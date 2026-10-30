import type { IncomingMessage, ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import { handleSalonApiRequest } from '../../../server/apiHandler'
import { MIGRATIONS } from '../../../server/migrations'
import type { SqlClientLike, SqlPoolLike } from '../../../server/neonClient'

/**
 * Harnais de test partagé : simulateur léger de pool PostgreSQL et
 * invocateur de la fonction serverless /api/*.
 *
 * Le simulateur reproduit volontairement les deux garanties structurantes du
 * schéma réel :
 *  - `tenant_id` attribué par défaut depuis `app.tenant_id` (paramètre posé
 *    par `set_config` au début de chaque transaction) ;
 *  - isolation RLS : une lecture sans contexte de salon ne renvoie rien, et un
 *    salon ne voit jamais les lignes d'un autre (sauf `salon_users`, hors RLS
 *    car l'authentification précède la connaissance du salon).
 */

export interface StoredRow {
  id: string
  tenant_id?: string
  revision?: string | number
  seq?: string | number
  table_name?: string
  row_id?: string
  op?: string
  updated_at?: string
  created_at?: string
  deleted_at?: string
  entity_type?: string
  entity_id?: string
  payload_json?: unknown
}

/** Tables soumises à RLS dans PostgreSQL (tout sauf comptes/plateforme). */
const TENANT_SCOPED_TABLES = new Set([
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
  'invoices',
  'clients',
  'appointments',
])

/** Hors RLS : l'authentification précède la connaissance du salon. */
const GLOBAL_TABLES = [
  'salon_users',
  'organizations',
  'tenants',
  'sessions',
  'schema_migrations',
  'sync_state',
  'sync_changes',
  'memberships',
  'subscriptions',
  'subscription_events',
  'payment_transactions',
]

const ALL_TABLE_NAMES = [...TENANT_SCOPED_TABLES, ...GLOBAL_TABLES]

export function createInMemoryNeonPool(options?: { failNetwork?: boolean }): {
  pool: SqlPoolLike
  tables: Map<string, Map<string, StoredRow>>
} {
  const tables = new Map<string, Map<string, StoredRow>>()
  for (const name of ALL_TABLE_NAMES) {
    tables.set(name, new Map())
  }

  let currentTenant: string | null = null

  type Condition = {
    column: string
    op: 'is-null' | 'is-not-null' | '=' | '>' | '<' | '>=' | '<='
    value?: unknown
  }

  const parseConditions = (clause: string, values: unknown[]): Condition[] =>
    clause.split(/\s+AND\s+/i).map((part) => {
      const trimmed = part.trim()
      const isNull = trimmed.match(/^([a-z_]+)\s+IS\s+NULL$/i)
      if (isNull) return { column: isNull[1], op: 'is-null' }
      const isNotNull = trimmed.match(/^([a-z_]+)\s+IS\s+NOT\s+NULL$/i)
      if (isNotNull) return { column: isNotNull[1], op: 'is-not-null' }
      const comparison = trimmed.match(/^([a-z_]+)\s*(>=|<=|=|>|<)\s*\$(\d+)$/i)
      if (!comparison) {
        throw new Error(`Condition SQL non gérée : ${trimmed}`)
      }
      return {
        column: comparison[1],
        op: comparison[2] as '=' | '>' | '<' | '>=' | '<=',
        value: values[Number(comparison[3]) - 1],
      }
    })

  const asComparable = (value: unknown): number | string => {
    if (value === null || value === undefined) return ''
    if (typeof value === 'number') return value
    const asDate = Date.parse(String(value))
    return Number.isNaN(asDate) ? String(value) : asDate
  }

  const matchesConditions = (row: StoredRow, conditions: Condition[]): boolean =>
    conditions.every((condition) => {
      const raw = (row as unknown as Record<string, unknown>)[condition.column]
      if (condition.op === 'is-null' || condition.op === 'is-not-null') {
        const isNull = raw === null || raw === undefined
        return condition.op === 'is-null' ? isNull : !isNull
      }
      const left = asComparable(raw)
      const right = asComparable(condition.value)
      switch (condition.op) {
        case '=':
          return left === right
        case '>':
          return left > right
        case '<':
          return left < right
        case '>=':
          return left >= right
        case '<=':
          return left <= right
        default:
          return false
      }
    })
  /** Découpe une liste SQL de valeurs (`$1`, `'lit'`, `NULL`, `$7::jsonb`). */
  const parseValueTokens = (clause: string, values: unknown[]): unknown[] =>
    clause
      .split(',')
      .map((token) => token.trim())
      .map((token) => {
        const param = token.match(/^\$(\d+)(?:::\w+)?$/)
        if (param) return values[Number(param[1]) - 1]
        const quoted = token.match(/^'([^']*)'$/)
        if (quoted) return quoted[1]
        if (/^null$/i.test(token)) return null
        if (/^true$/i.test(token)) return true
        if (/^false$/i.test(token)) return false
        if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token)
        throw new Error(`Valeur SQL non gérée : ${token}`)
      })

  /** Découpe une clause `SET` (`col = $2`, `col = 'lit'`, `col = NULL`). */
  const parseAssignments = (
    clause: string,
    values: unknown[],
  ): { column: string; value: unknown }[] =>
    clause.split(',').map((assignment) => {
      const parsed = assignment
        .trim()
        .match(/^([a-z_]+)\s*=\s*(\$\d+(?:::\w+)?|'[^']*'|NULL|true|false|-?\d+(\.\d+)?)$/i)
      if (!parsed) {
        throw new Error(`Assignation SQL non gérée : ${assignment}`)
      }
      return {
        column: parsed[1],
        value: parseValueTokens(parsed[2], values)[0],
      }
    })

  const rowKey = (table: string, id: string): string => {
    if (!TENANT_SCOPED_TABLES.has(table)) return id
    if (!currentTenant) return `∅::${id}`
    return `${currentTenant}::${id}`
  }

  const visibleRows = (table: string): StoredRow[] => {
    const rows = Array.from(tables.get(table)?.values() ?? [])
    if (!TENANT_SCOPED_TABLES.has(table)) return rows
    if (!currentTenant) return []
    return rows.filter((row) => row.tenant_id === currentTenant)
  }

  const executeQuery = async <R = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount: number | null }> => {
    if (options?.failNetwork) {
      throw new Error('getaddrinfo ENOTFOUND ep-test.aws.neon.tech')
    }

    const normalized = text.replace(/\s+/g, ' ').trim()

    if (
      normalized === 'BEGIN' ||
      normalized === 'ROLLBACK'
    ) {
      currentTenant = null
      return { rows: [], rowCount: 0 }
    }
    if (normalized === 'COMMIT') {
      currentTenant = null
      return { rows: [], rowCount: 0 }
    }

    // Contexte multi-tenant posé par `withTenantClient`
    if (/^SELECT set_config\('app\.tenant_id'/i.test(normalized)) {
      currentTenant = String(values[0] ?? '') || null
      return {
        rows: [{ set_config: currentTenant }] as R[],
        rowCount: 1,
      }
    }

    // Migrations : le DDL est ignoré par le simulateur (pas de moteur SQL),
    // mais le registre `schema_migrations` est réellement tenu à jour.
    if (
      /^(CREATE|ALTER|DROP|COMMENT|GRANT|REVOKE|DO)\b/i.test(normalized)
    ) {
      return { rows: [], rowCount: 0 }
    }
    // Le simulateur n'interprète pas le DDL : on considère les migrations
    // comme appliquées (leur contenu SQL est couvert par migrations.test.ts).
    // L'isolation multi-tenant est, elle, réellement émulée ci-dessous.
    if (normalized.startsWith('SELECT id FROM schema_migrations')) {
      const rows = MIGRATIONS.map((migration) => ({ id: migration.id })) as R[]
      return { rows, rowCount: rows.length }
    }
    if (normalized.startsWith('INSERT INTO schema_migrations')) {
      const tbl = tables.get('schema_migrations')!
      const id = String(values[0])
      if (tbl.has(id)) return { rows: [], rowCount: 0 }
      tbl.set(id, { id })
      return { rows: [], rowCount: 1 }
    }

    // Table `sessions` (S4) : lecture/écriture générique pilotée par les
    // colonnes et conditions réellement utilisées par server/sessions.ts.
    if (/^SELECT\s/i.test(normalized) && /\bFROM sessions\b/i.test(normalized)) {
      const match = normalized.match(
        /^SELECT (.+?) FROM sessions(?: WHERE (.+?))?(?: ORDER BY .*)?$/i,
      )
      if (!match) throw new Error(`Requête sessions non gérée : ${normalized}`)
      const columns = match[1].split(',').map((c) => c.trim())
      const conditions = match[2] ? parseConditions(match[2], values) : []
      const rows = Array.from(tables.get('sessions')!.values())
        .filter((row) => matchesConditions(row, conditions))
        .map((row) => {
          const projected: Record<string, unknown> = {}
          for (const column of columns) {
            projected[column] = (row as unknown as Record<string, unknown>)[column]
          }
          return projected as R
        })
      return { rows, rowCount: rows.length }
    }

    if (/^UPDATE sessions\b/i.test(normalized)) {
      const match = normalized.match(/^UPDATE sessions SET (.+?) WHERE (.+)$/i)
      if (!match) throw new Error(`UPDATE sessions non géré : ${normalized}`)
      const assignments = match[1].split(',').map((assignment) => {
        const parsed = assignment.trim().match(/^([a-z_]+)\s*=\s*\$(\d+)$/i)
        if (!parsed) {
          throw new Error(`Assignation SQL non gérée : ${assignment}`)
        }
        return { column: parsed[1], value: values[Number(parsed[2]) - 1] }
      })
      const conditions = parseConditions(match[2], values)
      let rowCount = 0
      for (const [key, row] of tables.get('sessions')!) {
        if (!matchesConditions(row, conditions)) continue
        const updated = { ...row } as unknown as Record<string, unknown>
        for (const assignment of assignments) {
          updated[assignment.column] = assignment.value
        }
        tables.get('sessions')!.set(key, updated as unknown as StoredRow)
        rowCount += 1
      }
      return { rows: [], rowCount }
    }


    // Comptages servant aux limites d'offre (abonnements)
    if (
      /^SELECT COUNT\(\*\) AS count FROM memberships WHERE tenant_id = \$1(?: AND is_active = true)?$/i.test(
        normalized,
      )
    ) {
      const tenantId = String(values[0])
      const onlyActive = /is_active = true/i.test(normalized)
      const rows = Array.from(tables.get('memberships')!.values()).filter(
        (row) =>
          String((row as unknown as Record<string, unknown>).tenant_id) ===
            tenantId &&
          (!onlyActive ||
            (row as unknown as Record<string, unknown>).is_active !== false),
      )
      return {
        rows: [{ count: String(rows.length) }] as R[],
        rowCount: 1,
      }
    }

    if (
      /^SELECT COUNT\(\*\) AS count FROM tenants WHERE org_id = \$1$/i.test(
        normalized,
      )
    ) {
      const orgId = String(values[0])
      const rows = Array.from(tables.get('tenants')!.values()).filter(
        (row) =>
          String((row as unknown as Record<string, unknown>).org_id) === orgId,
      )
      return { rows: [{ count: String(rows.length) }] as R[], rowCount: 1 }
    }

    // Organisation d'un salon (facturation par organisation)
    if (/^SELECT org_id FROM tenants WHERE id = \$1$/i.test(normalized)) {
      const row = tables.get('tenants')!.get(String(values[0]))
      const orgId = row
        ? (row as unknown as Record<string, unknown>).org_id
        : undefined
      return {
        rows: (orgId ? [{ org_id: orgId }] : []) as R[],
        rowCount: orgId ? 1 : 0,
      }
    }

    if (
      /^SELECT id FROM tenants WHERE org_id = \$1 ORDER BY created_at LIMIT 1$/i.test(
        normalized,
      )
    ) {
      const orgId = String(values[0])
      const rows = Array.from(tables.get('tenants')!.values())
        .filter(
          (row) =>
            String((row as unknown as Record<string, unknown>).org_id) === orgId,
        )
        .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))
      return {
        rows: (rows[0] ? [{ id: rows[0].id }] : []) as R[],
        rowCount: rows[0] ? 1 : 0,
      }
    }

    // Abonnements (Sprint 7) — clé primaire = organisation
    if (/^SELECT .+ FROM subscriptions\b/i.test(normalized)) {
      const match = normalized.match(
        /^SELECT (.+?) FROM subscriptions(?: WHERE (.+?))?$/i,
      )
      if (!match) throw new Error(`Requête subscriptions non gérée : ${normalized}`)
      const columns = match[1].split(',').map((column) => column.trim())
      const conditions = match[2] ? parseConditions(match[2], values) : []
      const rows = Array.from(tables.get('subscriptions')!.values())
        .filter((row) => matchesConditions(row, conditions))
        .map((row) => {
          const projected: Record<string, unknown> = {}
          for (const column of columns) {
            projected[column] = (row as unknown as Record<string, unknown>)[column]
          }
          return projected as R
        })
      return { rows, rowCount: rows.length }
    }

    if (/^INSERT INTO subscriptions\b/i.test(normalized)) {
      const match = normalized.match(
        /^INSERT INTO subscriptions\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i,
      )
      if (!match) throw new Error(`INSERT subscriptions non géré : ${normalized}`)
      const cols = match[1].split(',').map((column) => column.trim())
      const vals = parseValueTokens(match[2], values)
      const row: Record<string, unknown> = {}
      cols.forEach((column, index) => {
        row[column] = vals[index]
      })
      const key = String(row.org_id ?? '')
      const overwrite = /DO UPDATE/i.test(normalized)
      if (tables.get('subscriptions')!.has(key) && !overwrite) {
        return { rows: [], rowCount: 0 }
      }
      tables.get('subscriptions')!.set(key, row as unknown as StoredRow)
      return { rows: [], rowCount: 1 }
    }

    if (/^UPDATE subscriptions\b/i.test(normalized)) {
      const match = normalized.match(/^UPDATE subscriptions SET (.+?) WHERE (.+)$/i)
      if (!match) throw new Error(`UPDATE subscriptions non géré : ${normalized}`)
      const assignments = parseAssignments(match[1], values)
      const conditions = parseConditions(match[2], values)
      let rowCount = 0
      for (const [key, row] of tables.get('subscriptions')!) {
        if (!matchesConditions(row, conditions)) continue
        const updated = { ...row } as unknown as Record<string, unknown>
        for (const assignment of assignments) {
          updated[assignment.column] = assignment.value
        }
        tables.get('subscriptions')!.set(key, updated as unknown as StoredRow)
        rowCount += 1
      }
      return { rows: [], rowCount }
    }

    // Appartenances multi-salons (P1)
    if (/^SELECT .+ FROM memberships/i.test(normalized)) {
      const match = normalized.match(
        /^SELECT (.+?) FROM memberships(?: WHERE (.+?))?(?: ORDER BY .*)?$/i,
      )
      if (!match) throw new Error(`Requête memberships non gérée : ${normalized}`)
      const columns = match[1].split(',').map((column) => column.trim())
      const conditions = match[2] ? parseConditions(match[2], values) : []
      const rows = Array.from(tables.get('memberships')!.values())
        .filter((row) => matchesConditions(row, conditions))
        .map((row) => {
          const projected: Record<string, unknown> = {}
          for (const column of columns) {
            projected[column] = (row as unknown as Record<string, unknown>)[
              column
            ]
          }
          return projected as R
        })
      return { rows, rowCount: rows.length }
    }

    if (/^DELETE FROM memberships/i.test(normalized)) {
      const key = `${String(values[0])}:${String(values[1])}`
      const existed = tables.get('memberships')!.delete(key)
      return { rows: [], rowCount: existed ? 1 : 0 }
    }

    if (/^SELECT id, name, slug FROM tenants/i.test(normalized)) {
      const rows = Array.from(tables.get('tenants')!.values()).map((row) => ({
        id: row.id,
        name: (row as unknown as Record<string, unknown>).name ?? 'Salon',
        slug: (row as unknown as Record<string, unknown>).slug ?? null,
      })) as R[]
      return { rows, rowCount: rows.length }
    }

    // Journal de synchronisation delta (P0-6)
    if (/^INSERT INTO sync_state\b/i.test(normalized)) {
      const tbl = tables.get('sync_state')!
      const tenantId = String(values[0])
      if (!tbl.has(tenantId)) {
        tbl.set(tenantId, { id: tenantId, tenant_id: tenantId, revision: '0' })
      }
      return { rows: [], rowCount: 1 }
    }

    if (/^SELECT revision FROM sync_state/i.test(normalized)) {
      const row = tables.get('sync_state')!.get(String(values[0]))
      return {
        rows: (row ? [{ revision: row.revision }] : []) as R[],
        rowCount: row ? 1 : 0,
      }
    }

    if (/^UPDATE sync_state SET revision = revision \+ \$2/i.test(normalized)) {
      const tenantId = String(values[0])
      const delta = Number(values[1])
      const tbl = tables.get('sync_state')!
      const row: StoredRow = tbl.get(tenantId) ?? {
        id: tenantId,
        tenant_id: tenantId,
        revision: '0',
      }
      const revision = String(Number(row.revision ?? 0) + delta)
      tbl.set(tenantId, { ...row, revision })
      return { rows: [{ revision }] as R[], rowCount: 1 }
    }

    if (/^SELECT seq, table_name, row_id, op, payload_json FROM sync_changes/i.test(normalized)) {
      const tenantId = String(values[0])
      const since = Number(values[1] ?? 0)
      const rows = Array.from(tables.get('sync_changes')!.values())
        .filter(
          (row) =>
            row.tenant_id === tenantId && Number(row.seq ?? 0) > since,
        )
        .sort((a, b) => Number(a.seq) - Number(b.seq))
        .map((row) => ({
          seq: row.seq,
          table_name: row.table_name,
          row_id: row.row_id,
          op: row.op,
          payload_json: row.payload_json,
        })) as R[]
      return { rows, rowCount: rows.length }
    }

    // SELECT payload_json FROM <table> ...
    const selectPayloadMatch = normalized.match(
      /^SELECT payload_json(?:, tenant_id)? FROM ([a-z_]+)/i,
    )
    if (selectPayloadMatch) {
      const table = selectPayloadMatch[1]
      const tbl = tables.get(table)
      if (!tbl) throw new Error(`Unknown table ${table}`)

      if (table === 'salon_users') {
        // Table hors RLS : l'authentification lit tous les salons, les écrans
        // d'administration filtrent explicitement par tenant.
        const askedTenant = normalized.includes('WHERE tenant_id = $1')
        const wanted = askedTenant
          ? String(values[0])
          : String(values[1] ?? '')
        const rows = Array.from(tbl.values())
          .filter((row) => !askedTenant || row.tenant_id === wanted)
          .map((row) => ({
            payload_json: row.payload_json,
            tenant_id: row.tenant_id,
          })) as R[]
        return { rows, rowCount: rows.length }
      }

      const rows = visibleRows(table)
      const byId = normalized.match(/WHERE id = \$1/i)
      if (byId) {
        const match = rows.find((row) => row.id === String(values[0]))
        return {
          rows: match ? ([{ payload_json: match.payload_json }] as R[]) : [],
          rowCount: match ? 1 : 0,
        }
      }
      return {
        rows: rows.map((row) => ({ payload_json: row.payload_json })) as R[],
        rowCount: rows.length,
      }
    }

    // SELECT entity_type, entity_id, deleted_at FROM sync_tombstones
    if (normalized.includes('FROM sync_tombstones')) {
      const rows = visibleRows('sync_tombstones').map((row) => ({
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        deleted_at: row.deleted_at,
      })) as R[]
      return { rows, rowCount: rows.length }
    }

    // DELETE FROM <table> WHERE id = $1 AND (updated_at|created_at) <= $2
    const deleteMatch = normalized.match(
      /^DELETE FROM ([a-z_]+) WHERE id = \$1 AND (updated_at|created_at) <= \$2/i,
    )
    if (deleteMatch) {
      const table = deleteMatch[1]
      const tsField = deleteMatch[2] as 'updated_at' | 'created_at'
      const tbl = tables.get(table)!
      const key = rowKey(table, String(values[0]))
      const cur = tbl.get(key)
      if (cur && (cur[tsField] ?? '') <= String(values[1])) {
        tbl.delete(key)
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }

    // DELETE FROM <table> WHERE id = $1
    const directDeleteMatch = normalized.match(
      /^DELETE FROM ([a-z_]+) WHERE id = \$1$/i,
    )
    if (directDeleteMatch) {
      const table = directDeleteMatch[1]
      const existed = tables.get(table)!.delete(rowKey(table, String(values[0])))
      return { rows: [], rowCount: existed ? 1 : 0 }
    }

    // INSERT INTO <table> (...) VALUES (...) [ON CONFLICT ...]
    const insertMatch = normalized.match(
      /^INSERT INTO ([a-z_]+)\s*\(([^)]+)\)/i,
    )
    if (insertMatch) {
      const table = insertMatch[1]
      const cols = insertMatch[2].split(',').map((c) => c.trim())
      const tbl = tables.get(table)
      if (!tbl) throw new Error(`Unknown table ${table}`)

      const idIdx = cols.indexOf('id')
      const updatedIdx = cols.indexOf('updated_at')
      const createdIdx = cols.indexOf('created_at')
      const payloadIdx = cols.indexOf('payload_json')
      const tenantIdx = cols.indexOf('tenant_id')

      const id =
        idIdx >= 0
          ? String(values[idIdx])
          : `${String(values[0])}:${String(values[1])}`
      const key = rowKey(table, id)

      const explicitTenant =
        tenantIdx >= 0 ? String(values[tenantIdx]) : currentTenant
      if (TENANT_SCOPED_TABLES.has(table) && !explicitTenant) {
        throw new Error(
          'new row violates row-level security policy (aucun app.tenant_id défini)',
        )
      }

      const incomingUpdated =
        updatedIdx >= 0 ? String(values[updatedIdx]) : undefined
      const incomingCreated =
        createdIdx >= 0 ? String(values[createdIdx]) : undefined
      const rawJson = payloadIdx >= 0 ? values[payloadIdx] : undefined
      const parsedPayload =
        typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson

      const existing = tbl.get(key)

      // Colonnes scalaires conservées telles quelles (entity_type, deleted_at…)
      const scalars: Record<string, unknown> = {}
      cols.forEach((col, index) => {
        if (col === 'payload_json' || col === 'tenant_id') return
        const value = values[index]
        if (
          value === null ||
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        ) {
          scalars[col] = value ?? undefined
        }
      })

      const row: StoredRow = {
        ...scalars,
        id,
        tenant_id: explicitTenant ?? undefined,
        created_at: incomingCreated,
        updated_at: incomingUpdated,
        payload_json: parsedPayload,
      }

      if (normalized.includes('DO NOTHING')) {
        if (existing) return { rows: [], rowCount: 0 }
        tbl.set(key, row)
        return { rows: [], rowCount: 1 }
      }

      // Sémantique serveur-autoritaire (P0-6) : l'horodatage du client ne
      // décide plus rien. Une écriture est ignorée seulement si le contenu est
      // identique (équivalent de `payload_json IS DISTINCT FROM EXCLUDED.payload_json`).
      if (
        existing &&
        payloadIdx >= 0 &&
        JSON.stringify(existing.payload_json) === JSON.stringify(parsedPayload)
      ) {
        return { rows: [], rowCount: 0 }
      }

      tbl.set(key, row)
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`Requête SQL non gérée dans le test : ${normalized}`)
  }

  const pool: SqlPoolLike = {
    query: executeQuery,
    async connect(): Promise<SqlClientLike> {
      if (options?.failNetwork) {
        throw new Error('getaddrinfo ENOTFOUND ep-test.aws.neon.tech')
      }
      return {
        query: executeQuery,
        release: () => {},
      }
    },
  }

  return { pool, tables }
}

