import {
  Wallet,
  CreditCard,
  Phone,
  Loader2,
} from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { useToast } from '@/hooks/toastContext'
import { formatFCFA } from '@/utils/format'
import {
  initiatePayment,
  fetchPaymentTransactions,
  fetchPlanCatalog,
  fetchSubscription,
  type PlanDefinition,
  type PaymentTransaction,
  type PaymentInitResult,
} from '@/lib/billingClient'

const PAYMENT_PROVIDERS: Array<{
  code: string
  label: string
  icon: React.ElementType
  color: string
}> = [
  {
    code: 'wave',
    label: 'Wave',
    icon: Phone,
    color: '#00A651',
  },
  {
    code: 'cinetpay',
    label: 'CinetPay',
    icon: CreditCard,
    color: '#1D4ED8',
  },
  {
    code: 'paydunya',
    label: 'PayDunya',
    icon: Wallet,
    color: '#7E2F8E',
  },
]

function statusVariant(status: string): 'default' | 'success' | 'warning' | 'destructive' {
  switch (status) {
    case 'paid': return 'success'
    case 'pending': return 'warning'
    case 'failed': return 'destructive'
    case 'cancelled': return 'default'
    case 'expired': return 'destructive'
    default: return 'default'
  }
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: 'En attente',
    paid: 'Payé',
    failed: 'Échec',
    cancelled: 'Annulé',
    expired: 'Expiré',
  }
  return labels[status] ?? status
}

function providerLabel(code: string): string {
  const labels: Record<string, string> = {
    wave: 'Wave',
    cinetpay: 'CinetPay',
    paydunya: 'PayDunya',
  }
  return labels[code] ?? code
}

function providerColorClass(color: string): string {
  if (color === '#00A651') return 'emerald'
  if (color === '#1D4ED8') return 'blue'
  if (color === '#7E2F8E') return 'purple'
  return 'primary'
}

