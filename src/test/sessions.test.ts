import { beforeEach, describe, expect, it } from 'vitest'
import { resetAllRateLimits } from '../../server/rateLimiter'
import { ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS } from '../../server/sessions'
import { createInMemoryNeonPool, invokeApi } from './helpers/neonTestHarness'

/**
 * Sessions révocables (audit §6.1 S4).
 *
 * Couvre : émission d'une session à la connexion, jeton d'accès court porteur
 * du claim `sid`, rotation du jeton de rafraîchissement, détection de rejeu
 * (vol) avec révocation de toute la famille, révocation immédiate à la
 * déconnexion et refus des jetons révoqués sur les routes protégées.
 */

const TEST_PIN = 'test-sync-secret'
const EMAIL = 'gerant@salon.ci'
const PASSWORD = 'MotDePasse123'

type Pool = ReturnType<typeof createInMemoryNeonPool>['pool']

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

function decodePayload(token: string): Record<string, unknown> {
  const parts = token.split('.')
  const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(Buffer.from(base64, 'base64').toString('utf8')) as Record<
    string,
    unknown
  >
}

async function registerManager(pool: Pool) {
  const res = await invokeApi({
    method: 'POST',
    url: '/api/auth/register',
    body: {
      fullName: 'Gérant Test',
      email: EMAIL,
      password: PASSWORD,
      role: 'manager',
      salonName: 'Salon Sessions',
    },
    poolOverride: pool,
    expectedPinOverride: TEST_PIN,
  })
  expect(res.statusCode).toBe(201)
  return res.json as unknown as {
    sessionToken: string
    refreshToken: string
    sessionId: string
    expiresAt: number
    tenantId: string
  }
}

async function login(pool: Pool) {
  const res = await invokeApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: EMAIL, password: PASSWORD },
    poolOverride: pool,
    expectedPinOverride: TEST_PIN,
  })
  expect(res.statusCode).toBe(200)
  return res.json as unknown as {
    sessionToken: string
    refreshToken: string
    sessionId: string
    expiresAt: number
    tenantId: string
  }
}

