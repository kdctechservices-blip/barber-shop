import type {
  AdvanceEntry,
  AppSettings,
  BonusEntry,
  BudgetTarget,
  CashMovement,
  CashSession,
  CategoryItem,
  CorrectionLog,
  Employee,
  ExpenseEntry,
  ProductItem,
  RecurringExpenseTemplate,
  RevenueEntry,
  SalaryPayment,
  SalonBackupPayload,
  SalonInfo,
  SalonUserAccount,
  ServiceCatalogItem,
  StockMovement,
  SyncTombstoneEntityType,
} from '../src/domain/models/index.ts'
import {
  isLegacyMockRecord,
  isLegacyRecurringPresetRecord,
  sanitizeLegacySalonInfo,
  stripLegacyDemoFlag,
} from '../src/domain/mockPurge.ts'
import type { SqlPoolLike, SqlQueryable } from './neonClient.ts'
import { runMigrations } from './migrations.ts'
import { isTenantId, setTenantContext } from './tenantContext.ts'

export type { SyncTombstoneEntityType }

export interface SyncTombstone {
  entityType: SyncTombstoneEntityType
  entityId: string
  deletedAt: string
}

const TOMBSTONE_TABLE_MAP: Record<
  SyncTombstoneEntityType,
  { table: string; tsCol: 'updated_at' | 'created_at' }
> = {
  service: { table: 'services_catalog', tsCol: 'updated_at' },
  employee: { table: 'employees', tsCol: 'updated_at' },
  revenue: { table: 'revenues', tsCol: 'updated_at' },
  expense: { table: 'expenses', tsCol: 'updated_at' },
  recurring_expense: { table: 'recurring_expenses', tsCol: 'updated_at' },
  cash_session: { table: 'cash_sessions', tsCol: 'updated_at' },
  cash_movement: { table: 'cash_movements', tsCol: 'updated_at' },
  advance: { table: 'advances', tsCol: 'updated_at' },
  bonus: { table: 'bonuses', tsCol: 'created_at' },
  salary_payment: { table: 'salary_payments', tsCol: 'updated_at' },
  product: { table: 'products', tsCol: 'updated_at' },
  stock_movement: { table: 'stock_movements', tsCol: 'created_at' },
  budget: { table: 'budgets', tsCol: 'updated_at' },
  correction_log: { table: 'correction_logs', tsCol: 'created_at' },
}

export interface CloudSyncEnvelope {
  payload: SalonBackupPayload
  tombstones?: SyncTombstone[]
}

export interface CloudSyncResult {
  ok: true
  syncedAt: string
  stats: {
    pushedRecords: number
    totalRemoteRecords: number
    tombstonesApplied: number
  }
  /** État complet — renvoyé uniquement aux clients qui ne fournissent pas de curseur. */
  payload?: SalonBackupPayload
  /** Tombstones connus — idem. */
  tombstones?: SyncTombstone[]
  /** Curseur de révision serveur à renvoyer au prochain push/pull. */
  cursor: string
  /** Changements survenus depuis le curseur fourni (delta), par table. */
  changes?: Record<string, unknown[]>
  /** Suppressions survenues depuis le curseur fourni. */
  deleted?: SyncTombstone[]
}

/**
 * Retire les comptes utilisateurs d'un payload de synchronisation.
 * Défense en profondeur : même si un client (ou un attaquant) envoie des
 * comptes, ils ne sont ni persistés, ni renvoyés.
 */
export function stripUsersFromSyncPayload(payload: SalonBackupPayload): {
  payload: SalonBackupPayload
  hadUsers: boolean
} {
  const hadUsers = Array.isArray(payload.users) && payload.users.length > 0
  if (!hadUsers) return { payload, hadUsers }
  const { users: _ignoredUsers, ...rest } = payload
  void _ignoredUsers
  return { payload: rest as SalonBackupPayload, hadUsers }
}

let schemaInitializedForPool = new WeakSet<object>()

/**
 * Applique les migrations versionnées (voir `server/migrations.ts`).
 * Conservé sous ce nom pour compatibilité avec les appelants existants.
 */
export async function ensureNeonSchema(pool: SqlPoolLike): Promise<void> {
  if (schemaInitializedForPool.has(pool)) return
  await runMigrations(pool)
  schemaInitializedForPool.add(pool)
}

export function resetSchemaCacheForTests(): void {
  schemaInitializedForPool = new WeakSet<object>()
}

interface PayloadRow<T> {
  payload_json: T | string
}

function parseJsonRow<T>(raw: T | string): T {
  return typeof raw === 'string' ? (JSON.parse(raw) as T) : raw
}

async function readRows<T>(
  db: SqlQueryable,
  tableName: string,
  orderByCol: string,
  whereSql = '',
  params: unknown[] = [],
): Promise<T[]> {
  const res = await db.query<PayloadRow<T>>(
    `SELECT payload_json FROM ${tableName} ${whereSql} ORDER BY ${orderByCol} ASC`,
    params,
  )
  return res.rows.map((r) => parseJsonRow<T>(r.payload_json))
}

