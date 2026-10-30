/**
 * SALON PRO — Service de notifications WhatsApp / SMS (Section 11.16 Sprint 3 — sous-tâche 4).
 *
 * Ce module définit :
 * - Les types de notifications métiers (confirmation RDV, rappel, reçu, etc.)
 * - Les modèles de messages en français, paramétrables par le salon
 * - L'interface du fournisseur d'envoi (SMS/WhatsApp), sans aucun secret codé en dur.
 * Les secrets fournisseur (clé API Twilio, Wave, etc.) restent strictement côté serveur
 * (DATABASE_URL / variables d'environnement serveur) et ne sont jamais exposés au navigateur.
 */

export type NotificationChannel = 'sms' | 'whatsapp'

export type NotificationType =
  | 'appointment_confirmation'
  | 'appointment_reminder'
  | 'appointment_cancellation'
  | 'payment_receipt'
  | 'loyalty_reward'
  | 'promo'

export interface NotificationTemplate {
  type: NotificationType
  channel: NotificationChannel
  subject?: string
  body: string
  /** Variables substituables dans le corps, ex: {{clientName}}, {{salonName}}. */
  variables: string[]
}

export interface NotificationSendRequest {
  type: NotificationType
  channel: NotificationChannel
  to: string // numéro de téléphone au format international (ex: +225 07 XX XX XX XX)
  salonName: string
  clientName?: string
  variables?: Record<string, string>
}

export interface NotificationSendResult {
  ok: boolean
  messageId?: string
  error?: string
}

/**
 * Interface du fournisseur d'envoi. À implémenter côté serveur avec le prestataire
 * choisi (Twilio, Wave SMS, Orange SMS API, etc.). Aucun secret n'est codé en dur ici.
 */
export interface NotificationProvider {
  send(request: NotificationSendRequest): Promise<NotificationSendResult>
}

