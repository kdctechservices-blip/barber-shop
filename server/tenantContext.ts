import type { SqlClientLike, SqlPoolLike } from './neonClient.ts'

/**
 * SALON PRO — Contexte multi-tenant côté serveur.
 *
 * RÈGLE ABSOLUE (IMPLEMENTATIONS.md §1) : le tenant provient TOUJOURS du jeton
 * de session signé (claim `tid`) ou, pour la synchronisation machine historique,
 * de la configuration serveur. Il ne provient JAMAIS du corps de requête ni
 * d'un en-tête fourni par le navigateur.
 */

/** Tenant par défaut créé par la migration 002 (installations mono-salon). */
export const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001'
export const DEFAULT_ORGANIZATION_ID = '00000000-0000-0000-0000-000000000001'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isTenantId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/**
 * Tenant utilisé lorsque la requête n'a pas de session (synchronisation par
 * `SALON_SYNC_PIN`, scripts de maintenance). Peut être surchargé par
 * `SALON_DEFAULT_TENANT_ID` pour les déploiements multi-tenant.
 */
export function resolveDefaultTenantId(): string {
  const configured = (process.env.SALON_DEFAULT_TENANT_ID ?? '').trim()
  return isTenantId(configured) ? configured : DEFAULT_TENANT_ID
}

export interface TenantQueryable {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>
}

/**
 * Ouvre une transaction PostgreSQL et y fixe `app.tenant_id`, seule source
 * de vérité lue par les politiques RLS.
 *
 * `set_config(..., true)` est limité à la transaction : aucun risque de fuite
 * de contexte entre deux requêtes réutilisant la même connexion du pool.
 */
export async function withTenantClient<T>(
  pool: SqlPoolLike,
  tenantId: string,
  fn: (client: SqlClientLike) => Promise<T>,
): Promise<T> {
  if (!isTenantId(tenantId)) {
    throw new Error('Contexte multi-tenant invalide : identifiant de salon manquant.')
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId])
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Fixe le contexte tenant dans une transaction déjà ouverte. */
export async function setTenantContext(
  db: TenantQueryable,
  tenantId: string,
): Promise<void> {
  await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId])
}
