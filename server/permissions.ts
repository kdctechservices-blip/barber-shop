import type { UserRole } from '../src/domain/models/index.ts'

/**
 * Garde de rôle par entité métier (P1, suite de l'audit §6.1 S3).
 *
 * Un Caissier manipule les opérations du quotidien (recettes, dépenses, caisse,
 * stock) mais **ne peut pas** toucher à la configuration du salon, aux
 * référentiels (prestations, employés, produits), aux budgets, aux salaires,
 * aux avances ni aux journaux de correction. Ces tables restent réservées au
 * Gérant.
 *
 * Aucune suppression n'est autorisée pour un Caissier : une annulation passe
 * par les mécanismes métier (drapeau d'annulation), pas par un effacement.
 *
 * Un acteur sans rôle (synchronisation machine par PIN, scripts de maintenance)
 * n'est pas filtré : ce chemin est déjà restreint par le secret serveur.
 */

/** Tables qu'un Caissier peut créer ou modifier. */
const CASHIER_WRITABLE_TABLES = new Set([
  'revenues',
  'expenses',
  'cash_sessions',
  'cash_movements',
  'stock_movements',
])

/** Entités qu'un Caissier peut supprimer. */
const CASHIER_DELETABLE_ENTITIES = new Set<string>([])

export function canWriteTable(role: UserRole | undefined, table: string): boolean {
  if (!role || role === 'manager') return true
  return CASHIER_WRITABLE_TABLES.has(table)
}

export function canDeleteEntity(
  role: UserRole | undefined,
  entityType: string,
): boolean {
  if (!role || role === 'manager') return true
  return CASHIER_DELETABLE_ENTITIES.has(entityType)
}

export const PERMISSION_POLICY = {
  cashierWritableTables: [...CASHIER_WRITABLE_TABLES],
  cashierDeletableEntities: [...CASHIER_DELETABLE_ENTITIES],
} as const
