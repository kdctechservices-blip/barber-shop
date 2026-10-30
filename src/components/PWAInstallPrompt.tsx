/**
 * Invite d'installation PWA (P1-3).
 *
 * Affiche une bannière discrète lorsque le navigateur propose l'installation
 * de l'application comme PWA (`beforeinstallprompt`). L'utilisateur peut
 * installer ou fermer définitivement l'invite.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, X } from 'lucide-react'

export interface PWAInstallPromptProps {
  /** Texte personnalisé de l'invite (optionnel). */
  message?: string
  /** Si true, l'invite est masquée. */
  disabled?: boolean
}

export function PWAInstallPrompt({
  message = 'Installez SALON PRO sur votre appareil pour l’utiliser hors-ligne.',
  disabled = false,
}: PWAInstallPromptProps) {
  const [deferred, setDeferred] = useState<Event | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const promptRef = useRef<((event: Event) => void) | null>(null)

  const handleBeforeInstallPrompt = useCallback(
    (event: Event) => {
      event.preventDefault()
      setDeferred(event)
      promptRef.current = (ev: Event) => ev
    },
    [],
  )

  useEffect(() => {
    if (disabled) return
    if (typeof window === 'undefined') return

    // Déjà installé : pas d'invite
    if (window.matchMedia('(display-mode: standalone)').matches) {
      return
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    }
  }, [disabled, handleBeforeInstallPrompt])

  const handleInstall = useCallback(async () => {
    if (!deferred) return
    try {
      ;(deferred as any).prompt()
      const { outcome } = await (deferred as any).userChoice
      if (outcome === 'accepted') {
        setDismissed(true)
      }
    } catch {
      /* échec silencieux : l'utilisateur réessaiera plus tard */
    } finally {
      setDeferred(null)
    }
  }, [deferred])

  const handleDismiss = useCallback(() => {
    setDismissed(true)
    setDeferred(null)
  }, [])

  if (disabled || dismissed || !deferred) return null

  return (
    <div
      role="alert"
      aria-label="Invite d'installation PWA"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '10px 16px',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-strong)',
        borderRadius: 10,
        boxShadow: 'var(--shadow-md)',
        backdropFilter: 'blur(8px)',
        position: 'fixed',
        bottom: 20,
        left: 20,
        right: 20,
        zIndex: 100,
        maxWidth: 520,
        margin: '0 12px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
        <Download size={16} color="var(--color-success)" />
        <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', flex: 1, minWidth: 0 }}>
          {message}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <button
          type="button"
          onClick={handleInstall}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            fontSize: '0.78rem',
            fontWeight: 600,
            color: 'var(--color-success)',
            border: '1px solid var(--color-success)',
            background: 'transparent',
            borderRadius: 8,
            cursor: 'pointer',
          }}
        >
          Installer
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Fermer l'invite"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: 6,
            color: 'var(--text-muted)',
            border: 'none',
            background: 'transparent',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
