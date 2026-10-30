/**
 * SALON PRO — Tâches de maintenance périodique (P1).
 *
 * Purge durable des lignes expirées ou obsolètes sur 3 tables :
 *  - sessions        : jetons révoqués > 30 j, expirés non révoqués > 30 j
 *  - sync_changes    : révisions > 10 000 et plus vieilles de 30 j par salon
 *  - subscription_events : événements > 90 j
 *
 * Chaque purge s'exécute dans une seule transaction, idempotente, et
 * retourne le nombre de lignes supprimées.
 */

import type { SqlPoolLike, SqlClientLike } from './neonClient.ts'
import { setTenantContext } from './tenantContext.ts'
import { isTenantId } from './tenantContext.ts'

const SESSIONS_RETENTION_DAYS = 30
const SYNC_CHANGES_RETENTION_DAYS = 30
const SYNC_CHANGES_KEEP_LAST_PER_TENANT = 10_000
const SUBSCRIPTION_EVENTS_RETENTION_DAYS = 90

export interface PurgeResult {
  sessions: number
  syncChanges: number
  subscriptionEvents: number
}

/** Purge les sessions expirées/révoquées anciennes (tous les salons). */
async function purgeSessions(client: SqlClientLike): Promise<number> {
  const cutoff = new Date(
    Date.now() - SESSIONS_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()
  const res = await client.query(
    `DELETE FROM sessions
       WHERE (revoked_at IS NOT NULL AND revoked_at < $1)
          OR (revoked_at IS NULL AND expires_at < $1)`,
    [cutoff],
  )
  return res.rowCount ?? 0
}

/** Purge le journal sync_changes pour un salon donné (garde les N dernières révisions). */
async function purgeSyncChangesForTenant(
  client: SqlClientLike,
  tenantId: string,
): Promise<number> {
  await setTenantContext(client, tenantId)
  const cutoff = new Date(
    Date.now() - SYNC_CHANGES_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()
  const res = await client.query(
    `DELETE FROM sync_changes
       WHERE tenant_id = $1
         AND created_at < $2
         AND seq <= (
           SELECT MAX(seq) - $3 FROM sync_changes WHERE tenant_id = $1
         )`,
    [tenantId, cutoff, SYNC_CHANGES_KEEP_LAST_PER_TENANT],
  )
  return res.rowCount ?? 0
}

/** Purge les événements d'abonnement anciens (toutes les organisations). */
async function purgeSubscriptionEvents(client: SqlClientLike): Promise<number> {
  const cutoff = new Date(
    Date.now() - SUBSCRIPTION_EVENTS_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()
  const res = await client.query(
    `DELETE FROM subscription_events WHERE created_at < $1`,
    [cutoff],
  )
  return res.rowCount ?? 0
}

/** Liste tous les tenants pour la purge ciblée de sync_changes. */
async function listTenants(client: SqlClientLike): Promise<string[]> {
  const res = await client.query<{ id: string }>('SELECT id FROM tenants')
  return res.rows.map((r) => r.id)
}

/**
 * Exécute la purge complète sur toutes les tables et tous les salons.
 * Retourne le nombre de lignes supprimées par table.
 */
export async function runMaintenancePurge(
  pool: SqlPoolLike,
): Promise<PurgeResult> {
  let sessionsDeleted = 0
  let syncChangesDeleted = 0
  let subscriptionEventsDeleted = 0

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    sessionsDeleted = await purgeSessions(client)
    subscriptionEventsDeleted = await purgeSubscriptionEvents(client)

    const tenants = await listTenants(client)
    for (const tenantId of tenants) {
      if (!isTenantId(tenantId)) continue
      syncChangesDeleted += await purgeSyncChangesForTenant(
        client,
        tenantId,
      )
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  return {
    sessions: sessionsDeleted,
    syncChanges: syncChangesDeleted,
    subscriptionEvents: subscriptionEventsDeleted,
  }
}
