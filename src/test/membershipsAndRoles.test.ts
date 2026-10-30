import { beforeEach, describe, expect, it } from 'vitest'
import { signAuthSessionToken } from '../../server/authEngine'
import { resetAllRateLimits } from '../../server/rateLimiter'
import { PERMISSION_POLICY } from '../../server/permissions'
import type { SalonBackupPayload } from '../domain/models'
import { createInMemoryNeonPool, invokeApi, seedMembership } from './helpers/neonTestHarness'

/**
 * Appartenances multi-salons et garde de rôle par entité (P1).
 *
 * - un compte peut appartenir à plusieurs salons, avec un rôle par salon ;
 * - les routes d'administration vérifient le rôle **en base** (pas seulement
 *   dans le jeton, qui peut être périmé après une rétrogradation) ;
 * - la synchronisation filtre les entités qu'un Caissier n'a pas le droit
 *   d'écrire ou de supprimer.
 */

const TEST_PIN = 'test-sync-secret'
const SECOND_TENANT = '66666666-6666-4666-8666-666666666666'
const PASSWORD = 'MotDePasse123'

function buildPayload(overrides: Partial<SalonBackupPayload> = {}): SalonBackupPayload {
  const now = new Date().toISOString()
  return {
    format: 'SALON_PRO_BACKUP_V1',
    exportedAt: now,
    salon: {
      id: 'salon-main',
      name: 'Salon Rôles',
      address: 'Abidjan',
      phone: '',
      managerName: 'Gérant',
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
    ...overrides,
  }
}

function tokenFor(
  userId: string,
  tenantId: string,
  role: 'manager' | 'cashier',
): string {
  return signAuthSessionToken(
    { id: userId, email: `${userId}@salon.ci`, role },
    TEST_PIN,
    tenantId,
  )
}

async function registerManager(
  pool: ReturnType<typeof createInMemoryNeonPool>['pool'],
) {
  const res = await invokeApi({
    method: 'POST',
    url: '/api/auth/register',
    body: {
      fullName: 'Gérant Rôles',
      email: 'gerant.roles@salon.ci',
      password: PASSWORD,
      role: 'manager',
      salonName: 'Salon Rôles',
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

describe('Appartenances multi-salons (P1)', () => {
  beforeEach(() => {
    resetAllRateLimits()
  })

  it("crée l'appartenance du Gérant à l'inscription et la liste", async () => {
    const { pool, tables } = createInMemoryNeonPool()
    const registered = await registerManager(pool)

    expect(tables.get('memberships')?.size).toBe(1)

    const res = await invokeApi({
      method: 'GET',
      url: '/api/auth/tenants',
      headers: { Authorization: `Bearer ${registered.sessionToken}` },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(res.statusCode).toBe(200)
    const tenants = res.json.tenants as Array<{ tenantId: string; role: string }>
    expect(tenants).toHaveLength(1)
    expect(tenants[0].tenantId).toBe(registered.tenantId)
    expect(tenants[0].role).toBe('manager')
    expect(res.json.activeTenantId).toBe(registered.tenantId)
  })

  it('bascule vers un autre salon et révoque la session précédente', async () => {
    const { pool } = createInMemoryNeonPool()
    const registered = await registerManager(pool)

    // Le même compte est Caissier d'un second salon.
    await seedMembership(pool, {
      tenantId: SECOND_TENANT,
      userId: registered.user.id,
      role: 'cashier',
    })

    const switched = await invokeApi({
      method: 'POST',
      url: '/api/auth/switch-tenant',
      headers: { Authorization: `Bearer ${registered.sessionToken}` },
      body: { tenantId: SECOND_TENANT },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(switched.statusCode).toBe(200)
    expect(switched.json.tenantId).toBe(SECOND_TENANT)
    expect((switched.json.user as { role: string }).role).toBe('cashier')

    const payload = String(switched.json.sessionToken).split('.')[1]
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      tid: string
      role: string
    }
    expect(claims.tid).toBe(SECOND_TENANT)
    expect(claims.role).toBe('cashier')

    // L'ancienne session ne survit pas à la bascule.
    const oldSession = await invokeApi({
      method: 'GET',
      url: '/api/users',
      headers: { Authorization: `Bearer ${registered.sessionToken}` },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(oldSession.statusCode).toBe(401)
    expect(oldSession.json.code).toBe('SESSION_REVOKED')
  })

  it("refuse la bascule vers un salon sans appartenance et les cibles invalides", async () => {
    const { pool } = createInMemoryNeonPool()
    const registered = await registerManager(pool)

    const forbidden = await invokeApi({
      method: 'POST',
      url: '/api/auth/switch-tenant',
      headers: { Authorization: `Bearer ${registered.sessionToken}` },
      body: { tenantId: SECOND_TENANT },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json.code).toBe('TENANT_ACCESS_DENIED')

    const invalid = await invokeApi({
      method: 'POST',
      url: '/api/auth/switch-tenant',
      headers: { Authorization: `Bearer ${registered.sessionToken}` },
      body: { tenantId: 'pas-un-uuid' },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json.code).toBe('INVALID_TENANT')

    const anonymous = await invokeApi({
      method: 'GET',
      url: '/api/auth/tenants',
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(anonymous.statusCode).toBe(401)
  })

  it('vérifie le rôle en base : un Gérant rétrogradé perd immédiatement ses droits', async () => {
    const { pool } = createInMemoryNeonPool()
    const registered = await registerManager(pool)

    const before = await invokeApi({
      method: 'GET',
      url: '/api/users',
      headers: { Authorization: `Bearer ${registered.sessionToken}` },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(before.statusCode).toBe(200)

    // Rétrogradation en base (sans nouvelle connexion, jeton inchangé).
    await seedMembership(pool, {
      tenantId: registered.tenantId,
      userId: registered.user.id,
      role: 'cashier',
    })

    const after = await invokeApi({
      method: 'GET',
      url: '/api/users',
      headers: { Authorization: `Bearer ${registered.sessionToken}` },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(after.statusCode).toBe(403)
    expect(after.json.code).toBe('MANAGER_ROLE_REQUIRED')
  })
})

describe('Garde de rôle par entité sur la synchronisation (P1)', () => {
  beforeEach(() => {
    resetAllRateLimits()
  })

  const employee = {
    id: 'emp-001',
    fullName: 'Awa Koné',
    role: 'stylist',
    commissionRate: 10,
    isActive: true,
    createdAt: '2026-10-30T08:00:00.000Z',
    updatedAt: '2026-10-30T08:00:00.000Z',
  }
  const revenue = {
    id: 'rev-001',
    date: '2026-10-30T10:00:00.000Z',
    label: 'Coupe',
    categoryCode: 'haircut',
    amount: 5_000,
    paymentMethod: 'cash',
    isCancelled: false,
    createdAt: '2026-10-30T10:00:00.000Z',
    updatedAt: '2026-10-30T10:00:00.000Z',
  }

  it("un Caissier ne peut pas créer d'employé ni modifier les réglages, mais peut saisir une recette", async () => {
    const { pool, tables } = createInMemoryNeonPool()
    const cashier = tokenFor('usr-cashier-001', SECOND_TENANT, 'cashier')

    const res = await invokeApi({
      method: 'POST',
      url: '/api/sync',
      headers: { Authorization: `Bearer ${cashier}` },
      body: {
        payload: buildPayload({
          employees: [employee] as unknown as SalonBackupPayload['employees'],
          revenues: [revenue] as unknown as SalonBackupPayload['revenues'],
        }),
        tombstones: [],
      },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })

    expect(res.statusCode).toBe(200)
    expect(tables.get('revenues')?.size).toBe(1)
    expect(tables.get('employees')?.size ?? 0).toBe(0)

    const rejected = res.json.rejected as { table: string }[]
    expect(rejected.some((entry) => entry.table === 'employees')).toBe(true)
    expect(
      (res.json.stats as { rejectedRecords: number }).rejectedRecords,
    ).toBeGreaterThanOrEqual(1)
  })

  it('un Caissier ne peut pas supprimer une recette (tombstone refusé)', async () => {
    const { pool, tables } = createInMemoryNeonPool()
    const manager = tokenFor('usr-manager-001', SECOND_TENANT, 'manager')
    const cashier = tokenFor('usr-cashier-001', SECOND_TENANT, 'cashier')

    await invokeApi({
      method: 'POST',
      url: '/api/sync',
      headers: { Authorization: `Bearer ${manager}` },
      body: {
        payload: buildPayload({
          revenues: [revenue] as unknown as SalonBackupPayload['revenues'],
        }),
        tombstones: [],
      },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(tables.get('revenues')?.size).toBe(1)

    const deletion = await invokeApi({
      method: 'POST',
      url: '/api/sync',
      headers: { Authorization: `Bearer ${cashier}` },
      body: {
        payload: buildPayload(),
        tombstones: [
          {
            entityType: 'revenue',
            entityId: revenue.id,
            deletedAt: '2026-10-30T12:00:00.000Z',
          },
        ],
      },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(deletion.statusCode).toBe(200)
    expect(tables.get('revenues')?.size).toBe(1)
    const rejected = deletion.json.rejected as { reason: string }[]
    expect(rejected.map((entry) => entry.reason)).toContain(
      'DELETE_FORBIDDEN_FOR_ROLE',
    )

    // Un Gérant, lui, peut supprimer.
    await invokeApi({
      method: 'POST',
      url: '/api/sync',
      headers: { Authorization: `Bearer ${manager}` },
      body: {
        payload: buildPayload(),
        tombstones: [
          {
            entityType: 'revenue',
            entityId: revenue.id,
            deletedAt: '2026-10-30T13:00:00.000Z',
          },
        ],
      },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(tables.get('revenues')?.size).toBe(0)
  })

  it('un Gérant peut tout écrire et la synchronisation machine par PIN reste non filtrée', async () => {
    const { pool, tables } = createInMemoryNeonPool()

    const manager = await invokeApi({
      method: 'POST',
      url: '/api/sync',
      headers: { Authorization: `Bearer ${tokenFor('usr-manager-002', SECOND_TENANT, 'manager')}` },
      body: {
        payload: buildPayload({
          employees: [employee] as unknown as SalonBackupPayload['employees'],
        }),
        tombstones: [],
      },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(manager.statusCode).toBe(200)
    expect(tables.get('employees')?.size).toBe(1)
    expect(manager.json.rejected).toBeUndefined()

    // Synchronisation machine (secret serveur, pas de rôle utilisateur).
    const machine = await invokeApi({
      method: 'POST',
      url: '/api/sync',
      headers: { 'x-salon-pin': TEST_PIN },
      body: {
        payload: buildPayload({
          employees: [
            { ...employee, id: 'emp-002' },
          ] as unknown as SalonBackupPayload['employees'],
        }),
        tombstones: [],
      },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(machine.statusCode).toBe(200)
    expect(machine.json.rejected).toBeUndefined()
  })

  it('documente la politique de droits appliquée', () => {
    expect(PERMISSION_POLICY.cashierWritableTables).toEqual([
      'revenues',
      'expenses',
      'cash_sessions',
      'cash_movements',
      'stock_movements',
    ])
    expect(PERMISSION_POLICY.cashierDeletableEntities).toEqual([])
  })
})
