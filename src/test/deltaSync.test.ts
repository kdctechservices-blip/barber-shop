import { beforeEach, describe, expect, it } from 'vitest'
import { resetAllRateLimits } from '../../server/rateLimiter'
import { signAuthSessionToken } from '../../server/authEngine'
import type { SalonBackupPayload } from '../domain/models'
import { SalonProDatabase } from '../db/database'
import { SalonRepositoryHub } from '../db/repositories/salonRepositories'
import { createInMemoryNeonPool, invokeApi } from './helpers/neonTestHarness'

/**
 * Synchronisation delta serveur-autoritaire (P0-6).
 *
 * Le serveur — et non les horloges des clients — décide de l'ordre des écritures
 * et attribue une révision monotone par salon. Un client qui présente un
 * curseur ne reçoit que les changements survenus depuis.
 */

const TEST_PIN = 'test-sync-secret'
const TENANT_A = '44444444-4444-4444-8444-444444444444'
const TENANT_B = '55555555-5555-4555-8555-555555555555'

function tokenFor(tenantId: string): string {
  return signAuthSessionToken(
    {
      id: `usr-manager-${tenantId.slice(0, 4)}`,
      email: `manager-${tenantId.slice(0, 4)}@salon.ci`,
      role: 'manager',
    },
    TEST_PIN,
    tenantId,
  )
}

