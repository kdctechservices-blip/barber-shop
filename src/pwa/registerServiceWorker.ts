/**
 * Enregistrement du service worker hors-ligne (P0-7).
 *
 * - jamais en développement (le service worker masquerait le HMR) ;
 * - jamais dans les environnements sans `serviceWorker` (jsdom, tests) ;
 * - met à jour l'application sans casser une saisie en cours : la nouvelle
 *   version attend, et n'est activée que sur demande explicite.
 */

export interface OfflineUpdateHandle {
  /** Installe la nouvelle version et recharge la page. */
  apply: () => void
}

export interface RegisterOfflineOptions {
  url?: string
  scope?: string
  onUpdateReady?: (handle: OfflineUpdateHandle) => void
  onRegistered?: (registration: ServiceWorkerRegistration) => void
}

function isSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    (window.location.protocol === 'https:' ||
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1')
  )
}

export function registerOfflineServiceWorker(
  options: RegisterOfflineOptions = {},
): boolean {
  if (!isSupported()) return false
  // En développement, le service worker n'est pas généré (`vite build` only).
  if (import.meta.env?.DEV) return false

  const url = options.url ?? '/sw.js'
  const scope = options.scope ?? '/'

  const start = (): void => {
    void navigator.serviceWorker
      .register(url, { scope })
      .then((registration) => {
        options.onRegistered?.(registration)

        const notifyIfWaiting = (): void => {
          if (!registration.waiting || !navigator.serviceWorker.controller) {
            return
          }
          options.onUpdateReady?.({
            apply: () => {
              registration.waiting?.postMessage({ type: 'SKIP_WAITING' })
            },
          })
        }

        notifyIfWaiting()
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing
          installing?.addEventListener('statechange', () => {
            if (installing.state === 'installed') notifyIfWaiting()
          })
        })

        let refreshed = false
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (refreshed) return
          refreshed = true
          window.location.reload()
        })
      })
      .catch((error: unknown) => {
        console.warn(
          '[pwa] Enregistrement du service worker impossible :',
          error instanceof Error ? error.message : String(error),
        )
      })
  }

  if (document.readyState === 'complete') {
    start()
  } else {
    window.addEventListener('load', start, { once: true })
  }
  return true
}