/**
 * Crée l'appartenance d'un acteur à un salon — étape de préparation des tests
 * qui forgent un jeton (les tests de parcours réels passent par l'inscription).
 */
export async function seedMembership(
  pool: SqlPoolLike,
  params: {
    tenantId: string
    userId: string
    role?: 'manager' | 'cashier'
    isActive?: boolean
  },
): Promise<void> {
  const now = new Date().toISOString()
  await pool.query(
    `INSERT INTO memberships (tenant_id, user_id, role, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET
       role = EXCLUDED.role,
       is_active = EXCLUDED.is_active,
       updated_at = EXCLUDED.updated_at`,
    [
      params.tenantId,
      params.userId,
      params.role ?? 'manager',
      params.isActive !== false,
      now,
    ],
  )
}

/**
 * Fixe l'abonnement d'une organisation — préparation des tests de limites.
 * Par défaut : offre Professional active sur une période d'un mois.
 */
export async function seedSubscription(
  pool: SqlPoolLike,
  params: {
    orgId: string
    planCode?: string
    status?: string
    trialEndsAt?: string | null
    currentPeriodStart?: string | null
    currentPeriodEnd?: string | null
    pendingPlanCode?: string | null
    cancelAtPeriodEnd?: boolean
  },
): Promise<void> {
  const now = new Date()
  const inOneMonth = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
  await pool.query(
    `INSERT INTO subscriptions (org_id, plan_code, pending_plan_code, status, trial_ends_at, current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     ON CONFLICT (org_id) DO UPDATE SET plan_code = EXCLUDED.plan_code`,
    [
      params.orgId,
      params.planCode ?? 'professional',
      params.pendingPlanCode ?? null,
      params.status ?? 'active',
      params.trialEndsAt ?? null,
      params.currentPeriodStart ?? now.toISOString(),
      params.currentPeriodEnd ?? inOneMonth.toISOString(),
      params.cancelAtPeriodEnd === true,
      now.toISOString(),
    ],
  )
}

