import {
  createHmac,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  PublicSalonUser,
  SalonUserAccount,
  UserRole,
} from '../src/domain/models/index.ts'
import {
  verifyManagerPin,
  type SqlPoolLike,
  type SqlQueryable,
} from './neonClient.ts'
import { ensureNeonSchema, readFullCloudState } from './syncEngine.ts'
import {
  DEFAULT_TENANT_ID,
  isTenantId,
  resolveDefaultTenantId,
  withTenantClient,
} from './tenantContext.ts'

const PBKDF2_ITERATIONS = 100_000
const KEY_BYTES = 32
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 jours

let cachedRuntimeSecret: string | null = null

function loadOrCreatePersistentRuntimeSecret(): string {
  if (cachedRuntimeSecret) return cachedRuntimeSecret
  const secretFilePath = resolve(process.cwd(), '.salon-auth-secret')
  try {
    if (existsSync(secretFilePath)) {
      const stored = readFileSync(secretFilePath, 'utf8').trim()
      if (stored.length >= 32) {
        cachedRuntimeSecret = stored
        return stored
      }
    }
    const generated = randomBytes(32).toString('hex')
    writeFileSync(secretFilePath, `${generated}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    cachedRuntimeSecret = generated
    return generated
  } catch {
    // Environnement serverless en lecture seule : repli mémoire si SALON_AUTH_SECRET non défini
    cachedRuntimeSecret = randomBytes(32).toString('hex')
    return cachedRuntimeSecret
  }
}

export interface SessionTokenPayload {
  uid: string
  email: string
  role: UserRole
  /** Salon (tenant) actif — TOUJOURS issu du jeton signé, jamais du client. */
  tid: string
  exp: number
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

export function hashPasswordNode(
  password: string,
  iterations = PBKDF2_ITERATIONS,
): string {
  const salt = randomBytes(16)
  const derived = pbkdf2Sync(password, salt, iterations, KEY_BYTES, 'sha256')
  return `pbkdf2_sha256$${iterations}$${salt.toString('hex')}$${derived.toString('hex')}`
}

export function verifyPasswordNode(
  password: string,
  storedHash: string,
): boolean {
  const parts = storedHash.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') {
    return false
  }
  const iterations = Number.parseInt(parts[1], 10)
  if (!Number.isFinite(iterations) || iterations < 1_000) {
    return false
  }
  const salt = Buffer.from(parts[2], 'hex')
  const expected = Buffer.from(parts[3], 'hex')
  const actual = pbkdf2Sync(
    password,
    salt,
    iterations,
    expected.length,
    'sha256',
  )
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

export function toPublicUser(account: SalonUserAccount): PublicSalonUser {
  const { passwordHash: _ignored, ...rest } = account
  void _ignored
  return rest
}

/**
 * Politique de mot de passe du produit (alignée client/serveur).
 * Voir AGENTS.md §3 : aucun secret par défaut, uniquement des secrets réels.
 */
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 200

export function assertStrongPassword(password: string): void {
  const value = password ?? ''
  const hasLetter = /[A-Za-z]/.test(value)
  const hasDigit = /\d/.test(value)
  if (
    value.length < PASSWORD_MIN_LENGTH ||
    value.length > PASSWORD_MAX_LENGTH ||
    !hasLetter ||
    !hasDigit
  ) {
    throw new AuthApiError(
      400,
      'WEAK_PASSWORD',
      `Le mot de passe doit contenir au moins ${PASSWORD_MIN_LENGTH} caractères, avec au moins une lettre et un chiffre.`,
    )
  }
}

function isProductionRuntime(): boolean {
  return (
    process.env.NODE_ENV === 'production' || process.env.VERCEL === '1'
  )
}

/**
 * En production, `SALON_AUTH_SECRET` est OBLIGATOIRE : sans lui, chaque
 * instance serverless générerait un secret différent et invaliderait les
 * sessions de façon imprévisible (voir audit §6.1 S7).
 */
function getSigningSecret(fallbackSecret?: string): string {
  const explicit = (process.env.SALON_AUTH_SECRET ?? '').trim()
  if (explicit) return explicit
  if (isProductionRuntime()) {
    throw new AuthApiError(
      500,
      'AUTH_SECRET_MISSING',
      'SALON_AUTH_SECRET doit être configuré côté serveur en production (voir .env.example).',
    )
  }
  const fallback = (fallbackSecret ?? process.env.SALON_SYNC_PIN ?? '').trim()
  return fallback || loadOrCreatePersistentRuntimeSecret()
}

export function signAuthSessionToken(
  user: Pick<SalonUserAccount, 'id' | 'email' | 'role'>,
  fallbackSecret?: string,
  tenantId: string = resolveDefaultTenantId(),
): string {
  const payload: SessionTokenPayload = {
    uid: user.id,
    email: user.email,
    role: user.role,
    tid: isTenantId(tenantId) ? tenantId : DEFAULT_TENANT_ID,
    exp: Date.now() + SESSION_TTL_MS,
  }
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  )
  const sig = createHmac('sha256', getSigningSecret(fallbackSecret))
    .update(`s1.${encodedPayload}`)
    .digest('base64url')
  return `s1.${encodedPayload}.${sig}`
}

export function verifyAuthSessionToken(
  token: string | undefined,
  fallbackSecret?: string,
): SessionTokenPayload | null {
  if (!token || !token.startsWith('s1.')) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [, encodedPayload, providedSig] = parts
  const expectedSig = createHmac('sha256', getSigningSecret(fallbackSecret))
    .update(`s1.${encodedPayload}`)
    .digest('base64url')

  const a = Buffer.from(providedSig, 'utf8')
  const b = Buffer.from(expectedSig, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    ) as SessionTokenPayload
    if (!parsed.uid || !parsed.email || !parsed.exp) return null
    if (Date.now() > parsed.exp) return null
    // Jetons émis avant la migration multi-tenant : rattachés au salon par défaut.
    if (!isTenantId(parsed.tid)) {
      parsed.tid = DEFAULT_TENANT_ID
    }
    return parsed
  } catch {
    return null
  }
}

export class AuthApiError extends Error {
  public readonly status: number
  public readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function parseAccountRow(raw: SalonUserAccount | string): SalonUserAccount {
  return typeof raw === 'string' ? (JSON.parse(raw) as SalonUserAccount) : raw
}

interface TenantAccount {
  account: SalonUserAccount
  tenantId: string
}

/**
 * Lecture globale (authentification uniquement) : l'identifiant de connexion
 * peut appartenir à n'importe quel salon. `salon_users` n'est volontairement
 * pas soumise à RLS (l'authentification précède la connaissance du salon) ;
 * toute autre lecture est filtrée par `tenant_id`.
 */
async function readAccountsGlobal(pool: SqlPoolLike): Promise<TenantAccount[]> {
  const res = await pool.query<{
    payload_json: SalonUserAccount | string
    tenant_id?: string
  }>('SELECT payload_json, tenant_id FROM salon_users ORDER BY created_at ASC')
  return res.rows.map((r) => {
    const account = parseAccountRow(r.payload_json)
    const tenantId = isTenantId(r.tenant_id)
      ? r.tenant_id
      : isTenantId(account.tenantId)
        ? account.tenantId
        : resolveDefaultTenantId()
    return { account, tenantId }
  })
}

/** Lecture strictement limitée à un salon. */
async function readAccountsForTenant(
  db: SqlQueryable,
  tenantId: string,
): Promise<SalonUserAccount[]> {
  const res = await db.query<{
    payload_json: SalonUserAccount | string
    tenant_id?: string
  }>(
    'SELECT payload_json, tenant_id FROM salon_users WHERE tenant_id = $1 ORDER BY created_at ASC',
    [tenantId],
  )
  return res.rows
    .filter((r) => !isTenantId(r.tenant_id) || r.tenant_id === tenantId)
    .map((r) => parseAccountRow(r.payload_json))
}

/** Crée l'organisation et le salon d'un nouveau client SaaS. */
async function createTenantForSalon(
  pool: SqlPoolLike,
  salonName: string | undefined,
): Promise<string> {
  const tenantId = randomUUID()
  const organizationId = randomUUID()
  const name = (salonName ?? '').trim() || 'Mon salon'
  await pool.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [
    organizationId,
    name,
  ])
  await pool.query(
    `INSERT INTO tenants (id, org_id, slug, name, status)
     VALUES ($1, $2, $3, $4, 'active')`,
    [tenantId, organizationId, `salon-${tenantId.slice(0, 8)}`, name],
  )
  return tenantId
}

export async function getNeonAuthStatus(
  pool: SqlPoolLike,
): Promise<{ hasUsers: boolean; hasManager: boolean }> {
  await ensureNeonSchema(pool)
  const accounts = (await readAccountsGlobal(pool))
    .map((entry) => entry.account)
    .filter((u) => u.isActive)
  return {
    hasUsers: accounts.length > 0,
    hasManager: accounts.some((u) => u.role === 'manager'),
  }
}

export interface RegisterUserInput {
  fullName: string
  email: string
  phone?: string
  password: string
  role?: UserRole
  salonName?: string
  managerPin?: string
}

export async function registerUserOnNeon(
  pool: SqlPoolLike,
  input: RegisterUserInput,
  options?: {
    expectedPin?: string
    callerSession?: SessionTokenPayload | null
  },
): Promise<{
  user: PublicSalonUser
  recordForCache: SalonUserAccount
  sessionToken: string
  tenantId: string
}> {
  const fullName = (input.fullName ?? '').trim()
  const email = normalizeEmail(input.email ?? '')
  const password = input.password ?? ''
  const role: UserRole = input.role === 'cashier' ? 'cashier' : 'manager'

  if (fullName.length < 2) {
    throw new AuthApiError(
      400,
      'INVALID_NAME',
      'Veuillez renseigner votre nom complet (au moins 2 caractères).',
    )
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthApiError(
      400,
      'INVALID_EMAIL',
      'Veuillez saisir une adresse e-mail valide.',
    )
  }
  assertStrongPassword(password)

  await ensureNeonSchema(pool)

  const globalAccounts = await readAccountsGlobal(pool)
  const callerTenantId = options?.callerSession?.tid

  let tenantId: string
  if (isTenantId(callerTenantId)) {
    // Gérant authentifié : il ajoute un collaborateur à SON salon.
    tenantId = callerTenantId
  } else if (globalAccounts.length === 0) {
    // Tout premier compte du déploiement : création de l'organisation + du salon.
    tenantId = await createTenantForSalon(pool, input.salonName)
  } else {
    // Déploiement déjà initialisé : seule une autorisation Gérant ou le code
    // serveur permet d'ouvrir un compte supplémentaire.
    tenantId = resolveDefaultTenantId()
    const pinCheck = verifyManagerPin(input.managerPin, options?.expectedPin)
    if (!(pinCheck.pinConfigured && pinCheck.authorized)) {
      throw new AuthApiError(
        403,
        'MANAGER_APPROVAL_REQUIRED',
        'Un compte existe déjà : connectez-vous en tant que Gérant pour ajouter un collaborateur.',
      )
    }
  }

  const tenantAccounts = globalAccounts
    .filter((entry) => entry.tenantId === tenantId)
    .map((entry) => entry.account)

  if (tenantAccounts.some((u) => normalizeEmail(u.email) === email)) {
    throw new AuthApiError(
      409,
      'EMAIL_EXISTS',
      'Un compte existe déjà avec cette adresse e-mail.',
    )
  }

  const hasExistingManager = tenantAccounts.some(
    (u) => u.isActive && u.role === 'manager',
  )

  if (!hasExistingManager && role !== 'manager') {
    throw new AuthApiError(
      400,
      'FIRST_USER_MUST_BE_MANAGER',
      'Le tout premier compte du salon doit avoir le rôle Gérant.',
    )
  }

  if (hasExistingManager) {
    const isManagerCaller =
      options?.callerSession?.role === 'manager' &&
      options.callerSession.tid === tenantId
    const pinCheck = verifyManagerPin(input.managerPin, options?.expectedPin)
    const pinOk = pinCheck.pinConfigured && pinCheck.authorized
    if (!isManagerCaller && !pinOk) {
      throw new AuthApiError(
        403,
        'MANAGER_APPROVAL_REQUIRED',
        'Un compte Gérant existe déjà : connectez-vous en tant que Gérant pour ajouter un collaborateur.',
      )
    }
  }

  const nowIso = new Date().toISOString()
  const account: SalonUserAccount = {
    id: `usr-${randomUUID()}`,
    fullName,
    email,
    phone: input.phone?.trim() || undefined,
    role,
    passwordHash: hashPasswordNode(password),
    isActive: true,
    lastLoginAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
    tenantId,
  }

  await withTenantClient(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO salon_users (id, email, full_name, phone, role, password_hash, is_active, last_login_at, created_at, updated_at, payload_json, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
      [
        account.id,
        account.email,
        account.fullName,
        account.phone ?? null,
        account.role,
        account.passwordHash,
        account.isActive,
        account.lastLoginAt ?? null,
        account.createdAt,
        account.updatedAt,
        JSON.stringify(account),
        tenantId,
      ],
    )

    // Purge persistante immédiate de toute donnée mock éventuelle pour ce salon.
    await readFullCloudState(client, tenantId)
  })

  return {
    user: toPublicUser(account),
    recordForCache: account,
    sessionToken: signAuthSessionToken(account, options?.expectedPin, tenantId),
    tenantId,
  }
}

function normalizeLookupText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
}

function matchesNeonAccountIdentifier(
  account: SalonUserAccount,
  rawIdentifier: string,
): boolean {
  const trimmed = rawIdentifier.trim()
  if (!trimmed) return false

  if (normalizeEmail(account.email) === normalizeEmail(trimmed)) {
    return true
  }

  const normInput = normalizeLookupText(trimmed)
  if (normInput.length >= 2 && normalizeLookupText(account.fullName) === normInput) {
    return true
  }

  const inputDigits = trimmed.replace(/\D+/g, '')
  const accountDigits = (account.phone ?? '').replace(/\D+/g, '')
  if (inputDigits.length >= 6 && accountDigits.length >= 6) {
    if (
      accountDigits === inputDigits ||
      accountDigits.endsWith(inputDigits) ||
      inputDigits.endsWith(accountDigits)
    ) {
      return true
    }
  }

  return false
}

export async function loginUserOnNeon(
  pool: SqlPoolLike,
  input: { email: string; password: string },
  options?: { expectedPin?: string },
): Promise<{
  user: PublicSalonUser
  recordForCache: SalonUserAccount
  sessionToken: string
  tenantId: string
}> {
  const identifier = (input.email ?? '').trim()
  const password = input.password ?? ''

  if (!identifier || !password) {
    throw new AuthApiError(
      400,
      'MISSING_CREDENTIALS',
      'Veuillez saisir votre identifiant (e-mail, nom ou téléphone) et votre mot de passe.',
    )
  }

  await ensureNeonSchema(pool)

  const candidates = (await readAccountsGlobal(pool)).filter((entry) =>
    matchesNeonAccountIdentifier(entry.account, identifier),
  )

  const matched = candidates.find((entry) =>
    verifyPasswordNode(password, entry.account.passwordHash),
  )
  const account = matched?.account

  if (!account) {
    throw new AuthApiError(
      401,
      'INVALID_CREDENTIALS',
      'Identifiant ou mot de passe incorrect.',
    )
  }

  if (!account.isActive) {
    throw new AuthApiError(
      403,
      'ACCOUNT_DISABLED',
      'Ce compte a été désactivé par le Gérant.',
    )
  }

  const tenantId = matched?.tenantId ?? resolveDefaultTenantId()
  const nowIso = new Date().toISOString()
  const updatedAccount: SalonUserAccount = {
    ...account,
    lastLoginAt: nowIso,
    updatedAt: nowIso,
    tenantId,
  }

  await withTenantClient(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO salon_users (id, email, full_name, phone, role, password_hash, is_active, last_login_at, created_at, updated_at, payload_json, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
       ON CONFLICT (id) DO UPDATE SET
         last_login_at = EXCLUDED.last_login_at,
         updated_at = EXCLUDED.updated_at,
         payload_json = EXCLUDED.payload_json,
         tenant_id = EXCLUDED.tenant_id
       WHERE EXCLUDED.updated_at > salon_users.updated_at`,
      [
        updatedAccount.id,
        updatedAccount.email,
        updatedAccount.fullName,
        updatedAccount.phone ?? null,
        updatedAccount.role,
        updatedAccount.passwordHash,
        updatedAccount.isActive,
        updatedAccount.lastLoginAt ?? null,
        updatedAccount.createdAt,
        updatedAccount.updatedAt,
        JSON.stringify(updatedAccount),
        tenantId,
      ],
    )

    await readFullCloudState(client, tenantId)
  })

  return {
    user: toPublicUser(updatedAccount),
    recordForCache: updatedAccount,
    sessionToken: signAuthSessionToken(
      updatedAccount,
      options?.expectedPin,
      tenantId,
    ),
    tenantId,
  }
}

