import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppRoutes } from '../app/router'
import { SalonProDatabase } from '../db/database'
import { SalonRepositoryHub } from '../db/repositories/salonRepositories'
import { calculateEstimatedResult } from '../domain/calculations/finance'
import { SalonStoreProvider } from '../hooks/SalonStoreProvider'
import { ToastProvider } from '../hooks/ToastProvider'

function createIsolatedRepo() {
  const dbName = `SalonProTest_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  const testDb = new SalonProDatabase(dbName)
  return new SalonRepositoryHub(testDb)
}

describe('Parcours transactionnels complets (Section 23 — Scénarios 1 à 10)', () => {
  let repo: SalonRepositoryHub

  beforeEach(async () => {
    repo = createIsolatedRepo()
    await repo.ensureInitialized(false)
  })

  it('Scénarios 1 & 2 : Caisse espèces (ouverture, entrées, sorties, clôture avec écart) + Wave hors caisse espèces', async () => {
    const session = await repo.openCashSession(20000, 'Fond matin')
    expect(session.status).toBe('open')

    // Recette en espèces -> alimente la caisse
    await repo.addRevenue({
      date: '2026-10-29T10:00:00.000Z',
      label: 'Coupe + Barbe client',
      categoryCode: 'hair_service',
      amount: 10000,
      paymentMethod: 'cash',
    })

    // Recette Wave -> compte dans le CA mais PAS dans la caisse espèces !
    await repo.addRevenue({
      date: '2026-10-29T10:30:00.000Z',
      label: 'Tresses sans nœuds Wave',
      categoryCode: 'braiding_weaving',
      amount: 25000,
      paymentMethod: 'wave',
    })

    // Sortie espèces via dépense
    await repo.addExpense({
      date: '2026-10-29T11:00:00.000Z',
      label: 'Achat désinfectant urgence',
      categoryCode: 'maintenance',
      beneficiary: 'Pharmacie',
      receiptRef: 'REC-001',
      amount: 3000,
      paymentMethod: 'cash',
    })

    const stateMid = await repo.readFullState()
    const open = stateMid.cashSessions[0]
    // Théorique = 20 000 + 10 000 - 3 000 = 27 000 FCFA (les 25 000 Wave n'y sont pas !)
    expect(open.theoreticalClosingBalance).toBe(27000)

    const res = calculateEstimatedResult({
      revenues: stateMid.revenues,
      expenses: stateMid.expenses,
      stockMovements: stateMid.stockMovements,
    })
    // Le CA total inclut bien Espèces (10 000) + Wave (25 000) = 35 000 FCFA
    expect(res.chiffreAffaires).toBe(35000)

    // Clôture avec 26 500 comptés -> écart de -500 FCFA
    const closed = await repo.closeCashSession({
      sessionId: session.id,
      countedClosingBalance: 26500,
      closingNote: 'Manque une pièce de 500 FCFA',
    })
    expect(closed.status).toBe('closed')
    expect(closed.discrepancy).toBe(-500)

    // Vérifier qu'on ne peut plus ajouter un mouvement direct sur la session clôturée
    await expect(
      repo.recordManualCashMovement({
        sessionId: session.id,
        direction: 'in',
        amount: 1000,
        reason: 'Tentative interdite',
      }),
    ).rejects.toThrow()
  })

  it('Scénarios 3 & 4 : Dépense avec justificatif + Employé, avance et paiement salaire sans double comptage', async () => {
    await repo.addExpense({
      date: '2026-10-10T09:00:00.000Z',
      label: 'Facture SODECI',
      categoryCode: 'utilities',
      beneficiary: 'SODECI',
      receiptRef: 'FAC-SOD-88',
      amount: 18000,
      paymentMethod: 'orange_money',
    })

    const emp = await repo.saveEmployee({
      lastName: 'Bamba',
      firstName: 'Mariam',
      roleTitle: 'Coiffeuse Tresses',
      hireDate: '2026-01-15',
      baseSalary: 100000,
      remunerationType: 'fixed',
      commissionEnabled: false,
      commissionBasis: 'employee_services',
      commissionRate: 0,
    })

    // Avance de 30 000 FCFA -> génère 1 dépense de 30 000 FCFA
    await repo.recordSalaryAdvance({
      employeeId: emp.id,
      periodMonth: '2026-10',
      amount: 30000,
      paidAt: '2026-10-15T12:00:00.000Z',
      paymentMethod: 'cash',
      note: 'Avance mi-mois',
    })

    // Paiement du salaire du mois -> doit verser uniquement 70 000 FCFA (100 000 - 30 000) !
    const payment = await repo.validateSalaryPayment({
      employeeId: emp.id,
      periodMonth: '2026-10',
      baseSalary: 100000,
      bonusesTotal: 0,
      deductions: 0,
      commissionCalculated: 0,
      commissionValidated: 0,
      paidAt: '2026-10-28T16:00:00.000Z',
      paymentMethod: 'wave',
    })

    expect(payment.advancesDeducted).toBe(30000)
    expect(payment.netPaidAmount).toBe(70000)

    const full = await repo.readFullState()
    const salaryExpenses = full.expenses.filter(
      (e) => e.sourceModule === 'payroll',
    )
    // Total décaissé pour la paie = 30 000 + 70 000 = 100 000 FCFA exactement (aucun double comptage !)
    const totalPayrollDisbursed = salaryExpenses.reduce(
      (s, e) => s + e.amount,
      0,
    )
    expect(totalPayrollDisbursed).toBe(100000)
    // Total général des dépenses = 18 000 (SODECI) + 100 000 (Paie) = 118 000 FCFA
    const totalAllExpenses = full.expenses.reduce((s, e) => s + e.amount, 0)
    expect(totalAllExpenses).toBe(118000)
  })

  it('Scénario 5 : Produit, achat, utilisation, vente, valeur stock et alerte sans double comptage', async () => {
    const prod = await repo.saveProduct({
      name: 'Huile de Ricin Pure',
      sku: 'HUI-01',
      categoryCode: 'creams_oils',
      initialQuantity: 0,
      unit: 'flacon',
      costPrice: 3000,
      salePrice: 6000,
      alertThreshold: 3,
      usageType: 'both',
    })

    // 1. Achat de 5 flacons à 3 000 FCFA = 15 000 FCFA décaissés en trésorerie
    await repo.recordStockMovement({
      productId: prod.id,
      type: 'purchase',
      quantity: 5,
      unitCost: 3000,
      reason: 'Achat grossiste',
      occurredAt: '2026-10-05T10:00:00.000Z',
      recordFinancialEntry: true,
      paymentMethod: 'cash',
    })

    // 2. Utilisation interne d'1 flacon
    await repo.recordStockMovement({
      productId: prod.id,
      type: 'use',
      quantity: 1,
      unitCost: 3000,
      reason: 'Soin capillaire salon',
      occurredAt: '2026-10-12T10:00:00.000Z',
      recordFinancialEntry: false,
    })

    // 3. Vente de 2 flacons à 6 000 FCFA (= 12 000 FCFA de recette)
    await repo.recordStockMovement({
      productId: prod.id,
      type: 'sale',
      quantity: 2,
      unitCost: 3000,
      unitSalePrice: 6000,
      reason: 'Vente cliente',
      occurredAt: '2026-10-14T15:00:00.000Z',
      recordFinancialEntry: true,
      paymentMethod: 'cash',
    })

    const stateAfter = await repo.readFullState()
    const updatedProd = stateAfter.products.find((p) => p.id === prod.id)!
    // Stock restant = 5 - 1 - 2 = 2 flacons (<= seuil d'alerte 3 !)
    expect(updatedProd.quantity).toBe(2)
    expect(updatedProd.quantity <= updatedProd.alertThreshold).toBe(true)

    const est = calculateEstimatedResult({
      revenues: stateAfter.revenues,
      expenses: stateAfter.expenses,
      stockMovements: stateAfter.stockMovements,
    })
    // CA = 12 000 ; Coût des 3 flacons sortis (1 utilisé + 2 vendus) = 9 000 ; Bénéfice estimé = 3 000 FCFA
    expect(est.chiffreAffaires).toBe(12000)
    expect(est.coutProduitsConsommesOuVendus).toBe(9000)
    expect(est.resultatEstime).toBe(3000)
  })

  it('Scénarios 7, 8 & 9 : Export JSON, réinitialisation SUPPRIMER, restauration JSON, entrées invalides et anti-doublon', async () => {
    await repo.addRevenue({
      date: '2026-10-29T09:00:00.000Z',
      label: 'Brushing complet',
      categoryCode: 'hair_service',
      amount: 8000,
      paymentMethod: 'cash',
    })

    // Scénario 9 : Double soumission identique immédiate bloquée
    await expect(
      repo.addRevenue({
        date: '2026-10-29T09:00:00.000Z',
        label: 'Brushing complet',
        categoryCode: 'hair_service',
        amount: 8000,
        paymentMethod: 'cash',
      }),
    ).rejects.toThrow(/Double enregistrement bloqué/)

    // Scénario 8 : Montant négatif refusé
    await expect(
      repo.addExpense({
        date: '2026-10-29T09:00:00.000Z',
        label: 'Dépense invalide',
        categoryCode: 'other_expense',
        amount: -2000,
        paymentMethod: 'cash',
      }),
    ).rejects.toThrow()

    // Scénario 7 : Sauvegarde JSON -> Reset -> Restauration JSON
    const backup = await repo.exportBackupPayload()
    expect(backup.format).toBe('SALON_PRO_BACKUP_V1')
    expect(backup.revenues).toHaveLength(1)

    await expect(repo.resetAllDataWithConfirmation('NON')).rejects.toThrow()
    await repo.resetAllDataWithConfirmation('SUPPRIMER')

    const afterReset = await repo.readFullState()
    expect(afterReset.revenues).toHaveLength(0)

    await repo.importBackupPayload(backup)
    const afterRestore = await repo.readFullState()
    expect(afterRestore.revenues).toHaveLength(1)
    expect(afterRestore.revenues[0].label).toBe('Brushing complet')
  })

  it('Purge de la base locale à la bascule de salon : vide les tables métier, préserve les comptes locaux', async () => {
    const now = new Date().toISOString()
    const db = (repo as any).database as {
      table: (name: string) => { put: (r: unknown) => Promise<void>; count: () => Promise<number>; toArray: () => Promise<unknown[]> }
    }

    // Peupler plusieurs tables métier avec des données de test.
    await db.table('salon').put({ id: 'salon-test', name: 'Test Salon' })
    await db.table('settings').put({ id: 'default', theme: 'dark', updatedAt: now })
    await db.table('categories').put({ id: 'cat-1', scope: 'revenue', code: 'c', label: 'Test', isArchived: false })
    await db.table('services').put({ id: 'svc-1', categoryCode: 'c', label: 'Test', isActive: true })
    await db.table('employees').put({ id: 'emp-1', fullName: 'Emp', role: 'cashier', isActive: true, hireDate: now })
    await db.table('revenues').put({ id: 'rev-1', date: now, label: 'R', amount: 100, categoryCode: 'c', paymentMethod: 'cash', isArchived: false })
    await db.table('expenses').put({ id: 'exp-1', date: now, label: 'E', amount: 100, categoryCode: 'c', paymentMethod: 'cash', isArchived: false })
    await db.table('products').put({ id: 'prod-1', sku: 'SKU', label: 'P', categoryCode: 'c', quantity: 10, alertThreshold: 2, isActive: true })
    await db.table('stockMovements').put({ id: 'sm-1', productId: 'prod-1', type: 'in', occurredAt: now, quantity: 10 })
    await db.table('cashSessions').put({ id: 'cash-1', status: 'open', openedAt: now })
    await db.table('cashMovements').put({ id: 'cm-1', sessionId: 'cash-1', type: 'in', occurredAt: now, amount: 1000 })
    await db.table('advances').put({ id: 'adv-1', employeeId: 'emp-1', periodMonth: '2026-10', amount: 2000, settledInPayrollId: null, isArchived: false })
    await db.table('bonuses').put({ id: 'bon-1', employeeId: 'emp-1', periodMonth: '2026-10', amount: 1000 })
    await db.table('salaryPayments').put({ id: 'sal-1', employeeId: 'emp-1', periodMonth: '2026-10', amount: 50000, status: 'paid' })
    await db.table('budgets').put({ id: 'bud-1', periodMonth: '2026-10', kind: 'revenue', categoryCode: 'c', amount: 100000 })
    await db.table('recurringExpenses').put({ id: 'rec-1', categoryCode: 'c', label: 'R', amount: 3000, isActive: true })
    await db.table('correctionLogs').put({ id: 'corr-1', entityType: 'revenue', entityId: 'rev-1', createdAt: now })
    await db.table('syncTombstones').put({ id: 't:rev-1', entityType: 'revenue', entityId: 'rev-1', deletedAt: now })

    // Préserver un compte local (doit survivre à la purge).
    await db.table('users').put({ id: 'user-1', email: 'test@salon.ci', fullName: 'U', role: 'manager', isActive: true, passwordHash: 'hash', createdAt: now, updatedAt: now })

    // Purge.
    await repo.purgeLocalDatabase()

    // Toutes les tables métier doivent être vides.
    const tableNames = [
      'salon', 'settings', 'categories', 'services', 'employees', 'revenues',
      'expenses', 'products', 'stockMovements', 'cashSessions', 'cashMovements',
      'advances', 'bonuses', 'salaryPayments', 'budgets', 'recurringExpenses',
      'correctionLogs', 'syncTombstones',
    ]
    for (const tableName of tableNames) {
      const count = await repo.tableCount(tableName)
      expect(count).toBe(0)
    }

    // Les comptes locaux doivent être préservés.
    const users = await repo.tableCount('users')
    expect(users).toBe(1)
  })

  it('Scénarios 6 & 10 : Rendu UI des onglets, mention obligatoire mode local et export CSV des rapports', async () => {
    const user = userEvent.setup()
    const createObjSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:mock-csv')
    const revokeObjSpy = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => {})

    await repo.addRevenue({
      date: new Date().toISOString(),
      label: 'Coloration intégrale',
      categoryCode: 'care_coloring',
      amount: 15000,
      paymentMethod: 'wave',
    })

    render(
      <ToastProvider>
        <SalonStoreProvider repository={repo}>
          <MemoryRouter initialEntries={['/dashboard']}>
            <AppRoutes />
          </MemoryRouter>
        </SalonStoreProvider>
      </ToastProvider>,
    )

    // Vérifier le rendu du tableau de bord et la présence de la recette dans les opérations récentes
    await waitFor(() => {
      expect(screen.getByText('Coloration intégrale')).toBeInTheDocument()
    })
    expect(screen.getAllByText(/15 000 FCFA/).length).toBeGreaterThan(0)

    // Naviguer vers Rapports et tester l'export CSV
    await user.click(screen.getAllByRole('link', { name: /Rapports/i })[0])
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /Rapports et états financiers/i }),
      ).toBeInTheDocument()
    })
    expect(
      screen.getByText(/Explication de la méthode de calcul/i),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Exporter CSV/i }))
    expect(createObjSpy).toHaveBeenCalled()

    // Naviguer vers Paramètres et vérifier la mention obligatoire exacte de la Section 16
    await user.click(screen.getAllByRole('link', { name: /Paramètres/i })[0])
    await waitFor(() => {
      expect(
        screen.getByText(
          /Version locale : les données sont enregistrées sur cet appareil\. La synchronisation entre plusieurs appareils n'est pas encore activée\./i,
        ),
      ).toBeInTheDocument()
    })

    createObjSpy.mockRestore()
    revokeObjSpy.mockRestore()
  })

  it('Budget mensuel : création, reconduction au mois suivant et suppression contrôlée', async () => {
    const revGoal = await repo.upsertBudgetTarget({
      periodMonth: '2026-09',
      kind: 'revenue_goal',
      categoryCode: 'global_revenue',
      plannedAmount: 1500000,
      note: 'Objectif rentrée',
    })
    await repo.upsertBudgetTarget({
      periodMonth: '2026-09',
      kind: 'expense_cap',
      categoryCode: 'rent',
      plannedAmount: 150000,
    })

    const copied = await repo.copyBudgetFromMonth('2026-09', '2026-10')
    expect(copied).toBe(2)

    // Un second appel ne duplique pas les lignes déjà existantes
    const copiedAgain = await repo.copyBudgetFromMonth('2026-09', '2026-10')
    expect(copiedAgain).toBe(0)

    await repo.deleteBudgetTarget(revGoal.id)
    const state = await repo.readFullState()
    const septTargets = state.budgets.filter((b) => b.periodMonth === '2026-09')
    const octTargets = state.budgets.filter((b) => b.periodMonth === '2026-10')
    expect(septTargets).toHaveLength(1)
    expect(octTargets).toHaveLength(2)
  })

  it('Catalogue prestations : interdiction de supprimer une prestation utilisée dans les recettes', async () => {
    const srv = await repo.saveService({
      name: 'Nattes collées prestige',
      categoryCode: 'tresses_nattes',
      referencePrice: 12000,
      durationMinutes: 90,
      description: ' Finition huiles naturelles',
    })

    await repo.addRevenue({
      date: '2026-10-20T14:00:00.000Z',
      label: 'Nattes collées prestige',
      categoryCode: 'braiding_weaving',
      serviceId: srv.id,
      amount: 12000,
      paymentMethod: 'cash',
    })

    // Doit refuser la suppression définitive car rattachée à l'historique financier
    await expect(repo.deleteServiceIfUnused(srv.id)).rejects.toThrow()

    // En revanche, la désactivation conserve l'historique intact
    const toggled = await repo.toggleServiceStatus(srv.id)
    expect(toggled.isActive).toBe(false)
  })

  it("Recherche rapide ⌘K et consultation du Journal d'audit dans les Rapports", async () => {
    const user = userEvent.setup()

    const rev = await repo.addRevenue({
      date: new Date().toISOString(),
      label: 'Pose perruque lace frontale',
      categoryCode: 'braiding_weaving',
      amount: 20000,
      paymentMethod: 'wave',
    })

    await repo.updateRevenue({
      id: rev.id,
      date: rev.date,
      label: 'Pose perruque lace frontale + coiffage',
      categoryCode: 'braiding_weaving',
      paymentMethod: 'wave',
      amount: 22000,
      reason: 'Ajout supplément coiffage sur facture client',
    })

    render(
      <ToastProvider>
        <SalonStoreProvider repository={repo}>
          <MemoryRouter initialEntries={['/dashboard']}>
            <AppRoutes />
          </MemoryRouter>
        </SalonStoreProvider>
      </ToastProvider>,
    )

    // Ouvrir la palette de recherche globale ⌘K
    const searchBtn = await screen.findByRole('button', {
      name: /Ouvrir la recherche rapide/i,
    })
    await user.click(searchBtn)

    const searchInput = await screen.findByLabelText(
      /Champ de recherche rapide/i,
    )
    await user.type(searchInput, 'perruque lace')

    // Cliquer sur le résultat trouvé pour naviguer vers Recettes
    const resultBtn = await screen.findByRole('button', {
      name: /Pose perruque lace frontale \+ coiffage/i,
    })
    await user.click(resultBtn)

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /Gestion des recettes/i }),
      ).toBeInTheDocument()
    })

    // Vérifier que le Journal d'audit dans Rapports affiche bien la rectification et son motif
    await user.click(screen.getAllByRole('link', { name: /Rapports/i })[0])
    const auditTab = await screen.findByRole('tab', {
      name: /Journal d'audit/i,
    })
    await user.click(auditTab)

    expect(
      await screen.findByText(/Ajout supplément coiffage sur facture client/i),
    ).toBeInTheDocument()
  })
})
