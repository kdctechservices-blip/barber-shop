import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  AuthApiError,
  getNeonAuthStatus,
  listUsersOnNeon,
  listUserTenants,
  loginUserOnNeon,
  logoutUserSession,
  provisionUsersOnNeon,
  refreshUserSession,
  registerUserOnNeon,
  switchTenantSession,
  updateUserOnNeon,
  verifyAuthSessionToken,
  type RegisterUserInput,
  type SessionTokenPayload,
  type UpdateUserInput,
} from './authEngine.ts'
import {
  checkRateLimit,
  consumeRateLimit,
  RATE_LIMITS,
  recordRateLimitFailure,
  resetRateLimit,
} from './rateLimiter.ts'
import {
  getNeonPool,
  sanitizeDatabaseUrl,
  verifyManagerPin,
  type SqlPoolLike,
} from './neonClient.ts'
import {
  ensureNeonSchema,
  readFullCloudState,
  readSyncChangesSince,
  syncWithNeonDatabase,
  type CloudSyncEnvelope,
} from './syncEngine.ts'
import { isSessionActive } from './sessions.ts'
import {
  BILLING_PERIOD_DAYS,
  DEFAULT_PLAN_CODE,
  PAST_DUE_GRACE_DAYS,
  TRIAL_DAYS,
  TRIAL_PLAN_CODE,
  isPlanCode,
  planCatalogPublic,
} from './plans.ts'
import {
  PlanLimitError,
  activateSubscriptionForOrg,
  cancelSubscription,
  readTenantPlan,
  requestPlanChange,
  type TenantPlanContext,
} from './subscriptions.ts'
import { resolveDefaultTenantId, withTenantClient } from './tenantContext.ts'

export interface ApiHandlerOptions {
  poolOverride?: SqlPoolLike | null
  expectedPinOverride?: string
  databaseUrlOverride?: string
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(JSON.stringify(body))
}

/**
 * Vue API d'un abonnement : offre applicable, échéance, consommation et
 * limites. Les limites `null` signifient « illimité ».
 */
function billingSnapshot(plan: TenantPlanContext): Record<string, unknown> {
  return {
    plan: plan.effective.plan,
    planCode: plan.effective.planCode,
    status: plan.effective.status,
    isExpired: plan.effective.isExpired,
    daysRemaining: plan.effective.daysRemaining,
    pendingPlanCode: plan.effective.pendingPlanCode,
    usage: { members: plan.members, salons: plan.salons },
    limits: {
      members: plan.effective.plan.maxEmployees,
      salons: plan.effective.plan.maxSalons,
      devices: plan.effective.plan.maxDevices,
    },
  }
}

function extractBearerToken(req: IncomingMessage): string | undefined {
  const authHeader = req.headers.authorization
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim()
  }
  return undefined
}

function extractPinFromHeaders(req: IncomingMessage): string | undefined {
  const pinHeader = req.headers['x-salon-pin']
  if (typeof pinHeader === 'string' && pinHeader.trim()) {
    return pinHeader.trim()
  }
  return extractBearerToken(req)
}

function extractClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(',')[0].trim()
  }
  const realIp = req.headers['x-real-ip']
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim()
  }
  const socket = req.socket as { remoteAddress?: string } | undefined
  return socket?.remoteAddress ?? 'unknown'
}

function rejectWhenRateLimited(
  res: ServerResponse,
  result: { allowed: boolean; retryAfterSeconds: number },
  message: string,
): boolean {
  if (result.allowed) return false
  res.setHeader('Retry-After', String(Math.max(1, result.retryAfterSeconds)))
  sendJson(res, 429, {
    ok: false,
    code: 'TOO_MANY_ATTEMPTS',
    message,
    retryAfterSeconds: Math.max(1, result.retryAfterSeconds),
  })
  return true
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const maybePreparsed = (req as IncomingMessage & { body?: unknown }).body
  if (maybePreparsed !== undefined && maybePreparsed !== null) {
    return typeof maybePreparsed === 'string'
      ? JSON.parse(maybePreparsed)
      : maybePreparsed
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    const MAX_BYTES = 15 * 1024 * 1024

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length
      if (totalBytes > MAX_BYTES) {
        reject(new Error('Charge utile trop volumineuse (max 15 Mo).'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('Corps de requête JSON invalide.'))
      }
    })
    req.on('error', reject)
  })
}

