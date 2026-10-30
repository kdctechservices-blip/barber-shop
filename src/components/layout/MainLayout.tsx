import {
  ArrowDownCircle,
  ArrowUpCircle,
  Award,
  Bell,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Cloud,
  CloudOff,
  CreditCard,
  FileBarChart2,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Monitor,
  Package,
  Plus,
  Receipt,
  Scissors,
  Search,
  Settings,
  Store,
  Sun,
  Target,
  Unlock,
  UserPlus,
  Users,
  UsersRound,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react'
import { motion } from 'framer-motion'
import { useEffect, useMemo, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { pageTransitionVariants } from '@/lib/motion'
import { canUserAccessPath, useAuth } from '../../contexts/authContext'
import { useCashSession } from '../../contexts/cashSessionContext'
import { useCloudSync } from '../../contexts/cloudSyncContext'
import { useQuickAction } from '../../contexts/quickActionContext'
import { useWorkspaceFocus } from '../../contexts/workspaceFocusContext'
import {
  buildDashboardAlerts,
  calculateEmployeePayrollStatus,
} from '../../domain/calculations/finance'
import { useSalonStore } from '../../hooks/salonStoreContext'
import { useToast } from '../../hooks/toastContext'
import { formatFCFA } from '../../utils/format'
import { CommandSearchModal } from './CommandSearchModal'
import { PWAInstallPrompt } from '../PWAInstallPrompt'

const NAV_GROUPS: Array<{
  heading: string
  items: Array<{ to: string; label: string; icon: LucideIcon }>
}> = [
  {
    heading: 'PILOTAGE',
    items: [
      { to: '/dashboard', label: 'Tableau de bord', icon: LayoutDashboard },
      { to: '/budget', label: 'Budget et objectifs', icon: Target },
    ],
  },
  {
    heading: 'TRÉSORERIE & FLUX',
    items: [
      { to: '/cash', label: 'Caisse', icon: Wallet },
      { to: '/revenue', label: 'Recettes', icon: ArrowUpCircle },
      { to: '/expenses', label: 'Dépenses', icon: ArrowDownCircle },
    ],
  },
      {
        heading: 'ACTIVITÉ & ÉQUIPE',
        items: [
          { to: '/services', label: 'Prestations et tarifs', icon: Scissors },
          { to: '/appointments', label: 'Agenda & RDV', icon: Calendar },
          { to: '/employees', label: 'Personnel', icon: Users },
          { to: '/payroll', label: 'Salaires et commissions', icon: Award },
          { to: '/team', label: 'Équipe et abonnement', icon: UsersRound },
          { to: '/devices', label: 'Appareils connectés', icon: Monitor },
          { to: '/invoices', label: 'Factures', icon: Receipt },
          { to: '/billing/payment', label: 'Paiement abonnement', icon: CreditCard },
        ],
      },
  {
    heading: 'STOCK & ÉTATS',
    items: [
      { to: '/inventory', label: 'Inventaire', icon: Package },
      { to: '/reports', label: 'Rapports', icon: FileBarChart2 },
      { to: '/settings', label: 'Paramètres', icon: Settings },
    ],
  },
]

const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items)

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) {
    return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase()
  }
  return name.slice(0, 2).toUpperCase() || 'SP'
}

