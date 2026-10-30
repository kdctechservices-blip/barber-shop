import {
  Check,
  Clock,
  Download,
  FolderPlus,
  Lock,
  Package,
  Pencil,
  Percent,
  Plus,
  Power,
  Printer,
  Receipt,
  Scissors,
  Search,
  SettingsIcon,
  SlidersHorizontal,
  Trash2,
  TrendingUp,
  X,
} from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { KpiCard } from '@/components/ui/KpiCard'
import { Modal } from '@/components/ui/Modal'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useAuth, useFieldAuth } from '../../contexts/authContext'
import { useQuickAction } from '../../contexts/quickActionContext'
import { useWorkspaceFocus } from '../../contexts/workspaceFocusContext'
import type {
  CategoryItem,
  ServiceCatalogItem,
  ServiceCommissionOverride,
  ServiceConfigMode,
} from '../../domain/models'
import { useSalonStore } from '../../hooks/salonStoreContext'
import { useToast } from '../../hooks/toastContext'
import { downloadCsvFile } from '../../utils/csv'
import { formatDateFR, formatFCFA, todayISO } from '../../utils/format'

interface DraftVariantRow {
  key: string
  id?: string
  label: string
  price: string
  durationMinutes: string
}

interface DraftConsumableRow {
  key: string
  productId: string
  quantity: string
}

const CONFIG_MODE_OPTIONS: Array<{
  id: ServiceConfigMode
  label: string
  shortDescription: string
}> = [
  {
    id: 'simple',
    label: 'Essentiel',
    shortDescription: 'Nom, catégorie, tarif FCFA, durée et description.',
  },
  {
    id: 'pricing_variants',
    label: 'Tarifs & variantes',
    shortDescription:
      'Ajoute les variantes tarifaires (ex. Court / Long) et le verrouillage du prix en caisse.',
  },
  {
    id: 'full',
    label: 'Complet',
    shortDescription:
      'Ajoute en plus les consommables cabine par défaut et la commission spécifique par prestation.',
  },
]

function makeRowKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

function resolveMinimumModeForService(
  srv: ServiceCatalogItem,
  preferred: ServiceConfigMode,
): ServiceConfigMode {
  const hasFullFields =
    Boolean(srv.defaultConsumables && srv.defaultConsumables.length > 0) ||
    Boolean(srv.commissionOverride)
  if (hasFullFields) return 'full'

  const hasVariantFields =
    Boolean(srv.variants && srv.variants.length > 0) || Boolean(srv.priceLocked)
  if (hasVariantFields && preferred === 'simple') {
    return 'pricing_variants'
  }
  return preferred
}

