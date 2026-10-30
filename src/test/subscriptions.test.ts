import { beforeEach, describe, expect, it } from 'vitest'
import { hashPasswordNode } from '../../server/authEngine'
import { resetAllRateLimits } from '../../server/rateLimiter'
import {
  DEFAULT_PLAN_CODE,
  PLAN_CATALOG,
  PLAN_ORDER,
  TRIAL_DAYS,
  isPlanCode,
  planCatalogPublic,
} from '../../server/plans'
import {
  effectivePlan,
  type Subscription,
  type SubscriptionStatus,
} from '../../server/subscriptions'
import type { SalonUserAccount } from '../domain/models'
import {
  createInMemoryNeonPool,
  invokeApi,
  seedMembership,
  seedSubscription,
} from './helpers/neonTestHarness'

/**
 * Abonnements par organisation et limites d'offre (P1 — phase « Monétisable »).
 *
 * - une organisation démarre avec 14 jours d'essai de l'offre Professional ;
 * - une offre payante ne s'applique qu'après activation par le canal
 *   plateforme (aucun paiement n'est simulé) ;
 * - les limites d'effectif/salons sont calculées à la lecture, donc une
 *   échéance dépassée fait retomber l'organisation sur Découverte sans
 *   ordonnanceur.
 */

const TEST_PIN = 'test-sync-secret'
const PASSWORD = 'MotDePasse123'
const DAY_MS = 24 * 60 * 60 * 1000

function subscriptionFixture(overrides: Partial<Subscription> = {}): Subscription {
  const now = Date.now()
  return {
    orgId: 'org-test',
    planCode: 'professional',
    pendingPlanCode: null,
    status: 'active' as SubscriptionStatus,
    trialEndsAt: null,
    currentPeriodStart: new Date(now - 5 * DAY_MS).toISOString(),
    currentPeriodEnd: new Date(now + 25 * DAY_MS).toISOString(),
    cancelAtPeriodEnd: false,
    updatedBy: null,
    createdAt: new Date(now - 5 * DAY_MS).toISOString(),
    updatedAt: new Date(now).toISOString(),
    ...overrides,
  }
}

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

async function registerManager(
  pool: ReturnType<typeof createInMemoryNeonPool>['pool'],
) {
  const res = await invokeApi({
    method: 'POST',
    url: '/api/auth/register',
    body: {
      fullName: 'Gérant Abonnement',
      email: 'gerant.abonnement@salon.ci',
      password: PASSWORD,
      role: 'manager',
      salonName: 'Salon Abonnement',
    },
    poolOverride: pool,
    expectedPinOverride: TEST_PIN,
  })
  expect(res.statusCode).toBe(201)
  return res.json as unknown as {
    sessionToken: string
    tenantId: string
    user: { id: string; role: string }
  }
}

function buildProvisionedAccount(index: number): SalonUserAccount {
  const now = new Date().toISOString()
  return {
    id: `usr-plan-00${index}`,
    fullName: `Collaborateur ${index}`,
    email: `collaborateur${index}@salon.ci`,
    role: 'cashier',
    passwordHash: hashPasswordNode(PASSWORD),
    isActive: true,
    createdAt: now,
    updatedAt: now,
  }
}

describe('Catalogue des offres', () => {
  it('expose les cinq offres dans l’ordre commercial, avec les prix du cahier des charges', () => {
    const plans = planCatalogPublic()
    expect(plans).toHaveLength(5)
    expect(plans.map((plan) => plan.code)).toEqual(PLAN_ORDER)
    expect(PLAN_CATALOG.decouverte.priceFcfa).toBe(0)
    expect(PLAN_CATALOG.professional.priceFcfa).toBe(9_900)
    expect(PLAN_CATALOG.business.priceFcfa).toBe(19_900)
    expect(PLAN_CATALOG.enterprise.priceFcfa).toBeNull()
    expect(PLAN_CATALOG.decouverte.requiresPayment).toBe(false)
    expect(PLAN_CATALOG.starter.requiresPayment).toBe(true)
    // `null` = illimité, jamais zéro.
    expect(PLAN_CATALOG.business.maxEmployees).toBeNull()
    expect(PLAN_CATALOG.decouverte.maxEmployees).toBe(3)
    expect(isPlanCode('professional')).toBe(true)
    expect(isPlanCode('platinum')).toBe(false)
    expect(isPlanCode(undefined)).toBe(false)
  })
})

