import Dexie, { type Table } from 'dexie'
import type {
  AdvanceEntry,
  Appointment,
  AppSettings,
  BonusEntry,
  BudgetTarget,
  CashMovement,
  CashSession,
  CategoryItem,
  Client,
  CorrectionLog,
  Employee,
  ExpenseEntry,
  Invoice,
  PersistedSyncTombstone,
  ProductItem,
  RecurringExpenseTemplate,
  RevenueEntry,
  SalaryPayment,
  SalonInfo,
  SalonUserAccount,
  ServiceCatalogItem,
  StockMovement,
  SyncTombstoneEntityType,
} from '../domain/models'
import {
  isLegacyMockRecord,
  isLegacyRecurringPresetRecord,
  sanitizeLegacySalonInfo,
} from '../domain/mockPurge'

export class SalonProDatabase extends Dexie {
  salon!: Table<SalonInfo, string>
  settings!: Table<AppSettings, string>
  categories!: Table<CategoryItem, string>
  services!: Table<ServiceCatalogItem, string>
  employees!: Table<Employee, string>
  revenues!: Table<RevenueEntry, string>
  expenses!: Table<ExpenseEntry, string>
  cashSessions!: Table<CashSession, string>
  cashMovements!: Table<CashMovement, string>
  advances!: Table<AdvanceEntry, string>
  bonuses!: Table<BonusEntry, string>
  salaryPayments!: Table<SalaryPayment, string>
  products!: Table<ProductItem, string>
  stockMovements!: Table<StockMovement, string>
  budgets!: Table<BudgetTarget, string>
  recurringExpenses!: Table<RecurringExpenseTemplate, string>
  users!: Table<SalonUserAccount, string>
  correctionLogs!: Table<CorrectionLog, string>
  syncTombstones!: Table<PersistedSyncTombstone, string>
  invoices!: Table<Invoice, string>
  clients!: Table<Client, string>
  appointments!: Table<Appointment, string>

