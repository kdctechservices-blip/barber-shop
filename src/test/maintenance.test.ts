/**
 * Maintenance périodique (P1) — purge des sessions expirées, journal
 * sync_changes et événements d'abonnement.
 *
 * Tests unitaires avec un pool simulé dédié.
 */

import { describe, expect, it } from 'vitest'
import type { SqlPoolLike, SqlClientLike } from '../../server/neonClient'
import { runMaintenancePurge } from '../../server/maintenance'

const NOW = Date.now()
const DAY_MS = 24 * 60 * 60 * 1000
const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

function recentIso(daysAgo: number): string {
  return new Date(NOW - daysAgo * DAY_MS).toISOString()
}

/** Ligne de test avec tous les champs nécessaires à la purge. */
interface PurgeRow {
  id: string
  tenant_id?: string
  user_id?: string
  email?: string
  role?: string
  refresh_token_hash?: string
  created_at?: string
  expires_at?: string
  last_used_at?: string
  revoked_at?: string | null
  revoked_reason?: string | null
  seq?: string | number
  table_name?: string
  row_id?: string
  op?: string
  org_id?: string
  event?: string
  name?: string
  slug?: string
}

/** Pool simulé minimal pour les tests de purge. */
function createPurgePool(initialRows: {
  sessions: PurgeRow[]
  tenants: PurgeRow[]
  syncChanges: PurgeRow[]
  subscriptionEvents: PurgeRow[]
}): SqlPoolLike {
  const sessions = new Map<string, PurgeRow>(
    initialRows.sessions.map((r) => [r.id, r]),
  )
  const tenants = new Map<string, PurgeRow>(
    initialRows.tenants.map((r) => [r.id, r]),
  )
  const syncChanges = new Map<string, PurgeRow>(
    initialRows.syncChanges.map((r) => [String(r.id), r]),
  )
  const subscriptionEvents = new Map<string, PurgeRow>(
    initialRows.subscriptionEvents.map((r) => [String(r.id), r]),
  )

  const query = async <R = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount: number | null }> => {
    const normalized = text.replace(/\s+/g, ' ').trim()

    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      return { rows: [], rowCount: 0 }
    }

    const setConfig = normalized.match(/^SELECT set_config\('app\.tenant_id', \$1, true\)/i)
    if (setConfig) {
      return { rows: [], rowCount: 1 }
    }

    if (normalized === 'SELECT id FROM tenants') {
      return {
        rows: Array.from(tenants.values()).map((r) => ({ id: r.id })) as R[],
        rowCount: tenants.size,
      }
    }

    // DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < $1) OR (revoked_at IS NULL AND expires_at < $1)
    const delSessions = normalized.match(
      /^DELETE FROM sessions WHERE \(revoked_at IS NOT NULL AND revoked_at < \$1\) OR \(revoked_at IS NULL AND expires_at < \$1\)/i,
    )
    if (delSessions) {
      const cutoff = String(values[0])
      let deleted = 0
      for (const [id, row] of sessions) {
        const revoked = row.revoked_at ?? null
        const expires = row.expires_at ?? null
        if ((revoked && revoked < cutoff) || (!revoked && expires && expires < cutoff)) {
          sessions.delete(id)
          deleted += 1
        }
      }
      return { rows: [], rowCount: deleted }
    }

    // DELETE FROM subscription_events WHERE created_at < $1
    const delSubs = normalized.match(
      /^DELETE FROM subscription_events WHERE created_at < \$1/i,
    )
    if (delSubs) {
      const cutoff = String(values[0])
      let deleted = 0
      for (const [id, row] of subscriptionEvents) {
        if ((row.created_at ?? '') < cutoff) {
          subscriptionEvents.delete(id)
          deleted += 1
        }
      }
      return { rows: [], rowCount: deleted }
    }

    // DELETE FROM sync_changes WHERE tenant_id = $1 AND created_at < $2 AND seq <= (SELECT MAX(seq) - $3 FROM sync_changes WHERE tenant_id = $1)
    const delSync = normalized.match(
      /^DELETE FROM sync_changes WHERE tenant_id = \$1 AND created_at < \$2 AND seq <= \(\s*SELECT MAX\(seq\) - \$3 FROM sync_changes WHERE tenant_id = \$1\s*\)/i,
    )
    if (delSync) {
      const tenantId = String(values[0])
      const cutoff = String(values[1])
      const keep = Number(values[2])
      const tenantRows = Array.from(syncChanges.values()).filter(
        (r) => r.tenant_id === tenantId,
      )
      const maxSeq =
        tenantRows.length > 0
          ? Math.max(...tenantRows.map((r) => Number(r.seq ?? 0)))
          : 0
      const threshold = maxSeq - keep
      let deleted = 0
      for (const [id, row] of syncChanges) {
        if (
          row.tenant_id === tenantId &&
          (row.created_at ?? '') < cutoff &&
          Number(row.seq ?? 0) <= threshold
        ) {
          syncChanges.delete(id)
          deleted += 1
        }
      }
      return { rows: [], rowCount: deleted }
    }

    throw new Error(`Requête SQL non gérée : ${normalized}`)
  }

  return {
    query,
    async connect(): Promise<SqlClientLike> {
      return { query, release: () => {} }
    },
  }
}

