import { createContext, useContext } from 'react'
import type { PublicSalonUser, UserRole } from '../domain/models'
import type { TenantMembership } from '../lib/teamClient'

export type AuthMode = 'checking' | 'cloud_neon' | 'local_offline'

export interface RegisterAccountParams {
  fullName: string
  email: string
  phone?: string
  password: string
  role: UserRole
  salonName?: string
  rememberMe?: boolean
}

export interface LoginAccountParams {
  email: string
  password: string
  rememberMe?: boolean
}

export interface AuthContextValue {
  authEnforced: boolean
  authReady: boolean
  hasAnyManager: boolean
  authMode: AuthMode
  currentUser: PublicSalonUser | null
  localAccounts: PublicSalonUser[]
  sessionToken: string | null
  /** Salons du compte connecté (vide hors mode cloud). */
  tenants: TenantMembership[]
  /** Salon de la session courante (claim `tid`). */
  activeTenantId: string | null
  refreshTenants: () => Promise<void>
  switchTenant: (tenantId: string) => Promise<void>
  refreshAuthStatus: () => Promise<void>
  login: (params: LoginAccountParams) => Promise<PublicSalonUser>
  register: (params: RegisterAccountParams) => Promise<PublicSalonUser>
  logout: () => void
}

export const MANAGER_ONLY_PREFIXES = [
  '/budget',
  '/employees',
  '/payroll',
  '/reports',
  '/settings',
  '/team',
] as const

export function canUserAccessPath(
  role: UserRole | undefined,
  pathname: string,
): boolean {
  if (!role || role === 'manager') return true
  return !MANAGER_ONLY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

const FALLBACK_MANAGER_USER: PublicSalonUser = {
  id: 'default-local-manager',
  fullName: 'Gérant',
  email: 'gerant@salon.local',
  role: 'manager',
  isActive: true,
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
}

const FALLBACK_AUTH_CONTEXT: AuthContextValue = {
  authEnforced: false,
  authReady: true,
  hasAnyManager: true,
  authMode: 'local_offline',
  currentUser: FALLBACK_MANAGER_USER,
  localAccounts: [],
  sessionToken: null,
  tenants: [],
  activeTenantId: null,
  refreshTenants: async () => {},
  switchTenant: async () => {},
  refreshAuthStatus: async () => {},
  login: async () => FALLBACK_MANAGER_USER,
  register: async () => FALLBACK_MANAGER_USER,
  logout: () => {},
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  return useContext(AuthContext) ?? FALLBACK_AUTH_CONTEXT
}
