/**
 * Gestion côté navigateur des jetons de session (S4).
 *
 * Le jeton d'accès est court (15 min) et signé ; le jeton de rafraîchissement
 * est opaque, à usage unique et **fait tourner** à chaque appel. Ce module
 * centralise leur stockage, le rafraîchissement automatique (avec verrou
 * anti-concurrence) et la révocation serveur à la déconnexion.
 */

export const AUTH_TOKEN_LOCAL_KEY = 'salon_pro_auth_token_local'
export const AUTH_TOKEN_SESSION_KEY = 'salon_pro_auth_token_session'
export const AUTH_REFRESH_LOCAL_KEY = 'salon_pro_auth_refresh_local'
export const AUTH_REFRESH_SESSION_KEY = 'salon_pro_auth_refresh_session'

export interface SessionTokens {
  sessionToken: string | null
  refreshToken: string | null
}

export interface RefreshedSession extends SessionTokens {
  expiresAt: number
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function readStoredSessionTokens(): SessionTokens {
  const sessionStore = safeSessionStorage()
  const localStore = safeLocalStorage()
  return {
    sessionToken:
      sessionStore?.getItem(AUTH_TOKEN_SESSION_KEY) ??
      localStore?.getItem(AUTH_TOKEN_LOCAL_KEY) ??
      null,
    refreshToken:
      sessionStore?.getItem(AUTH_REFRESH_SESSION_KEY) ??
      localStore?.getItem(AUTH_REFRESH_LOCAL_KEY) ??
      null,
  }
}

export function storeSessionTokens(
  tokens: SessionTokens,
  rememberMe: boolean,
): void {
  const sessionStore = safeSessionStorage()
  const localStore = safeLocalStorage()

  try {
    sessionStore?.removeItem(AUTH_TOKEN_SESSION_KEY)
    sessionStore?.removeItem(AUTH_REFRESH_SESSION_KEY)
    localStore?.removeItem(AUTH_TOKEN_LOCAL_KEY)
    localStore?.removeItem(AUTH_REFRESH_LOCAL_KEY)

    if (tokens.sessionToken) {
      sessionStore?.setItem(AUTH_TOKEN_SESSION_KEY, tokens.sessionToken)
    }
    if (tokens.refreshToken) {
      sessionStore?.setItem(AUTH_REFRESH_SESSION_KEY, tokens.refreshToken)
    }
    if (rememberMe) {
      if (tokens.sessionToken) {
        localStore?.setItem(AUTH_TOKEN_LOCAL_KEY, tokens.sessionToken)
      }
      if (tokens.refreshToken) {
        localStore?.setItem(AUTH_REFRESH_LOCAL_KEY, tokens.refreshToken)
      }
    }
  } catch {
    // Stockage indisponible (mode privé strict) : la session reste en mémoire.
  }
}

export function clearStoredSessionTokens(): void {
  const sessionStore = safeSessionStorage()
  const localStore = safeLocalStorage()
  try {
    sessionStore?.removeItem(AUTH_TOKEN_SESSION_KEY)
    sessionStore?.removeItem(AUTH_REFRESH_SESSION_KEY)
    localStore?.removeItem(AUTH_TOKEN_LOCAL_KEY)
    localStore?.removeItem(AUTH_REFRESH_LOCAL_KEY)
  } catch {
    // ignore storage errors
  }
}

/**
 * Lit la date d'expiration d'un jeton d'accès **sans le vérifier** : cette
 * information ne sert qu'à programmer le rafraîchissement, jamais à autoriser
 * une opération (seul le serveur tranche).
 */
export function readAccessTokenExpiry(token: string | null): number | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const json = JSON.parse(
      atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')),
    ) as { exp?: number }
    return typeof json.exp === 'number' ? json.exp : null
  } catch {
    return null
  }
}

let refreshInFlight: Promise<RefreshedSession | null> | null = null

/**
 * Rafraîchit la session (rotation du jeton). Un seul appel réseau à la fois :
 * plusieurs requêtes simultanées en 401 ne doivent pas révoquer la session en
 * rejouant le même jeton de rafraîchissement.
 */
export async function refreshAuthSession(): Promise<RefreshedSession | null> {
  if (refreshInFlight) return refreshInFlight

  const { refreshToken } = readStoredSessionTokens()
  if (!refreshToken) return null
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') {
    return null
  }

  refreshInFlight = (async () => {
    try {
      const resp = await window.fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      })
      const data = (await resp.json().catch(() => ({}))) as {
        ok?: boolean
        sessionToken?: string
        refreshToken?: string
        expiresAt?: number
      }
      if (!resp.ok || !data.ok || !data.sessionToken || !data.refreshToken) {
        // Session close ou jeton rejoué : on nettoie, l'utilisateur se reconnecte.
        clearStoredSessionTokens()
        return null
      }
      const rememberMe = Boolean(
        safeLocalStorage()?.getItem(AUTH_TOKEN_LOCAL_KEY),
      )
      const next: RefreshedSession = {
        sessionToken: data.sessionToken,
        refreshToken: data.refreshToken,
        expiresAt: data.expiresAt ?? Date.now() + 15 * 60_000,
      }
      storeSessionTokens(next, rememberMe)
      return next
    } catch {
      // Hors-ligne : on conserve les jetons, la session locale reste utilisable.
      return null
    } finally {
      refreshInFlight = null
    }
  })()

  return refreshInFlight
}

/** Révoque la session côté serveur (déconnexion immédiate, idempotente). */
export async function revokeSessionOnServer(): Promise<void> {
  const { sessionToken, refreshToken } = readStoredSessionTokens()
  if (!sessionToken && !refreshToken) return
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') {
    return
  }
  try {
    await window.fetch('/api/auth/logout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      },
      body: JSON.stringify(refreshToken ? { refreshToken } : {}),
    })
  } catch {
    // Hors-ligne : la session expirera d'elle-même (15 min).
  }
}

/**
 * `fetch` authentifié : ajoute le jeton courant et, sur 401, tente **une**
 * rotation de session avant de rejouer la requête.
 */
export async function fetchWithSession(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const attempt = async (token: string | null): Promise<Response> =>
    window.fetch(input, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })

  const first = await attempt(readStoredSessionTokens().sessionToken)
  if (first.status !== 401) return first

  const refreshed = await refreshAuthSession()
  if (!refreshed?.sessionToken) return first
  return attempt(refreshed.sessionToken)
}

/**
 * Programme un rafraîchissement automatique 60 s avant l'expiration.
 * Renvoie une fonction d'arrêt (à appeler au démontage).
 */
export function scheduleSessionRefresh(
  onRefreshed: (session: RefreshedSession) => void,
  onExpired: () => void,
): () => void {
  if (typeof window === 'undefined') return () => {}

  let timer: ReturnType<typeof setTimeout> | null = null
  let cancelled = false

  const arm = (): void => {
    if (cancelled) return
    const { sessionToken } = readStoredSessionTokens()
    const expiry = readAccessTokenExpiry(sessionToken)
    if (!expiry) return
    const delay = Math.max(5_000, expiry - Date.now() - 60_000)
    timer = setTimeout(() => {
      void (async () => {
        const refreshed = await refreshAuthSession()
        if (cancelled) return
        if (refreshed) {
          onRefreshed(refreshed)
          arm()
        } else {
          onExpired()
        }
      })()
    }, delay)
  }

  arm()

  return () => {
    cancelled = true
    if (timer) clearTimeout(timer)
  }
}