export async function invokeApi(params: {
  method: string
  url: string
  headers?: Record<string, string>
  body?: unknown
  poolOverride?: SqlPoolLike | null
  expectedPinOverride?: string
}): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const reqEmitter = new EventEmitter() as IncomingMessage & { body?: unknown }
  reqEmitter.method = params.method
  reqEmitter.url = params.url
  reqEmitter.headers = Object.fromEntries(
    Object.entries(params.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  )
  // Toujours renseigner `body` (même vide) : sinon `readJsonBody` attendrait
  // indéfiniment l'événement `end`, que ce faux flux n'émet jamais.
  reqEmitter.body = params.body ?? {}

  let statusCode = 200
  let rawResponse = ''
  const res = {
    get statusCode() {
      return statusCode
    },
    set statusCode(code: number) {
      statusCode = code
    },
    setHeader: () => res,
    end: (chunk?: string) => {
      if (chunk) rawResponse += chunk
    },
  } as unknown as ServerResponse

  await handleSalonApiRequest(reqEmitter, res, {
    poolOverride: params.poolOverride,
    expectedPinOverride: params.expectedPinOverride,
    databaseUrlOverride: 'postgresql://demo:secret@ep-demo.neon.tech/neondb',
  })

  return {
    statusCode,
    json: rawResponse ? (JSON.parse(rawResponse) as Record<string, unknown>) : {},
  }
}
