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
])

const ALL_TABLE_NAMES = [
  ...TENANT_SCOPED_TABLES,
  'salon_users',
  'organizations',
  'tenants',
  'schema_migrations',
]

export function createInMemoryNeonPool(options?: { failNetwork?: boolean }): {
  pool: SqlPoolLike
  tables: Map<string, Map<string, StoredRow>>
} {
  const tables = new Map<string, Map<string, StoredRow>>()
  for (const name of ALL_TABLE_NAMES) {
    tables.set(name, new Map())
  }

  let currentTenant: string | null = null
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

      if (existing && existing.updated_at && incomingUpdated) {
        if (!(existing.updated_at < incomingUpdated)) {
          return { rows: [], rowCount: 0 }
        }
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
  if (params.body !== undefined) {
    reqEmitter.body = params.body
  }

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
