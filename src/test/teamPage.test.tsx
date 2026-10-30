import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '../contexts/authContext'
import { TeamPage } from '../features/team/TeamPage'
import { ToastProvider } from '../hooks/ToastProvider'
import { AUTH_TOKEN_SESSION_KEY, clearStoredSessionTokens } from '../lib/sessionClient'
import type { PublicSalonUser } from '../domain/models'

/**
 * Écran « Équipe et abonnement » (Sprint 8) : rendu des collaborateurs, état de
 * l'offre et messages d'erreur de limite. Le réseau est simulé au niveau
 * `fetch` — aucune donnée de démonstration n'est injectée dans l'application.
 */

const MANAGER: PublicSalonUser = {
  id: 'usr-manager',
  fullName: 'Gérant Test',
  email: 'gerant@salon.ci',
  role: 'manager',
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const PLAN = {
  code: 'professional',
  name: 'Professional',
  priceFcfa: 9_900,
  maxSalons: 2,
  maxEmployees: 25,
  maxDevices: 10,
  features: ['caisse'],
  requiresPayment: true,
}

const SUBSCRIPTION = {
  plan: PLAN,
  planCode: 'professional',
  status: 'active',
  isExpired: false,
  daysRemaining: 12,
  pendingPlanCode: null,
  usage: { members: 2, salons: 1 },
  limits: { members: 25, salons: 2, devices: 10 },
  subscription: {
    orgId: 'org-1',
    planCode: 'professional',
    pendingPlanCode: null,
    status: 'active',
    trialEndsAt: null,
    currentPeriodStart: '2026-10-01T00:00:00.000Z',
    currentPeriodEnd: '2026-11-01T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
}

const MEMBERS = [
  {
    id: 'usr-manager',
    fullName: 'Gérant Test',
    email: 'gerant@salon.ci',
    role: 'manager',
    isActive: true,
  },
  {
    id: 'usr-cashier',
    fullName: 'Awa Koné',
    email: 'awa@salon.ci',
    role: 'cashier',
    isActive: false,
  },
]

type Handler = (body: unknown) => { status: number; payload: unknown }

function stubServer(overrides: Record<string, Handler> = {}): void {
  const routes: Record<string, { status: number; payload: unknown }> = {
    '/api/users': { status: 200, payload: { ok: true, users: MEMBERS } },
    '/api/billing/subscription': { status: 200, payload: { ok: true, ...SUBSCRIPTION } },
    '/api/billing/plans': {
      status: 200,
      payload: {
        ok: true,
        plans: [PLAN],
        currency: 'FCFA',
        defaultPlan: 'decouverte',
        trialPlan: 'professional',
        trialDays: 14,
        graceDays: 7,
        billingPeriodDays: 30,
      },
    },
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      const override = overrides[url]
      const result = override
        ? override(body)
        : (routes[url] ?? { status: 404, payload: { ok: false, code: 'NOT_FOUND' } })
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        json: async () => result.payload,
      }
    }),
  )
}

function authValue(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    authEnforced: true,
    authReady: true,
    hasAnyManager: true,
    authMode: 'cloud_neon',
    currentUser: MANAGER,
    localAccounts: [],
    sessionToken: 'jeton-test',
    tenants: [
      {
        tenantId: 'tenant-a',
        name: 'Salon A',
        slug: 'salon-a',
        role: 'manager',
        isActive: true,
      },
    ],
    activeTenantId: 'tenant-a',
    refreshTenants: async () => {},
    switchTenant: async () => {},
    refreshAuthStatus: async () => {},
    login: async () => MANAGER,
    register: async () => MANAGER,
    logout: () => {},
    ...overrides,
  }
}

function renderTeam(value: AuthContextValue = authValue()) {
  return render(
    <ToastProvider>
      <AuthContext.Provider value={value}>
        <TeamPage />
      </AuthContext.Provider>
    </ToastProvider>,
  )
}

describe('Écran Équipe et abonnement', () => {
  beforeEach(() => {
    window.sessionStorage.setItem(AUTH_TOKEN_SESSION_KEY, 'jeton-test')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearStoredSessionTokens()
  })

  it('affiche les collaborateurs, l’offre en cours et la consommation', async () => {
    stubServer()
    renderTeam()

    await waitFor(() => {
      expect(screen.getByText('Awa Koné')).toBeInTheDocument()
    })
    expect(screen.getByText('gerant@salon.ci')).toBeInTheDocument()
    expect(screen.getAllByText(/Professional/).length).toBeGreaterThan(0)
    // « Actif » apparaît pour l'état d'abonnement et pour le compte Gérant.
    expect(screen.getAllByText('Actif').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Désactivé')).toBeInTheDocument()
    expect(screen.getByText('2 / 25')).toBeInTheDocument()
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    expect(screen.getByText('Collaborateurs (2)')).toBeInTheDocument()
  })

  it('explique le refus d’ajout lorsque la limite de membres est atteinte', async () => {
    stubServer({
      '/api/auth/register': () => ({
        status: 402,
        payload: {
          ok: false,
          code: 'PLAN_LIMIT_REACHED',
          message:
            "L'offre Découverte est limitée à 3 membre(s) actif(s) par salon.",
        },
      }),
    })
    const user = userEvent.setup()
    renderTeam()

    await waitFor(() => {
      expect(screen.getByText('Collaborateurs (2)')).toBeInTheDocument()
    })

    await user.click(
      screen.getByRole('button', { name: /Ajouter un collaborateur/i }),
    )
    await user.type(screen.getByLabelText(/Nom complet/i), 'Koffi Yao')
    await user.type(screen.getByLabelText(/^E-mail$/i), 'koffi@salon.ci')
    await user.type(
      screen.getByLabelText(/Mot de passe initial/i),
      'MotDePasse123',
    )
    await user.click(screen.getByRole('button', { name: /^Ajouter$/ }))

    await waitFor(() => {
      expect(
        screen.getByText(/Passez à une offre supérieure/i),
      ).toBeInTheDocument()
    })
  })

  it('limite le salon à ses propres données en mode local (hors-ligne)', async () => {
    stubServer()
    renderTeam(
      authValue({
        authMode: 'local_offline',
        sessionToken: null,
        tenants: [],
        activeTenantId: null,
        localAccounts: [MANAGER],
      }),
    )

    expect(screen.getByText('Gérant Test')).toBeInTheDocument()
    expect(
      screen.getByText(/nécessitent la synchronisation Neon/i),
    ).toBeInTheDocument()
    // Aucun appel réseau n'est déclenché hors mode cloud.
    expect(fetch).not.toHaveBeenCalled()
  })
})