function buildPayload(options: {
  revenueId: string
  amount: number
  updatedAt: string
}): SalonBackupPayload {
  return {
    format: 'SALON_PRO_BACKUP_V1',
    exportedAt: new Date().toISOString(),
    salon: {
      id: 'salon-main',
      name: 'Salon Delta',
      address: 'Abidjan',
      phone: '',
      managerName: 'Gérant',
      currency: 'XOF',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    settings: {
      id: 'default',
      theme: 'light',
      dateFormat: 'long-fr',
      printHeaderNote: '',
      printCompact: false,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    categories: [],
    services: [],
    employees: [],
    revenues: [
      {
        id: options.revenueId,
        date: '2026-10-30T10:00:00.000Z',
        label: 'Prestation',
        amount: options.amount,
        paymentMethod: 'cash',
        isCancelled: false,
        createdAt: '2026-10-30T10:00:00.000Z',
        updatedAt: options.updatedAt,
      } as unknown as SalonBackupPayload['revenues'][number],
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
  }
}

async function push(
  pool: ReturnType<typeof createInMemoryNeonPool>['pool'],
  tenantId: string,
  payload: SalonBackupPayload,
  cursor?: string,
  tombstones: { entityType: string; entityId: string; deletedAt: string }[] = [],
) {
  const res = await invokeApi({
    method: 'POST',
    url: '/api/sync',
    headers: { Authorization: `Bearer ${tokenFor(tenantId)}` },
    body: { payload, tombstones, ...(cursor ? { cursor } : {}) },
    poolOverride: pool,
    expectedPinOverride: TEST_PIN,
  })
  expect(res.statusCode).toBe(200)
  return res.json as unknown as {
    cursor: string
    payload?: SalonBackupPayload
    changes?: Record<string, unknown[]>
    deleted?: { entityType: string; entityId: string; deletedAt: string }[]
  }
}

describe('Synchronisation delta serveur-autoritaire (P0-6)', () => {
  beforeEach(() => {
    resetAllRateLimits()
  })

  it('renvoie l’état complet sans curseur, puis un delta ciblé avec curseur', async () => {
    const { pool } = createInMemoryNeonPool()

    const first = await push(
      pool,
      TENANT_A,
      buildPayload({
        revenueId: 'rev-001',
        amount: 10_000,
        updatedAt: '2026-10-30T10:00:00.000Z',
      }),
    )
    expect(first.payload?.revenues).toHaveLength(1)
    expect(Number(first.cursor)).toBeGreaterThan(0)

    // Aucun changement depuis : delta vide, curseur inchangé.
    const idle = await push(
      pool,
      TENANT_A,
      buildPayload({
        revenueId: 'rev-001',
        amount: 10_000,
        updatedAt: '2026-10-30T10:00:00.000Z',
      }),
      first.cursor,
    )
    expect(idle.changes).toEqual({})
    expect(idle.payload).toBeUndefined()
    expect(idle.cursor).toBe(first.cursor)

    // Modification réelle : une seule ligne dans le delta.
    const changed = await push(
      pool,
      TENANT_A,
      buildPayload({
        revenueId: 'rev-001',
        amount: 25_000,
        updatedAt: '2026-10-30T11:00:00.000Z',
      }),
      first.cursor,
    )
    expect(changed.changes?.revenues).toHaveLength(1)
    const changedRevenue = (changed.changes?.revenues ?? [])[0] as
      | { amount: number }
      | undefined
    expect(changedRevenue?.amount).toBe(25_000)
    expect(Number(changed.cursor)).toBeGreaterThan(Number(first.cursor))
    expect(changed.payload).toBeUndefined()
  })

  it('décide de l’ordre côté serveur : un horodatage client « futur » ne gagne pas', async () => {
    const { pool } = createInMemoryNeonPool()

    // Appareil A : horloge artificiellement avancée (2099).
    const a = await push(
      pool,
      TENANT_A,
      buildPayload({
        revenueId: 'rev-clock',
        amount: 5_000,
        updatedAt: '2099-01-01T00:00:00.000Z',
      }),
    )

    // Appareil B : horloge plus ancienne mais écriture arrivée après.
    const b = await push(
      pool,
      TENANT_A,
      buildPayload({
        revenueId: 'rev-clock',
        amount: 7_500,
        updatedAt: '2020-01-01T00:00:00.000Z',
      }),
      a.cursor,
    )
    const authoritativeRevenue = (b.changes?.revenues ?? [])[0] as
      | { amount: number }
      | undefined
    expect(authoritativeRevenue?.amount).toBe(7_500)

    const pull = await invokeApi({
      method: 'GET',
      url: `/api/sync/pull?since=${a.cursor}`,
      headers: { Authorization: `Bearer ${tokenFor(TENANT_A)}` },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(pull.statusCode).toBe(200)
    const rows = (pull.json.changes as Record<string, { amount: number }[]>)
      .revenues
    expect(rows).toHaveLength(1)
    expect(rows[0].amount).toBe(7_500)
    // Le curseur avance : l'horloge du client ne bloque plus les écritures suivantes.
    expect(Number(pull.json.cursor)).toBeGreaterThanOrEqual(Number(b.cursor))
  })

  it('ne crée pas de révision quand rien ne change (push idempotent)', async () => {
    const { pool } = createInMemoryNeonPool()
    const payload = buildPayload({
      revenueId: 'rev-idem',
      amount: 12_000,
      updatedAt: '2026-10-30T09:00:00.000Z',
    })

    const first = await push(pool, TENANT_A, payload)
    const second = await push(pool, TENANT_A, payload, first.cursor)
    expect(second.cursor).toBe(first.cursor)
  })

  it('propage les suppressions dans `deleted` et retire la ligne du delta', async () => {
    const { pool } = createInMemoryNeonPool()
    const first = await push(
      pool,
      TENANT_A,
      buildPayload({
        revenueId: 'rev-del',
        amount: 9_000,
        updatedAt: '2026-10-30T08:00:00.000Z',
      }),
    )

    const deletion = await push(
      pool,
      TENANT_A,
      buildPayload({
        revenueId: 'rev-del',
        amount: 9_000,
        updatedAt: '2026-10-30T08:00:00.000Z',
      }),
      first.cursor,
      [
        {
          entityType: 'revenue',
          entityId: 'rev-del',
          deletedAt: '2026-10-30T12:00:00.000Z',
        },
      ],
    )
    const deleted = deletion.deleted ?? []
    expect(deleted.map((tb) => tb.entityId)).toContain('rev-del')
    expect(deletion.changes?.revenues ?? []).toHaveLength(0)
  })

  it('cloisonne les journaux de changements par salon', async () => {
    const { pool } = createInMemoryNeonPool()
    const a = await push(
      pool,
      TENANT_A,
      buildPayload({
        revenueId: 'rev-a',
        amount: 1_000,
        updatedAt: '2026-10-30T07:00:00.000Z',
      }),
    )
    await push(
      pool,
      TENANT_B,
      buildPayload({
        revenueId: 'rev-b',
        amount: 2_000,
        updatedAt: '2026-10-30T07:00:00.000Z',
      }),
    )

    const pullA = await invokeApi({
      method: 'GET',
      url: `/api/sync/pull?since=0`,
      headers: { Authorization: `Bearer ${tokenFor(TENANT_A)}` },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    const revenues = (pullA.json.changes as Record<string, { id: string }[]>)
      .revenues
    expect(revenues.map((r) => r.id)).toEqual(['rev-a'])
    expect(Number(pullA.json.cursor)).toBeGreaterThanOrEqual(Number(a.cursor))
  })
})

describe('Fusion d’un delta côté client', () => {
  it('applique uniquement les tables présentes et respecte les suppressions', async () => {
    const repo = new SalonRepositoryHub(
      new SalonProDatabase(`delta-${crypto.randomUUID()}`),
    )
    await repo.ensureInitialized()
    await repo.updateSalonInfo({ name: 'Salon Delta Client' })
    await repo.addRevenue({
      date: '2026-10-30T10:00:00.000Z',
      label: 'Coupe',
      categoryCode: 'haircut',
      amount: 5_000,
      paymentMethod: 'cash',
    })
    const expense = await repo.addExpense({
      date: '2026-10-30T10:30:00.000Z',
      label: 'Électricité',
      categoryCode: 'utilities',
      amount: 20_000,
      paymentMethod: 'cash',
    })

    const before = await repo.readFullState()
    expect(before.revenues).toHaveLength(1)
    expect(before.expenses).toHaveLength(1)

    // Delta : une nouvelle recette, suppression d'une dépense, salon inchangé.
    const merged = await repo.mergeCloudDelta({
      changes: {
        revenues: [
          {
            ...before.revenues[0],
            id: 'rev-remote-001',
            label: 'Tresses',
            updatedAt: '2026-10-30T13:00:00.000Z',
          },
        ],
      },
      deleted: [
        {
          entityType: 'expense',
          entityId: expense.id,
          deletedAt: '2026-10-30T14:00:00.000Z',
        },
      ],
    })
    expect(merged.mergedCount).toBeGreaterThanOrEqual(1)

    const after = await repo.readFullState()
    expect(after.salon.name).toBe('Salon Delta Client')
    expect(after.revenues.map((r) => r.id)).toContain('rev-remote-001')
    expect(after.expenses).toHaveLength(0)
    expect(after.recurringExpenses).toHaveLength(0)
  })
})