describe('runMaintenancePurge — purge des sessions expirées', () => {
  it('supprime les sessions révoquées depuis plus de 30 jours', async () => {
    const pool = createPurgePool({
      sessions: [
        {
          id: 's1',
          tenant_id: TENANT_A,
          user_id: 'u1',
          email: 'a@salon.ci',
          role: 'manager',
          refresh_token_hash: 'hash1',
          created_at: recentIso(40),
          expires_at: recentIso(40),
          last_used_at: recentIso(40),
          revoked_at: recentIso(35),
          revoked_reason: 'logout',
        },
        {
          id: 's2',
          tenant_id: TENANT_A,
          user_id: 'u2',
          email: 'b@salon.ci',
          role: 'cashier',
          refresh_token_hash: 'hash2',
          created_at: recentIso(10),
          expires_at: recentIso(10),
          last_used_at: recentIso(10),
          revoked_at: recentIso(5),
          revoked_reason: 'logout',
        },
        {
          id: 's3',
          tenant_id: TENANT_A,
          user_id: 'u3',
          email: 'c@salon.ci',
          role: 'manager',
          refresh_token_hash: 'hash3',
          created_at: recentIso(40),
          expires_at: recentIso(40),
          last_used_at: recentIso(40),
          revoked_at: null,
          revoked_reason: null,
        },
      ],
      tenants: [],
      syncChanges: [],
      subscriptionEvents: [],
    })

    const result = await runMaintenancePurge(pool)

    expect(result.sessions).toBe(2)
    expect(result.syncChanges).toBe(0)
    expect(result.subscriptionEvents).toBe(0)
  })

  it('conserve les sessions actives et récentes', async () => {
    const pool = createPurgePool({
      sessions: [
        {
          id: 's1',
          tenant_id: TENANT_A,
          user_id: 'u1',
          email: 'a@salon.ci',
          role: 'manager',
          refresh_token_hash: 'hash1',
          created_at: recentIso(1),
          expires_at: recentIso(-15),
          last_used_at: recentIso(1),
          revoked_at: null,
          revoked_reason: null,
        },
      ],
      tenants: [],
      syncChanges: [],
      subscriptionEvents: [],
    })

    const result = await runMaintenancePurge(pool)

    expect(result.sessions).toBe(0)
  })
})