/* -------------------------------------------------------------------------- */
/* Administration des comptes — réservée au Gérant (jamais via la synchro)     */
/* -------------------------------------------------------------------------- */

/**
 * Un payload de synchronisation ne doit JAMAIS pouvoir créer, promouvoir ou
 * réécrire un compte. Toute administration de compte passe par ces fonctions,
 * protégées par une session Gérant vérifiée côté serveur (audit §6.1 S1/S3).
 */
function assertManagerActor(actor: SessionTokenPayload | null | undefined): void {
  if (!actor) {
    throw new AuthApiError(
      401,
      'SESSION_REQUIRED',
      'Authentification requise pour administrer les comptes.',
    )
  }
  if (actor.role !== 'manager') {
    throw new AuthApiError(
      403,
      'MANAGER_ROLE_REQUIRED',
      'Seul un compte Gérant peut administrer les comptes du salon.',
    )
  }
}

function assertTenantActor(
  actor: SessionTokenPayload | null | undefined,
): string {
  assertManagerActor(actor)
  const tenantId = actor?.tid
  if (!isTenantId(tenantId)) {
    throw new AuthApiError(
      400,
      'TENANT_REQUIRED',
      'Aucun salon actif dans la session : reconnectez-vous.',
    )
  }
  return tenantId
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))
}