async function readAndPurgeMockRows<T extends { id: string }>(
  db: SqlQueryable,
  tableName: string,
  entityType: SyncTombstoneEntityType,
  orderByCol: string,
  rejectFn: (row: T) => boolean = isLegacyMockRecord,
): Promise<T[]> {
  const rows = await readRows<T>(db, tableName, orderByCol)
  const clean: T[] = []
  const nowIso = new Date().toISOString()
  for (const row of rows) {
    if (rejectFn(row)) {
      await db.query(`DELETE FROM ${tableName} WHERE id = $1`, [row.id])
      await db.query(
        `INSERT INTO sync_tombstones (entity_type, entity_id, deleted_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (entity_type, entity_id) DO UPDATE SET
           deleted_at = EXCLUDED.deleted_at
         WHERE EXCLUDED.deleted_at > sync_tombstones.deleted_at`,
        [entityType, row.id, nowIso],
      )
    } else {
      clean.push(stripLegacyDemoFlag(row).cleaned)
    }
  }
  return clean
}

export async function readFullCloudState(
  db: SqlQueryable,
  tenantId: string,
): Promise<{
  payload: SalonBackupPayload | null
  tombstones: SyncTombstone[]
  totalRemoteRecords: number
}> {
  const [
    salonRows,
    settingsRows,
    categories,
    servicesClean,
    employeesClean,
    revenuesClean,
    expensesClean,
    recurringClean,
    cashSessionsClean,
    cashMovementsClean,
    advancesClean,
    bonusesClean,
    salaryPaymentsClean,
    productsClean,
    stockMovementsClean,
    budgetsClean,
    users,
    correctionLogsClean,
    tombstoneRes,
  ] = await Promise.all([
    readRows<SalonInfo>(db, 'salon_info', 'updated_at'),
    readRows<AppSettings>(db, 'app_settings', 'updated_at'),
    readRows<CategoryItem>(db, 'categories', 'updated_at'),
    readAndPurgeMockRows<ServiceCatalogItem>(
      db,
      'services_catalog',
      'service',
      'updated_at',
    ),
    readAndPurgeMockRows<Employee>(db, 'employees', 'employee', 'updated_at'),
    readAndPurgeMockRows<RevenueEntry>(db, 'revenues', 'revenue', 'date'),
    readAndPurgeMockRows<ExpenseEntry>(db, 'expenses', 'expense', 'date'),
    readAndPurgeMockRows<RecurringExpenseTemplate>(
      db,
      'recurring_expenses',
      'recurring_expense',
      'updated_at',
      isLegacyRecurringPresetRecord,
    ),
    readAndPurgeMockRows<CashSession>(
      db,
      'cash_sessions',
      'cash_session',
      'opened_at',
    ),
    readAndPurgeMockRows<CashMovement>(
      db,
      'cash_movements',
      'cash_movement',
      'occurred_at',
    ),
    readAndPurgeMockRows<AdvanceEntry>(db, 'advances', 'advance', 'paid_at'),
    readAndPurgeMockRows<BonusEntry>(db, 'bonuses', 'bonus', 'created_at'),
    readAndPurgeMockRows<SalaryPayment>(
      db,
      'salary_payments',
      'salary_payment',
      'paid_at',
    ),
    readAndPurgeMockRows<ProductItem>(db, 'products', 'product', 'updated_at'),
    readAndPurgeMockRows<StockMovement>(
      db,
      'stock_movements',
      'stock_movement',
      'occurred_at',
    ),
    readAndPurgeMockRows<BudgetTarget>(
      db,
      'budgets',
      'budget',
      'period_month',
    ),
    readRows<SalonUserAccount>(
      db,
      'salon_users',
      'created_at',
      'WHERE tenant_id = $1',
      [tenantId],
    ),
    readAndPurgeMockRows<CorrectionLog>(
      db,
      'correction_logs',
      'correction_log',
      'created_at',
    ),
    db.query<{
      entity_type: SyncTombstoneEntityType
      entity_id: string
      deleted_at: string
    }>(
      'SELECT entity_type, entity_id, deleted_at FROM sync_tombstones ORDER BY deleted_at ASC',
    ),
  ])

  const tombstones: SyncTombstone[] = tombstoneRes.rows.map((r) => ({
    entityType: r.entity_type,
    entityId: r.entity_id,
    deletedAt: r.deleted_at,
  }))

  const totalRemoteRecords =
    revenuesClean.length +
    expensesClean.length +
    cashSessionsClean.length +
    cashMovementsClean.length +
    servicesClean.length +
    employeesClean.length +
    productsClean.length +
    stockMovementsClean.length +
    advancesClean.length +
    bonusesClean.length +
    salaryPaymentsClean.length +
    budgetsClean.length +
    recurringClean.length +
    correctionLogsClean.length

  const activeManager =
    users.find((u) => u.role === 'manager' && u.isActive) ?? users[0] ?? null
  const rawSalon = salonRows[0]
  let salon: SalonInfo | undefined
  if (rawSalon) {
    const nowIso = new Date().toISOString()
    const { cleaned, changed } = sanitizeLegacySalonInfo(
      rawSalon,
      activeManager,
      nowIso,
    )
    salon = cleaned
    if (changed) {
      await db.query(
        `INSERT INTO salon_info (id, name, address, phone, manager_name, currency, updated_at, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           name = EXCLUDED.name,
           address = EXCLUDED.address,
           phone = EXCLUDED.phone,
           manager_name = EXCLUDED.manager_name,
           updated_at = EXCLUDED.updated_at,
           payload_json = EXCLUDED.payload_json
         WHERE salon_info.payload_json IS DISTINCT FROM EXCLUDED.payload_json`,
        [
          'salon-main',
          cleaned.name,
          cleaned.address,
          cleaned.phone,
          cleaned.managerName,
          'XOF',
          cleaned.updatedAt,
          JSON.stringify({ ...cleaned, id: 'salon-main' }),
        ],
      )
    }
  }
  const settings = settingsRows[0]

  if (!salon || !settings) {
    return {
      payload: null,
      tombstones,
      totalRemoteRecords,
    }
  }

  return {
    payload: {
      format: 'SALON_PRO_BACKUP_V1',
      exportedAt: new Date().toISOString(),
      salon,
      settings,
      categories,
      services: servicesClean,
      employees: employeesClean,
      revenues: revenuesClean,
      expenses: expensesClean,
      cashSessions: cashSessionsClean,
      cashMovements: cashMovementsClean,
      advances: advancesClean,
      bonuses: bonusesClean,
      salaryPayments: salaryPaymentsClean,
      products: productsClean,
      stockMovements: stockMovementsClean,
      budgets: budgetsClean,
      recurringExpenses: recurringClean,
      // `users` est volontairement exclu : les comptes (rôles + hashes) ne sont
      // jamais exposés à un client via la synchronisation (audit §6.1 S1).
      correctionLogs: correctionLogsClean,
    },
    tombstones,
    totalRemoteRecords,
  }
}


