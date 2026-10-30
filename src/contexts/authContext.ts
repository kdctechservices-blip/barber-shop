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
  '/billing',
  '/budget',
  '/devices',
  '/employees',
  '/invoices',
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

/**
 * Niveau d'accès à un champ par rôle.
 * - 'readwrite' : lisible et modifiable par tous les rôles connectés.
 * - 'read'      : lisible par tous, modifiable uniquement par le Gérant.
 * - 'manager'   : lisible et modifiable uniquement par le Gérant (invisible pour le Caissier).
 * - 'hidden'    : masqué pour le Caissier.
 */
export type FieldAccess = 'readwrite' | 'read' | 'manager' | 'hidden'

/**
 * Règles de droits par champ, par écran/formulaire.
 * Clé = identifiant d'écran (ex: 'services', 'employees', 'settings', 'salon_info').
 * Valeur = mapping nom de champ -> niveau d'accès.
 */
export const FIELD_PERMISSIONS: Record<
  string,
  Record<string, FieldAccess>
> = {
  services: {
    name: 'readwrite',
    categoryCode: 'readwrite',
    durationMinutes: 'readwrite',
    price: 'manager',
    commissionRate: 'manager',
    isActive: 'manager',
    description: 'readwrite',
  },
  employees: {
    fullName: 'readwrite',
    email: 'readwrite',
    phone: 'readwrite',
    role: 'manager',
    baseSalary: 'manager',
    commissionRate: 'manager',
    isActive: 'manager',
    hireDate: 'readwrite',
  },
  settings: {
    salonName: 'manager',
    salonAddress: 'manager',
    salonPhone: 'manager',
    salonEmail: 'manager',
    theme: 'readwrite',
    currency: 'manager',
    taxRate: 'manager',
  },
  salon_info: {
    name: 'manager',
    address: 'manager',
    phone: 'manager',
    email: 'manager',
    siret: 'manager',
    logoUrl: 'manager',
  },
  cash_session: {
    openingAmount: 'readwrite',
    closingAmount: 'read',
    status: 'manager',
  },
}

/**
 * Retourne le niveau d'accès d'un champ pour un écran donné.
 */
export function getFieldAccess(
  screen: string,
  field: string,
): FieldAccess {
  return FIELD_PERMISSIONS[screen]?.[field] ?? 'readwrite'
}

/**
 * Vérifie si un rôle donné peut écrire sur un champ d'un écran.
 */
export function canWriteField(
  role: UserRole | undefined,
  screen: string,
  field: string,
): boolean {
  if (!role || role === 'manager') return true
  const access = getFieldAccess(screen, field)
  return access === 'readwrite'
}

/**
 * Vérifie si un champ est visible pour un rôle donné.
 */
export function canSeeField(
  role: UserRole | undefined,
  screen: string,
  field: string,
): boolean {
  if (!role || role === 'manager') return true
  const access = getFieldAccess(screen, field)
  return access !== 'hidden' && access !== 'manager'
}

export interface UseFieldAuthOptions {
  screen: string
}

/**
 * Hook exposant les helpers de droits par champ pour un écran donné.
 */
export function useFieldAuth(options: UseFieldAuthOptions) {
  const { currentUser } = useAuth()
  const role = currentUser?.role

  return {
    canWrite: (field: string) => canWriteField(role, options.screen, field),
    canSee: (field: string) => canSeeField(role, options.screen, field),
    role,
    isManager: role === 'manager',
  }
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
