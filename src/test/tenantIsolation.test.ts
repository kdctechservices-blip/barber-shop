import { describe, expect, it } from 'vitest'
import { hashPasswordNode, signAuthSessionToken } from '../../server/authEngine'
import { resetAllRateLimits } from '../../server/rateLimiter'
import { DEFAULT_TENANT_ID } from '../../server/tenantContext'
import type { SalonBackupPayload, SalonUserAccount } from '../domain/models'
import {
  createInMemoryNeonPool,
  invokeApi,
  seedMembership,
} from './helpers/neonTestHarness'

/**
 * Isolation multi-salon (audit §6.1 S2 / P0-2).
 *
 * Le salon d'appartenance ne provient QUE du jeton de session signé (`tid`) ou
 * de la configuration serveur — jamais d'un en-tête ou du corps de la requête.
 * Ces tests vérifient qu'aucune donnée ne traverse la frontière entre salons.
 */

const TEST_PIN = 'test-sync-secret'
const TENANT_A = '11111111-1111-4111-8111-111111111111'
const TENANT_B = '22222222-2222-4222-8222-222222222222'

function tokenFor(tenantId: string, role: 'manager' | 'cashier' = 'manager'): string {
  return signAuthSessionToken(
    {
      id: `usr-${role}-${tenantId.slice(0, 4)}`,
      email: `${role}-${tenantId.slice(0, 4)}@salon.ci`,
      role,
    },
    TEST_PIN,
    tenantId,
  )
}

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