function isValidPasswordHash(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^pbkdf2_sha256\$\d{4,7}\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(value)
  )
}

export interface UserProvisioningResult {
  created: number
  skipped: number
  invalid: number
}

/**
 * Provisionne (création seule, jamais de mise à jour) les comptes créés
 * hors-ligne par un Gérant. Les identifiants déjà connus sont ignorés : un
 * payload ne peut donc pas écraser un rôle ou un hash existant.
 */
export async function provisionUsersOnNeon(
  pool: SqlPoolLike,
  input: { accounts?: unknown },
  actor: SessionTokenPayload | null | undefined,
): Promise<UserProvisioningResult> {
  const tenantId = assertTenantActor(actor)
  await ensureNeonSchema(pool)

  const rawAccounts = Array.isArray(input.accounts) ? input.accounts : []
  let created = 0
  let skipped = 0
  let invalid = 0

  const existing = await withTenantClient(pool, tenantId, (client) =>
    readAccountsForTenant(client, tenantId),
  )
  const existingIds = new Set(existing.map((u) => u.id))
  const existingEmails = new Set(existing.map((u) => normalizeEmail(u.email)))

  for (const raw of rawAccounts.slice(0, 200)) {
    if (!raw || typeof raw !== 'object') {
      invalid += 1
      continue
    }
    const candidate = raw as Partial<SalonUserAccount>
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
    const email = normalizeEmail(
      typeof candidate.email === 'string' ? candidate.email : '',
    )
    const fullName =
      typeof candidate.fullName === 'string' ? candidate.fullName.trim() : ''
    const role = candidate.role
    const passwordHash = candidate.passwordHash
    const createdAt = candidate.createdAt
    const updatedAt = candidate.updatedAt

    const isStructurallyValid =
      /^[A-Za-z0-9_-]{6,80}$/.test(id) &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
      email.length <= 254 &&
      fullName.length >= 2 &&
      fullName.length <= 120 &&
      (role === 'manager' || role === 'cashier') &&
      isValidPasswordHash(passwordHash) &&
      isIsoDate(createdAt) &&
      isIsoDate(updatedAt)

    if (!isStructurallyValid) {
      invalid += 1
      continue
    }

    if (existingIds.has(id) || existingEmails.has(email)) {
      // Compte déjà connu : on n'écrase ni le rôle ni le hash de mot de passe.
      skipped += 1
      continue
    }

    const account: SalonUserAccount = {
      id,
      fullName,
      email,
      phone:
        typeof candidate.phone === 'string' && candidate.phone.trim()
          ? candidate.phone.trim().slice(0, 30)
          : undefined,
      role: role as UserRole,
      passwordHash,
      isActive: candidate.isActive !== false,
      lastLoginAt: isIsoDate(candidate.lastLoginAt)
        ? candidate.lastLoginAt
        : undefined,
      createdAt,
      updatedAt,
      tenantId,
    }

    try {
      await withTenantClient(pool, tenantId, async (client) => {
        await client.query(
          `INSERT INTO salon_users (id, email, full_name, phone, role, password_hash, is_active, last_login_at, created_at, updated_at, payload_json, tenant_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
           ON CONFLICT (id) DO NOTHING`,
          [
            account.id,
            account.email,
            account.fullName,
            account.phone ?? null,
            account.role,
            account.passwordHash,
            account.isActive,
            account.lastLoginAt ?? null,
            account.createdAt,
            account.updatedAt,
            JSON.stringify(account),
            tenantId,
          ],
        )
      })
      created += 1
      existingIds.add(account.id)
      existingEmails.add(account.email)
    } catch {
      // Violation d'unicité concurrente (23505) : le compte existe déjà.
      skipped += 1
    }
  }

  return { created, skipped, invalid }
}