export function ServicesPage() {
  const { state, categoryLabel, mutate } = useSalonStore()
  const { currentUser } = useAuth()
  const isManager = currentUser?.role !== 'cashier'
  const fieldAuth = useFieldAuth({ screen: 'services' })
  const { openCheckoutTicket } = useQuickAction()
  const { focusTarget, clearFocusTarget } = useWorkspaceFocus()
  const toast = useToast()

  const savedConfigMode: ServiceConfigMode =
    state.settings.serviceConfigMode ?? 'simple'

  const [catFilter, setCatFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState<
    'all' | 'active' | 'inactive'
  >('all')
  const [localSearch, setLocalSearch] = useState<string | null>(null)
  const [today] = useState<string>(() => todayISO())

  const isRouteFocused = focusTarget?.route === '/services'
  const search =
    localSearch !== null
      ? localSearch
      : isRouteFocused
        ? (focusTarget.searchQuery ?? '')
        : ''

  const allServiceCategories = useMemo(
    () =>
      state.categories
        .filter((c) => c.scope === 'service')
        .sort((a, b) => a.label.localeCompare(b.label)),
    [state.categories],
  )

  const serviceCategories = useMemo(
    () => allServiceCategories.filter((c) => !c.isArchived),
    [allServiceCategories],
  )

  const cabinProducts = useMemo(
    () =>
      state.products
        .filter((p) => p.isActive && p.usageType !== 'resale')
        .sort((a, b) => a.name.localeCompare(b.name)),
    [state.products],
  )

  const productById = useMemo(
    () => new Map(state.products.map((p) => [p.id, p])),
    [state.products],
  )

  const serviceCountByCatCode = useMemo(() => {
    const map = new Map<string, number>()
    for (const s of state.services) {
      map.set(s.categoryCode, (map.get(s.categoryCode) ?? 0) + 1)
    }
    return map
  }, [state.services])

  const serviceUsageStats = useMemo(() => {
    const map = new Map<string, { count: number; revenue: number }>()
    const usedEver = new Set<string>()
    for (const r of state.revenues) {
      if (r.serviceId) {
        usedEver.add(r.serviceId)
        if (!r.isArchived) {
          const cur = map.get(r.serviceId) ?? { count: 0, revenue: 0 }
          cur.count += 1
          cur.revenue += r.amount
          map.set(r.serviceId, cur)
        }
      }
    }
    return { map, usedEver }
  }, [state.revenues])

  const kpiStats = useMemo(() => {
    const active = state.services.filter((s) => s.isActive)
    const avgPrice =
      active.length > 0
        ? Math.round(
            active.reduce((sum, s) => sum + s.referencePrice, 0) / active.length,
          )
        : 0

    let topName = 'Aucune vente liée'
    let topRev = 0
    for (const s of state.services) {
      const st = serviceUsageStats.map.get(s.id)
      if (st && st.revenue > topRev) {
        topRev = st.revenue
        topName = `${s.name} (${st.count})`
      }
    }

    return {
      activeCount: active.length,
      totalCount: state.services.length,
      avgPrice,
      topName,
      topRev,
    }
  }, [state.services, serviceUsageStats.map])

  const filteredServices = useMemo(() => {
    const q = search.trim().toLowerCase()
    return state.services
      .filter((s) => catFilter === 'all' || s.categoryCode === catFilter)
      .filter((s) =>
        statusFilter === 'all'
          ? true
          : statusFilter === 'active'
            ? s.isActive
            : !s.isActive,
      )
      .filter(
        (s) =>
          !q ||
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          Boolean(
            s.variants?.some((v) => v.label.toLowerCase().includes(q)),
          ),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [state.services, catFilter, statusFilter, search])

  // Formulaire prestation
  const [formOpen, setFormOpen] = useState(false)
  const [formMode, setFormMode] = useState<ServiceConfigMode>('simple')
  const [editing, setEditing] = useState<ServiceCatalogItem | null>(null)
  const [name, setName] = useState('')
  const [categoryCode, setCategoryCode] = useState('tresses_nattes')
  const [referencePrice, setReferencePrice] = useState('')
  const [duration, setDuration] = useState('')
  const [description, setDescription] = useState('')

  // Mode 2 : Contrôle caisse & Variantes
  const [priceLocked, setPriceLocked] = useState(false)
  const [variants, setVariants] = useState<DraftVariantRow[]>([])

  // Mode 3 : Consommables cabine & Commission spécifique
  const [defaultConsumables, setDefaultConsumables] = useState<
    DraftConsumableRow[]
  >([])
  const [commissionPolicy, setCommissionPolicy] = useState<
    'default' | 'rate' | 'fixed'
  >('default')
  const [commissionValue, setCommissionValue] = useState('')

  // Création rapide de catégorie dans le formulaire prestation
  const [inlineNewCatOpen, setInlineNewCatOpen] = useState(false)
  const [inlineNewCatLabel, setInlineNewCatLabel] = useState('')

  // Modale dédiée Gestion des catégories de prestations
  const [categoriesModalOpen, setCategoriesModalOpen] = useState(false)
  const [newCategoryLabel, setNewCategoryLabel] = useState('')
  const [editingCatId, setEditingCatId] = useState<string | null>(null)
  const [editingCatLabel, setEditingCatLabel] = useState('')

  const [deleteTarget, setDeleteTarget] = useState<ServiceCatalogItem | null>(
    null,
  )
  const [busy, setBusy] = useState(false)

  const handleChangeConfigMode = async (nextMode: ServiceConfigMode) => {
    if (!isManager) return
    setFormMode(nextMode)
    if (savedConfigMode === nextMode) return
    try {
      await mutate((repo) =>
        repo.updateSettings({ serviceConfigMode: nextMode }),
      )
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : 'Impossible de sauvegarder le mode de configuration.',
      )
    }
  }

  const openCreate = () => {
    if (!isManager) return
    setEditing(null)
    setFormMode(savedConfigMode)
    setName('')
    setCategoryCode(serviceCategories[0]?.code ?? 'autre_prestation')
    setReferencePrice('')
    setDuration('')
    setDescription('')
    setPriceLocked(false)
    setVariants([])
    setDefaultConsumables([])
    setCommissionPolicy('default')
    setCommissionValue('')
    setInlineNewCatOpen(false)
    setInlineNewCatLabel('')
    setFormOpen(true)
  }

  const openEdit = (srv: ServiceCatalogItem) => {
    if (!isManager) return
    setEditing(srv)
    setFormMode(resolveMinimumModeForService(srv, savedConfigMode))
    setName(srv.name)
    setCategoryCode(srv.categoryCode)
    setReferencePrice(String(srv.referencePrice))
    setDuration(srv.durationMinutes ? String(srv.durationMinutes) : '')
    setDescription(srv.description)
    setPriceLocked(Boolean(srv.priceLocked))
    setVariants(
      (srv.variants ?? []).map((v) => ({
        key: makeRowKey('var'),
        id: v.id,
        label: v.label,
        price: String(v.price),
        durationMinutes: v.durationMinutes ? String(v.durationMinutes) : '',
      })),
    )
    setDefaultConsumables(
      (srv.defaultConsumables ?? []).map((c) => ({
        key: makeRowKey('cons'),
        productId: c.productId,
        quantity: String(c.quantity),
      })),
    )
    if (srv.commissionOverride) {
      setCommissionPolicy(srv.commissionOverride.mode)
      setCommissionValue(String(srv.commissionOverride.value))
    } else {
      setCommissionPolicy('default')
      setCommissionValue('')
    }
    setInlineNewCatOpen(false)
    setInlineNewCatLabel('')
    setFormOpen(true)
  }

  const handleCreateInlineCategory = async () => {
    if (!inlineNewCatLabel.trim()) return
    setBusy(true)
    try {
      const created = await mutate((repo) =>
        repo.addCustomCategory({
          scope: 'service',
          label: inlineNewCatLabel,
          callerRole: currentUser?.role,
        }),
      )
      setCategoryCode(created.code)
      setInlineNewCatLabel('')
      setInlineNewCatOpen(false)
      toast.success(`Catégorie « ${created.label} » créée et sélectionnée.`)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Création de catégorie refusée.',
      )
    } finally {
      setBusy(false)
    }
  }

  const handleAddCategoryInModal = async (e: FormEvent) => {
    e.preventDefault()
    if (!newCategoryLabel.trim()) return
    setBusy(true)
    try {
      const created = await mutate((repo) =>
        repo.addCustomCategory({
          scope: 'service',
          label: newCategoryLabel,
          callerRole: currentUser?.role,
        }),
      )
      setNewCategoryLabel('')
      toast.success(`Catégorie « ${created.label} » ajoutée.`)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Erreur création catégorie.',
      )
    } finally {
      setBusy(false)
    }
  }

  const handleSaveCategoryRename = async (cat: CategoryItem) => {
    if (!editingCatLabel.trim()) return
    setBusy(true)
    try {
      await mutate((repo) =>
        repo.updateCategory(
          cat.id,
          { label: editingCatLabel },
          currentUser?.role,
        ),
      )
      setEditingCatId(null)
      setEditingCatLabel('')
      toast.success('Catégorie renommée.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Renommage impossible.')
    } finally {
      setBusy(false)
    }
  }

  const handleToggleCategoryArchive = async (cat: CategoryItem) => {
    setBusy(true)
    try {
      await mutate((repo) =>
        repo.updateCategory(
          cat.id,
          { isArchived: !cat.isArchived },
          currentUser?.role,
        ),
      )
      if (!cat.isArchived && catFilter === cat.code) {
        setCatFilter('all')
      }
      toast.success(
        cat.isArchived
          ? `Catégorie « ${cat.label} » réactivée.`
          : `Catégorie « ${cat.label} » masquée des nouvelles saisies.`,
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action refusée.')
    } finally {
      setBusy(false)
    }
  }

  const addVariantRow = () => {
    setVariants((prev) => [
      ...prev,
      {
        key: makeRowKey('var'),
        label: '',
        price: referencePrice || '',
        durationMinutes: duration || '',
      },
    ])
  }

  const updateVariantRow = (
    key: string,
    patch: Partial<Omit<DraftVariantRow, 'key'>>,
  ) => {
    setVariants((prev) =>
      prev.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    )
  }

  const removeVariantRow = (key: string) => {
    setVariants((prev) => prev.filter((row) => row.key !== key))
  }

  const addConsumableRow = () => {
    const defaultProdId = cabinProducts[0]?.id ?? ''
    setDefaultConsumables((prev) => [
      ...prev,
      {
        key: makeRowKey('cons'),
        productId: defaultProdId,
        quantity: '1',
      },
    ])
  }

  const updateConsumableRow = (
    key: string,
    patch: Partial<Omit<DraftConsumableRow, 'key'>>,
  ) => {
    setDefaultConsumables((prev) =>
      prev.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    )
  }

  const removeConsumableRow = (key: string) => {
    setDefaultConsumables((prev) => prev.filter((row) => row.key !== key))
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!isManager) return
    setBusy(true)
    try {
      const includePricingControls =
        formMode === 'pricing_variants' || formMode === 'full'
      const includeFullControls = formMode === 'full'

      const preparedVariants = includePricingControls
        ? variants
            .filter((v) => v.label.trim() || v.price.trim())
            .map((v) => ({
              id: v.id,
              label: v.label,
              price: Number(v.price),
              durationMinutes: v.durationMinutes.trim()
                ? Number(v.durationMinutes)
                : undefined,
            }))
        : editing
          ? []
          : undefined

      const preparedConsumables = includeFullControls
        ? defaultConsumables
            .filter((c) => c.productId.trim())
            .map((c) => ({
              productId: c.productId,
              quantity: Number(c.quantity),
            }))
        : editing
          ? []
          : undefined

      let preparedCommission: ServiceCommissionOverride | null | undefined =
        editing ? null : undefined
      if (includeFullControls) {
        if (commissionPolicy === 'rate' || commissionPolicy === 'fixed') {
          preparedCommission = {
            mode: commissionPolicy,
            value: Number(commissionValue),
          }
        } else {
          preparedCommission = null
        }
      }

      await mutate((repo) =>
        repo.saveService({
          id: editing?.id,
          name,
          categoryCode,
          referencePrice: Number(referencePrice),
          durationMinutes: duration.trim() ? Number(duration) : undefined,
          description,
          priceLocked: includePricingControls ? priceLocked : false,
          variants: preparedVariants,
          defaultConsumables: preparedConsumables,
          commissionOverride: preparedCommission,
          callerRole: currentUser?.role,
        }),
      )
      toast.success(
        editing
          ? 'Prestation mise à jour.'
          : 'Prestation ajoutée au catalogue.',
      )
      setFormOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur prestation.')
    } finally {
      setBusy(false)
    }
  }

  const handleToggleActive = async (srv: ServiceCatalogItem) => {
    if (!isManager) return
    try {
      await mutate((repo) =>
        repo.toggleServiceStatus(srv.id, currentUser?.role),
      )
      toast.success(
        srv.isActive
          ? `Prestation « ${srv.name} » désactivée (historique financier conservé).`
          : `Prestation « ${srv.name} » réactivée.`,
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action refusée.')
    }
  }

  const handleDeleteUnused = async () => {
    if (!deleteTarget || !isManager) return
    setBusy(true)
    try {
      await mutate((repo) =>
        repo.deleteServiceIfUnused(deleteTarget.id, currentUser?.role),
      )
      setDeleteTarget(null)
      toast.success('Prestation non utilisée supprimée du catalogue.')
    } catch (err) {
      setDeleteTarget(null)
      toast.error(err instanceof Error ? err.message : 'Suppression refusée.')
    } finally {
      setBusy(false)
    }
  }

  const handleExportCSV = () => {
    downloadCsvFile(
      `catalogue-prestations-${today}.csv`,
      [
        'Prestation',
        'Catégorie',
        'Durée (min)',
        'Tarif standard FCFA',
        'Prix en caisse',
        'Variantes',
        'Statut',
        'Réalisations',
        'CA généré FCFA',
      ],
      filteredServices.map((s) => {
        const st = serviceUsageStats.map.get(s.id) ?? { count: 0, revenue: 0 }
        const variantsText =
          s.variants && s.variants.length > 0
            ? s.variants.map((v) => `${v.label}: ${v.price} FCFA`).join(' | ')
            : ''
        return [
          s.name,
          categoryLabel('service', s.categoryCode),
          s.durationMinutes ?? '',
          s.referencePrice,
          s.priceLocked ? 'Fixe verrouillé' : 'Ajustable',
          variantsText,
          s.isActive ? 'Actif' : 'Inactif',
          st.count,
          st.revenue,
        ]
      }),
    )
    toast.success('Catalogue tarifaire exporté en CSV.')
  }

  const activeModeMeta =
    CONFIG_MODE_OPTIONS.find((m) => m.id === savedConfigMode) ??
    CONFIG_MODE_OPTIONS[0]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div
        className="print-only"
        style={{
          borderBottom: '2px solid #111827',
          paddingBottom: 10,
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: '1.15rem', fontWeight: 800 }}>
          {state.salon.name || 'SALON'} — GRILLE TARIFAIRE DES PRESTATIONS
        </div>
        <div style={{ fontSize: '0.8rem', color: '#4b5563' }}>
          {state.salon.address} · Tél : {state.salon.phone} · Éditée le{' '}
          {formatDateFR(today, 'long-fr')}
        </div>
      </div>

      <div className="page-header no-print">
        <div>
          <h1 className="page-title">Prestations et tarifs</h1>
          <p className="page-subtitle">
            {isManager
              ? 'Configuration du catalogue, des familles de prestations et des règles tarifaires'
              : 'Consultation de la grille tarifaire du salon et encaissement direct'}
          </p>
        </div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 8,
          }}
        >
          {!isManager && (
            <Badge variant="secondary" size="sm">
              <Lock className="size-3" aria-hidden="true" />
              Configuration réservée au Gérant
            </Badge>
          )}
          <Button type="button" variant="outline" onClick={handleExportCSV}>
            <Download size={15} />
            CSV
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => window.print()}
          >
            <Printer size={15} />
            Grille A4
          </Button>
          {isManager && (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCategoriesModalOpen(true)}
              >
                <FolderPlus size={15} />
                Catégories
              </Button>
              <Button type="button" onClick={openCreate}>
                <Plus size={15} />
                Nouvelle prestation
              </Button>
            </>
          )}
        </div>
      </div>

      <section className="kpi-grid-3 no-print">
        <KpiCard
          label="Prestations actives"
          value={String(kpiStats.activeCount)}
          icon={<Scissors size={18} />}
          tone="emerald"
          subtitle={`Sur ${kpiStats.totalCount} au catalogue`}
        />
        <KpiCard
          label="Tarif moyen actif"
          value={formatFCFA(kpiStats.avgPrice)}
          icon={<Clock size={18} />}
          tone="blue"
          subtitle="Moyenne catalogue"
        />
        <KpiCard
          label="Prestation phare"
          value={kpiStats.topRev > 0 ? formatFCFA(kpiStats.topRev) : '—'}
          icon={<TrendingUp size={18} />}
          tone="amber"
          subtitle={kpiStats.topName}
        />
      </section>

      <div
        className="surface-card no-print"
        style={{
          padding: '16px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        {isManager && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              paddingBottom: 12,
              borderBottom: '1px solid var(--border-subtle)',
            }}
          >
            <div className="flex flex-col gap-0.5">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
                <SlidersHorizontal size={13} />
                Mode de configuration des prestations
              </span>
              <span className="text-muted-foreground text-xs">
                {activeModeMeta.shortDescription}
              </span>
            </div>

            <div
              role="group"
              aria-label="Mode de configuration des prestations"
              style={{
                display: 'inline-flex',
                flexWrap: 'wrap',
                gap: 4,
                padding: 3,
                borderRadius: 9,
                background: 'var(--bg-surface-muted)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              {CONFIG_MODE_OPTIONS.map((opt) => {
                const active = savedConfigMode === opt.id
                return (
                  <Button
                    key={opt.id}
                    type="button"
                    size="xs"
                    variant={active ? 'default' : 'ghost'}
                    aria-pressed={active}
                    onClick={() => void handleChangeConfigMode(opt.id)}
                  >
                    {opt.label}
                  </Button>
                )
              })}
            </div>
          </div>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
            gap: 14,
            alignItems: 'end',
          }}
        >
          <Field>
            <FieldLabel htmlFor="srv-cat">Catégorie</FieldLabel>
            <Select value={catFilter} onValueChange={setCatFilter}>
              <SelectTrigger id="srv-cat">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Toutes les catégories</SelectItem>
                {serviceCategories.map((c) => (
                  <SelectItem key={c.code} value={c.code}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="srv-status">Statut</FieldLabel>
            <Select
              value={statusFilter}
              onValueChange={(v) =>
                setStatusFilter(v as 'all' | 'active' | 'inactive')
              }
            >
              <SelectTrigger id="srv-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Toutes</SelectItem>
                <SelectItem value="active">Actives uniquement</SelectItem>
                <SelectItem value="inactive">Inactives uniquement</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="srv-search">
              Rechercher une prestation
            </FieldLabel>
            <div style={{ position: 'relative' }}>
              <Search
                size={15}
                style={{
                  position: 'absolute',
                  left: 11,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'var(--text-muted)',
                  pointerEvents: 'none',
                }}
              />
              <Input
                id="srv-search"
                type="search"
                style={{ paddingLeft: 34 }}
                placeholder="Coupe, Tresses, Brushing, Soin..."
                value={search}
                onChange={(e) => {
                  if (isRouteFocused) clearFocusTarget()
                  setLocalSearch(e.target.value)
                }}
              />
            </div>
          </Field>
        </div>
      </div>

      <Card>
        <CardContent style={{ paddingTop: 6 }}>
          {filteredServices.length === 0 ? (
            <EmptyState
              icon={<Scissors size={24} />}
              title="Aucune prestation au catalogue"
              description={
                isManager
                  ? 'Ajoutez vos prestations habituelles avec leur tarif en FCFA et le niveau de détail de votre choix.'
                  : "Aucune prestation ne correspond aux filtres ou le Gérant n'a pas encore configuré la grille tarifaire."
              }
              actionLabel={isManager ? 'Créer une prestation' : undefined}
              onAction={isManager ? openCreate : undefined}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Prestation</TableHead>
                  <TableHead>Catégorie</TableHead>
                  <TableHead>Tarif &amp; options</TableHead>
                  <TableHead className="no-print">Statut</TableHead>
                  <TableHead className="text-right no-print">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredServices.map((srv) => {
                  const isUsed = serviceUsageStats.usedEver.has(srv.id)
                  const stats = serviceUsageStats.map.get(srv.id) ?? {
                    count: 0,
                    revenue: 0,
                  }

                  const metaParts: string[] = []
                  if (srv.durationMinutes) {
                    metaParts.push(`${srv.durationMinutes} min`)
                  }
                  if (stats.count > 0) {
                    metaParts.push(
                      `${stats.count} réal. · ${formatFCFA(stats.revenue)}`,
                    )
                  }
                  if (srv.description) {
                    metaParts.push(srv.description)
                  }

                  const consumablesCount = srv.defaultConsumables?.length ?? 0

                  return (
                    <TableRow
                      key={srv.id}
                      style={{ opacity: srv.isActive ? 1 : 0.64 }}
                    >
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-medium">
                              {srv.name}
                            </span>
                            {srv.priceLocked && (
                              <Badge variant="outline" size="sm">
                                <Lock className="size-3" aria-hidden="true" />
                                Tarif fixe
                              </Badge>
                            )}
                            {srv.commissionOverride && (
                              <Badge variant="info-light" size="sm">
                                <Percent
                                  className="size-3"
                                  aria-hidden="true"
                                />
                                {srv.commissionOverride.mode === 'rate'
                                  ? `Comm. ${srv.commissionOverride.value}%`
                                  : `Prime ${formatFCFA(srv.commissionOverride.value)}`}
                              </Badge>
                            )}
                            {consumablesCount > 0 && (
                              <Badge variant="secondary" size="sm">
                                <Package
                                  className="size-3"
                                  aria-hidden="true"
                                />
                                {consumablesCount} cons. cabine
                              </Badge>
                            )}
                          </div>
                          {metaParts.length > 0 && (
                            <span className="text-muted-foreground text-xs">
                              {metaParts.join(' · ')}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" size="sm">
                          {categoryLabel('service', srv.categoryCode)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <span className="text-sm font-semibold tabular-nums">
                            {formatFCFA(srv.referencePrice)}
                          </span>
                          {srv.variants && srv.variants.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {srv.variants.map((v) => (
                                <button
                                  key={v.id}
                                  type="button"
                                  disabled={!srv.isActive}
                                  title={
                                    srv.isActive
                                      ? `Encaisser directement « ${srv.name} — ${v.label} »`
                                      : undefined
                                  }
                                  onClick={() => {
                                    if (!srv.isActive) return
                                    openCheckoutTicket({
                                      serviceId: srv.id,
                                      variantId: v.id,
                                    })
                                  }}
                                  className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors disabled:pointer-events-none"
                                  style={{
                                    borderColor: 'var(--border-subtle)',
                                    background: 'var(--bg-surface-muted)',
                                  }}
                                >
                                  <span>{v.label}</span>
                                  <span className="font-semibold tabular-nums">
                                    {formatFCFA(v.price)}
                                  </span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="no-print">
                        <Badge
                          variant={
                            srv.isActive ? 'success-light' : 'destructive-light'
                          }
                          size="sm"
                        >
                          {srv.isActive ? 'Actif' : 'Inactif'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right no-print">
                        <div className="inline-flex items-center justify-end gap-1">
                          {srv.isActive && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7"
                              title="Encaisser cette prestation sur un Ticket client"
                              onClick={() =>
                                openCheckoutTicket({ serviceId: srv.id })
                              }
                            >
                              <Receipt className="size-3.5" aria-hidden="true" />
                              Encaisser
                            </Button>
                          )}
                          {isManager && (
                            <>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7"
                                title="Modifier"
                                onClick={() => openEdit(srv)}
                              >
                                <SettingsIcon
                                  className="size-3.5"
                                  aria-hidden="true"
                                />
                                Gérer
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                title={
                                  srv.isActive
                                    ? 'Désactiver cette prestation'
                                    : 'Réactiver cette prestation'
                                }
                                onClick={() => void handleToggleActive(srv)}
                              >
                                <Power size={14} />
                              </Button>
                              {!isUsed && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-xs"
                                  style={{ color: 'var(--color-danger)' }}
                                  title="Supprimer (non utilisée dans l'historique)"
                                  onClick={() => setDeleteTarget(srv)}
                                >
                                  <Trash2 size={14} />
                                </Button>
                              )}
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Modale Création / Édition d'une prestation */}
      {isManager && (
        <Modal
          open={formOpen}
          title={
            editing
              ? 'Modifier la prestation'
              : 'Nouvelle prestation au catalogue'
          }
          subtitle="Choisissez le niveau de configuration adapté aux besoins de votre salon."
          maxWidth={640}
          onClose={() => setFormOpen(false)}
        >
          <form className="w-full" onSubmit={(e) => void handleSubmit(e)}>
            <FieldGroup>
              {/* Sélecteur de niveau directement dans le formulaire */}
              <div
                style={{
                  padding: '10px 12px',
                  borderRadius: 10,
                  background: 'var(--bg-surface-muted)',
                  border: '1px solid var(--border-subtle)',
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <span className="text-xs font-medium">
                  Paramètres affichés :
                </span>
                <div className="flex flex-wrap gap-1">
                  {CONFIG_MODE_OPTIONS.map((opt) => {
                    const active = formMode === opt.id
                    return (
                      <Button
                        key={opt.id}
                        type="button"
                        size="xs"
                        variant={active ? 'default' : 'ghost'}
                        onClick={() => void handleChangeConfigMode(opt.id)}
                      >
                        {opt.label}
                      </Button>
                    )
                  })}
                </div>
              </div>

              <Field>
                <FieldLabel htmlFor="f-srv-name">
                  Nom de la prestation
                </FieldLabel>
                <Input
                  id="f-srv-name"
                  type="text"
                  required
                  placeholder="Ex. Coupe dégradé, Tresses sans nœuds, Brushing..."
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field>
                  <div className="flex items-center justify-between">
                    <FieldLabel htmlFor="f-srv-cat">Catégorie</FieldLabel>
                    <button
                      type="button"
                      onClick={() => setInlineNewCatOpen((v) => !v)}
                      className="text-primary hover:underline text-xs font-medium"
                    >
                      {inlineNewCatOpen ? 'Fermer' : '+ Nouvelle catégorie'}
                    </button>
                  </div>
                  <Select value={categoryCode} onValueChange={setCategoryCode}>
                    <SelectTrigger id="f-srv-cat">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {serviceCategories.map((c) => (
                        <SelectItem key={c.code} value={c.code}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {inlineNewCatOpen && (
                    <div className="mt-2 flex items-center gap-2">
                      <Input
                        type="text"
                        aria-label="Nom de la nouvelle catégorie"
                        placeholder="Ex. Locks & Vanilles"
                        value={inlineNewCatLabel}
                        onChange={(e) => setInlineNewCatLabel(e.target.value)}
                      />
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy || inlineNewCatLabel.trim().length < 2}
                        onClick={() => void handleCreateInlineCategory()}
                      >
                        Créer
                      </Button>
                    </div>
                  )}
                </Field>

                <Field>
                  <FieldLabel htmlFor="f-srv-price">
                    Tarif standard (FCFA)
                  </FieldLabel>
                  <Input
                    id="f-srv-price"
                    type="number"
                    min={1}
                    step={1}
                    required
                    placeholder="Ex. 10000"
                    value={referencePrice}
                    onChange={(e) => setReferencePrice(e.target.value)}
                    disabled={!fieldAuth.canWrite('price')}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="f-srv-dur">
                    Durée indicative (min)
                  </FieldLabel>
                  <Input
                    id="f-srv-dur"
                    type="number"
                    min={5}
                    step={5}
                    placeholder="Ex. 60"
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="f-srv-desc">
                    Description courte (optionnel)
                  </FieldLabel>
                  <Input
                    id="f-srv-desc"
                    type="text"
                    placeholder="Ex. Shampoing et finition inclus"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </Field>
              </div>

              {/* Niveau 2 : Tarifs, variantes & contrôle du prix en caisse */}
              {(formMode === 'pricing_variants' || formMode === 'full') && (
                <div
                  style={{
                    padding: 14,
                    borderRadius: 10,
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-surface-muted)',
                  }}
                  className="space-y-4"
                >
                  <Field>
                    <FieldLabel htmlFor="f-srv-price-policy">
                      Contrôle du tarif en caisse
                    </FieldLabel>
                    <Select
                      value={priceLocked ? 'locked' : 'adjustable'}
                      onValueChange={(v) => setPriceLocked(v === 'locked')}
                      disabled={!fieldAuth.canWrite('price')}
                    >
                      <SelectTrigger id="f-srv-price-policy">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="adjustable">
                          Prix ajustable en caisse (selon longueur ou devis)
                        </SelectItem>
                        <SelectItem value="locked">
                          Tarif fixe verrouillé pour le Caissier
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>

                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold">
                        Variantes tarifaires optionnelles ({variants.length})
                      </span>
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={addVariantRow}
                      >
                        <Plus size={13} />
                        Ajouter une variante
                      </Button>
                    </div>

                    {variants.length === 0 ? (
                      <p className="text-muted-foreground text-xs">
                        Utile pour décliner une prestation (ex. Court, Mi-long,
                        Long) avec un tarif dédié en FCFA.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {variants.map((vRow, idx) => (
                          <div
                            key={vRow.key}
                            style={{
                              display: 'grid',
                              gridTemplateColumns: '1.5fr 1fr 0.8fr auto',
                              gap: 8,
                              alignItems: 'end',
                            }}
                          >
                            <Field>
                              {idx === 0 && (
                                <FieldLabel>Libellé variante</FieldLabel>
                              )}
                              <Input
                                type="text"
                                aria-label={`Libellé variante ${idx + 1}`}
                                placeholder="Ex. Long / Mi-dos"
                                required
                                value={vRow.label}
                                onChange={(e) =>
                                  updateVariantRow(vRow.key, {
                                    label: e.target.value,
                                  })
                                }
                              />
                            </Field>
                            <Field>
                              {idx === 0 && <FieldLabel>Tarif FCFA</FieldLabel>}
                              <Input
                                type="number"
                                aria-label={`Tarif variante ${idx + 1}`}
                                min={1}
                                step={1}
                                placeholder="15000"
                                required
                                value={vRow.price}
                                onChange={(e) =>
                                  updateVariantRow(vRow.key, {
                                    price: e.target.value,
                                  })
                                }
                              />
                            </Field>
                            <Field>
                              {idx === 0 && (
                                <FieldLabel>Durée (min)</FieldLabel>
                              )}
                              <Input
                                type="number"
                                aria-label={`Durée variante ${idx + 1}`}
                                min={5}
                                step={5}
                                placeholder="90"
                                value={vRow.durationMinutes}
                                onChange={(e) =>
                                  updateVariantRow(vRow.key, {
                                    durationMinutes: e.target.value,
                                  })
                                }
                              />
                            </Field>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              style={{
                                color: 'var(--color-danger)',
                                marginBottom: 4,
                              }}
                              aria-label={`Supprimer variante ${idx + 1}`}
                              onClick={() => removeVariantRow(vRow.key)}
                            >
                              <Trash2 size={14} />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Niveau 3 : Consommables cabine & Commission spécifique */}
              {formMode === 'full' && (
                <div
                  style={{
                    padding: 14,
                    borderRadius: 10,
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-surface-muted)',
                  }}
                  className="space-y-4"
                >
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold">
                        Consommables cabine par défaut (
                        {defaultConsumables.length})
                      </span>
                      {cabinProducts.length > 0 && (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={addConsumableRow}
                        >
                          <Package size={13} />
                          Lier un consommable
                        </Button>
                      )}
                    </div>

                    {cabinProducts.length === 0 ? (
                      <p className="text-muted-foreground text-xs">
                        Aucun produit cabine enregistré dans le module Stock.
                        Ajoutez d&apos;abord vos consommables en stock pour les
                        lier ici.
                      </p>
                    ) : defaultConsumables.length === 0 ? (
                      <p className="text-muted-foreground text-xs">
                        Pré-remplit automatiquement les produits utilisés en
                        cabine lors de l&apos;encaissement d&apos;un Ticket
                        client.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {defaultConsumables.map((cRow, idx) => {
                          const prod = productById.get(cRow.productId)
                          return (
                            <div
                              key={cRow.key}
                              style={{
                                display: 'grid',
                                gridTemplateColumns: '2fr 0.8fr auto',
                                gap: 8,
                                alignItems: 'end',
                              }}
                            >
                              <Field>
                                {idx === 0 && (
                                  <FieldLabel>Produit cabine</FieldLabel>
                                )}
                                <Select
                                  value={cRow.productId}
                                  onValueChange={(v) =>
                                    updateConsumableRow(cRow.key, {
                                      productId: v,
                                    })
                                  }
                                >
                                  <SelectTrigger
                                    aria-label={`Produit consommable ${idx + 1}`}
                                  >
                                    <SelectValue placeholder="Choisir un produit…" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {cabinProducts.map((p) => (
                                      <SelectItem key={p.id} value={p.id}>
                                        {p.name} ({p.unit})
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </Field>
                              <Field>
                                {idx === 0 && (
                                  <FieldLabel>
                                    Qté ({prod?.unit ?? 'unité'})
                                  </FieldLabel>
                                )}
                                <Input
                                  type="number"
                                  aria-label={`Quantité consommable ${idx + 1}`}
                                  min={1}
                                  step={1}
                                  required
                                  value={cRow.quantity}
                                  onChange={(e) =>
                                    updateConsumableRow(cRow.key, {
                                      quantity: e.target.value,
                                    })
                                  }
                                />
                              </Field>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                style={{
                                  color: 'var(--color-danger)',
                                  marginBottom: 4,
                                }}
                                aria-label={`Supprimer consommable ${idx + 1}`}
                                onClick={() => removeConsumableRow(cRow.key)}
                              >
                                <Trash2 size={14} />
                              </Button>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor="f-srv-comm-mode">
                        Commission employé sur cette prestation
                      </FieldLabel>
                      <Select
                        value={commissionPolicy}
                        onValueChange={(v) =>
                          setCommissionPolicy(v as 'default' | 'rate' | 'fixed')
                        }
                        disabled={!fieldAuth.canWrite('commissionRate')}
                      >
                        <SelectTrigger id="f-srv-comm-mode">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">
                            Taux habituel de l&apos;employé (par défaut)
                          </SelectItem>
                          <SelectItem value="rate">
                            Taux spécifique (%) sur cette prestation
                          </SelectItem>
                          <SelectItem value="fixed">
                            Prime fixe (FCFA) par prestation réalisée
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>

                    {commissionPolicy !== 'default' && (
                      <Field>
                        <FieldLabel htmlFor="f-srv-comm-val">
                          {commissionPolicy === 'rate'
                            ? 'Taux spécifique (%)'
                            : 'Prime fixe (FCFA)'}
                        </FieldLabel>
                        <Input
                          id="f-srv-comm-val"
                          type="number"
                          min={commissionPolicy === 'rate' ? 0.5 : 0}
                          max={commissionPolicy === 'rate' ? 100 : undefined}
                          step={commissionPolicy === 'rate' ? 0.5 : 1}
                          required
                          placeholder={
                            commissionPolicy === 'rate' ? 'Ex. 15' : 'Ex. 2000'
                          }
                          value={commissionValue}
                          onChange={(e) => setCommissionValue(e.target.value)}
                          disabled={!fieldAuth.canWrite('commissionRate')}
                        />
                      </Field>
                    )}
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setFormOpen(false)}
                >
                  Annuler
                </Button>
                <Button type="submit" disabled={busy}>
                  {editing ? 'Enregistrer' : 'Ajouter au catalogue'}
                </Button>
              </div>
            </FieldGroup>
          </form>
        </Modal>
      )}

      {/* Modale Gestion directe des catégories de prestations */}
      {isManager && (
        <Modal
          open={categoriesModalOpen}
          title="Catégories de prestations"
          subtitle="Créez, renommez ou masquez les familles de prestations de votre salon."
          maxWidth={560}
          onClose={() => {
            setCategoriesModalOpen(false)
            setEditingCatId(null)
          }}
        >
          <div className="space-y-4">
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => void handleAddCategoryInModal(e)}
            >
              <Field className="flex-1">
                <FieldLabel htmlFor="f-new-srv-cat">
                  Nouvelle catégorie de prestations
                </FieldLabel>
                <Input
                  id="f-new-srv-cat"
                  type="text"
                  required
                  placeholder="Ex. Locks & Vanilles, Onglerie, Visage..."
                  value={newCategoryLabel}
                  onChange={(e) => setNewCategoryLabel(e.target.value)}
                />
              </Field>
              <Button
                type="submit"
                disabled={busy || newCategoryLabel.trim().length < 2}
              >
                <Plus size={15} />
                Ajouter
              </Button>
            </form>

            <div
              style={{
                border: '1px solid var(--border-subtle)',
                borderRadius: 10,
                overflow: 'hidden',
              }}
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Famille</TableHead>
                    <TableHead>Prestations</TableHead>
                    <TableHead>Statut</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {allServiceCategories.map((cat) => {
                    const count = serviceCountByCatCode.get(cat.code) ?? 0
                    const isEditingRow = editingCatId === cat.id

                    return (
                      <TableRow
                        key={cat.id}
                        style={{ opacity: cat.isArchived ? 0.6 : 1 }}
                      >
                        <TableCell>
                          {isEditingRow ? (
                            <div className="flex items-center gap-1.5">
                              <Input
                                type="text"
                                aria-label="Nouveau nom de la catégorie"
                                value={editingCatLabel}
                                onChange={(e) =>
                                  setEditingCatLabel(e.target.value)
                                }
                              />
                              <Button
                                type="button"
                                size="icon-xs"
                                aria-label="Valider le renommage"
                                disabled={busy}
                                onClick={() =>
                                  void handleSaveCategoryRename(cat)
                                }
                              >
                                <Check size={13} />
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                aria-label="Annuler le renommage"
                                onClick={() => setEditingCatId(null)}
                              >
                                <X size={13} />
                              </Button>
                            </div>
                          ) : (
                            <span className="text-sm font-medium">
                              {cat.label}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs tabular-nums">
                          {count}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              cat.isArchived ? 'secondary' : 'success-light'
                            }
                            size="sm"
                          >
                            {cat.isArchived ? 'Masquée' : 'Active'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="inline-flex items-center justify-end gap-1">
                            {!isEditingRow && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                title="Renommer"
                                aria-label={`Renommer ${cat.label}`}
                                onClick={() => {
                                  setEditingCatId(cat.id)
                                  setEditingCatLabel(cat.label)
                                }}
                              >
                                <Pencil size={13} />
                              </Button>
                            )}
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              title={
                                cat.isArchived
                                  ? 'Réactiver la catégorie'
                                  : 'Masquer la catégorie'
                              }
                              aria-label={
                                cat.isArchived
                                  ? `Réactiver ${cat.label}`
                                  : `Masquer ${cat.label}`
                              }
                              disabled={busy}
                              onClick={() =>
                                void handleToggleCategoryArchive(cat)
                              }
                            >
                              <Power size={13} />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        </Modal>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Supprimer cette prestation ?"
        message={
          deleteTarget
            ? `La prestation « ${deleteTarget.name} » n'est rattachée à aucune recette et sera retirée du catalogue.`
            : ''
        }
        confirmLabel="Supprimer"
        busy={busy}
        onConfirm={() => void handleDeleteUnused()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
