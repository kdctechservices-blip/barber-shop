import { fetchWithSession, readStoredSessionTokens } from './sessionClient'

/**
 * Client navigateur de la facturation (P1 — Sprint 7).
 *
 * Toutes les URL sont **relatives** (`/api/...`) : le serveur de développement
 * et l'hébergement proxifient eux-mêmes vers la fonction serveur, ce qui évite
 * toute adresse codée en dur côté navigateur.
 *
 * Aucune offre payante ne s'active ici : la souscription place l'abonnement en
 * `pending_payment`, seul le canal plateforme (code serveur) l'active.
 */

export type PlanCode =
  | 'decouverte'
  | 'starter'
  | 'professional'
  | 'business'
  | 'enterprise'

export interface PlanDefinition {
  code: PlanCode
  name: string
  priceFcfa: number | null
  maxSalons: number | null
  maxEmployees: number | null
  maxDevices: number | null
  features: string[]
  requiresPayment: boolean
}

export interface PlanCatalog {
  plans: PlanDefinition[]
  currency: string
  defaultPlan: PlanCode
  trialPlan: PlanCode
  trialDays: number
  graceDays: number
  billingPeriodDays: number
}

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'pending_payment'
  | 'past_due'
  | 'cancelled'

export interface SubscriptionSnapshot {
  plan: PlanDefinition
  planCode: PlanCode
  status: SubscriptionStatus
  isExpired: boolean
  daysRemaining: number
  pendingPlanCode: PlanCode | null
  usage: { members: number; salons: number }
  limits: { members: number | null; salons: number | null; devices: number | null }
  subscription: {
    orgId: string
    planCode: PlanCode
    pendingPlanCode: PlanCode | null
    status: SubscriptionStatus
    trialEndsAt: string | null
    currentPeriodStart: string | null
    currentPeriodEnd: string | null
    cancelAtPeriodEnd: boolean
    updatedAt: string
  }
}

export interface PlanChangeOutcome extends SubscriptionSnapshot {
  applied: boolean
  message: string
}

export class BillingApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'BillingApiError'
    this.status = status
    this.code = code
  }
}

function authHeaders(): Record<string, string> {
  const { sessionToken } = readStoredSessionTokens()
  return sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}
}

async function requestJson<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    ...(init?.body === undefined
      ? {}
      : { body: JSON.stringify(init.body) }),
  })
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >
  if (!response.ok) {
    throw new BillingApiError(
      response.status,
      typeof payload.code === 'string' ? payload.code : 'BILLING_ERROR',
      typeof payload.message === 'string'
        ? payload.message
        : 'Opération de facturation impossible.',
    )
  }
  return payload as T
}

/** Catalogue public des offres (aucune session requise). */
export async function fetchPlanCatalog(): Promise<PlanCatalog> {
  return requestJson<PlanCatalog>('/api/billing/plans')
}

/** Abonnement du salon authentifié, avec consommation et limites. */
export async function fetchSubscription(): Promise<SubscriptionSnapshot> {
  return requestJson<SubscriptionSnapshot>('/api/billing/subscription')
}

/** Demande de changement d'offre (offre payante → attente de paiement). */
export async function subscribeToPlan(
  planCode: PlanCode,
): Promise<PlanChangeOutcome> {
  return requestJson<PlanChangeOutcome>('/api/billing/subscribe', {
    method: 'POST',
    body: { planCode },
  })
}

/** Résiliation : l'offre payée reste active jusqu'à la fin de la période. */
export async function cancelSubscription(): Promise<SubscriptionSnapshot> {
  return requestJson<SubscriptionSnapshot>('/api/billing/cancel', {
    method: 'POST',
  })
}

/* -------------------------------------------------------------------------- */
/* Extensions Sprint 3 : moyens de paiement PSP (Wave / CinetPay / PayDunya) */
/* -------------------------------------------------------------------------- */

export interface PaymentTransaction {
  id: string
  reference: string
  provider: string
  orgId: string
  planCode: string | null
  amountFcfa: number
  status: string
  callbackUrl: string | null
  returnUrl: string | null
  metadata: unknown
  createdAt: string
  updatedAt: string
  paidAt: string | null
  pspTransactionId: string | null
  failureReason: string | null
}

export interface Reminder {
  id: string
  orgId: string
  type: string
  reminderDay: number
  sentAt: string
  createdAt: string
}

export interface PaymentInitResult {
  ok: boolean
  transactionId: string
  reference: string
  provider: string
  amountFcfa: number
  planCode: string
  paymentUrl: string
  status: string
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>
}

function toError(
  _response: Response,
  payload: Record<string, unknown>,
  fallback: string,
): Error {
  return new Error(
    typeof payload.message === 'string' ? payload.message : fallback,
  )
}

/** Initialise un paiement auprès d'un prestataire (Wave / CinetPay / PayDunya). */
export async function initiatePayment(input: {
  provider: string
  planCode?: string
  returnUrl?: string
}): Promise<PaymentInitResult> {
  const response = await fetchWithSession('/api/billing/payment/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: input.provider,
      planCode: input.planCode ?? undefined,
      returnUrl: input.returnUrl ?? undefined,
    }),
  })
  const payload = await readJson(response)
  if (!response.ok) throw toError(response, payload, 'Impossible d’initier le paiement.')
  return payload as unknown as PaymentInitResult
}

/** Historique des transactions de paiement du salon. */
export async function fetchPaymentTransactions(): Promise<PaymentTransaction[]> {
  const response = await fetchWithSession('/api/billing/payment/transactions')
  const payload = await readJson(response)
  if (!response.ok) throw toError(response, payload, 'Impossible de charger les transactions.')
  const rows = Array.isArray(payload.transactions) ? payload.transactions : []
  return rows.map((r: Record<string, unknown>) => ({
    id: String(r.id ?? ''),
    reference: String(r.reference ?? ''),
    provider: String(r.provider ?? ''),
    orgId: String(r.orgId ?? r.org_id ?? ''),
    planCode: (r.planCode ?? r.plan_code ?? null) as string | null,
    amountFcfa: typeof r.amountFcfa === 'number' ? r.amountFcfa : 0,
    status: String(r.status ?? 'pending'),
    callbackUrl: (r.callbackUrl ?? r.callback_url ?? null) as string | null,
    returnUrl: (r.returnUrl ?? r.return_url ?? null) as string | null,
    metadata: r.metadata ?? null,
    createdAt: String(r.createdAt ?? r.created_at ?? ''),
    updatedAt: String(r.updatedAt ?? r.updated_at ?? ''),
    paidAt: (r.paidAt ?? r.paid_at ?? null) as string | null,
    pspTransactionId: (r.pspTransactionId ?? r.psp_transaction_id ?? null) as string | null,
    failureReason: (r.failureReason ?? r.failure_reason ?? null) as string | null,
  }))
}

/** Déclenche la vérification des relances d'échéance (canal plateforme uniquement). */
export async function checkExpirationReminders(): Promise<{
  ok: boolean
  reminders: Reminder[]
  count: number
}> {
  const response = await fetchWithSession('/api/billing/reminders/check', {
    method: 'POST',
  })
  const payload = await readJson(response)
  if (!response.ok) throw toError(response, payload, 'Impossible de vérifier les relances.')
  return {
    ok: Boolean(payload.ok),
    reminders: Array.isArray(payload.reminders) ? (payload.reminders as Reminder[]) : [],
    count: typeof payload.count === 'number' ? payload.count : 0,
  }
}
