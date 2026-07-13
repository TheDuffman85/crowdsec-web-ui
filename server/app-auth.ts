import crypto from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
} from '@simplewebauthn/server';
import { generateSecret, generateURI, verify } from 'otplib';
import * as oidcClient from 'openid-client';
import { parseOidcScope, parseOidcUnmatchedRole, type DashboardAuthConfig, type OidcUnmatchedRole } from './config';
import { CrowdsecDatabase, type AuthUserRow, type OidcUserUpsertParams } from './database';
import type { DatabaseWrite } from './sync-worker-client';

type HonoContext = any;
type HonoNext = any;
type Role = 'admin' | 'read-only';
type AuthMethod = 'password' | 'passkey' | 'oidc';
type MutableAuthSettingKey =
  | 'disable_password_login'
  | 'oidc_issuer_url'
  | 'oidc_client_id'
  | 'oidc_client_secret'
  | 'oidc_scope'
  | 'oidc_groups_claim'
  | 'oidc_admin_groups'
  | 'oidc_read_only_groups'
  | 'oidc_unmatched_role';

interface EffectiveAuthConfig {
  oidcIssuerUrl?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  oidcScope: string;
  oidcGroupsClaim: string;
  oidcAdminGroups: string[];
  oidcReadOnlyGroups: string[];
  oidcUnmatchedRole: OidcUnmatchedRole;
}

export interface OidcRoleConfig {
  oidcAdminGroups: string[];
  oidcReadOnlyGroups: string[];
  oidcUnmatchedRole: OidcUnmatchedRole;
}

export interface SessionData {
  userId: number;
  username: string;
  role: Role;
  authMethod?: AuthMethod;
}

export interface DashboardAuth {
  enabled: boolean;
  oidcEnabled: boolean;
  ensureAuth: (context: HonoContext, next: HonoNext) => Promise<Response | void>;
  registerRoutes: (app: Hono) => void;
  getSession: (context: HonoContext) => SessionData | null;
  getPermissions: (context: HonoContext) => {
    mode: Role;
    can_manage_enforcement: boolean;
    can_manage_settings: boolean;
  };
}

const SESSION_COOKIE = 'crowdsec_web_ui_session';
const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 30;
const OIDC_SESSION_LIFETIME_SECONDS = 60 * 60 * 24;
const SESSION_REFRESH_AFTER_SECONDS = 60 * 60 * 24;
const CHALLENGE_COOKIE = 'crowdsec_web_ui_webauthn_challenge';
const TOTP_SETUP_COOKIE = 'crowdsec_web_ui_totp_setup';
const OIDC_STATE_COOKIE = 'crowdsec_web_ui_oidc_state';
const OIDC_NONCE_COOKIE = 'crowdsec_web_ui_oidc_nonce';
const OIDC_REDIRECT_COOKIE = 'crowdsec_web_ui_oidc_redirect_uri';
const DUMMY_PASSWORD_HASH_PROMISE = hashPassword('timing-safe-dummy-password-pad');
const ENCRYPTED_SECRET_PREFIX = 'enc:v1:';
const TOTP_EPOCH_TOLERANCE_SECONDS = 30;
const TOTP_CODE_PATTERN = /^\d{6}$/;
const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const AUTH_RATE_LIMIT_BLOCK_MS = 15 * 60 * 1000;
const PASSWORD_MAX_FAILURES = 10;
const TOTP_MAX_FAILURES = 5;
const MAX_AUTH_FAILURE_BUCKETS = 10_000;
const MAX_CONCURRENT_PASSWORD_VERIFICATIONS = 8;

interface AuthFailureBucket {
  failures: number;
  firstFailureAt: number;
  blockedUntil: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function fromBase64url(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

function toPlainUint8Array(buffer: Buffer): Uint8Array<ArrayBuffer> {
  const arrayBuffer = new ArrayBuffer(buffer.byteLength);
  const view = new Uint8Array(arrayBuffer);
  view.set(buffer);
  return view;
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options?: crypto.ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options || {}, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey as Buffer);
    });
  });
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getCookiePath(basePath: string): string {
  return basePath || '/';
}

