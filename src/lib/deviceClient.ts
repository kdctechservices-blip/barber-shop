/**
 * Client navigateur des appareils connectés (sessions actives).
 *
 * S'appuie sur `fetchWithSession` (jeton courant + rotation automatique sur
 * 401) et sur des URL relatives : aucune adresse de backend en dur côté
 * navigateur.
 */

import { fetchWithSession } from './sessionClient'

export interface ConnectedSession {
  id: string
  email: string
  role: string
  createdAt: string
  expiresAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  revokedReason: string | null
  userAgent: string | null
  ip: string | null
}

export interface ConnectedSessionsResult {
  sessions: ConnectedSession[]
}

export class DeviceApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'DeviceApiError'
    this.status = status
    this.code = code
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>
}

function toError(
  response: Response,
  payload: Record<string, unknown>,
  fallback: string,
): DeviceApiError {
  return new DeviceApiError(
    response.status,
    typeof payload.code === 'string' ? payload.code : 'DEVICE_API_ERROR',
    typeof payload.message === 'string' ? payload.message : fallback,
  )
}

/** Liste les sessions actives du salon courant (tous les appareils connectés). */
export async function fetchConnectedSessions(): Promise<ConnectedSession[]> {
  const response = await fetchWithSession('/api/sessions')
  const payload = await readJson(response)
  if (!response.ok) {
    throw toError(response, payload, 'Impossible de charger les appareils connectés.')
  }
  const raw = Array.isArray(payload.sessions) ? payload.sessions : []
  return raw.map((row: Record<string, unknown>) => ({
    id: String(row.id ?? ''),
    email: String(row.email ?? ''),
    role: String(row.role ?? ''),
    createdAt: String(row.created_at ?? ''),
    expiresAt: String(row.expires_at ?? ''),
    lastUsedAt:
      typeof row.last_used_at === 'string' ? row.last_used_at : null,
    revokedAt:
      typeof row.revoked_at === 'string' ? row.revoked_at : null,
    revokedReason:
      typeof row.revoked_reason === 'string' ? row.revoked_reason : null,
    userAgent:
      typeof row.user_agent === 'string' ? row.user_agent : null,
    ip: typeof row.ip === 'string' ? row.ip : null,
  }))
}

/** Révoque une session distante (déconnecte l'appareil concerné). */
export async function revokeConnectedSession(
  sessionId: string,
): Promise<boolean> {
  const response = await fetchWithSession(`/api/sessions/${sessionId}`, {
    method: 'DELETE',
  })
  const payload = await readJson(response)
  if (!response.ok) {
    throw toError(
      response,
      payload,
      'Impossible de révoquer cet appareil.',
    )
  }
  return Boolean(payload.revoked)
}