export const DEFAULT_NOTIFICATION_TEMPLATES: NotificationTemplate[] = [
  {
    type: 'appointment_confirmation',
    channel: 'sms',
    subject: 'Confirmation de rendez-vous',
    body:
      'Bonjour {{clientName}}, votre rendez-vous est confirmé chez {{salonName}} le {{appointmentDate}} à {{appointmentTime}}. Merci de votre confiance !',
    variables: ['clientName', 'salonName', 'appointmentDate', 'appointmentTime'],
  },
  {
    type: 'appointment_confirmation',
    channel: 'whatsapp',
    subject: 'Confirmation de rendez-vous',
    body:
      '*Bonjour {{clientName}} !* ✂️\nVotre rendez-vous est confirmé chez *{{salonName}}* le {{appointmentDate}} à {{appointmentTime}}.\nÀ bientôt !',
    variables: ['clientName', 'salonName', 'appointmentDate', 'appointmentTime'],
  },
  {
    type: 'appointment_reminder',
    channel: 'sms',
    subject: 'Rappel de rendez-vous',
    body:
      'Rappel : rendez-vous demain chez {{salonName}} le {{appointmentDate}} à {{appointmentTime}}. Pour annuler, répondez STOP.',
    variables: ['clientName', 'salonName', 'appointmentDate', 'appointmentTime'],
  },
  {
    type: 'appointment_reminder',
    channel: 'whatsapp',
    subject: 'Rappel de rendez-vous',
    body:
      '👋 Bonjour {{clientName}} !\nRappel : votre rendez-vous chez *{{salonName}}* est prévu le {{appointmentDate}} à {{appointmentTime}}.\nÀ bientôt !',
    variables: ['clientName', 'salonName', 'appointmentDate', 'appointmentTime'],
  },
  {
    type: 'appointment_cancellation',
    channel: 'sms',
    subject: 'Annulation de rendez-vous',
    body:
      'Votre rendez-vous chez {{salonName}} le {{appointmentDate}} a été annulé. Pour reprendre rendez-vous, contactez-nous.',
    variables: ['clientName', 'salonName', 'appointmentDate'],
  },
  {
    type: 'appointment_cancellation',
    channel: 'whatsapp',
    subject: 'Annulation de rendez-vous',
    body:
      'Bonjour {{clientName}},\nVotre rendez-vous chez *{{salonName}}* prévu le {{appointmentDate}} a été annulé.\nNous restons à votre disposition pour un nouveau créneau.',
    variables: ['clientName', 'salonName', 'appointmentDate'],
  },
  {
    type: 'payment_receipt',
    channel: 'sms',
    subject: 'Reçu de paiement',
    body:
      'Merci pour votre paiement de {{amount}} FCFA chez {{salonName}} le {{paymentDate}}. Reçu n°{{receiptNumber}}. Bonne journée !',
    variables: ['clientName', 'salonName', 'amount', 'paymentDate', 'receiptNumber'],
  },
  {
    type: 'payment_receipt',
    channel: 'whatsapp',
    subject: 'Reçu de paiement',
    body:
      'Merci *{{clientName}}* ! 💳\nPaiement de {{amount}} FCFA reçu chez *{{salonName}}* le {{paymentDate}}.\nReçu n°{{receiptNumber}}. À bientôt !',
    variables: ['clientName', 'salonName', 'amount', 'paymentDate', 'receiptNumber'],
  },
  {
    type: 'loyalty_reward',
    channel: 'sms',
    subject: 'Récompense fidélité',
    body:
      'Félicitations {{clientName}} ! Vous avez atteint {{loyaltyPoints}} points de fidélité chez {{salonName}}. Profitez d’une réduction lors de votre prochaine visite.',
    variables: ['clientName', 'salonName', 'loyaltyPoints'],
  },
  {
    type: 'loyalty_reward',
    channel: 'whatsapp',
    subject: 'Récompense fidélité',
    body:
      '🎉 Félicitations *{{clientName}} !*\nVous avez atteint {{loyaltyPoints}} points de fidélité chez *{{salonName}}*.\nProfitez d’une réduction lors de votre prochaine visite !',
    variables: ['clientName', 'salonName', 'loyaltyPoints'],
  },
  {
    type: 'promo',
    channel: 'sms',
    subject: 'Offre spéciale',
    body:
      'Offre spéciale chez {{salonName}} : {{promoLabel}}. Valable jusqu’au {{validUntil}}. Présentez ce message en caisse.',
    variables: ['clientName', 'salonName', 'promoLabel', 'validUntil'],
  },
  {
    type: 'promo',
    channel: 'whatsapp',
    subject: 'Offre spéciale',
    body:
      '📢 *Offre spéciale chez {{salonName}} :* {{promoLabel}}\nValable jusqu’au {{validUntil}}.\nPrésentez ce message en caisse !',
    variables: ['clientName', 'salonName', 'promoLabel', 'validUntil'],
  },
]

function findTemplate(
  templates: NotificationTemplate[],
  type: NotificationType,
  channel: NotificationChannel,
): NotificationTemplate | undefined {
  return templates.find((t) => t.type === type && t.channel === channel)
}

function substituteVariables(body: string, variables: Record<string, string>): string {
  let result = body
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), value)
  }
  return result
}

/**
 * Construit le corps du message à partir d'un modèle et des variables fournies.
 * Utilisé côté serveur (et éventuellement côté client pour prévisualisation).
 */
export function renderNotification(
  templates: NotificationTemplate[],
  request: NotificationSendRequest,
): { subject?: string; body: string } {
  const template = findTemplate(templates, request.type, request.channel)
  if (!template) {
    return {
      body: `Notification ${request.type} (${request.channel}) pour ${request.clientName ?? request.to}`,
    }
  }
  return {
    subject: template.subject,
    body: substituteVariables(template.body, request.variables ?? {}),
  }
}

export class NotificationService {
  private readonly provider: NotificationProvider
  private readonly templates: NotificationTemplate[]
  private readonly salonName: string

  constructor(params: {
    provider: NotificationProvider
    templates?: NotificationTemplate[]
    salonName: string
  }) {
    this.provider = params.provider
    this.templates = params.templates ?? DEFAULT_NOTIFICATION_TEMPLATES
    this.salonName = params.salonName
  }

  async send(request: Omit<NotificationSendRequest, 'salonName'>): Promise<NotificationSendResult> {
    const fullRequest: NotificationSendRequest = {
      ...request,
      salonName: this.salonName,
    }
    return this.provider.send(fullRequest)
  }

  getTemplates(): NotificationTemplate[] {
    return this.templates
  }
}