describe('Sessions révocables (S4)', () => {
  beforeEach(() => {
    resetAllRateLimits()
  })

  it("émet un jeton d'accès court porteur d'un identifiant de session", async () => {
    const { pool } = createInMemoryNeonPool()
    const session = await registerManager(pool)

    expect(session.sessionId).toBeTruthy()
    expect(session.refreshToken).toBeTruthy()
    expect(session.refreshToken.length).toBeGreaterThanOrEqual(40)

    const payload = decodePayload(session.sessionToken)
    expect(payload.sid).toBe(session.sessionId)
    expect(payload.tid).toBe(session.tenantId)
    const ttl = Number(payload.exp) - Date.now()
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(ACCESS_TOKEN_TTL_MS)
    expect(ACCESS_TOKEN_TTL_MS).toBe(15 * 60 * 1000)

    const accessTtl = session.expiresAt - Date.now()
    expect(accessTtl).toBeGreaterThan(0)
    expect(accessTtl).toBeLessThanOrEqual(ACCESS_TOKEN_TTL_MS)
    // Le jeton de rafraîchissement vit nettement plus longtemps que l'accès.
    expect(REFRESH_TOKEN_TTL_MS).toBeGreaterThan(accessTtl * 10)
  })

  it('fait tourner le jeton de rafraîchissement à chaque appel', async () => {
    const { pool } = createInMemoryNeonPool()
    await registerManager(pool)
    const first = await login(pool)

    const refreshed = await invokeApi({
      method: 'POST',
      url: '/api/auth/refresh',
      body: { refreshToken: first.refreshToken },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(refreshed.statusCode).toBe(200)
    const next = refreshed.json as unknown as {
      sessionToken: string
      refreshToken: string
      sessionId: string
    }

    expect(next.refreshToken).not.toBe(first.refreshToken)
    expect(next.sessionId).not.toBe(first.sessionId)
    expect(decodePayload(next.sessionToken).sid).toBe(next.sessionId)

    // Le nouveau jeton de rafraîchissement fonctionne…
    const second = await invokeApi({
      method: 'POST',
      url: '/api/auth/refresh',
      body: { refreshToken: next.refreshToken },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(second.statusCode).toBe(200)
  })

  it('révoque toute la famille de sessions lorsqu’un jeton déjà consommé est rejoué', async () => {
    const { pool } = createInMemoryNeonPool()
    await registerManager(pool)
    const sessionA = await login(pool)
    const sessionB = await login(pool)

    // Déconnexion de la session A : son jeton est marqué révoqué (motif logout).
    const logout = await invokeApi({
      method: 'POST',
      url: '/api/auth/logout',
      headers: authHeader(sessionA.sessionToken),
      body: { refreshToken: sessionA.refreshToken },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(logout.statusCode).toBe(200)
    expect(logout.json.revoked).toBeGreaterThanOrEqual(1)

    // Rejeu d'un jeton révoqué (hors fenêtre de rotation) = vol probable.
    const replay = await invokeApi({
      method: 'POST',
      url: '/api/auth/refresh',
      body: { refreshToken: sessionA.refreshToken },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(replay.statusCode).toBe(401)
    expect(replay.json.code).toBe('SESSION_REUSED')

    // Toute la famille est coupée : la session B ne fonctionne plus non plus.
    const stillAlive = await invokeApi({
      method: 'GET',
      url: '/api/users',
      headers: authHeader(sessionB.sessionToken),
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(stillAlive.statusCode).toBe(401)
    expect(stillAlive.json.code).toBe('SESSION_REVOKED')
  })

  it('refuse immédiatement un jeton d’accès après déconnexion', async () => {
    const { pool } = createInMemoryNeonPool()
    await registerManager(pool)
    const session = await login(pool)

    const before = await invokeApi({
      method: 'GET',
      url: '/api/users',
      headers: authHeader(session.sessionToken),
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(before.statusCode).toBe(200)

    const logout = await invokeApi({
      method: 'POST',
      url: '/api/auth/logout',
      headers: authHeader(session.sessionToken),
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(logout.statusCode).toBe(200)

    const after = await invokeApi({
      method: 'GET',
      url: '/api/users',
      headers: authHeader(session.sessionToken),
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(after.statusCode).toBe(401)
    expect(after.json.code).toBe('SESSION_REVOKED')
  })

  it('rejette un jeton de rafraîchissement inconnu ou vide', async () => {
    const { pool } = createInMemoryNeonPool()
    await registerManager(pool)

    const unknown = await invokeApi({
      method: 'POST',
      url: '/api/auth/refresh',
      body: { refreshToken: 'jeton-invente-de-trente-deux-octets-minimum' },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(unknown.statusCode).toBe(401)
    expect(unknown.json.code).toBe('INVALID_REFRESH_TOKEN')

    const empty = await invokeApi({
      method: 'POST',
      url: '/api/auth/refresh',
      body: {},
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(empty.statusCode).toBe(400)
    expect(empty.json.code).toBe('MISSING_REFRESH_TOKEN')
  })

  it('reste idempotent sur une double déconnexion et tolère l’absence de jeton', async () => {
    const { pool } = createInMemoryNeonPool()
    await registerManager(pool)
    const session = await login(pool)

    const first = await invokeApi({
      method: 'POST',
      url: '/api/auth/logout',
      headers: authHeader(session.sessionToken),
      body: { refreshToken: session.refreshToken },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(first.statusCode).toBe(200)

    const second = await invokeApi({
      method: 'POST',
      url: '/api/auth/logout',
      headers: authHeader(session.sessionToken),
      body: { refreshToken: session.refreshToken },
      poolOverride: pool,
      expectedPinOverride: TEST_PIN,
    })
    expect(second.statusCode).toBe(200)
    expect(second.json.revoked).toBe(0)
  })
})
