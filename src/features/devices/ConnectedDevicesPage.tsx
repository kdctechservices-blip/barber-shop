import {
  AlertTriangle,
  Loader2,
  Monitor,
  RefreshCw,
  Smartphone,
  Tablet,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Modal } from '@/components/ui/Modal'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useAuth } from '../../contexts/authContext'
import { useToast } from '../../hooks/toastContext'
import { formatDateTimeFR } from '../../utils/format'
import type { ConnectedSession } from '../../lib/deviceClient'
import {
  DeviceApiError,
  fetchConnectedSessions,
  revokeConnectedSession,
} from '../../lib/deviceClient'

/**
 * Appareils connectés (P1-2).
 *
 * Liste les sessions actives du salon courant et permet au Gérant de
 * révoquer à distance un appareil (déconnexion immédiate). Réservé au
 * rôle Gérant. Hors mode cloud, l'écran affiche un état dégradé.
 */

function deviceIcon(userAgent: string | null): React.ReactElement {
  const ua = (userAgent ?? '').toLowerCase()
  const Icon =
    ua.includes('mobile')
      ? Smartphone
      : ua.includes('tablet') || ua.includes('ipad')
        ? Tablet
        : Monitor
  return <Icon size={16} />
}

function roleLabel(role: string): string {
  if (role === 'manager') return 'Gérant'
  if (role === 'cashier') return 'Caissier'
  return role
}
export function ConnectedDevicesPage() {
  const auth = useAuth()
  const toast = useToast()

  const cloudMode = auth.authMode === 'cloud_neon' && Boolean(auth.sessionToken)
  const isManager = !auth.currentUser || auth.currentUser.role === 'manager'

  const [sessions, setSessions] = useState<ConnectedSession[]>([])
  const [loading, setLoading] = useState(cloudMode && isManager)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmTarget, setConfirmTarget] = useState<ConnectedSession | null>(null)

  const load = useCallback(async () => {
    if (!cloudMode || !isManager) {
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError(null)
    try {
      const list = await fetchConnectedSessions()
      setSessions(list)
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : 'Impossible de charger les appareils.',
      )
    } finally {
      setLoading(false)
    }
  }, [cloudMode, isManager])

  useEffect(() => {
    let cancelled = false
    Promise.resolve().then(() => {
      if (!cancelled) void load()
    })
    return () => {
      cancelled = true
    }
  }, [load])

  const activeSessions = useMemo(
    () => sessions.filter((s) => !s.revokedAt),
    [sessions],
  )

  const handleRevoke = async (session: ConnectedSession) => {
    if (revokingId === session.id) return
    setRevokingId(session.id)
    try {
      const ok = await revokeConnectedSession(session.id)
      if (ok) {
        setSessions((current) =>
          current.map((s) =>
            s.id === session.id ? { ...s, revokedAt: new Date().toISOString(), revokedReason: 'user_revoke' } : s,
          ),
        )
        toast.success(`Appareil de ${session.email} déconnecté.`)
      }
    } catch (err) {
      if (err instanceof DeviceApiError) {
        toast.error(err.message)
      } else if (err instanceof Error) {
        toast.error(err.message)
      } else {
        toast.error('Révoquation impossible pour le moment.')
      }
    } finally {
      setRevokingId(null)
    }
  }

  const openConfirm = (session: ConnectedSession) => {
    setConfirmTarget(session)
    setConfirmOpen(true)
  }

  const handleConfirmRevoke = async () => {
    if (!confirmTarget) return
    setConfirmOpen(false)
    setConfirmTarget(null)
    await handleRevoke(confirmTarget)
  }

  if (!cloudMode || !isManager) {
    return (
      <div className="page-fade" style={{ display: 'grid', gap: 18 }}>
        <div>
          <h1
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              margin: 0,
              fontSize: '1.35rem',
            }}
          >
            <Monitor size={20} /> Appareils connectés
          </h1>
          <p style={{ margin: '6px 0 0', color: 'var(--text-muted)', fontSize: '0.86rem' }}>
            Gestion à distance des sessions actives. Réservée au Gérant.
          </p>
        </div>
        <Card tilt3d={false}>
          <CardContent style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <AlertTriangle size={16} />
              <strong>
                {!cloudMode
                  ? 'Gestion d’appareils cloud'
                  : 'Accès réservé au Gérant'}
              </strong>
            </div>
            <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              {!cloudMode
                ? 'Vous travaillez en local (hors-ligne) : la gestion des appareils connectés nécessite la synchronisation Neon.'
                : 'Vous devez être Gérant pour consulter et révoquer les appareils connectés.'}
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="page-fade" style={{ display: 'grid', gap: 18 }}>
      <div>
        <h1
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            margin: 0,
            fontSize: '1.35rem',
          }}
        >
          <Monitor size={20} /> Appareils connectés
        </h1>
        <p style={{ margin: '6px 0 0', color: 'var(--text-muted)', fontSize: '0.86rem' }}>
          Sessions actives du salon courant. Un appareil révoqué est déconnecté immédiatement et doit se reconnecter.
        </p>
      </div>

      {loading && (
        <Card tilt3d={false}>
          <CardContent
            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <Loader2 size={16} className="spin" /> Chargement des appareils…
          </CardContent>
        </Card>
      )}

      {loadError && !loading && (
        <Card tilt3d={false}>
          <CardContent style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <AlertTriangle size={16} /> Appareils indisponibles
            </div>
            <p style={{ margin: 0, fontSize: '0.85rem' }}>{loadError}</p>
            <div>
              <Button size="sm" variant="outline" onClick={() => void load()}>
                Réessayer
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {!loading && !loadError && (
        <Card tilt3d={false}>
          <CardContent style={{ display: 'grid', gap: 12 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Monitor size={16} />
                <strong>Appareils ({activeSessions.length})</strong>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void load()}
                disabled={loading}
              >
                <RefreshCw size={14} /> Actualiser
              </Button>
            </div>

            {activeSessions.length === 0 ? (
              <EmptyState
                icon={<Monitor size={18} />}
                title="Aucun appareil connecté"
                description="Aucune session active pour le moment sur ce salon."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Appareil</TableHead>
                    <TableHead>Compte</TableHead>
                    <TableHead>Rôle</TableHead>
                    <TableHead>Connecté le</TableHead>
                    <TableHead>Dernière activité</TableHead>
                    <TableHead>Statut</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activeSessions.map((session) => (
                    <TableRow key={session.id}>
                      <TableCell style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {deviceIcon(session.userAgent)}
                        <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                          {session.userAgent
                            ? session.userAgent.length > 40
                              ? `${session.userAgent.slice(0, 40)}…`
                              : session.userAgent
                            : 'Navigateur'}
                        </span>
                      </TableCell>
                      <TableCell style={{ fontSize: '0.85rem' }}>{session.email}</TableCell>
                      <TableCell>
                        <Badge size="sm" variant="outline">{roleLabel(session.role)}</Badge>
                      </TableCell>
                      <TableCell style={{ fontSize: '0.85rem' }}>
                        {formatDateTimeFR(session.createdAt)}
                      </TableCell>
                      <TableCell style={{ fontSize: '0.85rem' }}>
                        {session.lastUsedAt ? formatDateTimeFR(session.lastUsedAt) : '—'}
                      </TableCell>
                      <TableCell>
                        <Badge size="sm" variant="success">Actif</Badge>
                      </TableCell>
                      <TableCell>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={revokingId === session.id}
                          onClick={() => openConfirm(session)}
                        >
                          {revokingId === session.id ? '…' : 'Déconnecter'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      <Modal
        open={confirmOpen}
        title="Déconnecter cet appareil ?"
        subtitle={
          confirmTarget
            ? `La session de ${confirmTarget.email} sera révoquée immédiatement. L'utilisateur devra se reconnecter.`
            : ''
        }
        onClose={() => {
          setConfirmOpen(false)
          setConfirmTarget(null)
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setConfirmOpen(false)
              setConfirmTarget(null)
            }}
          >
            Annuler
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={revokingId === confirmTarget?.id}
            onClick={handleConfirmRevoke}
          >
            {revokingId === confirmTarget?.id ? 'Déconnexion…' : 'Confirmer'}
          </Button>
        </div>
      </Modal>
    </div>
  )
}
