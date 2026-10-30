import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { SqlPoolLike } from './neonClient.ts'

/**
 * Sessions révocables (audit §6.1 S4).
 *
 * Modèle :
 *  - un **jeton d'accès** signé (HMAC) de courte durée (15 min) porte le claim
 *    `sid` : il identifie la session et permet de vérifier à chaque requête
 *    qu'elle n'a pas été révoquée ;
 *  - un **jeton de rafraîchissement** opaque (256 bits) est stocké côté serveur
 *    **haché** (SHA-256) : une fuite de la base ne permet pas de rejouer les
 *    sessions ;
 *  - chaque rafraîchissement **fait tourner** le jeton (l'ancien est révoqué) ;
 *    rejouer un jeton déjà utilisé révoque toute la famille (détection de vol) ;
 *  - la déconnexion révoque la session immédiatement, sans attendre l'expiration.
 *
 * La table `sessions` est volontairement **hors RLS** : retrouver une session à
 * partir d'un jeton de rafraîchissement précède la connaissance du salon. Le
 * `tenant_id` qu'elle porte est en revanche toujours vérifié applicativement.
 */

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000 // 15 minutes
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 jours

export type SessionRole = 'manager' | 'cashier'

export interface SessionOwner {
  id: string
  email: string
  role: SessionRole
  tenantId: string
}

export interface SessionMetadata {
  userAgent?: string | null
  ip?: string | null
}

export interface IssuedSession {
  sessionId: string
  refreshToken: string
  accessExpiresAt: number
  refreshExpiresAt: number
}

export interface StoredSession {
  id: string
  tenant_id: string
  user_id: string
  email: string
  role: SessionRole
  expires_at: string
  revoked_at: string | null
  revoked_reason: string | null
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url')
}

export function generateSessionId(): string {
  return randomUUID()
}

/**
 * Crée une session et renvoie le jeton de rafraîchissement en clair : il n'est
 * jamais persisté, seule son empreinte SHA-256 l'est.
 */
export async function createSession(
  pool: SqlPoolLike,
  owner: SessionOwner,
  metadata: SessionMetadata = {},
): Promise<IssuedSession> {
  const sessionId = generateSessionId()
  const refreshToken = generateRefreshToken()
  const now = Date.now()
  const accessExpiresAt = now + ACCESS_TOKEN_TTL_MS
  const refreshExpiresAt = now + REFRESH_TOKEN_TTL_MS

  await pool.query(
    `INSERT INTO sessions (id, tenant_id, user_id, email, role, refresh_token_hash, created_at, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      sessionId,
      owner.tenantId,
      owner.id,
      owner.email,
      owner.role,
      hashRefreshToken(refreshToken),
      new Date(now).toISOString(),
      new Date(refreshExpiresAt).toISOString(),
      metadata.userAgent ?? null,
      metadata.ip ?? null,
    ],
  )

  return { sessionId, refreshToken, accessExpiresAt, refreshExpiresAt }
}

/** Recherche globale (l'authentification précède la résolution du salon). */
export async function findSessionByRefreshToken(
  pool: SqlPoolLike,
  refreshToken: string,
): Promise<StoredSession | null> {
  const res = await pool.query<StoredSession>(
    `SELECT id, tenant_id, user_id, email, role, expires_at, revoked_at, revoked_reason
       FROM sessions
      WHERE refresh_token_hash = $1`,
    [hashRefreshToken(refreshToken)],
  )
  return res.rows[0] ?? null
}

export async function isSessionActive(
  pool: SqlPoolLike,
  sessionId: string,
): Promise<boolean> {
  const res = await pool.query<{ id: string }>(
    `SELECT id FROM sessions
      WHERE id = $1 AND revoked_at IS NULL AND expires_at > $2`,
    [sessionId, new Date().toISOString()],
  )
  return res.rows.length > 0
}

export async function touchSession(
  pool: SqlPoolLike,
  sessionId: string,
): Promise<void> {
  await pool.query(`UPDATE sessions SET last_used_at = $2 WHERE id = $1`, [
    sessionId,
    new Date().toISOString(),
  ])
}

export async function revokeSessionById(
  pool: SqlPoolLike,
  sessionId: string,
  reason = 'logout',
): Promise<number> {
  const res = await pool.query(
    `UPDATE sessions SET revoked_at = $2, revoked_reason = $3
      WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, new Date().toISOString(), reason],
  )
  return res.rowCount ?? 0
}

export async function revokeSessionByRefreshToken(
  pool: SqlPoolLike,
  refreshToken: string,
  reason = 'logout',
): Promise<number> {
  const res = await pool.query(
    `UPDATE sessions SET revoked_at = $2, revoked_reason = $3
      WHERE refresh_token_hash = $1 AND revoked_at IS NULL`,
    [hashRefreshToken(refreshToken), new Date().toISOString(), reason],
  )
  return res.rowCount ?? 0
}

/** Révoque toutes les sessions vivantes d'un compte (vol de jeton, panique). */
export async function revokeAllSessionsForUser(
  pool: SqlPoolLike,
  tenantId: string,
  userId: string,
  reason = 'security',
): Promise<number> {
  const res = await pool.query(
    `UPDATE sessions SET revoked_at = $3, revoked_reason = $4
      WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [tenantId, userId, new Date().toISOString(), reason],
  )
  return res.rowCount ?? 0
}
