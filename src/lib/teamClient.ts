import { fetchWithSession } from './sessionClient'

/**
 * Client navigateur de l'équipe et des salons (Sprint 8).
 *
 * S'appuie sur `fetchWithSession` (jeton courant + rotation automatique sur
 * 401) et sur des URL **relatives** : aucune adresse de backend en dur côté
 * navigateur.
 *
 * Rappel de conception : `salon_users` porte l'identité, `memberships` porte le
 * rôle et l'activation **par salon**. L'écran Équipe ne modifie donc jamais un
 * rôle sans passer par l'API serveur (qui vérifie le rôle Gérant en base).
 */

export interface TeamMember {
  id: string
  fullName: string
  email: string
  phone?: string
  role: 'manager' | 'cashier'
  isActive: boolean
  lastLoginAt?: string
  createdAt?: string
  updatedAt?: string
}

export interface TenantMembership {
  tenantId: string
  name: string
  slug: string | null
  role: 'manager' | 'cashier'
  isActive: boolean
}

export interface TeamMembersResult {
  members: TeamMember[]
}

export interface TenantListResult {
  tenants: TenantMembership[]
  activeTenantId: string | null
}

export interface SwitchedTenant {
  sessionToken: string
  refreshToken: string
  tenantId: string
  user: TeamMember
}

export class TeamApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'TeamApiError'
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
): TeamApiError {
  return new TeamApiError(
    response.status,
    typeof payload.code === 'string' ? payload.code : 'TEAM_API_ERROR',
    typeof payload.message === 'string' ? payload.message : fallback,
  )
}

/** Comptes du salon actif (jamais de hash de mot de passe renvoyé). */
export async function fetchTeamMembers(): Promise<TeamMember[]> {
  const response = await fetchWithSession('/api/users')
  const payload = await readJson(response)
  if (!response.ok) {
    throw toError(response, payload, 'Impossible de charger l’équipe du salon.')
  }
  return Array.isArray(payload.users) ? (payload.users as TeamMember[]) : []
}

/** Salons du compte connecté, avec le rôle réel dans chacun. */
export async function fetchTenantMemberships(): Promise<TenantListResult> {
  const response = await fetchWithSession('/api/auth/tenants')
  const payload = await readJson(response)
  if (!response.ok) {
    throw toError(response, payload, 'Impossible de charger vos salons.')
  }
  return {
    tenants: Array.isArray(payload.tenants)
      ? (payload.tenants as TenantMembership[])
      : [],
    activeTenantId:
      typeof payload.activeTenantId === 'string'
        ? payload.activeTenantId
        : null,
  }
}

/**
 * Ajoute un collaborateur au salon actif.
 *
 * Le mot de passe est transmis en clair sur HTTPS puis **haché côté serveur** :
 * le navigateur ne stocke ni ne calcule aucun hash ici.
 */
export async function addTeamMember(input: {
  fullName: string
  email: string
  phone?: string
  password: string
  role: 'manager' | 'cashier'
}): Promise<TeamMember> {
  const response = await fetchWithSession('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const payload = await readJson(response)
  if (!response.ok) {
    throw toError(
      response,
      payload,
      'Impossible d’ajouter ce collaborateur au salon.',
    )
  }
  return payload.user as TeamMember
}

/** Rôle, activation, identité ou réinitialisation de mot de passe. */
export async function updateTeamMember(
  memberId: string,
  patch: {
    fullName?: string
    phone?: string
    role?: 'manager' | 'cashier'
    isActive?: boolean
    password?: string
  },
): Promise<TeamMember> {
  const response = await fetchWithSession(`/api/users/${memberId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const payload = await readJson(response)
  if (!response.ok) {
    throw toError(
      response,
      payload,
      'Impossible de mettre à jour ce collaborateur.',
    )
  }
  return payload.user as TeamMember
}

/**
 * Bascule de salon : le serveur vérifie l'appartenance **en base**, révoque
 * l'ancienne session et émet un jeton porteur du rôle du salon cible.
 */
export async function switchActiveTenant(
  tenantId: string,
): Promise<SwitchedTenant> {
  const response = await fetchWithSession('/api/auth/switch-tenant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId }),
  })
  const payload = await readJson(response)
  if (!response.ok) {
    throw toError(response, payload, 'Impossible de changer de salon.')
  }
  return {
    sessionToken: String(payload.sessionToken ?? ''),
    refreshToken: String(payload.refreshToken ?? ''),
    tenantId: String(payload.tenantId ?? tenantId),
    user: payload.user as TeamMember,
  }
}