describe('Cycle de vie d’un abonnement (calcul à la lecture)', () => {
  it('applique l’offre d’essai puis retombe sur Découverte après 14 jours', () => {
    const trialEndsAt = new Date(Date.now() + 10 * DAY_MS).toISOString()
    const duringTrial = effectivePlan(
      subscriptionFixture({ status: 'trialing', trialEndsAt }),
    )
    expect(duringTrial.planCode).toBe('professional')
    expect(duringTrial.status).toBe('trialing')
    expect(duringTrial.isExpired).toBe(false)
    expect(duringTrial.daysRemaining).toBeGreaterThan(9)

    const expiredTrial = effectivePlan(
      subscriptionFixture({
        status: 'trialing',
        trialEndsAt: new Date(Date.now() - DAY_MS).toISOString(),
      }),
    )
    expect(expiredTrial.planCode).toBe(DEFAULT_PLAN_CODE)
    expect(expiredTrial.isExpired).toBe(true)
    expect(expiredTrial.plan.maxEmployees).toBe(PLAN_CATALOG.decouverte.maxEmployees)
    expect(TRIAL_DAYS).toBe(14)
  })

  it('accorde 7 jours de grâce après échéance avant de revenir à Découverte', () => {
    const inGrace = effectivePlan(
      subscriptionFixture({
        currentPeriodEnd: new Date(Date.now() - 3 * DAY_MS).toISOString(),
      }),
    )
    expect(inGrace.status).toBe('past_due')
    expect(inGrace.planCode).toBe('professional')
    expect(inGrace.isExpired).toBe(true)

    const longExpired = effectivePlan(
      subscriptionFixture({
        currentPeriodEnd: new Date(Date.now() - 30 * DAY_MS).toISOString(),
      }),
    )
    expect(longExpired.planCode).toBe(DEFAULT_PLAN_CODE)
    expect(longExpired.plan.maxSalons).toBe(1)
  })

  it('n’applique pas une offre payante en attente de paiement', () => {
    const pending = effectivePlan(
      subscriptionFixture({
        planCode: 'business',
        pendingPlanCode: 'business',
        status: 'pending_payment',
        trialEndsAt: new Date(Date.now() - DAY_MS).toISOString(),
      }),
    )
    expect(pending.planCode).toBe(DEFAULT_PLAN_CODE)
    expect(pending.pendingPlanCode).toBe('business')
    expect(pending.plan.maxEmployees).toBe(3)
  })

  it('conserve l’offre payée jusqu’à l’échéance après résiliation', () => {
    const cancelled = effectivePlan(
      subscriptionFixture({
        planCode: 'starter',
        cancelAtPeriodEnd: true,
        status: 'cancelled',
        currentPeriodEnd: new Date(Date.now() + 12 * DAY_MS).toISOString(),
      }),
    )
    expect(cancelled.planCode).toBe('starter')
    expect(cancelled.daysRemaining).toBeGreaterThan(10)
  })
})

