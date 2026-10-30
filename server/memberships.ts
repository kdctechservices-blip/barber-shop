import type { SqlPoolLike, SqlQueryable } from './neonClient.ts'
import type { UserRole } from '../src/domain/models/index.ts'

/**
 * Appartenances aux salons (P1 — `memberships`).
 *
 * Un compte (`salon_users`, qui porte les identifiants et le hash du mot de
 * passe) est distinct de son **appartenance** à un salon : le rôle et
 * l'activation y sont stockés **par salon**. Un même utilisateur peut donc
 * travailler dans plusieurs salons avec des rôles différents.
 *
 * La table `memberships` est volontairement **hors RLS** : elle est lue pour
 * lister les salons d'un compte avant qu'un salon actif ne soit choisi, et pour
 * vérifier les droits d'un acteur. Toutes les requêtes filtrent explicitement
 * `user_id` et/ou `tenant_id` — ce filtre ne doit jamais être retiré.
 */

export interface Membership {
  tenantId: string
  userId: string
  role: UserRole
  isActive: boolean
  createdAt: string
  updatedAt: string
}

interface MembershipRow {
  tenant_id: string
  user_id: string
  role: string
  is_active: boolean
  created_at: string | Date
  updated_at: string | Date
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

function toMembership(row: MembershipRow): Membership {
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    role: row.role === 'manager' ? 'manager' : 'cashier',
    isActive: row.is_active !== false,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

/** Crée ou met à jour l'appartenance (rôle + activation) d'un compte à un salon. */
export async function upsertMembership(
  db: SqlQueryable,
  input: {
    tenantId: string
    userId: string
    role: UserRole
    isActive?: boolean
    now?: string
  },
): Promise<void> {
  const now = input.now ?? new Date().toISOString()
  await db.query(
    `INSERT INTO memberships (tenant_id, user_id, role, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET
       role = EXCLUDED.role,
       is_active = EXCLUDED.is_active,
       updated_at = EXCLUDED.updated_at`,
    [
      input.tenantId,
      input.userId,
      input.role,
      input.isActive !== false,
      now,
    ],
  )
}

/** Supprime l'appartenance (retrait d'un employé d'un salon). */
export async function deleteMembership(
  db: SqlQueryable,
  tenantId: string,
  userId: string,
): Promise<number> {
  const res = await db.query(
    'DELETE FROM memberships WHERE tenant_id = $1 AND user_id = $2',
    [tenantId, userId],
  )
  return res.rowCount ?? 0
}

export async function readMembership(
  db: SqlQueryable,
  tenantId: string,
  userId: string,
): Promise<Membership | null> {
  const res = await db.query<MembershipRow>(
    `SELECT tenant_id, user_id, role, is_active, created_at, updated_at
       FROM memberships
      WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  )
  return res.rows[0] ? toMembership(res.rows[0]) : null
}

/** Tous les salons d'un compte (ordre chronologique d'ajout). */
export async function listMembershipsForUser(
  db: SqlQueryable,
  userId: string,
): Promise<Membership[]> {
  const res = await db.query<MembershipRow>(
    `SELECT tenant_id, user_id, role, is_active, created_at, updated_at
       FROM memberships
      WHERE user_id = $1
      ORDER BY created_at ASC`,
    [userId],
  )
  return res.rows.map(toMembership)
}

/** Le compte est-il Gérant actif de ce salon ? (source de vérité des droits) */
export async function isActiveManagerOfTenant(
  pool: SqlPoolLike,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const membership = await readMembership(pool, tenantId, userId)
  return Boolean(membership && membership.isActive && membership.role === 'manager')
}