  constructor(dbName = 'SalonProLocalDB') {
    super(dbName)

    this.version(1).stores({
      salon: 'id',
      settings: 'id',
      categories: 'id, scope, code, isArchived',
      services: 'id, categoryCode, isActive',
      employees: 'id, isActive, hireDate',
      revenues:
        'id, date, categoryCode, paymentMethod, serviceId, employeeId, isArchived',
      expenses:
        'id, date, categoryCode, paymentMethod, sourceModule, isArchived',
      cashSessions: 'id, status, openedAt',
      cashMovements: 'id, sessionId, type, occurredAt',
      advances: 'id, employeeId, periodMonth, settledInPayrollId, isArchived',
      bonuses: 'id, employeeId, periodMonth',
      salaryPayments: 'id, employeeId, periodMonth, status',
      products: 'id, sku, categoryCode, isActive',
      stockMovements: 'id, productId, type, occurredAt',
      budgets: 'id, periodMonth, kind, categoryCode',
      correctionLogs: 'id, entityType, entityId, createdAt',
    })

    this.version(2).stores({
      salon: 'id',
      settings: 'id',
      categories: 'id, scope, code, isArchived',
      services: 'id, categoryCode, isActive',
      employees: 'id, isActive, hireDate',
      revenues:
        'id, date, ticketId, receiptNumber, categoryCode, paymentMethod, serviceId, productId, employeeId, isArchived',
      expenses:
        'id, date, categoryCode, paymentMethod, sourceModule, recurringTemplateId, recurringPeriodMonth, isArchived',
      cashSessions: 'id, status, openedAt',
      cashMovements: 'id, sessionId, type, occurredAt',
      advances: 'id, employeeId, periodMonth, settledInPayrollId, isArchived',
      bonuses: 'id, employeeId, periodMonth',
      salaryPayments: 'id, employeeId, periodMonth, status',
      products: 'id, sku, categoryCode, isActive',
      stockMovements: 'id, productId, type, occurredAt',
      budgets: 'id, periodMonth, kind, categoryCode',
      recurringExpenses: 'id, categoryCode, isActive',
      correctionLogs: 'id, entityType, entityId, createdAt',
    })

    this.version(3).stores({
      salon: 'id',
      settings: 'id',
      categories: 'id, scope, code, isArchived',
      services: 'id, categoryCode, isActive',
      employees: 'id, isActive, hireDate',
      revenues:
        'id, date, ticketId, receiptNumber, categoryCode, paymentMethod, serviceId, productId, employeeId, isArchived',
      expenses:
        'id, date, categoryCode, paymentMethod, sourceModule, recurringTemplateId, recurringPeriodMonth, isArchived',
      cashSessions: 'id, status, openedAt',
      cashMovements: 'id, sessionId, type, occurredAt',
      advances: 'id, employeeId, periodMonth, settledInPayrollId, isArchived',
      bonuses: 'id, employeeId, periodMonth',
      salaryPayments: 'id, employeeId, periodMonth, status',
      products: 'id, sku, categoryCode, isActive',
      stockMovements: 'id, productId, type, occurredAt',
      budgets: 'id, periodMonth, kind, categoryCode',
      recurringExpenses: 'id, categoryCode, isActive',
      users: 'id, &email, role, isActive, updatedAt',
      correctionLogs: 'id, entityType, entityId, createdAt',
    })

    this.version(4)
      .stores({
        salon: 'id',
        settings: 'id',
        categories: 'id, scope, code, isArchived',
        services: 'id, categoryCode, isActive',
        employees: 'id, isActive, hireDate',
        revenues:
          'id, date, ticketId, receiptNumber, categoryCode, paymentMethod, serviceId, productId, employeeId, isArchived',
        expenses:
          'id, date, categoryCode, paymentMethod, sourceModule, recurringTemplateId, recurringPeriodMonth, isArchived',
        cashSessions: 'id, status, openedAt',
        cashMovements: 'id, sessionId, type, occurredAt',
        advances: 'id, employeeId, periodMonth, settledInPayrollId, isArchived',
        bonuses: 'id, employeeId, periodMonth',
        salaryPayments: 'id, employeeId, periodMonth, status',
        products: 'id, sku, categoryCode, isActive',
        stockMovements: 'id, productId, type, occurredAt',
        budgets: 'id, periodMonth, kind, categoryCode',
        recurringExpenses: 'id, categoryCode, isActive',
        users: 'id, &email, role, isActive, updatedAt',
        correctionLogs: 'id, entityType, entityId, createdAt',
        syncTombstones: 'id, entityType, entityId, deletedAt',
        invoices: 'id, invoiceNumber, date, paymentStatus, isArchived',
      })
      .upgrade(async (tx) => {
        const nowIso = new Date().toISOString()
        const users = (await tx.table('users').toArray()) as SalonUserAccount[]
        const activeManager =
          users.find((u) => u.role === 'manager' && u.isActive) ??
          users[0] ??
          null

        const existingSalon = (await tx
          .table('salon')
          .get('salon-main')) as SalonInfo | undefined
        if (existingSalon) {
          const { cleaned, changed } = sanitizeLegacySalonInfo(
            existingSalon,
            activeManager,
            nowIso,
          )
          if (changed) {
            await tx.table('salon').put(cleaned)
          }
        }

        const tableConfigs: Array<{
          tableName: string
          entityType: SyncTombstoneEntityType
          predicate: (row: unknown) => boolean
        }> = [
          {
            tableName: 'services',
            entityType: 'service',
            predicate: isLegacyMockRecord,
          },
          {
            tableName: 'employees',
            entityType: 'employee',
            predicate: isLegacyMockRecord,
          },
          {
            tableName: 'revenues',
            entityType: 'revenue',
            predicate: isLegacyMockRecord,
          },
          {
            tableName: 'expenses',
            entityType: 'expense',
            predicate: isLegacyMockRecord,
          },
          {
            tableName: 'recurringExpenses',
            entityType: 'recurring_expense',
            predicate: isLegacyRecurringPresetRecord,
          },
          {
            tableName: 'cashSessions',
            entityType: 'cash_session',
            predicate: isLegacyMockRecord,
          },
          {
            tableName: 'cashMovements',
            entityType: 'cash_movement',
            predicate: isLegacyMockRecord,
          },
          {
            tableName: 'advances',
            entityType: 'advance',
            predicate: isLegacyMockRecord,
          },
          {
            tableName: 'bonuses',
            entityType: 'bonus',
            predicate: isLegacyMockRecord,
          },
          {
            tableName: 'salaryPayments',
            entityType: 'salary_payment',
            predicate: isLegacyMockRecord,
          },
          {
            tableName: 'products',
            entityType: 'product',
            predicate: isLegacyMockRecord,
          },
          {
            tableName: 'stockMovements',
            entityType: 'stock_movement',
            predicate: isLegacyMockRecord,
          },
          {
            tableName: 'budgets',
            entityType: 'budget',
            predicate: isLegacyMockRecord,
          },
          {
            tableName: 'correctionLogs',
            entityType: 'correction_log',
            predicate: isLegacyMockRecord,
          },
        ]

        const tombstones: PersistedSyncTombstone[] = []
        for (const cfg of tableConfigs) {
          const rows = (await tx.table(cfg.tableName).toArray()) as Array<{
            id: string
          }>
          const mockIds = rows
            .filter((r) => cfg.predicate(r))
            .map((r) => r.id)
          if (mockIds.length > 0) {
            await tx.table(cfg.tableName).bulkDelete(mockIds)
            for (const entityId of mockIds) {
              tombstones.push({
                id: `${cfg.entityType}:${entityId}`,
                entityType: cfg.entityType,
                entityId,
                deletedAt: nowIso,
              })
            }
          }
        }

        if (tombstones.length > 0) {
          await tx.table('syncTombstones').bulkPut(tombstones)
        }
      })

    this.version(5).stores({
      salon: 'id',
      settings: 'id',
      categories: 'id, scope, code, isArchived',
      services: 'id, categoryCode, isActive',
      employees: 'id, isActive, hireDate',
      revenues:
        'id, date, ticketId, receiptNumber, categoryCode, paymentMethod, serviceId, productId, employeeId, isArchived',
      expenses:
        'id, date, categoryCode, paymentMethod, sourceModule, recurringTemplateId, recurringPeriodMonth, isArchived',
      cashSessions: 'id, status, openedAt',
      cashMovements: 'id, sessionId, type, occurredAt',
      advances: 'id, employeeId, periodMonth, settledInPayrollId, isArchived',
      bonuses: 'id, employeeId, periodMonth',
      salaryPayments: 'id, employeeId, periodMonth, status',
      products: 'id, sku, categoryCode, isActive',
      stockMovements: 'id, productId, type, occurredAt',
      budgets: 'id, periodMonth, kind, categoryCode',
      recurringExpenses: 'id, categoryCode, isActive',
      users: 'id, &email, role, isActive, updatedAt',
      correctionLogs: 'id, entityType, entityId, createdAt',
      syncTombstones: 'id, entityType, entityId, deletedAt',
      invoices: 'id, invoiceNumber, date, paymentStatus, isArchived',
    })

    this.version(6).stores({
      salon: 'id',
      settings: 'id',
      categories: 'id, scope, code, isArchived',
      services: 'id, categoryCode, isActive',
      employees: 'id, isActive, hireDate',
      revenues:
        'id, date, ticketId, receiptNumber, categoryCode, paymentMethod, serviceId, productId, employeeId, isArchived',
      expenses:
        'id, date, categoryCode, paymentMethod, sourceModule, recurringTemplateId, recurringPeriodMonth, isArchived',
      cashSessions: 'id, status, openedAt',
      cashMovements: 'id, sessionId, type, occurredAt',
      advances: 'id, employeeId, periodMonth, settledInPayrollId, isArchived',
      bonuses: 'id, employeeId, periodMonth',
      salaryPayments: 'id, employeeId, periodMonth, status',
      products: 'id, sku, categoryCode, isActive',
      stockMovements: 'id, productId, type, occurredAt',
      budgets: 'id, periodMonth, kind, categoryCode',
      recurringExpenses: 'id, categoryCode, isActive',
      users: 'id, &email, role, isActive, updatedAt',
      correctionLogs: 'id, entityType, entityId, createdAt',
      syncTombstones: 'id, entityType, entityId, deletedAt',
      invoices: 'id, invoiceNumber, date, paymentStatus, isArchived',
      clients: 'id, phone, isActive, createdAt, updatedAt',
      appointments: 'id, clientId, serviceId, employeeId, startAt, status, source',
    })
  }
}

export const db = new SalonProDatabase()
