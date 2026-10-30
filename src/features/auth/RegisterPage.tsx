import {
  AlertTriangle,
  ArrowLeft,
  Eye,
  EyeOff,
  ShieldCheck,
  Wallet,
} from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/authContext'
import type { UserRole } from '../../domain/models'
import { useSalonStore } from '../../hooks/salonStoreContext'
import { useToast } from '../../hooks/toastContext'
import { AuthLayout } from './AuthLayout'

export function RegisterPage() {
  const { currentUser, hasAnyManager, register } = useAuth()
  const { state } = useSalonStore()
  const toast = useToast()
  const navigate = useNavigate()

  const isLoggedInManager = currentUser?.role === 'manager'
  const [role, setRole] = useState<UserRole>(() =>
    hasAnyManager ? 'cashier' : 'manager',
  )
  const [fullName, setFullName] = useState('')
  const [salonName, setSalonName] = useState(state.salon.name)
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const effectiveRole: UserRole = !hasAnyManager ? 'manager' : role
  const blockedWithoutManagerSession = hasAnyManager && !isLoggedInManager

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)

    if (blockedWithoutManagerSession) {
      setError(
        'Un compte Gérant existe déjà : connectez-vous d’abord en tant que Gérant pour ajouter un collaborateur.',
      )
      return
    }
    if (
      password.length < 8 ||
      !/[A-Za-z]/.test(password) ||
      !/\d/.test(password)
    ) {
      setError(
        'Le mot de passe doit contenir au moins 8 caractères, avec au moins une lettre et un chiffre.',
      )
      return
    }
    if (password !== confirmPassword) {
      setError('Les deux mots de passe ne correspondent pas.')
      return
    }

    setBusy(true)
    try {
      const created = await register({
        fullName,
        email,
        phone,
        password,
        role: effectiveRole,
        salonName: !hasAnyManager ? salonName : undefined,
        rememberMe: true,
      })
      toast.success(
        `Compte ${created.role === 'manager' ? 'Gérant' : 'Caissier'} créé pour ${created.fullName}.`,
      )
      navigate(created.role === 'cashier' ? '/cash' : '/dashboard', {
        replace: true,
      })
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Création du compte impossible.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      variant="register"
      maxWidth={405}
      title={
        !hasAnyManager
          ? 'Créer le compte Gérant'
          : 'Créer un compte utilisateur'
      }
      subtitle={
        !hasAnyManager
          ? 'Initialisez votre salon et votre accès administrateur'
          : 'Ajoutez un accès Gérant ou Caissier / Réception'
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {isLoggedInManager && (
          <div style={{ textAlign: 'center', marginTop: -6 }}>
            <Link
              to="/dashboard"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: '0.78rem',
                fontWeight: 650,
                color: 'var(--text-secondary)',
              }}
            >
              <ArrowLeft size={13} />
              Retour au tableau de bord
            </Link>
          </div>
        )}

        {error && (
          <div
            role="alert"
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '10px 12px',
              borderRadius: 11,
              background: 'var(--color-danger-bg)',
              color: 'var(--color-danger)',
              fontSize: '0.8rem',
            }}
          >
            <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{error}</span>
          </div>
        )}

        <form
          onSubmit={(e) => void handleSubmit(e)}
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          {/* Sélecteur de profil Gérant / Caissier en 2 boutons épurés */}
          <div className="auth-form-grid-2">
            <button
              type="button"
              onClick={() => setRole('manager')}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 7,
                height: 40,
                padding: '0 12px',
                borderRadius: 10,
                fontSize: '0.81rem',
                fontWeight: 650,
                cursor: 'pointer',
                border:
                  effectiveRole === 'manager'
                    ? '1.5px solid #064e3b'
                    : '1px solid var(--border-strong)',
                background:
                  effectiveRole === 'manager'
                    ? 'var(--accent-emerald-soft)'
                    : 'transparent',
                color: 'var(--text-primary)',
              }}
            >
              <ShieldCheck size={15} color="#059669" />
              Gérant
            </button>

            <button
              type="button"
              disabled={!hasAnyManager}
              onClick={() => setRole('cashier')}
              title={
                !hasAnyManager
                  ? 'Créez d’abord le premier compte Gérant'
                  : 'Accès caisse, recettes, dépenses et inventaire'
              }
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 7,
                height: 40,
                padding: '0 12px',
                borderRadius: 10,
                fontSize: '0.81rem',
                fontWeight: 650,
                cursor: !hasAnyManager ? 'not-allowed' : 'pointer',
                opacity: !hasAnyManager ? 0.45 : 1,
                border:
                  effectiveRole === 'cashier'
                    ? '1.5px solid #064e3b'
                    : '1px solid var(--border-strong)',
                background:
                  effectiveRole === 'cashier'
                    ? 'var(--accent-emerald-soft)'
                    : 'transparent',
                color: 'var(--text-primary)',
              }}
            >
              <Wallet size={15} color="#059669" />
              Caissier
            </button>
          </div>

          <div className="auth-form-grid-2">
            <div className="auth-soft-field">
              <label htmlFor="reg-fullname" className="auth-soft-label">
                Nom complet
              </label>
              <input
                id="reg-fullname"
                type="text"
                required
                autoComplete="name"
                placeholder="Nom et prénom"
                className="auth-soft-input"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
              />
            </div>

            <div className="auth-soft-field">
              <label htmlFor="reg-phone" className="auth-soft-label">
                Téléphone (optionnel)
              </label>
              <input
                id="reg-phone"
                type="tel"
                autoComplete="tel"
                placeholder="Numéro de téléphone"
                className="auth-soft-input"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
          </div>

          {!hasAnyManager && (
            <div className="auth-soft-field">
              <label htmlFor="reg-salon-name" className="auth-soft-label">
                Nom du salon
              </label>
              <input
                id="reg-salon-name"
                type="text"
                required
                placeholder="Nom de votre établissement"
                className="auth-soft-input"
                value={salonName}
                onChange={(e) => setSalonName(e.target.value)}
              />
            </div>
          )}

          <div className="auth-soft-field">
            <label htmlFor="reg-email" className="auth-soft-label">
              Adresse e-mail
            </label>
            <input
              id="reg-email"
              type="email"
              required
              autoComplete="email"
              placeholder="nom@domaine.com"
              className="auth-soft-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="auth-form-grid-2">
            <div className="auth-soft-field" style={{ paddingRight: 36 }}>
              <label htmlFor="reg-password" className="auth-soft-label">
                Mot de passe
              </label>
              <input
                id="reg-password"
                type={showPassword ? 'text' : 'password'}
                required
                minLength={6}
                autoComplete="new-password"
                placeholder="Min. 6 caract."
                className="auth-soft-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                aria-label={
                  showPassword
                    ? 'Masquer le mot de passe'
                    : 'Afficher le mot de passe'
                }
                onClick={() => setShowPassword((v) => !v)}
                style={{
                  position: 'absolute',
                  right: 8,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  padding: 4,
                  display: 'inline-flex',
                }}
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>

            <div className="auth-soft-field">
              <label htmlFor="reg-confirm" className="auth-soft-label">
                Confirmation
              </label>
              <input
                id="reg-confirm"
                type={showPassword ? 'text' : 'password'}
                required
                minLength={6}
                autoComplete="new-password"
                placeholder="Répéter"
                className="auth-soft-input"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
          </div>

          {blockedWithoutManagerSession && (
            <div
              style={{
                padding: '10px 12px',
                borderRadius: 11,
                background: 'var(--bg-surface-muted)',
                border: '1px solid var(--border-subtle)',
                fontSize: '0.79rem',
                color: 'var(--text-secondary)',
                lineHeight: 1.45,
              }}
            >
              Un compte <strong>Gérant</strong> existe déjà pour ce salon.
              Connectez-vous avec un compte Gérant pour créer un nouvel accès
              collaborateur.
            </div>
          )}

          <button
            type="submit"
            className="auth-haven-submit"
            style={{ marginTop: 4 }}
            disabled={busy || blockedWithoutManagerSession}
          >
            {busy ? 'Création en cours…' : 'Créer le compte'}
          </button>
        </form>

        <div
          style={{
            marginTop: 4,
            textAlign: 'center',
            fontSize: '0.81rem',
            color: 'var(--text-secondary)',
          }}
        >
          Vous avez déjà un compte ?{' '}
          <Link
            to="/login"
            style={{
              color: 'var(--text-primary)',
              fontWeight: 700,
              textDecoration: 'underline',
              textUnderlineOffset: 3,
            }}
          >
            Se connecter
          </Link>
        </div>
      </div>
    </AuthLayout>
  )
}
