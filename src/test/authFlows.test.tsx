import type { IncomingMessage, ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'
import { handleSalonApiRequest } from '../../server/apiHandler'
import { MIGRATIONS } from '../../server/migrations'
import {
  hashPasswordNode,
  verifyPasswordNode,
} from '../../server/authEngine'
import type { SqlClientLike, SqlPoolLike } from '../../server/neonClient'
import { AppRoutes } from '../app/router'
import { AuthProvider } from '../contexts/AuthProvider'
import { SalonProDatabase } from '../db/database'
import { SalonRepositoryHub } from '../db/repositories/salonRepositories'
import { SalonStoreProvider } from '../hooks/SalonStoreProvider'
import { ToastProvider } from '../hooks/ToastProvider'
import {
  hashPasswordPBKDF2,
  verifyPasswordPBKDF2,
} from '../utils/passwordCrypto'

function createAuthMemoryPool(): SqlPoolLike {
  const users = new Map<
    string,
    { updated_at: string; payload_json: unknown; tenant_id: string }
  >()
  // Sessions révocables (S4) — colonnes utilisées par server/sessions.ts
  const sessions = new Map<string, Record<string, unknown>>()

  const query = async <R = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount: number | null }> => {
    const norm = text.replace(/\s+/g, ' ').trim()
    if (
      norm.startsWith('CREATE TABLE') ||
      norm.startsWith('CREATE INDEX') ||
      norm === 'BEGIN' ||
      norm === 'COMMIT' ||
      norm === 'ROLLBACK'
    ) {
      return { rows: [], rowCount: 0 }
    }
    // Migrations considérées comme déjà appliquées dans ce simulateur ciblé
    // sur les flux d'authentification (le DDL n'est pas interprété).
    if (norm.startsWith('SELECT id FROM schema_migrations')) {
      const rows = MIGRATIONS.map((m) => ({ id: m.id })) as R[]
      return { rows, rowCount: rows.length }
    }
    if (norm.startsWith('INSERT INTO schema_migrations')) {
      return { rows: [], rowCount: 1 }
    }
    if (norm.startsWith('SELECT set_config')) {
      return { rows: [{}] as R[], rowCount: 1 }
    }
    if (
      norm.startsWith('INSERT INTO organizations') ||
      norm.startsWith('INSERT INTO tenants')
    ) {
      return { rows: [], rowCount: 1 }
    }
    if (/^SELECT payload_json(?:, tenant_id)? FROM salon_users/i.test(norm)) {
      const askedTenant = norm.includes('WHERE tenant_id = $1')
      const rows = Array.from(users.values())
        .filter((u) => !askedTenant || u.tenant_id === String(values[0]))
        .map((u) => ({
          payload_json: u.payload_json,
          tenant_id: u.tenant_id,
        })) as R[]
      return { rows, rowCount: rows.length }
    }
    if (norm.startsWith('SELECT payload_json FROM ')) {
      return { rows: [], rowCount: 0 }
    }
    if (norm.includes('FROM sync_tombstones')) {
      return { rows: [], rowCount: 0 }
    }
    if (norm.startsWith('INSERT INTO salon_users')) {
      const id = String(values[0])
      const updatedAt = String(values[9])
      const payload = JSON.parse(String(values[10]))
      const tenantId = values[11] ? String(values[11]) : 'default-tenant'
      users.set(id, {
        updated_at: updatedAt,
        payload_json: payload,
        tenant_id: tenantId,
      })
      return { rows: [], rowCount: 1 }
    }
    if (norm.startsWith('INSERT INTO sessions')) {
      const columns = norm
        .slice(
          norm.indexOf('(') + 1,
          norm.indexOf(')'),
        )
        .split(',')
        .map((c) => c.trim())
      const row: Record<string, unknown> = {}
      columns.forEach((column, index) => {
        row[column] = values[index] ?? null
      })
      sessions.set(String(row.id), row)
      return { rows: [], rowCount: 1 }
    }
    if (norm.includes('FROM sessions')) {
      const byId = norm.match(/WHERE id = \$1/)
      const wanted = byId
        ? String(values[0])
        : String(values.find((v) => typeof v === 'string' && v.length === 64) ?? '')
      const rows = Array.from(sessions.values()).filter((row) =>
        byId
          ? row.id === wanted
          : row.refresh_token_hash === wanted,
      )
      if (norm.startsWith('SELECT id ')) {
        const live = rows.filter(
          (row) =>
            !row.revoked_at &&
            Date.parse(String(row.expires_at)) > Date.now(),
        )
        return {
          rows: live.map((row) => ({ id: row.id })) as R[],
          rowCount: live.length,
        }
      }
      return {
        rows: rows.map((row) => ({ ...row })) as R[],
        rowCount: rows.length,
      }
    }
    if (norm.startsWith('UPDATE sessions')) {
      const revokedAt = String(values[1] ?? values[2] ?? new Date().toISOString())
      let rowCount = 0
      for (const row of sessions.values()) {
        const matchesHash =
          String(row.refresh_token_hash) === String(values[0])
        const matchesId = String(row.id) === String(values[0])
        if ((matchesHash || matchesId) && !row.revoked_at) {
          row.revoked_at = revokedAt
          row.revoked_reason = String(values[2] ?? values[3] ?? 'logout')
          rowCount += 1
        }
      }
      return { rows: [], rowCount }
    }
    throw new Error(`SQL non géré : ${norm}`)
  }

  return {
    query,
    async connect(): Promise<SqlClientLike> {
      return { query, release: () => {} }
    },
  }
}