function getPublicOrigin(context: Context): string {
  const forwardedHost = context.req.header('x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwardedHost || context.req.header('host');
  const forwardedProto = context.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const url = new URL(context.req.url);
  const protocol = forwardedProto || url.protocol.replace(/:$/, '');
  return host ? `${protocol}://${host}` : url.origin;
}

function isSecureRequest(context: Context): boolean {
  return getPublicOrigin(context).startsWith('https://');
}

function isOidcOnlyAccount(user: AuthUserRow | null): boolean {
  return Boolean(user && user.auth_provider === 'oidc' && !user.password_hash);
}

function readClaimGroups(claims: Record<string, unknown>, claimName: string): string[] {
  const value = claims[claimName];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  if (typeof value === 'string') {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function parseCsvList(value: string | undefined): string[] {
  if (!value) return [];
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return Array.from(new Set(entries));
}

function formatCsvList(value: string | undefined): string {
  return parseCsvList(value).join(',');
}

export function resolveOidcRole(config: OidcRoleConfig, groups: string[]): Role | null {
  const groupSet = new Set(groups);
  if (config.oidcAdminGroups.some((group) => groupSet.has(group))) return 'admin';
  if (config.oidcReadOnlyGroups.some((group) => groupSet.has(group))) return 'read-only';
  if (config.oidcUnmatchedRole === 'deny') return null;
  return config.oidcUnmatchedRole;
}

export function resolveOidcClaims(
  idClaims: Record<string, unknown>,
  userinfo: Record<string, unknown> | undefined,
  config: OidcRoleConfig & { oidcGroupsClaim: string },
): { username: string; role: Role | null } | null {
  const merged = { ...idClaims, ...(userinfo ?? {}) };
  const username = (
    (typeof merged.preferred_username === 'string' && merged.preferred_username) ||
    (typeof merged.email === 'string' && merged.email) ||
    (typeof merged.sub === 'string' && merged.sub) ||
    ''
  ).trim().slice(0, 254);
  if (!username) return null;

  const groups = Array.from(new Set([
    ...readClaimGroups(idClaims, config.oidcGroupsClaim),
    ...readClaimGroups(userinfo ?? {}, config.oidcGroupsClaim),
  ]));

  return { username, role: resolveOidcRole(config, groups) };
}

function encryptSecret(value: string, secret: string): string {
  const key = crypto.createHash('sha256').update(secret, 'utf8').digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${ENCRYPTED_SECRET_PREFIX}${JSON.stringify({
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: encrypted.toString('base64url'),
  })}`;
}

function decryptSecret(value: string, secret: string): string {
  if (!value.startsWith(ENCRYPTED_SECRET_PREFIX)) return value;
  const key = crypto.createHash('sha256').update(secret, 'utf8').digest();
  const envelope = JSON.parse(value.slice(ENCRYPTED_SECRET_PREFIX.length)) as { iv?: string; tag?: string; data?: string };
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(envelope.iv || ''), 'base64url'));
  decipher.setAuthTag(Buffer.from(String(envelope.tag || ''), 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(String(envelope.data || ''), 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function readAuthSetting(database: CrowdsecDatabase, key: MutableAuthSettingKey): string | undefined {
  const value = database.getMeta(`auth_${key}`)?.value;
  return value === undefined || value === null ? undefined : value;
}

function writeAuthSetting(database: CrowdsecDatabase, key: MutableAuthSettingKey, value: string): void {
  database.setMeta(`auth_${key}`, value);
}

function validatePassword(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (!/[a-z]/.test(password)) return 'Password must contain a lowercase letter';
  if (!/[A-Z]/.test(password)) return 'Password must contain an uppercase letter';
  if (!/\d/.test(password)) return 'Password must contain a digit';
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt, 64) as Buffer;
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const parts = hash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, expected] = parts;
  const key = await scryptAsync(password, fromBase64url(salt), 64, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  }) as Buffer;
  const expectedKey = fromBase64url(expected);
  return key.length === expectedKey.length && crypto.timingSafeEqual(key, expectedKey);
}

function normalizeTotpCode(value: string): string {
  return value.replace(/\s+/g, '');
}

function isTotpCodeFormatValid(value: string): boolean {
  return TOTP_CODE_PATTERN.test(value);
}

async function verifyTotpCode(token: string, secret: string): Promise<{ valid: boolean; timeStep: number | null }> {
  if (!isTotpCodeFormatValid(token)) return { valid: false, timeStep: null };
  try {
    const verification = await verify({ token, secret, epochTolerance: TOTP_EPOCH_TOLERANCE_SECONDS });
    const timeStep = verification.valid ? (verification as { timeStep?: unknown }).timeStep : null;
    return {
      valid: verification.valid,
      timeStep: typeof timeStep === 'number' ? timeStep : null,
    };
  } catch {
    return { valid: false, timeStep: null };
  }
}

function signShortValue(value: string, secret: string): string {
  const signature = crypto.createHmac('sha256', secret).update(value).digest('base64url');
  return `${value}.${signature}`;
}

function verifyShortValue(token: string | undefined, secret: string): string | null {
  if (!token) return null;
  const separatorIndex = token.lastIndexOf('.');
  if (separatorIndex <= 0) return null;
  const value = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);
  const expectedSignature = crypto.createHmac('sha256', secret).update(value).digest('base64url');
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }
  return value;
}

function resolveSessionSecret(database: CrowdsecDatabase, configuredSecret?: string): string {
  if (configuredSecret) return configuredSecret;
  const existing = database.getMeta('auth_session_secret')?.value;
  if (existing) return existing;
  const generated = crypto.randomBytes(32).toString('base64url');
  database.setMeta('auth_session_secret', generated);
  return generated;
}

function getAccountAttemptKey(username: string): string {
  return username.trim().toLowerCase().slice(0, 254);
}

function pruneAuthFailureBuckets(buckets: Map<string, AuthFailureBucket>, now = Date.now()): void {
  for (const [key, bucket] of buckets) {
    if (bucket.blockedUntil <= now && now - bucket.firstFailureAt > AUTH_RATE_LIMIT_WINDOW_MS) {
      buckets.delete(key);
    }
  }
  while (buckets.size >= MAX_AUTH_FAILURE_BUCKETS) {
    const oldestUnblocked = Array.from(buckets).find(([, bucket]) => bucket.blockedUntil <= now)?.[0];
    if (!oldestUnblocked) break;
    buckets.delete(oldestUnblocked);
  }
}

function getAuthThrottleRetryAfter(buckets: Map<string, AuthFailureBucket>, key: string, now = Date.now()): number | null {
  const bucket = buckets.get(key);
  if (!bucket) return null;
  if (bucket.blockedUntil > now) return Math.ceil((bucket.blockedUntil - now) / 1000);
  if (now - bucket.firstFailureAt > AUTH_RATE_LIMIT_WINDOW_MS) {
    buckets.delete(key);
  }
  return null;
}

function recordAuthFailure(
  buckets: Map<string, AuthFailureBucket>,
  key: string,
  maxFailures: number,
  now = Date.now(),
): number | null {
  pruneAuthFailureBuckets(buckets, now);
  const current = buckets.get(key);
  if (!current && buckets.size >= MAX_AUTH_FAILURE_BUCKETS) {
    return null;
  }
  const bucket = current && now - current.firstFailureAt <= AUTH_RATE_LIMIT_WINDOW_MS
    ? current
    : { failures: 0, firstFailureAt: now, blockedUntil: 0 };

  bucket.failures += 1;
  if (bucket.failures >= maxFailures) {
    bucket.failures = 0;
    bucket.firstFailureAt = now;
    bucket.blockedUntil = now + AUTH_RATE_LIMIT_BLOCK_MS;
  }
  buckets.set(key, bucket);
  return getAuthThrottleRetryAfter(buckets, key, now);
}

function clearAuthFailures(buckets: Map<string, AuthFailureBucket>, key: string): void {
  buckets.delete(key);
}

function signSession(payload: Record<string, unknown>, secret: string): string {
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

function verifySessionToken(token: string, secret: string): (SessionData & { sessionVersion: number; issuedAt: number }) | null {
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) return null;
  const expectedSignature = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(fromBase64url(encodedPayload).toString('utf8')) as Partial<SessionData> & {
      exp?: number;
      iat?: number;
      sessionVersion?: number;
    };
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof payload.userId !== 'number' || typeof payload.username !== 'string') return null;
    const role: Role = payload.role === 'read-only' ? 'read-only' : 'admin';
    const authMethod = payload.authMethod === 'password' || payload.authMethod === 'passkey' || payload.authMethod === 'oidc'
      ? payload.authMethod
      : undefined;
    const sessionVersion = Number.isInteger(payload.sessionVersion) && Number(payload.sessionVersion) > 0
      ? Number(payload.sessionVersion)
      : 1;
    const issuedAt = Number.isInteger(payload.iat) && Number(payload.iat) > 0 ? Number(payload.iat) : 0;
    return { userId: payload.userId, username: payload.username, role, authMethod, sessionVersion, issuedAt };
  } catch {
    return null;
  }
}

async function createRegistrationOptions(
  user: SessionData,
  database: CrowdsecDatabase,
  rpID: string,
) {
  const existingCredentials = database.listWebAuthnCredentialsByUser(user.userId);
  return generateRegistrationOptions({
    rpName: 'CrowdSec Web UI',
    rpID,
    userName: user.username,
    userDisplayName: user.username,
    userID: new TextEncoder().encode(String(user.userId)),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    excludeCredentials: existingCredentials.map((credential) => ({ id: credential.credential_id })),
  });
}

async function verifyRegistration(
  credential: unknown,
  expectedChallenge: string,
  expectedOrigin: string,
  rpID: string,
): Promise<VerifiedRegistrationResponse> {
  return verifyRegistrationResponse({
    response: credential as Parameters<typeof verifyRegistrationResponse>[0]['response'],
    expectedChallenge,
    expectedRPID: rpID,
    expectedOrigin,
  });
}

async function createAuthenticationOptions(database: CrowdsecDatabase, username: string | undefined, rpID: string) {
  let credentials: Array<{ credential_id: string }> = [];
  if (username) {
    const user = database.getAuthUserByUsername(username);
    if (user) {
      credentials = database.listWebAuthnCredentialsByUser(user.id);
    }
  }

  return generateAuthenticationOptions({
    rpID,
    allowCredentials: credentials.length > 0
      ? credentials.map((credential) => ({ id: credential.credential_id }))
      : undefined,
    userVerification: 'preferred',
  });
}

async function verifyAuthentication(
  credential: unknown,
  expectedChallenge: string,
  expectedOrigin: string,
  rpID: string,
  storedCredential: {
    credentialId: string;
    publicKey: string;
    signCount: number;
  },
): Promise<VerifiedAuthenticationResponse> {
  return verifyAuthenticationResponse({
    response: credential as Parameters<typeof verifyAuthenticationResponse>[0]['response'],
    expectedChallenge,
    expectedRPID: rpID,
    expectedOrigin,
    credential: {
      id: storedCredential.credentialId,
      publicKey: toPlainUint8Array(fromBase64url(storedCredential.publicKey)),
      counter: storedCredential.signCount,
    },
  });
}

class OidcRuntime {
  private configuration: oidcClient.Configuration | null = null;
  private cacheKey = '';

  constructor(private readonly getConfig: () => EffectiveAuthConfig) {}

  get enabled(): boolean {
    const config = this.getConfig();
    return Boolean(config.oidcIssuerUrl && config.oidcClientId);
  }

  async getConfiguration(): Promise<oidcClient.Configuration> {
    const config = this.getConfig();
    if (!this.enabled) {
      throw new Error('OIDC is not configured');
    }
    const nextCacheKey = `${config.oidcIssuerUrl || ''}\n${config.oidcClientId || ''}\n${config.oidcClientSecret || ''}`;
    if (!this.configuration || this.cacheKey !== nextCacheKey) {
      this.configuration = await oidcClient.discovery(
        new URL(config.oidcIssuerUrl!),
        config.oidcClientId!,
        config.oidcClientSecret || undefined,
      );
      this.cacheKey = nextCacheKey;
    }
    return this.configuration;
  }

  async authorizationUrl(state: string, nonce: string, redirectUri: string): Promise<string> {
    const configuration = await this.getConfiguration();
    const config = this.getConfig();
    const authorizationEndpoint = configuration.serverMetadata().authorization_endpoint;
    if (!authorizationEndpoint) {
      throw new Error('OIDC provider has no authorization endpoint');
    }

    const params = new URLSearchParams({
      client_id: config.oidcClientId!,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: config.oidcScope,
      state,
      nonce,
    });
    return `${authorizationEndpoint}?${params.toString()}`;
  }

  async handleCallback(currentUrl: URL, expectedNonce?: string, expectedState?: string): Promise<{
    username: string;
    role: Role | null;
    issuer: string;
    subject: string;
  } | null> {
    const configuration = await this.getConfiguration();
    const config = this.getConfig();
    const tokens = await oidcClient.authorizationCodeGrant(configuration, currentUrl, {
      expectedNonce,
      expectedState,
    });
    const idClaims = tokens.claims() as Record<string, unknown> | undefined;
    if (!idClaims) return null;
    const issuer = typeof idClaims.iss === 'string' ? idClaims.iss : '';
    const subject = typeof idClaims.sub === 'string' ? idClaims.sub : '';
    if (!issuer || !subject) return null;

    const userinfo = await this.fetchUserInfoClaims(configuration, tokens.access_token, subject);
    const resolved = resolveOidcClaims(idClaims, userinfo, config);
    if (!resolved) return null;

    return {
      username: resolved.username,
      role: resolved.role,
      issuer,
      subject,
    };
  }

  private async fetchUserInfoClaims(
    configuration: oidcClient.Configuration,
    accessToken: string | undefined,
    subject: string,
  ): Promise<Record<string, unknown> | undefined> {
    if (!configuration.serverMetadata().userinfo_endpoint) return undefined;
    if (typeof accessToken !== 'string' || !accessToken) return undefined;
    try {
      const userinfo = await oidcClient.fetchUserInfo(configuration, accessToken, subject);
      return userinfo as Record<string, unknown>;
    } catch (error) {
      console.warn('OIDC UserInfo fetch failed; falling back to ID token claims:', error);
      return undefined;
    }
  }
}

export function createDashboardAuth(options: {
  config: DashboardAuthConfig;
  database: CrowdsecDatabase;
  basePath: string;
  instanceReadOnly: boolean;
  writeDatabase?: DatabaseWrite;
}): DashboardAuth {
  const { config, database, basePath, instanceReadOnly } = options;
  const enabled = config.enabled ?? !database.isAuthMigrationDefaultDisabled();
  const cookiePath = getCookiePath(basePath);
  const sessionSecret = resolveSessionSecret(database, config.sessionSecret);
  const persistedSessionSecret = database.getMeta('auth_session_secret')?.value;
  const totpSecretEncryptionSecret = config.sessionSecret || sessionSecret;
  const passwordAccountFailureBuckets = new Map<string, AuthFailureBucket>();
  const totpFailureBuckets = new Map<string, AuthFailureBucket>();
  const writeDatabase: DatabaseWrite = options.writeDatabase
    ?? (async (operation) => operation());
  let activePasswordVerifications = 0;

  function getEffectiveConfig(): EffectiveAuthConfig {
    const encryptedClientSecret = readAuthSetting(database, 'oidc_client_secret');
    const oidcClientSecret = encryptedClientSecret === undefined
      ? config.oidcClientSecret
      : encryptedClientSecret
        ? decryptSecret(encryptedClientSecret, sessionSecret)
        : undefined;

    return {
      oidcIssuerUrl: readAuthSetting(database, 'oidc_issuer_url') ?? config.oidcIssuerUrl,
      oidcClientId: readAuthSetting(database, 'oidc_client_id') ?? config.oidcClientId,
      oidcClientSecret,
      oidcScope: readAuthSetting(database, 'oidc_scope')?.trim() || config.oidcScope,
      oidcGroupsClaim: readAuthSetting(database, 'oidc_groups_claim') || config.oidcGroupsClaim || 'groups',
      oidcAdminGroups: parseCsvList(readAuthSetting(database, 'oidc_admin_groups') ?? config.oidcAdminGroups.join(',')),
      oidcReadOnlyGroups: parseCsvList(readAuthSetting(database, 'oidc_read_only_groups') ?? config.oidcReadOnlyGroups.join(',')),
      oidcUnmatchedRole: parseOidcUnmatchedRole(readAuthSetting(database, 'oidc_unmatched_role') ?? config.oidcUnmatchedRole),
    };
  }

  function isPasswordLoginDisabled(): boolean {
    return readAuthSetting(database, 'disable_password_login') === 'true';
  }

  function persistAuthSetting(key: MutableAuthSettingKey, value: string): Promise<void> {
    return writeDatabase(() => writeAuthSetting(database, key, value));
  }

  const oidc = new OidcRuntime(getEffectiveConfig);

  function decryptTotpSecret(value: string): string {
    const candidateSecrets = Array.from(new Set([
      totpSecretEncryptionSecret,
      persistedSessionSecret,
    ].filter((secret): secret is string => Boolean(secret))));

    let lastError: unknown;
    for (const secret of candidateSecrets) {
      try {
        return decryptSecret(value, secret);
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    return decryptSecret(value, sessionSecret);
  }

  function authThrottleResponse(context: HonoContext, retryAfterSeconds: number): Response {
    context.header('Retry-After', String(retryAfterSeconds));
    return context.json({ error: 'Too many authentication attempts. Try again later.' }, 429);
  }

  function createSession(
    context: HonoContext,
    user: AuthUserRow | SessionData,
    authMethod?: AuthMethod,
    authenticatedAt?: number,
  ): void {
    const now = Math.floor(Date.now() / 1000);
    const userId = 'id' in user ? user.id : user.userId;
    const persistedUser = 'id' in user ? user : database.getAuthUserById(userId);
    const effectiveAuthMethod = authMethod || ('authMethod' in user ? user.authMethod : undefined);
    const sessionLifetime = effectiveAuthMethod === 'oidc'
      ? OIDC_SESSION_LIFETIME_SECONDS
      : SESSION_LIFETIME_SECONDS;
    const absoluteStart = authenticatedAt || now;
    const token = signSession({
      userId,
      username: user.username,
      role: user.role,
      authMethod: effectiveAuthMethod,
      sessionVersion: persistedUser?.session_version || 1,
      authenticatedAt: absoluteStart,
      iat: now,
      exp: Math.min(now + sessionLifetime, absoluteStart + sessionLifetime),
    }, sessionSecret);
    setCookie(context, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: isSecureRequest(context),
      maxAge: SESSION_LIFETIME_SECONDS,
      path: cookiePath,
    });
  }

  function clearSession(context: HonoContext): void {
    deleteCookie(context, SESSION_COOKIE, { path: cookiePath });
  }

  function getSession(context: HonoContext): SessionData | null {
    if (!enabled) return { userId: 0, username: 'disabled-auth', role: 'admin' };
    const token = getCookie(context, SESSION_COOKIE);
    if (!token) return null;
    const session = verifySessionToken(token, sessionSecret);
    if (!session) return null;
    if (
      session.authMethod === 'oidc'
      && (!session.issuedAt || session.issuedAt + OIDC_SESSION_LIFETIME_SECONDS < Math.floor(Date.now() / 1000))
    ) return null;
    const user = database.getAuthUserById(session.userId);
    if (!user || (session.sessionVersion || 1) !== (user.session_version || 1)) return null;
    if (session.authMethod === 'oidc' && user.auth_provider !== 'oidc') return null;
    if (session.authMethod === 'passkey' && user.auth_provider === 'oidc' && !user.password_hash) return null;
    return {
      userId: user.id,
      username: user.username,
      role: user.role,
      authMethod: session.authMethod,
    };
  }

  function refreshSessionIfNeeded(context: HonoContext, session: SessionData): void {
    const token = getCookie(context, SESSION_COOKIE);
    if (!token) return;
    try {
      const payload = JSON.parse(fromBase64url(token.split('.')[0] || '').toString('utf8')) as {
        iat?: number;
        authenticatedAt?: number;
        authMethod?: AuthMethod;
      };
      if (!payload.iat) return;
      if (payload.authMethod === 'oidc') return;
      const age = Math.floor(Date.now() / 1000) - payload.iat;
      if (age > SESSION_REFRESH_AFTER_SECONDS) {
        createSession(context, session, undefined, payload.authenticatedAt || payload.iat);
      }
    } catch {
      // Invalid tokens are handled by getSession.
    }
  }

  function getPermissions(context: HonoContext) {
    const session = getSession(context);
    const readOnly = instanceReadOnly || session?.role === 'read-only';
    return {
      mode: readOnly ? 'read-only' as const : 'admin' as const,
      can_manage_enforcement: !readOnly,
      can_manage_settings: !readOnly,
    };
  }

  async function ensureAuth(context: HonoContext, next: HonoNext): Promise<Response | void> {
    if (!enabled) {
      await next();
      return;
    }

    const session = getSession(context);
    if (!session) {
      return context.json({ error: 'Unauthorized' }, 401);
    }

    context.set('user', session);
    refreshSessionIfNeeded(context, session);
    await next();
  }

  function setShortCookie(context: HonoContext, name: string, value: string, sameSite: 'Strict' | 'Lax' = 'Strict'): void {
    setCookie(context, name, value, {
      httpOnly: true,
      sameSite,
      secure: isSecureRequest(context),
      maxAge: 300,
      path: cookiePath,
    });
  }

  function registerRoutes(app: Hono): void {
    const auth = new Hono();

    auth.get('/status', (context) => {
      const session = getSession(context);
      const user = session ? database.getAuthUserById(session.userId) : null;
      return context.json({
        authEnabled: enabled,
        setupRequired: enabled && database.countAuthUsers() === 0,
        authenticated: !enabled || Boolean(session),
        user: enabled ? session : null,
        authMethod: enabled ? session?.authMethod ?? null : null,
        oidcEnabled: enabled && oidc.enabled,
        passwordLoginDisabled: enabled && isPasswordLoginDisabled(),
        passkeysEnabled: enabled && database.countWebAuthnCredentials() > 0,
        hasPassword: Boolean(user?.password_hash),
        totpEnabled: Boolean(user?.totp_enabled),
      });
    });

    auth.post('/setup', async (context) => {
      if (!enabled) return context.json({ error: 'Authentication is disabled' }, 400);
      if (database.countAuthUsers() > 0) return context.json({ error: 'Setup already completed' }, 400);
      const body = asObject(await context.req.json().catch(() => null));
      const username = typeof body?.username === 'string' ? body.username.trim() : '';
      const password = typeof body?.password === 'string' ? body.password : '';
      if (!username || !password) return context.json({ error: 'Username and password required' }, 400);
      if (username.length > 128 || password.length > 1024) return context.json({ error: 'Username or password is too long' }, 400);
      const passwordError = validatePassword(password);
      if (passwordError) return context.json({ error: passwordError }, 400);

      const passwordHash = await hashPassword(password);
      const user = await writeDatabase(() => {
        if (database.countAuthUsers() > 0) return null;
        const userId = database.createAuthUser({
          username,
          passwordHash,
          role: 'admin',
          authProvider: 'password',
        });
        return database.getAuthUserById(userId)!;
      });
      if (!user) return context.json({ error: 'Setup already completed' }, 400);
      createSession(context, user, 'password');
      return context.json({ status: 'ok', user: { userId: user.id, username: user.username, role: user.role } });
    });

    auth.post('/login', async (context) => {
      if (!enabled) return context.json({ error: 'Authentication is disabled' }, 400);
      if (isPasswordLoginDisabled()) return context.json({ error: 'Password login is disabled' }, 403);
      const body = asObject(await context.req.json().catch(() => null));
      const username = typeof body?.username === 'string' ? body.username.trim() : '';
      const password = typeof body?.password === 'string' ? body.password : '';
      const totpCode = typeof body?.totpCode === 'string' ? normalizeTotpCode(body.totpCode) : '';
      if (!username || !password) return context.json({ error: 'Username and password required' }, 400);
      if (username.length > 254 || password.length > 1024) return context.json({ error: 'Invalid credentials' }, 401);
      const accountAttemptKey = getAccountAttemptKey(username);
      const accountRetryAfter = getAuthThrottleRetryAfter(passwordAccountFailureBuckets, accountAttemptKey);
      if (accountRetryAfter !== null) return authThrottleResponse(context, accountRetryAfter);
      if (activePasswordVerifications >= MAX_CONCURRENT_PASSWORD_VERIFICATIONS) {
        return authThrottleResponse(context, 1);
      }

      const user = database.getAuthUserByUsername(username);
      const hashToVerify = user?.password_hash || await DUMMY_PASSWORD_HASH_PROMISE;
      activePasswordVerifications += 1;
      let valid = false;
      try {
        valid = await verifyPassword(password, hashToVerify);
      } finally {
        activePasswordVerifications -= 1;
      }
      if (!user || !user.password_hash || !valid) {
        recordAuthFailure(passwordAccountFailureBuckets, accountAttemptKey, PASSWORD_MAX_FAILURES);
        return context.json({ error: 'Invalid credentials' }, 401);
      }
      clearAuthFailures(passwordAccountFailureBuckets, accountAttemptKey);
      if (user.totp_enabled && user.totp_secret) {
        if (!totpCode) {
          return context.json({ error: 'Authenticator code required', requiresTotp: true }, 401);
        }
        const totpAttemptKey = String(user.id);
        const totpRetryAfter = getAuthThrottleRetryAfter(totpFailureBuckets, totpAttemptKey);
        if (totpRetryAfter !== null) return authThrottleResponse(context, totpRetryAfter);
        const secret = decryptTotpSecret(user.totp_secret);
        const verification = await verifyTotpCode(totpCode, secret);
        if (!verification.valid || verification.timeStep === null) {
          recordAuthFailure(totpFailureBuckets, totpAttemptKey, TOTP_MAX_FAILURES);
          return context.json({ error: 'Invalid authenticator code', requiresTotp: true }, 401);
        }
        if (!await writeDatabase(() => database.updateAuthUserTotpLastStep(user.id, verification.timeStep!))) {
          recordAuthFailure(totpFailureBuckets, totpAttemptKey, TOTP_MAX_FAILURES);
          return context.json({ error: 'Invalid authenticator code', requiresTotp: true }, 401);
        }
        clearAuthFailures(totpFailureBuckets, totpAttemptKey);
      }

      createSession(context, user, 'password');
      return context.json({ status: 'ok', user: { userId: user.id, username: user.username, role: user.role } });
    });

    auth.post('/logout', (context) => {
      clearSession(context);
      return context.json({ status: 'ok' });
    });

    auth.get('/me', (context) => {
      const session = getSession(context);
      if (!session) return context.json({ error: 'Not authenticated' }, 401);
      return context.json({ user: session });
    });

    auth.get('/settings', (context) => {
      const session = getSession(context);
      if (!session || !enabled) return context.json({ error: 'Not authenticated' }, 401);
      const effectiveConfig = getEffectiveConfig();
      const user = database.getAuthUserById(session.userId);
      return context.json({
        disablePasswordLogin: isPasswordLoginDisabled(),
        oidcIssuerUrl: effectiveConfig.oidcIssuerUrl || '',
        oidcClientId: effectiveConfig.oidcClientId || '',
        hasOidcClientSecret: Boolean(effectiveConfig.oidcClientSecret),
        oidcScope: effectiveConfig.oidcScope,
        oidcGroupsClaim: effectiveConfig.oidcGroupsClaim,
        oidcAdminGroups: effectiveConfig.oidcAdminGroups.join(','),
        oidcReadOnlyGroups: effectiveConfig.oidcReadOnlyGroups.join(','),
        oidcUnmatchedRole: effectiveConfig.oidcUnmatchedRole,
        hasPassword: Boolean(user?.password_hash),
        passkeysAvailable: !isOidcOnlyAccount(user),
        totpEnabled: Boolean(user?.totp_enabled),
        authMethod: session.authMethod ?? null,
      });
    });

    auth.put('/settings', async (context) => {
      const session = getSession(context);
      if (!session || !enabled) return context.json({ error: 'Not authenticated' }, 401);
      if (session.role !== 'admin' || instanceReadOnly) return context.json({ error: 'Read-only mode is enabled', code: 'READ_ONLY' }, 403);
      const body = asObject(await context.req.json().catch(() => null));
      if (!body) return context.json({ error: 'Invalid request body' }, 400);

      if ('disablePasswordLogin' in body) {
        const nextDisabled = body.disablePasswordLogin === true;
        if (nextDisabled) {
          const hasPasskeys = database.countWebAuthnCredentials() > 0;
          const effectiveConfig = getEffectiveConfig();
          const hasOidc = Boolean(effectiveConfig.oidcIssuerUrl && effectiveConfig.oidcClientId);
          if (!hasPasskeys && !hasOidc) {
            return context.json({ error: 'Register a passkey or configure OIDC before disabling password login' }, 400);
          }
        }
        await persistAuthSetting('disable_password_login', nextDisabled ? 'true' : 'false');
      }

      if ('oidcGroupsClaim' in body) {
        const groupsClaim = typeof body.oidcGroupsClaim === 'string' && body.oidcGroupsClaim.trim()
          ? body.oidcGroupsClaim.trim()
          : 'groups';
        await persistAuthSetting('oidc_groups_claim', groupsClaim);
      }

      if ('oidcScope' in body) {
        let scope: string;
        try {
          const scopeInput = typeof body.oidcScope === 'string' && body.oidcScope.trim()
            ? body.oidcScope
            : config.oidcScope;
          scope = parseOidcScope(scopeInput);
        } catch {
          return context.json({ error: 'OIDC scopes must include openid' }, 400);
        }
        await persistAuthSetting('oidc_scope', scope);
      }

      if ('oidcAdminGroups' in body) {
        const adminGroups = typeof body.oidcAdminGroups === 'string' ? formatCsvList(body.oidcAdminGroups) : '';
        await persistAuthSetting('oidc_admin_groups', adminGroups);
      }

      if ('oidcReadOnlyGroups' in body) {
        const readOnlyGroups = typeof body.oidcReadOnlyGroups === 'string' ? formatCsvList(body.oidcReadOnlyGroups) : '';
        await persistAuthSetting('oidc_read_only_groups', readOnlyGroups);
      }

      if ('oidcUnmatchedRole' in body) {
        if (typeof body.oidcUnmatchedRole !== 'string') {
          return context.json({ error: 'Invalid OIDC unmatched role' }, 400);
        }
        let unmatchedRole: OidcUnmatchedRole;
        try {
          unmatchedRole = parseOidcUnmatchedRole(body.oidcUnmatchedRole);
        } catch {
          return context.json({ error: 'Invalid OIDC unmatched role' }, 400);
        }
        await persistAuthSetting('oidc_unmatched_role', unmatchedRole);
      }

      if ('oidcIssuerUrl' in body || 'oidcClientId' in body || 'oidcClientSecret' in body) {
        const currentConfig = getEffectiveConfig();
        const issuer = typeof body.oidcIssuerUrl === 'string' ? body.oidcIssuerUrl.trim() : (currentConfig.oidcIssuerUrl || '');
        const clientId = typeof body.oidcClientId === 'string' ? body.oidcClientId.trim() : (currentConfig.oidcClientId || '');
        const clientSecretInput = typeof body.oidcClientSecret === 'string' ? body.oidcClientSecret.trim() : undefined;

        await persistAuthSetting('oidc_issuer_url', issuer);
        await persistAuthSetting('oidc_client_id', clientId);
        if (clientSecretInput !== undefined && clientSecretInput !== '') {
          await persistAuthSetting('oidc_client_secret', encryptSecret(clientSecretInput, sessionSecret));
        } else if (!issuer && !clientId) {
          await persistAuthSetting('oidc_client_secret', '');
        }

        if (issuer && clientId) {
          try {
            await oidc.getConfiguration();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return context.json({ status: 'ok', oidcError: message });
          }
        }
      }

      const effectiveConfig = getEffectiveConfig();
      return context.json({
        status: 'ok',
        settings: {
          disablePasswordLogin: isPasswordLoginDisabled(),
          oidcIssuerUrl: effectiveConfig.oidcIssuerUrl || '',
          oidcClientId: effectiveConfig.oidcClientId || '',
          hasOidcClientSecret: Boolean(effectiveConfig.oidcClientSecret),
          oidcScope: effectiveConfig.oidcScope,
          oidcGroupsClaim: effectiveConfig.oidcGroupsClaim,
          oidcAdminGroups: effectiveConfig.oidcAdminGroups.join(','),
          oidcReadOnlyGroups: effectiveConfig.oidcReadOnlyGroups.join(','),
          oidcUnmatchedRole: effectiveConfig.oidcUnmatchedRole,
        },
      });
    });

    auth.post('/change-password', async (context) => {
      const session = getSession(context);
      if (!session || !enabled) return context.json({ error: 'Not authenticated' }, 401);
      const body = asObject(await context.req.json().catch(() => null));
      const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : '';
      const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : '';
      if (!currentPassword || !newPassword) return context.json({ error: 'Current and new password required' }, 400);
      if (session.authMethod !== 'password') {
        return context.json({ error: 'Log in with your password before changing it' }, 403);
      }

      const user = database.getAuthUserById(session.userId);
      if (!user?.password_hash) return context.json({ error: 'No password set for this account' }, 400);
      if (!await verifyPassword(currentPassword, user.password_hash)) {
        return context.json({ error: 'Current password is incorrect' }, 401);
      }
      const passwordError = validatePassword(newPassword);
      if (passwordError) return context.json({ error: passwordError }, 400);

      const passwordHash = await hashPassword(newPassword);
      await writeDatabase(() => database.updateAuthUserPassword(user.id, passwordHash));
      createSession(context, database.getAuthUserById(user.id)!, 'password');
      return context.json({ status: 'ok' });
    });

    auth.post('/totp/setup', (context) => {
      const session = getSession(context);
      if (!session || !enabled) return context.json({ error: 'Not authenticated' }, 401);
      if (session.authMethod !== 'password') {
        return context.json({ error: 'Log in with your password before setting up TOTP' }, 403);
      }

      const user = database.getAuthUserById(session.userId);
      if (!user?.password_hash) return context.json({ error: 'No password set for this account' }, 400);
      if (user.totp_enabled) return context.json({ error: 'TOTP is already enabled for this account' }, 400);
      const secret = generateSecret();
      const otpauthUrl = generateURI({
        issuer: 'CrowdSec Web UI',
        label: user.username,
        secret,
      });
      setShortCookie(context, TOTP_SETUP_COOKIE, signShortValue(secret, sessionSecret));
      return context.json({ secret, otpauthUrl });
    });

    auth.post('/totp/enable', async (context) => {
      const session = getSession(context);
      if (!session || !enabled) return context.json({ error: 'Not authenticated' }, 401);
      if (session.authMethod !== 'password') {
        return context.json({ error: 'Log in with your password before setting up TOTP' }, 403);
      }

      const body = asObject(await context.req.json().catch(() => null));
      const code = typeof body?.code === 'string' ? normalizeTotpCode(body.code) : '';
      if (!code) return context.json({ error: 'Authenticator code required' }, 400);
      if (!isTotpCodeFormatValid(code)) return context.json({ error: 'Invalid authenticator code' }, 400);
      const secret = verifyShortValue(getCookie(context, TOTP_SETUP_COOKIE), sessionSecret);
      if (!secret) return context.json({ error: 'TOTP setup expired. Start setup again.' }, 400);
      const user = database.getAuthUserById(session.userId);
      if (!user?.password_hash) return context.json({ error: 'No password set for this account' }, 400);
      if (user.totp_enabled) return context.json({ error: 'TOTP is already enabled for this account' }, 400);
      const verification = await verifyTotpCode(code, secret);
      if (!verification.valid) {
        return context.json({ error: 'Invalid authenticator code' }, 400);
      }

      await writeDatabase(() => database.updateAuthUserTotp(user.id, encryptSecret(secret, totpSecretEncryptionSecret), true));
      deleteCookie(context, TOTP_SETUP_COOKIE, { path: cookiePath });
      return context.json({ status: 'ok', totpEnabled: true });
    });

    auth.delete('/totp', async (context) => {
      const session = getSession(context);
      if (!session || !enabled) return context.json({ error: 'Not authenticated' }, 401);
      if (session.authMethod !== 'password') {
        return context.json({ error: 'Log in with your password before disabling TOTP' }, 403);
      }

      const body = asObject(await context.req.json().catch(() => null));
      const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : '';
      if (!currentPassword) return context.json({ error: 'Current password required' }, 400);
      const user = database.getAuthUserById(session.userId);
      if (!user?.password_hash) return context.json({ error: 'No password set for this account' }, 400);
      if (!user.totp_enabled || !user.totp_secret) return context.json({ error: 'TOTP is not enabled for this account' }, 400);
      if (!await verifyPassword(currentPassword, user.password_hash)) {
        return context.json({ error: 'Current password is incorrect' }, 401);
      }
      await writeDatabase(() => database.updateAuthUserTotp(user.id, null, false));
      return context.json({ status: 'ok', totpEnabled: false });
    });

    auth.get('/passkeys', (context) => {
      const session = getSession(context);
      if (!session || !enabled) return context.json({ error: 'Not authenticated' }, 401);
      const user = database.getAuthUserById(session.userId);
      if (isOidcOnlyAccount(user)) {
        return context.json({ error: 'Passkeys are unavailable for OIDC-only accounts' }, 403);
      }
      return context.json({
        passkeys: database.listWebAuthnCredentialsByUser(session.userId).map((credential) => ({
          id: credential.id,
          name: credential.name,
          createdAt: credential.created_at,
        })),
      });
    });

    auth.patch('/passkeys/:id', async (context) => {
      const session = getSession(context);
      if (!session || !enabled) return context.json({ error: 'Not authenticated' }, 401);
      const user = database.getAuthUserById(session.userId);
      if (isOidcOnlyAccount(user)) {
        return context.json({ error: 'Passkeys are unavailable for OIDC-only accounts' }, 403);
      }
      const id = Number(context.req.param('id'));
      const body = asObject(await context.req.json().catch(() => null));
      const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : null;
      if (!Number.isInteger(id) || !await writeDatabase(() => database.renameWebAuthnCredential(id, session.userId, name))) {
        return context.json({ error: 'Passkey not found' }, 404);
      }
      return context.json({ status: 'ok' });
    });

    auth.delete('/passkeys/:id', async (context) => {
      const session = getSession(context);
      if (!session || !enabled) return context.json({ error: 'Not authenticated' }, 401);
      const user = database.getAuthUserById(session.userId);
      if (isOidcOnlyAccount(user)) {
        return context.json({ error: 'Passkeys are unavailable for OIDC-only accounts' }, 403);
      }
      const id = Number(context.req.param('id'));
      if (!Number.isInteger(id) || !await writeDatabase(() => database.deleteWebAuthnCredential(id, session.userId))) {
        return context.json({ error: 'Passkey not found' }, 404);
      }
      return context.json({ status: 'ok' });
    });

    auth.post('/webauthn/register/options', async (context) => {
      const session = getSession(context);
      if (!session || !enabled) return context.json({ error: 'Not authenticated' }, 401);
      const user = database.getAuthUserById(session.userId);
      if (!user || isOidcOnlyAccount(user)) {
        return context.json({ error: 'Passkeys cannot be registered for OIDC-only accounts' }, 403);
      }
      const origin = getPublicOrigin(context);
      const options = await createRegistrationOptions(session, database, new URL(origin).hostname);
      setShortCookie(context, CHALLENGE_COOKIE, options.challenge);
      return context.json(options);
    });

    auth.post('/webauthn/register/verify', async (context) => {
      const session = getSession(context);
      if (!session || !enabled) return context.json({ error: 'Not authenticated' }, 401);
      const user = database.getAuthUserById(session.userId);
      if (!user || isOidcOnlyAccount(user)) {
        return context.json({ error: 'Passkeys cannot be registered for OIDC-only accounts' }, 403);
      }
      const body = asObject(await context.req.json().catch(() => null));
      const challenge = getCookie(context, CHALLENGE_COOKIE);
      if (!body || !challenge) return context.json({ error: 'No registration challenge found' }, 400);

      try {
        const origin = getPublicOrigin(context);
        const verification = await verifyRegistration(body, challenge, origin, new URL(origin).hostname);
        if (!verification.verified || !verification.registrationInfo) {
          return context.json({ error: 'Verification failed' }, 400);
        }

        const credential = verification.registrationInfo.credential;
        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : null;
        await writeDatabase(() => database.createWebAuthnCredential({
          userId: session.userId,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString('base64url'),
          signCount: credential.counter,
          transports: JSON.stringify((body.response as { transports?: unknown[] } | undefined)?.transports || []),
          name,
        }));
        deleteCookie(context, CHALLENGE_COOKIE, { path: cookiePath });
        return context.json({ status: 'ok' });
      } catch (error) {
        console.error('WebAuthn registration error:', error);
        return context.json({ error: 'Verification failed' }, 400);
      }
    });

    auth.post('/webauthn/login/options', async (context) => {
      if (!enabled) return context.json({ error: 'Authentication is disabled' }, 400);
      const body = asObject(await context.req.json().catch(() => null));
      const username = typeof body?.username === 'string' ? body.username.trim() : undefined;
      const origin = getPublicOrigin(context);
      const options = await createAuthenticationOptions(database, username, new URL(origin).hostname);
      setShortCookie(context, CHALLENGE_COOKIE, options.challenge);
      return context.json(options);
    });

    auth.post('/webauthn/login/verify', async (context) => {
      if (!enabled) return context.json({ error: 'Authentication is disabled' }, 400);
      const body = asObject(await context.req.json().catch(() => null));
      const challenge = getCookie(context, CHALLENGE_COOKIE);
      const credentialId = typeof body?.id === 'string' ? body.id : '';
      const credential = credentialId ? database.getWebAuthnCredentialByCredentialId(credentialId) : null;
      if (!body || !challenge || !credential) return context.json({ error: 'Credential not found' }, 400);
      const user = database.getAuthUserById(credential.user_id);
      if (!user) return context.json({ error: 'User not found' }, 400);
      if (isOidcOnlyAccount(user)) {
        return context.json({ error: 'This passkey belongs to an OIDC-only account. Sign in with SSO instead.' }, 403);
      }

      try {
        const origin = getPublicOrigin(context);
        const verification = await verifyAuthentication(body, challenge, origin, new URL(origin).hostname, {
          credentialId: credential.credential_id,
          publicKey: credential.public_key,
          signCount: credential.sign_count,
        });
        if (!verification.verified) return context.json({ error: 'Verification failed' }, 400);
        await writeDatabase(() => database.updateWebAuthnCredentialCounter(credential.id, verification.authenticationInfo.newCounter));
        createSession(context, user, 'passkey');
        deleteCookie(context, CHALLENGE_COOKIE, { path: cookiePath });
        return context.json({ status: 'ok', user: { userId: user.id, username: user.username, role: user.role } });
      } catch (error) {
        console.error('WebAuthn authentication error:', error);
        return context.json({ error: 'Verification failed' }, 400);
      }
    });

    auth.get('/oidc/login', async (context) => {
      if (!enabled || !oidc.enabled) return context.json({ error: 'OIDC not configured' }, 400);
      const origin = getPublicOrigin(context);
      const redirectUri = `${origin}${basePath}/api/auth/oidc/callback`;
      const state = crypto.randomUUID();
      const nonce = crypto.randomUUID();
      setShortCookie(context, OIDC_STATE_COOKIE, state, 'Lax');
      setShortCookie(context, OIDC_NONCE_COOKIE, nonce, 'Lax');
      setShortCookie(context, OIDC_REDIRECT_COOKIE, redirectUri, 'Lax');
      return context.redirect(await oidc.authorizationUrl(state, nonce, redirectUri));
    });

    auth.get('/oidc/callback', async (context) => {
      if (!enabled || !oidc.enabled) return context.json({ error: 'OIDC not configured' }, 400);
      const nonce = getCookie(context, OIDC_NONCE_COOKIE);
      const state = getCookie(context, OIDC_STATE_COOKIE);
      const redirectUri = getCookie(context, OIDC_REDIRECT_COOKIE);

      try {
        const internalUrl = new URL(context.req.url);
        const callbackUrl = redirectUri ? new URL(redirectUri) : new URL(`${getPublicOrigin(context)}${basePath}/api/auth/oidc/callback`);
        callbackUrl.search = internalUrl.search;
        const result = await oidc.handleCallback(callbackUrl, nonce, state);
        if (!result) return context.json({ error: 'OIDC authentication failed' }, 400);
        if (!result.role) return context.json({ error: 'OIDC user is not authorized' }, 403);
        const oidcUser: OidcUserUpsertParams = {
          username: result.username,
          role: result.role,
          issuer: result.issuer,
          subject: result.subject,
        };
        const user = await writeDatabase(() => database.upsertOidcUser(oidcUser));
        createSession(context, user, 'oidc');
        deleteCookie(context, OIDC_STATE_COOKIE, { path: cookiePath });
        deleteCookie(context, OIDC_NONCE_COOKIE, { path: cookiePath });
        deleteCookie(context, OIDC_REDIRECT_COOKIE, { path: cookiePath });
        return context.redirect(`${getPublicOrigin(context)}${basePath || '/'}`);
      } catch (error) {
        console.error('OIDC callback error:', error);
        return context.json({ error: 'OIDC authentication failed' }, 400);
      }
    });

    app.route(`${basePath}/api/auth`, auth);
  }

  return {
    enabled,
    oidcEnabled: oidc.enabled,
    ensureAuth,
    registerRoutes,
    getSession,
    getPermissions,
  };
}