/* -------------------------------------------------------------------------- */
/* Synchronisation delta serveur-autoritaire (P0-6)                            */
/* -------------------------------------------------------------------------- */

/**
 * Correspondance entre les tables SQL et les clés du payload de sauvegarde.
 * `single` signale les tables à une seule ligne (salon, réglages).
 */
const DELTA_TABLES: Array<{
  table: string
  key: keyof SalonBackupPayload
  single?: boolean
}> = [
  { table: 'salon_info', key: 'salon', single: true },
  { table: 'app_settings', key: 'settings', single: true },
  { table: 'categories', key: 'categories' },
  { table: 'services_catalog', key: 'services' },
  { table: 'employees', key: 'employees' },
  { table: 'cash_sessions', key: 'cashSessions' },
  { table: 'cash_movements', key: 'cashMovements' },
  { table: 'revenues', key: 'revenues' },
  { table: 'expenses', key: 'expenses' },
  { table: 'recurring_expenses', key: 'recurringExpenses' },
  { table: 'products', key: 'products' },
  { table: 'stock_movements', key: 'stockMovements' },
  { table: 'advances', key: 'advances' },
  { table: 'bonuses', key: 'bonuses' },
  { table: 'salary_payments', key: 'salaryPayments' },
  { table: 'budgets', key: 'budgets' },
  { table: 'correction_logs', key: 'correctionLogs' },
]

interface ChangeEntry {
  table: string
  rowId: string
  op: 'upsert' | 'delete'
  payload: unknown
}

function indexRows(
  payload: SalonBackupPayload | null,
): Map<string, string> {
  const index = new Map<string, string>()
  if (!payload) return index
  for (const { table, key, single } of DELTA_TABLES) {
    if (single) {
      const row = payload[key] as unknown
      if (row && typeof row === 'object' && 'id' in (row as object)) {
        const id = String((row as { id: string }).id)
        index.set(`${table}:${id}`, JSON.stringify(row))
      }
      continue
    }
    const rows = (payload[key] as unknown[] | undefined) ?? []
    for (const row of rows) {
      if (!row || typeof row !== 'object' || !('id' in (row as object))) continue
      const id = String((row as { id: string }).id)
      index.set(`${table}:${id}`, JSON.stringify(row))
    }
  }
  return index
}


/**
 * Filtre les lignes « périmées » d'un push complet (sans curseur).
 *
 * Un client qui n'a pas encore récupéré l'état serveur envoie un instantané
 * complet : sans ce filtre, un appareil resté hors-ligne écraserait des données
 * plus récentes. Les clients qui présentent un curseur sont, eux, à jour : leurs
 * écritures sont appliquées dans l'ordre d'arrivée (autorité serveur).
 */
function dropStaleRows(
  incoming: SalonBackupPayload,
  stored: SalonBackupPayload | null,
): SalonBackupPayload {
  if (!stored) return incoming
  const rowTimestamp = (row: unknown): string => {
    if (!row || typeof row !== 'object') return ''
    const record = row as { updatedAt?: string; createdAt?: string }
    return record.updatedAt ?? record.createdAt ?? ''
  }
  const indexById = (rows: unknown[] | undefined): Map<string, unknown> => {
    const map = new Map<string, unknown>()
    for (const row of rows ?? []) {
      if (row && typeof row === 'object' && 'id' in (row as object)) {
        map.set(String((row as { id: string }).id), row)
      }
    }
    return map
  }

  const next: SalonBackupPayload = { ...incoming }

  for (const { key, single } of DELTA_TABLES) {
    if (single) {
      const incomingRow = incoming[key] as unknown
      const storedRow = stored[key] as unknown
      if (
        incomingRow &&
        storedRow &&
        rowTimestamp(incomingRow) < rowTimestamp(storedRow)
      ) {
        ;(next as unknown as Record<string, unknown>)[key] = undefined
      }
      continue
    }
    const storedIndex = indexById(stored[key] as unknown[] | undefined)
    const kept = ((incoming[key] as unknown[] | undefined) ?? []).filter(
      (row) => {
        if (!row || typeof row !== 'object' || !('id' in (row as object))) {
          return true
        }
        const storedRow = storedIndex.get(String((row as { id: string }).id))
        if (!storedRow) return true
        return rowTimestamp(row) >= rowTimestamp(storedRow)
      },
    )
    ;(next as unknown as Record<string, unknown>)[key] = kept
  }

  return next
}

