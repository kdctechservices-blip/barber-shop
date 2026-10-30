import { randomUUID } from 'node:crypto'
import type { SqlPoolLike, SqlQueryable } from './neonClient.ts'
import {
  BILLING_PERIOD_DAYS,
  DEFAULT_PLAN_CODE,
  TRIAL_PLAN_CODE,
  PAST_DUE_GRACE_DAYS,
  PLAN_CATALOG,
  TRIAL_DAYS,
  isPlanCode,
  type PlanCode,
  type PlanDefinition,
} from './plans.ts'

/**
 * Abonnements par organisation (IMPLEMENTATIONS.md — phase « Monétisable »).
 *
 * L'abonnement est porté par l'**organisation** (qui possède un ou plusieurs
 * salons) : c'est l'unité de facturation du modèle retenu en D1.
 *
 * Le cycle de vie est calculé **à la lecture** (`effectivePlan`) : aucun
 * ordonnanceur n'est nécessaire pour qu'un abonnement échu retombe sur l'offre
 * Découverte après sa période de grâce.
 *
 * Ces tables ne portent pas de politique RLS : elles sont lues par
 * l'organisation (via `org_id`, déduit du salon authentifié) et non par salon.
 * Toutes les requêtes filtrent explicitement `org_id`.
 */

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'pending_payment'
  | 'past_due'
  | 'cancelled'

export interface Subscription {
  orgId: string
  planCode: PlanCode
  pendingPlanCode: PlanCode | null
  status: SubscriptionStatus
  trialEndsAt: string | null
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  updatedBy: string | null
  createdAt: string
  updatedAt: string
}

export interface EffectivePlan {
  plan: PlanDefinition
  /** Offre effectivement appliquée (peut différer de l'offre souscrite). */
  planCode: PlanCode
  status: SubscriptionStatus
  /** L'abonnement a dépassé son échéance (grâce en cours ou terminée). */
  isExpired: boolean
  /** Jours restants avant échéance (négatif si dépassée). */
  daysRemaining: number
  /** Offre en attente d'activation (paiement non confirmé). */
  pendingPlanCode: PlanCode | null
}

interface SubscriptionRow {
  org_id: string
  plan_code: string
  pending_plan_code: string | null
  status: string
  trial_ends_at: string | Date | null
  current_period_start: string | Date | null
  current_period_end: string | Date | null
  cancel_at_period_end: boolean
  updated_by: string | null
  created_at: string | Date
  updated_at: string | Date
}

function toIso(value: string | Date | null): string | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

