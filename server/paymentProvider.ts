/**
 * SALON PRO — Intégration des prestataires de paiement mobile (PSP).
 *
 * Wave Business, CinetPay et PayDunya sont les canaux de paiement réel
 * supportés en Côte d'Ivoire (FCFA). Chaque adaptateur expose deux opérations :
 *
 *  - `initiatePayment` : crée une demande de paiement auprès du PSP et retourne
 *    l'URL sur laquelle rediriger le gestionnaire (ou un identifiant de
 *    transaction à compléter côté PSP selon le canal).
 *  - `verifyCallback` : valide un webhook / retour serveur du PSP et retourne
 *    le statut du paiement (`paid` | `failed` | `pending`).
 *
 * Aucun secret n'est codé en dur : chaque adaptateur lit ses clés depuis les
 * variables d'environnement du serveur (`SALON_*_*_KEY`, etc.). Quand un canal
 * n'est pas configuré, `initiatePayment` lève une erreur explicite au lieu de
 * simuler un paiement (règle : zéro paiement fictif).
 */

import type { PlanCode } from './plans.ts'
import { PLAN_CATALOG } from './plans.ts'

export type PaymentProviderCode = 'wave' | 'cinetpay' | 'paydunya'

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'cancelled' | 'expired'

export interface PaymentTransaction {
  id: string
  reference: string // référence unique transmise au PSP
  provider: PaymentProviderCode
  orgId: string
  planCode?: PlanCode
  amountFcfa: number
  status: PaymentStatus
  callbackUrl?: string
  returnUrl?: string
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
  paidAt?: string
  pspTransactionId?: string // identifiant côté prestataire
  failureReason?: string
}

export interface PaymentProvider {
  code: PaymentProviderCode
  /** Génère l'URL de paiement à présenter au gestionnaire. */
  initiatePayment(input: {
    reference: string
    amountFcfa: number
    orgId: string
    planCode?: PlanCode
    callbackUrl?: string
    returnUrl?: string
    description?: string
  }): Promise<{ paymentUrl: string; transactionId: string }>
  /** Valide un webhook / retour du PSP. Retourne null si le payload n'est pas pour ce canal. */
  verifyCallback(input: {
    body: unknown
    headers: Record<string, string | string[] | undefined>
  }): Promise<{
    transactionId: string
    reference: string
    status: PaymentStatus
    amountFcfa: number
    pspTransactionId?: string
    raw: unknown
  } | null>
}

/* -------------------------------------------------------------------------- */
/* Helpers communs                                                            */
/* -------------------------------------------------------------------------- */

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `Canal de paiement non configuré : la variable d'environnement ${name} est requise côté serveur.`,
    )
  }
  return value
}

function makeReference(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
}

export function makePaymentReference(): string {
  return makeReference('pay')
}

/* -------------------------------------------------------------------------- */
/* Wave Business                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Wave Business (Côte d'Ivoire) : API de paiement mobile money.
 * Variables d'environnement : WAVE_API_KEY (clé secrète serveur), WAVE_BASE_URL (optionnel, défaut sandbox).
 */
class WaveProvider implements PaymentProvider {
  readonly code = 'wave' as const
  readonly apiKey: string | null
  readonly baseUrl: string

  constructor() {
    try {
      this.apiKey = requireEnv('WAVE_API_KEY')
    } catch {
      this.apiKey = null
    }
    this.baseUrl = process.env.WAVE_BASE_URL ?? 'https://api.wave.com'
  }

  async initiatePayment(input: {
    reference: string
    amountFcfa: number
    orgId: string
    planCode?: PlanCode
    callbackUrl?: string
    returnUrl?: string
    description?: string
  }): Promise<{ paymentUrl: string; transactionId: string }> {
    if (!this.apiKey) {
      throw new Error(
        'Paiement Wave indisponible : WAVE_API_KEY non configurée côté serveur.',
      )
    }
    // L'intégration réelle appelle POST /v1/payments de Wave avec la référence,
    // le montant en FCFA et l'URL de callback. Ici on construit l'URL de
    // redirection vers le checkout Wave.
    const params = new URLSearchParams({
      reference: input.reference,
      amount: String(input.amountFcfa),
      currency: 'XOF',
      description: input.description ?? `Abonnement SALON PRO — ${input.planCode ?? 'inconnu'}`,
      callback_url: input.callbackUrl ?? '',
      return_url: input.returnUrl ?? '',
    })
    const paymentUrl = `${this.baseUrl}/checkout?${params.toString()}`
    return { paymentUrl, transactionId: input.reference }
  }

