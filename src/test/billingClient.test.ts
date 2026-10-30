import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BillingApiError,
  cancelSubscription,
  fetchPlanCatalog,
  fetchSubscription,
  subscribeToPlan,
} from '../lib/billingClient'

/**
 * Client navigateur de facturation : URL relatives (le proxy serveur s'occupe
 * du backend), propagation du code d'erreur et aucun moyen de paiement simulé.
 */

interface FetchCall {
  url: string
  method: string
  body?: unknown
}

function stubFetch(
  payload: unknown,
  status = 200,
): { calls: FetchCall[] } {
  const calls: FetchCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
      }
    }),
  )
  return { calls }
}

describe('Client de facturation (navigateur)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lit le catalogue d’offres via une URL relative', async () => {
    const { calls } = stubFetch({
      ok: true,
      plans: [{ code: 'professional', name: 'Professional', priceFcfa: 9_900 }],
      currency: 'FCFA',
      trialDays: 14,
    })
    const catalog = await fetchPlanCatalog()
    expect(calls[0].url).toBe('/api/billing/plans')
    expect(calls[0].method).toBe('GET')
    expect(catalog.plans[0].code).toBe('professional')
    expect(catalog.trialDays).toBe(14)
  })

  it('souscrit une offre en POST et remonte la mise en attente de paiement', async () => {
    const { calls } = stubFetch({
      ok: true,
      applied: false,
      message: 'Offre Starter en attente de paiement (4900 FCFA / mois).',
      status: 'pending_payment',
      pendingPlanCode: 'starter',
    })
    const outcome = await subscribeToPlan('starter')
    expect(calls[0].url).toBe('/api/billing/subscribe')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body).toEqual({ planCode: 'starter' })
    expect(outcome.applied).toBe(false)
    expect(outcome.pendingPlanCode).toBe('starter')
  })

  it('convertit une limite d’offre (402) en erreur typée', async () => {
    stubFetch(
      {
        ok: false,
        code: 'PLAN_LIMIT_REACHED',
        message: "L'offre Découverte est limitée à 3 membre(s) actif(s) par salon.",
      },
      402,
    )
    await expect(fetchSubscription()).rejects.toBeInstanceOf(BillingApiError)
    await expect(fetchSubscription()).rejects.toMatchObject({
      status: 402,
      code: 'PLAN_LIMIT_REACHED',
    })
  })

  it('résilie en POST sans corps de requête', async () => {
    const { calls } = stubFetch({ ok: true, status: 'active' })
    await cancelSubscription()
    expect(calls[0].url).toBe('/api/billing/cancel')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body).toBeUndefined()
  })
})