async function callApi(params: {
  method: string
  url: string
  headers?: Record<string, string>
  body?: unknown
  pool: SqlPoolLike
  pin?: string
}) {
  const req = new EventEmitter() as IncomingMessage & { body?: unknown }
  req.method = params.method
  req.url = params.url
  req.headers = Object.fromEntries(
    Object.entries(params.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  )
  req.body = params.body

  let statusCode = 200
  let raw = ''
  const res = {
    get statusCode() {
      return statusCode
    },
    set statusCode(c: number) {
      statusCode = c
    },
    setHeader: () => res,
    end: (chunk?: string) => {
      if (chunk) raw += chunk
    },
  } as unknown as ServerResponse

  await handleSalonApiRequest(req, res, {
    poolOverride: params.pool,
    expectedPinOverride: params.pin ?? '',
    databaseUrlOverride: 'postgresql://user:pass@db.example.test/salondb',
  })

  return {
    statusCode,
    json: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
  }
}

describe('Inscription, Connexion Hybride & Contrôle d’accès par rôle (Gérant / Caissier)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  it('assure une compatibilité cryptographique PBKDF2-SHA256 à 100 % entre Node et WebCrypto', async () => {
    const serverHash = hashPasswordNode('SalonSecret2026!', 10_000)
    expect(await verifyPasswordPBKDF2('SalonSecret2026!', serverHash)).toBe(
      true,
    )
    expect(await verifyPasswordPBKDF2('MauvaisMotDePasse', serverHash)).toBe(
      false,
    )

    const browserHash = await hashPasswordPBKDF2('CoiffureAbidjan#1', 10_000)
    expect(verifyPasswordNode('CoiffureAbidjan#1', browserHash)).toBe(true)
    expect(verifyPasswordNode('Autre', browserHash)).toBe(false)
  })

  it('gère /api/auth/register, /api/auth/login et autorise /api/sync/verify via Bearer sessionToken', async () => {
    const pool = createAuthMemoryPool()

    // 1. Premier compte : Gérant créé sans code requis
    const regManager = await callApi({
      method: 'POST',
      url: '/api/auth/register',
      body: {
        fullName: 'Awa Koné',
        email: 'awa@salonprestige.ci',
        password: 'password123',
        role: 'manager',
      },
      pool,
    })
    expect(regManager.statusCode).toBe(201)
    expect(typeof regManager.json.sessionToken).toBe('string')

    // 2. Tentative d'inscription d'un Caissier sans autorisation Gérant -> 403
    const regCashierDenied = await callApi({
      method: 'POST',
      url: '/api/auth/register',
      body: {
        fullName: 'Marc Yao',
        email: 'marc@salonprestige.ci',
        password: 'password123',
        role: 'cashier',
      },
      pool,
    })
    expect(regCashierDenied.statusCode).toBe(403)
    expect(regCashierDenied.json.code).toBe('MANAGER_APPROVAL_REQUIRED')

    // 3. Inscription du Caissier par le Gérant authentifié (Bearer sessionToken) -> 201
    const managerToken = String(regManager.json.sessionToken)
    const regCashierOk = await callApi({
      method: 'POST',
      url: '/api/auth/register',
      headers: { Authorization: `Bearer ${managerToken}` },
      body: {
        fullName: 'Marc Yao',
        email: 'marc@salonprestige.ci',
        password: 'password123',
        role: 'cashier',
      },
      pool,
    })
    expect(regCashierOk.statusCode).toBe(201)

    // 4. Connexion avec mauvais mot de passe -> 401, puis bon mot de passe -> 200
    const badLogin = await callApi({
      method: 'POST',
      url: '/api/auth/login',
      body: { email: 'awa@salonprestige.ci', password: 'wrong' },
      pool,
    })
    expect(badLogin.statusCode).toBe(401)

    const goodLogin = await callApi({
      method: 'POST',
      url: '/api/auth/login',
      body: { email: 'awa@salonprestige.ci', password: 'password123' },
      pool,
    })
    expect(goodLogin.statusCode).toBe(200)
    const token = String(goodLogin.json.sessionToken)

    // 5. Le sessionToken signé donne accès à /api/sync/verify sans repasser le PIN
    const syncVerify = await callApi({
      method: 'POST',
      url: '/api/sync/verify',
      headers: { Authorization: `Bearer ${token}` },
      pool,
    })
    expect(syncVerify.statusCode).toBe(200)
    expect(syncVerify.json.connected).toBe(true)
  })

  it('redirige vers /login, permet l’inscription Gérant, la reconnexion et restreint les routes Caissier', async () => {
    const user = userEvent.setup()
    const repo = new SalonRepositoryHub(
      new SalonProDatabase(`AuthUITest_${crypto.randomUUID()}`),
    )
    await repo.ensureInitialized(false)

    const view = render(
      <ToastProvider>
        <SalonStoreProvider repository={repo}>
          <MemoryRouter initialEntries={['/dashboard']}>
            <AuthProvider>
              <AppRoutes />
            </AuthProvider>
          </MemoryRouter>
        </SalonStoreProvider>
      </ToastProvider>,
    )

    // Non connecté -> redirigé vers la page de Connexion
    expect(
      await screen.findByRole('heading', {
        name: /Connexion à votre espace/i,
      }),
    ).toBeInTheDocument()
    expect(
      await screen.findByText(/Première utilisation de SALON PRO/i),
    ).toBeInTheDocument()

    // Naviguer vers /register et créer le premier compte Gérant
    await user.click(
      screen.getByRole('link', { name: /Créer le compte Gérant/i }),
    )
    expect(
      await screen.findByRole('heading', {
        name: /Créer le compte Gérant/i,
      }),
    ).toBeInTheDocument()

    await user.type(screen.getByLabelText(/Nom complet/i), 'Awa Koné')
    const salonInput = screen.getByLabelText(/Nom du salon/i)
    await user.clear(salonInput)
    await user.type(salonInput, 'Prestige Cocody')
    await user.type(
      screen.getByLabelText(/Adresse e-mail/i),
      'awa@prestige.ci',
    )
    await user.type(screen.getByLabelText(/^Mot de passe$/i), 'secret123')
    await user.type(screen.getByLabelText(/Confirmation/i), 'secret123')
    await user.click(screen.getByRole('button', { name: /Créer le compte/i }))

    // Connectée en tant que Gérante -> Tableau de bord accessible + modules complets visibles
    expect(
      await screen.findByRole('heading', { name: /Tableau de bord/i }),
    ).toBeInTheDocument()
    expect(
      screen.getAllByRole('link', { name: /Salaires et commissions/i }).length,
    ).toBeGreaterThan(0)

    view.unmount()

    // Créer un compte Caissier et vérifier que /payroll redirige vers /cash et masque les liens sensibles
    window.localStorage.clear()
    window.sessionStorage.clear()
    await repo.registerLocalUserAccount({
      fullName: 'Marc Yao',
      email: 'marc@prestige.ci',
      password: 'cashier123',
      role: 'cashier',
      callerIsAuthenticatedManager: true,
    })

    render(
      <ToastProvider>
        <SalonStoreProvider repository={repo}>
          <MemoryRouter initialEntries={['/payroll']}>
            <AuthProvider>
              <AppRoutes />
            </AuthProvider>
          </MemoryRouter>
        </SalonStoreProvider>
      </ToastProvider>,
    )

    // Redirigé vers /login d'abord
    expect(
      await screen.findByRole('heading', {
        name: /Connexion à votre espace/i,
      }),
    ).toBeInTheDocument()

    await user.type(
      screen.getByLabelText(/Adresse e-mail/i),
      'marc@prestige.ci',
    )
    await user.type(screen.getByLabelText(/^Mot de passe$/i), 'cashier123')
    await user.click(screen.getByRole('button', { name: /Se connecter/i }))

    // Redirigé automatiquement vers /cash car /payroll est réservé au Gérant !
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /Gestion de caisse/i }),
      ).toBeInTheDocument()
    })
    expect(
      screen.queryByRole('link', { name: /Salaires et commissions/i }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: /Paramètres/i }),
    ).not.toBeInTheDocument()
  })

  it('supprime automatiquement toutes les données mocks résiduelles d’un compte réel existant tout en conservant les vraies données', async () => {
    const dbName = `RealAccountPolluted_${crypto.randomUUID()}`
    const pollutedDb = new SalonProDatabase(dbName)
    const nowIso = '2026-10-30T08:00:00.000Z'

    // Simule une base locale d'un compte réel créé avant la suppression des mocks
    await pollutedDb.salon.put({
      id: 'salon-main',
      name: 'Élégance Coiffure & Barber',
      address: 'Cocody Angré 8e Tranche — Abidjan',
      phone: '+225 07 08 44 55 66',
      managerName: 'Kouamé Koffi',
      currency: 'XOF',
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    await pollutedDb.users.put({
      id: 'usr-real-1',
      fullName: 'Erwins Gérant',
      email: 'erwins@mon-salon.ci',
      phone: '+225 01 02 03 04 05',
      role: 'manager',
      passwordHash: await hashPasswordPBKDF2('MonMotDePasse!', 10_000),
      isActive: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    })

    // Injection de données mocks (demo-* / isDemo: true / rec-tpl-*) + vraies écritures du compte réel
    await pollutedDb.services.bulkPut([
      {
        id: 'demo-srv-1',
        name: 'Coupe Homme Démo',
        categoryCode: 'coupe_barbe',
        referencePrice: 5_000,
        description: '',
        isActive: true,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        id: 'svc-1793337600000-real01',
        name: 'Coupe Signature Réelle',
        categoryCode: 'coupe_barbe',
        referencePrice: 8_000,
        description: 'Vraie prestation du salon',
        isActive: true,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ])
    await pollutedDb.revenues.bulkPut([
      Object.assign(
        {
          id: 'rev-legacy-flag',
          date: nowIso,
          label: 'Fausse recette héritée',
          categoryCode: 'hair_service',
          amount: 10_000,
          paymentMethod: 'cash' as const,
          sourceModule: 'revenue' as const,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        { isDemo: true },
      ),
      {
        id: 'rev-1793337600000-real01',
        date: nowIso,
        label: 'Encaissement réel client',
        categoryCode: 'hair_service',
        amount: 8_000,
        paymentMethod: 'wave',
        sourceModule: 'revenue',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ])
    await pollutedDb.recurringExpenses.bulkPut([
      {
        id: 'rec-tpl-cie',
        label: 'Électricité CIE',
        categoryCode: 'utilities',
        defaultAmount: 35_000,
        paymentMethod: 'orange_money',
        dayOfMonth: 10,
        isActive: true,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        id: 'rec-1793337600000-real01',
        label: 'Loyer réel du local',
        categoryCode: 'rent',
        defaultAmount: 120_000,
        paymentMethod: 'transfer',
        dayOfMonth: 5,
        isActive: true,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ])

    // Dès l'ouverture du repository sur ce compte réel existant, le nettoyage s'exécute automatiquement
    const repo = new SalonRepositoryHub(pollutedDb)
    const cleanState = await repo.readFullState()

    // 1. Toutes les données mocks ont disparu
    expect(cleanState.services.map((s) => s.id)).toEqual([
      'svc-1793337600000-real01',
    ])
    expect(cleanState.revenues.map((r) => r.id)).toEqual([
      'rev-1793337600000-real01',
    ])
    expect(cleanState.recurringExpenses.map((t) => t.id)).toEqual([
      'rec-1793337600000-real01',
    ])

    // 2. Les champs fictifs par défaut de salon-main ont été nettoyés avec les vraies infos du Gérant
    expect(cleanState.salon.name).toBe('')
    expect(cleanState.salon.address).toBe('')
    expect(cleanState.salon.managerName).toBe('Erwins Gérant')
    expect(cleanState.salon.phone).toBe('+225 01 02 03 04 05')

    // 3. Le compte réel de l'utilisateur est intact et opérationnel
    const authed = await repo.authenticateLocalUserAccount({
      email: 'erwins@mon-salon.ci',
      password: 'MonMotDePasse!',
    })
    expect(authed.fullName).toBe('Erwins Gérant')

    // 4. Persistance durable sur disque (simulation de fermeture d'onglet puis réouverture d'une nouvelle instance DB)
    pollutedDb.close()
    const reopenedDb = new SalonProDatabase(dbName)
    const reopenedRepo = new SalonRepositoryHub(reopenedDb)
    const reopenedEnvelope = await reopenedRepo.buildCloudSyncEnvelope()

    expect(reopenedEnvelope.payload.services.map((s) => s.id)).toEqual([
      'svc-1793337600000-real01',
    ])
    expect(reopenedEnvelope.payload.revenues.map((r) => r.id)).toEqual([
      'rev-1793337600000-real01',
    ])
    expect(reopenedEnvelope.payload.recurringExpenses?.map((t) => t.id)).toEqual(
      ['rec-1793337600000-real01'],
    )
    expect(reopenedEnvelope.payload.settings.dataHygieneVersion).toBe(2)
    expect(
      reopenedEnvelope.tombstones.map(
        (tb) => `${tb.entityType}:${tb.entityId}`,
      ),
    ).toEqual(
      expect.arrayContaining([
        'service:demo-srv-1',
        'revenue:rev-legacy-flag',
        'recurring_expense:rec-tpl-cie',
      ]),
    )
  })

  it('affiche les comptes enregistrés sur l’appareil sur /login et permet la connexion par nom complet, téléphone ou e-mail', async () => {
    const user = userEvent.setup()
    const repo = new SalonRepositoryHub(
      new SalonProDatabase(`AuthPickerTest_${crypto.randomUUID()}`),
    )
    await repo.ensureInitialized(false)

    await repo.registerLocalUserAccount({
      fullName: 'Billy Sess',
      email: 'billy.sess@salon.ci',
      phone: '+225 07 11 22 33 44',
      password: 'MonSecret2026',
      role: 'manager',
    })

    // Vérifier aussi la connexion par téléphone directement via le repository
    const byPhone = await repo.authenticateLocalUserAccount({
      email: '0711223344',
      password: 'MonSecret2026',
    })
    expect(byPhone.fullName).toBe('Billy Sess')

    window.localStorage.clear()
    window.sessionStorage.clear()

    const view = render(
      <ToastProvider>
        <SalonStoreProvider repository={repo}>
          <MemoryRouter initialEntries={['/login']}>
            <AuthProvider>
              <AppRoutes />
            </AuthProvider>
          </MemoryRouter>
        </SalonStoreProvider>
      </ToastProvider>,
    )

    // Le sélecteur affiche automatiquement le compte local enregistré sur l'appareil
    expect(
      await screen.findByText(/Comptes enregistrés sur cet appareil/i),
    ).toBeInTheDocument()
    expect(screen.getByText('Billy Sess')).toBeInTheDocument()

    // Connexion en saisissant directement le nom en minuscules "billy sess" (sans @)
    const idInput = screen.getByLabelText(/Adresse e-mail, nom ou téléphone/i)
    await user.clear(idInput)
    await user.type(idInput, 'billy sess')
    await user.type(screen.getByLabelText(/^Mot de passe$/i), 'MonSecret2026')
    await user.click(screen.getByRole('button', { name: /Se connecter/i }))

    expect(
      await screen.findByRole('heading', { name: /Tableau de bord/i }),
    ).toBeInTheDocument()

    // Le bouton "Changer de compte" dans le pied de barre latérale permet de revenir en 1 clic au sélecteur
    await user.click(screen.getByRole('button', { name: /Changer de compte/i }))
    const accountCard = await screen.findByRole('button', {
      name: /Billy Sess/i,
    })
    await user.click(accountCard)
    expect(
      screen.getByLabelText(/Adresse e-mail, nom ou téléphone/i),
    ).toHaveValue('Billy Sess')

    view.unmount()
  })
})
