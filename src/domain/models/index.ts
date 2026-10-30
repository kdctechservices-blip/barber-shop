/**
 * SALON PRO — Modèles de données du domaine métier
 * Tous les montants financiers sont des entiers en Francs CFA (XOF), sans centimes flottants.
 */

export type PaymentMethodCode =
  | 'cash'
  | 'wave'
  | 'orange_money'
  | 'mtn_momo'
  | 'transfer'
  | 'card'
  | 'other'
  | (string & {})

export type CategoryScope =
  | 'revenue'
  | 'expense'
  | 'product'
  | 'service'
  | 'payment_method'

export interface SalonInfo {
  id: string
  name: string
  address: string
  phone: string
  managerName: string
  currency: 'XOF'
  logoDataUrl?: string
  createdAt: string
  updatedAt: string
}

export type ReceiptFormat = 'thermal_80mm' | 'a5_sheet'

export type ServiceConfigMode = 'simple' | 'pricing_variants' | 'full'

export interface AppSettings {
  id: 'default'
  theme: 'light' | 'dark'
  dateFormat: 'dd/MM/yyyy' | 'long-fr'
  printHeaderNote: string
  printCompact: boolean
  receiptFormat?: ReceiptFormat
  receiptFooterNote?: string
  serviceConfigMode?: ServiceConfigMode
  freshBarberCatalogSeededAt?: string
  lastBackupExportedAt?: string
  dataHygieneVersion?: number
  mockPurgeCompletedAt?: string
  updatedAt: string
}

export type SyncTombstoneEntityType =
  | 'service'
  | 'employee'
  | 'revenue'
  | 'expense'
  | 'recurring_expense'
  | 'cash_session'
  | 'cash_movement'
  | 'advance'
  | 'bonus'
  | 'salary_payment'
  | 'product'
  | 'stock_movement'
  | 'budget'
  | 'correction_log'

export interface PersistedSyncTombstone {
  id: string // `${entityType}:${entityId}`
  entityType: SyncTombstoneEntityType
  entityId: string
  deletedAt: string
}

export interface CategoryItem {
  id: string
  scope: CategoryScope
  code: string
  label: string
  isSystem: boolean
  isArchived: boolean
  createdAt: string
  updatedAt: string
}

export interface ServicePriceVariant {
  id: string
  label: string
  price: number
  durationMinutes?: number
}

export interface ServiceDefaultConsumable {
  productId: string
  quantity: number
}

export type ServiceCommissionMode = 'rate' | 'fixed'

export interface ServiceCommissionOverride {
  mode: ServiceCommissionMode
  value: number
}

