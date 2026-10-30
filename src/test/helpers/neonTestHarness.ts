import type { IncomingMessage, ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import { handleSalonApiRequest } from '../../../server/apiHandler'
import type { SqlClientLike, SqlPoolLike } from '../../../server/neonClient'

/**
 * Harnais de test partagé : simulateur léger de pool PostgreSQL et
 * invocateur de la fonction serverless /api/*.
 */

export interface StoredRow {
  id: string
  updated_at?: string
  created_at?: string
  deleted_at?: string
  entity_type?: string
  entity_id?: string
  payload_json?: unknown
}

/**
 * Simulateur léger de pool PostgreSQL supportant exactement les requêtes SQL
 * paramétrées utilisées par `server/syncEngine.ts` (transactions BEGIN/COMMIT,
 * upserts LWW sur `updated_at`, tables immuables, et `sync_tombstones`).
 */
export function createInMemoryNeonPool(options?: { failNetwork?: boolean }): {
  pool: SqlPoolLike
  tables: Map<string, Map<string, StoredRow>>
} {
  const tables = new Map<string, Map<string, StoredRow>>()
  const allTableNames = [
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
    'salon_users',
    'correction_logs',
    'sync_tombstones',
  ]
  for (const name of allTableNames) {
    tables.set(name, new Map())
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
      normalized === 'COMMIT' ||
      normalized === 'ROLLBACK' ||
      normalized.startsWith('CREATE TABLE') ||
      normalized.startsWith('CREATE INDEX')
    ) {
      return { rows: [], rowCount: 0 }
    }

    // SELECT payload_json FROM <table> ...
    const selectPayloadMatch = normalized.match(
      /^SELECT payload_json FROM ([a-z_]+)/i,
    )
    if (selectPayloadMatch) {
      const tbl = tables.get(selectPayloadMatch[1])!
      if (normalized.includes('WHERE id = $1')) {
        const row = tbl.get(String(values[0]))
        return {
          rows: row ? ([{ payload_json: row.payload_json }] as R[]) : [],
          rowCount: row ? 1 : 0,
        }
      }
      const rows = Array.from(tbl.values()).map((r) => ({
        payload_json: r.payload_json,
      })) as R[]
      return { rows, rowCount: rows.length }
    }

    // SELECT entity_type, entity_id, deleted_at FROM sync_tombstones
    if (normalized.includes('FROM sync_tombstones')) {
      const tbl = tables.get('sync_tombstones')!
      const rows = Array.from(tbl.values()).map((r) => ({
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        deleted_at: r.deleted_at,
      })) as R[]
      return { rows, rowCount: rows.length }
    }

    // INSERT INTO sync_tombstones (entity_type, entity_id, deleted_at)
    if (normalized.startsWith('INSERT INTO sync_tombstones')) {
      const tbl = tables.get('sync_tombstones')!
      const entityType = String(values[0])
      const entityId = String(values[1])
      const deletedAt = String(values[2])
      const key = `${entityType}:${entityId}`
      const existing = tbl.get(key)
      if (!existing || deletedAt >= (existing.deleted_at ?? '')) {
        tbl.set(key, {
          id: key,
          entity_type: entityType,
          entity_id: entityId,
          deleted_at: deletedAt,
        })
      }
      return { rows: [], rowCount: 1 }
    }

    // DELETE FROM <table> WHERE id = $1 AND (updated_at|created_at) <= $2::timestamptz
    const deleteMatch = normalized.match(
      /^DELETE FROM ([a-z_]+) WHERE id = \$1 AND (updated_at|created_at) <= \$2/i,
    )
    if (deleteMatch) {
      const tbl = tables.get(deleteMatch[1])!
      const tsField = deleteMatch[2] as 'updated_at' | 'created_at'
      const id = String(values[0])
      const deletedAt = String(values[1])
      const cur = tbl.get(id)
      if (cur && (cur[tsField] ?? '') <= deletedAt) {
        tbl.delete(id)
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }

    // DELETE FROM <table> WHERE id = $1 (nettoyage direct des enregistrements mocks hérités)
    const directDeleteMatch = normalized.match(
      /^DELETE FROM ([a-z_]+) WHERE id = \$1$/i,
    )
    if (directDeleteMatch) {
      const tbl = tables.get(directDeleteMatch[1])!
      const id = String(values[0])
      const existed = tbl.delete(id)
      return { rows: [], rowCount: existed ? 1 : 0 }
    }

    // INSERT INTO <table> (...) VALUES (...) ON CONFLICT ...
    const insertMatch = normalized.match(
      /^INSERT INTO ([a-z_]+)\s*\(([^)]+)\)/i,
    )
    if (insertMatch) {
      const tableName = insertMatch[1]
      const cols = insertMatch[2].split(',').map((c) => c.trim())
      const tbl = tables.get(tableName)
      if (!tbl) throw new Error(`Unknown table ${tableName}`)

      const idIdx = cols.indexOf('id')
      const updatedIdx = cols.indexOf('updated_at')
      const createdIdx = cols.indexOf('created_at')
      const payloadIdx = cols.indexOf('payload_json')

      const id = String(values[idIdx])
      const incomingUpdated =
        updatedIdx >= 0 ? String(values[updatedIdx]) : undefined
      const incomingCreated =
        createdIdx >= 0 ? String(values[createdIdx]) : undefined
      const rawJson = values[payloadIdx]
      const parsedPayload =
        typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson

      const existing = tbl.get(id)

      // ON CONFLICT DO NOTHING (tables immuables)
      if (normalized.includes('DO NOTHING')) {
        if (existing) {
          return { rows: [], rowCount: 0 }
        }
        tbl.set(id, {
          id,
          created_at: incomingCreated,
          payload_json: parsedPayload,
        })
        return { rows: [], rowCount: 1 }
      }

      // ON CONFLICT (id) DO UPDATE ... WHERE <table>.updated_at < EXCLUDED.updated_at
      if (existing && existing.updated_at && incomingUpdated) {
        if (!(existing.updated_at < incomingUpdated)) {
          return { rows: [], rowCount: 0 }
        }
      }

      tbl.set(id, {
        id,
        updated_at: incomingUpdated,
        created_at: incomingCreated,
        payload_json: parsedPayload,
      })
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