describe('runMaintenancePurge — purge du journal sync_changes', () => {
  it("garde toutes les révisions quand le seuil de garde dépasse le nombre total", async () => {
    const rows: PurgeRow[] = []
    for (let seq = 1; seq <= 5; seq += 1) {
      rows.push({
        id: `sc:${TENANT_A}:${seq}`,
        tenant_id: TENANT_A,
        seq: String(seq),
        table_name: 'revenues',
        row_id: `rev-${seq}`,
        op: 'upsert',
        created_at: recentIso(40),
      })
    }
    for (let seq = 6; seq <= 8; seq += 1) {
      rows.push({
        id: `sc:${TENANT_A}:${seq}`,
        tenant_id: TENANT_A,
        seq: String(seq),
        table_name: 'revenues',
        row_id: `rev-${seq}`,
        op: 'upsert',
        created_at: recentIso(5),
      })
    }

    const pool = createPurgePool({
      sessions: [],
      tenants: [{ id: TENANT_A, org_id: 'org-a', name: 'Salon A', slug: 'salon-a' }],
      syncChanges: rows,
      subscriptionEvents: [],
    })

    const result = await runMaintenancePurge(pool)

    expect(result.syncChanges).toBe(0)
  })

  it('supprime les révisions anciennes au-delà du seuil de garde', async () => {
    const rows: PurgeRow[] = []
    for (let seq = 1; seq <= 15000; seq += 1) {
      rows.push({
        id: `sc:${TENANT_A}:${seq}`,
        tenant_id: TENANT_A,
        seq: String(seq),
        table_name: 'revenues',
        row_id: `rev-${seq}`,
        op: 'upsert',
        created_at: recentIso(40),
      })
    }
    for (let seq = 15001; seq <= 15500; seq += 1) {
      rows.push({
        id: `sc:${TENANT_A}:${seq}`,
        tenant_id: TENANT_A,
        seq: String(seq),
        table_name: 'expenses',
        row_id: `exp-${seq}`,
        op: 'upsert',
        created_at: recentIso(5),
      })
    }

    const pool = createPurgePool({
      sessions: [],
      tenants: [{ id: TENANT_A, org_id: 'org-a', name: 'Salon A', slug: 'salon-a' }],
      syncChanges: rows,
      subscriptionEvents: [],
    })

    const result = await runMaintenancePurge(pool)

    // max seq = 15500, keep = 10000, threshold = 5500
    // Lignes supprimées : tenant_id = A, date < 30j, seq <= 5500 => seq 1..5500
    expect(result.syncChanges).toBe(5500)
  })

  it('isole la purge par tenant', async () => {
    const rows: PurgeRow[] = []
    for (let seq = 1; seq <= 2000; seq += 1) {
      rows.push({
        id: `sc:${TENANT_A}:${seq}`,
        tenant_id: TENANT_A,
        seq: String(seq),
        table_name: 'revenues',
        row_id: `rev-a-${seq}`,
        op: 'upsert',
        created_at: recentIso(40),
      })
    }
    for (let seq = 1; seq <= 2000; seq += 1) {
      rows.push({
        id: `sc:${TENANT_B}:${seq}`,
        tenant_id: TENANT_B,
        seq: String(seq),
        table_name: 'revenues',
        row_id: `rev-b-${seq}`,
        op: 'upsert',
        created_at: recentIso(5),
      })
    }

    const pool = createPurgePool({
      sessions: [],
      tenants: [
        { id: TENANT_A, org_id: 'org-a', name: 'Salon A', slug: 'salon-a' },
        { id: TENANT_B, org_id: 'org-b', name: 'Salon B', slug: 'salon-b' },
      ],
      syncChanges: rows,
      subscriptionEvents: [],
    })

    const result = await runMaintenancePurge(pool)

    // max seq A = 2000, keep = 10000, threshold < 0 => rien supprimé
    // max seq B = 2000, keep = 10000, threshold < 0 => rien supprimé
    expect(result.syncChanges).toBe(0)
  })
})

describe('runMaintenancePurge — purge des événements d’abonnement', () => {
  it('supprime les événements de plus de 90 jours', async () => {
    const pool = createPurgePool({
      sessions: [],
      tenants: [],
      syncChanges: [],
      subscriptionEvents: [
        {
          id: 'e1',
          org_id: 'org-a',
          event: 'plan_activated',
          created_at: recentIso(100),
        },
        {
          id: 'e2',
          org_id: 'org-a',
          event: 'plan_cancelled',
          created_at: recentIso(10),
        },
      ],
    })

    const result = await runMaintenancePurge(pool)

    expect(result.subscriptionEvents).toBe(1)
  })
})

describe('runMaintenancePurge — résultat global', () => {
  it('retourne les trois compteurs', async () => {
    const pool = createPurgePool({
      sessions: [
        {
          id: 's1',
          tenant_id: TENANT_A,
          user_id: 'u1',
          email: 'a@salon.ci',
          role: 'manager',
          refresh_token_hash: 'hash1',
          created_at: recentIso(40),
          expires_at: recentIso(40),
          last_used_at: recentIso(40),
          revoked_at: recentIso(35),
          revoked_reason: 'logout',
        },
      ],
      tenants: [],
      syncChanges: [],
      subscriptionEvents: [
        {
          id: 'e1',
          org_id: 'org-a',
          event: 'plan_activated',
          created_at: recentIso(100),
        },
      ],
    })

    const result = await runMaintenancePurge(pool)

    expect(result).toMatchObject({
      sessions: 1,
      syncChanges: 0,
      subscriptionEvents: 1,
    })
  })
})