function formatDbError(err: unknown): {
  status: number
  code: string
  message: string
} {
  if (err instanceof PlanLimitError) {
    return {
      status: err.status,
      code: err.code,
      message: err.message,
    }
  }
  if (err instanceof AuthApiError) {
    return {
      status: err.status,
      code: err.code,
      message: err.message,
    }
  }
  const rawMsg = err instanceof Error ? err.message : String(err)
  if (
    rawMsg.includes('ENOTFOUND') ||
    rawMsg.includes('EAI_AGAIN') ||
    rawMsg.includes('ECONNREFUSED') ||
    rawMsg.includes('ETIMEDOUT') ||
    rawMsg.includes('Connection terminated') ||
    rawMsg.includes('timeout')
  ) {
    return {
      status: 503,
      code: 'NETWORK_UNREACHABLE',
      message:
        'Base Cloud Neon temporairement injoignable (hors-ligne ou pare-feu réseau). Vos données restent protégées localement dans IndexedDB et se synchroniseront dès le retour de la connexion.',
    }
  }
  if (rawMsg.includes('password authentication failed')) {
    return {
      status: 502,
      code: 'DB_AUTH_FAILED',
      message:
        'Échec d’authentification PostgreSQL Neon : vérifiez DATABASE_URL côté serveur.',
    }
  }
  return {
    status: 500,
    code: 'SYNC_ERROR',
    message: rawMsg || 'Erreur interne lors de la synchronisation Neon.',
  }
}

