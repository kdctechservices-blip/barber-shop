import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTH_TOKEN_SESSION_KEY,
  clearStoredSessionTokens,
} from '../lib/sessionClient'
import {
  TeamApiError,
  addTeamMember,
  fetchTeamMembers,
  fetchTenantMemberships,
  switchActiveTenant,
  updateTeamMember,
} from '../lib/teamClient'

/**
 * Client équipe : URL relatives, jeton de session courant, propagation des
 * codes d'erreur serveur (dont la limite d'offre 402).
 */

interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

function stubFetch(payload: unknown, status = 200): { calls: FetchCall[] } {
  const calls: FetchCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
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

describe('Client équipe et salons', () => {
  beforeEach(() => {
    window.sessionStorage.setItem(AUTH_TOKEN_SESSION_KEY, 'jeton-test')
  })

  it('liste les comptes du salon avec le jeton de session', async () => {
    const { calls } = stubFetch({
      ok: true,
      users: [
        {
          id: 'usr-1',
          fullName: 'Awa Koné',
          email: 'awa@salon.ci',
          role: 'cashier',
          isActive: true,
        },
      ],
    })
    const members = await fetchTeamMembers()
    expect(calls[0].url).toBe('/api/users')
    expect(calls[0].headers.Authorization).toBe('Bearer jeton-test')
    expect(members).toHaveLength(1)
    expect(members[0].role).toBe('cashier')
    clearStoredSessionTokens()
  })

  it('ajoute un collaborateur en POST sans jamais calculer de hash côté navigateur', async () => {
    const { calls } = stubFetch({
      ok: true,
      user: {
        id: 'usr-2',
        fullName: 'Koffi Yao',
        email: 'koffi@salon.ci',
        role: 'cashier',
        isActive: true,
      },
    })
    const created = await addTeamMember({
      fullName: 'Koffi Yao',
      email: 'koffi@salon.ci',
      password: 'MotDePasse123',
      role: 'cashier',
    })
    expect(calls[0].url).toBe('/api/auth/register')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body).toMatchObject({
      email: 'koffi@salon.ci',
      role: 'cashier',
    })
    expect(created.id).toBe('usr-2')
    clearStoredSessionTokens()
  })

  it('remonte la limite d’offre (402) en erreur typée', async () => {
    stubFetch(
      {
        ok: false,
        code: 'PLAN_LIMIT_REACHED',
        message:
          "L'offre Découverte est limitée à 3 membre(s) actif(s) par salon.",
      },
      402,
    )
    await expect(
      addTeamMember({
        fullName: 'Un de trop',
        email: 'trop@salon.ci',
        password: 'MotDePasse123',
        role: 'cashier',
      }),
    ).rejects.toMatchObject({
      name: 'TeamApiError',
      status: 402,
      code: 'PLAN_LIMIT_REACHED',
    } satisfies Partial<TeamApiError>)
    clearStoredSessionTokens()
  })

  it('met à jour le rôle d’un membre via PATCH', async () => {
    const { calls } = stubFetch({
      ok: true,
      user: {
        id: 'usr-2',
        fullName: 'Koffi Yao',
        email: 'koffi@salon.ci',
        role: 'manager',
        isActive: true,
      },
    })
    const updated = await updateTeamMember('usr-2', { role: 'manager' })
    expect(calls[0].url).toBe('/api/users/usr-2')
    expect(calls[0].method).toBe('PATCH')
    expect(calls[0].body).toEqual({ role: 'manager' })
    expect(updated.role).toBe('manager')
    clearStoredSessionTokens()
  })

  it('liste les salons du compte et bascule la session', async () => {
    stubFetch({
      ok: true,
      activeTenantId: 'tenant-a',
      tenants: [
        { tenantId: 'tenant-a', name: 'Salon A', role: 'manager', isActive: true },
        { tenantId: 'tenant-b', name: 'Salon B', role: 'cashier', isActive: true },
      ],
    })
    const memberships = await fetchTenantMemberships()
    expect(memberships.activeTenantId).toBe('tenant-a')
    expect(memberships.tenants).toHaveLength(2)

    const { calls } = stubFetch({
      ok: true,
      sessionToken: 'nouveau-jeton',
      refreshToken: 'nouveau-refresh',
      tenantId: 'tenant-b',
      user: {
        id: 'usr-1',
        fullName: 'Awa Koné',
        email: 'awa@salon.ci',
        role: 'cashier',
        isActive: true,
      },
    })
    const switched = await switchActiveTenant('tenant-b')
    expect(calls[0].url).toBe('/api/auth/switch-tenant')
    expect(calls[0].body).toEqual({ tenantId: 'tenant-b' })
    expect(switched.sessionToken).toBe('nouveau-jeton')
    expect(switched.user.role).toBe('cashier')
    clearStoredSessionTokens()
  })
})
