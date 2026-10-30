import { describe, expect, it } from 'vitest'
import { sanitizeDatabaseUrl, verifyManagerPin } from '../../server/neonClient'
import { SalonProDatabase } from '../db/database'
import { SalonRepositoryHub } from '../db/repositories/salonRepositories'
import { createInMemoryNeonPool, invokeApi } from './helpers/neonTestHarness'

describe('Synchronisation Hybride IndexedDB + Neon PostgreSQL', () => {
  const TEST_SYNC_CODE = 'test-sync-secret'

  it('nettoie les URL PostgreSQL copiées depuis du Markdown et vérifie le code serveur en temps constant', () => {
    const pastedMarkdown =
      'postgresql://[neondb_owner:npg_test123@ep-mute-glade.aws.neon.tech](mailto:neondb_owner:npg_test123@ep-mute-glade.aws.neon.tech)/neondb?sslmode=require&amp;channel_binding=require'

    expect(sanitizeDatabaseUrl(pastedMarkdown)).toBe(
      'postgresql://neondb_owner:npg_test123@ep-mute-glade.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
    )

    expect(verifyManagerPin(TEST_SYNC_CODE, TEST_SYNC_CODE).authorized).toBe(
      true,
    )
    expect(verifyManagerPin('wrong', TEST_SYNC_CODE).authorized).toBe(false)
    expect(verifyManagerPin(undefined, TEST_SYNC_CODE).authorized).toBe(false)
    expect(verifyManagerPin('', '').authorized).toBe(false)
  })

  it('protège /api/sync et n’expose aucun secret sur /api/health', async () => {
    const { pool } = createInMemoryNeonPool()

    const health = await invokeApi({
      method: 'GET',
      url: '/api/health',
      poolOverride: pool,
      expectedPinOverride: TEST_SYNC_CODE,
    })
    expect(health.statusCode).toBe(200)
    expect(health.json).toEqual({
      ok: true,
      databaseConfigured: true,
      pinRequired: true,
    })
    expect(JSON.stringify(health.json)).not.toContain('neondb_owner')
    expect(JSON.stringify(health.json)).not.toContain(TEST_SYNC_CODE)

    const unauthorized = await invokeApi({
      method: 'POST',
      url: '/api/sync/verify',
      headers: { 'x-salon-pin': 'wrong' },
      poolOverride: pool,
      expectedPinOverride: TEST_SYNC_CODE,
    })
    expect(unauthorized.statusCode).toBe(401)
    expect(unauthorized.json.code).toBe('INVALID_PIN')
  })

  it('initialise une base vierge sans aucune donnée fictive, synchronise deux appareils (LWW) et propage les suppressions (tombstones)', async () => {
    const { pool, tables } = createInMemoryNeonPool()

    // Appareil A : initialisé totalement vierge (0 donnée mock) + 1 recette réelle + 1 budget réel
    const dbA = new SalonProDatabase(`test-sync-a-${crypto.randomUUID()}`)
    const repoA = new SalonRepositoryHub(dbA)
    await repoA.ensureInitialized()

    const initialStateA = await repoA.readFullState()
    expect(initialStateA.salon.name).toBe('')
    expect(initialStateA.services).toHaveLength(0)
    expect(initialStateA.employees).toHaveLength(0)
    expect(initialStateA.revenues).toHaveLength(0)
    expect(initialStateA.expenses).toHaveLength(0)
    expect(initialStateA.products).toHaveLength(0)
    expect(initialStateA.recurringExpenses).toHaveLength(0)

    await repoA.updateSalonInfo({
      name: 'Salon Prestige Plateau',
      managerName: 'Responsable A',
    })
    await repoA.addRevenue({
      date: '2026-10-30T10:00:00.000Z',
      label: 'Tresses Nattes Collées',
      categoryCode: 'braiding_weaving',
      clientName: 'Cliente A',
      amount: 15_000,
      paymentMethod: 'wave',
    })
    const budgetToKeepAndDelete = await repoA.upsertBudgetTarget({
      periodMonth: '2026-10',
      kind: 'revenue_goal',
      categoryCode: 'global',
      plannedAmount: 1_500_000,
    })

    const envA = await repoA.buildCloudSyncEnvelope()
    expect(envA.payload.revenues).toHaveLength(1)

    const syncA1 = await invokeApi({
      method: 'POST',
      url: '/api/sync',
      headers: { 'x-salon-pin': TEST_SYNC_CODE },
      body: envA,
      poolOverride: pool,
      expectedPinOverride: TEST_SYNC_CODE,
    })
    expect(syncA1.statusCode).toBe(200)
    expect(tables.get('revenues')?.size).toBe(1)
    expect(tables.get('budgets')?.size).toBe(1)

    // Appareil B : initialisé vierge, saisit une dépense hors-ligne puis synchronise
    const dbB = new SalonProDatabase(`test-sync-b-${crypto.randomUUID()}`)
    const repoB = new SalonRepositoryHub(dbB)
    await repoB.ensureInitialized()

    await repoB.addExpense({
      date: '2026-10-30T14:00:00.000Z',
      label: 'Facture Électricité Octobre',
      categoryCode: 'utilities',
      amount: 35_000,
      paymentMethod: 'orange_money',
    })

    const envB = await repoB.buildCloudSyncEnvelope()
    const syncB1 = await invokeApi({
      method: 'POST',
      url: '/api/sync',
      headers: { 'x-salon-pin': TEST_SYNC_CODE },
      body: envB,
      poolOverride: pool,
      expectedPinOverride: TEST_SYNC_CODE,
    })
    expect(syncB1.statusCode).toBe(200)

    await repoB.mergeCloudSyncResult({
      payload: syncB1.json.payload as typeof envB.payload,
      tombstones: syncB1.json.tombstones as typeof envB.tombstones,
    })

    const stateBAfter = await repoB.readFullState()
    expect(stateBAfter.salon.name).toBe('Salon Prestige Plateau')
    expect(stateBAfter.revenues).toHaveLength(1)
    expect(stateBAfter.revenues[0].label).toBe('Tresses Nattes Collées')
    expect(stateBAfter.expenses).toHaveLength(1)
    expect(stateBAfter.budgets).toHaveLength(1)

    // Appareil A supprime le budget -> Tombstone propagé à Neon puis à l'Appareil B
    await repoA.deleteBudgetTarget(budgetToKeepAndDelete.id)
    const envA2 = await repoA.buildCloudSyncEnvelope()
    expect(envA2.tombstones).toHaveLength(1)

    const syncA2 = await invokeApi({
      method: 'POST',
      url: '/api/sync',
      headers: { 'x-salon-pin': TEST_SYNC_CODE },
      body: envA2,
      poolOverride: pool,
      expectedPinOverride: TEST_SYNC_CODE,
    })
    expect(syncA2.statusCode).toBe(200)
    expect(tables.get('budgets')?.size).toBe(0)

    const pullB = await invokeApi({
      method: 'GET',
      url: '/api/sync/pull',
      headers: { Authorization: `Bearer ${TEST_SYNC_CODE}` },
      poolOverride: pool,
      expectedPinOverride: TEST_SYNC_CODE,
    })
    expect(pullB.statusCode).toBe(200)

    await repoB.mergeCloudSyncResult({
      payload: pullB.json.payload as typeof envB.payload,
      tombstones: pullB.json.tombstones as typeof envB.tombstones,
    })

    const stateBFinal = await repoB.readFullState()
    expect(stateBFinal.budgets).toHaveLength(0)
    expect(stateBFinal.expenses).toHaveLength(1)
  })

  it('renvoie proprement un statut 503 NETWORK_UNREACHABLE si Neon est hors-ligne', async () => {
    const { pool } = createInMemoryNeonPool({ failNetwork: true })

    const res = await invokeApi({
      method: 'POST',
      url: '/api/sync/verify',
      headers: { 'x-salon-pin': TEST_SYNC_CODE },
      poolOverride: pool,
      expectedPinOverride: TEST_SYNC_CODE,
    })

    expect(res.statusCode).toBe(503)
    expect(res.json.code).toBe('NETWORK_UNREACHABLE')
  })
})