export async function handleSalonApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ApiHandlerOptions = {},
): Promise<boolean> {
  const urlObj = new URL(req.url ?? '/', 'http://localhost')
  const pathname = urlObj.pathname

  if (!pathname.startsWith('/api/')) {
    return false
  }

  const dbUrl = sanitizeDatabaseUrl(
    options.databaseUrlOverride ?? process.env.DATABASE_URL,
  )
  const expectedPin = options.expectedPinOverride ?? process.env.SALON_SYNC_PIN

  // 1. Santé publique (sans exposer DATABASE_URL ni le PIN)
  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      databaseConfigured: Boolean(dbUrl || options.poolOverride),
      pinRequired: Boolean((expectedPin ?? '').trim()),
    })
    return true
  }

  const pool =
    options.poolOverride !== undefined
      ? options.poolOverride
      : getNeonPool(dbUrl)

  let callerSession: SessionTokenPayload | null = null
  try {
    callerSession = verifyAuthSessionToken(
      extractBearerToken(req),
      expectedPin,
    )
  } catch (err) {
    const formatted = formatDbError(err)
    sendJson(res, formatted.status, {
      ok: false,
      code: formatted.code,
      message: formatted.message,
    })
    return true
  }
  const clientIp = extractClientIp(req)
  const sessionMetadata = {
    userAgent:
      typeof req.headers['user-agent'] === 'string'
        ? req.headers['user-agent']
        : null,
    ip: clientIp,
  }

  // 2. Routes publiques d'authentification (/api/auth/*)
  // Les jetons d'accès porteurs d'un `sid` sont vérifiés en base à chaque
  // requête : une session révoquée (déconnexion, vol de jeton) cesse d'être
  // utilisable immédiatement, sans attendre l'expiration (audit S4).
  if (callerSession?.sid && pool && !pathname.startsWith('/api/auth/')) {
    let active = false
    try {
      active = await isSessionActive(pool, callerSession.sid)
    } catch (err) {
      const formatted = formatDbError(err)
      sendJson(res, formatted.status, {
        ok: false,
        code: formatted.code,
        message: formatted.message,
      })
      return true
    }
    if (!active) {
      sendJson(res, 401, {
        ok: false,
        code: 'SESSION_REVOKED',
        message: 'Session close ou expirée : reconnectez-vous.',
      })
      return true
    }
  }

  if (pathname.startsWith('/api/auth/')) {
    if (!pool) {
      sendJson(res, 503, {
        ok: false,
        code: 'DB_NOT_CONFIGURED',
        message:
          "DATABASE_URL n'est pas configurée côté serveur : fonctionnement local hors-ligne actif.",
      })
      return true
    }

    if (pathname === '/api/auth/status' && req.method === 'GET') {
      try {
        const status = await getNeonAuthStatus(pool)
        sendJson(res, 200, {
          ok: true,
          ...status,
        })
      } catch (err) {
        const formatted = formatDbError(err)
        sendJson(res, formatted.status, {
          ok: false,
          code: formatted.code,
          message: formatted.message,
        })
      }
      return true
    }

    if (pathname === '/api/auth/register' && req.method === 'POST') {
      try {
        const registerLimit = consumeRateLimit(
          `register:${clientIp}`,
          RATE_LIMITS.registerPerIp,
        )
        if (
          rejectWhenRateLimited(
            res,
            registerLimit,
            "Trop de créations de compte depuis cet appareil. Réessayez dans quelques minutes.",
          )
        ) {
          return true
        }
        const body = (await readJsonBody(req)) as RegisterUserInput
        const result = await registerUserOnNeon(pool, body, {
          expectedPin,
          callerSession,
          metadata: sessionMetadata,
        })
        sendJson(res, 201, {
          ok: true,
          ...result,
        })
      } catch (err) {
        const formatted = formatDbError(err)
        sendJson(res, formatted.status, {
          ok: false,
          code: formatted.code,
          message: formatted.message,
        })
      }
      return true
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      try {
        const body = (await readJsonBody(req)) as {
          email?: string
          password?: string
        }
        const identityKey = `login:${clientIp}:${String(body.email ?? '')
          .trim()
          .toLowerCase()}`
        const ipKey = `login-ip:${clientIp}`
        const identityState = checkRateLimit(
          identityKey,
          RATE_LIMITS.loginPerIdentity,
        )
        const ipState = checkRateLimit(ipKey, RATE_LIMITS.loginPerIp)
        if (
          rejectWhenRateLimited(
            res,
            identityState,
            'Trop de tentatives de connexion. Réessayez dans quelques minutes.',
          ) ||
          rejectWhenRateLimited(
            res,
            ipState,
            'Trop de tentatives de connexion depuis cet appareil. Réessayez dans quelques minutes.',
          )
        ) {
          return true
        }

        let result: Awaited<ReturnType<typeof loginUserOnNeon>>
        try {
          result = await loginUserOnNeon(
            pool,
            { email: body.email ?? '', password: body.password ?? '' },
            { expectedPin, metadata: sessionMetadata },
          )
        } catch (err) {
          // Seuls les échecs alimentent la limitation (pas les succès).
          recordRateLimitFailure(identityKey, RATE_LIMITS.loginPerIdentity)
          recordRateLimitFailure(ipKey, RATE_LIMITS.loginPerIp)
          throw err
        }
        resetRateLimit(identityKey)
        sendJson(res, 200, {
          ok: true,
          ...result,
        })
      } catch (err) {
        const formatted = formatDbError(err)
        sendJson(res, formatted.status, {
          ok: false,
          code: formatted.code,
          message: formatted.message,
        })
      }
      return true
    }

    if (pathname === '/api/auth/refresh' && req.method === 'POST') {
      try {
        const refreshLimit = consumeRateLimit(
          `refresh:${clientIp}`,
          RATE_LIMITS.refreshPerIp,
        )
        if (
          rejectWhenRateLimited(
            res,
            refreshLimit,
            'Trop de rafraîchissements de session depuis cet appareil. Réessayez dans quelques minutes.',
          )
        ) {
          return true
        }
        const body = (await readJsonBody(req)) as { refreshToken?: string }
        const result = await refreshUserSession(
          pool,
          body.refreshToken ?? '',
          { expectedPin, metadata: sessionMetadata },
        )
        sendJson(res, 200, { ok: true, ...result })
      } catch (err) {
        const formatted = formatDbError(err)
        sendJson(res, formatted.status, {
          ok: false,
          code: formatted.code,
          message: formatted.message,
        })
      }
      return true
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      try {
        const body = (await readJsonBody(req)) as { refreshToken?: string }
        const { revoked } = await logoutUserSession(pool, {
          sessionId: callerSession?.sid,
          refreshToken:
            typeof body.refreshToken === 'string' && body.refreshToken
              ? body.refreshToken
              : undefined,
        })
        sendJson(res, 200, { ok: true, revoked })
      } catch (err) {
        const formatted = formatDbError(err)
        sendJson(res, formatted.status, {
          ok: false,
          code: formatted.code,
          message: formatted.message,
        })
      }
      return true
    }


    if (pathname === '/api/auth/tenants' && req.method === 'GET') {
      try {
        const tenants = await listUserTenants(pool, callerSession)
        sendJson(res, 200, {
          ok: true,
          activeTenantId: callerSession?.tid ?? null,
          tenants,
        })
      } catch (err) {
        const formatted = formatDbError(err)
        sendJson(res, formatted.status, {
          ok: false,
          code: formatted.code,
          message: formatted.message,
        })
      }
      return true
    }

    if (pathname === '/api/auth/switch-tenant' && req.method === 'POST') {
      try {
        const body = (await readJsonBody(req)) as { tenantId?: string }
        const result = await switchTenantSession(
          pool,
          callerSession,
          String(body.tenantId ?? '').trim(),
          { expectedPin, metadata: sessionMetadata },
        )
        console.info(
          `[audit] tenant.switch actor=${callerSession?.uid} from=${callerSession?.tid} to=${result.tenantId}`,
        )
        sendJson(res, 200, { ok: true, ...result })
      } catch (err) {
        const formatted = formatDbError(err)
        sendJson(res, formatted.status, {
          ok: false,
          code: formatted.code,
          message: formatted.message,
        })
      }
      return true
    }

    sendJson(res, 404, {
      ok: false,
      code: 'NOT_FOUND',
      message: `Route Auth introuvable : ${req.method} ${pathname}`,
    })
    return true
  }

  // 3. Administration des comptes (/api/users*) — session Gérant OBLIGATOIRE.
  //    Aucune création, promotion ou réécriture de compte ne peut transiter
  //    par la synchronisation (audit §6.1 S1/S3).
  if (pathname === '/api/users' || pathname.startsWith('/api/users/')) {
    if (!callerSession) {
      sendJson(res, 401, {
        ok: false,
        code: 'SESSION_REQUIRED',
        message:
          "Connectez-vous avec un compte Gérant pour administrer les comptes du salon.",
      })
      return true
    }
    if (!pool) {
      sendJson(res, 503, {
        ok: false,
        code: 'DB_NOT_CONFIGURED',
        message:
          "DATABASE_URL n'est pas configurée côté serveur : gestion des comptes indisponible.",
      })
      return true
    }
    if (callerSession.role !== 'manager') {
      sendJson(res, 403, {
        ok: false,
        code: 'MANAGER_ROLE_REQUIRED',
        message: 'Seul un compte Gérant peut administrer les comptes du salon.',
      })
      return true
    }
    if (
      rejectWhenRateLimited(
        res,
        consumeRateLimit(
          `user-admin:${callerSession.uid}`,
          RATE_LIMITS.userAdminPerActor,
        ),
        "Trop d'opérations d'administration de comptes. Réessayez dans quelques minutes.",
      )
    ) {
      return true
    }

    if (pathname === '/api/users' && req.method === 'GET') {
      try {
        const users = await listUsersOnNeon(pool, callerSession)
        sendJson(res, 200, { ok: true, users })
      } catch (err) {
        const formatted = formatDbError(err)
        sendJson(res, formatted.status, {
          ok: false,
          code: formatted.code,
          message: formatted.message,
        })
      }
      return true
    }

    if (pathname === '/api/users/provision' && req.method === 'POST') {
      try {
        const body = (await readJsonBody(req)) as { accounts?: unknown }
        const result = await provisionUsersOnNeon(pool, body, callerSession)
        console.info(
          `[audit] user.provision actor=${callerSession.uid} created=${result.created} skipped=${result.skipped} invalid=${result.invalid} blockedByPlan=${result.blockedByPlan}`,
        )
        sendJson(res, 200, { ok: true, ...result })
      } catch (err) {
        const formatted = formatDbError(err)
        sendJson(res, formatted.status, {
          ok: false,
          code: formatted.code,
          message: formatted.message,
        })
      }
      return true
    }

    if (
      pathname.startsWith('/api/users/') &&
      req.method === 'PATCH'
    ) {
      try {
        const targetId = decodeURIComponent(
          pathname.slice('/api/users/'.length),
        ).trim()
        if (!targetId) {
          sendJson(res, 400, {
            ok: false,
            code: 'INVALID_USER_ID',
            message: 'Identifiant de compte manquant.',
          })
          return true
        }
        const body = (await readJsonBody(req)) as UpdateUserInput
        const user = await updateUserOnNeon(pool, targetId, body, callerSession)
        console.info(
          `[audit] user.update actor=${callerSession.uid} target=${targetId} role=${user.role} active=${user.isActive}`,
        )
        sendJson(res, 200, { ok: true, user })
      } catch (err) {
        const formatted = formatDbError(err)
        sendJson(res, formatted.status, {
          ok: false,
          code: formatted.code,
          message: formatted.message,
        })
      }
      return true
    }

    sendJson(res, 404, {
      ok: false,
      code: 'NOT_FOUND',
      message: `Route Users introuvable : ${req.method} ${pathname}`,
    })
    return true
  }

  // 3. Facturation (/api/billing*) — catalogue d'offres, abonnement courant et
  //    activation par le canal plateforme (aucun paiement n'est simulé).
  if (pathname === '/api/billing/plans' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      plans: planCatalogPublic(),
      currency: 'FCFA',
      defaultPlan: DEFAULT_PLAN_CODE,
      trialPlan: TRIAL_PLAN_CODE,
      trialDays: TRIAL_DAYS,
      graceDays: PAST_DUE_GRACE_DAYS,
      billingPeriodDays: BILLING_PERIOD_DAYS,
    })
    return true
  }

  if (pathname.startsWith('/api/billing/')) {
    // Activation d'une offre : canal plateforme uniquement (secret serveur).
    // Aucune session client n'est acceptée ici : seul le détenteur du code
    // serveur peut confirmer un encaissement. Le jeton de session, s'il est
    // présent, est ignoré (il ne peut donc pas s'auto-attribuer une offre).
    if (pathname === '/api/billing/activate' && req.method === 'POST') {
      const platformCheck = verifyManagerPin(extractPinFromHeaders(req), expectedPin)
      if (!platformCheck.pinConfigured) {
        sendJson(res, 503, {
          ok: false,
          code: 'PLATFORM_CHANNEL_DISABLED',
          message:
            "Le canal plateforme n'est pas configuré (SALON_SYNC_PIN absent) : activation impossible.",
        })
        return true
      }
      if (!platformCheck.authorized) {
        sendJson(res, 403, {
          ok: false,
          code: 'PLATFORM_SECRET_REQUIRED',
          message:
            "Activation réservée à la plateforme : code serveur invalide.",
        })
        return true
      }
      if (!pool) {
        sendJson(res, 503, {
          ok: false,
          code: 'DB_NOT_CONFIGURED',
          message:
            "DATABASE_URL n'est pas configurée côté serveur : activation indisponible.",
        })
        return true
      }
      try {
        const body = (await readJsonBody(req)) as {
          orgId?: unknown
          tenantId?: unknown
          planCode?: unknown
          months?: unknown
          reference?: unknown
        }
        const orgId =
          typeof body?.orgId === 'string' && body.orgId.trim()
            ? body.orgId.trim()
            : null
        const tenantId =
          typeof body?.tenantId === 'string' && body.tenantId.trim()
            ? body.tenantId.trim()
            : null
        if (!orgId && !tenantId) {
          sendJson(res, 400, {
            ok: false,
            code: 'ORG_REQUIRED',
            message: 'Indiquez l’organisation (orgId) ou le salon (tenantId) à activer.',
          })
          return true
        }
        if (body?.planCode !== undefined && !isPlanCode(body.planCode)) {
          sendJson(res, 400, {
            ok: false,
            code: 'INVALID_PLAN',
            message: 'Offre inconnue.',
          })
          return true
        }
        const months =
          typeof body?.months === 'number' && Number.isFinite(body.months)
            ? body.months
            : 1
        const result = await activateSubscriptionForOrg(pool, {
          orgId,
          tenantId,
          planCode: isPlanCode(body?.planCode) ? body.planCode : undefined,
          months,
          reference:
            typeof body?.reference === 'string' ? body.reference : undefined,
        })
        console.info(
          `[audit] billing.activate org=${result.orgId} plan=${result.subscription.planCode} months=${months} by=platform`,
        )
        sendJson(res, 200, {
          ok: true,
          orgId: result.orgId,
          subscription: result.subscription,
          ...billingSnapshot(result.plan),
        })
      } catch (err) {
        const formatted = formatDbError(err)
        sendJson(res, formatted.status, {
          ok: false,
          code: formatted.code,
          message: formatted.message,
        })
      }
      return true
    }

    if (!callerSession) {
      sendJson(res, 401, {
        ok: false,
        code: 'SESSION_REQUIRED',
        message:
          'Connectez-vous pour consulter ou gérer votre abonnement.',
      })
      return true
    }
    if (!pool) {
      sendJson(res, 503, {
        ok: false,
        code: 'DB_NOT_CONFIGURED',
        message:
          "DATABASE_URL n'est pas configurée côté serveur : facturation indisponible.",
      })
      return true
    }

    if (pathname === '/api/billing/subscription' && req.method === 'GET') {
      try {
        const plan = await readTenantPlan(pool, callerSession.tid)
        sendJson(res, 200, {
          ok: true,
          subscription: plan.subscription,
          ...billingSnapshot(plan),
        })
      } catch (err) {
        const formatted = formatDbError(err)
        sendJson(res, formatted.status, {
          ok: false,
          code: formatted.code,
          message: formatted.message,
        })
      }
      return true
    }

    if (
      pathname === '/api/billing/subscribe' ||
      pathname === '/api/billing/cancel'
    ) {
      if (req.method !== 'POST') {
        sendJson(res, 405, {
          ok: false,
          code: 'METHOD_NOT_ALLOWED',
          message: 'Méthode non autorisée sur cette route de facturation.',
        })
        return true
      }
      if (callerSession.role !== 'manager') {
        sendJson(res, 403, {
          ok: false,
          code: 'MANAGER_ROLE_REQUIRED',
          message: 'Seul un compte Gérant peut gérer l’abonnement du salon.',
        })
        return true
      }
      if (
        rejectWhenRateLimited(
          res,
          consumeRateLimit(
            `billing:${callerSession.uid}`,
            RATE_LIMITS.userAdminPerActor,
          ),
          "Trop d'opérations de facturation. Réessayez dans quelques minutes.",
        )
      ) {
        return true
      }
      try {
        const plan = await readTenantPlan(pool, callerSession.tid)
        if (pathname === '/api/billing/cancel') {
          const subscription = await cancelSubscription(pool, {
            orgId: plan.orgId,
            actorId: callerSession.uid,
          })
          const updated = await readTenantPlan(pool, callerSession.tid)
          console.info(
            `[audit] billing.cancel org=${plan.orgId} plan=${subscription.planCode} actor=${callerSession.uid}`,
          )
          sendJson(res, 200, {
            ok: true,
            subscription,
            ...billingSnapshot(updated),
          })
          return true
        }

        const body = (await readJsonBody(req)) as { planCode?: unknown }
        if (!isPlanCode(body?.planCode)) {
          sendJson(res, 400, {
            ok: false,
            code: 'INVALID_PLAN',
            message:
              'Offre inconnue : utilisez decouverte, starter, professional, business ou enterprise.',
          })
          return true
        }
        const result = await requestPlanChange(pool, {
          orgId: plan.orgId,
          planCode: body.planCode,
          actorId: callerSession.uid,
        })
        const updated = await readTenantPlan(pool, callerSession.tid)
        console.info(
          `[audit] billing.subscribe org=${plan.orgId} plan=${body.planCode} applied=${result.applied} actor=${callerSession.uid}`,
        )
        sendJson(res, result.applied ? 200 : 202, {
          ok: true,
          applied: result.applied,
          message: result.message,
          subscription: result.subscription,
          ...billingSnapshot(updated),
        })
      } catch (err) {
        const formatted = formatDbError(err)
        sendJson(res, formatted.status, {
          ok: false,
          code: formatted.code,
          message: formatted.message,
        })
      }
      return true
    }

    sendJson(res, 404, {
      ok: false,
      code: 'NOT_FOUND',
      message: `Route Billing introuvable : ${req.method} ${pathname}`,
    })
    return true
  }

  // 4. Routes /api/sync* : exigent soit un jeton de session signé valide, soit un code serveur SALON_SYNC_PIN configuré
  const pinCheck = verifyManagerPin(extractPinFromHeaders(req), expectedPin)
  const authorizedByPin = pinCheck.pinConfigured && pinCheck.authorized
  if (!authorizedByPin && !callerSession) {
    sendJson(res, 401, {
      ok: false,
      code: 'INVALID_PIN',
      message:
        'Session utilisateur ou code serveur invalide. Connectez-vous à votre compte pour synchroniser.',
    })
    return true
  }

  if (!pool) {
    sendJson(res, 503, {
      ok: false,
      code: 'DB_NOT_CONFIGURED',
      message:
        "DATABASE_URL n'est pas configurée côté serveur (.env ou variables d'environnement).",
    })
    return true
  }

  if (pathname === '/api/sync/verify' && req.method === 'POST') {
    try {
      await ensureNeonSchema(pool)
      const tenantId = callerSession?.tid ?? resolveDefaultTenantId()
      const state = await withTenantClient(pool, tenantId, (client) =>
        readFullCloudState(client, tenantId),
      )
      sendJson(res, 200, {
        ok: true,
        connected: true,
        serverTime: new Date().toISOString(),
        totalRemoteRecords: state.totalRemoteRecords,
        hasRemoteSalon: state.payload !== null,
      })
    } catch (err) {
      const formatted = formatDbError(err)
      sendJson(res, formatted.status, {
        ok: false,
        connected: false,
        code: formatted.code,
        message: formatted.message,
      })
    }
    return true
  }

  if (pathname === '/api/sync/pull' && req.method === 'GET') {
    try {
      await ensureNeonSchema(pool)
      const tenantId = callerSession?.tid ?? resolveDefaultTenantId()
      const since = urlObj.searchParams.get('since')
      if (since !== null) {
        // Mode delta (P0-6) : uniquement ce qui a changé depuis le curseur.
        const delta = await withTenantClient(pool, tenantId, (client) =>
          readSyncChangesSince(client, tenantId, since),
        )
        sendJson(res, 200, {
          ok: true,
          syncedAt: new Date().toISOString(),
          cursor: delta.cursor,
          changes: delta.changes,
          deleted: delta.deleted,
        })
        return true
      }
      const state = await withTenantClient(pool, tenantId, (client) =>
        readFullCloudState(client, tenantId),
      )
      sendJson(res, 200, {
        ok: true,
        syncedAt: new Date().toISOString(),
        totalRemoteRecords: state.totalRemoteRecords,
        payload: state.payload,
        tombstones: state.tombstones,
      })
    } catch (err) {
      const formatted = formatDbError(err)
      sendJson(res, formatted.status, {
        ok: false,
        code: formatted.code,
        message: formatted.message,
      })
    }
    return true
  }

  if (pathname === '/api/sync' && req.method === 'POST') {
    try {
      const body = (await readJsonBody(req)) as Partial<CloudSyncEnvelope> & {
        cursor?: string | number
      }
      if (
        !body ||
        !body.payload ||
        body.payload.format !== 'SALON_PRO_BACKUP_V1'
      ) {
        sendJson(res, 400, {
          ok: false,
          code: 'INVALID_PAYLOAD',
          message:
            'Format de synchronisation invalide (SALON_PRO_BACKUP_V1 attendu).',
        })
        return true
      }

      const tenantId = callerSession?.tid ?? resolveDefaultTenantId()
      const result = await syncWithNeonDatabase(
        pool,
        {
          payload: body.payload,
          tombstones: Array.isArray(body.tombstones) ? body.tombstones : [],
        },
        tenantId,
        { cursor: body.cursor, role: callerSession?.role },
      )
      sendJson(res, 200, result as unknown as Record<string, unknown>)
    } catch (err) {
      const formatted = formatDbError(err)
      sendJson(res, formatted.status, {
        ok: false,
        code: formatted.code,
        message: formatted.message,
      })
    }
    return true
  }

  sendJson(res, 404, {
    ok: false,
    code: 'NOT_FOUND',
    message: `Route API introuvable : ${req.method} ${pathname}`,
  })
  return true
}
