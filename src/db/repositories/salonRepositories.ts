import type { Table } from 'dexie'
import {
  calculateCashSessionSummary,
  calculateCUMP,
} from '../../domain/calculations/finance'
import {
  isLegacyMockRecord,
  isLegacyRecurringPresetRecord,
  sanitizeLegacySalonInfo,
  stripLegacyDemoFlag,
} from '../../domain/mockPurge'
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
  PaymentMethodCode,
  PersistedSyncTombstone,
  ProductItem,
  PublicSalonUser,
  RecurringExpenseTemplate,
  RevenueEntry,
  SalaryPayment,
  SalonBackupPayload,
  SalonInfo,
  SalonUserAccount,
  ServiceCatalogItem,
  ServiceCommissionOverride,
  ServiceDefaultConsumable,
  ServicePriceVariant,
  StockMovement,
  StockMovementType,
  SyncTombstoneEntityType,
  TicketConsumableUsage,
  TicketPaymentSplit,
  UserRole,
} from '../../domain/models'
import {
  hashPasswordPBKDF2,
  verifyPasswordPBKDF2,
} from '../../utils/passwordCrypto'
import {
  DuplicateSubmissionGuard,
  validateEmployeeInput,
  validateExpenseInput,
  validateNonNegativeFCFA,
  validatePositiveFCFA,
  validateProductInput,
  validateRevenueInput,
  validateServiceInput,
} from '../../domain/validators'
import { toIntFCFA } from '../../utils/format'
import { db, type SalonProDatabase } from '../database'
import {
  buildDefaultSalonInfo,
  buildDefaultSettings,
  buildSystemCategories,
} from '../seed'
import type { IRepository } from './types'

function makeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${Date.now()}-${rand}`
}

export class DexieTableRepository<T extends { id: string }>
  implements IRepository<T>
{
  private readonly table: Table<T, string>

  constructor(table: Table<T, string>) {
    this.table = table
  }

  async getAll(): Promise<T[]> {
    return this.table.toArray()
  }

  async getById(id: string): Promise<T | undefined> {
    return this.table.get(id)
  }

  async create(item: T): Promise<T> {
    await this.table.add(item)
    return item
  }

  async update(id: string, changes: Partial<T>): Promise<T> {
    await this.table.update(id, changes as never)
    const updated = await this.table.get(id)
    if (!updated) {
      throw new Error('Enregistrement introuvable après mise à jour.')
    }
    return updated
  }

  async archive(id: string): Promise<void> {
    await this.table.update(id, {
      isArchived: true,
      updatedAt: new Date().toISOString(),
    } as never)
  }

  async delete(id: string): Promise<void> {
    await this.table.delete(id)
  }
}

export interface FullSalonState {
  salon: SalonInfo
  settings: AppSettings
  categories: CategoryItem[]
  services: ServiceCatalogItem[]
  employees: Employee[]
  revenues: RevenueEntry[]
  expenses: ExpenseEntry[]
  cashSessions: CashSession[]
  cashMovements: CashMovement[]
  advances: AdvanceEntry[]
  bonuses: BonusEntry[]
  salaryPayments: SalaryPayment[]
  products: ProductItem[]
  stockMovements: StockMovement[]
  budgets: BudgetTarget[]
  recurringExpenses: RecurringExpenseTemplate[]
  correctionLogs: CorrectionLog[]
}

export interface CheckoutTicketLineInput {
  kind: 'service' | 'product'
  serviceId?: string
  serviceVariantId?: string
  serviceVariantLabel?: string
  productId?: string
  label: string
  categoryCode: string
  employeeId?: string
  quantity: number
  unitPrice: number
}

export interface CheckoutConsumableInput {
  productId: string
  quantity: number
}

export interface CheckoutTicketInput {
  date: string
  clientName?: string
  lines: CheckoutTicketLineInput[]
  consumables?: CheckoutConsumableInput[]
  paymentMethod: PaymentMethodCode
  paymentSplits?: Array<{ method: PaymentMethodCode; amount: number }>
  amountTendered?: number
  reference?: string
  note?: string
  callerRole?: UserRole
}

export interface CheckoutTicketResult {
  ticketId: string
  receiptNumber: string
  entries: RevenueEntry[]
  totalAmount: number
}

export type LocalSyncTombstoneType = SyncTombstoneEntityType

export interface LocalSyncTombstone {
  entityType: LocalSyncTombstoneType
  entityId: string
  deletedAt: string
}

const CURRENT_DATA_HYGIENE_VERSION = 2

export class SalonRepositoryHub {
  private readonly database: SalonProDatabase
  public readonly servicesRepo: DexieTableRepository<ServiceCatalogItem>
  public readonly employeesRepo: DexieTableRepository<Employee>
  public readonly revenuesRepo: DexieTableRepository<RevenueEntry>
  public readonly expensesRepo: DexieTableRepository<ExpenseEntry>
  public readonly productsRepo: DexieTableRepository<ProductItem>
  public readonly budgetsRepo: DexieTableRepository<BudgetTarget>
  public readonly recurringExpensesRepo: DexieTableRepository<RecurringExpenseTemplate>
  public readonly categoriesRepo: DexieTableRepository<CategoryItem>
  private readonly dupGuard = new DuplicateSubmissionGuard()

  constructor(database: SalonProDatabase = db) {
    this.database = database
    this.servicesRepo = new DexieTableRepository(database.services)
    this.employeesRepo = new DexieTableRepository(database.employees)
    this.revenuesRepo = new DexieTableRepository(database.revenues)
    this.expensesRepo = new DexieTableRepository(database.expenses)
    this.productsRepo = new DexieTableRepository(database.products)
    this.budgetsRepo = new DexieTableRepository(database.budgets)
    this.recurringExpensesRepo = new DexieTableRepository(
      database.recurringExpenses,
    )
    this.categoriesRepo = new DexieTableRepository(database.categories)
  }

  public clearDuplicateGuard(): void {
    this.dupGuard.clear()
  }

  private assertNotDuplicate(fingerprint: string): void {
    if (!this.dupGuard.tryAcquire(fingerprint)) {
      throw new Error(
        'Une opération identique vient tout juste d’être soumise. Double enregistrement bloqué.',
      )
    }
  }

  private async persistTombstone(
    entityType: LocalSyncTombstoneType,
    entityId: string,
    deletedAt = new Date().toISOString(),
  ): Promise<void> {
    const id = `${entityType}:${entityId}`
    const existing = await this.database.syncTombstones.get(id)
    if (!existing || deletedAt >= existing.deletedAt) {
      await this.database.syncTombstones.put({
        id,
        entityType,
        entityId,
        deletedAt,
      })
    }
  }

  /**
   * Supprime chirurgicalement et de façon PERSISTANTE toutes les données fictives héritées
   * (`isDemo: true`, identifiants `demo-*`, modèles pré-remplis `rec-tpl-*` / `rec-std-*`,
   * et valeurs fictives par défaut sur `salon-main`) pour tout compte réel,
   * en enregistrant durablement les tombstones dans IndexedDB (`syncTombstones`) et la version
   * d'hygiène dans `settings`, tout en préservant les comptes utilisateurs et les vraies opérations.
   */
  public async purgeLegacyMockData(): Promise<{
    removedRecords: number
    salonCleaned: boolean
  }> {
    const nowIso = new Date().toISOString()
    let removedRecords = 0
    let salonCleaned = false

    await this.database.transaction(
      'rw',
      this.database.tables,
      async () => {
        const [existingSalon, existingSettings, users] = await Promise.all([
          this.database.salon.get('salon-main'),
          this.database.settings.get('default'),
          this.database.users.toArray(),
        ])

        const activeManager =
          users.find((u) => u.role === 'manager' && u.isActive) ??
          users[0] ??
          null

        if (existingSalon) {
          const { cleaned, changed } = sanitizeLegacySalonInfo(
            existingSalon,
            activeManager,
            nowIso,
          )
          if (changed) {
            await this.database.salon.put(cleaned)
            salonCleaned = true
          }
        }

        const newTombstones: PersistedSyncTombstone[] = []

        const sweepTable = async <T extends { id: string }>(
          table: Table<T, string>,
          predicate: (row: T) => boolean,
          tombstoneType: LocalSyncTombstoneType,
        ) => {
          const all = await table.toArray()
          const toDelete: string[] = []
          const toCleanFlag: T[] = []

          for (const row of all) {
            if (predicate(row)) {
              toDelete.push(row.id)
              newTombstones.push({
                id: `${tombstoneType}:${row.id}`,
                entityType: tombstoneType,
                entityId: row.id,
                deletedAt: nowIso,
              })
            } else {
              const { cleaned, hadFlag } = stripLegacyDemoFlag(row)
              if (hadFlag) {
                toCleanFlag.push(cleaned)
              }
            }
          }

          if (toDelete.length > 0) {
            await table.bulkDelete(toDelete)
            removedRecords += toDelete.length
          }
          if (toCleanFlag.length > 0) {
            await table.bulkPut(toCleanFlag)
          }
        }

        await sweepTable(this.database.services, isLegacyMockRecord, 'service')
        await sweepTable(
          this.database.employees,
          isLegacyMockRecord,
          'employee',
        )
        await sweepTable(this.database.revenues, isLegacyMockRecord, 'revenue')
        await sweepTable(this.database.expenses, isLegacyMockRecord, 'expense')
        await sweepTable(
          this.database.cashSessions,
          isLegacyMockRecord,
          'cash_session',
        )
        await sweepTable(
          this.database.cashMovements,
          isLegacyMockRecord,
          'cash_movement',
        )
        await sweepTable(this.database.advances, isLegacyMockRecord, 'advance')
        await sweepTable(this.database.bonuses, isLegacyMockRecord, 'bonus')
        await sweepTable(
          this.database.salaryPayments,
          isLegacyMockRecord,
          'salary_payment',
        )
        await sweepTable(this.database.products, isLegacyMockRecord, 'product')
        await sweepTable(
          this.database.stockMovements,
          isLegacyMockRecord,
          'stock_movement',
        )
        await sweepTable(this.database.budgets, isLegacyMockRecord, 'budget')
        await sweepTable(
          this.database.recurringExpenses,
          isLegacyRecurringPresetRecord,
          'recurring_expense',
        )
        await sweepTable(
          this.database.correctionLogs,
          isLegacyMockRecord,
          'correction_log',
        )

        if (newTombstones.length > 0) {
          await this.database.syncTombstones.bulkPut(newTombstones)
        }

        const baseSettings =
          existingSettings ?? buildDefaultSettings('1970-01-01T00:00:00.000Z')
        if (
          baseSettings.dataHygieneVersion !== CURRENT_DATA_HYGIENE_VERSION ||
          removedRecords > 0 ||
          salonCleaned
        ) {
          await this.database.settings.put({
            ...baseSettings,
            dataHygieneVersion: CURRENT_DATA_HYGIENE_VERSION,
            mockPurgeCompletedAt:
              removedRecords > 0 ||
              salonCleaned ||
              !baseSettings.mockPurgeCompletedAt
                ? nowIso
                : baseSettings.mockPurgeCompletedAt,
          })
        }
      },
    )

    return { removedRecords, salonCleaned }
  }

  public async ensureInitialized(_legacySeedFlag?: boolean): Promise<void> {
    void _legacySeedFlag
    const [existingSalon, existingSettings] = await Promise.all([
      this.database.salon.get('salon-main'),
      this.database.settings.get('default'),
    ])
    if (existingSalon) {
      if (
        existingSettings?.dataHygieneVersion !== CURRENT_DATA_HYGIENE_VERSION
      ) {
        await this.purgeLegacyMockData()
      }
      return
    }

    const factoryBaselineIso = '1970-01-01T00:00:00.000Z'
    await this.database.transaction(
      'rw',
      this.database.tables,
      async () => {
        const checkAgain = await this.database.salon.get('salon-main')
        if (checkAgain) return

        await this.database.salon.put(buildDefaultSalonInfo(factoryBaselineIso))
        await this.database.settings.put({
          ...buildDefaultSettings(factoryBaselineIso),
          dataHygieneVersion: CURRENT_DATA_HYGIENE_VERSION,
        })
        // AGENTS.md §1 : seules les catégories comptables structurelles sont créées.
        // Aucun catalogue de prestations, aucun salarié ni écriture pré-remplis.
        await this.database.categories.bulkPut(
          buildSystemCategories(factoryBaselineIso),
        )
      },
    )
  }

  public async readFullState(): Promise<FullSalonState> {
    await this.ensureInitialized()
    const [
      salon,
      settings,
      categories,
      services,
      employees,
      revenues,
      expenses,
      cashSessions,
      cashMovements,
      advances,
      bonuses,
      salaryPayments,
      products,
      stockMovements,
      budgets,
      recurringExpenses,
      correctionLogs,
    ] = await Promise.all([
      this.database.salon.get('salon-main'),
      this.database.settings.get('default'),
      this.database.categories.toArray(),
      this.database.services.toArray(),
      this.database.employees.toArray(),
      this.database.revenues.toArray(),
      this.database.expenses.toArray(),
      this.database.cashSessions.toArray(),
      this.database.cashMovements.toArray(),
      this.database.advances.toArray(),
      this.database.bonuses.toArray(),
      this.database.salaryPayments.toArray(),
      this.database.products.toArray(),
      this.database.stockMovements.toArray(),
      this.database.budgets.toArray(),
      this.database.recurringExpenses.toArray(),
      this.database.correctionLogs.toArray(),
    ])

    return {
      salon: salon ?? buildDefaultSalonInfo(),
      settings: settings ?? buildDefaultSettings(),
      categories,
      services,
      employees,
      revenues,
      expenses,
      cashSessions,
      cashMovements,
      advances,
      bonuses,
      salaryPayments,
      products,
      stockMovements,
      budgets,
      recurringExpenses,
      correctionLogs,
    }
  }

  // --------------------------------------------------------------------------
  // Synchronisation interne du tiroir-caisse espèces (uniquement paymentMethod === 'cash')
  // --------------------------------------------------------------------------
  private async recomputeSessionTotals(sessionId: string): Promise<void> {
    const session = await this.database.cashSessions.get(sessionId)
    if (!session) return
    const mvs = await this.database.cashMovements
      .where('sessionId')
      .equals(sessionId)
      .toArray()
    const summary = calculateCashSessionSummary(session.openingBalance, mvs)
    await this.database.cashSessions.update(sessionId, {
      totalCashIn: summary.totalIn,
      totalCashOut: summary.totalOut,
      theoreticalClosingBalance: summary.theoreticalBalance,
      updatedAt: new Date().toISOString(),
    })
  }

  // --------------------------------------------------------------------------
  // CAISSE (Section 7)
  // --------------------------------------------------------------------------
  public async openCashSession(
    openingBalance: number,
    note?: string,
  ): Promise<CashSession> {
    const v = validateNonNegativeFCFA(openingBalance, "Le solde d'ouverture")
    if (!v.valid) throw new Error(v.error)
    this.assertNotDuplicate(`open-cash:${openingBalance}`)

    return this.database.transaction(
      'rw',
      [this.database.cashSessions],
      async () => {
        const existingOpen = await this.database.cashSessions
          .where('status')
          .equals('open')
          .first()
        if (existingOpen) {
          throw new Error(
            'Une session de caisse est déjà ouverte. Clôturez-la avant d’en ouvrir une nouvelle.',
          )
        }
        const nowIso = new Date().toISOString()
        const session: CashSession = {
          id: makeId('cs'),
          openedAt: nowIso,
          openingBalance: toIntFCFA(openingBalance),
          totalCashIn: 0,
          totalCashOut: 0,
          theoreticalClosingBalance: toIntFCFA(openingBalance),
          status: 'open',
          closingNote: note?.trim() || undefined,
          createdAt: nowIso,
          updatedAt: nowIso,
        }
        await this.database.cashSessions.add(session)
        return session
      },
    )
  }

  public async closeCashSession(params: {
    sessionId: string
    countedClosingBalance: number
    closingDenominations?: Record<string, number>
    closingNote?: string
  }): Promise<CashSession> {
    const v = validateNonNegativeFCFA(
      params.countedClosingBalance,
      'Le montant espèces compté',
    )
    if (!v.valid) throw new Error(v.error)
    this.assertNotDuplicate(`close-cash:${params.sessionId}`)

    return this.database.transaction(
      'rw',
      [this.database.cashSessions, this.database.cashMovements],
      async () => {
        const session = await this.database.cashSessions.get(params.sessionId)
        if (!session) throw new Error('Session de caisse introuvable.')
        if (session.status === 'closed') {
          throw new Error('Cette session de caisse est déjà clôturée.')
        }

        const mvs = await this.database.cashMovements
          .where('sessionId')
          .equals(session.id)
          .toArray()
        const summary = calculateCashSessionSummary(
          session.openingBalance,
          mvs,
        )
        const counted = toIntFCFA(params.countedClosingBalance)
        const discrepancy = counted - summary.theoreticalBalance
        const nowIso = new Date().toISOString()

        const updated: CashSession = {
          ...session,
          closedAt: nowIso,
          totalCashIn: summary.totalIn,
          totalCashOut: summary.totalOut,
          theoreticalClosingBalance: summary.theoreticalBalance,
          countedClosingBalance: counted,
          closingDenominations: params.closingDenominations,
          discrepancy,
          status: 'closed',
          closingNote: params.closingNote?.trim() || session.closingNote,
          updatedAt: nowIso,
        }

        await this.database.cashSessions.put(updated)
        return updated
      },
    )
  }

  public async recordManualCashMovement(params: {
    sessionId: string
    direction: 'in' | 'out'
    amount: number
    reason: string
    occurredAt?: string
    note?: string
  }): Promise<CashMovement> {
    if (!params.reason || params.reason.trim().length < 2) {
      throw new Error('Veuillez indiquer le motif du mouvement en espèces.')
    }
    const v = validatePositiveFCFA(params.amount, 'Le montant en espèces')
    if (!v.valid) throw new Error(v.error)
    this.assertNotDuplicate(
      `cash-man:${params.sessionId}:${params.direction}:${params.amount}:${params.reason.trim()}`,
    )

    return this.database.transaction(
      'rw',
      [this.database.cashSessions, this.database.cashMovements],
      async () => {
        const session = await this.database.cashSessions.get(params.sessionId)
        if (!session) throw new Error('Session de caisse introuvable.')
        if (session.status === 'closed') {
          throw new Error('Impossible d’ajouter un mouvement sur une session clôturée.')
        }
        const nowIso = new Date().toISOString()
        const mv: CashMovement = {
          id: makeId('cm'),
          sessionId: session.id,
          type: params.direction,
          amount: toIntFCFA(params.amount),
          reason: params.reason.trim(),
          categoryCode: params.direction === 'in' ? 'cash_in' : 'cash_out',
          paymentMethod: 'cash',
          occurredAt: params.occurredAt || nowIso,
          note: params.note?.trim() || undefined,
          createdAt: nowIso,
          updatedAt: nowIso,
        }
        await this.database.cashMovements.add(mv)
        await this.recomputeSessionTotals(session.id)
        return mv
      },
    )
  }

  public async recordCashCorrection(params: {
    sessionId: string
    direction: 'in' | 'out'
    amount: number
    reason: string
  }): Promise<CashMovement> {
    if (!params.reason || params.reason.trim().length < 3) {
      throw new Error(
        'Un motif explicite (minimum 3 caractères) est obligatoire pour toute correction de caisse.',
      )
    }
    const v = validatePositiveFCFA(
      params.amount,
      'Le montant de la correction',
    )
    if (!v.valid) throw new Error(v.error)
    this.assertNotDuplicate(
      `cash-corr:${params.sessionId}:${params.direction}:${params.amount}:${params.reason.trim()}`,
    )

    return this.database.transaction(
      'rw',
      [
        this.database.cashSessions,
        this.database.cashMovements,
        this.database.correctionLogs,
      ],
      async () => {
        const session = await this.database.cashSessions.get(params.sessionId)
        if (!session) throw new Error('Session de caisse introuvable.')
        if (session.status === 'closed') {
          throw new Error(
            'Impossible de modifier directement les mouvements d’une caisse clôturée. Utilisez la correction de clôture traçable.',
          )
        }

        const nowIso = new Date().toISOString()
        const mv: CashMovement = {
          id: makeId('cm'),
          sessionId: session.id,
          type: params.direction === 'in' ? 'correction_in' : 'correction_out',
          amount: toIntFCFA(params.amount),
          reason: params.reason.trim(),
          categoryCode: 'cash_correction',
          paymentMethod: 'cash',
          occurredAt: nowIso,
          createdAt: nowIso,
          updatedAt: nowIso,
        }
        await this.database.cashMovements.add(mv)
        await this.recomputeSessionTotals(session.id)

        await this.database.correctionLogs.add({
          id: makeId('corr'),
          entityType: 'cash_session',
          entityId: session.id,
          action:
            params.direction === 'in'
              ? 'Correction positive de caisse'
              : 'Correction négative de caisse',
          reason: params.reason.trim(),
          previousSnapshotJson: JSON.stringify({
            theoreticalClosingBalance: session.theoreticalClosingBalance,
          }),
          newSnapshotJson: JSON.stringify(mv),
          createdAt: nowIso,
        })

        return mv
      },
    )
  }

  public async correctClosedSessionCount(params: {
    sessionId: string
    newCountedBalance: number
    reason: string
  }): Promise<CashSession> {
    if (!params.reason || params.reason.trim().length < 5) {
      throw new Error(
        'Veuillez indiquer le motif précis de correction de la clôture (minimum 5 caractères).',
      )
    }
    const v = validateNonNegativeFCFA(
      params.newCountedBalance,
      'Le nouveau montant compté',
    )
    if (!v.valid) throw new Error(v.error)

    return this.database.transaction(
      'rw',
      [this.database.cashSessions, this.database.correctionLogs],
      async () => {
        const session = await this.database.cashSessions.get(params.sessionId)
        if (!session || session.status !== 'closed') {
          throw new Error('Session clôturée introuvable.')
        }

        const nowIso = new Date().toISOString()
        const counted = toIntFCFA(params.newCountedBalance)
        const updated: CashSession = {
          ...session,
          countedClosingBalance: counted,
          discrepancy: counted - session.theoreticalClosingBalance,
          closingNote: `${session.closingNote ? `${session.closingNote} | ` : ''}Corrigé : ${params.reason.trim()}`,
          updatedAt: nowIso,
        }

        await this.database.cashSessions.put(updated)
        await this.database.correctionLogs.add({
          id: makeId('corr'),
          entityType: 'cash_session',
          entityId: session.id,
          action: 'Correction traçable de clôture validée',
          reason: params.reason.trim(),
          previousSnapshotJson: JSON.stringify(session),
          newSnapshotJson: JSON.stringify(updated),
          createdAt: nowIso,
        })

        return updated
      },
    )
  }

  private async generateReceiptNumber(dateIso: string): Promise<string> {
    const dayCompact = dateIso.slice(0, 10).replace(/-/g, '')
    const dayPrefix = `REC-${dayCompact}-`
    const all = await this.database.revenues.toArray()
    const seenReceipts = new Set(
      all
        .map((r) => r.receiptNumber)
        .filter((n): n is string => Boolean(n && n.startsWith(dayPrefix))),
    )
    const seq = String(seenReceipts.size + 1).padStart(3, '0')
    return `${dayPrefix}${seq}`
  }

  /**
   * Crée un Ticket d'encaissement client complet (1 à N lignes prestations/produits,
   * consommables optionnels en cabine, paiement simple ou mixte Espèces/Mobile Money,
   * décrémentation stock automatique, alimentation caisse espèces et numéro de reçu).
   */
  public async createCheckoutTicket(
    input: CheckoutTicketInput,
  ): Promise<CheckoutTicketResult> {
    if (!input.lines || input.lines.length === 0) {
      throw new Error('Ajoutez au moins une prestation ou un produit au ticket.')
    }

    const normalizedLines = input.lines.map((ln) => {
      const qty = Math.max(1, Math.round(ln.quantity || 1))
      const unitPrice = toIntFCFA(ln.unitPrice)
      const lineTotal = qty * unitPrice
      const check = validateRevenueInput({
        date: input.date,
        label: ln.label,
        categoryCode: ln.categoryCode,
        amount: lineTotal,
        paymentMethod: input.paymentMethod,
      })
      if (!check.valid) throw new Error(check.error)
      return { ...ln, quantity: qty, unitPrice, lineTotal }
    })

    const totalAmount = normalizedLines.reduce((s, l) => s + l.lineTotal, 0)
    if (totalAmount <= 0) {
      throw new Error('Le total du ticket doit être strictement positif.')
    }

    // Validation éventuelle du paiement mixte
    const activeSplits = (input.paymentSplits ?? [])
      .map((s) => ({ method: s.method, amount: toIntFCFA(s.amount) }))
      .filter((s) => s.amount > 0)

    if (activeSplits.length > 0) {
      const splitSum = activeSplits.reduce((s, sp) => s + sp.amount, 0)
      if (splitSum !== totalAmount) {
        throw new Error(
          `La somme des modes de paiement (${splitSum.toLocaleString('fr-FR')} FCFA) doit égaler le total du ticket (${totalAmount.toLocaleString('fr-FR')} FCFA).`,
        )
      }
    }

    const fpSummary = normalizedLines
      .map((l) => `${l.label.trim()}:${l.lineTotal}`)
      .join('|')
    this.assertNotDuplicate(
      `tkt:${fpSummary}:${totalAmount}:${input.date.slice(0, 16)}`,
    )

    return this.database.transaction(
      'rw',
      [
        this.database.services,
        this.database.revenues,
        this.database.products,
        this.database.stockMovements,
        this.database.cashSessions,
        this.database.cashMovements,
      ],
      async () => {
        const nowIso = new Date().toISOString()
        const ticketId = makeId('tkt')
        const receiptNumber = await this.generateReceiptNumber(input.date)

        // 0. Contrôle RBAC sur les prestations à tarif fixe verrouillé lorsque l'opérateur est Caissier
        if (input.callerRole === 'cashier') {
          for (const ln of normalizedLines) {
            if (ln.kind === 'service' && ln.serviceId) {
              const srv = await this.database.services.get(ln.serviceId)
              if (srv?.priceLocked) {
                const matchedVariant = ln.serviceVariantId
                  ? srv.variants?.find((v) => v.id === ln.serviceVariantId)
                  : undefined
                const expectedPrice = matchedVariant
                  ? toIntFCFA(matchedVariant.price)
                  : toIntFCFA(srv.referencePrice)
                if (ln.unitPrice !== expectedPrice) {
                  throw new Error(
                    `Le tarif de « ${srv.name} » est verrouillé à ${expectedPrice.toLocaleString('fr-FR')} FCFA par le Gérant.`,
                  )
                }
              }
            }
          }
        }

        // 1. Vérifier la disponibilité du stock pour tous les produits vendus et consommables
        const requiredStock = new Map<string, number>()
        for (const ln of normalizedLines) {
          if (ln.kind === 'product' && ln.productId) {
            requiredStock.set(
              ln.productId,
              (requiredStock.get(ln.productId) ?? 0) + ln.quantity,
            )
          }
        }
        for (const cons of input.consumables ?? []) {
          if (cons.productId && cons.quantity > 0) {
            const q = Math.max(1, Math.round(cons.quantity))
            requiredStock.set(
              cons.productId,
              (requiredStock.get(cons.productId) ?? 0) + q,
            )
          }
        }

        const productMap = new Map<string, ProductItem>()
        for (const [prodId, neededQty] of requiredStock.entries()) {
          const prod = await this.database.products.get(prodId)
          if (!prod) throw new Error('Produit sélectionné introuvable en stock.')
          if (prod.quantity < neededQty) {
            throw new Error(
              `Stock insuffisant pour « ${prod.name} » (${prod.quantity} ${prod.unit} disponible(s), ${neededQty} demandé(s)).`,
            )
          }
          productMap.set(prodId, { ...prod })
        }

        // 2. Enregistrer les consommables éventuels utilisés en cabine
        const consumablesRecorded: TicketConsumableUsage[] = []
        for (const cons of input.consumables ?? []) {
          if (!cons.productId || cons.quantity <= 0) continue
          const prod = productMap.get(cons.productId)
          if (!prod) continue
          const qty = Math.max(1, Math.round(cons.quantity))
          const nextQty = prod.quantity - qty
          const smId = makeId('sm')

          await this.database.stockMovements.add({
            id: smId,
            productId: prod.id,
            type: 'use',
            quantityDelta: -qty,
            quantityAfter: nextQty,
            unitCost: toIntFCFA(prod.costPrice),
            reason: `Consommation prestation (${receiptNumber})`,
            occurredAt: input.date,
            createdAt: nowIso,
          })
          await this.database.products.update(prod.id, {
            quantity: nextQty,
            updatedAt: nowIso,
          })
          prod.quantity = nextQty
          consumablesRecorded.push({
            productId: prod.id,
            productName: prod.name,
            quantity: qty,
            unit: prod.unit,
            stockMovementId: smId,
          })
        }

        // 3. Répartir proprement les éventuels paiements mixtes sur chaque ligne sans perte d'1 FCFA
        const openSession = await this.database.cashSessions
          .where('status')
          .equals('open')
          .first()

        const remainingSplitPool = activeSplits.map((sp) => ({ ...sp }))
        const entries: RevenueEntry[] = []

        const cashTotalOnTicket =
          activeSplits.length > 0
            ? activeSplits
                .filter((s) => s.method === 'cash')
                .reduce((sum, s) => sum + s.amount, 0)
            : input.paymentMethod === 'cash'
              ? totalAmount
              : 0

        const tendered =
          input.amountTendered && input.amountTendered >= cashTotalOnTicket
            ? toIntFCFA(input.amountTendered)
            : undefined
        const changeGiven =
          tendered !== undefined && cashTotalOnTicket > 0
            ? tendered - cashTotalOnTicket
            : undefined

        for (let idx = 0; idx < normalizedLines.length; idx++) {
          const ln = normalizedLines[idx]
          const revId = makeId('rev')
          let linkedStockMovementId: string | undefined

          // Décrémenter le stock si ligne produit vendu
          if (ln.kind === 'product' && ln.productId) {
            const prod = productMap.get(ln.productId)
            if (prod) {
              const nextQty = prod.quantity - ln.quantity
              linkedStockMovementId = makeId('sm')
              await this.database.stockMovements.add({
                id: linkedStockMovementId,
                productId: prod.id,
                type: 'sale',
                quantityDelta: -ln.quantity,
                quantityAfter: nextQty,
                unitCost: toIntFCFA(prod.costPrice),
                unitSalePrice: ln.unitPrice,
                reason: `Vente ticket ${receiptNumber} — ${prod.name}`,
                occurredAt: input.date,
                linkedRevenueId: revId,
                createdAt: nowIso,
              })
              await this.database.products.update(prod.id, {
                quantity: nextQty,
                updatedAt: nowIso,
              })
              prod.quantity = nextQty
            }
          }

          // Allouer les splits de paiement pour cette ligne
          let lineSplits: TicketPaymentSplit[] | undefined
          let lineCashAmount = 0
          let linePrimaryMethod: PaymentMethodCode = input.paymentMethod

          if (remainingSplitPool.length > 0) {
            lineSplits = []
            let toCover = ln.lineTotal
            for (const pool of remainingSplitPool) {
              if (toCover <= 0) break
              if (pool.amount <= 0) continue
              const take = Math.min(toCover, pool.amount)
              pool.amount -= take
              toCover -= take
              lineSplits.push({ method: pool.method, amount: take })
              if (pool.method === 'cash') {
                lineCashAmount += take
              }
            }
            if (lineSplits.length > 0) {
              linePrimaryMethod = lineSplits[0].method
            }
          } else if (input.paymentMethod === 'cash') {
            lineCashAmount = ln.lineTotal
          }

          let cashMovementId: string | undefined
          if (lineCashAmount > 0 && openSession) {
            cashMovementId = makeId('cm')
            await this.database.cashMovements.add({
              id: cashMovementId,
              sessionId: openSession.id,
              type: 'in',
              amount: lineCashAmount,
              reason: `${receiptNumber} · ${ln.label.trim()}`,
              categoryCode: ln.categoryCode,
              paymentMethod: 'cash',
              occurredAt: input.date,
              note: input.note?.trim() || undefined,
              linkedRevenueId: revId,
              createdAt: nowIso,
              updatedAt: nowIso,
            })
            if (lineSplits) {
              const cashSp = lineSplits.find((s) => s.method === 'cash')
              if (cashSp) cashSp.cashMovementId = cashMovementId
            }
          }

          const entry: RevenueEntry = {
            id: revId,
            date: input.date,
            label:
              ln.quantity > 1
                ? `${ln.label.trim()} (×${ln.quantity})`
                : ln.label.trim(),
            categoryCode: ln.categoryCode,
            serviceId: ln.serviceId || undefined,
            serviceVariantId: ln.serviceVariantId || undefined,
            serviceVariantLabel: ln.serviceVariantLabel || undefined,
            productId: ln.productId || undefined,
            employeeId: ln.employeeId || undefined,
            quantity: ln.quantity,
            unitPrice: ln.unitPrice,
            amount: ln.lineTotal,
            paymentMethod: linePrimaryMethod,
            paymentSplits:
              lineSplits && lineSplits.length > 1 ? lineSplits : undefined,
            ticketId,
            receiptNumber,
            clientName: input.clientName?.trim() || undefined,
            amountTendered: idx === 0 ? tendered : undefined,
            changeGiven: idx === 0 ? changeGiven : undefined,
            linkedStockMovementId,
            consumablesUsed:
              idx === 0 && consumablesRecorded.length > 0
                ? consumablesRecorded
                : undefined,
            reference: input.reference?.trim() || undefined,
            note: input.note?.trim() || undefined,
            sourceModule:
              ln.kind === 'product' ? 'inventory_sale' : 'revenue',
            cashMovementId,
            createdAt: nowIso,
            updatedAt: nowIso,
          }

          await this.database.revenues.add(entry)
          entries.push(entry)
        }

        if (openSession && cashTotalOnTicket > 0) {
          await this.recomputeSessionTotals(openSession.id)
        }

        return {
          ticketId,
          receiptNumber,
          entries,
          totalAmount,
        }
      },
    )
  }

  // --------------------------------------------------------------------------
  // RECETTES (Section 8)
  // --------------------------------------------------------------------------
  public async addRevenue(input: {
    date: string
    label: string
    categoryCode: string
    serviceId?: string
    serviceVariantId?: string
    serviceVariantLabel?: string
    productId?: string
    employeeId?: string
    quantity?: number
    amount: number
    paymentMethod: PaymentMethodCode
    clientName?: string
    reference?: string
    note?: string
    sourceModule?: RevenueEntry['sourceModule']
    callerRole?: UserRole
  }): Promise<RevenueEntry> {
    const check = validateRevenueInput(input)
    if (!check.valid) throw new Error(check.error)

    this.assertNotDuplicate(
      `rev:${input.label.trim()}:${input.amount}:${input.paymentMethod}:${input.date.slice(0, 16)}`,
    )

    return this.database.transaction(
      'rw',
      [
        this.database.services,
        this.database.revenues,
        this.database.products,
        this.database.stockMovements,
        this.database.cashSessions,
        this.database.cashMovements,
      ],
      async () => {
        const nowIso = new Date().toISOString()
        const revId = makeId('rev')
        const receiptNumber = await this.generateReceiptNumber(input.date)
        const qty = Math.max(1, Math.round(input.quantity ?? 1))
        let cashMovementId: string | undefined
        let linkedStockMovementId: string | undefined

        if (input.callerRole === 'cashier' && input.serviceId) {
          const srv = await this.database.services.get(input.serviceId)
          if (srv?.priceLocked) {
            const matchedVariant = input.serviceVariantId
              ? srv.variants?.find((v) => v.id === input.serviceVariantId)
              : undefined
            const expectedUnit = matchedVariant
              ? toIntFCFA(matchedVariant.price)
              : toIntFCFA(srv.referencePrice)
            const expectedTotal = expectedUnit * qty
            if (toIntFCFA(input.amount) !== expectedTotal) {
              throw new Error(
                `Le tarif de « ${srv.name} » est verrouillé à ${expectedTotal.toLocaleString('fr-FR')} FCFA par le Gérant.`,
              )
            }
          }
        }

        // Décrémentation stock automatique si un produit est rattaché à la recette
        if (input.productId) {
          const prod = await this.database.products.get(input.productId)
          if (!prod) throw new Error('Produit sélectionné introuvable.')
          if (prod.quantity < qty) {
            throw new Error(
              `Stock insuffisant pour « ${prod.name} » (${prod.quantity} ${prod.unit} disponible(s)).`,
            )
          }
          const nextQty = prod.quantity - qty
          linkedStockMovementId = makeId('sm')
          await this.database.stockMovements.add({
            id: linkedStockMovementId,
            productId: prod.id,
            type: 'sale',
            quantityDelta: -qty,
            quantityAfter: nextQty,
            unitCost: toIntFCFA(prod.costPrice),
            unitSalePrice: Math.round(toIntFCFA(input.amount) / qty),
            reason: `Vente produit (${receiptNumber}) — ${prod.name}`,
            occurredAt: input.date,
            linkedRevenueId: revId,
            createdAt: nowIso,
          })
          await this.database.products.update(prod.id, {
            quantity: nextQty,
            updatedAt: nowIso,
          })
        }

        // Règle Section 7 : SEULES les recettes en espèces impactent la caisse espèces ouverte !
        if (input.paymentMethod === 'cash') {
          const openSession = await this.database.cashSessions
            .where('status')
            .equals('open')
            .first()
          if (openSession) {
            cashMovementId = makeId('cm')
            const mv: CashMovement = {
              id: cashMovementId,
              sessionId: openSession.id,
              type: 'in',
              amount: toIntFCFA(input.amount),
              reason: input.label.trim(),
              categoryCode: input.categoryCode,
              paymentMethod: 'cash',
              occurredAt: input.date,
              note: input.note?.trim() || undefined,
              linkedRevenueId: revId,
              createdAt: nowIso,
              updatedAt: nowIso,
            }
            await this.database.cashMovements.add(mv)
            await this.recomputeSessionTotals(openSession.id)
          }
        }

        const entry: RevenueEntry = {
          id: revId,
          date: input.date,
          label: input.label.trim(),
          categoryCode: input.categoryCode,
          serviceId: input.serviceId || undefined,
          serviceVariantId: input.serviceVariantId || undefined,
          serviceVariantLabel: input.serviceVariantLabel || undefined,
          productId: input.productId || undefined,
          employeeId: input.employeeId || undefined,
          quantity: qty,
          unitPrice: Math.round(toIntFCFA(input.amount) / qty),
          amount: toIntFCFA(input.amount),
          paymentMethod: input.paymentMethod,
          receiptNumber,
          clientName: input.clientName?.trim() || undefined,
          linkedStockMovementId,
          reference: input.reference?.trim() || undefined,
          note: input.note?.trim() || undefined,
          sourceModule:
            input.sourceModule ??
            (input.productId ? 'inventory_sale' : 'revenue'),
          cashMovementId,
          createdAt: nowIso,
          updatedAt: nowIso,
        }

        await this.database.revenues.add(entry)
        return entry
      },
    )
  }

  public async updateRevenue(params: {
    id: string
    label: string
    amount: number
    categoryCode: string
    paymentMethod: PaymentMethodCode
    date: string
    employeeId?: string
    reference?: string
    note?: string
    reason: string
  }): Promise<RevenueEntry> {
    const check = validateRevenueInput(params)
    if (!check.valid) throw new Error(check.error)
    if (!params.reason.trim()) {
      throw new Error(
        'Veuillez indiquer le motif de modification pour la traçabilité.',
      )
    }

    return this.database.transaction(
      'rw',
      [
        this.database.revenues,
        this.database.cashMovements,
        this.database.cashSessions,
        this.database.correctionLogs,
      ],
      async () => {
        const existing = await this.database.revenues.get(params.id)
        if (!existing) throw new Error('Recette introuvable.')

        const nowIso = new Date().toISOString()
        const updated: RevenueEntry = {
          ...existing,
          label: params.label.trim(),
          amount: toIntFCFA(params.amount),
          categoryCode: params.categoryCode,
          paymentMethod: params.paymentMethod,
          date: params.date,
          employeeId: params.employeeId || undefined,
          reference: params.reference?.trim() || undefined,
          note: params.note?.trim() || undefined,
          updatedAt: nowIso,
        }

        await this.database.revenues.put(updated)

        if (existing.cashMovementId) {
          const mv = await this.database.cashMovements.get(
            existing.cashMovementId,
          )
          if (mv) {
            if (params.paymentMethod === 'cash') {
              await this.database.cashMovements.update(mv.id, {
                amount: toIntFCFA(params.amount),
                reason: params.label.trim(),
                updatedAt: nowIso,
              })
            } else {
              await this.database.cashMovements.delete(mv.id)
              await this.database.revenues.update(params.id, {
                cashMovementId: undefined,
              })
              updated.cashMovementId = undefined
            }
            await this.recomputeSessionTotals(mv.sessionId)
          }
        } else if (params.paymentMethod === 'cash') {
          const openSession = await this.database.cashSessions
            .where('status')
            .equals('open')
            .first()
          if (openSession) {
            const newMvId = makeId('cm')
            await this.database.cashMovements.add({
              id: newMvId,
              sessionId: openSession.id,
              type: 'in',
              amount: toIntFCFA(params.amount),
              reason: params.label.trim(),
              categoryCode: params.categoryCode,
              paymentMethod: 'cash',
              occurredAt: params.date,
              linkedRevenueId: existing.id,
              createdAt: nowIso,
              updatedAt: nowIso,
            })
            await this.database.revenues.update(params.id, {
              cashMovementId: newMvId,
            })
            updated.cashMovementId = newMvId
            await this.recomputeSessionTotals(openSession.id)
          }
        }

        await this.database.correctionLogs.add({
          id: makeId('corr'),
          entityType: 'revenue',
          entityId: existing.id,
          action: 'Modification de recette',
          reason: params.reason.trim(),
          previousSnapshotJson: JSON.stringify(existing),
          newSnapshotJson: JSON.stringify(updated),
          createdAt: nowIso,
        })

        return updated
      },
    )
  }

  public async archiveRevenue(
    id: string,
    reason = 'Annulation / Suppression de recette',
  ): Promise<void> {
    await this.database.transaction(
      'rw',
      [
        this.database.revenues,
        this.database.products,
        this.database.stockMovements,
        this.database.cashMovements,
        this.database.cashSessions,
        this.database.correctionLogs,
      ],
      async () => {
        const rev = await this.database.revenues.get(id)
        if (!rev || rev.isArchived) return
        const nowIso = new Date().toISOString()

        await this.database.revenues.update(id, {
          isArchived: true,
          updatedAt: nowIso,
        })

        if (rev.cashMovementId) {
          const mv = await this.database.cashMovements.get(rev.cashMovementId)
          if (mv) {
            await this.database.cashMovements.delete(mv.id)
            await this.recomputeSessionTotals(mv.sessionId)
          }
        }

        // Réintégration automatique du stock vendu en cas d'annulation
        if (rev.linkedStockMovementId) {
          const sm = await this.database.stockMovements.get(
            rev.linkedStockMovementId,
          )
          if (sm && sm.quantityDelta < 0) {
            const prod = await this.database.products.get(sm.productId)
            if (prod) {
              const restoredQty = Math.abs(sm.quantityDelta)
              const nextQty = prod.quantity + restoredQty
              await this.database.products.update(prod.id, {
                quantity: nextQty,
                updatedAt: nowIso,
              })
              await this.database.stockMovements.add({
                id: makeId('sm'),
                productId: prod.id,
                type: 'adjustment',
                quantityDelta: restoredQty,
                quantityAfter: nextQty,
                unitCost: toIntFCFA(prod.costPrice),
                reason: `Réintégration stock suite annulation (${rev.receiptNumber ?? rev.label})`,
                occurredAt: nowIso,
                createdAt: nowIso,
              })
            }
          }
        }

        // Réintégration éventuelle des consommables liés à cette ligne de ticket
        if (rev.consumablesUsed && rev.consumablesUsed.length > 0) {
          for (const cons of rev.consumablesUsed) {
            const prod = await this.database.products.get(cons.productId)
            if (prod && cons.quantity > 0) {
              const nextQty = prod.quantity + cons.quantity
              await this.database.products.update(prod.id, {
                quantity: nextQty,
                updatedAt: nowIso,
              })
              await this.database.stockMovements.add({
                id: makeId('sm'),
                productId: prod.id,
                type: 'adjustment',
                quantityDelta: cons.quantity,
                quantityAfter: nextQty,
                unitCost: toIntFCFA(prod.costPrice),
                reason: `Réintégration consommable suite annulation (${rev.receiptNumber ?? rev.label})`,
                occurredAt: nowIso,
                createdAt: nowIso,
              })
            }
          }
        }

        await this.database.correctionLogs.add({
          id: makeId('corr'),
          entityType: 'revenue',
          entityId: rev.id,
          action: 'Annulation de recette (avec synchro caisse/stock)',
          reason: reason.trim() || 'Annulation utilisateur',
          previousSnapshotJson: JSON.stringify(rev),
          newSnapshotJson: JSON.stringify({ ...rev, isArchived: true }),
          createdAt: nowIso,
        })
      },
    )
  }

  // --------------------------------------------------------------------------
  // DÉPENSES (Section 9)
  // --------------------------------------------------------------------------
  public async addExpense(input: {
    date: string
    label: string
    categoryCode: string
    amount: number
    paymentMethod: PaymentMethodCode
    beneficiary?: string
    receiptRef?: string
    note?: string
    sourceModule?: ExpenseEntry['sourceModule']
    isStockPurchase?: boolean
    recurringTemplateId?: string
    recurringPeriodMonth?: string
  }): Promise<ExpenseEntry> {
    const check = validateExpenseInput(input)
    if (!check.valid) throw new Error(check.error)

    if (
      (input.categoryCode === 'salaries' || input.categoryCode === 'bonuses') &&
      input.sourceModule !== 'payroll'
    ) {
      throw new Error(
        'Pour éviter tout double comptage, enregistrez les salaires, primes et avances depuis le module « Salaires et commissions ».',
      )
    }

    this.assertNotDuplicate(
      `exp:${input.label.trim()}:${input.amount}:${input.paymentMethod}:${input.date.slice(0, 16)}`,
    )

    return this.database.transaction(
      'rw',
      [
        this.database.expenses,
        this.database.cashSessions,
        this.database.cashMovements,
      ],
      async () => {
        const nowIso = new Date().toISOString()
        const expId = makeId('exp')
        let cashMovementId: string | undefined

        if (input.paymentMethod === 'cash') {
          const openSession = await this.database.cashSessions
            .where('status')
            .equals('open')
            .first()
          if (openSession) {
            cashMovementId = makeId('cm')
            const mv: CashMovement = {
              id: cashMovementId,
              sessionId: openSession.id,
              type: 'out',
              amount: toIntFCFA(input.amount),
              reason: input.label.trim(),
              categoryCode: input.categoryCode,
              paymentMethod: 'cash',
              occurredAt: input.date,
              note: input.note?.trim() || undefined,
              linkedExpenseId: expId,
              createdAt: nowIso,
              updatedAt: nowIso,
            }
            await this.database.cashMovements.add(mv)
            await this.recomputeSessionTotals(openSession.id)
          }
        }

        const entry: ExpenseEntry = {
          id: expId,
          date: input.date,
          label: input.label.trim(),
          categoryCode: input.categoryCode,
          amount: toIntFCFA(input.amount),
          paymentMethod: input.paymentMethod,
          beneficiary: input.beneficiary?.trim() || undefined,
          receiptRef: input.receiptRef?.trim() || undefined,
          note: input.note?.trim() || undefined,
          sourceModule: input.sourceModule ?? 'expenses',
          recurringTemplateId: input.recurringTemplateId || undefined,
          recurringPeriodMonth: input.recurringPeriodMonth || undefined,
          cashMovementId,
          isStockPurchase: Boolean(input.isStockPurchase),
          createdAt: nowIso,
          updatedAt: nowIso,
        }

        await this.database.expenses.add(entry)
        return entry
      },
    )
  }

  public async updateExpense(params: {
    id: string
    label: string
    amount: number
    categoryCode: string
    paymentMethod: PaymentMethodCode
    date: string
    beneficiary?: string
    receiptRef?: string
    note?: string
    reason: string
  }): Promise<ExpenseEntry> {
    const check = validateExpenseInput(params)
    if (!check.valid) throw new Error(check.error)
    if (!params.reason.trim()) {
      throw new Error('Veuillez indiquer le motif de modification.')
    }

    return this.database.transaction(
      'rw',
      [
        this.database.expenses,
        this.database.cashMovements,
        this.database.cashSessions,
        this.database.correctionLogs,
      ],
      async () => {
        const existing = await this.database.expenses.get(params.id)
        if (!existing) throw new Error('Dépense introuvable.')
        if (existing.sourceModule === 'payroll') {
          throw new Error(
            'Cette écriture est liée à un paiement de salaire. Utilisez le module « Salaires et commissions » pour la corriger.',
          )
        }

        const nowIso = new Date().toISOString()
        const updated: ExpenseEntry = {
          ...existing,
          label: params.label.trim(),
          amount: toIntFCFA(params.amount),
          categoryCode: params.categoryCode,
          paymentMethod: params.paymentMethod,
          date: params.date,
          beneficiary: params.beneficiary?.trim() || undefined,
          receiptRef: params.receiptRef?.trim() || undefined,
          note: params.note?.trim() || undefined,
          updatedAt: nowIso,
        }

        await this.database.expenses.put(updated)

        if (existing.cashMovementId) {
          const mv = await this.database.cashMovements.get(
            existing.cashMovementId,
          )
          if (mv) {
            if (params.paymentMethod === 'cash') {
              await this.database.cashMovements.update(mv.id, {
                amount: toIntFCFA(params.amount),
                reason: params.label.trim(),
                updatedAt: nowIso,
              })
            } else {
              await this.database.cashMovements.delete(mv.id)
              await this.database.expenses.update(params.id, {
                cashMovementId: undefined,
              })
              updated.cashMovementId = undefined
            }
            await this.recomputeSessionTotals(mv.sessionId)
          }
        } else if (params.paymentMethod === 'cash') {
          const openSession = await this.database.cashSessions
            .where('status')
            .equals('open')
            .first()
          if (openSession) {
            const newMvId = makeId('cm')
            await this.database.cashMovements.add({
              id: newMvId,
              sessionId: openSession.id,
              type: 'out',
              amount: toIntFCFA(params.amount),
              reason: params.label.trim(),
              categoryCode: params.categoryCode,
              paymentMethod: 'cash',
              occurredAt: params.date,
              linkedExpenseId: existing.id,
              createdAt: nowIso,
              updatedAt: nowIso,
            })
            await this.database.expenses.update(params.id, {
              cashMovementId: newMvId,
            })
            updated.cashMovementId = newMvId
            await this.recomputeSessionTotals(openSession.id)
          }
        }

        await this.database.correctionLogs.add({
          id: makeId('corr'),
          entityType: 'expense',
          entityId: existing.id,
          action: 'Modification de dépense',
          reason: params.reason.trim(),
          previousSnapshotJson: JSON.stringify(existing),
          newSnapshotJson: JSON.stringify(updated),
          createdAt: nowIso,
        })

        return updated
      },
    )
  }

  public async archiveExpense(id: string): Promise<void> {
    await this.database.transaction(
      'rw',
      [
        this.database.expenses,
        this.database.cashMovements,
        this.database.cashSessions,
      ],
      async () => {
        const exp = await this.database.expenses.get(id)
        if (!exp) return
        if (exp.sourceModule === 'payroll') {
          throw new Error(
            'Impossible de supprimer directement une écriture générée par le module Paie.',
          )
        }
        await this.database.expenses.update(id, {
          isArchived: true,
          updatedAt: new Date().toISOString(),
        })
        if (exp.cashMovementId) {
          const mv = await this.database.cashMovements.get(exp.cashMovementId)
          if (mv) {
            await this.database.cashMovements.delete(mv.id)
            await this.recomputeSessionTotals(mv.sessionId)
          }
        }
      },
    )
  }

  // --------------------------------------------------------------------------
  // PRESTATIONS ET TARIFS (Section 10)
  // --------------------------------------------------------------------------
  private assertManagerForServiceConfig(callerRole?: UserRole): void {
    if (callerRole === 'cashier') {
      throw new Error(
        'Accès refusé : seul le Gérant peut configurer ou modifier les prestations et leurs tarifs.',
      )
    }
  }

  public async saveService(input: {
    id?: string
    name: string
    categoryCode: string
    referencePrice: number
    description?: string
    durationMinutes?: number
    priceLocked?: boolean
    variants?: Array<{
      id?: string
      label: string
      price: number
      durationMinutes?: number
    }>
    defaultConsumables?: Array<{
      productId: string
      quantity: number
    }>
    commissionOverride?: ServiceCommissionOverride | null
    callerRole?: UserRole
  }): Promise<ServiceCatalogItem> {
    this.assertManagerForServiceConfig(input.callerRole)

    const check = validateServiceInput(input)
    if (!check.valid) throw new Error(check.error)

    const normalizedVariants: ServicePriceVariant[] | undefined =
      input.variants !== undefined
        ? input.variants.map((v) => ({
            id: v.id?.trim() || makeId('var'),
            label: v.label.trim(),
            price: toIntFCFA(v.price),
            durationMinutes:
              v.durationMinutes && v.durationMinutes > 0
                ? Math.round(v.durationMinutes)
                : undefined,
          }))
        : undefined

    let normalizedConsumables: ServiceDefaultConsumable[] | undefined
    if (input.defaultConsumables !== undefined) {
      const qtyByProduct = new Map<string, number>()
      for (const c of input.defaultConsumables) {
        const pid = c.productId.trim()
        if (!pid) continue
        const q = Math.max(1, Math.round(c.quantity))
        qtyByProduct.set(pid, (qtyByProduct.get(pid) ?? 0) + q)
      }
      normalizedConsumables = Array.from(qtyByProduct.entries()).map(
        ([productId, quantity]) => ({ productId, quantity }),
      )
    }

    const normalizedCommission: ServiceCommissionOverride | undefined =
      input.commissionOverride
        ? {
            mode: input.commissionOverride.mode,
            value:
              input.commissionOverride.mode === 'fixed'
                ? toIntFCFA(input.commissionOverride.value)
                : input.commissionOverride.value,
          }
        : undefined

    const nowIso = new Date().toISOString()
    if (input.id) {
      const patch: Partial<ServiceCatalogItem> = {
        name: input.name.trim(),
        categoryCode: input.categoryCode,
        referencePrice: toIntFCFA(input.referencePrice),
        description: input.description?.trim() ?? '',
        durationMinutes: input.durationMinutes || undefined,
        updatedAt: nowIso,
      }
      if (input.priceLocked !== undefined) {
        patch.priceLocked = Boolean(input.priceLocked)
      }
      if (normalizedVariants !== undefined) {
        patch.variants =
          normalizedVariants.length > 0 ? normalizedVariants : undefined
      }
      if (normalizedConsumables !== undefined) {
        patch.defaultConsumables =
          normalizedConsumables.length > 0 ? normalizedConsumables : undefined
      }
      if (input.commissionOverride !== undefined) {
        patch.commissionOverride = normalizedCommission
      }
      return this.servicesRepo.update(input.id, patch)
    }

    this.assertNotDuplicate(`svc:${input.name.trim()}:${input.referencePrice}`)
    return this.servicesRepo.create({
      id: makeId('svc'),
      name: input.name.trim(),
      categoryCode: input.categoryCode,
      referencePrice: toIntFCFA(input.referencePrice),
      description: input.description?.trim() ?? '',
      durationMinutes: input.durationMinutes || undefined,
      priceLocked: input.priceLocked ? true : undefined,
      variants:
        normalizedVariants && normalizedVariants.length > 0
          ? normalizedVariants
          : undefined,
      defaultConsumables:
        normalizedConsumables && normalizedConsumables.length > 0
          ? normalizedConsumables
          : undefined,
      commissionOverride: normalizedCommission,
      isActive: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
  }

  public async toggleServiceStatus(
    id: string,
    callerRole?: UserRole,
  ): Promise<ServiceCatalogItem> {
    this.assertManagerForServiceConfig(callerRole)
    const current = await this.servicesRepo.getById(id)
    if (!current) throw new Error('Prestation introuvable.')
    return this.servicesRepo.update(id, {
      isActive: !current.isActive,
      updatedAt: new Date().toISOString(),
    })
  }

  public async deleteServiceIfUnused(
    id: string,
    callerRole?: UserRole,
  ): Promise<void> {
    this.assertManagerForServiceConfig(callerRole)
    const usedCount = await this.database.revenues
      .where('serviceId')
      .equals(id)
      .count()
    if (usedCount > 0) {
      throw new Error(
        'Cette prestation est déjà utilisée dans votre historique financier : désactivez-la au lieu de la supprimer.',
      )
    }
    await this.servicesRepo.delete(id)
    await this.persistTombstone('service', id)
  }

  // --------------------------------------------------------------------------
  // PERSONNEL (Section 11)
  // --------------------------------------------------------------------------
  public async saveEmployee(input: {
    id?: string
    lastName: string
    firstName: string
    roleTitle: string
    phone?: string
    hireDate: string
    baseSalary: number
    remunerationType: Employee['remunerationType']
    defaultBonus?: number
    commissionEnabled: boolean
    commissionBasis: Employee['commissionBasis']
    commissionRate: number
    adminNote?: string
  }): Promise<Employee> {
    const check = validateEmployeeInput(input)
    if (!check.valid) throw new Error(check.error)

    const nowIso = new Date().toISOString()
    const fullName = `${input.firstName.trim()} ${input.lastName.trim()}`

    if (input.id) {
      return this.employeesRepo.update(input.id, {
        lastName: input.lastName.trim(),
        firstName: input.firstName.trim(),
        fullName,
        roleTitle: input.roleTitle.trim(),
        phone: input.phone?.trim() ?? '',
        hireDate: input.hireDate,
        baseSalary: toIntFCFA(input.baseSalary),
        remunerationType: input.remunerationType,
        defaultBonus: toIntFCFA(input.defaultBonus ?? 0),
        commissionEnabled: input.commissionEnabled,
        commissionBasis: input.commissionBasis,
        commissionRate: input.commissionEnabled ? input.commissionRate : 0,
        adminNote: input.adminNote?.trim() ?? '',
        updatedAt: nowIso,
      })
    }

    this.assertNotDuplicate(`emp:${fullName}:${input.hireDate}`)
    return this.employeesRepo.create({
      id: makeId('emp'),
      lastName: input.lastName.trim(),
      firstName: input.firstName.trim(),
      fullName,
      roleTitle: input.roleTitle.trim(),
      phone: input.phone?.trim() ?? '',
      hireDate: input.hireDate,
      baseSalary: toIntFCFA(input.baseSalary),
      remunerationType: input.remunerationType,
      defaultBonus: toIntFCFA(input.defaultBonus ?? 0),
      commissionEnabled: input.commissionEnabled,
      commissionBasis: input.commissionBasis,
      commissionRate: input.commissionEnabled ? input.commissionRate : 0,
      adminNote: input.adminNote?.trim() ?? '',
      isActive: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
  }

  public async toggleEmployeeActive(id: string): Promise<Employee> {
    const emp = await this.employeesRepo.getById(id)
    if (!emp) throw new Error('Employé introuvable.')
    return this.employeesRepo.update(id, {
      isActive: !emp.isActive,
      updatedAt: new Date().toISOString(),
    })
  }

  // --------------------------------------------------------------------------
  // SALAIRES, AVANCES ET COMMISSIONS (Section 12)
  // --------------------------------------------------------------------------
  public async recordEmployeeBonus(input: {
    employeeId: string
    periodMonth: string
    amount: number
    reason: string
  }): Promise<BonusEntry> {
    const v = validatePositiveFCFA(input.amount, 'Le montant de la prime')
    if (!v.valid) throw new Error(v.error)
    if (!input.reason || input.reason.trim().length < 2) {
      throw new Error('Veuillez préciser le motif de la prime.')
    }
    this.assertNotDuplicate(
      `bon:${input.employeeId}:${input.periodMonth}:${input.amount}:${input.reason.trim()}`,
    )
    const emp = await this.database.employees.get(input.employeeId)
    if (!emp) throw new Error('Employé introuvable.')

    const bonus: BonusEntry = {
      id: makeId('bon'),
      employeeId: emp.id,
      periodMonth: input.periodMonth,
      amount: toIntFCFA(input.amount),
      reason: input.reason.trim(),
      createdAt: new Date().toISOString(),
    }
    await this.database.bonuses.add(bonus)
    return bonus
  }

  public async recordSalaryAdvance(input: {
    employeeId: string
    periodMonth: string
    amount: number
    paidAt: string
    paymentMethod: PaymentMethodCode
    reference?: string
    note?: string
  }): Promise<AdvanceEntry> {
    const v = validatePositiveFCFA(input.amount, "Le montant de l'avance")
    if (!v.valid) throw new Error(v.error)
    this.assertNotDuplicate(
      `adv:${input.employeeId}:${input.periodMonth}:${input.amount}`,
    )

    return this.database.transaction(
      'rw',
      [
        this.database.employees,
        this.database.advances,
        this.database.expenses,
        this.database.cashSessions,
        this.database.cashMovements,
      ],
      async () => {
        const emp = await this.database.employees.get(input.employeeId)
        if (!emp) throw new Error('Employé introuvable.')

        const nowIso = new Date().toISOString()
        const advId = makeId('adv')
        const expId = makeId('exp')
        let cashMovementId: string | undefined

        if (input.paymentMethod === 'cash') {
          const openSession = await this.database.cashSessions
            .where('status')
            .equals('open')
            .first()
          if (openSession) {
            cashMovementId = makeId('cm')
            await this.database.cashMovements.add({
              id: cashMovementId,
              sessionId: openSession.id,
              type: 'out',
              amount: toIntFCFA(input.amount),
              reason: `Avance sur salaire — ${emp.fullName}`,
              categoryCode: 'salaries',
              paymentMethod: 'cash',
              occurredAt: input.paidAt,
              linkedExpenseId: expId,
              createdAt: nowIso,
              updatedAt: nowIso,
            })
            await this.recomputeSessionTotals(openSession.id)
          }
        }

        await this.database.expenses.add({
          id: expId,
          date: input.paidAt,
          label: `Avance sur salaire (${input.periodMonth}) — ${emp.fullName}`,
          categoryCode: 'salaries',
          amount: toIntFCFA(input.amount),
          paymentMethod: input.paymentMethod,
          beneficiary: emp.fullName,
          receiptRef: input.reference?.trim() || undefined,
          note: input.note?.trim() || undefined,
          sourceModule: 'payroll',
          linkedAdvanceId: advId,
          cashMovementId,
          isStockPurchase: false,
          createdAt: nowIso,
          updatedAt: nowIso,
        })

        const advance: AdvanceEntry = {
          id: advId,
          employeeId: emp.id,
          periodMonth: input.periodMonth,
          amount: toIntFCFA(input.amount),
          paidAt: input.paidAt,
          paymentMethod: input.paymentMethod,
          reference: input.reference?.trim() || undefined,
          note: input.note?.trim() || undefined,
          linkedExpenseId: expId,
          createdAt: nowIso,
          updatedAt: nowIso,
        }

        await this.database.advances.add(advance)
        return advance
      },
    )
  }

  public async validateSalaryPayment(input: {
    employeeId: string
    periodMonth: string
    baseSalary: number
    bonusesTotal: number
    deductions: number
    commissionCalculated: number
    commissionValidated: number
    customNetAmount?: number
    paidAt: string
    paymentMethod: PaymentMethodCode
    reference?: string
    note?: string
  }): Promise<SalaryPayment> {
    if (!input.employeeId || !input.periodMonth) {
      throw new Error('Employé et période de paie obligatoires.')
    }
    this.assertNotDuplicate(
      `pay:${input.employeeId}:${input.periodMonth}:${input.customNetAmount ?? 'full'}`,
    )

    return this.database.transaction(
      'rw',
      [
        this.database.employees,
        this.database.advances,
        this.database.salaryPayments,
        this.database.expenses,
        this.database.cashSessions,
        this.database.cashMovements,
      ],
      async () => {
        const emp = await this.database.employees.get(input.employeeId)
        if (!emp) throw new Error('Employé introuvable.')

        // Rapprochement automatique des avances non encore imputées pour éviter toute double déduction !
        const unsettledAdvances = (
          await this.database.advances
            .where('employeeId')
            .equals(emp.id)
            .toArray()
        ).filter(
          (a) =>
            !a.isArchived &&
            a.periodMonth === input.periodMonth &&
            !a.settledInPayrollId,
        )

        const previousPayments = (
          await this.database.salaryPayments
            .where('employeeId')
            .equals(emp.id)
            .toArray()
        ).filter((sp) => sp.periodMonth === input.periodMonth)

        const alreadyPaidNet = previousPayments.reduce(
          (sum, sp) => sum + toIntFCFA(sp.netPaidAmount),
          0,
        )
        const settledAdvancesSum = (
          await this.database.advances
            .where('employeeId')
            .equals(emp.id)
            .toArray()
        )
          .filter(
            (a) =>
              !a.isArchived &&
              a.periodMonth === input.periodMonth &&
              Boolean(a.settledInPayrollId),
          )
          .reduce((sum, a) => sum + toIntFCFA(a.amount), 0)

        const unsettledSum = unsettledAdvances.reduce(
          (sum, a) => sum + toIntFCFA(a.amount),
          0,
        )

        const base = toIntFCFA(input.baseSalary)
        const bonuses = toIntFCFA(input.bonusesTotal)
        const deductions = toIntFCFA(input.deductions)
        const commVal = toIntFCFA(input.commissionValidated)
        const commCalc = toIntFCFA(input.commissionCalculated)

        const fullRemainingNet = Math.max(
          0,
          base +
            bonuses +
            commVal -
            deductions -
            settledAdvancesSum -
            unsettledSum -
            alreadyPaidNet,
        )

        const requestedCustom =
          input.customNetAmount !== undefined && input.customNetAmount > 0
            ? toIntFCFA(input.customNetAmount)
            : undefined

        if (
          requestedCustom !== undefined &&
          requestedCustom > fullRemainingNet &&
          fullRemainingNet > 0
        ) {
          throw new Error(
            `L’acompte saisi (${requestedCustom.toLocaleString('fr-FR')} FCFA) dépasse le solde restant à payer (${fullRemainingNet.toLocaleString('fr-FR')} FCFA).`,
          )
        }

        const isPartial =
          requestedCustom !== undefined && requestedCustom < fullRemainingNet
        const netPaidAmount = isPartial ? requestedCustom : fullRemainingNet
        const advancesDeducted = isPartial ? 0 : unsettledSum

        const nowIso = new Date().toISOString()
        const payrollId = makeId('sal')
        let linkedExpenseId: string | undefined

        // Création d'UNE SEULE écriture financière correspondant au solde net versé !
        if (netPaidAmount > 0) {
          linkedExpenseId = makeId('exp')
          let cashMovementId: string | undefined

          if (input.paymentMethod === 'cash') {
            const openSession = await this.database.cashSessions
              .where('status')
              .equals('open')
              .first()
            if (openSession) {
              cashMovementId = makeId('cm')
              await this.database.cashMovements.add({
                id: cashMovementId,
                sessionId: openSession.id,
                type: 'out',
                amount: netPaidAmount,
                reason: `${isPartial ? 'Acompte salaire' : 'Salaire'} (${input.periodMonth}) — ${emp.fullName}`,
                categoryCode: 'salaries',
                paymentMethod: 'cash',
                occurredAt: input.paidAt,
                linkedExpenseId,
                createdAt: nowIso,
                updatedAt: nowIso,
              })
              await this.recomputeSessionTotals(openSession.id)
            }
          }

          await this.database.expenses.add({
            id: linkedExpenseId,
            date: input.paidAt,
            label: `${isPartial ? 'Acompte salaire' : 'Règlement salaire'} (${input.periodMonth}) — ${emp.fullName}`,
            categoryCode: 'salaries',
            amount: netPaidAmount,
            paymentMethod: input.paymentMethod,
            beneficiary: emp.fullName,
            receiptRef: input.reference?.trim() || undefined,
            note: input.note?.trim() || undefined,
            sourceModule: 'payroll',
            linkedPayrollId: payrollId,
            cashMovementId,
            isStockPurchase: false,
            createdAt: nowIso,
            updatedAt: nowIso,
          })
        }

        // Marquer les avances comme rapprochées lors du solde du bulletin
        if (!isPartial) {
          for (const adv of unsettledAdvances) {
            await this.database.advances.update(adv.id, {
              settledInPayrollId: payrollId,
              updatedAt: nowIso,
            })
          }
        }

        const payment: SalaryPayment = {
          id: payrollId,
          employeeId: emp.id,
          periodMonth: input.periodMonth,
          baseSalary: base,
          bonusesTotal: bonuses,
          advancesDeducted,
          deductions,
          commissionCalculated: commCalc,
          commissionValidated: isPartial ? 0 : commVal,
          netPaidAmount,
          isPartial,
          paidAt: input.paidAt,
          paymentMethod: input.paymentMethod,
          reference: input.reference?.trim() || undefined,
          note: input.note?.trim() || undefined,
          linkedExpenseId,
          status: 'validated',
          createdAt: nowIso,
          updatedAt: nowIso,
        }

        await this.database.salaryPayments.add(payment)
        return payment
      },
    )
  }

  public async correctSalaryPaymentNoteOrBonus(params: {
    payrollId: string
    newNote: string
    reason: string
  }): Promise<SalaryPayment> {
    if (!params.reason.trim()) {
      throw new Error('Motif de correction obligatoire.')
    }
    return this.database.transaction(
      'rw',
      [this.database.salaryPayments, this.database.correctionLogs],
      async () => {
        const current = await this.database.salaryPayments.get(params.payrollId)
        if (!current) throw new Error('Paiement de salaire introuvable.')
        const nowIso = new Date().toISOString()
        const updated: SalaryPayment = {
          ...current,
          note: params.newNote.trim(),
          status: 'corrected',
          updatedAt: nowIso,
        }
        await this.database.salaryPayments.put(updated)
        await this.database.correctionLogs.add({
          id: makeId('corr'),
          entityType: 'payroll',
          entityId: current.id,
          action: 'Annotation / correction traçable de paie',
          reason: params.reason.trim(),
          previousSnapshotJson: JSON.stringify(current),
          newSnapshotJson: JSON.stringify(updated),
          createdAt: nowIso,
        })
        return updated
      },
    )
  }

  // --------------------------------------------------------------------------
  // INVENTAIRE & MOUVEMENTS DE STOCK (Section 13)
  // --------------------------------------------------------------------------
  public async saveProduct(input: {
    id?: string
    name: string
    sku: string
    categoryCode: string
    initialQuantity?: number
    unit: string
    costPrice: number
    salePrice?: number
    alertThreshold: number
    usageType: ProductItem['usageType']
  }): Promise<ProductItem> {
    const check = validateProductInput(input)
    if (!check.valid) throw new Error(check.error)

    const nowIso = new Date().toISOString()
    if (input.id) {
      return this.productsRepo.update(input.id, {
        name: input.name.trim(),
        sku: input.sku.trim(),
        categoryCode: input.categoryCode,
        unit: input.unit.trim(),
        costPrice: toIntFCFA(input.costPrice),
        salePrice: input.salePrice ? toIntFCFA(input.salePrice) : undefined,
        alertThreshold: Math.round(input.alertThreshold),
        usageType: input.usageType,
        updatedAt: nowIso,
      })
    }

    const initQty = Math.max(0, Math.round(input.initialQuantity ?? 0))
    this.assertNotDuplicate(`prod:${input.name.trim()}:${input.sku.trim()}`)

    return this.database.transaction(
      'rw',
      [this.database.products, this.database.stockMovements],
      async () => {
        const prodId = makeId('prod')
        const created: ProductItem = {
          id: prodId,
          name: input.name.trim(),
          sku: input.sku.trim() || `SKU-${Date.now().toString().slice(-4)}`,
          categoryCode: input.categoryCode,
          quantity: initQty,
          unit: input.unit.trim(),
          costPrice: toIntFCFA(input.costPrice),
          salePrice: input.salePrice ? toIntFCFA(input.salePrice) : undefined,
          alertThreshold: Math.round(input.alertThreshold),
          usageType: input.usageType,
          isActive: true,
          createdAt: nowIso,
          updatedAt: nowIso,
        }
        await this.database.products.add(created)

        if (initQty > 0) {
          await this.database.stockMovements.add({
            id: makeId('sm'),
            productId: prodId,
            type: 'adjustment',
            quantityDelta: initQty,
            quantityAfter: initQty,
            unitCost: created.costPrice,
            reason: 'Stock initial à la création de la fiche',
            occurredAt: nowIso,
            createdAt: nowIso,
          })
        }
        return created
      },
    )
  }

  public async recordStockMovement(input: {
    productId: string
    type: StockMovementType
    quantity: number // Positif pour purchase/use/sale/loss ; signé (+/-) pour adjustment
    unitCost: number
    unitSalePrice?: number
    reason: string
    occurredAt: string
    recordFinancialEntry: boolean
    paymentMethod?: PaymentMethodCode
    supplierName?: string
  }): Promise<StockMovement> {
    if (!input.reason || input.reason.trim().length < 2) {
      throw new Error('Veuillez préciser le motif du mouvement de stock.')
    }
    if (!Number.isInteger(input.quantity) || input.quantity === 0) {
      throw new Error('La quantité doit être un entier non nul.')
    }
    if (input.type !== 'adjustment' && input.quantity <= 0) {
      throw new Error('La quantité doit être strictement positive.')
    }

    this.assertNotDuplicate(
      `stk:${input.productId}:${input.type}:${input.quantity}:${input.reason.trim()}`,
    )

    return this.database.transaction(
      'rw',
      [
        this.database.products,
        this.database.stockMovements,
        this.database.expenses,
        this.database.revenues,
        this.database.cashSessions,
        this.database.cashMovements,
        this.database.correctionLogs,
      ],
      async () => {
        const prod = await this.database.products.get(input.productId)
        if (!prod) throw new Error('Produit introuvable.')

        const delta =
          input.type === 'purchase'
            ? input.quantity
            : input.type === 'adjustment'
              ? input.quantity
              : -Math.abs(input.quantity)

        const quantityAfter = prod.quantity + delta
        if (quantityAfter < 0) {
          throw new Error(
            `Stock insuffisant (${prod.quantity} ${prod.unit} disponible(s)).`,
          )
        }

        const nowIso = new Date().toISOString()
        const mvId = makeId('sm')
        const unitCost = toIntFCFA(input.unitCost)
        const method = input.paymentMethod ?? 'cash'
        let linkedExpenseId: string | undefined
        let linkedRevenueId: string | undefined

        // Achat de stock : crée 1 seule dépense marquée `isStockPurchase: true` (pas de double comptage !)
        if (input.recordFinancialEntry && input.type === 'purchase') {
          const totalPurchase = Math.abs(delta) * unitCost
          if (totalPurchase > 0) {
            linkedExpenseId = makeId('exp')
            let cashMovementId: string | undefined

            if (method === 'cash') {
              const openSession = await this.database.cashSessions
                .where('status')
                .equals('open')
                .first()
              if (openSession) {
                cashMovementId = makeId('cm')
                await this.database.cashMovements.add({
                  id: cashMovementId,
                  sessionId: openSession.id,
                  type: 'out',
                  amount: totalPurchase,
                  reason: `Achat stock : ${prod.name}`,
                  categoryCode: 'hair_products',
                  paymentMethod: 'cash',
                  occurredAt: input.occurredAt,
                  linkedExpenseId,
                  createdAt: nowIso,
                  updatedAt: nowIso,
                })
                await this.recomputeSessionTotals(openSession.id)
              }
            }

            await this.database.expenses.add({
              id: linkedExpenseId,
              date: input.occurredAt,
              label: `Achat stock (${Math.abs(delta)} ${prod.unit}) — ${prod.name}`,
              categoryCode: 'hair_products',
              amount: totalPurchase,
              paymentMethod: method,
              beneficiary: input.supplierName?.trim() || undefined,
              sourceModule: 'inventory_purchase',
              linkedStockMovementId: mvId,
              cashMovementId,
              isStockPurchase: true,
              createdAt: nowIso,
              updatedAt: nowIso,
            })
          }
        }

        // Vente de produit : crée 1 recette `product_sale`
        if (input.recordFinancialEntry && input.type === 'sale') {
          const salePrice = toIntFCFA(
            input.unitSalePrice ?? prod.salePrice ?? unitCost,
          )
          const totalSale = Math.abs(delta) * salePrice
          if (totalSale > 0) {
            linkedRevenueId = makeId('rev')
            let cashMovementId: string | undefined

            if (method === 'cash') {
              const openSession = await this.database.cashSessions
                .where('status')
                .equals('open')
                .first()
              if (openSession) {
                cashMovementId = makeId('cm')
                await this.database.cashMovements.add({
                  id: cashMovementId,
                  sessionId: openSession.id,
                  type: 'in',
                  amount: totalSale,
                  reason: `Vente produit : ${prod.name}`,
                  categoryCode: 'product_sale',
                  paymentMethod: 'cash',
                  occurredAt: input.occurredAt,
                  linkedRevenueId,
                  createdAt: nowIso,
                  updatedAt: nowIso,
                })
                await this.recomputeSessionTotals(openSession.id)
              }
            }

            await this.database.revenues.add({
              id: linkedRevenueId,
              date: input.occurredAt,
              label: `Vente (${Math.abs(delta)} ${prod.unit}) — ${prod.name}`,
              categoryCode: 'product_sale',
              productId: prod.id,
              amount: totalSale,
              paymentMethod: method,
              sourceModule: 'inventory_sale',
              cashMovementId,
              createdAt: nowIso,
              updatedAt: nowIso,
            })
          }
        }

        const nextCostPrice =
          input.type === 'purchase'
            ? calculateCUMP(
                prod.quantity,
                prod.costPrice,
                Math.abs(delta),
                unitCost,
              )
            : prod.costPrice

        await this.database.products.update(prod.id, {
          quantity: quantityAfter,
          costPrice: nextCostPrice,
          updatedAt: nowIso,
        })

        const movement: StockMovement = {
          id: mvId,
          productId: prod.id,
          type: input.type,
          quantityDelta: delta,
          quantityAfter,
          unitCost,
          unitSalePrice: input.unitSalePrice
            ? toIntFCFA(input.unitSalePrice)
            : undefined,
          reason: input.reason.trim(),
          occurredAt: input.occurredAt,
          linkedExpenseId,
          linkedRevenueId,
          createdAt: nowIso,
        }

        await this.database.stockMovements.add(movement)

        if (input.type === 'adjustment' || input.type === 'loss') {
          await this.database.correctionLogs.add({
            id: makeId('corr'),
            entityType: 'inventory',
            entityId: prod.id,
            action:
              input.type === 'loss'
                ? 'Perte / détérioration de stock'
                : 'Ajustement manuel de stock',
            reason: input.reason.trim(),
            previousSnapshotJson: JSON.stringify({ quantity: prod.quantity }),
            newSnapshotJson: JSON.stringify({ quantity: quantityAfter }),
            createdAt: nowIso,
          })
        }

        return movement
      },
    )
  }

  // --------------------------------------------------------------------------
  // CHARGES FIXES RÉCURRENTES DU SALON (Loyer, CIE, SODECI, Internet...)
  // --------------------------------------------------------------------------
  public async saveRecurringExpenseTemplate(input: {
    id?: string
    label: string
    categoryCode: string
    defaultAmount: number
    paymentMethod: PaymentMethodCode
    beneficiary?: string
    dayOfMonth?: number
  }): Promise<RecurringExpenseTemplate> {
    if (!input.label || input.label.trim().length < 2) {
      throw new Error('Veuillez saisir le libellé de la charge récurrente.')
    }
    const v = validatePositiveFCFA(input.defaultAmount, 'Le montant habituel')
    if (!v.valid) throw new Error(v.error)

    const day = Math.min(28, Math.max(1, Math.round(input.dayOfMonth ?? 5)))
    const nowIso = new Date().toISOString()

    if (input.id) {
      return this.recurringExpensesRepo.update(input.id, {
        label: input.label.trim(),
        categoryCode: input.categoryCode,
        defaultAmount: toIntFCFA(input.defaultAmount),
        paymentMethod: input.paymentMethod,
        beneficiary: input.beneficiary?.trim() || undefined,
        dayOfMonth: day,
        updatedAt: nowIso,
      })
    }

    return this.recurringExpensesRepo.create({
      id: makeId('rec'),
      label: input.label.trim(),
      categoryCode: input.categoryCode,
      defaultAmount: toIntFCFA(input.defaultAmount),
      paymentMethod: input.paymentMethod,
      beneficiary: input.beneficiary?.trim() || undefined,
      dayOfMonth: day,
      isActive: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
  }

  public async toggleRecurringExpenseTemplate(
    id: string,
  ): Promise<RecurringExpenseTemplate> {
    const existing = await this.recurringExpensesRepo.getById(id)
    if (!existing) throw new Error('Modèle de charge récurrente introuvable.')
    return this.recurringExpensesRepo.update(id, {
      isActive: !existing.isActive,
      updatedAt: new Date().toISOString(),
    })
  }

  public async deleteRecurringExpenseTemplate(id: string): Promise<void> {
    await this.recurringExpensesRepo.delete(id)
    await this.persistTombstone('recurring_expense', id)
  }

  public async payRecurringExpenseForMonth(params: {
    templateId: string
    periodMonth: string // YYYY-MM
    amount: number
    paymentMethod: PaymentMethodCode
    date: string
    receiptRef?: string
    note?: string
  }): Promise<ExpenseEntry> {
    const tpl = await this.recurringExpensesRepo.getById(params.templateId)
    if (!tpl) throw new Error('Modèle de charge récurrente introuvable.')

    const alreadyPaid = (
      await this.database.expenses
        .where('recurringTemplateId')
        .equals(params.templateId)
        .toArray()
    ).some(
      (e) => !e.isArchived && e.recurringPeriodMonth === params.periodMonth,
    )
    if (alreadyPaid) {
      throw new Error(
        `Cette charge récurrente (« ${tpl.label} ») a déjà été validée pour le mois ${params.periodMonth}.`,
      )
    }

    return this.addExpense({
      date: params.date,
      label: `${tpl.label} (${params.periodMonth})`,
      categoryCode: tpl.categoryCode,
      amount: toIntFCFA(params.amount),
      paymentMethod: params.paymentMethod,
      beneficiary: tpl.beneficiary,
      receiptRef: params.receiptRef,
      note: params.note,
      recurringTemplateId: tpl.id,
      recurringPeriodMonth: params.periodMonth,
    })
  }

  // --------------------------------------------------------------------------
  // BUDGET ET OBJECTIFS (Section 15)
  // --------------------------------------------------------------------------
  public async upsertBudgetTarget(input: {
    periodMonth: string
    kind: BudgetTarget['kind']
    categoryCode: string
    plannedAmount: number
    note?: string
  }): Promise<BudgetTarget> {
    const v = validatePositiveFCFA(input.plannedAmount, 'Le montant budgétaire')
    if (!v.valid) throw new Error(v.error)

    const existing = (
      await this.database.budgets
        .where('periodMonth')
        .equals(input.periodMonth)
        .toArray()
    ).find(
      (b) => b.kind === input.kind && b.categoryCode === input.categoryCode,
    )

    const nowIso = new Date().toISOString()
    if (existing) {
      return this.budgetsRepo.update(existing.id, {
        plannedAmount: toIntFCFA(input.plannedAmount),
        note: input.note?.trim() || undefined,
        updatedAt: nowIso,
      })
    }

    return this.budgetsRepo.create({
      id: makeId('bdg'),
      periodMonth: input.periodMonth,
      kind: input.kind,
      categoryCode: input.categoryCode,
      plannedAmount: toIntFCFA(input.plannedAmount),
      note: input.note?.trim() || undefined,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
  }

  public async deleteBudgetTarget(id: string): Promise<void> {
    const existing = await this.budgetsRepo.getById(id)
    if (!existing) {
      throw new Error('Ligne budgétaire introuvable.')
    }
    await this.budgetsRepo.delete(id)
    await this.persistTombstone('budget', id)
  }

  public async copyBudgetFromMonth(
    fromMonth: string,
    toMonth: string,
  ): Promise<number> {
    if (!fromMonth || !toMonth || fromMonth === toMonth) {
      throw new Error('Veuillez choisir un mois source distinct du mois cible.')
    }

    const sourceItems = await this.database.budgets
      .where('periodMonth')
      .equals(fromMonth)
      .toArray()

    if (sourceItems.length === 0) {
      throw new Error(
        `Aucune ligne budgétaire n’est définie sur le mois ${fromMonth}.`,
      )
    }

    const targetItems = await this.database.budgets
      .where('periodMonth')
      .equals(toMonth)
      .toArray()

    const nowIso = new Date().toISOString()
    let copiedCount = 0

    await this.database.transaction('rw', [this.database.budgets], async () => {
      for (const item of sourceItems) {
        const alreadyExists = targetItems.some(
          (t) => t.kind === item.kind && t.categoryCode === item.categoryCode,
        )
        if (!alreadyExists) {
          await this.database.budgets.add({
            id: makeId('bdg'),
            periodMonth: toMonth,
            kind: item.kind,
            categoryCode: item.categoryCode,
            plannedAmount: item.plannedAmount,
            note: item.note,
            createdAt: nowIso,
            updatedAt: nowIso,
          })
          copiedCount += 1
        }
      }
    })

    return copiedCount
  }

  // --------------------------------------------------------------------------
  // PARAMÈTRES, CATÉGORIES & SAUVEGARDES LOCALES (Section 16)
  // --------------------------------------------------------------------------
  public async updateSalonInfo(changes: Partial<SalonInfo>): Promise<SalonInfo> {
    const current =
      (await this.database.salon.get('salon-main')) ?? buildDefaultSalonInfo()
    const updated: SalonInfo = {
      ...current,
      ...changes,
      id: 'salon-main',
      currency: 'XOF',
      updatedAt: new Date().toISOString(),
    }
    await this.database.salon.put(updated)
    return updated
  }

  public async updateSettings(
    changes: Partial<AppSettings>,
  ): Promise<AppSettings> {
    const current =
      (await this.database.settings.get('default')) ?? buildDefaultSettings()
    const updated: AppSettings = {
      ...current,
      ...changes,
      id: 'default',
      updatedAt: new Date().toISOString(),
    }
    await this.database.settings.put(updated)
    return updated
  }

  public async updateCategory(
    id: string,
    changes: { label?: string; isArchived?: boolean },
    callerRole?: UserRole,
  ): Promise<CategoryItem> {
    this.assertManagerForServiceConfig(callerRole)
    const next: Partial<CategoryItem> = {
      updatedAt: new Date().toISOString(),
    }
    if (changes.label !== undefined) {
      if (changes.label.trim().length < 2) {
        throw new Error('Le libellé de la catégorie est trop court.')
      }
      next.label = changes.label.trim()
    }
    if (changes.isArchived !== undefined) {
      next.isArchived = changes.isArchived
    }
    return this.categoriesRepo.update(id, next)
  }

  public async addCustomCategory(input: {
    scope: CategoryItem['scope']
    label: string
    callerRole?: UserRole
  }): Promise<CategoryItem> {
    this.assertManagerForServiceConfig(input.callerRole)
    const label = input.label.trim()
    if (label.length < 2) {
      throw new Error('Le nom de la catégorie est trop court.')
    }
    const existingInScope = (
      await this.database.categories.where('scope').equals(input.scope).toArray()
    ).find((c) => c.label.trim().toLowerCase() === label.toLowerCase())

    if (existingInScope) {
      if (existingInScope.isArchived) {
        return this.categoriesRepo.update(existingInScope.id, {
          isArchived: false,
          label,
          updatedAt: new Date().toISOString(),
        })
      }
      throw new Error(`La catégorie « ${existingInScope.label} » existe déjà.`)
    }

    const slug = label
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
    const code = `${slug}_${Date.now().toString().slice(-4)}`
    const nowIso = new Date().toISOString()

    return this.categoriesRepo.create({
      id: `cat-${input.scope}-${code}`,
      scope: input.scope,
      code,
      label,
      isSystem: false,
      isArchived: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
  }

  public async exportBackupPayload(): Promise<SalonBackupPayload> {
    const nowIso = new Date().toISOString()
    await this.updateSettings({ lastBackupExportedAt: nowIso })
    const state = await this.readFullState()

    return {
      format: 'SALON_PRO_BACKUP_V1',
      exportedAt: nowIso,
      ...state,
    }
  }

  /**
   * Prépare l'enveloppe de synchronisation vers Neon PostgreSQL.
   */
  public async buildCloudSyncEnvelope(): Promise<{
    payload: SalonBackupPayload
    tombstones: LocalSyncTombstone[]
  }> {
    const [state, users, persistedTombstones] = await Promise.all([
      this.readFullState(),
      this.database.users.toArray(),
      this.database.syncTombstones.toArray(),
    ])
    return {
      payload: {
        format: 'SALON_PRO_BACKUP_V1',
        exportedAt: new Date().toISOString(),
        salon: state.salon,
        settings: state.settings,
        categories: state.categories,
        services: state.services,
        employees: state.employees,
        revenues: state.revenues,
        expenses: state.expenses,
        cashSessions: state.cashSessions,
        cashMovements: state.cashMovements,
        advances: state.advances,
        bonuses: state.bonuses,
        salaryPayments: state.salaryPayments,
        products: state.products,
        stockMovements: state.stockMovements,
        budgets: state.budgets,
        recurringExpenses: state.recurringExpenses,
        users,
        correctionLogs: state.correctionLogs,
      },
      tombstones: persistedTombstones.map((tb) => ({
        entityType: tb.entityType,
        entityId: tb.entityId,
        deletedAt: tb.deletedAt,
      })),
    }
  }

  /**
   * Fusionne sans perte (Last-Write-Wins par `updatedAt` / `createdAt`) les données
   * retournées par Neon PostgreSQL avec IndexedDB locale sans écraser une saisie hors-ligne plus récente.
   */
  public async mergeCloudSyncResult(input: {
    payload: SalonBackupPayload | null
    tombstones?: LocalSyncTombstone[]
  }): Promise<{ mergedCount: number }> {
    if (!input.payload) return { mergedCount: 0 }
    const remote = input.payload
    let mergedCount = 0

    await this.database.transaction(
      'rw',
      this.database.tables,
      async () => {
        const localSalon = await this.database.salon.get('salon-main')
        const sanitizedRemoteSalon = sanitizeLegacySalonInfo(
          remote.salon,
          null,
          remote.salon.updatedAt,
        ).cleaned
        if (
          !localSalon ||
          sanitizedRemoteSalon.updatedAt > localSalon.updatedAt
        ) {
          await this.database.salon.put({
            ...sanitizedRemoteSalon,
            id: 'salon-main',
          })
          mergedCount += 1
        }

        const localSettings = await this.database.settings.get('default')
        if (
          remote.settings &&
          (!localSettings || remote.settings.updatedAt > localSettings.updatedAt)
        ) {
          await this.database.settings.put({ ...remote.settings, id: 'default' })
          mergedCount += 1
        }

        const mergeByUpdatedAt = async <
          T extends { id: string; updatedAt: string },
        >(
          table: {
            get(id: string): Promise<T | undefined>
            put(item: T): Promise<unknown>
          },
          items: T[] | undefined,
          rejectFn: (row: T) => boolean = isLegacyMockRecord,
        ) => {
          for (const item of items ?? []) {
            if (rejectFn(item)) continue
            const cur = await table.get(item.id)
            if (!cur || item.updatedAt > cur.updatedAt) {
              await table.put(stripLegacyDemoFlag(item).cleaned)
              mergedCount += 1
            }
          }
        }

        const mergeImmutableById = async <T extends { id: string }>(
          table: {
            get(id: string): Promise<T | undefined>
            put(item: T): Promise<unknown>
          },
          items: T[] | undefined,
        ) => {
          for (const item of items ?? []) {
            if (isLegacyMockRecord(item)) continue
            const cur = await table.get(item.id)
            if (!cur) {
              await table.put(stripLegacyDemoFlag(item).cleaned)
              mergedCount += 1
            }
          }
        }

        await mergeByUpdatedAt(
          this.database.categories,
          remote.categories,
          () => false,
        )
        await mergeByUpdatedAt(this.database.services, remote.services)
        await mergeByUpdatedAt(this.database.employees, remote.employees)
        await mergeByUpdatedAt(this.database.cashSessions, remote.cashSessions)
        await mergeByUpdatedAt(this.database.cashMovements, remote.cashMovements)
        await mergeByUpdatedAt(this.database.revenues, remote.revenues)
        await mergeByUpdatedAt(this.database.expenses, remote.expenses)
        await mergeByUpdatedAt(
          this.database.recurringExpenses,
          remote.recurringExpenses,
          isLegacyRecurringPresetRecord,
        )
        await mergeByUpdatedAt(this.database.products, remote.products)
        await mergeByUpdatedAt(this.database.advances, remote.advances)
        await mergeByUpdatedAt(
          this.database.salaryPayments,
          remote.salaryPayments,
        )
        await mergeByUpdatedAt(this.database.budgets, remote.budgets)

        for (const usr of remote.users ?? []) {
          const curById = await this.database.users.get(usr.id)
          const curByEmail = await this.database.users
            .where('email')
            .equals(usr.email.trim().toLowerCase())
            .first()
          const cur = curById ?? curByEmail
          if (!cur || usr.updatedAt > cur.updatedAt) {
            if (cur && cur.id !== usr.id) {
              await this.database.users.delete(cur.id)
            }
            await this.database.users.put({
              ...usr,
              email: usr.email.trim().toLowerCase(),
            })
            mergedCount += 1
          }
        }

        await mergeImmutableById(
          this.database.stockMovements,
          remote.stockMovements,
        )
        await mergeImmutableById(this.database.bonuses, remote.bonuses)
        await mergeImmutableById(
          this.database.correctionLogs,
          remote.correctionLogs,
        )

        // Appliquer et persister durablement les suppressions distantes (tombstones)
        const applyTombstoneToMutable = async <
          T extends { id: string; updatedAt: string },
        >(
          table: Table<T, string>,
          entityId: string,
          deletedAt: string,
        ) => {
          const cur = await table.get(entityId)
          if (cur && cur.updatedAt <= deletedAt) {
            await table.delete(entityId)
          }
        }

        const applyTombstoneToImmutable = async <
          T extends { id: string; createdAt: string },
        >(
          table: Table<T, string>,
          entityId: string,
          deletedAt: string,
        ) => {
          const cur = await table.get(entityId)
          if (cur && cur.createdAt <= deletedAt) {
            await table.delete(entityId)
          }
        }

        for (const tb of input.tombstones ?? []) {
          const tbId = `${tb.entityType}:${tb.entityId}`
          const existingTb = await this.database.syncTombstones.get(tbId)
          if (!existingTb || tb.deletedAt >= existingTb.deletedAt) {
            await this.database.syncTombstones.put({
              id: tbId,
              entityType: tb.entityType,
              entityId: tb.entityId,
              deletedAt: tb.deletedAt,
            })
          }

          switch (tb.entityType) {
            case 'budget':
              await applyTombstoneToMutable(
                this.database.budgets,
                tb.entityId,
                tb.deletedAt,
              )
              break
            case 'recurring_expense':
              await applyTombstoneToMutable(
                this.database.recurringExpenses,
                tb.entityId,
                tb.deletedAt,
              )
              break
            case 'service':
              await applyTombstoneToMutable(
                this.database.services,
                tb.entityId,
                tb.deletedAt,
              )
              break
            case 'employee':
              await applyTombstoneToMutable(
                this.database.employees,
                tb.entityId,
                tb.deletedAt,
              )
              break
            case 'revenue':
              await applyTombstoneToMutable(
                this.database.revenues,
                tb.entityId,
                tb.deletedAt,
              )
              break
            case 'expense':
              await applyTombstoneToMutable(
                this.database.expenses,
                tb.entityId,
                tb.deletedAt,
              )
              break
            case 'cash_session':
              await applyTombstoneToMutable(
                this.database.cashSessions,
                tb.entityId,
                tb.deletedAt,
              )
              break
            case 'cash_movement':
              await applyTombstoneToMutable(
                this.database.cashMovements,
                tb.entityId,
                tb.deletedAt,
              )
              break
            case 'advance':
              await applyTombstoneToMutable(
                this.database.advances,
                tb.entityId,
                tb.deletedAt,
              )
              break
            case 'salary_payment':
              await applyTombstoneToMutable(
                this.database.salaryPayments,
                tb.entityId,
                tb.deletedAt,
              )
              break
            case 'product':
              await applyTombstoneToMutable(
                this.database.products,
                tb.entityId,
                tb.deletedAt,
              )
              break
            case 'bonus':
              await applyTombstoneToImmutable(
                this.database.bonuses,
                tb.entityId,
                tb.deletedAt,
              )
              break
            case 'stock_movement':
              await applyTombstoneToImmutable(
                this.database.stockMovements,
                tb.entityId,
                tb.deletedAt,
              )
              break
            case 'correction_log':
              await applyTombstoneToImmutable(
                this.database.correctionLogs,
                tb.entityId,
                tb.deletedAt,
              )
              break
          }
        }
      },
    )

    await this.purgeLegacyMockData()
    return { mergedCount }
  }

  // --------------------------------------------------------------------------
  // COMPTES UTILISATEURS & AUTHENTIFICATION HYBRIDE (Gérant / Caissier)
  // --------------------------------------------------------------------------
  public async listUserAccounts(): Promise<PublicSalonUser[]> {
    const rows = await this.database.users.toArray()
    return rows
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(({ passwordHash: _ignored, ...pub }) => {
        void _ignored
        return pub
      })
  }

  public async hasAnyManagerAccount(): Promise<boolean> {
    const rows = await this.database.users.toArray()
    return rows.some((u) => u.isActive && u.role === 'manager')
  }

  public async cacheRemoteUserAccount(account: SalonUserAccount): Promise<void> {
    const email = account.email.trim().toLowerCase()
    const existingByEmail = await this.database.users
      .where('email')
      .equals(email)
      .first()
    if (existingByEmail && existingByEmail.id !== account.id) {
      await this.database.users.delete(existingByEmail.id)
    }
    await this.database.users.put({
      ...account,
      email,
    })
    await this.purgeLegacyMockData()
  }

  public async registerLocalUserAccount(input: {
    fullName: string
    email: string
    phone?: string
    password: string
    role: UserRole
    salonName?: string
    callerIsAuthenticatedManager?: boolean
  }): Promise<PublicSalonUser> {
    await this.ensureInitialized()
    const fullName = input.fullName.trim()
    const email = input.email.trim().toLowerCase()
    const password = input.password

    if (fullName.length < 2) {
      throw new Error(
        'Veuillez renseigner votre nom complet (au moins 2 caractères).',
      )
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Veuillez saisir une adresse e-mail valide.')
    }
    if (password.length < 6) {
      throw new Error('Le mot de passe doit contenir au moins 6 caractères.')
    }

    const existing = await this.database.users
      .where('email')
      .equals(email)
      .first()
    if (existing) {
      throw new Error('Un compte existe déjà avec cette adresse e-mail.')
    }

    const hasManager = await this.hasAnyManagerAccount()
    if (!hasManager && input.role !== 'manager') {
      throw new Error(
        'Le tout premier compte du salon doit obligatoirement avoir le rôle Gérant.',
      )
    }

    if (hasManager && !input.callerIsAuthenticatedManager) {
      throw new Error(
        'Un compte Gérant existe déjà : connectez-vous en tant que Gérant pour ajouter un collaborateur.',
      )
    }

    const nowIso = new Date().toISOString()
    const passwordHash = await hashPasswordPBKDF2(password)
    const account: SalonUserAccount = {
      id: `usr-${crypto.randomUUID()}`,
      fullName,
      email,
      phone: input.phone?.trim() || undefined,
      role: input.role,
      passwordHash,
      isActive: true,
      lastLoginAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    }

    await this.database.users.put(account)

    if (!hasManager) {
      await this.updateSalonInfo({
        ...(input.salonName?.trim() ? { name: input.salonName.trim() } : {}),
        managerName: fullName,
        ...(input.phone?.trim() ? { phone: input.phone.trim() } : {}),
      })
    }

    await this.purgeLegacyMockData()

    const { passwordHash: _ignored, ...pub } = account
    void _ignored
    return pub
  }

  private static normalizeIdentifierText(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
  }

  private static matchesAccountIdentifier(
    account: SalonUserAccount,
    rawIdentifier: string,
  ): boolean {
    const trimmed = rawIdentifier.trim()
    if (!trimmed) return false

    if (account.email.trim().toLowerCase() === trimmed.toLowerCase()) {
      return true
    }

    const normInput = SalonRepositoryHub.normalizeIdentifierText(trimmed)
    const normFullName = SalonRepositoryHub.normalizeIdentifierText(
      account.fullName,
    )
    if (normInput.length >= 2 && normFullName === normInput) {
      return true
    }

    const inputDigits = trimmed.replace(/\D+/g, '')
    const accountDigits = (account.phone ?? '').replace(/\D+/g, '')
    if (inputDigits.length >= 6 && accountDigits.length >= 6) {
      if (
        accountDigits === inputDigits ||
        accountDigits.endsWith(inputDigits) ||
        inputDigits.endsWith(accountDigits)
      ) {
        return true
      }
    }

    return false
  }

  public async authenticateLocalUserAccount(input: {
    email: string
    password: string
  }): Promise<PublicSalonUser> {
    await this.ensureInitialized()
    const identifier = input.email.trim()
    if (!identifier || !input.password) {
      throw new Error('Identifiant ou mot de passe incorrect.')
    }

    const allAccounts = await this.database.users.toArray()
    const candidates = allAccounts.filter((u) =>
      SalonRepositoryHub.matchesAccountIdentifier(u, identifier),
    )

    if (candidates.length === 0) {
      throw new Error('Identifiant ou mot de passe incorrect.')
    }

    let matchedAccount: SalonUserAccount | null = null
    for (const candidate of candidates) {
      const ok = await verifyPasswordPBKDF2(
        input.password,
        candidate.passwordHash,
      )
      if (ok) {
        matchedAccount = candidate
        break
      }
    }

    if (!matchedAccount) {
      throw new Error('Identifiant ou mot de passe incorrect.')
    }
    if (!matchedAccount.isActive) {
      throw new Error('Ce compte a été désactivé par le Gérant.')
    }

    const nowIso = new Date().toISOString()
    const updated: SalonUserAccount = {
      ...matchedAccount,
      lastLoginAt: nowIso,
      updatedAt: nowIso,
    }
    await this.database.users.put(updated)
    await this.purgeLegacyMockData()

    const { passwordHash: _ignored, ...pub } = updated
    void _ignored
    return pub
  }

  public async importBackupPayload(
    payload: unknown,
  ): Promise<void> {
    if (
      !payload ||
      typeof payload !== 'object' ||
      (payload as SalonBackupPayload).format !== 'SALON_PRO_BACKUP_V1'
    ) {
      throw new Error(
        'Fichier de sauvegarde non reconnu (format attendu : SALON_PRO_BACKUP_V1).',
      )
    }

    const data = payload as SalonBackupPayload
    if (!data.salon || !Array.isArray(data.revenues) || !Array.isArray(data.expenses)) {
      throw new Error('La structure interne de la sauvegarde est incomplète.')
    }

    await this.database.transaction(
      'rw',
      this.database.tables,
      async () => {
        const preservedUsers = await this.database.users.toArray()
        await Promise.all(this.database.tables.map((t) => t.clear()))
        await this.database.salon.put(data.salon)
        await this.database.settings.put(
          data.settings ?? buildDefaultSettings(),
        )
        await this.database.categories.bulkPut(
          data.categories?.length ? data.categories : buildSystemCategories(),
        )
        if (data.services?.length) await this.database.services.bulkPut(data.services)
        if (data.employees?.length) await this.database.employees.bulkPut(data.employees)
        if (data.revenues?.length) await this.database.revenues.bulkPut(data.revenues)
        if (data.expenses?.length) await this.database.expenses.bulkPut(data.expenses)
        if (data.cashSessions?.length) await this.database.cashSessions.bulkPut(data.cashSessions)
        if (data.cashMovements?.length) await this.database.cashMovements.bulkPut(data.cashMovements)
        if (data.advances?.length) await this.database.advances.bulkPut(data.advances)
        if (data.bonuses?.length) await this.database.bonuses.bulkPut(data.bonuses)
        if (data.salaryPayments?.length) await this.database.salaryPayments.bulkPut(data.salaryPayments)
        if (data.products?.length) await this.database.products.bulkPut(data.products)
        if (data.stockMovements?.length) await this.database.stockMovements.bulkPut(data.stockMovements)
        if (data.budgets?.length) await this.database.budgets.bulkPut(data.budgets)
        if (data.recurringExpenses?.length) await this.database.recurringExpenses.bulkPut(data.recurringExpenses)
        if (data.correctionLogs?.length) await this.database.correctionLogs.bulkPut(data.correctionLogs)
        const usersToSave = data.users?.length ? data.users : preservedUsers
        if (usersToSave.length) await this.database.users.bulkPut(usersToSave)
      },
    )

    await this.purgeLegacyMockData()
  }

  public async resetAllDataWithConfirmation(
    confirmationWord: string,
  ): Promise<void> {
    if (confirmationWord.trim().toUpperCase() !== 'SUPPRIMER') {
      throw new Error(
        'Confirmation invalide : veuillez saisir exactement SUPPRIMER pour réinitialiser toutes les données.',
      )
    }

    const nowIso = new Date().toISOString()
    await this.database.transaction(
      'rw',
      this.database.tables,
      async () => {
        const [preservedUsers, currentSalon] = await Promise.all([
          this.database.users.toArray(),
          this.database.salon.get('salon-main'),
        ])
        await Promise.all(this.database.tables.map((t) => t.clear()))
        const activeManager =
          preservedUsers.find((u) => u.role === 'manager' && u.isActive) ??
          preservedUsers[0] ??
          null
        const nextSalon = currentSalon
          ? sanitizeLegacySalonInfo(currentSalon, activeManager, nowIso).cleaned
          : buildDefaultSalonInfo(nowIso)
        await this.database.salon.put({ ...nextSalon, updatedAt: nowIso })
        await this.database.settings.put({
          ...buildDefaultSettings(nowIso),
          dataHygieneVersion: CURRENT_DATA_HYGIENE_VERSION,
          mockPurgeCompletedAt: nowIso,
        })
        await this.database.categories.bulkPut(buildSystemCategories(nowIso))
        if (preservedUsers.length > 0) {
          await this.database.users.bulkPut(preservedUsers)
        }
      },
    )
  }
}

export const salonRepo = new SalonRepositoryHub()