describe('Facturation par API (P1)', () => {
  beforeEach(() => {
    resetAllRateLimits()
  })

  it('sert le catalogue publiquement, sans session ni code serveur', async () => {
    const { pool } = createInMemoryNeonPool()
    const res = await invokeApi({
      method: 'GET',
      url: '/api/billing/plans',
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(res.statusCode).toBe(200)
    expect((res.json.plans as unknown[]).length).toBe(5)
    expect(res.json.trialDays).toBe(TRIAL_DAYS)
    expect(res.json.currency).toBe('FCFA')
  })

  it('ouvre un essai Professional à l’inscription et expose l’abonnement du salon', async () => {
    const { pool, tables } = createInMemoryNeonPool()
    const registered = await registerManager(pool)

    const tenantRow = tables.get('tenants')?.values().next().value as
      | { org_id?: string }
      | undefined
    const orgId = String(tenantRow?.org_id ?? '')
    expect(orgId).not.toBe('')

    const res = await invokeApi({
      method: 'GET',
      url: '/api/billing/subscription',
      headers: authHeader(registered.sessionToken),
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json.status).toBe('trialing')
    expect(res.json.planCode).toBe('professional')
    expect((res.json.limits as { members: number }).members).toBe(
      PLAN_CATALOG.professional.maxEmployees,
    )
    expect((res.json.usage as { members: number }).members).toBe(1)
    const subscription = res.json.subscription as { orgId: string }
    expect(subscription.orgId).toBe(orgId)

    const anonymous = await invokeApi({
      method: 'GET',
      url: '/api/billing/subscription',
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(anonymous.statusCode).toBe(401)
    expect(anonymous.json.code).toBe('SESSION_REQUIRED')
  })

  it('place une offre payante en attente de paiement, puis l’active par le canal plateforme', async () => {
    const { pool } = createInMemoryNeonPool()
    const registered = await registerManager(pool)

    const requested = await invokeApi({
      method: 'POST',
      url: '/api/billing/subscribe',
      headers: authHeader(registered.sessionToken),
      body: { planCode: 'starter' },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(requested.statusCode).toBe(202)
    expect(requested.json.applied).toBe(false)
    expect(requested.json.status).toBe('pending_payment')
    expect(requested.json.pendingPlanCode).toBe('starter')
    // Tant que le paiement n'est pas confirmé, les limites restent celles du gratuit.
    expect(requested.json.planCode).toBe(DEFAULT_PLAN_CODE)
    expect((requested.json.limits as { members: number }).members).toBe(
      PLAN_CATALOG.decouverte.maxEmployees,
    )

    // Un client ne peut pas s'auto-activer, même avec sa session.
    const selfActivation = await invokeApi({
      method: 'POST',
      url: '/api/billing/activate',
      headers: authHeader(registered.sessionToken),
      body: { tenantId: registered.tenantId, planCode: 'starter' },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(selfActivation.statusCode).toBe(403)
    expect(selfActivation.json.code).toBe('PLATFORM_SECRET_REQUIRED')

    const activated = await invokeApi({
      method: 'POST',
      url: '/api/billing/activate',
      headers: { 'x-salon-pin': TEST_PIN },
      body: { tenantId: registered.tenantId, planCode: 'starter', months: 2 },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(activated.statusCode).toBe(200)
    expect(activated.json.planCode).toBe('starter')
    expect(activated.json.status).toBe('active')
    expect(activated.json.pendingPlanCode).toBeNull()
    const periodEnd = Date.parse(
      String((activated.json.subscription as { currentPeriodEnd: string }).currentPeriodEnd),
    )
    expect(periodEnd - Date.now()).toBeGreaterThan(58 * DAY_MS)

    const invalidPlan = await invokeApi({
      method: 'POST',
      url: '/api/billing/subscribe',
      headers: authHeader(registered.sessionToken),
      body: { planCode: 'platinum' },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(invalidPlan.statusCode).toBe(400)
    expect(invalidPlan.json.code).toBe('INVALID_PLAN')
  })

  it('réserve la gestion de l’abonnement au Gérant et programme la résiliation', async () => {
    const { pool } = createInMemoryNeonPool()
    const registered = await registerManager(pool)

    await invokeApi({
      method: 'POST',
      url: '/api/billing/activate',
      headers: { 'x-salon-pin': TEST_PIN },
      body: { tenantId: registered.tenantId, planCode: 'professional', months: 1 },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })

    const cashier = await invokeApi({
      method: 'POST',
      url: '/api/auth/register',
      headers: authHeader(registered.sessionToken),
      body: {
        fullName: 'Caissier Abonnement',
        email: 'caissier.abonnement@salon.ci',
        password: PASSWORD,
        role: 'cashier',
      },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(cashier.statusCode).toBe(201)
    const cashierToken = String(cashier.json.sessionToken)

    const forbidden = await invokeApi({
      method: 'POST',
      url: '/api/billing/cancel',
      headers: authHeader(cashierToken),
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json.code).toBe('MANAGER_ROLE_REQUIRED')

    const cancelled = await invokeApi({
      method: 'POST',
      url: '/api/billing/cancel',
      headers: authHeader(registered.sessionToken),
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(cancelled.statusCode).toBe(200)
    const subscription = cancelled.json.subscription as {
      cancelAtPeriodEnd: boolean
    }
    expect(subscription.cancelAtPeriodEnd).toBe(true)
    // La période payée continue de courir : l'offre n'est pas coupée net.
    expect(cancelled.json.planCode).toBe('professional')
    expect(cancelled.json.isExpired).toBe(false)
  })

  it('refuse un membre au-delà de la limite d’effectif de l’offre (402)', async () => {
    const { pool, tables } = createInMemoryNeonPool()
    const registered = await registerManager(pool)
    const tenantRow = tables.get('tenants')?.values().next().value as
      | { org_id?: string }
      | undefined
    // Offre Découverte active : 3 membres maximum, sans perspective d'essai.
    await seedSubscription(pool, {
      orgId: String(tenantRow?.org_id ?? ''),
      planCode: 'decouverte',
      status: 'active',
      currentPeriodEnd: null,
    })
    await seedMembership(pool, {
      tenantId: registered.tenantId,
      userId: 'usr-plan-saturation-1',
      role: 'cashier',
    })
    await seedMembership(pool, {
      tenantId: registered.tenantId,
      userId: 'usr-plan-saturation-2',
      role: 'cashier',
    })

    const overflow = await invokeApi({
      method: 'POST',
      url: '/api/auth/register',
      headers: authHeader(registered.sessionToken),
      body: {
        fullName: 'Trop de monde',
        email: 'trop.de.monde@salon.ci',
        password: PASSWORD,
        role: 'cashier',
      },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(overflow.statusCode).toBe(402)
    expect(overflow.json.code).toBe('PLAN_LIMIT_REACHED')
    expect(String(overflow.json.message)).toContain('Découverte')
  })

  it('plafonne la synchronisation de comptes hors-ligne au quota de l’offre', async () => {
    const { pool, tables } = createInMemoryNeonPool()
    const registered = await registerManager(pool)
    const tenantRow = tables.get('tenants')?.values().next().value as
      | { org_id?: string }
      | undefined
    await seedSubscription(pool, {
      orgId: String(tenantRow?.org_id ?? ''),
      planCode: 'decouverte',
      status: 'active',
      currentPeriodEnd: null,
    })

    const res = await invokeApi({
      method: 'POST',
      url: '/api/users/provision',
      headers: authHeader(registered.sessionToken),
      body: {
        accounts: [1, 2, 3, 4, 5].map((index) => buildProvisionedAccount(index)),
      },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(res.statusCode).toBe(200)
    // 1 Gérant déjà présent + 3 membres maximum : 2 créations, 3 refusées.
    expect(res.json.created).toBe(2)
    expect(res.json.blockedByPlan).toBe(3)
    expect(tables.get('memberships')?.size).toBe(3)
  })
})