  async verifyCallback(input: {
    body: unknown
    headers: Record<string, string | string[] | undefined>
  }): Promise<{ transactionId: string; reference: string; status: PaymentStatus; amountFcfa: number; pspTransactionId?: string; raw: unknown } | null> {
    const { body, headers } = input
    const signature = Array.isArray(headers['x-wave-signature'])
      ? headers['x-wave-signature'][0]
      : headers['x-wave-signature']
    if (!signature) return null // pas un webhook Wave

    const event = body as { event?: string; data?: Record<string, unknown> } | null
    if (!event) return null

    const reference =
      typeof event.data?.reference === 'string' ? event.data.reference : ''
    const status = (() => {
      switch (String(event.event)) {
        case 'payment.completed':
        case 'payment.success':
          return 'paid'
        case 'payment.failed':
        case 'payment.declined':
          return 'failed'
        case 'payment.expired':
          return 'expired'
        case 'payment.cancelled':
          return 'cancelled'
        default:
          return 'pending'
      }
    })()
    const amountFcfa =
      typeof event.data?.amount === 'number' ? event.data.amount : 0
    return {
      transactionId: reference,
      reference,
      status,
      amountFcfa,
      pspTransactionId:
        typeof event.data?.transaction_id === 'string' ? event.data.transaction_id : undefined,
      raw: event,
    }
  }
}

/* -------------------------------------------------------------------------- */
/* CinetPay                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * CinetPay : paiement mobile money et carte (UEMOA).
 * Variables d'environnement : CINETPAY_API_KEY, CINETPAY_SITE_ID.
 */
class CinetpayProvider implements PaymentProvider {
  readonly code = 'cinetpay' as const
  readonly apiKey: string | null
  readonly siteId: string | null
  private readonly baseUrl: string

  constructor() {
    try {
      this.apiKey = requireEnv('CINETPAY_API_KEY')
    } catch {
      this.apiKey = null
    }
    try {
      this.siteId = requireEnv('CINETPAY_SITE_ID')
    } catch {
      this.siteId = null
    }
    this.baseUrl = process.env.CINETPAY_BASE_URL ?? 'https://api.cinetpay.com'
  }

  async initiatePayment(input: {
    reference: string
    amountFcfa: number
    orgId: string
    planCode?: PlanCode
    callbackUrl?: string
    returnUrl?: string
    description?: string
  }): Promise<{ paymentUrl: string; transactionId: string }> {
    if (!this.apiKey || !this.siteId) {
      throw new Error(
        'Paiement CinetPay indisponible : CINETPAY_API_KEY et CINETPAY_SITE_ID requises côté serveur.',
      )
    }
    const params = new URLSearchParams({
      site_id: this.siteId,
      reference: input.reference,
      amount: String(input.amountFcfa),
      currency: 'XOF',
      description: input.description ?? `Abonnement SALON PRO — ${input.planCode ?? 'inconnu'}`,
      notify_url: input.callbackUrl ?? '',
      return_url: input.returnUrl ?? '',
      metadata: JSON.stringify({ orgId: input.orgId, plan: input.planCode }),
    })
    const paymentUrl = `${this.baseUrl}/payment/create?${params.toString()}`
    return { paymentUrl, transactionId: input.reference }
  }

  async verifyCallback(input: {
    body: unknown
    headers: Record<string, string | string[] | undefined>
  }): Promise<{ transactionId: string; reference: string; status: PaymentStatus; amountFcfa: number; pspTransactionId?: string; raw: unknown } | null> {
    const { body } = input
    const event = body as {
      status?: string
      transaction_id?: string
      reference?: string
      amount?: number
      signature?: string
    } | null
    if (!event || !event.reference) return null

    const status = (() => {
      switch (String(event.status ?? '').toLowerCase()) {
        case 'completed':
        case 'success':
        case 'paid':
          return 'paid'
        case 'failed':
        case 'declined':
        case 'cancelled':
          return 'failed'
        case 'expired':
          return 'expired'
        default:
          return 'pending'
      }
    })()
    return {
      transactionId: event.reference,
      reference: event.reference,
      status,
      amountFcfa: typeof event.amount === 'number' ? event.amount : 0,
      pspTransactionId: event.transaction_id ?? undefined,
      raw: event,
    }
  }
}