export function PaymentPage() {
  const toast = useToast()
  const [loading, setLoading] = useState(false)
  const [initLoading, setInitLoading] = useState<string | null>(null)

  const [plans, setPlans] = useState<PlanDefinition[]>([])
  const [subscription, setSubscription] = useState<SubscriptionSnapshot | null>(null)
  const [transactions, setTransactions] = useState<PaymentTransaction[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [catalogResult, subscriptionResult, transactionsResult] =
        await Promise.all([
          fetchPlanCatalog(),
          fetchSubscription(),
          fetchPaymentTransactions(),
        ])
      setPlans(catalogResult.plans)
      setSubscription(subscriptionResult)
      setTransactions(transactionsResult)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur de chargement.')
    } finally {
      setLoading(false)
    }
  }, [toast])

  const paidPlans = useMemo(
    () => plans.filter((p) => p.requiresPayment && p.priceFcfa !== null),
    [plans],
  )
  const firstPaidPlan = paidPlans[0]

  const handleInitiate = useCallback(async (providerCode: string) => {
    if (!firstPaidPlan) {
      toast.error('Aucune offre payante disponible pour ce salon.')
      return
    }
    setInitLoading(providerCode)
    try {
      const result: PaymentInitResult = await initiatePayment({
        provider: providerCode,
        planCode: firstPaidPlan.code,
      })
      toast.success(
        `Paiement initié avec ${providerLabel(providerCode)} (${formatFCFA(result.amountFcfa)}).`,
      )
      window.location.assign(result.paymentUrl)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Échec de l’initiation du paiement.',
      )
    } finally {
      setInitLoading(null)
    }
  }, [firstPaidPlan, toast])

  if (loading) {
    return (
      <div className="flex h-[400px] items-center justify-center">
        <Loader2 size={24} className="animate-spin text-muted-foreground" />
      </div>
    )
  }

  const effective = subscription?.subscription
  const pendingPlan = subscription?.pendingPlanCode
    ? {
        planCode: subscription.pendingPlanCode,
        status: subscription.status as string,
        requestedAt: subscription.subscription.updatedAt,
      }
    : null

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Paiement de l’abonnement</h1>
          <p className="text-muted-foreground">
            Réglez votre abonnement SALON PRO par mobile money ou carte bancaire.
          </p>
        </div>
        <Button onClick={() => load()}>
          <Loader2 size={14} className={`mr-2 ${loading ? 'animate-spin' : ''}`} />
          Rafraîchir
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Votre abonnement</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between py-4">
              <div>
                <CardTitle className="text-sm">Offre actuelle</CardTitle>
                <p className="text-xs text-muted-foreground">
                  {effective?.planCode ?? '—'}
                </p>
              </div>
              <Badge variant={subscription?.isExpired ? 'destructive' : 'default'}>
                {subscription?.status ?? '—'}
              </Badge>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between py-4">
              <div>
                <CardTitle className="text-sm">Échéance</CardTitle>
                <p className="text-xs text-muted-foreground">
                  {effective?.currentPeriodEnd
                    ? new Date(effective.currentPeriodEnd).toLocaleDateString(
                      'fr-FR',
                    )
                    : '—'}
                </p>
              </div>
              <span className="text-xl font-mono font-bold">
                {subscription && subscription.daysRemaining !== null &&
                subscription.daysRemaining >= 0
                  ? `J-${subscription.daysRemaining}`
                  : '—'}
              </span>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between py-4">
              <div>
                <CardTitle className="text-sm">Montant dû</CardTitle>
                <p className="text-xs text-muted-foreground">
                  {firstPaidPlan
                    ? formatFCFA(firstPaidPlan.priceFcfa ?? 0)
                    : 'Gratuit'}
                </p>
              </div>
              <Badge variant={subscription?.isExpired ? 'destructive' : 'default'}>
                {subscription?.isExpired ? 'Échéance dépassée' : 'À jour'}
              </Badge>
            </CardHeader>
          </Card>
        </CardContent>
      </Card>

      {pendingPlan && (
        <Card className="border-amber/50 bg-amber/5">
          <CardHeader className="flex flex-row items-center justify-between py-4">
            <CardTitle className="text-sm">Modification en attente</CardTitle>
            <Badge variant="warning">{pendingPlan.status}</Badge>
          </CardHeader>
          <CardContent>
            <p className="text-sm">
              Passage à l’offre{' '}
              <strong>{pendingPlan.planCode}</strong> demandé le{' '}
              {pendingPlan.requestedAt
                ? new Date(pendingPlan.requestedAt).toLocaleDateString('fr-FR')
                : '—'}.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Initier un paiement</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            Choisissez le prestataire de paiement. Le montant correspond à
            l’offre payante actuellement sélectionnée.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {PAYMENT_PROVIDERS.map((provider) => {
              const disabled =
                initLoading === provider.code ||
                !firstPaidPlan ||
                loading
              const colorClass = providerColorClass(provider.color)
              const base = `flex flex-col items-center justify-center gap-2 py-4 border rounded-lg transition-colors`
              const disabledCls = `${base} border-muted/50 bg-muted/50 text-muted-foreground/50`
              const enabledCls = `${base} border-${colorClass}/20 bg-${colorClass}/5 text-${colorClass}-foreground hover:bg-${colorClass}/10`
              return (
                <Button
                  key={provider.code}
                  onClick={() => void handleInitiate(provider.code)}
                  disabled={disabled}
                  className={disabled ? disabledCls : enabledCls}
                >
                  <provider.icon size={20} strokeWidth={2} />
                  <span className="text-sm font-medium">
                    {provider.label}
                  </span>
                  {initLoading === provider.code && (
                    <Loader2 size={14} className="animate-spin" />
                  )}
                  {!firstPaidPlan && (
                    <span className="text-xs text-muted-foreground">
                      Aucune offre payante
                    </span>
                  )}
                </Button>
              )
            })}
          </div>
          {paidPlans.length === 0 && (
            <p className="mt-3 text-sm text-muted-foreground">
              Votre offre actuelle ne nécessite pas de paiement (gratuite ou sur
              devis).
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Historique des transactions</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="h-11 text-left text-xs font-medium text-muted-foreground">
                    Référence
                  </th>
                  <th className="h-11 text-left text-xs font-medium text-muted-foreground">
                    Prestataire
                  </th>
                  <th className="h-11 text-left text-xs font-medium text-muted-foreground">
                    Plan
                  </th>
                  <th className="h-11 text-right text-xs font-medium text-muted-foreground">
                    Montant
                  </th>
                  <th className="h-11 text-left text-xs font-medium text-muted-foreground">
                    Statut
                  </th>
                  <th className="h-11 text-left text-xs font-medium text-muted-foreground">
                    Date
                  </th>
                </tr>
              </thead>
              <tbody>
                {transactions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center text-muted-foreground py-10">
                      Aucune transaction pour l’instant.
                    </td>
                  </tr>
                ) : (
                  transactions.map((tx) => (
                    <tr key={tx.id} className="border-b hover:bg-muted/50">
                      <td className="py-3 text-sm font-mono">
                        {tx.reference}
                      </td>
                      <td className="py-3 text-sm">{providerLabel(tx.provider)}</td>
                      <td className="py-3 text-sm">{tx.planCode ?? '—'}</td>
                      <td className="py-3 text-right text-sm font-medium">
                        {formatFCFA(tx.amountFcfa)}
                      </td>
                      <td className="py-3 text-sm">
                        <Badge variant={statusVariant(tx.status)} className="text-xs">
                          {statusLabel(tx.status)}
                        </Badge>
                      </td>
                      <td className="py-3 text-sm text-muted-foreground">
                        {new Date(tx.createdAt).toLocaleDateString('fr-FR')}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {transactions.length > 0 && (
            <CardFooter className="border-t px-6 py-3 flex justify-between items-center">
              <span className="text-sm text-muted-foreground">
                {transactions.length} transaction(s)
              </span>
            </CardFooter>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

interface SubscriptionSnapshot {
  plan: PlanDefinition
  planCode: string
  status: string
  isExpired: boolean
  daysRemaining: number
  pendingPlanCode: string | null
  usage: { members: number; salons: number }
  limits: { members: number | null; salons: number | null; devices: number | null }
  subscription: {
    orgId: string
    planCode: string
    pendingPlanCode: string | null
    status: string
    trialEndsAt: string | null
    currentPeriodStart: string | null
    currentPeriodEnd: string | null
    cancelAtPeriodEnd: boolean
    updatedAt: string
  }
}