/**
 * Compare deux états complets et produit la liste des changements réels.
 * Le serveur est seul juge : ce sont les états **stockés** qui sont comparés,
 * jamais les horodatages fournis par les clients.
 */
function diffCloudStates(
  before: {
    payload: SalonBackupPayload | null
    tombstones: SyncTombstone[]
  },
  after: { payload: SalonBackupPayload | null; tombstones: SyncTombstone[] },
): ChangeEntry[] {
  const beforeIndex = indexRows(before.payload)
  const afterIndex = indexRows(after.payload)
  const entries: ChangeEntry[] = []

  for (const [compositeKey, serialized] of afterIndex) {
    if (beforeIndex.get(compositeKey) === serialized) continue
    const separator = compositeKey.indexOf(':')
    const table = compositeKey.slice(0, separator)
    const rowId = compositeKey.slice(separator + 1)
    entries.push({
      table,
      rowId,
      op: 'upsert',
      payload: JSON.parse(serialized) as unknown,
    })
  }

  const beforeTombstones = new Set(
    before.tombstones.map((tb) => `${tb.entityType}:${tb.entityId}`),
  )
  for (const tb of after.tombstones) {
    const key = `${tb.entityType}:${tb.entityId}`
    if (beforeTombstones.has(key)) continue
    entries.push({ table: 'sync_tombstones', rowId: key, op: 'delete', payload: tb })
  }

  return entries
}

/**
 * Alloue des révisions et journalise les changements dans `sync_changes`.
 * Le verrou `FOR UPDATE` sur `sync_state` sérialise les push d'un même salon :
 * l'ordre de validation des révisions est donc l'ordre d'attribution, ce qui
 * interdit les « trous » qu'un lecteur pourrait manquer.
 */