export function MainLayout() {
  const { state, mutate } = useSalonStore()
  const auth = useAuth()
  const cloudSync = useCloudSync()
  const {
    openSession,
    theoreticalBalance,
    isSessionStale,
    openQuickCashModal,
  } = useCashSession()
  const { openCheckoutTicket, openQuickExpense } = useQuickAction()
  const { navigateToEntity } = useWorkspaceFocus()
  const toast = useToast()
  const location = useLocation()
  const navigate = useNavigate()

  const [collapsed, setCollapsed] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [currentYm] = useState<string>(() =>
    new Date().toISOString().slice(0, 7),
  )

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen((prev) => !prev)
      } else if (e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        openCheckoutTicket()
      } else if (e.altKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        openQuickExpense()
      } else if (e.key === 'Escape') {
        setNotifOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openCheckoutTicket, openQuickExpense])

  const hasOpenCashSession = openSession !== null

  const alerts = useMemo(() => {
    const activeRevs = state.revenues.filter((r) => !r.isArchived)
    const activeExps = state.expenses.filter((e) => !e.isArchived)
    const monthRevs = activeRevs.filter((r) => r.date.slice(0, 7) === currentYm)
    const monthExps = activeExps.filter((e) => e.date.slice(0, 7) === currentYm)
    const payrollStatuses = state.employees.map((employee) =>
      calculateEmployeePayrollStatus({
        employee,
        periodMonth: currentYm,
        periodRevenues: monthRevs,
        advances: state.advances,
        bonuses: state.bonuses,
        salaryPayments: state.salaryPayments,
        servicesCatalog: state.services,
      }),
    )
    return buildDashboardAlerts({
      cashSessions: state.cashSessions,
      products: state.products,
      payrollStatuses,
      periodExpenses: monthExps,
      budgets: state.budgets,
      periodRevenues: monthRevs,
      recurringExpenses: state.recurringExpenses,
      allExpenses: activeExps,
      lastBackupExportedAt: state.settings.lastBackupExportedAt,
    })
  }, [
    state.revenues,
    state.employees,
    state.advances,
    state.bonuses,
    state.salaryPayments,
    state.cashSessions,
    state.products,
    state.expenses,
    state.budgets,
    state.settings.lastBackupExportedAt,
      state.recurringExpenses,
      state.services,
      currentYm,
    ])

  const lowStockCount = useMemo(
    () =>
      state.products.filter(
        (p) => p.isActive && p.quantity <= p.alertThreshold,
      ).length,
    [state.products],
  )

  const handleToggleTheme = async () => {
    const nextTheme = state.settings.theme === 'dark' ? 'light' : 'dark'
    await mutate((repo) => repo.updateSettings({ theme: nextTheme }))
  }

  const displaySalonName = state.salon.name || 'Mon établissement'
  const displayUserName =
    auth.currentUser?.fullName || state.salon.managerName || 'Gérant'
  const isManager = !auth.currentUser || auth.currentUser.role === 'manager'
  const roleLabel = isManager ? 'Gérant' : 'Caissier'
  const initials = getInitials(displayUserName)

  const visibleNavGroups = useMemo(
    () =>
      NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          canUserAccessPath(auth.currentUser?.role, item.to),
        ),
      })).filter((group) => group.items.length > 0),
    [auth.currentUser?.role],
  )

  const visibleMobileNavItems = useMemo(
    () =>
      ALL_NAV_ITEMS.filter((item) =>
        canUserAccessPath(auth.currentUser?.role, item.to),
      ),
    [auth.currentUser?.role],
  )

  return (
    <div className="app-shell">
      {/* Barre latérale Desktop SALON PRO */}
      <aside className={`app-sidebar${collapsed ? ' collapsed' : ''}`}>
        <button
          type="button"
          className="sidebar-collapse-btn"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={
            collapsed ? 'Déplier la barre latérale' : 'Réduire la barre latérale'
          }
          title={collapsed ? 'Déplier' : 'Réduire'}
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
        </button>

        <div className="sidebar-brand">
          {state.salon.logoDataUrl ? (
            <img
              src={state.salon.logoDataUrl}
              alt="Logo du salon"
              style={{
                width: 34,
                height: 34,
                borderRadius: 9,
                objectFit: 'cover',
              }}
            />
          ) : (
            <div className="brand-mark" aria-hidden="true">
              <Scissors size={18} strokeWidth={2.2} />
            </div>
          )}

          {!collapsed && (
            <div style={{ minWidth: 0 }}>
              <div className="brand-title">SALON PRO</div>
              <div
                style={{
                  fontSize: '0.73rem',
                  color: '#a1a1aa',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {displaySalonName}
              </div>
            </div>
          )}
        </div>

        <nav className="sidebar-scroll" aria-label="Menu principal SALON PRO">
          {visibleNavGroups.map((group) => (
            <div key={group.heading}>
              {!collapsed && (
                <div className="sidebar-group-label">{group.heading}</div>
              )}
              <div className="sidebar-group-items">
                {group.items.map((item) => {
                  const Icon = item.icon
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      title={item.label}
                      className={({ isActive }) =>
                        `sidebar-link${isActive ? ' active' : ''}`
                      }
                    >
                      <Icon size={17} strokeWidth={1.85} />
                      {!collapsed && (
                        <>
                          <span>{item.label}</span>
                          {item.to === '/cash' && hasOpenCashSession && (
                            <span className="sidebar-pill-count">Ouverte</span>
                          )}
                          {item.to === '/inventory' && lowStockCount > 0 && (
                            <span className="sidebar-pill-alert">
                              {lowStockCount}
                            </span>
                          )}
                        </>
                      )}
                    </NavLink>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="sidebar-user-footer">
          <div className="user-avatar-emerald" aria-hidden="true">
            {initials}
          </div>
          {!collapsed && (
            <>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    color: '#f4f4f5',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {displayUserName}
                </div>
                <div
                  style={{
                    fontSize: '0.68rem',
                    color: '#71717a',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {roleLabel} ·{' '}
                  {cloudSync.syncEnabled ? 'Hybride Neon' : 'Mode local'}
                </div>
              </div>
              {auth.authEnforced && (
                <button
                  type="button"
                  title="Changer de compte / Se déconnecter"
                  aria-label="Changer de compte"
                  onClick={() => {
                    auth.logout()
                    toast.success('Déconnecté — choisissez votre compte.')
                    navigate('/login', { replace: true })
                  }}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: '#a1a1aa',
                    cursor: 'pointer',
                    padding: 5,
                    borderRadius: 6,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <LogOut size={15} />
                </button>
              )}
            </>
          )}
        </div>
      </aside>

      {/* Tiroir de navigation Mobile */}
      {mobileMenuOpen && (
        <div
          className="mobile-drawer-backdrop no-print"
          onClick={() => setMobileMenuOpen(false)}
        >
          <div
            className="mobile-drawer-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '16px 18px',
                borderBottom: '1px solid var(--sidebar-border)',
              }}
            >
              <div>
                <div style={{ fontWeight: 700, fontSize: '0.96rem' }}>
                  SALON PRO
                </div>
                <div style={{ fontSize: '0.73rem', color: '#34d399' }}>
                  {cloudSync.syncEnabled ? 'Hybride Neon' : 'Mode local'} ·{' '}
                  {displaySalonName}
                </div>
              </div>
              <button
                type="button"
                className="icon-btn"
                style={{ color: '#fafafa' }}
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Fermer le menu"
              >
                <X size={18} />
              </button>
            </div>
            <div style={{ padding: 12 }}>
              {visibleMobileNavItems.map((item) => {
                const Icon = item.icon
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    onClick={() => setMobileMenuOpen(false)}
                    className={({ isActive }) =>
                      `sidebar-link${isActive ? ' active' : ''}`
                    }
                  >
                    <Icon size={17} />
                    <span>{item.label}</span>
                  </NavLink>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* Zone Principale */}
      <div className={`app-main${collapsed ? ' sidebar-is-collapsed' : ''}`}>
        <header className="app-topbar">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              flex: 1,
              minWidth: 0,
            }}
          >
            <button
              type="button"
              className="icon-btn mobile-only-menu-btn"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Ouvrir le menu de navigation"
              style={{ display: 'none' }}
            >
              <Menu size={20} />
            </button>

            {auth.tenants.length > 1 && (
              <label
                title="Changer de salon"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: '0.78rem',
                  color: 'var(--text-muted)',
                }}
              >
                <Store size={14} />
                <select
                  aria-label="Salon actif"
                  value={auth.activeTenantId ?? ''}
                  onChange={(event) => {
                    const target = event.target.value
                    if (target && target !== auth.activeTenantId) {
                      void auth.switchTenant(target)
                    }
                  }}
                  style={{
                    height: 30,
                    borderRadius: 8,
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-surface-muted)',
                    color: 'inherit',
                    padding: '0 6px',
                    maxWidth: 180,
                  }}
                >
                  {auth.tenants.map((tenant) => (
                    <option key={tenant.tenantId} value={tenant.tenantId}>
                      {tenant.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <button
              type="button"
              className="topbar-search-btn"
              onClick={() => setSearchOpen(true)}
              aria-label="Ouvrir la recherche rapide"
            >
              <Search size={15} />
              <span className="topbar-search-text">
                Rechercher (rubrique, client, stock)...
              </span>
              <span className="kbd-shortcut">⌘K</span>
            </button>
          </div>

          <div className="topbar-actions">
            {/* Pastille d'état en direct de la caisse espèces */}
            <button
              type="button"
              className="topbar-search-text"
              onClick={() =>
                openSession ? navigate('/cash') : openQuickCashModal()
              }
              title={
                openSession
                  ? isSessionStale
                    ? 'Session de la veille non clôturée — cliquez pour clôturer'
                    : 'Solde théorique de la caisse espèces ouverte'
                  : 'Caisse fermée — cliquez pour ouvrir le fond de caisse'
              }
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                height: 32,
                padding: '0 10px',
                borderRadius: 999,
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: 'pointer',
                border: `1px solid ${
                  isSessionStale
                    ? 'rgba(239, 68, 68, 0.4)'
                    : openSession
                      ? 'rgba(16, 185, 129, 0.35)'
                      : 'var(--border-subtle)'
                }`,
                background: isSessionStale
                  ? 'var(--color-danger-bg)'
                  : openSession
                    ? 'var(--accent-emerald-soft)'
                    : 'var(--bg-surface-muted)',
                color: isSessionStale
                  ? 'var(--color-danger)'
                  : openSession
                    ? 'var(--accent-cta)'
                    : 'var(--text-secondary)',
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: isSessionStale
                    ? 'var(--color-danger)'
                    : openSession
                      ? 'var(--color-success)'
                      : 'var(--color-warning)',
                }}
              />
              {openSession ? (
                <span className="tabular-nums">
                  {isSessionStale ? 'Caisse veille · ' : 'Caisse : '}
                  {formatFCFA(theoreticalBalance)}
                </span>
              ) : (
                <span>Caisse fermée</span>
              )}
            </button>

            {cloudSync.syncEnabled && (
              <button
                type="button"
                onClick={() => {
                  if (
                    cloudSync.status === 'unauthorized' ||
                    cloudSync.status === 'error'
                  ) {
                    navigate('/settings')
                  } else {
                    void cloudSync.syncNow()
                  }
                }}
                title={
                  cloudSync.status === 'synced'
                    ? 'Synchronisé avec Neon PostgreSQL — cliquer pour resynchroniser'
                    : cloudSync.status === 'offline'
                      ? 'Mode hors-ligne actif (IndexedDB) — cliquer pour réessayer'
                      : 'Cliquer pour synchroniser ou configurer Cloud Neon'
                }
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  height: 32,
                  padding: '0 9px',
                  borderRadius: 999,
                  fontSize: '0.73rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-surface-muted)',
                  color:
                    cloudSync.status === 'synced'
                      ? 'var(--color-success)'
                      : cloudSync.status === 'offline'
                        ? 'var(--color-warning)'
                        : cloudSync.status === 'unauthorized' ||
                            cloudSync.status === 'error'
                          ? 'var(--color-danger)'
                          : 'var(--text-secondary)',
                }}
              >
                {cloudSync.status === 'offline' ? (
                  <CloudOff size={13} />
                ) : (
                  <Cloud size={13} />
                )}
                <span className="topbar-search-text">
                  {cloudSync.status === 'syncing'
                    ? 'Sync…'
                    : cloudSync.status === 'synced'
                      ? 'Cloud'
                      : cloudSync.status === 'offline'
                        ? 'Local'
                        : 'Neon'}
                </span>
              </button>
            )}

            {/* Menu Action Rapide (+ Nouvelle opération — ReUI DropdownMenu) */}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button size="sm" onClick={() => setNotifOpen(false)}>
                    <Plus size={15} />
                    <span className="topbar-search-text">Opération</span>
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Saisie rapide universelle</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => openCheckoutTicket()}>
                    <Receipt size={15} color="var(--color-success)" />
                    <span>Ticket client (encaisser)</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => openQuickExpense()}>
                    <ArrowDownCircle size={15} color="var(--color-danger)" />
                    <span>Dépense rapide</span>
                  </DropdownMenuItem>
                  {!openSession ? (
                    <DropdownMenuItem onSelect={openQuickCashModal}>
                      <Unlock size={15} color="var(--accent-emerald)" />
                      <span>Ouvrir la caisse espèces</span>
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onSelect={() => navigate('/cash')}>
                      <Wallet size={15} color="var(--accent-emerald)" />
                      <span>Gérer la caisse espèces</span>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onSelect={() =>
                      navigateToEntity({
                        route: '/inventory',
                        action: 'restock',
                      })
                    }
                  >
                    <Package size={15} color="var(--color-info)" />
                    <span>Approvisionner le stock</span>
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <button
              type="button"
              className="icon-btn"
              onClick={() => void handleToggleTheme()}
              aria-label="Basculer le thème clair ou sombre"
              title="Thème clair / sombre"
            >
              {state.settings.theme === 'dark' ? (
                <Sun size={18} />
              ) : (
                <Moon size={18} />
              )}
            </button>

            <div style={{ position: 'relative' }}>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setNotifOpen((o) => !o)}
                aria-label="Consulter les alertes"
                title="Alertes et rappels"
              >
                <Bell size={18} />
                {alerts.length > 0 && <span className="notif-dot" />}
              </button>

              {notifOpen && (
                <div
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 8px)',
                    right: 0,
                    width: 320,
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border-strong)',
                    borderRadius: 12,
                    boxShadow: 'var(--shadow-md)',
                    padding: 14,
                    zIndex: 60,
                  }}
                >
                  <div
                    style={{
                      fontWeight: 700,
                      fontSize: '0.86rem',
                      marginBottom: 8,
                    }}
                  >
                    Notifications &amp; Alertes ({alerts.length})
                  </div>
                  {alerts.length === 0 ? (
                    <div
                      style={{
                        fontSize: '0.8rem',
                        color: 'var(--text-muted)',
                      }}
                    >
                      Aucune alerte active.
                    </div>
                  ) : (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                        maxHeight: 280,
                        overflowY: 'auto',
                      }}
                    >
                      {alerts.map((al) => (
                        <Link
                          key={al.id}
                          to={al.route}
                          onClick={() => setNotifOpen(false)}
                          style={{
                            padding: '8px 10px',
                            borderRadius: 8,
                            background: 'var(--bg-surface-muted)',
                            fontSize: '0.78rem',
                          }}
                        >
                          <div style={{ fontWeight: 600 }}>{al.title}</div>
                          <div
                            style={{
                              color: 'var(--text-muted)',
                              marginTop: 2,
                            }}
                          >
                            {al.description}
                          </div>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`${displayUserName} — Menu du salon`}
                title={`${displayUserName} — Menu du salon`}
              >
                <Avatar>
                  <AvatarImage
                    src={state.salon.logoDataUrl}
                    alt={displaySalonName}
                  />
                  <AvatarFallback>{initials}</AvatarFallback>
                </Avatar>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>
                    <div style={{ fontWeight: 700 }}>{displayUserName}</div>
                    <div
                      style={{
                        fontSize: '0.72rem',
                        fontWeight: 500,
                        color: 'var(--text-muted)',
                      }}
                    >
                      {roleLabel}
                      {auth.currentUser?.email
                        ? ` · ${auth.currentUser.email}`
                        : ''}
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {isManager && (
                    <>
                      <DropdownMenuItem onSelect={() => navigate('/settings')}>
                        <Settings aria-hidden="true" />
                        <span>Paramètres &amp; Sauvegarde</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => navigate('/reports')}>
                        <FileBarChart2 aria-hidden="true" />
                        <span>Rapports financiers</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => navigate('/register')}>
                        <UserPlus aria-hidden="true" />
                        <span>Ajouter un compte</span>
                      </DropdownMenuItem>
                    </>
                  )}
                  {auth.authEnforced && (
                    <>
                      {isManager && <DropdownMenuSeparator />}
                      <DropdownMenuItem
                        onSelect={() => {
                          auth.logout()
                          toast.success('Vous êtes déconnecté.')
                          navigate('/login', { replace: true })
                        }}
                      >
                        <LogOut aria-hidden="true" />
                        <span>Se déconnecter</span>
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="app-content">
          <PWAInstallPrompt />
          <motion.div
            key={location.pathname}
            variants={pageTransitionVariants}
            initial="initial"
            animate="animate"
          >
            <Outlet />
          </motion.div>
        </main>
      </div>

      {/* Modale de recherche globale ⌘K */}
      <CommandSearchModal
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
      />

      {/* Barre inférieure tactile sur smartphone + bouton Menu complet */}
      <nav className="mobile-bottom-nav no-print" aria-label="Navigation mobile">
        <NavLink
          to="/dashboard"
          className={({ isActive }) =>
            `mobile-nav-link${isActive ? ' active' : ''}`
          }
        >
          <LayoutDashboard size={18} />
          <span>Accueil</span>
        </NavLink>
        <NavLink
          to="/cash"
          className={({ isActive }) =>
            `mobile-nav-link${isActive ? ' active' : ''}`
          }
        >
          <Wallet size={18} />
          <span>Caisse</span>
        </NavLink>
        <NavLink
          to="/revenue"
          className={({ isActive }) =>
            `mobile-nav-link${isActive ? ' active' : ''}`
          }
        >
          <ArrowUpCircle size={18} />
          <span>Recettes</span>
        </NavLink>
        <NavLink
          to="/inventory"
          className={({ isActive }) =>
            `mobile-nav-link${isActive ? ' active' : ''}`
          }
        >
          <Package size={18} />
          <span>Stock</span>
        </NavLink>
        <button
          type="button"
          onClick={() => setMobileMenuOpen(true)}
          className="mobile-nav-link"
          style={{ border: 'none', background: 'transparent', cursor: 'pointer' }}
        >
          <Menu size={18} />
          <span>Plus (11)</span>
        </button>
      </nav>
    </div>
  )
}