function toSubscription(row: SubscriptionRow): Subscription {
  return {
    orgId: row.org_id,
    planCode: isPlanCode(row.plan_code) ? row.plan_code : DEFAULT_PLAN_CODE,
    pendingPlanCode: isPlanCode(row.pending_plan_code)
      ? row.pending_plan_code
      : null,
    status: (row.status as SubscriptionStatus) ?? 'trialing',
    trialEndsAt: toIso(row.trial_ends_at),
    currentPeriodStart: toIso(row.current_period_start),
    currentPeriodEnd: toIso(row.current_period_end),
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
    updatedBy: row.updated_by,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

function addDays(from: Date, days: number): string {
  return new Date(from.getTime() + days * DAY_MS).toISOString()
}

/** Organisation propriétaire d'un salon. */
export async function getOrgIdForTenant(
  db: SqlQueryable,
  tenantId: string,
): Promise<string | null> {
  const res = await db.query<{ org_id: string }>(
    'SELECT org_id FROM tenants WHERE id = $1',
    [tenantId],
  )
  return res.rows[0]?.org_id ?? null
}

/**
 * Lit l'abonnement d'une organisation, en le créant au besoin (essai offert).
 * Idempotent : deux appels concurrents ne créent qu'une ligne.
 */
export async function getOrCreateSubscription(
  pool: SqlPoolLike,
  orgId: string,
  options?: { now?: Date },
): Promise<Subscription> {
  const now = options?.now ?? new Date()
  const existing = await pool.query<SubscriptionRow>(
    `SELECT org_id, plan_code, pending_plan_code, status, trial_ends_at,
            current_period_start, current_period_end, cancel_at_period_end,
            updated_by, created_at, updated_at
       FROM subscriptions
      WHERE org_id = $1`,
    [orgId],
  )
  if (existing.rows[0]) return toSubscription(existing.rows[0])

  const trialEndsAt = addDays(now, TRIAL_DAYS)
  await pool.query(
    `INSERT INTO subscriptions (org_id, plan_code, status, trial_ends_at, created_at, updated_at)
     VALUES ($1, $2, 'trialing', $3, $4, $4)
     ON CONFLICT (org_id) DO NOTHING`,
    [orgId, TRIAL_PLAN_CODE, trialEndsAt, now.toISOString()],
  )

  const created = await pool.query<SubscriptionRow>(
    `SELECT org_id, plan_code, pending_plan_code, status, trial_ends_at,
            current_period_start, current_period_end, cancel_at_period_end,
            updated_by, created_at, updated_at
       FROM subscriptions
      WHERE org_id = $1`,
    [orgId],
  )
  const row = created.rows[0]
  if (!row) {
    throw new Error("Impossible d'initialiser l'abonnement de l'organisation.")
  }
  return toSubscription(row)
}

/** Abonnement du salon authentifié (créé s'il n'existe pas). */
export async function getSubscriptionForTenant(
  pool: SqlPoolLike,
  tenantId: string,
): Promise<{ orgId: string; subscription: Subscription }> {
  const orgId = await getOrgIdForTenant(pool, tenantId)
  if (!orgId) {
    throw new Error("Ce salon n'est rattaché à aucune organisation.")
  }
  return { orgId, subscription: await getOrCreateSubscription(pool, orgId) }
}

/**
 * Offre réellement applicable maintenant.
 *
 * - `trialing` : l'offre souscrite s'applique jusqu'à la fin de l'essai ;
 * - `active` : l'offre s'applique jusqu'à la fin de la période, puis passe en
 *   `past_due` (grâce de 7 jours), puis retombe sur Découverte ;
 * - `pending_payment` / `cancelled` : l'offre **souscrite** n'est pas appliquée,
 *   l'offre Découverte l'est (les limites restent donc celles du gratuit).
 */
export function effectivePlan(
  subscription: Subscription,
  now: Date = new Date(),
): EffectivePlan {
  const dateAt = (value: string | null): number | null =>
    value ? Date.parse(value) : null
  const effective = (code: PlanCode, status: SubscriptionStatus, until: string | null, isExpired: boolean): EffectivePlan => {
    const end = dateAt(until)
    return {
      plan: PLAN_CATALOG[code],
      planCode: code,
      status,
      isExpired,
      daysRemaining: end === null ? 0 : Math.ceil((end - now.getTime()) / DAY_MS),
      pendingPlanCode: subscription.pendingPlanCode,
    }
  }

  if (subscription.status === 'cancelled' || subscription.cancelAtPeriodEnd) {
    const periodEnd = dateAt(subscription.currentPeriodEnd)
    // Résiliation programmée : l'offre payée reste effective jusqu'à l'échéance.
    if (periodEnd !== null && periodEnd > now.getTime()) {
      return effective(
        subscription.planCode,
        subscription.status,
        subscription.currentPeriodEnd,
        false,
      )
    }
    if (subscription.status === 'cancelled') {
      return effective(DEFAULT_PLAN_CODE, 'cancelled', null, true)
    }
  }

  if (subscription.status === 'pending_payment') {
    // L'offre payante n'est active qu'après confirmation du paiement.
    const trialEnd = dateAt(subscription.trialEndsAt)
    const trialOver = trialEnd !== null && trialEnd <= now.getTime()
    return effective(
      DEFAULT_PLAN_CODE,
      'pending_payment',
      subscription.trialEndsAt,
      trialOver,
    )
  }

  if (subscription.status === 'trialing') {
    const trialEnd = dateAt(subscription.trialEndsAt)
    if (trialEnd === null || trialEnd > now.getTime()) {
      return effective(
        subscription.planCode,
        'trialing',
        subscription.trialEndsAt,
        false,
      )
    }
    return effective(DEFAULT_PLAN_CODE, 'past_due', subscription.trialEndsAt, true)
  }

  // active / past_due
  const periodEnd = dateAt(subscription.currentPeriodEnd)
  if (periodEnd === null) {
    return effective(subscription.planCode, 'active', null, false)
  }
  if (periodEnd > now.getTime()) {
    return effective(subscription.planCode, 'active', subscription.currentPeriodEnd, false)
  }
  const graceEnd = periodEnd + PAST_DUE_GRACE_DAYS * DAY_MS
  if (graceEnd > now.getTime()) {
    return effective(
      subscription.planCode,
      'past_due',
      new Date(graceEnd).toISOString(),
      true,
    )
  }
  return effective(DEFAULT_PLAN_CODE, 'past_due', subscription.currentPeriodEnd, true)
}

async function recordEvent(
  db: SqlQueryable,
  input: {
    orgId: string
    event: string
    fromPlan?: PlanCode | null
    toPlan?: PlanCode | null
    actorId?: string | null
    payload?: unknown
    now: Date
  },
): Promise<void> {
  await db.query(
    `INSERT INTO subscription_events (id, org_id, event, from_plan, to_plan, actor_id, payload_json, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      randomUUID(),
      input.orgId,
      input.event,
      input.fromPlan ?? null,
      input.toPlan ?? null,
      input.actorId ?? null,
      input.payload === undefined ? null : JSON.stringify(input.payload),
      input.now.toISOString(),
    ],
  )
}

export interface PlanChangeResult {
  subscription: Subscription
  /** `true` si l'offre est appliquée immédiatement, `false` si paiement requis. */
  applied: boolean
  message: string
}

/**
 * Demande de changement d'offre.
 *
 * Une offre gratuite s'applique immédiatement ; une offre payante passe en
 * `pending_payment` : elle ne s'appliquera qu'après confirmation d'un paiement
 * par le canal plateforme (`activateSubscription`). Aucun moyen de paiement
 * n'est simulé.
 */
export async function requestPlanChange(
  pool: SqlPoolLike,
  input: {
    orgId: string
    planCode: PlanCode
    actorId: string
    now?: Date
  },
): Promise<PlanChangeResult> {
  const now = input.now ?? new Date()
  const current = await getOrCreateSubscription(pool, input.orgId, { now })
  const target = PLAN_CATALOG[input.planCode]

  if (current.planCode === input.planCode && current.status === 'active') {
    return {
      subscription: current,
      applied: true,
      message: `Votre abonnement ${target.name} est déjà actif.`,
    }
  }

  if (!target.requiresPayment) {
    const updatedAt = now.toISOString()
    await pool.query(
      `UPDATE subscriptions
          SET plan_code = $2, pending_plan_code = NULL, status = 'active',
              current_period_start = $3, current_period_end = NULL,
              updated_by = $4, updated_at = $3
        WHERE org_id = $1`,
      [input.orgId, input.planCode, updatedAt, input.actorId],
    )
    await recordEvent(pool, {
      orgId: input.orgId,
      event: 'plan_changed',
      fromPlan: current.planCode,
      toPlan: input.planCode,
      actorId: input.actorId,
      now,
    })
    const subscription = await getOrCreateSubscription(pool, input.orgId, { now })
    return {
      subscription,
      applied: true,
      message: `Offre ${target.name} activée.`,
    }
  }

  const updatedAt = now.toISOString()
  await pool.query(
    `UPDATE subscriptions
        SET pending_plan_code = $2, status = 'pending_payment',
            updated_by = $3, updated_at = $4
      WHERE org_id = $1`,
    [input.orgId, input.planCode, input.actorId, updatedAt],
  )
  await recordEvent(pool, {
    orgId: input.orgId,
    event: 'plan_requested',
    fromPlan: current.planCode,
    toPlan: input.planCode,
    actorId: input.actorId,
    payload: { priceFcfa: target.priceFcfa },
    now,
  })
  const subscription = await getOrCreateSubscription(pool, input.orgId, { now })
  return {
    subscription,
    applied: false,
    message: `Offre ${target.name} en attente de paiement (${target.priceFcfa ?? 0} FCFA / mois).`,
  }
}

/**
 * Activation d'une offre après encaissement — canal plateforme uniquement
 * (secret serveur). Ouvre une période de facturation de 30 jours par mois payé.
 */
export async function activateSubscription(
  pool: SqlPoolLike,
  input: {
    orgId: string
    planCode?: PlanCode
    months?: number
    actorId?: string
    reference?: string
    now?: Date
  },
): Promise<Subscription> {
  const now = input.now ?? new Date()
  const current = await getOrCreateSubscription(pool, input.orgId, { now })
  const planCode = input.planCode ?? current.pendingPlanCode ?? current.planCode
  const months = Math.min(Math.max(Math.round(input.months ?? 1), 1), 24)
  const periodEnd = addDays(now, BILLING_PERIOD_DAYS * months)

  await pool.query(
    `UPDATE subscriptions
        SET plan_code = $2, pending_plan_code = NULL, status = 'active',
            current_period_start = $3, current_period_end = $4,
            cancel_at_period_end = false, updated_by = $5, updated_at = $3
      WHERE org_id = $1`,
    [input.orgId, planCode, now.toISOString(), periodEnd, input.actorId ?? null],
  )
  await recordEvent(pool, {
    orgId: input.orgId,
    event: 'plan_activated',
    fromPlan: current.planCode,
    toPlan: planCode,
    actorId: input.actorId ?? 'platform',
    payload: { months, reference: input.reference ?? null, periodEnd },
    now,
  })

  return getOrCreateSubscription(pool, input.orgId, { now })
}

/**
 * Résolution d'organisation puis activation : point d'entrée du canal
 * plateforme, qui peut cibler soit l'organisation, soit l'un de ses salons.
 */
export async function activateSubscriptionForOrg(
  pool: SqlPoolLike,
  input: {
    orgId?: string | null
    tenantId?: string | null
    planCode?: PlanCode
    months?: number
    reference?: string
    now?: Date
  },
): Promise<{ orgId: string; subscription: Subscription; plan: TenantPlanContext }> {
  const orgId =
    (input.orgId ? input.orgId.trim() : '') ||
    (input.tenantId
      ? ((await getOrgIdForTenant(pool, input.tenantId.trim())) ?? '')
      : '')
  if (!orgId) {
    throw new Error(
      "Organisation introuvable : impossible d'activer un abonnement.",
    )
  }
  const subscription = await activateSubscription(pool, {
    orgId,
    planCode: input.planCode,
    months: input.months,
    actorId: 'platform',
    reference: input.reference,
    now: input.now,
  })
  const tenantId = input.tenantId?.trim() || (await firstTenantOfOrg(pool, orgId))
  const usage = tenantId
    ? await readPlanUsage(pool, { tenantId, orgId })
    : { members: 0, salons: await countOrgSalons(pool, orgId) }
  return {
    orgId,
    subscription,
    plan: {
      orgId,
      subscription,
      effective: effectivePlan(subscription, input.now),
      ...usage,
    },
  }
}

/** Premier salon d'une organisation (cible par défaut des activations). */
async function firstTenantOfOrg(
  db: SqlQueryable,
  orgId: string,
): Promise<string | null> {
  const res = await db.query<{ id: string }>(
    'SELECT id FROM tenants WHERE org_id = $1 ORDER BY created_at LIMIT 1',
    [orgId],
  )
  return res.rows[0]?.id ?? null
}

/** Résiliation : l'offre reste active jusqu'à la fin de la période payée. */
export async function cancelSubscription(
  pool: SqlPoolLike,
  input: { orgId: string; actorId: string; now?: Date },
): Promise<Subscription> {
  const now = input.now ?? new Date()
  const current = await getOrCreateSubscription(pool, input.orgId, { now })
  // Une période payée en cours continue de courir : la résiliation ne coupe
  // l'accès qu'à son échéance.
  const periodEnd = current.currentPeriodEnd
    ? Date.parse(current.currentPeriodEnd)
    : Number.NaN
  const stillPaid = Number.isFinite(periodEnd) && periodEnd > now.getTime()
  await pool.query(
    `UPDATE subscriptions
        SET cancel_at_period_end = true, status = $2,
            updated_by = $3, updated_at = $4
      WHERE org_id = $1`,
    [
      input.orgId,
      stillPaid ? 'active' : ('cancelled' as SubscriptionStatus),
      input.actorId,
      now.toISOString(),
    ],
  )
  await recordEvent(pool, {
    orgId: input.orgId,
    event: 'plan_cancelled',
    fromPlan: current.planCode,
    actorId: input.actorId,
    now,
  })
  return getOrCreateSubscription(pool, input.orgId, { now })
}

/** Nombre de membres actifs d'un salon (base des limites d'effectif). */
export async function countTenantMembers(
  db: SqlQueryable,
  tenantId: string,
): Promise<number> {
  const res = await db.query<{ count: string | number }>(
    'SELECT COUNT(*) AS count FROM memberships WHERE tenant_id = $1 AND is_active = true',
    [tenantId],
  )
  return Number(res.rows[0]?.count ?? 0)
}

/** Nombre de salons d'une organisation (base de la limite multi-salons). */
export async function countOrgSalons(
  db: SqlQueryable,
  orgId: string,
): Promise<number> {
  const res = await db.query<{ count: string | number }>(
    'SELECT COUNT(*) AS count FROM tenants WHERE org_id = $1',
    [orgId],
  )
  return Number(res.rows[0]?.count ?? 0)
}

export interface PlanUsage {
  members: number
  salons: number
}

export async function readPlanUsage(
  db: SqlQueryable,
  input: { tenantId: string; orgId: string },
): Promise<PlanUsage> {
  return {
    members: await countTenantMembers(db, input.tenantId),
    salons: await countOrgSalons(db, input.orgId),
  }
}

export interface TenantPlanContext extends PlanUsage {
  orgId: string
  subscription: Subscription
  effective: EffectivePlan
}

/**
 * Contexte de facturation complet d'un salon (organisation, abonnement, offre
 * effective, consommation). Point d'entrée unique pour les gardes de limites.
 */
export async function readTenantPlan(
  pool: SqlPoolLike,
  tenantId: string,
  options?: { now?: Date },
): Promise<TenantPlanContext> {
  const orgId = await getOrgIdForTenant(pool, tenantId)
  if (!orgId) {
    throw new Error("Ce salon n'est rattaché à aucune organisation.")
  }
  const now = options?.now ?? new Date()
  const subscription = await getOrCreateSubscription(pool, orgId, { now })
  const usage = await readPlanUsage(pool, { tenantId, orgId })
  return {
    orgId,
    subscription,
    effective: effectivePlan(subscription, now),
    ...usage,
  }
}

/**
 * Vérifie qu'une offre autorise un effectif supplémentaire.
 * `incoming` = nombre de comptes que l'opération s'apprête à créer.
 */
export function assertEmployeeCapacity(
  plan: PlanDefinition,
  usage: PlanUsage,
  incoming: number,
): void {
  const limit = plan.maxEmployees
  if (limit === null) return
  if (usage.members + incoming <= limit) return
  throw new PlanLimitError(
    `L'offre ${plan.name} est limitée à ${limit} membre(s) actif(s) par salon. ` +
      `Passez à une offre supérieure pour en ajouter.`,
    { limit, used: usage.members, requested: incoming },
  )
}

export class PlanLimitError extends Error {
  readonly code = 'PLAN_LIMIT_REACHED'
  readonly status = 402
  readonly details: { limit: number; used: number; requested: number }

  constructor(
    message: string,
    details: { limit: number; used: number; requested: number },
  ) {
    super(message)
    this.name = 'PlanLimitError'
    this.details = details
  }
}
