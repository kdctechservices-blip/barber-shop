import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { LocalSyncTombstone } from '../db/repositories/salonRepositories'
import type { SalonBackupPayload } from '../domain/models'
import { useSalonStore } from '../hooks/salonStoreContext'
import { fetchWithSession, readStoredSessionTokens } from '../lib/sessionClient'
import { useToast } from '../hooks/toastContext'
import { CloudSyncContext, type CloudSyncStatus } from './cloudSyncContext'

const PREFS_KEY = 'salon_pro_cloud_sync_prefs'
const CURSOR_KEY = 'salon_pro_cloud_sync_cursor'

interface StoredSyncPrefs {
  enabled: boolean
  autoSync: boolean
  lastSyncedAt: string | null
  remoteRecordsCount: number | null
}

function purgeLegacyPinStorage(): void {
  try {
    window.sessionStorage.removeItem('salon_pro_cloud_pin_session')
    window.localStorage.removeItem('salon_pro_cloud_pin_saved')
  } catch {
    // ignore
  }
}

function readStoredPrefs(): StoredSyncPrefs {
  purgeLegacyPinStorage()
  try {
    const raw = window.localStorage.getItem(PREFS_KEY)
    if (!raw) {
      return {
        enabled: false,
        autoSync: true,
        lastSyncedAt: null,
        remoteRecordsCount: null,
      }
    }
    const parsed = JSON.parse(raw) as Partial<StoredSyncPrefs>
    return {
      enabled: Boolean(parsed.enabled),
      autoSync: parsed.autoSync !== false,
      lastSyncedAt: parsed.lastSyncedAt ?? null,
      remoteRecordsCount:
        typeof parsed.remoteRecordsCount === 'number'
          ? parsed.remoteRecordsCount
          : null,
    }
  } catch {
    return {
      enabled: false,
      autoSync: true,
      lastSyncedAt: null,
      remoteRecordsCount: null,
    }
  }
}

function writeStoredPrefs(prefs: StoredSyncPrefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // ignore storage quota errors
  }
}

/** Curseur de révision serveur (P0-6) : base des synchronisations delta. */
function readStoredCursor(): string | null {
  try {
    const raw = window.localStorage.getItem(CURSOR_KEY)
    return raw && /^\d+$/.test(raw) ? raw : null
  } catch {
    return null
  }
}

function writeStoredCursor(cursor: string | null): void {
  try {
    if (cursor === null) {
      window.localStorage.removeItem(CURSOR_KEY)
      return
    }
    window.localStorage.setItem(CURSOR_KEY, cursor)
  } catch {
    // ignore storage quota errors
  }
}

