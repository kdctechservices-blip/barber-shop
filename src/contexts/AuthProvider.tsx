import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { PublicSalonUser, SalonUserAccount } from '../domain/models'
import { useSalonStore } from '../hooks/salonStoreContext'
import {
  AUTH_TOKEN_LOCAL_KEY,
  AUTH_TOKEN_SESSION_KEY,
  clearStoredSessionTokens,
  readStoredSessionTokens,
  refreshAuthSession,
  revokeSessionOnServer,
  scheduleSessionRefresh,
  storeSessionTokens,
} from '../lib/sessionClient'
import {
  AuthContext,
  type AuthMode,
  type LoginAccountParams,
  type RegisterAccountParams,
} from './authContext'

export const AUTH_USER_LOCAL_KEY = 'salon_pro_auth_user_local'
export const AUTH_USER_SESSION_KEY = 'salon_pro_auth_user_session'
export { AUTH_TOKEN_LOCAL_KEY, AUTH_TOKEN_SESSION_KEY }

function purgeLegacyStoredPins(): void {
  try {
    window.sessionStorage.removeItem('salon_pro_cloud_pin_session')
    window.localStorage.removeItem('salon_pro_cloud_pin_saved')
  } catch {
    // ignore storage errors
  }
}

function readPersistedAuth(): {
  user: PublicSalonUser | null
  token: string | null
  refreshToken: string | null
} {
  purgeLegacyStoredPins()
  try {
    const rawSession = window.sessionStorage.getItem(AUTH_USER_SESSION_KEY)
    const rawLocal = window.localStorage.getItem(AUTH_USER_LOCAL_KEY)
    const rawUser = rawSession ?? rawLocal
    const { sessionToken: token, refreshToken } = readStoredSessionTokens()

    if (!rawUser) return { user: null, token: null, refreshToken: null }
    const parsed = JSON.parse(rawUser) as PublicSalonUser
    if (!parsed?.id || !parsed?.email || !parsed?.role) {
      return { user: null, token: null, refreshToken: null }
    }
    return { user: parsed, token, refreshToken }
  } catch {
    return { user: null, token: null, refreshToken: null }
  }
}

function persistAuthSession(
  user: PublicSalonUser,
  token: string | null,
  rememberMe: boolean,
  refreshToken: string | null = null,
): void {
  purgeLegacyStoredPins()
  try {
    const serialized = JSON.stringify(user)
    window.sessionStorage.setItem(AUTH_USER_SESSION_KEY, serialized)
    if (rememberMe) {
      window.localStorage.setItem(AUTH_USER_LOCAL_KEY, serialized)
    } else {
      window.localStorage.removeItem(AUTH_USER_LOCAL_KEY)
    }
    storeSessionTokens({ sessionToken: token, refreshToken }, rememberMe)
  } catch {
    // ignore storage errors
  }
}

function clearPersistedAuthSession(): void {
  purgeLegacyStoredPins()
  try {
    window.sessionStorage.removeItem(AUTH_USER_SESSION_KEY)
    window.localStorage.removeItem(AUTH_USER_LOCAL_KEY)
  } catch {
    // ignore storage errors
  }
  clearStoredSessionTokens()
}

