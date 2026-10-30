import { describe, expect, it } from 'vitest'
import type { SqlClientLike, SqlPoolLike } from '../../server/neonClient'
import { MIGRATIONS, runMigrations } from '../../server/migrations'

/**
 * Migrations versionnées (audit §6.1 S8 / P0-4).
 *
 * Le simulateur n'interprète pas le SQL : il enregistre l'ordre d'exécution et
 * tient le registre `schema_migrations`, ce qui suffit à vérifier l'idempotence,
 * la sérialisation et la propagation des échecs.
 */
function createRecordingPool(options?: { failOn?: (sql: string) => boolean }): {
  pool: SqlPoolLike
  applied: string[]
  executed: string[]
} {
  const applied: string[] = []
  const executed: string[] = []

  const query = async <R = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount: number | null }> => {
    const normalized = text.replace(/\s+/g, ' ').trim()
    const isBookkeeping =
      normalized === 'BEGIN' ||
      normalized === 'COMMIT' ||
      normalized === 'ROLLBACK' ||
      normalized.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations') ||
      normalized.startsWith('SELECT id FROM schema_migrations') ||
      normalized.startsWith('INSERT INTO schema_migrations')

    if (options?.failOn?.(text) && !isBookkeeping) {
      throw new Error('syntax error at or near "POLICY"')
    }

    executed.push(normalized)

    if (
      normalized === 'BEGIN' ||
      normalized === 'COMMIT' ||
      normalized === 'ROLLBACK' ||
      normalized.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')
    ) {
      return { rows: [], rowCount: 0 }
    }
    if (normalized.startsWith('SELECT id FROM schema_migrations')) {
      const rows = applied.map((id) => ({ id })) as R[]
      return { rows, rowCount: rows.length }
    }
    if (normalized.startsWith('INSERT INTO schema_migrations')) {
      const id = String(values[0])
      if (applied.includes(id)) return { rows: [], rowCount: 0 }
      applied.push(id)
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }

  return {
    pool: {
      query,
      async connect(): Promise<SqlClientLike> {
        return { query, release: () => {} }
      },
    },
    applied,
    executed,
  }
}

describe('Migrations versionnées', () => {
  it('expose des identifiants uniques et ordonnés', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(ids)
    expect(ids[0]).toBe('001_baseline')
  })

  it('applique chaque migration une seule fois, dans l’ordre', async () => {
    const { pool, applied, executed } = createRecordingPool()

    await runMigrations(pool)
    expect(applied).toEqual(MIGRATIONS.map((m) => m.id))

    expect(
      executed.filter((sql) => sql.includes('pg_advisory_xact_lock')),
    ).toHaveLength(MIGRATIONS.length)
    const openingIndex = executed.findIndex((sql) => sql === 'BEGIN')
    expect(openingIndex).toBeGreaterThanOrEqual(0)
    expect(executed.filter((sql) => sql === 'COMMIT')).toHaveLength(
      MIGRATIONS.length,
    )

    executed.length = 0
    await runMigrations(pool)
    expect(applied).toEqual(MIGRATIONS.map((m) => m.id))
    expect(executed.some((sql) => sql.includes('tenants'))).toBe(false)
  })

  it('crée organisations/tenants, ajoute tenant_id aux 19 tables et force la RLS sur les 18 tables métier', () => {
    const tenancy = MIGRATIONS.find((m) => m.id === '002_multi_tenant')?.sql ?? ''
    const businessTables = [
      'salon_info',
      'app_settings',
      'categories',
      'services_catalog',
      'employees',
      'cash_sessions',
      'cash_movements',
      'revenues',
      'expenses',
      'recurring_expenses',
      'products',
      'stock_movements',
      'advances',
      'bonuses',
      'salary_payments',
      'budgets',
      'correction_logs',
      'sync_tombstones',
    ]

    expect(tenancy).toContain('CREATE TABLE IF NOT EXISTS organizations')
    expect(tenancy).toContain('CREATE TABLE IF NOT EXISTS tenants')
    for (const table of [...businessTables, 'salon_users']) {
      expect(tenancy).toContain(`'${table}'`)
    }
    expect(tenancy).toContain("ALTER TABLE %I ENABLE ROW LEVEL SECURITY")
    expect(tenancy).toContain("ALTER TABLE %I FORCE ROW LEVEL SECURITY")
    expect(tenancy).toContain('CREATE POLICY tenant_isolation ON %I')
    expect(tenancy).toContain("current_setting(''app.tenant_id'', true)::uuid")
    // Le backfill garantit qu'aucune ligne existante n'est orpheline.
    expect(tenancy).toContain('SET tenant_id = %L WHERE tenant_id IS NULL')
    // Les comptes restent hors RLS (l'authentification précède le salon).
    expect(tenancy).toContain('salon_users_tenant_email_key')
  })

  it('interrompt la séquence et ne marque pas la migration en échec comme appliquée', async () => {
    const { pool, applied } = createRecordingPool({
      failOn: (sql) => sql.includes('CREATE POLICY tenant_isolation'),
    })

    await expect(runMigrations(pool)).rejects.toThrow(/002_multi_tenant/)
    expect(applied).toEqual(['001_baseline'])
  })
})