export function CloudSyncProvider({ children }: { children: ReactNode }) {
  const { mutationCount, syncWithRepo } = useSalonStore()
  const toast = useToast()

  const [prefs, setPrefs] = useState<StoredSyncPrefs>(readStoredPrefs)
  const [status, setStatus] = useState<CloudSyncStatus>(() =>
    readStoredPrefs().enabled ? 'idle' : 'disabled',
  )
  const [lastError, setLastError] = useState<string | null>(null)
  const [databaseConfiguredOnServer, setDatabaseConfiguredOnServer] = useState<
    boolean | null
  >(null)

  const syncInFlightRef = useRef(false)

  const checkServerHealth = useCallback(async () => {
    purgeLegacyPinStorage()
    if (typeof window === 'undefined' || typeof window.fetch !== 'function') {
      return
    }
    try {
      const resp = await window.fetch('/api/health', { method: 'GET' })
      if (!resp.ok) return
      const json = (await resp.json()) as {
        databaseConfigured?: boolean
      }
      setDatabaseConfiguredOnServer(Boolean(json.databaseConfigured))
    } catch {
      // Hors-ligne ou mode test jsdom sans serveur HTTP
    }
  }, [])

  const runBidirectionalSync = useCallback(
    async (options?: { silent?: boolean }): Promise<boolean> => {
      if (syncInFlightRef.current) return false
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setStatus('offline')
        setLastError(
          'Appareil hors-ligne : vos opérations sont sécurisées dans IndexedDB et seront synchronisées dès le retour d’Internet.',
        )
        return false
      }

      syncInFlightRef.current = true
      setStatus('syncing')
      setLastError(null)

      try {
        const envelope = await syncWithRepo((repo) =>
          repo.buildCloudSyncEnvelope(),
        )
        const savedSessionToken = readStoredSessionTokens().sessionToken ?? ''

        // `fetchWithSession` rafraîchit automatiquement un jeton d'accès expiré
        // (rotation S4) avant de rejouer la requête.
        const cursor = readStoredCursor()
        const resp = await fetchWithSession('/api/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...envelope, ...(cursor ? { cursor } : {}) }),
        })

        const data = (await resp.json().catch(() => ({}))) as {
          ok?: boolean
          code?: string
          message?: string
          syncedAt?: string
          stats?: { totalRemoteRecords?: number }
          payload?: SalonBackupPayload
          tombstones?: LocalSyncTombstone[]
          cursor?: string
          changes?: Record<string, unknown[]>
          deleted?: LocalSyncTombstone[]
        }

        if (!resp.ok || !data.ok) {
          if (resp.status === 401) {
            setStatus('unauthorized')
            const msg =
              data.message ??
              'Session utilisateur requise pour synchroniser avec Neon PostgreSQL.'
            setLastError(msg)
            if (!options?.silent) toast.error(msg)
            return false
          }

          if (resp.status === 503 && data.code === 'NETWORK_UNREACHABLE') {
            setStatus('offline')
            const msg =
              data.message ??
              'Base Neon momentanément injoignable : continuité locale active.'
            setLastError(msg)
            if (!options?.silent) toast.warning(msg)
            return false
          }

          setStatus('error')
          const msg =
            data.message ?? 'Échec de la synchronisation Cloud Neon PostgreSQL.'
          setLastError(msg)
          if (!options?.silent) toast.error(msg)
          return false
        }

        // Delta quand le serveur en renvoie un, sinon état complet (premier sync).
        if (data.changes || data.deleted) {
          await syncWithRepo((repo) =>
            repo.mergeCloudDelta({
              changes: data.changes,
              deleted: data.deleted ?? [],
            }),
          )
        } else {
          await syncWithRepo((repo) =>
            repo.mergeCloudSyncResult({
              payload: data.payload ?? null,
              tombstones: data.tombstones ?? [],
            }),
          )
        }

        if (data.cursor) writeStoredCursor(String(data.cursor))

        // Provisionnement des comptes créés hors-ligne : route dédiée,
        // réservée au Gérant (un Caissier reçoit 403, ignoré silencieusement).
        if (savedSessionToken) {
          try {
            const provisioning = await syncWithRepo((repo) =>
              repo.buildUserProvisioningEnvelope(),
            )
            if (provisioning.accounts.length > 0) {
              await fetchWithSession('/api/users/provision', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(provisioning),
              })
            }
          } catch {
            // Best-effort : la synchronisation des données reste prioritaire.
          }
        }

        const syncedAt = data.syncedAt ?? new Date().toISOString()
        const remoteRecordsCount =
          typeof data.stats?.totalRemoteRecords === 'number'
            ? data.stats.totalRemoteRecords
            : null

        setPrefs((prev) => {
          const next: StoredSyncPrefs = {
            ...prev,
            enabled: true,
            lastSyncedAt: syncedAt,
            remoteRecordsCount,
          }
          writeStoredPrefs(next)
          return next
        })
        setStatus('synced')
        setDatabaseConfiguredOnServer(true)

        if (!options?.silent) {
          toast.success('Synchronisation Neon PostgreSQL réussie.')
        }
        return true
      } catch {
        setStatus('offline')
        const msg =
          'Connexion réseau indisponible : vos données restent protégées localement (IndexedDB).'
        setLastError(msg)
        if (!options?.silent) toast.warning(msg)
        return false
      } finally {
        syncInFlightRef.current = false
      }
    },
    [syncWithRepo, toast],
  )

  const syncNow = useCallback(
    async (options?: { silent?: boolean }) => {
      return runBidirectionalSync(options)
    },
    [runBidirectionalSync],
  )

  const configureAndConnect = useCallback(
    async (params: {
      autoSync: boolean
    }): Promise<{ ok: boolean; message: string }> => {
      purgeLegacyPinStorage()
      const nextPrefs: StoredSyncPrefs = {
        ...prefs,
        enabled: true,
        autoSync: params.autoSync,
      }
      setPrefs(nextPrefs)
      writeStoredPrefs(nextPrefs)

      const ok = await runBidirectionalSync({ silent: true })
      if (ok) {
        return {
          ok: true,
          message:
            'Mode Hybride activé et synchronisé avec votre base Neon PostgreSQL.',
        }
      }
      return {
        ok: false,
        message:
          'Mode Hybride configuré localement (la synchronisation reprendra dès que Neon PostgreSQL sera joignable).',
      }
    },
    [prefs, runBidirectionalSync],
  )

  const setAutoSync = useCallback((enabled: boolean) => {
    setPrefs((prev) => {
      const next = { ...prev, autoSync: enabled }
      writeStoredPrefs(next)
      return next
    })
  }, [])

  const disconnectCloudSync = useCallback(() => {
    purgeLegacyPinStorage()
    setLastError(null)
    setStatus('disabled')
    setPrefs((prev) => {
      const next: StoredSyncPrefs = { ...prev, enabled: false }
      writeStoredPrefs(next)
      return next
    })
  }, [])

  useEffect(() => {
    if (!prefs.enabled || !prefs.autoSync || mutationCount === 0) return
    const timer = window.setTimeout(() => {
      void runBidirectionalSync({ silent: true })
    }, 1600)
    return () => window.clearTimeout(timer)
  }, [mutationCount, prefs.enabled, prefs.autoSync, runBidirectionalSync])

  useEffect(() => {
    // Après une bascule de salon (switchTenant), le curseur a été vidé et un
    // flag a été posé dans localStorage : déclencher un full sync pour
    // recharger les données du nouveau salon depuis Neon.
    if (!prefs.enabled) return
    try {
      const pending =
        typeof window !== 'undefined'
          ? window.localStorage.getItem('salon_pro_pending_full_sync')
          : null
      if (pending === '1') {
        window.localStorage.removeItem('salon_pro_pending_full_sync')
        void runBidirectionalSync({ silent: true })
      }
    } catch {
      // ignore storage errors
    }
  }, [prefs.enabled, runBidirectionalSync])

  useEffect(() => {
    if (!prefs.enabled) return
    const handleOnline = () => {
      void runBidirectionalSync({ silent: true })
    }
    const handleOffline = () => {
      setStatus('offline')
    }
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [prefs.enabled, runBidirectionalSync])

  const value = useMemo(
    () => ({
      syncEnabled: prefs.enabled,
      autoSync: prefs.autoSync,
      status,
      lastSyncedAt: prefs.lastSyncedAt,
      remoteRecordsCount: prefs.remoteRecordsCount,
      lastError,
      databaseConfiguredOnServer,
      checkServerHealth,
      configureAndConnect,
      syncNow,
      setAutoSync,
      disconnectCloudSync,
    }),
    [
      prefs.enabled,
      prefs.autoSync,
      prefs.lastSyncedAt,
      prefs.remoteRecordsCount,
      status,
      lastError,
      databaseConfiguredOnServer,
      checkServerHealth,
      configureAndConnect,
      syncNow,
      setAutoSync,
      disconnectCloudSync,
    ],
  )

  return (
    <CloudSyncContext.Provider value={value}>
      {children}
    </CloudSyncContext.Provider>
  )
}
