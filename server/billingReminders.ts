/**
 * SALON PRO — Relances d'abonnement avant échéance.
 *
 * Vérifie les abonnements actifs qui arrivent à échéance dans les prochains
 * jours (J-3, J-1, J-0 par défaut) et crée un événement de relance
 * (`subscription_reminder`) dans `subscription_events` pour chaque jalon
 * atteint. Une relance n'est émise qu'une fois par jalon (déduplication sur
 * `org_id` + `event` + jalon de jours).
 *
 * Cette fonction est appelée par la route `POST /api/billing/reminders/check`
 * (réservée au canal plateforme via le code serveur). Elle n'envoie pas
 * d'e-mail/SMS elle-même : l'événement enregistré alerte l'opérateur plateforme
 * et peut alimenter un envoi externe ultérieur.
 */

import type { SqlPoolLike } from './neonClient.ts'
import { type PlanCode } from './plans.ts'
import { type Subscription } from './subscriptions.ts'

const DAY_MS = 24 * 60 * 60 * 1000

/** Jalons de relance avant échéance (en jours). */
export const REMINDER_DAYS = [3, 1, 0] as const
export type ReminderDay = (typeof REMINDER_DAYS)[number]

export interface ReminderResult {
  orgId: string
  planCode: string
  currentPeriodEnd: string | null
  daysRemaining: number
  reminderDay: ReminderDay
  eventCreated: boolean
}

function toIsoMs(value: string | Date | null): number | null {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(d.getTime()) ? null : d.getTime()
}

/**
 * Détermine si un jalon de relance est atteint aujourd'hui pour une date
 * d'échéance donnée. Retourne le nombre de jours restants si le jalon
 * correspond, sinon null.
 */
function reminderDayFor(
  periodEndMs: number,
  nowMs: number,
): ReminderDay | null {
  const daysRemaining = Math.ceil((periodEndMs - nowMs) / DAY_MS)
  // On ne relance que pour les jalons configurés, dans la fenêtre [now, now+24h[
  // pour éviter de re-déclencher plusieurs fois par jour sur le même jalon.
  for (const day of REMINDER_DAYS) {
    if (daysRemaining === day) return day
  }
  return null
}

/**
 * Vérifie tous les abonnements de l'instance et émet les relances d'échéance
 * dues. Retourne la liste des relances créées.
 */
export async function checkExpirationReminders(
  pool: SqlPoolLike,
  options?: { now?: Date },
): Promise<ReminderResult[]> {
  const now = options?.now ?? new Date()
  const nowMs = now.getTime()

  const res = await pool.query<{
    org_id: string
    plan_code: string
    status: string
    current_period_end: string | Date | null
  }>(
    `SELECT org_id, plan_code, status, current_period_end
       FROM subscriptions
      WHERE status IN ('active', 'past_due')`,
  )

  const results: ReminderResult[] = []

  for (const row of res.rows) {
    const periodEndMs = toIsoMs(row.current_period_end)
    if (periodEndMs === null) continue
    // Déjà expiré : pas de relance future.
    if (periodEndMs <= nowMs) continue

    const reminderDay = reminderDayFor(periodEndMs, nowMs)
    if (!reminderDay) continue

    // Déduplication : une relance par (org, jalon) est déjà présente ?
    const alreadyReminded = await pool.query<{ id: string }>(
      `SELECT id FROM subscription_events
        WHERE org_id = $1
          AND event = $2
          AND payload_json->>'reminder_day' = $3
          AND created_at >= $4
      LIMIT 1`,
      [
        row.org_id,
        'subscription_reminder',
        String(reminderDay),
        new Date(nowMs - DAY_MS).toISOString(),
      ],
    )
    if (alreadyReminded.rows.length > 0) continue

    await pool.query(
      `INSERT INTO subscription_events (id, org_id, event, from_plan, to_plan, actor_id, payload_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        crypto.randomUUID(),
        row.org_id,
        'subscription_reminder',
        row.plan_code,
        row.plan_code,
        'system',
        JSON.stringify({
          reminder_day: reminderDay,
          days_remaining: Math.ceil((periodEndMs - nowMs) / DAY_MS),
          period_end: new Date(periodEndMs).toISOString(),
        }),
        now.toISOString(),
      ],
    )

    results.push({
      orgId: row.org_id,
      planCode: row.plan_code,
      currentPeriodEnd: new Date(periodEndMs).toISOString(),
      daysRemaining: Math.ceil((periodEndMs - nowMs) / DAY_MS),
      reminderDay,
      eventCreated: true,
    })
  }

  return results
}

/** Résumé d'échéances proches pour l'affichage (gestionnaire / plateforme). */
export async function listUpcomingExpirations(
  pool: SqlPoolLike,
  options?: { now?: Date; withinDays?: number },
): Promise<Subscription[]> {
  const now = options?.now ?? new Date()
  const withinDays = options?.withinDays ?? 7
  const limitMs = now.getTime() + withinDays * DAY_MS

  const res = await pool.query<{
    org_id: string
    plan_code: string
    pending_plan_code: string | null
    status: string
    trial_ends_at: string | Date | null
    current_period_start: string | Date | null
    current_period_end: string | Date | null
    cancel_at_period_end: boolean
    updated_by: string | null
    created_at: string | Date
    updated_at: string | Date
  }>(
    `SELECT org_id, plan_code, pending_plan_code, status, trial_ends_at,
            current_period_start, current_period_end, cancel_at_period_end,
            updated_by, created_at, updated_at
       FROM subscriptions
      WHERE status IN ('active', 'past_due', 'pending_payment')
        AND current_period_end IS NOT NULL`,
  )

  const subs: Subscription[] = []
  for (const row of res.rows) {
    const periodEndMs = toIsoMs(row.current_period_end)
    if (periodEndMs === null) continue
    if (periodEndMs > limitMs) continue
    subs.push({
      orgId: row.org_id,
      planCode: row.plan_code as PlanCode,
      pendingPlanCode: row.pending_plan_code as PlanCode | null,
      status: row.status as any,
      trialEndsAt: row.trial_ends_at ? new Date(String(row.trial_ends_at)).toISOString() : null,
      currentPeriodStart: row.current_period_start ? new Date(String(row.current_period_start)).toISOString() : null,
      currentPeriodEnd: new Date(periodEndMs).toISOString(),
      cancelAtPeriodEnd: row.cancel_at_period_end === true,
      updatedBy: row.updated_by,
      createdAt: new Date(String(row.created_at)).toISOString(),
      updatedAt: new Date(String(row.updated_at)).toISOString(),
    })
  }
  return subs
}