class ServerBusinessAuthError extends Error {}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { mutate, syncWithRepo } = useSalonStore()

  const [currentUser, setCurrentUser] = useState<PublicSalonUser | null>(
    () => readPersistedAuth().user,
  )
  const [localAccounts, setLocalAccounts] = useState<PublicSalonUser[]>([])
  const [sessionToken, setSessionToken] = useState<string | null>(
    () => readPersistedAuth().token,
  )
  const [authReady, setAuthReady] = useState(false)
  const [hasAnyManager, setHasAnyManager] = useState(false)
  const [authMode, setAuthMode] = useState<AuthMode>('checking')

  const refreshAuthStatus = useCallback(async () => {
    purgeLegacyStoredPins()
    const { hasMgr: localHasManager, accounts } = await syncWithRepo(
      async (repo) => {
        const [hasMgr, allUsers] = await Promise.all([
          repo.hasAnyManagerAccount(),
          repo.listUserAccounts(),
        ])
        if (hasMgr || currentUser) {
          await repo.purgeLegacyMockData()
        }
        return {
          hasMgr,
          accounts: allUsers.filter((u) => u.isActive),
        }
      },
    )
    setLocalAccounts(accounts)

    let remoteHasManager = false
    let cloudReachable = false

    if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
      try {
        const resp = await window.fetch('/api/auth/status', { method: 'GET' })
        if (resp.ok) {
          const data = (await resp.json()) as {
            ok?: boolean
            hasManager?: boolean
          }
          if (data.ok) {
            cloudReachable = true
            remoteHasManager = Boolean(data.hasManager)
          }
        }
      } catch {
        // Hors-ligne ou environnement de test sans serveur HTTP
      }
    }

    setHasAnyManager(localHasManager || remoteHasManager)
    setAuthMode(cloudReachable ? 'cloud_neon' : 'local_offline')
    setAuthReady(true)
  }, [currentUser, syncWithRepo])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await refreshAuthStatus()
      if (cancelled) return
    })()
    return () => {
      cancelled = true
    }
  }, [refreshAuthStatus])

  const register = useCallback(
    async (params: RegisterAccountParams): Promise<PublicSalonUser> => {
      const rememberMe = params.rememberMe !== false

      // 1. Tentative sur Neon PostgreSQL via /api/auth/register
      if (
        typeof window !== 'undefined' &&
        typeof window.fetch === 'function' &&
        (typeof navigator === 'undefined' || navigator.onLine !== false)
      ) {
        try {
          const resp = await window.fetch('/api/auth/register', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(sessionToken
                ? { Authorization: `Bearer ${sessionToken}` }
                : {}),
            },
            body: JSON.stringify({
              fullName: params.fullName,
              email: params.email,
              phone: params.phone,
              password: params.password,
              role: params.role,
              salonName: params.salonName,
            }),
          })

          const data = (await resp.json().catch(() => ({}))) as {
            ok?: boolean
            code?: string
            message?: string
            user?: PublicSalonUser
            recordForCache?: SalonUserAccount
            sessionToken?: string
            refreshToken?: string
          }

          if (resp.ok && data.ok && data.user) {
            const refreshedAccounts = await mutate(async (repo) => {
              if (data.recordForCache) {
                await repo.cacheRemoteUserAccount(data.recordForCache)
              }
              if (!hasAnyManager && params.role === 'manager') {
                await repo.updateSalonInfo({
                  ...(params.salonName?.trim()
                    ? { name: params.salonName.trim() }
                    : {}),
                  managerName: params.fullName.trim(),
                  ...(params.phone?.trim()
                    ? { phone: params.phone.trim() }
                    : {}),
                })
              }
              await repo.purgeLegacyMockData()
              return (await repo.listUserAccounts()).filter((u) => u.isActive)
            })
            const nextToken = data.sessionToken ?? null
            setLocalAccounts(refreshedAccounts)
            setCurrentUser(data.user)
            setSessionToken(nextToken)
            setHasAnyManager(true)
            setAuthMode('cloud_neon')
            persistAuthSession(
              data.user,
              nextToken,
              rememberMe,
              data.refreshToken ?? null,
            )
            return data.user
          }

          if (
            resp.status !== 503 &&
            resp.status !== 502 &&
            resp.status !== 404 &&
            data.code !== 'NETWORK_UNREACHABLE' &&
            data.code !== 'DB_NOT_CONFIGURED'
          ) {
            throw new ServerBusinessAuthError(
              data.message ?? 'Inscription refusée par le serveur.',
            )
          }
        } catch (err) {
          if (err instanceof ServerBusinessAuthError) {
            throw err
          }
        }
      }

      // 2. Continuité locale Hors-Ligne (IndexedDB)
      const { created: localUser, accounts: updatedLocalAccounts } =
        await mutate(async (repo) => {
          const created = await repo.registerLocalUserAccount({
            fullName: params.fullName,
            email: params.email,
            phone: params.phone,
            password: params.password,
            role: params.role,
            salonName: params.salonName,
            callerIsAuthenticatedManager: currentUser?.role === 'manager',
          })
          await repo.purgeLegacyMockData()
          const accounts = (await repo.listUserAccounts()).filter(
            (u) => u.isActive,
          )
          return { created, accounts }
        })

      setLocalAccounts(updatedLocalAccounts)
      setCurrentUser(localUser)
      setSessionToken(null)
      setHasAnyManager(true)
      setAuthMode('local_offline')
      persistAuthSession(localUser, null, rememberMe)
      return localUser
    },
    [currentUser?.role, hasAnyManager, mutate, sessionToken],
  )

  const login = useCallback(
    async (params: LoginAccountParams): Promise<PublicSalonUser> => {
      const rememberMe = params.rememberMe !== false

      // 1. Tentative sur Neon PostgreSQL via /api/auth/login
      if (
        typeof window !== 'undefined' &&
        typeof window.fetch === 'function' &&
        (typeof navigator === 'undefined' || navigator.onLine !== false)
      ) {
        try {
          const resp = await window.fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: params.email,
              password: params.password,
            }),
          })

          const data = (await resp.json().catch(() => ({}))) as {
            ok?: boolean
            code?: string
            message?: string
            user?: PublicSalonUser
            recordForCache?: SalonUserAccount
            sessionToken?: string
            refreshToken?: string
          }

          if (resp.ok && data.ok && data.user) {
            const refreshedAccounts = await syncWithRepo(async (repo) => {
              if (data.recordForCache) {
                await repo.cacheRemoteUserAccount(data.recordForCache)
              }
              await repo.purgeLegacyMockData()
              return (await repo.listUserAccounts()).filter((u) => u.isActive)
            })
            const nextToken = data.sessionToken ?? null
            setLocalAccounts(refreshedAccounts)
            setCurrentUser(data.user)
            setSessionToken(nextToken)
            setAuthMode('cloud_neon')
            persistAuthSession(
              data.user,
              nextToken,
              rememberMe,
              data.refreshToken ?? null,
            )
            return data.user
          }

          if (resp.status === 403 && data.code === 'ACCOUNT_DISABLED') {
            throw new ServerBusinessAuthError(
              data.message ?? 'Ce compte a été désactivé par le Gérant.',
            )
          }

          if (resp.status === 401) {
            try {
              const localFallback = await syncWithRepo(async (repo) => {
                const authed = await repo.authenticateLocalUserAccount({
                  email: params.email,
                  password: params.password,
                })
                await repo.purgeLegacyMockData()
                return authed
              })
              setCurrentUser(localFallback)
              setSessionToken(null)
              persistAuthSession(localFallback, null, rememberMe)
              return localFallback
            } catch (localErr) {
              throw new ServerBusinessAuthError(
                localErr instanceof Error
                  ? localErr.message
                  : 'Adresse e-mail ou mot de passe incorrect.',
              )
            }
          }
        } catch (err) {
          if (err instanceof ServerBusinessAuthError) {
            throw err
          }
        }
      }

      // 2. Continuité locale Hors-Ligne (IndexedDB)
      const { authed: localUser, accounts: nextLocalAccounts } =
        await syncWithRepo(async (repo) => {
          const authed = await repo.authenticateLocalUserAccount({
            email: params.email,
            password: params.password,
          })
          await repo.purgeLegacyMockData()
          const accounts = (await repo.listUserAccounts()).filter(
            (u) => u.isActive,
          )
          return { authed, accounts }
        })
      setLocalAccounts(nextLocalAccounts)
      setCurrentUser(localUser)
      setSessionToken(null)
      setAuthMode('local_offline')
      persistAuthSession(localUser, null, rememberMe)
      return localUser
    },
    [syncWithRepo],
  )

  const logout = useCallback(() => {
    // Révocation immédiate côté serveur (la session ne survit pas à la déconnexion).
    void revokeSessionOnServer()
    clearPersistedAuthSession()
    setCurrentUser(null)
    setSessionToken(null)
  }, [])

  // Rotation automatique du jeton d'accès avant expiration (15 min).
  useEffect(() => {
    if (!sessionToken) return undefined
    return scheduleSessionRefresh(
      (session) => {
        setSessionToken(session.sessionToken)
      },
      () => {
        clearPersistedAuthSession()
        setCurrentUser(null)
        setSessionToken(null)
      },
    )
  }, [sessionToken])

  // Si l'onglet redevient actif avec un jeton expiré, on rafraîchit tout de suite.
  useEffect(() => {
    if (typeof window === 'undefined' || !sessionToken) return undefined
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      const { sessionToken: stored } = readStoredSessionTokens()
      if (!stored) return
      void refreshAuthSession().then((session) => {
        if (session) setSessionToken(session.sessionToken)
      })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [sessionToken])

  const value = useMemo(
    () => ({
      authEnforced: true,
      authReady,
      hasAnyManager,
      authMode,
      currentUser,
      localAccounts,
      sessionToken,
      refreshAuthStatus,
      login,
      register,
      logout,
    }),
    [
      authReady,
      hasAnyManager,
      authMode,
      currentUser,
      localAccounts,
      sessionToken,
      refreshAuthStatus,
      login,
      register,
      logout,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