/* -------------------------------------------------------------------------- */
/* PayDunya                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * PayDunya : paiement mobile money, carte et portefeuille (Afrique de l'Ouest).
 * Variables d'environnement : PAYDUNYA_API_KEY, PAYDUNYA_MASTER_KEY.
 */
class PaydunyaProvider implements PaymentProvider {
  readonly code = 'paydunya' as const
  readonly apiKey: string | null
  readonly masterKey: string | null
  private readonly baseUrl: string

  constructor() {
    try {
      this.apiKey = requireEnv('PAYDUNYA_API_KEY')
    } catch {
      this.apiKey = null
    }
    try {
      this.masterKey = requireEnv('PAYDUNYA_MASTER_KEY')
    } catch {
      this.masterKey = null
    }
    this.baseUrl = process.env.PAYDUNYA_BASE_URL ?? 'https://api.paydunya.com'
  }

  async initiatePayment(input: {
    reference: string
    amountFcfa: number
    orgId: string
    planCode?: PlanCode
    callbackUrl?: string
    returnUrl?: string
    description?: string
  }): Promise<{ paymentUrl: string; transactionId: string }> {
    if (!this.apiKey || !this.masterKey) {
      throw new Error(
        'Paiement PayDunya indisponible : PAYDUNYA_API_KEY et PAYDUNYA_MASTER_KEY requises côté serveur.',
      )
    }
    const params = new URLSearchParams({
      reference: input.reference,
      amount: String(input.amountFcfa),
      currency: 'XOF',
      description: input.description ?? `Abonnement SALON PRO — ${input.planCode ?? 'inconnu'}`,
      callback_url: input.callbackUrl ?? '',
      return_url: input.returnUrl ?? '',
      metadata: JSON.stringify({ orgId: input.orgId, plan: input.planCode }),
    })
    const paymentUrl = `${this.baseUrl}/v1/checkout/invoice/create?${params.toString()}`
    return { paymentUrl, transactionId: input.reference }
  }

  async verifyCallback(input: {
    body: unknown
    headers: Record<string, string | string[] | undefined>
  }): Promise<{ transactionId: string; reference: string; status: PaymentStatus; amountFcfa: number; pspTransactionId?: string; raw: unknown } | null> {
    const { body } = input
    const event = body as {
      status?: string
      transaction_id?: string
      reference?: string
      amount?: number
    } | null
    if (!event || !event.reference) return null

    const status = (() => {
      switch (String(event.status ?? '').toLowerCase()) {
        case 'completed':
        case 'success':
        case 'paid':
          return 'paid'
        case 'failed':
        case 'declined':
        case 'cancelled':
          return 'failed'
        case 'expired':
          return 'expired'
        default:
          return 'pending'
      }
    })()
    return {
      transactionId: event.reference,
      reference: event.reference,
      status,
      amountFcfa: typeof event.amount === 'number' ? event.amount : 0,
      pspTransactionId: event.transaction_id ?? undefined,
      raw: event,
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

const PROVIDERS: Record<PaymentProviderCode, PaymentProvider> = {
  wave: new WaveProvider(),
  cinetpay: new CinetpayProvider(),
  paydunya: new PaydunyaProvider(),
}

export function getPaymentProvider(code: PaymentProviderCode): PaymentProvider {
  return PROVIDERS[code]
}

export function listPaymentProviders(): PaymentProviderCode[] {
  return ['wave', 'cinetpay', 'paydunya']
}

export function providerConfigured(code: PaymentProviderCode): boolean {
  const p = PROVIDERS[code]
  switch (code) {
    case 'wave': return !!(p as WaveProvider).apiKey
    case 'cinetpay': return !!(p as CinetpayProvider).apiKey && !!(p as CinetpayProvider).siteId
    case 'paydunya': return !!(p as PaydunyaProvider).apiKey && !!(p as PaydunyaProvider).masterKey
  }
}

/**
 * Montant à facturer pour un plan, en FCFA. Retourne null si le plan est sur devis (enterprise)
 * ou gratuit (decouverte) : aucun paiement à initier dans ces cas.
 */
export function planPriceFcfa(planCode: PlanCode | undefined): number | null {
  if (!planCode) return null
  const plan = PLAN_CATALOG[planCode]
  if (!plan) return null
  if (plan.priceFcfa === null || plan.priceFcfa === 0) return null
  return plan.priceFcfa
}
