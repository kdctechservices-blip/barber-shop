import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  Loader2,
  ShieldCheck,
  Store,
  UserPlus,
  Users,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
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
import { useAuth } from '../../contexts/authContext'
import {
  BillingApiError,
  cancelSubscription,
  fetchPlanCatalog,
  fetchSubscription,
  subscribeToPlan,
  type PlanCatalog,
  type PlanCode,
  type SubscriptionSnapshot,
} from '../../lib/billingClient'
import {
  TeamApiError,
  addTeamMember,
  fetchTeamMembers,
  updateTeamMember,
  type TeamMember,
} from '../../lib/teamClient'
import { useToast } from '../../hooks/toastContext'
import { formatDateFR, formatFCFA } from '../../utils/format'

/**
 * Équipe et abonnement (Sprint 8).
 *
 * Trois usages :
 *  - ajouter / promouvoir / désactiver les collaborateurs du salon (l'API
 *    vérifie le rôle Gérant **en base**, l'écran n'est qu'une interface) ;
 *  - suivre la consommation de l'offre (membres, salons) et ses limites ;
 *  - demander une offre supérieure. Aucune offre payante ne s'active ici : la
 *    demande passe en attente de paiement, l'activation est réservée au canal
 *    plateforme.
 *
 * Hors mode Neon (données locales uniquement), l'écran liste les comptes de
 * l'appareil et explique que la gestion d'équipe est une fonction cloud.
 */

const STATUS_LABELS: Record<SubscriptionSnapshot['status'], string> = {
  trialing: 'Essai en cours',
  active: 'Actif',
  pending_payment: 'En attente de paiement',
  past_due: 'Échéance dépassée',
  cancelled: 'Résilié',
}

function statusTone(
  status: SubscriptionSnapshot['status'],
): 'success' | 'warning' | 'destructive' | 'info' {
  if (status === 'active') return 'success'
  if (status === 'trialing') return 'info'
  if (status === 'pending_payment' || status === 'past_due') return 'warning'
  return 'destructive'
}

function roleLabel(role: 'manager' | 'cashier'): string {
  return role === 'manager' ? 'Gérant' : 'Caissier'
}

function limitLabel(value: number | null): string {
  return value === null ? 'illimité' : String(value)
}