async function appendSyncChanges(
  client: SqlQueryable,
  tenantId: string,
  entries: ChangeEntry[],
): Promise<string> {
  await client.query(
    'INSERT INTO sync_state (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING',
    [tenantId],
  )
  const lockRes = await client.query<{ revision: string | number }>(
    'SELECT revision FROM sync_state WHERE tenant_id = $1 FOR UPDATE',
    [tenantId],
  )
  const current = Number(lockRes.rows[0]?.revision ?? 0)

  if (entries.length === 0) return String(current)

  const nextRes = await client.query<{ revision: string | number }>(
    `UPDATE sync_state
        SET revision = revision + $2, updated_at = now()
      WHERE tenant_id = $1
      RETURNING revision`,
    [tenantId, entries.length],
  )
  const next = Number(nextRes.rows[0]?.revision ?? current + entries.length)
  const first = next - entries.length + 1

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    await client.query(
      `INSERT INTO sync_changes (tenant_id, seq, table_name, row_id, op, payload_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        tenantId,
        first + i,
        entry.table,
        entry.rowId,
        entry.op,
        entry.payload === null || entry.payload === undefined
          ? null
          : JSON.stringify(entry.payload),
      ],
    )
  }

  return String(next)
}

/** Révision courante (curseur) d'un salon. */
export async function readSyncRevision(
  db: SqlQueryable,
  tenantId: string,
): Promise<string> {
  const res = await db.query<{ revision: string | number }>(
    'SELECT revision FROM sync_state WHERE tenant_id = $1',
    [tenantId],
  )
  return String(Number(res.rows[0]?.revision ?? 0))
}

/**
 * Lit le journal des changements postérieurs à `since` et le condense :
 * une seule entrée par ligne (la plus récente), plus les suppressions.
 */
export async function readSyncChangesSince(
  db: SqlQueryable,
  tenantId: string,
  since: string | number | undefined,
): Promise<{
  cursor: string
  changes: Record<string, unknown[]>
  deleted: SyncTombstone[]
}> {
  const sinceValue = Number(since ?? 0)
  const safeSince = Number.isFinite(sinceValue) && sinceValue > 0 ? sinceValue : 0

  const res = await db.query<{
    seq: string | number
    table_name: string
    row_id: string
    op: string
    payload_json: unknown
  }>(
    `SELECT seq, table_name, row_id, op, payload_json
       FROM sync_changes
      WHERE tenant_id = $1 AND seq > $2
      ORDER BY seq ASC`,
    [tenantId, safeSince],
  )

  const revisionRes = await db.query<{ revision: string | number }>(
    'SELECT revision FROM sync_state WHERE tenant_id = $1',
    [tenantId],
  )
  const revision = Number(revisionRes.rows[0]?.revision ?? 0)

  const latest = new Map<string, { op: string; payload: unknown }>()
  let maxSeq = safeSince
  for (const row of res.rows) {
    const seq = Number(row.seq)
    if (seq > maxSeq) maxSeq = seq
    latest.set(`${row.table_name}:${row.row_id}`, {
      op: row.op,
      payload:
        typeof row.payload_json === 'string'
          ? JSON.parse(row.payload_json)
          : row.payload_json,
    })
  }

  const changes: Record<string, unknown[]> = {}
  const deleted: SyncTombstone[] = []
  for (const [compositeKey, entry] of latest) {
    if (entry.op === 'delete') {
      const tombstone = entry.payload as SyncTombstone | null
      if (tombstone?.entityType && tombstone?.entityId) deleted.push(tombstone)
      continue
    }
    const table = compositeKey.slice(0, compositeKey.indexOf(':'))
    if (!entry.payload) continue
    changes[table] = changes[table] ?? []
    changes[table].push(entry.payload)
  }

  return {
    cursor: String(Math.max(maxSeq, revision)),
    changes,
    deleted,
  }
}

/**
 * Synchronisation bidirectionnelle transactionnelle, **autoritaire côté serveur**.
 *
 * Les clients envoient leur état ; le serveur décide de l'ordre (arrivée), de
 * l'état retenu et attribue une révision monotone. Un client qui fournit un
 * curseur (`cursor`) reçoit uniquement le **delta** des changements survenus
 * depuis, y compris ceux des autres appareils.
 */
export async function syncWithNeonDatabase(
  pool: SqlPoolLike,
  incoming: CloudSyncEnvelope,
  tenantId: string,
  options?: { cursor?: string | number },
): Promise<CloudSyncResult> {
  if (!isTenantId(tenantId)) {
    throw new Error('Synchronisation refusée : contexte de salon invalide.')
  }
  await ensureNeonSchema(pool)
  const client = await pool.connect()
  const syncedAt = new Date().toISOString()
  let pushedRecords = 0
  let tombstonesApplied = 0

  try {
    await client.query('BEGIN')
    await setTenantContext(client, tenantId)

    // État avant application : sert à calculer le delta réel (contenus comparés,
    // jamais les horodatages fournis par les clients).
    const before = await readFullCloudState(client, tenantId)

    const { payload: rawPayload, hadUsers } = stripUsersFromSyncPayload(
      incoming.payload,
    )
    if (hadUsers) {
      console.warn(
        '[security] Payload de synchronisation contenant des comptes ignoré : ' +
          "l'administration des comptes passe exclusivement par /api/users.",
      )
    }

    const cursorProvidedEarly =
      options?.cursor !== undefined && options?.cursor !== null
    // Push « à l'aveugle » (sans curseur) : les lignes plus anciennes que l'état
    // serveur sont écartées pour ne pas écraser des données récentes.
    const p = cursorProvidedEarly
      ? rawPayload
      : dropStaleRows(rawPayload, before.payload)

    // 1. SalonInfo (nettoyé de toute valeur fictive héritée)
    if (p.salon) {
      const cleanSalon = sanitizeLegacySalonInfo(
        p.salon,
        null,
        p.salon.updatedAt,
      ).cleaned
      const r = await client.query(
        `INSERT INTO salon_info (id, name, address, phone, manager_name, currency, updated_at, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           name = EXCLUDED.name,
           address = EXCLUDED.address,
           phone = EXCLUDED.phone,
           manager_name = EXCLUDED.manager_name,
           updated_at = EXCLUDED.updated_at,
           payload_json = EXCLUDED.payload_json
         WHERE salon_info.payload_json IS DISTINCT FROM EXCLUDED.payload_json`,
        [
          'salon-main',
          cleanSalon.name,
          cleanSalon.address,
          cleanSalon.phone,
          cleanSalon.managerName,
          'XOF',
          cleanSalon.updatedAt,
          JSON.stringify({ ...cleanSalon, id: 'salon-main' }),
        ],
      )
      pushedRecords += r.rowCount ?? 0
    }

    // 2. AppSettings
    if (p.settings) {
      const r = await client.query(
        `INSERT INTO app_settings (id, theme, date_format, receipt_format, last_backup_exported_at, updated_at, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           theme = EXCLUDED.theme,
           date_format = EXCLUDED.date_format,
           receipt_format = EXCLUDED.receipt_format,
           last_backup_exported_at = EXCLUDED.last_backup_exported_at,
           updated_at = EXCLUDED.updated_at,
           payload_json = EXCLUDED.payload_json
         WHERE app_settings.payload_json IS DISTINCT FROM EXCLUDED.payload_json`,
        [
          'default',
          p.settings.theme,
          p.settings.dateFormat,
          p.settings.receiptFormat ?? 'thermal_80mm',
          p.settings.lastBackupExportedAt ?? null,
          p.settings.updatedAt,
          JSON.stringify({ ...p.settings, id: 'default' }),
        ],
      )
      pushedRecords += r.rowCount ?? 0
    }

    // 3. Categories
    for (const c of p.categories ?? []) {
      const r = await client.query(
        `INSERT INTO categories (id, scope, code, label, is_system, is_archived, updated_at, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           label = EXCLUDED.label,
           is_archived = EXCLUDED.is_archived,
           updated_at = EXCLUDED.updated_at,
           payload_json = EXCLUDED.payload_json
         WHERE categories.payload_json IS DISTINCT FROM EXCLUDED.payload_json`,
        [
          c.id,
          c.scope,
          c.code,
          c.label,
          c.isSystem,
          c.isArchived,
          c.updatedAt,
          JSON.stringify(c),
        ],
      )
      pushedRecords += r.rowCount ?? 0
    }

    // 4. Services
    for (const s of (p.services ?? []).filter((x) => !isLegacyMockRecord(x))) {
      const r = await client.query(
        `INSERT INTO services_catalog (id, name, category_code, reference_price, is_active, updated_at, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           name = EXCLUDED.name,
           category_code = EXCLUDED.category_code,
           reference_price = EXCLUDED.reference_price,
           is_active = EXCLUDED.is_active,
           updated_at = EXCLUDED.updated_at,
           payload_json = EXCLUDED.payload_json
         WHERE services_catalog.payload_json IS DISTINCT FROM EXCLUDED.payload_json`,
        [
          s.id,
          s.name,
          s.categoryCode,
          Math.round(s.referencePrice),
          s.isActive,
          s.updatedAt,
          JSON.stringify(s),
        ],
      )
      pushedRecords += r.rowCount ?? 0
    }

    // 5. Employees
    for (const e of (p.employees ?? []).filter((x) => !isLegacyMockRecord(x))) {
      const r = await client.query(
        `INSERT INTO employees (id, full_name, role_title, base_salary, remuneration_type, commission_enabled, commission_rate, is_active, updated_at, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           full_name = EXCLUDED.full_name,
           role_title = EXCLUDED.role_title,
           base_salary = EXCLUDED.base_salary,
           remuneration_type = EXCLUDED.remuneration_type,
           commission_enabled = EXCLUDED.commission_enabled,
           commission_rate = EXCLUDED.commission_rate,
           is_active = EXCLUDED.is_active,
           updated_at = EXCLUDED.updated_at,
           payload_json = EXCLUDED.payload_json
         WHERE employees.payload_json IS DISTINCT FROM EXCLUDED.payload_json`,
        [
          e.id,
          e.fullName,
          e.roleTitle,
          Math.round(e.baseSalary),
          e.remunerationType,
          e.commissionEnabled,
          e.commissionRate,
          e.isActive,
          e.updatedAt,
          JSON.stringify(e),
        ],
      )
      pushedRecords += r.rowCount ?? 0
    }

    // 6. CashSessions & CashMovements
    for (const cs of (p.cashSessions ?? []).filter(
      (x) => !isLegacyMockRecord(x),
    )) {
      const r = await client.query(
        `INSERT INTO cash_sessions (id, opened_at, closed_at, opening_balance, theoretical_closing_balance, counted_closing_balance, discrepancy, status, updated_at, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           closed_at = EXCLUDED.closed_at,
           theoretical_closing_balance = EXCLUDED.theoretical_closing_balance,
           counted_closing_balance = EXCLUDED.counted_closing_balance,
           discrepancy = EXCLUDED.discrepancy,
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at,
           payload_json = EXCLUDED.payload_json
         WHERE cash_sessions.payload_json IS DISTINCT FROM EXCLUDED.payload_json`,
        [
          cs.id,
          cs.openedAt,
          cs.closedAt ?? null,
          Math.round(cs.openingBalance),
          Math.round(cs.theoreticalClosingBalance),
          cs.countedClosingBalance !== undefined
            ? Math.round(cs.countedClosingBalance)
            : null,
          cs.discrepancy !== undefined ? Math.round(cs.discrepancy) : null,
          cs.status,
          cs.updatedAt,
          JSON.stringify(cs),
        ],
      )
      pushedRecords += r.rowCount ?? 0
    }

    for (const cm of (p.cashMovements ?? []).filter(
      (x) => !isLegacyMockRecord(x),
    )) {
      const r = await client.query(
        `INSERT INTO cash_movements (id, session_id, type, amount, occurred_at, updated_at, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           amount = EXCLUDED.amount,
           updated_at = EXCLUDED.updated_at,
           payload_json = EXCLUDED.payload_json
         WHERE cash_movements.payload_json IS DISTINCT FROM EXCLUDED.payload_json`,
        [
          cm.id,
          cm.sessionId,
          cm.type,
          Math.round(cm.amount),
          cm.occurredAt,
          cm.updatedAt,
          JSON.stringify(cm),
        ],
      )
      pushedRecords += r.rowCount ?? 0
    }

    // 7. Revenues
    for (const rev of (p.revenues ?? []).filter(
      (x) => !isLegacyMockRecord(x),
    )) {
      const r = await client.query(
        `INSERT INTO revenues (id, ticket_id, receipt_number, date, label, category_code, employee_id, amount, payment_method, is_archived, updated_at, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           date = EXCLUDED.date,
           label = EXCLUDED.label,
           category_code = EXCLUDED.category_code,
           employee_id = EXCLUDED.employee_id,
           amount = EXCLUDED.amount,
           payment_method = EXCLUDED.payment_method,
           is_archived = EXCLUDED.is_archived,
           updated_at = EXCLUDED.updated_at,
           payload_json = EXCLUDED.payload_json
         WHERE revenues.payload_json IS DISTINCT FROM EXCLUDED.payload_json`,
        [
          rev.id,
          rev.ticketId ?? null,
          rev.receiptNumber ?? null,
          rev.date,
          rev.label,
          rev.categoryCode,
          rev.employeeId ?? null,
          Math.round(rev.amount),
          rev.paymentMethod,
          Boolean(rev.isArchived),
          rev.updatedAt,
          JSON.stringify(rev),
        ],
      )
      pushedRecords += r.rowCount ?? 0
    }

    // 8. Expenses & RecurringExpenses
    for (const exp of (p.expenses ?? []).filter(
      (x) => !isLegacyMockRecord(x),
    )) {
      const r = await client.query(
        `INSERT INTO expenses (id, date, label, category_code, amount, payment_method, source_module, is_stock_purchase, is_archived, updated_at, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           date = EXCLUDED.date,
           label = EXCLUDED.label,
           category_code = EXCLUDED.category_code,
           amount = EXCLUDED.amount,
           payment_method = EXCLUDED.payment_method,
           is_archived = EXCLUDED.is_archived,
           updated_at = EXCLUDED.updated_at,
           payload_json = EXCLUDED.payload_json
         WHERE expenses.payload_json IS DISTINCT FROM EXCLUDED.payload_json`,
        [
          exp.id,
          exp.date,
          exp.label,
          exp.categoryCode,
          Math.round(exp.amount),
          exp.paymentMethod,
          exp.sourceModule,
          Boolean(exp.isStockPurchase),
          Boolean(exp.isArchived),
          exp.updatedAt,
          JSON.stringify(exp),
        ],
      )
      pushedRecords += r.rowCount ?? 0
    }

    for (const tpl of (p.recurringExpenses ?? []).filter(
      (x) => !isLegacyRecurringPresetRecord(x),
    )) {
      const r = await client.query(
        `INSERT INTO recurring_expenses (id, label, category_code, default_amount, day_of_month, is_active, updated_at, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           label = EXCLUDED.label,
           category_code = EXCLUDED.category_code,
           default_amount = EXCLUDED.default_amount,
           day_of_month = EXCLUDED.day_of_month,
           is_active = EXCLUDED.is_active,
           updated_at = EXCLUDED.updated_at,
           payload_json = EXCLUDED.payload_json
         WHERE recurring_expenses.payload_json IS DISTINCT FROM EXCLUDED.payload_json`,
        [
          tpl.id,
          tpl.label,
          tpl.categoryCode,
          Math.round(tpl.defaultAmount),
          tpl.dayOfMonth,
          tpl.isActive,
          tpl.updatedAt,
          JSON.stringify(tpl),
        ],
      )
      pushedRecords += r.rowCount ?? 0
    }

    // 9. Products & StockMovements
    for (const prd of (p.products ?? []).filter(
      (x) => !isLegacyMockRecord(x),
    )) {
      const r = await client.query(
        `INSERT INTO products (id, sku, name, category_code, quantity, cost_price, sale_price, alert_threshold, usage_type, is_active, updated_at, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           sku = EXCLUDED.sku,
           name = EXCLUDED.name,
           category_code = EXCLUDED.category_code,
           quantity = EXCLUDED.quantity,
           cost_price = EXCLUDED.cost_price,
           sale_price = EXCLUDED.sale_price,
           alert_threshold = EXCLUDED.alert_threshold,
           usage_type = EXCLUDED.usage_type,
           is_active = EXCLUDED.is_active,
           updated_at = EXCLUDED.updated_at,
           payload_json = EXCLUDED.payload_json
         WHERE products.payload_json IS DISTINCT FROM EXCLUDED.payload_json`,
        [
          prd.id,
          prd.sku,
          prd.name,
          prd.categoryCode,
          Math.round(prd.quantity),
          Math.round(prd.costPrice),
          prd.salePrice !== undefined ? Math.round(prd.salePrice) : null,
          Math.round(prd.alertThreshold),
          prd.usageType,
          prd.isActive,
          prd.updatedAt,
          JSON.stringify(prd),
        ],
      )
      pushedRecords += r.rowCount ?? 0
    }

    for (const sm of (p.stockMovements ?? []).filter(
      (x) => !isLegacyMockRecord(x),
    )) {
      const r = await client.query(
        `INSERT INTO stock_movements (id, product_id, type, quantity_delta, quantity_after, unit_cost, occurred_at, created_at, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [
          sm.id,
          sm.productId,
          sm.type,
          Math.round(sm.quantityDelta),
          Math.round(sm.quantityAfter),
          Math.round(sm.unitCost),
          sm.occurredAt,
          sm.createdAt,
          JSON.stringify(sm),
        ],
      )
      pushedRecords += r.rowCount ?? 0
    }

    // 10. Advances, Bonuses, SalaryPayments
    for (const adv of (p.advances ?? []).filter(
      (x) => !isLegacyMockRecord(x),
    )) {
      const r = await client.query(
        `INSERT INTO advances (id, employee_id, period_month, amount, paid_at, is_archived, updated_at, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           is_archived = EXCLUDED.is_archived,
           updated_at = EXCLUDED.updated_at,
           payload_json = EXCLUDED.payload_json
         WHERE advances.payload_json IS DISTINCT FROM EXCLUDED.payload_json`,
        [
          adv.id,
          adv.employeeId,
          adv.periodMonth,
          Math.round(adv.amount),
          adv.paidAt,
          Boolean(adv.isArchived),
          adv.updatedAt,
          JSON.stringify(adv),
        ],
      )
      pushedRecords += r.rowCount ?? 0
    }

    for (const bon of (p.bonuses ?? []).filter(
      (x) => !isLegacyMockRecord(x),
    )) {
      const r = await client.query(
        `INSERT INTO bonuses (id, employee_id, period_month, amount, created_at, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [
          bon.id,
          bon.employeeId,
          bon.periodMonth,
          Math.round(bon.amount),
          bon.createdAt,
          JSON.stringify(bon),
        ],
      )
      pushedRecords += r.rowCount ?? 0
    }

    for (const sp of (p.salaryPayments ?? []).filter(
      (x) => !isLegacyMockRecord(x),
    )) {
      const r = await client.query(
        `INSERT INTO salary_payments (id, employee_id, period_month, net_paid_amount, is_partial, paid_at, updated_at, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           net_paid_amount = EXCLUDED.net_paid_amount,
           is_partial = EXCLUDED.is_partial,
           updated_at = EXCLUDED.updated_at,
           payload_json = EXCLUDED.payload_json
         WHERE salary_payments.payload_json IS DISTINCT FROM EXCLUDED.payload_json`,
        [
          sp.id,
          sp.employeeId,
          sp.periodMonth,
          Math.round(sp.netPaidAmount),
          Boolean(sp.isPartial),
          sp.paidAt,
          sp.updatedAt,
          JSON.stringify(sp),
        ],
      )
      pushedRecords += r.rowCount ?? 0
    }

    // 11. Budgets
    for (const bdg of (p.budgets ?? []).filter(
      (x) => !isLegacyMockRecord(x),
    )) {
      const r = await client.query(
        `INSERT INTO budgets (id, period_month, kind, category_code, planned_amount, updated_at, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           planned_amount = EXCLUDED.planned_amount,
           updated_at = EXCLUDED.updated_at,
           payload_json = EXCLUDED.payload_json
         WHERE budgets.payload_json IS DISTINCT FROM EXCLUDED.payload_json`,
        [
          bdg.id,
          bdg.periodMonth,
          bdg.kind,
          bdg.categoryCode,
          Math.round(bdg.plannedAmount),
          bdg.updatedAt,
          JSON.stringify(bdg),
        ],
      )
      pushedRecords += r.rowCount ?? 0
    }

    // Les comptes utilisateurs ne transitent JAMAIS par la synchronisation
    // (audit §6.1 S1) : ils sont administrés uniquement via /api/users*.

    for (const log of (p.correctionLogs ?? []).filter(
      (x) => !isLegacyMockRecord(x),
    )) {
      const r = await client.query(
        `INSERT INTO correction_logs (id, entity_type, entity_id, action, reason, created_at, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [
          log.id,
          log.entityType,
          log.entityId,
          log.action,
          log.reason,
          log.createdAt,
          JSON.stringify(log),
        ],
      )
      pushedRecords += r.rowCount ?? 0
    }

    // 13. Tombstones de suppressions définitives (budgets, modèles récurrents, prestations non utilisées)
    for (const tb of incoming.tombstones ?? []) {
      await client.query(
        `INSERT INTO sync_tombstones (entity_type, entity_id, deleted_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (entity_type, entity_id) DO UPDATE SET
           deleted_at = EXCLUDED.deleted_at
         WHERE EXCLUDED.deleted_at > sync_tombstones.deleted_at`,
        [tb.entityType, tb.entityId, tb.deletedAt],
      )
    }

    // Appliquer tous les tombstones connus en base sur les 14 tables métiers
    const allTombstonesRes = await client.query<{
      entity_type: SyncTombstoneEntityType
      entity_id: string
      deleted_at: string
    }>('SELECT entity_type, entity_id, deleted_at FROM sync_tombstones')

    for (const tb of allTombstonesRes.rows) {
      const mapping = TOMBSTONE_TABLE_MAP[tb.entity_type]
      if (!mapping) continue
      const delRes = await client.query(
        `DELETE FROM ${mapping.table} WHERE id = $1 AND ${mapping.tsCol} <= $2`,
        [tb.entity_id, tb.deleted_at],
      )
      tombstonesApplied += delRes.rowCount ?? 0
    }

    const merged = await readFullCloudState(client, tenantId)

    // Journalisation des changements réels + attribution des révisions.
    const entries = diffCloudStates(before, merged)
    await appendSyncChanges(client, tenantId, entries)

    const cursorProvided = options?.cursor !== undefined && options?.cursor !== null
    const delta = cursorProvided
      ? await readSyncChangesSince(client, tenantId, options?.cursor)
      : {
          cursor: await readSyncRevision(client, tenantId),
          changes: {} as Record<string, unknown[]>,
          deleted: [] as SyncTombstone[],
        }

    await client.query('COMMIT')

    return {
      ok: true,
      syncedAt,
      stats: {
        pushedRecords,
        totalRemoteRecords: merged.totalRemoteRecords,
        tombstonesApplied,
      },
      cursor: delta.cursor,
      changes: delta.changes,
      deleted: delta.deleted,
      // Compatibilité : un client sans curseur reçoit l'état complet.
      ...(cursorProvided
        ? {}
        : { payload: merged.payload ?? p, tombstones: merged.tombstones }),
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
