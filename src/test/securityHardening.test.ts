import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  hashPasswordNode,
  signAuthSessionToken,
  verifyPasswordNode,
} from '../../server/authEngine'
import { resetAllRateLimits } from '../../server/rateLimiter'
import { stripUsersFromSyncPayload } from '../../server/syncEngine'
import type { SalonBackupPayload, SalonUserAccount } from '../domain/models'
import { SalonProDatabase } from '../db/database'
import { SalonRepositoryHub } from '../db/repositories/salonRepositories'
import { createInMemoryNeonPool, invokeApi } from './helpers/neonTestHarness'

const TEST_PIN = 'test-sync-secret'
const MANAGER = { id: 'usr-manager-001', email: 'gerant@salon.ci', role: 'manager' as const }
const CASHIER = { id: 'usr-cashier-001', email: 'caissier@salon.ci', role: 'cashier' as const }

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

function managerToken(): string {
  return signAuthSessionToken(MANAGER, TEST_PIN)
}

function cashierToken(): string {
  return signAuthSessionToken(CASHIER, TEST_PIN)
}

function buildAccount(overrides: Partial<SalonUserAccount> = {}): SalonUserAccount {
  const now = new Date().toISOString()
  return {
    id: 'usr-provisioned-001',
    fullName: 'Awa Koné',
    email: 'awa@salon.ci',
    phone: '+225 07 00 00 00',
    role: 'cashier',
    passwordHash: hashPasswordNode('MotDePasse123'),
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function buildBasePayload(): SalonBackupPayload {
  const now = new Date().toISOString()
  return {
    format: 'SALON_PRO_BACKUP_V1',
    exportedAt: now,
    salon: {
      id: 'salon-main',
      name: 'Salon Test',
      address: 'Abidjan',
      phone: '',
      managerName: 'Gérant Test',
      currency: 'XOF',
      createdAt: now,
      updatedAt: now,
    },
    settings: {
      id: 'default',
      theme: 'light',
      dateFormat: 'long-fr',
      printHeaderNote: '',
      printCompact: false,
      updatedAt: now,
    },
    categories: [],
    services: [],
    employees: [],
    revenues: [],
    expenses: [],
    cashSessions: [],
    cashMovements: [],
    advances: [],
    bonuses: [],
    salaryPayments: [],
    products: [],
    stockMovements: [],
    budgets: [],
    recurringExpenses: [],
    correctionLogs: [],
  }
}

describe('Sécurité — escalade de privilèges impossible via la synchronisation', () => {
  beforeEach(() => {
    resetAllRateLimits()
  })

  it('ignore tout compte injecté dans un payload de synchronisation et ne le renvoie jamais', async () => {
    const { pool, tables } = createInMemoryNeonPool()
    const payload = buildBasePayload()
    const forgedManager = buildAccount({
      id: 'usr-evil-001',
      email: 'pirate@salon.ci',
      role: 'manager',
    })

    const res = await invokeApi({
      method: 'POST',
      url: '/api/sync',
      headers: { 'x-salon-pin': TEST_PIN },
      body: { payload: { ...payload, users: [forgedManager] }, tombstones: [] },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })

    expect(res.statusCode).toBe(200)
    // Aucun compte n'a été créé côté Cloud…
    expect(tables.get('salon_users')?.size ?? 0).toBe(0)
    // …et aucun compte n'est renvoyé au client.
    const returnedPayload = res.json.payload as Record<string, unknown>
    expect(returnedPayload).toBeTruthy()
    expect('users' in returnedPayload).toBe(false)
  })

  it('stripUsersFromSyncPayload est pure et signale la présence de comptes', () => {
    const payload = buildBasePayload()
    const clean = stripUsersFromSyncPayload(payload)
    expect(clean.hadUsers).toBe(false)
    expect(clean.payload).toBe(payload)

    const withUsers = stripUsersFromSyncPayload({
      ...payload,
      users: [buildAccount()],
    })
    expect(withUsers.hadUsers).toBe(true)
    expect('users' in withUsers.payload).toBe(false)
    expect(withUsers.payload).toEqual(payload)
  })

  it("l'enveloppe de synchronisation du client exclut les comptes et les achemine par le provisionnement dédié", async () => {
    const db = new SalonProDatabase(`SecEnvelope_${crypto.randomUUID()}`)
    const repo = new SalonRepositoryHub(db)
    await repo.ensureInitialized()
    await repo.registerLocalUserAccount({
      fullName: 'Gérant Local',
      email: 'local@salon.ci',
      password: 'MotDePasse123',
      role: 'manager',
    })

    const envelope = await repo.buildCloudSyncEnvelope()
    expect('users' in envelope.payload).toBe(false)

    const provisioning = await repo.buildUserProvisioningEnvelope()
    expect(provisioning.accounts).toHaveLength(1)
    expect(provisioning.accounts[0].passwordHash).toMatch(
      /^pbkdf2_sha256\$\d+\$[0-9a-f]{32}\$[0-9a-f]{64}$/,
    )

    // Une fusion Cloud ne doit jamais installer un compte distant.
    await repo.mergeCloudSyncResult({
      payload: {
        ...envelope.payload,
        users: [
          buildAccount({ id: 'usr-remote-evil', email: 'remote@pirate.ci', role: 'manager' }),
        ],
      },
    })
    const accounts = await repo.listUserAccounts()
    expect(accounts.map((a) => a.id)).not.toContain('usr-remote-evil')
  })
})

describe('Sécurité — administration des comptes réservée au Gérant', () => {
  beforeEach(() => {
    resetAllRateLimits()
  })

  it('refuse /api/users sans session, puis refuse un Caissier', async () => {
    const { pool } = createInMemoryNeonPool()

    const anonymous = await invokeApi({
      method: 'GET',
      url: '/api/users',
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(anonymous.statusCode).toBe(401)
    expect(anonymous.json.code).toBe('SESSION_REQUIRED')

    const cashier = await invokeApi({
      method: 'POST',
      url: '/api/users/provision',
      headers: authHeader(cashierToken()),
      body: { accounts: [buildAccount()] },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(cashier.statusCode).toBe(403)
    expect(cashier.json.code).toBe('MANAGER_ROLE_REQUIRED')

    const anonymousPatch = await invokeApi({
      method: 'PATCH',
      url: '/api/users/usr-provisioned-001',
      body: { role: 'manager' },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(anonymousPatch.statusCode).toBe(401)
  })

  it('provisionne un compte hors-ligne, puis refuse toute réécriture de rôle ou de hash', async () => {
    const { pool, tables } = createInMemoryNeonPool()
    const account = buildAccount()

    const first = await invokeApi({
      method: 'POST',
      url: '/api/users/provision',
      headers: authHeader(managerToken()),
      body: { accounts: [account] },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(first.statusCode).toBe(200)
    expect(first.json.created).toBe(1)
    expect(tables.get('salon_users')?.size).toBe(1)

    // Tentative d'escalade : même identifiant, rôle Gérant, hash d'attaquant.
    const second = await invokeApi({
      method: 'POST',
      url: '/api/users/provision',
      headers: authHeader(managerToken()),
      body: {
        accounts: [
          {
            ...account,
            role: 'manager',
            passwordHash: hashPasswordNode('Pirate123'),
            updatedAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
        ],
      },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(second.statusCode).toBe(200)
    expect(second.json.skipped).toBe(1)
    expect(second.json.created).toBe(0)

    const stored = tables.get('salon_users')?.get(account.id)
      ?.payload_json as SalonUserAccount
    expect(stored.role).toBe('cashier')
    expect(verifyPasswordNode('MotDePasse123', stored.passwordHash)).toBe(true)
    expect(verifyPasswordNode('Pirate123', stored.passwordHash)).toBe(false)
  })

  it('rejette les comptes structurellement invalides (hash falsifié, rôle inconnu)', async () => {
    const { pool, tables } = createInMemoryNeonPool()
    const res = await invokeApi({
      method: 'POST',
      url: '/api/users/provision',
      headers: authHeader(managerToken()),
      body: {
        accounts: [
          { ...buildAccount(), passwordHash: 'mot-de-passe-en-clair' },
          { ...buildAccount({ id: 'usr-role-002' }), role: 'super-admin' },
        ],
      },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json.invalid).toBe(2)
    expect(tables.get('salon_users')?.size ?? 0).toBe(0)
  })

  it('liste les comptes sans jamais exposer les hashes de mots de passe', async () => {
    const { pool } = createInMemoryNeonPool()
    await invokeApi({
      method: 'POST',
      url: '/api/users/provision',
      headers: authHeader(managerToken()),
      body: { accounts: [buildAccount()] },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })

    const list = await invokeApi({
      method: 'GET',
      url: '/api/users',
      headers: authHeader(managerToken()),
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(list.statusCode).toBe(200)
    const users = list.json.users as Array<Record<string, unknown>>
    expect(users).toHaveLength(1)
    expect(users[0].email).toBe('awa@salon.ci')
    expect('passwordHash' in users[0]).toBe(false)
    expect(JSON.stringify(list.json)).not.toContain('pbkdf2_sha256')
  })

  it('protège le dernier Gérant actif et hache côté serveur tout nouveau mot de passe', async () => {
    const { pool, tables } = createInMemoryNeonPool()
    const manager = buildAccount({
      id: 'usr-manager-777',
      email: 'bigboss@salon.ci',
      fullName: 'Grand Patron',
      role: 'manager',
      passwordHash: hashPasswordNode('PremierPass1'),
    })

    await invokeApi({
      method: 'POST',
      url: '/api/users/provision',
      headers: authHeader(managerToken()),
      body: { accounts: [manager] },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })

    const demote = await invokeApi({
      method: 'PATCH',
      url: `/api/users/${manager.id}`,
      headers: authHeader(managerToken()),
      body: { role: 'cashier' },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(demote.statusCode).toBe(409)
    expect(demote.json.code).toBe('LAST_MANAGER_REQUIRED')

    const deactivate = await invokeApi({
      method: 'PATCH',
      url: `/api/users/${manager.id}`,
      headers: authHeader(managerToken()),
      body: { isActive: false },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(deactivate.statusCode).toBe(409)
    expect(['CANNOT_DEACTIVATE_SELF', 'LAST_MANAGER_REQUIRED']).toContain(
      deactivate.json.code,
    )

    const weak = await invokeApi({
      method: 'PATCH',
      url: `/api/users/${manager.id}`,
      headers: authHeader(managerToken()),
      body: { password: 'court1' },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(weak.statusCode).toBe(400)
    expect(weak.json.code).toBe('WEAK_PASSWORD')

    const strong = await invokeApi({
      method: 'PATCH',
      url: `/api/users/${manager.id}`,
      headers: authHeader(managerToken()),
      body: { password: 'NouveauPass2026' },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(strong.statusCode).toBe(200)

    const stored = tables.get('salon_users')?.get(manager.id)
      ?.payload_json as SalonUserAccount
    expect(stored.passwordHash).toMatch(/^pbkdf2_sha256\$/)
    expect(verifyPasswordNode('NouveauPass2026', stored.passwordHash)).toBe(true)
    expect(verifyPasswordNode('PremierPass1', stored.passwordHash)).toBe(false)
  })
})

describe('Sécurité — authentification et politique de mot de passe', () => {
  beforeEach(() => {
    resetAllRateLimits()
  })

  it('applique la politique de mot de passe à l’inscription', async () => {
    const { pool } = createInMemoryNeonPool()

    const tooShort = await invokeApi({
      method: 'POST',
      url: '/api/auth/register',
      body: {
        fullName: 'Awa Koné',
        email: 'awa@salon.ci',
        password: 'abcdefg',
      },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(tooShort.statusCode).toBe(400)
    expect(tooShort.json.code).toBe('WEAK_PASSWORD')

    const withoutDigit = await invokeApi({
      method: 'POST',
      url: '/api/auth/register',
      body: {
        fullName: 'Awa Koné',
        email: 'awa2@salon.ci',
        password: 'abcdefgh',
      },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(withoutDigit.statusCode).toBe(400)
    expect(withoutDigit.json.code).toBe('WEAK_PASSWORD')

    const valid = await invokeApi({
      method: 'POST',
      url: '/api/auth/register',
      body: {
        fullName: 'Awa Koné',
        email: 'awa3@salon.ci',
        password: 'abcdefg1',
      },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(valid.statusCode).toBe(201)
    expect(typeof valid.json.sessionToken).toBe('string')
  })

  it('bloque le bruteforce après 5 tentatives et libère le compteur après succès', async () => {
    const { pool } = createInMemoryNeonPool()
    const account = buildAccount({
      id: 'usr-login-001',
      email: 'login@salon.ci',
      passwordHash: hashPasswordNode('MotDePasse123'),
    })
    await invokeApi({
      method: 'POST',
      url: '/api/users/provision',
      headers: authHeader(managerToken()),
      body: { accounts: [account] },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const failed = await invokeApi({
        method: 'POST',
        url: '/api/auth/login',
        body: { email: 'login@salon.ci', password: 'MauvaisPass1' },
        poolOverride: pool,
        expectedPinOverride: TEST_PIN,
      })
      expect(failed.statusCode).toBe(401)
    }

    const success = await invokeApi({
      method: 'POST',
      url: '/api/auth/login',
      body: { email: 'login@salon.ci', password: 'MotDePasse123' },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(success.statusCode).toBe(200)

    // Le compteur a été remis à zéro : 4 échecs supplémentaires restent tolérés.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const failed = await invokeApi({
        method: 'POST',
        url: '/api/auth/login',
        body: { email: 'login@salon.ci', password: 'MauvaisPass1' },
        poolOverride: pool,
        expectedPinOverride: TEST_PIN,
      })
      expect(failed.statusCode).toBe(401)
    }

    // 5e échec de la nouvelle fenêtre → blocage au coup suivant.
    const fifth = await invokeApi({
      method: 'POST',
      url: '/api/auth/login',
      body: { email: 'login@salon.ci', password: 'MauvaisPass1' },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(fifth.statusCode).toBe(401)

    const blocked = await invokeApi({
      method: 'POST',
      url: '/api/auth/login',
      body: { email: 'login@salon.ci', password: 'MotDePasse123' },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json.code).toBe('TOO_MANY_ATTEMPTS')
    expect(Number(blocked.json.retryAfterSeconds)).toBeGreaterThan(0)
  })
})

describe('Sécurité — secret de signature obligatoire en production', () => {
  const previousNodeEnv = process.env.NODE_ENV
  const previousSecret = process.env.SALON_AUTH_SECRET
  const previousVercel = process.env.VERCEL

  afterEach(() => {
    process.env.NODE_ENV = previousNodeEnv
    if (previousSecret === undefined) delete process.env.SALON_AUTH_SECRET
    else process.env.SALON_AUTH_SECRET = previousSecret
    if (previousVercel === undefined) delete process.env.VERCEL
    else process.env.VERCEL = previousVercel
  })

  it('refuse de signer un jeton si SALON_AUTH_SECRET est absent en production', () => {
    delete process.env.SALON_AUTH_SECRET
    delete process.env.VERCEL
    process.env.NODE_ENV = 'production'

    expect(() =>
      signAuthSessionToken({ id: 'usr-x', email: 'x@salon.ci', role: 'manager' }),
    ).toThrow(/SALON_AUTH_SECRET/)
  })

  it('accepte une signature valide en production lorsque le secret est fourni', () => {
    process.env.NODE_ENV = 'production'
    process.env.SALON_AUTH_SECRET = 'a'.repeat(64)
    const token = signAuthSessionToken({
      id: 'usr-x',
      email: 'x@salon.ci',
      role: 'manager',
    })
    expect(token.startsWith('s1.')).toBe(true)
  })
})