export async function listUsersOnNeon(
  pool: SqlPoolLike,
  actor: SessionTokenPayload | null | undefined,
): Promise<PublicSalonUser[]> {
  const tenantId = assertTenantActor(actor)
  await ensureNeonSchema(pool)
  const accounts = await withTenantClient(pool, tenantId, (client) =>
    readAccountsForTenant(client, tenantId),
  )
  return accounts.map(toPublicUser)
}

export interface UpdateUserInput {
  fullName?: string
  phone?: string
  role?: UserRole
  isActive?: boolean
  password?: string
}

/**
 * Met à jour un compte : rôle, activation, identité ou mot de passe.
 * Le mot de passe est TOUJOURS haché côté serveur (jamais reçu haché).
 */
export async function updateUserOnNeon(
  pool: SqlPoolLike,
  targetUserId: string,
  input: UpdateUserInput,
  actor: SessionTokenPayload | null | undefined,
): Promise<PublicSalonUser> {
  const tenantId = assertTenantActor(actor)
  await ensureNeonSchema(pool)

  const accounts = await withTenantClient(pool, tenantId, (client) =>
    readAccountsForTenant(client, tenantId),
  )
  const target = accounts.find((u) => u.id === targetUserId)
  if (!target) {
    throw new AuthApiError(404, 'USER_NOT_FOUND', 'Compte introuvable.')
  }

  const activeManagers = accounts.filter(
    (u) => u.role === 'manager' && u.isActive,
  )
  const isLastActiveManager =
    target.role === 'manager' &&
    target.isActive &&
    activeManagers.length <= 1

  const nextRole = input.role ?? target.role
  const nextIsActive = input.isActive ?? target.isActive

  if (nextRole !== 'manager' && isLastActiveManager) {
    throw new AuthApiError(
      409,
      'LAST_MANAGER_REQUIRED',
      'Impossible de retirer le rôle Gérant au dernier Gérant actif du salon.',
    )
  }
  if (!nextIsActive && isLastActiveManager) {
    throw new AuthApiError(
      409,
      'LAST_MANAGER_REQUIRED',
      'Impossible de désactiver le dernier Gérant actif du salon.',
    )
  }
  if (actor && actor.uid === target.id && !nextIsActive) {
    throw new AuthApiError(
      409,
      'CANNOT_DEACTIVATE_SELF',
      'Vous ne pouvez pas désactiver votre propre compte.',
    )
  }

  if (input.fullName !== undefined) {
    const fullName = input.fullName.trim()
    if (fullName.length < 2 || fullName.length > 120) {
      throw new AuthApiError(
        400,
        'INVALID_NAME',
        'Veuillez renseigner un nom complet valide (2 à 120 caractères).',
      )
    }
  }

  let nextPasswordHash = target.passwordHash
  if (input.password !== undefined) {
    assertStrongPassword(input.password)
    nextPasswordHash = hashPasswordNode(input.password)
  }

  // Horodatage serveur strictement croissant : un enregistrement client
  // antidaté ne peut pas bloquer la mise à jour (audit §6.1 S5).
  const existingUpdatedMs = Date.parse(target.updatedAt)
  const nowMs = Date.now()
  const updatedAt = new Date(
    Math.max(nowMs, Number.isNaN(existingUpdatedMs) ? nowMs : existingUpdatedMs + 1),
  ).toISOString()

  const updated: SalonUserAccount = {
    ...target,
    fullName: input.fullName !== undefined ? input.fullName.trim() : target.fullName,
    phone:
      input.phone !== undefined ? input.phone.trim().slice(0, 30) || undefined : target.phone,
    role: nextRole,
    isActive: nextIsActive,
    passwordHash: nextPasswordHash,
    updatedAt,
    tenantId,
  }

  await withTenantClient(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO salon_users (id, email, full_name, phone, role, password_hash, is_active, last_login_at, created_at, updated_at, payload_json, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         full_name = EXCLUDED.full_name,
         phone = EXCLUDED.phone,
         role = EXCLUDED.role,
         password_hash = EXCLUDED.password_hash,
         is_active = EXCLUDED.is_active,
         last_login_at = EXCLUDED.last_login_at,
         updated_at = EXCLUDED.updated_at,
         payload_json = EXCLUDED.payload_json,
         tenant_id = EXCLUDED.tenant_id
       WHERE EXCLUDED.updated_at > salon_users.updated_at`,
      [
        updated.id,
        updated.email,
        updated.fullName,
        updated.phone ?? null,
        updated.role,
        updated.passwordHash,
        updated.isActive,
        updated.lastLoginAt ?? null,
        updated.createdAt,
        updated.updatedAt,
        JSON.stringify(updated),
        tenantId,
      ],
    )
  })

  return toPublicUser(updated)
}