function buildPayload(salonName: string, revenueId: string): SalonBackupPayload {
  const now = new Date().toISOString()
  return {
    format: 'SALON_PRO_BACKUP_V1',
    exportedAt: now,
    salon: {
      id: 'salon-main',
      name: salonName,
      address: 'Abidjan',
      phone: '',
      managerName: salonName,
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
    revenues: [
      {
        id: revenueId,
        date: now,
        label: `Prestation ${salonName}`,
        amount: 15_000,
        paymentMethod: 'cash',
        employeeId: null,
        serviceId: null,
        isCancelled: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
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
  } as unknown as SalonBackupPayload
}

/** Enregistre l'acteur comme Gérant du salon (les jetons sont forgés ici). */
async function seedManager(
  pool: ReturnType<typeof createInMemoryNeonPool>['pool'],
  tenantId: string,
  role: 'manager' | 'cashier' = 'manager',
): Promise<void> {
  await seedMembership(pool, {
    tenantId,
    userId: `usr-${role}-${tenantId.slice(0, 4)}`,
    role,
  })
}

function buildAccount(overrides: Partial<SalonUserAccount> = {}): SalonUserAccount {
  const now = new Date().toISOString()
  return {
    id: 'usr-cashier-a-001',
    fullName: 'Awa Koné',
    email: 'awa@salon.ci',
    role: 'cashier',
    passwordHash: hashPasswordNode('MotDePasse123'),
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('Isolation multi-salon — le tenant ne vient jamais du client', () => {
  it('sépare les données synchronisées par salon (lecture comme écriture)', async () => {
    resetAllRateLimits()
    const { pool } = createInMemoryNeonPool()
    const tokenA = tokenFor(TENANT_A)
    const tokenB = tokenFor(TENANT_B)

    const pushA = await invokeApi({
      method: 'POST',
      url: '/api/sync',
      headers: authHeader(tokenA),
      body: { payload: buildPayload('Salon A', 'rev-a-001'), tombstones: [] },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(pushA.statusCode).toBe(200)

    const pushB = await invokeApi({
      method: 'POST',
      url: '/api/sync',
      headers: authHeader(tokenB),
      body: { payload: buildPayload('Salon B', 'rev-b-001'), tombstones: [] },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(pushB.statusCode).toBe(200)

    const pullA = await invokeApi({
      method: 'GET',
      url: '/api/sync/pull',
      headers: authHeader(tokenA),
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    const payloadA = pullA.json.payload as SalonBackupPayload
    expect(pullA.statusCode).toBe(200)
    expect(payloadA.salon.name).toBe('Salon A')
    expect(payloadA.revenues.map((r) => r.id)).toEqual(['rev-a-001'])

    const pullB = await invokeApi({
      method: 'GET',
      url: '/api/sync/pull',
      headers: authHeader(tokenB),
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    const payloadB = pullB.json.payload as SalonBackupPayload
    expect(payloadB.salon.name).toBe('Salon B')
    expect(payloadB.revenues.map((r) => r.id)).toEqual(['rev-b-001'])
  })

  it("n'autorise pas un salon à écraser une ligne identique d'un autre salon", async () => {
    resetAllRateLimits()
    const { pool } = createInMemoryNeonPool()
    const sharedId = 'rev-shared-001'

    const first = await invokeApi({
      method: 'POST',
      url: '/api/sync',
      headers: authHeader(tokenFor(TENANT_A)),
      body: { payload: buildPayload('Salon A', sharedId), tombstones: [] },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(first.statusCode).toBe(200)

    const second = await invokeApi({
      method: 'POST',
      url: '/api/sync',
      headers: authHeader(tokenFor(TENANT_B)),
      body: { payload: buildPayload('Salon B', sharedId), tombstones: [] },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(second.statusCode).toBe(200)

    const pullA = await invokeApi({
      method: 'GET',
      url: '/api/sync/pull',
      headers: authHeader(tokenFor(TENANT_A)),
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    const payloadA = pullA.json.payload as SalonBackupPayload
    expect(payloadA.salon.name).toBe('Salon A')
    expect(payloadA.revenues[0].label).toBe('Prestation Salon A')

    const unknownTenantPull = await invokeApi({
      method: 'GET',
      url: '/api/sync/pull',
      headers: authHeader(tokenFor('33333333-3333-4333-8333-333333333333')),
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(unknownTenantPull.statusCode).toBe(200)
    expect(unknownTenantPull.json.payload).toBeNull()
    expect(unknownTenantPull.json.totalRemoteRecords).toBe(0)
  })

  it("n'expose à un salon que les comptes de son propre salon", async () => {
    resetAllRateLimits()
    const { pool } = createInMemoryNeonPool()
    const tokenA = tokenFor(TENANT_A)
    const tokenB = tokenFor(TENANT_B)
    await seedManager(pool, TENANT_A)
    await seedManager(pool, TENANT_B)

    const provisionA = await invokeApi({
      method: 'POST',
      url: '/api/users/provision',
      headers: authHeader(tokenA),
      body: { accounts: [buildAccount()] },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(provisionA.statusCode).toBe(200)
    expect(provisionA.json.created).toBe(1)

    const listA = await invokeApi({
      method: 'GET',
      url: '/api/users',
      headers: authHeader(tokenA),
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(listA.statusCode).toBe(200)
    expect((listA.json.users as SalonUserAccount[]).map((u) => u.email)).toEqual([
      'awa@salon.ci',
    ])

    // Le salon B ne voit rien de A…
    const listB = await invokeApi({
      method: 'GET',
      url: '/api/users',
      headers: authHeader(tokenB),
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(listB.statusCode).toBe(200)
    expect(listB.json.users).toEqual([])

    // …et peut réutiliser le même e-mail : l'unicité est désormais par salon.
    const provisionB = await invokeApi({
      method: 'POST',
      url: '/api/users/provision',
      headers: authHeader(tokenB),
      body: { accounts: [buildAccount({ id: 'usr-cashier-b-001' })] },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(provisionB.statusCode).toBe(200)
    expect(provisionB.json.created).toBe(1)

    const listBAfter = await invokeApi({
      method: 'GET',
      url: '/api/users',
      headers: authHeader(tokenB),
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect((listBAfter.json.users as SalonUserAccount[]).map((u) => u.id)).toEqual([
      'usr-cashier-b-001',
    ])
  })

  it('rattache au salon par défaut une session historique dépourvue de tid', async () => {
    resetAllRateLimits()
    const { pool } = createInMemoryNeonPool()

    const legacyToken = signAuthSessionToken(
      { id: 'usr-legacy-001', email: 'legacy@salon.ci', role: 'manager' },
      TEST_PIN,
    )

    const res = await invokeApi({
      method: 'GET',
      url: '/api/sync/pull',
      headers: authHeader(legacyToken),
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(res.statusCode).toBe(200)
    expect(DEFAULT_TENANT_ID).toBe('00000000-0000-0000-0000-000000000001')
  })

  it('ne renvoie aucune ligne sans contexte de salon (RLS fail-closed)', async () => {
    resetAllRateLimits()
    const { pool } = createInMemoryNeonPool()
    await invokeApi({
      method: 'POST',
      url: '/api/sync',
      headers: authHeader(tokenFor(TENANT_A)),
      body: { payload: buildPayload('Salon A', 'rev-a-002'), tombstones: [] },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })

    const unscoped = await pool.query<{ payload_json: unknown }>(
      'SELECT payload_json FROM revenues ORDER BY updated_at ASC',
    )
    expect(unscoped.rows).toEqual([])

    const scoped = await pool.connect()
    await scoped.query('BEGIN')
    await scoped.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT_A])
    const rowsA = await scoped.query<{ payload_json: unknown }>(
      'SELECT payload_json FROM revenues ORDER BY updated_at ASC',
    )
    expect(rowsA.rows).toHaveLength(1)
    await scoped.query('COMMIT')
  })
})
