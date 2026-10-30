/**
 * SALON PRO — Limitation de débit en mémoire (protection anti-bruteforce).
 *
 * Chaque instance serverless possède son propre compteur : la limitation est
 * donc « au mieux » en environnement distribué, mais elle bloque efficacement
 * les attaques à faible volume et les scripts de bourrage d'identifiants.
 * Un stockage partagé (PostgreSQL/Redis) est prévu en Phase 1 (P0-5+).
 */

export interface RateLimitRule {
  /** Nombre maximal de tentatives autorisées dans la fenêtre. */
  max: number
  /** Durée de la fenêtre glissante, en millisecondes. */
  windowMs: number
  /** Durée du blocage une fois la limite franchie, en millisecondes. */
  blockMs?: number
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

interface Bucket {
  hits: number[]
  blockedUntil: number
}

const buckets = new Map<string, Bucket>()
const MAX_BUCKETS = 5_000

function pruneBuckets(now: number, windowMs: number): void {
  if (buckets.size <= MAX_BUCKETS) return
  for (const [key, bucket] of buckets) {
    const lastHit = bucket.hits[bucket.hits.length - 1] ?? 0
    if (bucket.blockedUntil < now && now - lastHit > windowMs) {
      buckets.delete(key)
    }
  }
}

/**
 * Enregistre une tentative et indique si elle est autorisée.
 * À appeler AVANT l'opération protégée (connexion, inscription…).
 */
export function consumeRateLimit(
  key: string,
  rule: RateLimitRule,
  now = Date.now(),
): RateLimitResult {
  pruneBuckets(now, rule.windowMs)

  const blockedUntil = rule.blockMs ?? rule.windowMs
  const bucket = buckets.get(key) ?? { hits: [], blockedUntil: 0 }

  if (bucket.blockedUntil > now) {
    buckets.set(key, bucket)
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.ceil((bucket.blockedUntil - now) / 1000),
    }
  }

  const windowStart = now - rule.windowMs
  bucket.hits = bucket.hits.filter((ts) => ts > windowStart)

  if (bucket.hits.length >= rule.max) {
    bucket.blockedUntil = now + blockedUntil
    buckets.set(key, bucket)
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.ceil(blockedUntil / 1000),
    }
  }

  bucket.hits.push(now)
  buckets.set(key, bucket)
  return {
    allowed: true,
    remaining: Math.max(0, rule.max - bucket.hits.length),
    retryAfterSeconds: 0,
  }
}

/**
 * Vérifie l'état d'un compteur SANS consommer de tentative.
 * Utilisé pour les connexions : seuls les échecs doivent peser dans la balance,
 * afin qu'un salon derrière une même adresse IP (NAT) ne soit jamais bloqué
 * par des connexions réussies.
 */
export function checkRateLimit(
  key: string,
  rule: RateLimitRule,
  now = Date.now(),
): RateLimitResult {
  const bucket = buckets.get(key)
  if (!bucket) {
    return { allowed: true, remaining: rule.max, retryAfterSeconds: 0 }
  }
  if (bucket.blockedUntil > now) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.ceil((bucket.blockedUntil - now) / 1000),
    }
  }
  const windowStart = now - rule.windowMs
  const hits = bucket.hits.filter((ts) => ts > windowStart)
  if (hits.length >= rule.max) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.ceil((rule.blockMs ?? rule.windowMs) / 1000),
    }
  }
  return {
    allowed: true,
    remaining: Math.max(0, rule.max - hits.length),
    retryAfterSeconds: 0,
  }
}

/**
 * Enregistre un ÉCHEC (mot de passe incorrect) et bloque le compteur
 * dès que la limite est atteinte.
 */
export function recordRateLimitFailure(
  key: string,
  rule: RateLimitRule,
  now = Date.now(),
): RateLimitResult {
  pruneBuckets(now, rule.windowMs)
  const bucket = buckets.get(key) ?? { hits: [], blockedUntil: 0 }
  const windowStart = now - rule.windowMs
  bucket.hits = bucket.hits.filter((ts) => ts > windowStart)
  bucket.hits.push(now)
  if (bucket.hits.length >= rule.max) {
    bucket.blockedUntil = now + (rule.blockMs ?? rule.windowMs)
  }
  buckets.set(key, bucket)
  return {
    allowed: bucket.hits.length < rule.max,
    remaining: Math.max(0, rule.max - bucket.hits.length),
    retryAfterSeconds:
      bucket.hits.length >= rule.max
        ? Math.ceil((rule.blockMs ?? rule.windowMs) / 1000)
        : 0,
  }
}

/** Libère un compteur (connexion réussie, ou remise à zéro explicite). */
export function resetRateLimit(key: string): void {
  buckets.delete(key)
}

/** Purge totale — réservé aux tests. */
export function resetAllRateLimits(): void {
  buckets.clear()
}

/** Règles par défaut du produit. */
export const RATE_LIMITS = {
  /** 5 tentatives échouées par identifiant + IP sur 15 minutes. */
  loginPerIdentity: { max: 5, windowMs: 15 * 60_000, blockMs: 15 * 60_000 },
  /** 30 tentatives par IP sur 15 minutes (protection énumération). */
  loginPerIp: { max: 30, windowMs: 15 * 60_000, blockMs: 15 * 60_000 },
  /** 10 créations de compte par IP et par heure. */
  registerPerIp: { max: 10, windowMs: 60 * 60_000, blockMs: 60 * 60_000 },
  /** 60 opérations d'administration de comptes par heure et par utilisateur. */
  userAdminPerActor: { max: 60, windowMs: 60 * 60_000, blockMs: 15 * 60_000 },
  /** 120 rafraîchissements de session par IP et par quart d'heure. */
  refreshPerIp: { max: 120, windowMs: 15 * 60_000, blockMs: 5 * 60_000 },
} as const satisfies Record<string, RateLimitRule>
