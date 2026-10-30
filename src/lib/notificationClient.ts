/**
 * SALON PRO — Client de notifications (côté navigateur).
 *
 * Appelle l'API serveur `/api/notifications/send` qui utilise un NotificationProvider
 * configuré côté serveur (sans secret côté client).
 */

import type {
  NotificationSendRequest,
  NotificationSendResult,
} from '../domain/notifications/notificationService'

const API_BASE = ''

export async function sendNotification(
  request: Omit<NotificationSendRequest, 'salonName'>,
): Promise<NotificationSendResult> {
  const resp = await fetch(`${API_BASE}/api/notifications/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as {
      message?: string
    }
    return { ok: false, error: body.message ?? 'Échec de l’envoi de notification.' }
  }
  return (await resp.json()) as NotificationSendResult
}

export class NoOpNotificationProvider {
  async send(): Promise<NotificationSendResult> {
    return { ok: true, messageId: 'noop' }
  }
}