export interface ServiceCatalogItem {
  id: string
  name: string
  categoryCode: string
  referencePrice: number
  description: string
  durationMinutes?: number
  priceLocked?: boolean
  variants?: ServicePriceVariant[]
  defaultConsumables?: ServiceDefaultConsumable[]
  commissionOverride?: ServiceCommissionOverride
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export type RemunerationType = 'fixed' | 'fixed_plus_variable'
export type CommissionBasis =
  | 'employee_services'
  | 'employee_services_and_products'
  | 'total_revenue'

export interface Employee {
  id: string
  lastName: string
  firstName: string
  fullName: string
  roleTitle: string
  phone: string
  hireDate: string // YYYY-MM-DD
  baseSalary: number
  remunerationType: RemunerationType
  defaultBonus: number
  commissionEnabled: boolean
  commissionBasis: CommissionBasis
  commissionRate: number // 0..100
  adminNote: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface TicketPaymentSplit {
  method: PaymentMethodCode
  amount: number
  cashMovementId?: string
}

export interface TicketConsumableUsage {
  productId: string
  productName: string
  quantity: number
  unit: string
  stockMovementId?: string
}

export interface RevenueEntry {
  id: string
  date: string // ISO datetime
  label: string
  categoryCode: string
  serviceId?: string
  serviceVariantId?: string
  serviceVariantLabel?: string
  productId?: string
  employeeId?: string
  quantity?: number
  unitPrice?: number
  amount: number
  paymentMethod: PaymentMethodCode
  paymentSplits?: TicketPaymentSplit[]
  ticketId?: string
  receiptNumber?: string
  clientName?: string
  amountTendered?: number
  changeGiven?: number
  linkedStockMovementId?: string
  consumablesUsed?: TicketConsumableUsage[]
  reference?: string
  note?: string
  sourceModule: 'revenue' | 'cash' | 'inventory_sale'
  cashMovementId?: string
  isArchived?: boolean
  createdAt: string
  updatedAt: string
}

export interface ExpenseEntry {
  id: string
  date: string // ISO datetime
  label: string
  categoryCode: string
  amount: number
  paymentMethod: PaymentMethodCode
  beneficiary?: string
  receiptRef?: string
  note?: string
  sourceModule: 'expenses' | 'cash' | 'payroll' | 'inventory_purchase'
  linkedPayrollId?: string
  linkedAdvanceId?: string
  linkedStockMovementId?: string
  recurringTemplateId?: string
  recurringPeriodMonth?: string
  cashMovementId?: string
  isStockPurchase: boolean
  isArchived?: boolean
  createdAt: string
  updatedAt: string
}

export interface CashSession {
  id: string
  openedAt: string
  closedAt?: string
  openingBalance: number
  totalCashIn: number
  totalCashOut: number
  theoreticalClosingBalance: number
  countedClosingBalance?: number
  closingDenominations?: Record<string, number>
  discrepancy?: number
  status: 'open' | 'closed'
  closingNote?: string
  createdAt: string
  updatedAt: string
}

export type CashMovementType =
  | 'opening'
  | 'in'
  | 'out'
  | 'correction_in'
  | 'correction_out'

export interface CashMovement {
  id: string
  sessionId: string
  type: CashMovementType
  amount: number
  reason: string
  categoryCode: string
  paymentMethod: 'cash'
  occurredAt: string
  note?: string
  linkedRevenueId?: string
  linkedExpenseId?: string
  createdAt: string
  updatedAt: string
}

export interface AdvanceEntry {
  id: string
  employeeId: string
  periodMonth: string // YYYY-MM
  amount: number
  paidAt: string
  paymentMethod: PaymentMethodCode
  reference?: string
  note?: string
  settledInPayrollId?: string
  linkedExpenseId: string
  isArchived?: boolean
  createdAt: string
  updatedAt: string
}

export interface BonusEntry {
  id: string
  employeeId: string
  periodMonth: string // YYYY-MM
  amount: number
  reason: string
  createdAt: string
}

export interface SalaryPayment {
  id: string
  employeeId: string
  periodMonth: string // YYYY-MM
  baseSalary: number
  bonusesTotal: number
  advancesDeducted: number
  deductions: number
  commissionCalculated: number
  commissionValidated: number
  netPaidAmount: number
  isPartial?: boolean
  paidAt: string
  paymentMethod: PaymentMethodCode
  reference?: string
  note?: string
  linkedExpenseId?: string
  status: 'validated' | 'corrected'
  createdAt: string
  updatedAt: string
}

export type ProductUsageType = 'consumable' | 'resale' | 'both'

export interface ProductItem {
  id: string
  name: string
  sku: string
  categoryCode: string
  quantity: number
  unit: string
  costPrice: number
  salePrice?: number
  alertThreshold: number
  usageType: ProductUsageType
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export type StockMovementType =
  | 'purchase'
  | 'use'
  | 'sale'
  | 'loss'
  | 'adjustment'

export interface StockMovement {
  id: string
  productId: string
  type: StockMovementType
  quantityDelta: number
  quantityAfter: number
  unitCost: number
  unitSalePrice?: number
  reason: string
  occurredAt: string
  linkedExpenseId?: string
  linkedRevenueId?: string
  createdAt: string
}

export interface BudgetTarget {
  id: string
  periodMonth: string // YYYY-MM
  kind: 'revenue_goal' | 'expense_cap'
  categoryCode: string
  plannedAmount: number
  note?: string
  createdAt: string
  updatedAt: string
}

export interface CorrectionLog {
  id: string
  entityType: 'cash_session' | 'revenue' | 'expense' | 'payroll' | 'inventory'
  entityId: string
  action: string
  reason: string
  previousSnapshotJson: string
  newSnapshotJson: string
  createdAt: string
}

export interface RecurringExpenseTemplate {
  id: string
  label: string
  categoryCode: string
  defaultAmount: number
  paymentMethod: PaymentMethodCode
  beneficiary?: string
  dayOfMonth: number
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export type UserRole = 'manager' | 'cashier'

export interface SalonUserAccount {
  id: string
  fullName: string
  email: string
  phone?: string
  role: UserRole
  passwordHash: string
  isActive: boolean
  lastLoginAt?: string
  createdAt: string
  updatedAt: string
}

export type PublicSalonUser = Omit<SalonUserAccount, 'passwordHash'>

export interface SalonBackupPayload {
  format: 'SALON_PRO_BACKUP_V1'
  exportedAt: string
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
  recurringExpenses?: RecurringExpenseTemplate[]
  /**
   * Comptes utilisateurs — utilisés UNIQUEMENT par la sauvegarde/restauration
   * JSON locale (action explicite du Gérant). Ils ne sont JAMAIS transmis au
   * Cloud : voir `buildCloudSyncEnvelope` et `/api/users/provision`.
   */
  users?: SalonUserAccount[]
  correctionLogs: CorrectionLog[]
}
