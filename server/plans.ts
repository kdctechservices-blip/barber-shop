/**
 * Catalogue des offres (IMPLEMENTATIONS.md — phase « Monétisable »).
 *
 * Les prix sont en francs CFA, par mois, hors taxes. `null` signifie
 * « illimité » (et non « zéro ») : c'est la convention utilisée par les
 * limites et par l'API.
 *
 * Le prix de l'offre Starter n'est pas fixé dans IMPLEMENTATIONS.md : 4 900 FCFA
 * est une hypothèse commerciale explicitement signalée dans l'audit (§11.13),
 * à confirmer avant publication.
 */

export type PlanCode =
  | 'decouverte'
  | 'starter'
  | 'professional'
  | 'business'
  | 'enterprise'

export interface PlanDefinition {
  code: PlanCode
  name: string
  /** Prix mensuel en FCFA (0 = gratuit, null = sur devis). */
  priceFcfa: number | null
  maxSalons: number | null
  maxEmployees: number | null
  maxDevices: number | null
  features: string[]
  /** Offre payante nécessitant l'activation d'un paiement. */
  requiresPayment: boolean
}

export const PLAN_CATALOG: Record<PlanCode, PlanDefinition> = {
  decouverte: {
    code: 'decouverte',
    name: 'Découverte',
    priceFcfa: 0,
    maxSalons: 1,
    maxEmployees: 3,
    maxDevices: 1,
    features: ['caisse', 'recettes_depenses', 'rapports_simples'],
    requiresPayment: false,
  },
  starter: {
    code: 'starter',
    name: 'Starter',
    priceFcfa: 4_900,
    maxSalons: 1,
    maxEmployees: 8,
    maxDevices: 3,
    features: ['caisse', 'recettes_depenses', 'rapports_simples', 'stock'],
    requiresPayment: true,
  },
  professional: {
    code: 'professional',
    name: 'Professional',
    priceFcfa: 9_900,
    maxSalons: 2,
    maxEmployees: 25,
    maxDevices: 10,
    features: [
      'caisse',
      'recettes_depenses',
      'rapports_avances',
      'stock',
      'salaires_commissions',
      'synchronisation_multi_appareils',
    ],
    requiresPayment: true,
  },
  business: {
    code: 'business',
    name: 'Business',
    priceFcfa: 19_900,
    maxSalons: 5,
    maxEmployees: null,
    maxDevices: null,
    features: [
      'caisse',
      'recettes_depenses',
      'rapports_avances',
      'stock',
      'salaires_commissions',
      'synchronisation_multi_appareils',
      'multi_salons',
      'support_prioritaire',
    ],
    requiresPayment: true,
  },
  enterprise: {
    code: 'enterprise',
    name: 'Enterprise',
    priceFcfa: null,
    maxSalons: null,
    maxEmployees: null,
    maxDevices: null,
    features: [
      'caisse',
      'recettes_depenses',
      'rapports_avances',
      'stock',
      'salaires_commissions',
      'synchronisation_multi_appareils',
      'multi_salons',
      'support_prioritaire',
      'accompagnement_dedie',
    ],
    requiresPayment: true,
  },
}

export const PLAN_ORDER: PlanCode[] = [
  'decouverte',
  'starter',
  'professional',
  'business',
  'enterprise',
]

/** Offre appliquée par défaut (freemium). */
export const DEFAULT_PLAN_CODE: PlanCode = 'decouverte'

/** Durée de l'essai offert à la création d'un salon. */
export const TRIAL_DAYS = 14
/**
 * Offre offerte pendant l'essai : l'organisation démarre avec les capacités de
 * l'offre Professional (essai « tout compris »), puis retombe sur Découverte si
 * aucun paiement n'est confirmé à l'échéance.
 */
export const TRIAL_PLAN_CODE: PlanCode = 'professional'
/** Grâce après échéance avant retour automatique à l'offre Découverte. */
export const PAST_DUE_GRACE_DAYS = 7
/** Durée facturée d'une activation. */
export const BILLING_PERIOD_DAYS = 30

export function isPlanCode(value: unknown): value is PlanCode {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(PLAN_CATALOG, value)
  )
}

export function planLimit(
  plan: PlanDefinition,
  resource: 'salons' | 'employees' | 'devices',
): number | null {
  if (resource === 'salons') return plan.maxSalons
  if (resource === 'employees') return plan.maxEmployees
  return plan.maxDevices
}

export function planCatalogPublic(): PlanDefinition[] {
  return PLAN_ORDER.map((code) => PLAN_CATALOG[code])
}