export function TeamPage() {
  const auth = useAuth()
  const toast = useToast()

  const cloudMode = auth.authMode === 'cloud_neon' && Boolean(auth.sessionToken)

  const [members, setMembers] = useState<TeamMember[]>([])
  const [catalog, setCatalog] = useState<PlanCatalog | null>(null)
  const [subscription, setSubscription] = useState<SubscriptionSnapshot | null>(
    null,
  )
  const [loading, setLoading] = useState(cloudMode)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    fullName: '',
    email: '',
    phone: '',
    password: '',
    role: 'cashier' as 'manager' | 'cashier',
  })

  const load = useCallback(async () => {
    if (!cloudMode) {
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError(null)
    try {
      const [team, snapshot, catalogue] = await Promise.all([
        fetchTeamMembers(),
        fetchSubscription(),
        fetchPlanCatalog(),
      ])
      setMembers(team)
      setSubscription(snapshot)
      setCatalog(catalogue)
    } catch (err) {
      setLoadError(
        err instanceof Error
          ? err.message
          : 'Impossible de charger l’équipe et l’abonnement.',
      )
    } finally {
      setLoading(false)
    }
  }, [cloudMode])

  useEffect(() => {
    // Le chargement met à jour l'état dès son premier `setState` : on le lance
    // dans une microtâche pour ne pas déclencher de rendu en cascade synchrone.
    let cancelled = false
    Promise.resolve().then(() => {
      if (!cancelled) void load()
    })
    return () => {
      cancelled = true
    }
  }, [load])

  const plan = subscription?.plan ?? null
  const limits = subscription?.limits ?? null
  const usage = subscription?.usage ?? null
  const employeeLimitReached = useMemo(() => {
    if (!limits || !usage) return false
    return limits.members !== null && usage.members >= limits.members
  }, [limits, usage])

  const handleAddMember = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    try {
      const created = await addTeamMember({
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        phone: form.phone.trim() || undefined,
        password: form.password,
        role: form.role,
      })
      setMembers((current) => [...current, created])
      setAddOpen(false)
      setForm({ fullName: '', email: '', phone: '', password: '', role: 'cashier' })
      toast.success(`${created.fullName} a été ajouté à l’équipe.`)
      void load()
    } catch (err) {
      if (err instanceof TeamApiError && err.code === 'PLAN_LIMIT_REACHED') {
        toast.error(
          `${err.message} Passez à une offre supérieure pour agrandir l’équipe.`,
        )
      } else {
        toast.error(
          err instanceof Error ? err.message : 'Ajout impossible pour le moment.',
        )
      }
    } finally {
      setSaving(false)
    }
  }

  const handleMemberPatch = async (
    member: TeamMember,
    patch: Parameters<typeof updateTeamMember>[1],
  ) => {
    setBusyId(member.id)
    try {
      const updated = await updateTeamMember(member.id, patch)
      setMembers((current) =>
        current.map((entry) => (entry.id === updated.id ? updated : entry)),
      )
      toast.success(`Compte de ${updated.fullName} mis à jour.`)
      // Rôle ou activation modifiés : les sessions du compte sont révoquées.
      if (patch.role !== undefined || patch.isActive !== undefined) {
        toast.warning(
          'Les sessions ouvertes de ce compte ont été révoquées par sécurité.',
        )
      }
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : 'Modification du compte impossible.',
      )
    } finally {
      setBusyId(null)
    }
  }

  const handleSubscribe = async (planCode: PlanCode) => {
    setBusyId(`plan:${planCode}`)
    try {
      const outcome = await subscribeToPlan(planCode)
      setSubscription(outcome)
      if (outcome.applied) {
        toast.success(outcome.message)
      } else {
        toast.warning(outcome.message)
      }
    } catch (err) {
      toast.error(
        err instanceof BillingApiError
          ? `${err.message}`
          : 'Demande de changement d’offre impossible.',
      )
    } finally {
      setBusyId(null)
    }
  }

  const handleCancel = async () => {
    setBusyId('cancel')
    try {
      const updated = await cancelSubscription()
      setSubscription(updated)
      toast.warning(
        'Résiliation enregistrée : l’offre reste active jusqu’à la fin de la période payée.',
      )
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Résiliation impossible.',
      )
    } finally {
      setBusyId(null)
    }
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
          <Users size={20} /> Équipe et abonnement
        </h1>
        <p style={{ margin: '6px 0 0', color: 'var(--text-muted)', fontSize: '0.86rem' }}>
          Collaborateurs du salon, rôles et consommation de votre offre. Les
          droits sont vérifiés côté serveur à chaque action.
        </p>
      </div>

      {!cloudMode && (
        <Card tilt3d={false}>
          <CardContent style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ShieldCheck size={16} />
              <strong>Gestion d’équipe cloud</strong>
            </div>
            <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              Vous travaillez en local (hors-ligne) : les comptes de cet appareil
              restent utilisables, mais l’ajout de collaborateurs, la bascule de
              salon et l’abonnement nécessitent la synchronisation Neon.
            </p>
            <div style={{ display: 'grid', gap: 6 }}>
              {auth.localAccounts.map((account) => (
                <div
                  key={account.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 10,
                    fontSize: '0.85rem',
                    padding: '6px 0',
                    borderBottom: '1px solid var(--border-subtle)',
                  }}
                >
                  <span>{account.fullName}</span>
                  <Badge size="sm" variant="outline">
                    {roleLabel(account.role)}
                  </Badge>
                </div>
              ))}
              {auth.localAccounts.length === 0 && (
                <EmptyState
                  icon={<Users size={18} />}
                  title="Aucun compte local"
                  description="Créez un compte Gérant depuis l’écran de connexion."
                />
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {cloudMode && (
        <>
          {loading && (
            <Card tilt3d={false}>
              <CardContent
                style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              >
                <Loader2 size={16} className="spin" /> Chargement de l’équipe et
                de l’abonnement…
              </CardContent>
            </Card>
          )}

          {loadError && !loading && (
            <Card tilt3d={false}>
              <CardContent style={{ display: 'grid', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <AlertTriangle size={16} /> Équipe indisponible
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

          {!loading && !loadError && subscription && plan && limits && usage && (
            <Card tilt3d={false}>
              <CardContent style={{ display: 'grid', gap: 12 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <CreditCard size={16} />
                    <strong>Offre {plan.name}</strong>
                    <Badge size="sm" variant={statusTone(subscription.status)}>
                      {STATUS_LABELS[subscription.status]}
                    </Badge>
                    {subscription.subscription.cancelAtPeriodEnd && (
                      <Badge size="sm" variant="outline">
                        Résiliation programmée
                      </Badge>
                    )}
                  </div>
                  <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                    {plan.priceFcfa === null
                      ? 'Sur devis'
                      : plan.priceFcfa === 0
                        ? 'Gratuit'
                        : `${formatFCFA(plan.priceFcfa)} / mois`}
                  </div>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                    gap: 10,
                    fontSize: '0.84rem',
                  }}
                >
                  <div>
                    <div style={{ color: 'var(--text-muted)' }}>Membres</div>
                    <strong>
                      {usage.members} / {limitLabel(limits.members)}
                    </strong>
                  </div>
                  <div>
                    <div style={{ color: 'var(--text-muted)' }}>Salons</div>
                    <strong>
                      {usage.salons} / {limitLabel(limits.salons)}
                    </strong>
                  </div>
                  <div>
                    <div style={{ color: 'var(--text-muted)' }}>
                      {subscription.status === 'trialing'
                        ? 'Fin de l’essai'
                        : 'Échéance'}
                    </div>
                    <strong>
                      {subscription.subscription.currentPeriodEnd
                        ? formatDateFR(subscription.subscription.currentPeriodEnd)
                        : subscription.subscription.trialEndsAt
                          ? formatDateFR(subscription.subscription.trialEndsAt)
                          : '—'}
                    </strong>
                    {subscription.daysRemaining !== 0 && (
                      <div style={{ color: 'var(--text-muted)' }}>
                        {subscription.daysRemaining > 0
                          ? `${subscription.daysRemaining} jour(s) restant(s)`
                          : `dépassée de ${Math.abs(subscription.daysRemaining)} jour(s)`}
                      </div>
                    )}
                  </div>
                </div>

                {subscription.pendingPlanCode && (
                  <p
                    style={{
                      margin: 0,
                      fontSize: '0.82rem',
                      color: 'var(--text-muted)',
                    }}
                  >
                    Offre {subscription.pendingPlanCode} demandée : activation dès
                    confirmation du paiement par la plateforme.
                  </p>
                )}

                {employeeLimitReached && (
                  <p
                    style={{ margin: 0, fontSize: '0.82rem', color: 'var(--danger, #b91c1c)' }}
                  >
                    Limite de membres atteinte : ajoutez une offre supérieure pour
                    inviter un nouveau collaborateur.
                  </p>
                )}

                {subscription.status !== 'cancelled' && (
                  <div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === 'cancel'}
                      onClick={() => void handleCancel()}
                    >
                      {busyId === 'cancel' ? 'Résiliation…' : 'Résilier l’abonnement'}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {!loading && !loadError && catalog && subscription && (
            <Card tilt3d={false}>
              <CardContent style={{ display: 'grid', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Store size={16} />
                  <strong>Offres disponibles</strong>
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
                    gap: 10,
                  }}
                >
                  {catalog.plans.map((offer) => {
                    const isCurrent = offer.code === subscription.planCode
                    return (
                      <div
                        key={offer.code}
                        style={{
                          border: '1px solid var(--border-subtle)',
                          borderRadius: 12,
                          padding: 12,
                          display: 'grid',
                          gap: 8,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <strong>{offer.name}</strong>
                          {isCurrent && (
                            <Badge size="sm" variant="success">
                              Offre actuelle
                            </Badge>
                          )}
                        </div>
                        <div style={{ fontSize: '0.86rem' }}>
                          {offer.priceFcfa === null
                            ? 'Sur devis'
                            : offer.priceFcfa === 0
                              ? 'Gratuit'
                              : `${formatFCFA(offer.priceFcfa)} / mois`}
                        </div>
                        <ul
                          style={{
                            margin: 0,
                            paddingLeft: 16,
                            fontSize: '0.78rem',
                            color: 'var(--text-muted)',
                          }}
                        >
                          <li>{limitLabel(offer.maxSalons)} salon(s)</li>
                          <li>{limitLabel(offer.maxEmployees)} membre(s)</li>
                          <li>{limitLabel(offer.maxDevices)} appareil(s)</li>
                        </ul>
                        <Button
                          size="sm"
                          variant={isCurrent ? 'outline' : 'default'}
                          disabled={isCurrent || busyId === `plan:${offer.code}`}
                          onClick={() => void handleSubscribe(offer.code)}
                        >
                          {isCurrent
                            ? 'Offre en cours'
                            : busyId === `plan:${offer.code}`
                              ? 'Demande…'
                              : offer.requiresPayment
                                ? 'Demander cette offre'
                                : 'Revenir au gratuit'}
                        </Button>
                      </div>
                    )
                  })}
                </div>
                <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  Les offres payantes ne s’activent qu’après confirmation du
                  paiement par la plateforme : aucune carte bancaire n’est
                  demandée dans l’application.
                </p>
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
                    <Users size={16} />
                    <strong>Collaborateurs ({members.length})</strong>
                  </div>
                  <Button size="sm" onClick={() => setAddOpen(true)}>
                    <UserPlus size={15} /> Ajouter un collaborateur
                  </Button>
                </div>

                {members.length === 0 ? (
                  <EmptyState
                    icon={<UserPlus size={18} />}
                    title="Aucun collaborateur"
                    description="Ajoutez un Caissier pour encaisser, ou un second Gérant pour administrer le salon."
                  />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Nom</TableHead>
                        <TableHead>E-mail</TableHead>
                        <TableHead>Rôle</TableHead>
                        <TableHead>Statut</TableHead>
                        <TableHead>Dernière connexion</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {members.map((member) => (
                        <TableRow key={member.id}>
                          <TableCell>{member.fullName}</TableCell>
                          <TableCell>{member.email}</TableCell>
                          <TableCell>
                            <Select
                              value={member.role}
                              onValueChange={(value) =>
                                void handleMemberPatch(member, {
                                  role: value as 'manager' | 'cashier',
                                })
                              }
                            >
                              <SelectTrigger aria-label={`Rôle de ${member.fullName}`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="manager">Gérant</SelectItem>
                                <SelectItem value="cashier">Caissier</SelectItem>
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell>
                            <Badge
                              size="sm"
                              variant={member.isActive ? 'success' : 'outline'}
                            >
                              {member.isActive ? 'Actif' : 'Désactivé'}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {member.lastLoginAt
                              ? formatDateFR(member.lastLoginAt)
                              : '—'}
                          </TableCell>
                          <TableCell>
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={busyId === member.id}
                              onClick={() =>
                                void handleMemberPatch(member, {
                                  isActive: !member.isActive,
                                })
                              }
                            >
                              {member.isActive ? 'Désactiver' : 'Réactiver'}
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

          {auth.tenants.length > 1 && (
            <Card tilt3d={false}>
              <CardContent style={{ display: 'grid', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Store size={16} />
                  <strong>Mes salons ({auth.tenants.length})</strong>
                </div>
                {auth.tenants.map((tenant) => (
                  <div
                    key={tenant.tenantId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      padding: '6px 0',
                      borderBottom: '1px solid var(--border-subtle)',
                      fontSize: '0.86rem',
                    }}
                  >
                    <span>
                      {tenant.name}{' '}
                      <Badge size="sm" variant="outline">
                        {roleLabel(tenant.role)}
                      </Badge>
                    </span>
                    {tenant.tenantId === auth.activeTenantId ? (
                      <Badge size="sm" variant="success">
                        <CheckCircle2 size={12} /> Salon actif
                      </Badge>
                    ) : (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busyId === `tenant:${tenant.tenantId}`}
                        onClick={() => {
                          setBusyId(`tenant:${tenant.tenantId}`)
                          void auth
                            .switchTenant(tenant.tenantId)
                            .catch((err: unknown) =>
                              toast.error(
                                err instanceof Error
                                  ? err.message
                                  : 'Changement de salon impossible.',
                              ),
                            )
                            .finally(() => setBusyId(null))
                        }}
                      >
                        Basculer
                      </Button>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}

      <Modal
        open={addOpen}
        title="Ajouter un collaborateur"
        subtitle="Le mot de passe est haché côté serveur ; le rôle peut être modifié ensuite."
        onClose={() => setAddOpen(false)}
      >
        <form onSubmit={handleAddMember} style={{ display: 'grid', gap: 12 }}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="team-name">Nom complet</FieldLabel>
              <Input
                id="team-name"
                required
                minLength={2}
                value={form.fullName}
                onChange={(e) =>
                  setForm((current) => ({ ...current, fullName: e.target.value }))
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="team-email">E-mail</FieldLabel>
              <Input
                id="team-email"
                type="email"
                required
                value={form.email}
                onChange={(e) =>
                  setForm((current) => ({ ...current, email: e.target.value }))
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="team-phone">Téléphone (facultatif)</FieldLabel>
              <Input
                id="team-phone"
                value={form.phone}
                onChange={(e) =>
                  setForm((current) => ({ ...current, phone: e.target.value }))
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="team-password">
                Mot de passe initial (8 caractères, lettre + chiffre)
              </FieldLabel>
              <Input
                id="team-password"
                type="password"
                required
                minLength={8}
                value={form.password}
                onChange={(e) =>
                  setForm((current) => ({ ...current, password: e.target.value }))
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="team-role">Rôle</FieldLabel>
              <Select
                value={form.role}
                onValueChange={(value) =>
                  setForm((current) => ({
                    ...current,
                    role: value as 'manager' | 'cashier',
                  }))
                }
              >
                <SelectTrigger id="team-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cashier">Caissier</SelectItem>
                  <SelectItem value="manager">Gérant</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button
              type="button"
              variant="outline"
              onClick={() => setAddOpen(false)}
            >
              Annuler
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Ajout…' : 'Ajouter'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
