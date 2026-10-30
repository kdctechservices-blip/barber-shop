import { readStoredSessionTokens } from './sessionClient'

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
