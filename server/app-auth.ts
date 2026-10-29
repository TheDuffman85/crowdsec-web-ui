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
import * as jose from 'jose';
import {
  OIDC_SETTING_PATHS,
  parseOidcScope,
  parseOidcUnmatchedRole,
  resolveManagedSettingSource,
  type ConfigEnvironmentOverride,
  type DashboardAuthConfig,
  type OidcSetting,
  type OidcUnmatchedRole,
} from './config';
import type { ManagedSettingSource } from '../shared/contracts';
import { getAppName } from './branding';
import {
  CrowdsecDatabase,
  INITIAL_OIDC_LOGOUT_VERSION,
  OIDC_END_SESSION_LEGACY_DEFAULT_KEY,
  type AuthUserRow,
  type OidcUserUpsertParams,
} from './database';
import type { DatabaseWrite } from './sync-worker-client';
import type { AuditEvent } from './audit-log';

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
  | 'oidc_unmatched_role'
  | 'oidc_end_session'
  | 'oidc_auto_login'
  | 'oidc_backchannel_logout';

interface EffectiveAuthConfig {
  oidcIssuerUrl?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  oidcScope: string;
  oidcGroupsClaim: string;
  oidcAdminGroups: string[];
  oidcReadOnlyGroups: string[];
  oidcUnmatchedRole: OidcUnmatchedRole;
  oidcEndSession: boolean;
  oidcAutoLogin: boolean;
  oidcBackchannelLogout: boolean;
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
  /** Set while a password session waits for the password an administrator chose to be replaced. */
  passwordChangeRequired?: boolean;
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
const OIDC_ID_TOKEN_COOKIE = 'crowdsec_web_ui_oidc_id_token';
const MAX_ID_TOKEN_COOKIE_LENGTH = 3800;
const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const LOGOUT_TOKEN_MAX_AGE_SECONDS = 5 * 60;
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

function parseRole(value: unknown): Role | null {
  return value === 'admin' || value === 'read-only' ? value : null;
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

function verifySessionToken(
  token: string,
  secret: string,
): (SessionData & { sessionVersion: number; issuedAt: number; sid?: string; oidcLogoutVersion: number }) | null {
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
      sid?: unknown;
      oidcLogoutVersion?: number;
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
    const sid = typeof payload.sid === 'string' && payload.sid ? payload.sid : undefined;
    // Cookies from before back-channel logout carry no version and belong to the initial one.
    const oidcLogoutVersion = Number.isInteger(payload.oidcLogoutVersion) && Number(payload.oidcLogoutVersion) > 0
      ? Number(payload.oidcLogoutVersion)
      : INITIAL_OIDC_LOGOUT_VERSION;
    return { userId: payload.userId, username: payload.username, role, authMethod, sessionVersion, issuedAt, sid, oidcLogoutVersion };
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
    rpName: getAppName(database),
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
  private jwks: { uri: string; keySet: ReturnType<typeof jose.createRemoteJWKSet> } | null = null;

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

  /**
   * Builds the RP-Initiated Logout URL, or returns null when the provider does
   * not advertise an end_session_endpoint.
   */
  async endSessionUrl(postLogoutRedirectUri: string, idTokenHint?: string): Promise<string | null> {
    const configuration = await this.getConfiguration();
    if (!configuration.serverMetadata().end_session_endpoint) return null;
    const params: Record<string, string> = { post_logout_redirect_uri: postLogoutRedirectUri };
    if (idTokenHint) params.id_token_hint = idTokenHint;
    return oidcClient.buildEndSessionUrl(configuration, params).toString();
  }

  async handleCallback(currentUrl: URL, expectedNonce?: string, expectedState?: string): Promise<{
    username: string;
    role: Role | null;
    issuer: string;
    subject: string;
    sessionId?: string;
    idToken?: string;
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
      sessionId: typeof idClaims.sid === 'string' && idClaims.sid ? idClaims.sid : undefined,
      idToken: tokens.id_token,
    };
  }

  /**
   * Validates an OpenID Connect Back-Channel Logout token and returns the
   * identity whose sessions it ends, or null when the token is not acceptable.
   */
  async verifyLogoutToken(logoutToken: string): Promise<{
    issuer: string;
    subject?: string;
    sessionId?: string;
    tokenId: string;
    tokenExpiresAt: number;
  } | null> {
    const configuration = await this.getConfiguration();
    const config = this.getConfig();
    const metadata = configuration.serverMetadata();
    const jwksUri = metadata.jwks_uri;
    if (!jwksUri) {
      this.jwks = null;
    } else if (this.jwks?.uri !== jwksUri) {
      this.jwks = { uri: jwksUri, keySet: jose.createRemoteJWKSet(new URL(jwksUri)) };
    }
    const keySet = this.jwks?.keySet;

    try {
      const { payload } = await jose.jwtVerify(logoutToken, async (header, token) => {
        // Providers without a signing key use the client secret, as for their ID tokens.
        if (header.alg.startsWith('HS')) {
          if (!config.oidcClientSecret) throw new Error('HMAC-signed logout token, but no client secret is configured');
          return new TextEncoder().encode(config.oidcClientSecret);
        }
        if (!keySet) throw new Error('OIDC provider has no jwks_uri');
        return keySet(header, token);
      }, {
        issuer: metadata.issuer,
        audience: config.oidcClientId,
        maxTokenAge: LOGOUT_TOKEN_MAX_AGE_SECONDS,
        requiredClaims: ['iat', 'jti'],
      });

      if (!asObject(asObject(payload.events)?.[BACKCHANNEL_LOGOUT_EVENT])) throw new Error('missing back-channel logout event');
      if ('nonce' in payload) throw new Error('logout tokens must not contain a nonce');
      if (typeof payload.jti !== 'string' || !payload.jti) throw new Error('logout token has no token ID');
      const subject = typeof payload.sub === 'string' && payload.sub ? payload.sub : undefined;
      const sessionId = typeof payload.sid === 'string' && payload.sid ? payload.sid : undefined;
      if (!subject && !sessionId) throw new Error('logout token has neither sub nor sid');
      return {
        issuer: metadata.issuer,
        subject,
        sessionId,
        tokenId: payload.jti,
        // maxTokenAge accepts the boundary second; retain the replay marker through it.
        tokenExpiresAt: Math.ceil(payload.iat! + LOGOUT_TOKEN_MAX_AGE_SECONDS) + 1,
      };
    } catch (error) {
      console.warn(`Rejected OIDC back-channel logout token: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
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
  configEnvironmentOverrides?: readonly ConfigEnvironmentOverride[];
  recordAudit?: (context: HonoContext, event: AuditEvent) => void;
}): DashboardAuth {
  const { config, database, basePath, instanceReadOnly } = options;
  const enabled = config.enabled ?? !database.isAuthMigrationDefaultDisabled();
  const cookiePath = getCookiePath(basePath);
  const sessionSecret = resolveSessionSecret(database, config.sessionSecret);
  const persistedSessionSecret = database.getMeta('auth_session_secret')?.value;
  const totpSecretEncryptionSecret = config.totpSecret || config.sessionSecret || sessionSecret;
  const passwordAccountFailureBuckets = new Map<string, AuthFailureBucket>();
  const totpFailureBuckets = new Map<string, AuthFailureBucket>();
  const writeDatabase: DatabaseWrite = options.writeDatabase
    ?? (async (operation) => operation());
  let activePasswordVerifications = 0;
  const webAuthnChallenges = new Map<string, {
    challenge: string; purpose: 'register' | 'login'; userId?: number; origin: string; expiresAt: number;
  }>();

  function issueWebAuthnChallenge(context: HonoContext, challenge: string, purpose: 'register' | 'login', userId?: number): void {
    const now = Date.now();
    for (const [id, entry] of webAuthnChallenges) {
      if (entry.expiresAt <= now) webAuthnChallenges.delete(id);
    }
    // Bound anonymous challenge storage. Evicting a pending ceremony only requires retrying it.
    if (webAuthnChallenges.size >= 10_000) webAuthnChallenges.delete(webAuthnChallenges.keys().next().value!);
    const id = crypto.randomBytes(32).toString('base64url');
    webAuthnChallenges.set(id, { challenge, purpose, userId, origin: getPublicOrigin(context), expiresAt: now + 300_000 });
    setShortCookie(context, CHALLENGE_COOKIE, id);
  }

  function consumeWebAuthnChallenge(context: HonoContext, purpose: 'register' | 'login', userId?: number): string | null {
    const id = getCookie(context, CHALLENGE_COOKIE);
    const entry = id ? webAuthnChallenges.get(id) : undefined;
    if (id) webAuthnChallenges.delete(id);
    deleteCookie(context, CHALLENGE_COOKIE, { path: cookiePath });
    if (!entry || entry.expiresAt <= Date.now() || entry.purpose !== purpose
      || entry.userId !== userId || entry.origin !== getPublicOrigin(context)) return null;
    return entry.challenge;
  }

  // Whether an enabled administrator can still sign in with a passkey, leaving out one credential
  // or every credential of one account (for example one that is about to lose admin access).
  function hasAdminPasskey(exclude: { credentialId?: number; userId?: number } = {}): boolean {
    return Boolean(database.db.prepare(`
      SELECT 1 FROM webauthn_credentials c JOIN auth_users u ON u.id = c.user_id
      WHERE u.role = 'admin' AND u.disabled = 0
        AND (u.auth_provider <> 'oidc' OR (u.password_hash IS NOT NULL AND u.password_hash <> ''))
        AND c.id <> ? AND u.id <> ? LIMIT 1
    `).get(exclude.credentialId ?? -1, exclude.userId ?? -1));
  }

  // While passkeys are the only sign-in method, some administrator must keep one. A passkey of a
  // read-only user does not help, because nobody could administer the instance with it.
  function wouldLockOutAdministrators(exclude: { credentialId?: number; userId?: number }): boolean {
    return isPasswordLoginDisabled() && !oidc.enabled && !hasAdminPasskey(exclude);
  }

  const managedOidcSettings = new Set<OidcSetting>(config.managedOidcSettings);

  // Values set by the application config win over values saved in Settings.
  function readOidcSetting(setting: OidcSetting, key: MutableAuthSettingKey): string | undefined {
    return managedOidcSettings.has(setting) ? undefined : readAuthSetting(database, key);
  }

  function getEffectiveConfig(): EffectiveAuthConfig {
    const encryptedClientSecret = readOidcSetting('oidcClientSecret', 'oidc_client_secret');
    const oidcClientSecret = encryptedClientSecret === undefined
      ? config.oidcClientSecret
      : encryptedClientSecret
        ? decryptSecret(encryptedClientSecret, sessionSecret)
        : undefined;

    return {
      oidcIssuerUrl: readOidcSetting('oidcIssuerUrl', 'oidc_issuer_url') ?? config.oidcIssuerUrl,
      oidcClientId: readOidcSetting('oidcClientId', 'oidc_client_id') ?? config.oidcClientId,
      oidcClientSecret,
      oidcScope: readOidcSetting('oidcScope', 'oidc_scope')?.trim() || config.oidcScope,
      oidcGroupsClaim: readOidcSetting('oidcGroupsClaim', 'oidc_groups_claim') || config.oidcGroupsClaim || 'groups',
      oidcAdminGroups: parseCsvList(readOidcSetting('oidcAdminGroups', 'oidc_admin_groups') ?? config.oidcAdminGroups.join(',')),
      oidcReadOnlyGroups: parseCsvList(readOidcSetting('oidcReadOnlyGroups', 'oidc_read_only_groups') ?? config.oidcReadOnlyGroups.join(',')),
      oidcUnmatchedRole: parseOidcUnmatchedRole(readOidcSetting('oidcUnmatchedRole', 'oidc_unmatched_role') ?? config.oidcUnmatchedRole),
      oidcEndSession: (readOidcSetting('oidcEndSession', 'oidc_end_session') ?? String(config.oidcEndSession ?? isOidcEndSessionLegacyDefault())) === 'true',
      oidcAutoLogin: (readOidcSetting('oidcAutoLogin', 'oidc_auto_login') ?? String(config.oidcAutoLogin)) === 'true',
      oidcBackchannelLogout: (readOidcSetting('oidcBackchannelLogout', 'oidc_backchannel_logout') ?? String(config.oidcBackchannelLogout)) === 'true',
    };
  }

  // auth.passwordLogin.enabled pins the setting from deployment config; unset leaves it managed in Settings.
  const passwordLoginManaged = config.passwordLoginEnabled !== null;
  let passwordLoginFallbackWarned = false;

  // Config cannot disable password login while no other sign-in method exists, so it falls back to enabled.
  function isPasswordLoginConfigFallbackActive(): boolean {
    if (config.passwordLoginEnabled !== false) return false;
    const fallback = !oidc.enabled && !hasAdminPasskey();
    if (fallback && !passwordLoginFallbackWarned) {
      console.warn('auth.passwordLogin.enabled is false, but neither OIDC nor an administrator passkey is configured; keeping password login enabled to avoid a lockout.');
    }
    passwordLoginFallbackWarned = fallback;
    return fallback;
  }

  function isPasswordLoginDisabled(): boolean {
    if (passwordLoginManaged) return config.passwordLoginEnabled === false && !isPasswordLoginConfigFallbackActive();
    return readAuthSetting(database, 'disable_password_login') === 'true';
  }

  // Settings fields locked by the application config, with where each one is set.
  function getManagedSettings(): Record<string, ManagedSettingSource> {
    const overrides = options.configEnvironmentOverrides ?? [];
    const sources: Record<string, ManagedSettingSource> = {};
    if (passwordLoginManaged) {
      sources.disablePasswordLogin = resolveManagedSettingSource(overrides, 'auth.passwordLogin.enabled');
    }
    for (const setting of managedOidcSettings) {
      sources[setting] = resolveManagedSettingSource(overrides, OIDC_SETTING_PATHS[setting]);
    }
    return sources;
  }

  function getPasswordLoginSettings() {
    return {
      disablePasswordLogin: isPasswordLoginDisabled(),
      passwordLoginManaged,
      passwordLoginFallback: isPasswordLoginConfigFallbackActive(),
    };
  }

  // End-session used to default to on. Installs that already used OIDC before it defaulted to off keep that
  // default; it applies only while neither the application config nor Settings sets a value.
  function isOidcEndSessionLegacyDefault(): boolean {
    return database.getMeta(OIDC_END_SESSION_LEGACY_DEFAULT_KEY)?.value === 'true';
  }

  const oidc = new OidcRuntime(getEffectiveConfig);
  if (database.getMeta(OIDC_END_SESSION_LEGACY_DEFAULT_KEY)?.value === 'pending') {
    database.setMeta(OIDC_END_SESSION_LEGACY_DEFAULT_KEY, oidc.enabled ? 'true' : 'false');
  }
  let oidcAutoLoginInactiveReason: string | null = null;

  // Auto-login only applies while SSO is the sole sign-in method. A configured but inactive
  // setting is logged once per change of the reason, not on every status request.
  function isOidcAutoLoginActive(): boolean {
    if (!getEffectiveConfig().oidcAutoLogin) {
      oidcAutoLoginInactiveReason = null;
      return false;
    }
    const unmetRequirements = [
      ...(enabled ? [] : ['authentication is disabled']),
      ...(oidc.enabled ? [] : ['OIDC is not configured']),
      ...(isPasswordLoginDisabled() ? [] : ['password login is enabled']),
    ];
    const reason = unmetRequirements.length > 0 ? unmetRequirements.join(', ') : null;
    if (reason && reason !== oidcAutoLoginInactiveReason) {
      console.warn(`OIDC auto-login is enabled but inactive because ${reason}. It requires OIDC to be configured and password login to be disabled.`);
    }
    oidcAutoLoginInactiveReason = reason;
    return !reason;
  }

  function getOidcAutoLoginSettings() {
    return {
      oidcAutoLogin: getEffectiveConfig().oidcAutoLogin,
      oidcAutoLoginActive: isOidcAutoLoginActive(),
    };
  }

  function decryptTotpSecret(value: string): string {
    const candidateSecrets = Array.from(new Set([
      totpSecretEncryptionSecret,
      config.sessionSecret,
      persistedSessionSecret,
      sessionSecret,
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

  function isTotpEnabled(user: AuthUserRow | null | undefined): boolean {
    if (!user?.password_hash) return false;
    return Boolean(config.totpSeed || (user.totp_enabled && user.totp_secret));
  }

  function getTotpSeed(user: AuthUserRow): string | undefined {
    if (!user.password_hash) return undefined;
    if (user.totp_enabled && user.totp_secret) return decryptTotpSecret(user.totp_secret);
    return config.totpSeed;
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
    oidcSessionId?: string,
  ): void {
    const now = Math.floor(Date.now() / 1000);
    const userId = 'id' in user ? user.id : user.userId;
    const persistedUser = 'id' in user ? user : database.getAuthUserById(userId);
    const effectiveAuthMethod = authMethod || ('authMethod' in user ? user.authMethod : undefined);
    const sessionLifetime = effectiveAuthMethod === 'oidc'
      ? OIDC_SESSION_LIFETIME_SECONDS
      : SESSION_LIFETIME_SECONDS;
    const absoluteStart = authenticatedAt || now;
    // Without a provider session ID, back-channel logout can only match this session by its identity's version.
    const oidcLogoutVersion = effectiveAuthMethod === 'oidc' && !oidcSessionId && persistedUser?.oidc_issuer && persistedUser.oidc_subject
      ? database.getOidcLogoutVersion(persistedUser.oidc_issuer, persistedUser.oidc_subject)
      : undefined;
    const token = signSession({
      userId,
      username: user.username,
      role: user.role,
      authMethod: effectiveAuthMethod,
      sessionVersion: persistedUser?.session_version || 1,
      authenticatedAt: absoluteStart,
      ...(oidcSessionId ? { sid: oidcSessionId } : {}),
      ...(oidcLogoutVersion ? { oidcLogoutVersion } : {}),
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
    if (!user || user.disabled || (session.sessionVersion || 1) !== (user.session_version || 1)) return null;
    if (session.authMethod === 'oidc' && user.auth_provider !== 'oidc') return null;
    if (session.authMethod === 'oidc' && user.oidc_issuer) {
      if (session.sid) {
        if (database.isOidcSessionRevoked(user.oidc_issuer, session.sid)) return null;
      } else if (
        user.oidc_subject
        && session.oidcLogoutVersion !== database.getOidcLogoutVersion(user.oidc_issuer, user.oidc_subject)
      ) return null;
    }
    if (session.authMethod === 'passkey' && user.auth_provider === 'oidc' && !user.password_hash) return null;
    return {
      userId: user.id,
      username: user.username,
      role: user.role,
      authMethod: session.authMethod,
      ...(session.authMethod === 'password' && user.password_change_required ? { passwordChangeRequired: true } : {}),
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
    if (session.passwordChangeRequired) {
      return context.json({ error: 'Change your password to continue', code: 'PASSWORD_CHANGE_REQUIRED' }, 403);
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

  // Display preferences each user saves for themselves; the browser applies them after sign-in.
  function getPersonalPreferences(userId: number): { language?: string; font?: string } {
    const { language, font } = database.getUserPreferences(userId);
    return { ...(language ? { language } : {}), ...(font ? { font } : {}) };
  }

  function passwordChangeRequiredResponse(context: HonoContext): Response {
    return context.json({ error: 'Change your password to continue', code: 'PASSWORD_CHANGE_REQUIRED' }, 403);
  }

  // Returns the administrator's session, or the response that rejects the request.
  function requireAdmin(context: HonoContext, write: boolean): SessionData | Response {
    const session = getSession(context);
    if (!session || !enabled) return context.json({ error: 'Not authenticated' }, 401);
    if (session.passwordChangeRequired) return passwordChangeRequiredResponse(context);
    if (session.role !== 'admin') return context.json({ error: 'Administrator access required', code: 'FORBIDDEN' }, 403);
    if (write && instanceReadOnly) return context.json({ error: 'Read-only mode is enabled', code: 'READ_ONLY' }, 403);
    return session;
  }

  function serializeUser(user: AuthUserRow & { passkey_count?: number }, session: SessionData) {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      // Accounts that only sign in through the identity provider get their role from it on every sign-in.
      source: isOidcOnlyAccount(user) ? 'oidc' as const : 'local' as const,
      disabled: Boolean(user.disabled),
      passwordChangeRequired: Boolean(user.password_change_required),
      totpEnabled: Boolean(user.totp_enabled && user.totp_secret),
      passkeyCount: user.passkey_count ?? database.listWebAuthnCredentialsByUser(user.id).length,
      createdAt: user.created_at,
      current: user.id === session.userId,
    };
  }

  function recordUserAudit(context: HonoContext, action: AuditEvent['action'], user: Pick<AuthUserRow, 'id' | 'username'>, details: Record<string, unknown> = {}): void {
    options.recordAudit?.(context, { action, outcome: 'success', target_user_id: user.id, target_username: user.username, ...details });
  }

  function registerUserRoutes(auth: Hono): void {
    type UserMutation =
      | { error: string; status: 400 | 404 | 409 }
      | { user: AuthUserRow };

    // Looks up the account an administrator acts on and applies the rules every change shares.
    function getManagedUser(
      id: number,
      session: SessionData,
      localOnly: boolean,
      selfError = 'You cannot change your own account here',
    ): UserMutation {
      const user = Number.isInteger(id) ? database.getAuthUserById(id) : null;
      if (!user) return { error: 'User not found', status: 404 };
      if (user.id === session.userId) return { error: selfError, status: 400 };
      if (localOnly && isOidcOnlyAccount(user)) {
        return { error: 'OIDC users are managed by the identity provider', status: 400 };
      }
      return { user };
    }

    function isLastActiveAdmin(user: AuthUserRow): boolean {
      return user.role === 'admin' && !user.disabled && database.countActiveAdmins(user.id) === 0;
    }

    auth.get('/users', (context) => {
      const session = requireAdmin(context, false);
      if (session instanceof Response) return session;
      return context.json({
        users: database.listAuthUsers().map((user) => serializeUser(user, session)),
        totpManagedByConfig: Boolean(config.totpSeed),
      });
    });

    auth.post('/users', async (context) => {
      const session = requireAdmin(context, true);
      if (session instanceof Response) return session;
      const body = asObject(await context.req.json().catch(() => null));
      const username = typeof body?.username === 'string' ? body.username.trim() : '';
      const password = typeof body?.password === 'string' ? body.password : '';
      const role = parseRole(body?.role);
      if (!username || !password) return context.json({ error: 'Username and password required' }, 400);
      if (username.length > 128 || password.length > 1024) return context.json({ error: 'Username or password is too long' }, 400);
      if (!role) return context.json({ error: 'Invalid role' }, 400);
      const passwordError = validatePassword(password);
      if (passwordError) return context.json({ error: passwordError }, 400);

      const passwordHash = await hashPassword(password);
      const user = await writeDatabase(() => {
        if (database.getAuthUserByUsername(username)) return null;
        const userId = database.createAuthUser({
          username,
          passwordHash,
          role,
          authProvider: 'password',
          passwordChangeRequired: body?.requirePasswordChange !== false,
        });
        return database.getAuthUserById(userId)!;
      });
      if (!user) return context.json({ error: 'A user with this username already exists' }, 409);
      recordUserAudit(context, 'user.create', user, { target_role: user.role });
      return context.json({ status: 'ok', user: serializeUser(user, session) }, 201);
    });

    auth.patch('/users/:id', async (context) => {
      const session = requireAdmin(context, true);
      if (session instanceof Response) return session;
      const body = asObject(await context.req.json().catch(() => null));
      if (!body) return context.json({ error: 'Invalid request body' }, 400);
      const role = 'role' in body ? parseRole(body.role) : undefined;
      if (role === null) return context.json({ error: 'Invalid role' }, 400);
      if ('disabled' in body && typeof body.disabled !== 'boolean') return context.json({ error: 'Invalid disabled value' }, 400);
      const disabled = typeof body.disabled === 'boolean' ? body.disabled : undefined;

      const result = await writeDatabase((): UserMutation => {
        const managed = getManagedUser(Number(context.req.param('id')), session, true);
        if ('error' in managed) return managed;
        const { user } = managed;
        const losesAdmin = (role === 'read-only' && user.role === 'admin') || (disabled === true && user.role === 'admin');
        if (losesAdmin && isLastActiveAdmin(user)) {
          return { error: 'At least one active administrator is required', status: 400 };
        }
        if (losesAdmin && !user.disabled && wouldLockOutAdministrators({ userId: user.id })) {
          return { error: 'Enable password login or configure OIDC before removing the last administrator with a passkey', status: 400 };
        }
        database.transaction<void>(() => {
          if (role) database.updateAuthUserRole(user.id, role);
          if (disabled !== undefined) database.setAuthUserDisabled(user.id, disabled);
        })(undefined);
        return { user: database.getAuthUserById(user.id)! };
      });
      if ('error' in result) return context.json({ error: result.error }, result.status);
      const { user } = result;
      recordUserAudit(context, 'user.update', user, {
        ...(role ? { target_role: role } : {}),
        ...(disabled !== undefined ? { disabled } : {}),
      });
      return context.json({ status: 'ok', user: serializeUser(user, session) });
    });

    auth.post('/users/:id/password', async (context) => {
      const session = requireAdmin(context, true);
      if (session instanceof Response) return session;
      const body = asObject(await context.req.json().catch(() => null));
      const password = typeof body?.password === 'string' ? body.password : '';
      if (!password) return context.json({ error: 'Password required' }, 400);
      if (password.length > 1024) return context.json({ error: 'Password is too long' }, 400);
      const passwordError = validatePassword(password);
      if (passwordError) return context.json({ error: passwordError }, 400);
      const changeRequired = body?.requirePasswordChange !== false;

      const passwordHash = await hashPassword(password);
      const result = await writeDatabase((): UserMutation => {
        const managed = getManagedUser(Number(context.req.param('id')), session, true);
        if ('error' in managed) return managed;
        database.resetAuthUserPassword(managed.user.id, passwordHash, changeRequired);
        return { user: database.getAuthUserById(managed.user.id)! };
      });
      if ('error' in result) return context.json({ error: result.error }, result.status);
      const { user } = result;
      recordUserAudit(context, 'user.password-reset', user, { password_change_required: changeRequired });
      return context.json({ status: 'ok', user: serializeUser(user, session) });
    });

    auth.post('/users/:id/reset-mfa', async (context) => {
      const session = requireAdmin(context, true);
      if (session instanceof Response) return session;
      const result = await writeDatabase((): UserMutation => {
        const managed = getManagedUser(Number(context.req.param('id')), session, true);
        if ('error' in managed) return managed;
        if (managed.user.role === 'admin' && !managed.user.disabled && wouldLockOutAdministrators({ userId: managed.user.id })) {
          return { error: 'Enable password login or configure OIDC before removing the passkeys of the last administrator with one', status: 400 };
        }
        database.resetAuthUserSecondFactors(managed.user.id);
        return { user: database.getAuthUserById(managed.user.id)! };
      });
      if ('error' in result) return context.json({ error: result.error }, result.status);
      const { user } = result;
      recordUserAudit(context, 'user.mfa-reset', user);
      return context.json({ status: 'ok', user: serializeUser(user, session) });
    });

    auth.delete('/users/:id', async (context) => {
      const session = requireAdmin(context, true);
      if (session instanceof Response) return session;
      const result = await writeDatabase((): UserMutation => {
        const managed = getManagedUser(Number(context.req.param('id')), session, false, 'You cannot delete your own account');
        if ('error' in managed) return managed;
        if (isLastActiveAdmin(managed.user)) return { error: 'At least one active administrator is required', status: 400 };
        if (managed.user.role === 'admin' && !managed.user.disabled && wouldLockOutAdministrators({ userId: managed.user.id })) {
          return { error: 'Enable password login or configure OIDC before deleting the last administrator with a passkey', status: 400 };
        }
        database.deleteAuthUser(managed.user.id);
        return { user: managed.user };
      });
      if ('error' in result) return context.json({ error: result.error }, result.status);
      const { user } = result;
      recordUserAudit(context, 'user.delete', user, { target_source: isOidcOnlyAccount(user) ? 'oidc' : 'local' });
      return context.json({ status: 'ok' });
    });
  }

  function registerRoutes(app: Hono): void {
    const auth = new Hono();

    auth.get('/status', (context) => {
      const session = getSession(context);
      const user = session ? database.getAuthUserById(session.userId) : null;
      return context.json({
        authEnabled: enabled,
        // With password login disabled, the first OIDC sign-in bootstraps the instance instead.
        setupRequired: enabled && !isPasswordLoginDisabled() && database.countAuthUsers() === 0,
        authenticated: !enabled || Boolean(session),
        user: enabled ? session : null,
        authMethod: enabled ? session?.authMethod ?? null : null,
        oidcEnabled: enabled && oidc.enabled,
        oidcAutoLogin: isOidcAutoLoginActive(),
        passwordLoginDisabled: enabled && isPasswordLoginDisabled(),
        passkeysEnabled: enabled && database.countWebAuthnCredentials() > 0,
        hasPassword: Boolean(user?.password_hash),
        totpEnabled: isTotpEnabled(user),
        passwordChangeRequired: Boolean(session?.passwordChangeRequired),
        preferences: enabled && session ? getPersonalPreferences(session.userId) : null,
      });
    });

    auth.post('/setup', async (context) => {
      if (!enabled) return context.json({ error: 'Authentication is disabled' }, 400);
      if (isPasswordLoginDisabled()) return context.json({ error: 'Password login is disabled' }, 403);
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
      if (user.disabled) return context.json({ error: 'This account is disabled' }, 403);
      const totpSeed = getTotpSeed(user);
      if (totpSeed) {
        if (!totpCode) {
          return context.json({ error: 'Authenticator code required', requiresTotp: true }, 401);
        }
        const totpAttemptKey = String(user.id);
        const totpRetryAfter = getAuthThrottleRetryAfter(totpFailureBuckets, totpAttemptKey);
        if (totpRetryAfter !== null) return authThrottleResponse(context, totpRetryAfter);
        const verification = await verifyTotpCode(totpCode, totpSeed);
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

    auth.post('/logout', async (context) => {
      const session = getSession(context);
      const idToken = getCookie(context, OIDC_ID_TOKEN_COOKIE);
      clearSession(context);
      deleteCookie(context, OIDC_ID_TOKEN_COOKIE, { path: cookiePath });

      // RP-initiated logout: send SSO users to the provider so its session ends too.
      if (session?.authMethod === 'oidc' && oidc.enabled && getEffectiveConfig().oidcEndSession) {
        try {
          const redirectUrl = await oidc.endSessionUrl(`${getPublicOrigin(context)}${basePath}/login`, idToken);
          if (redirectUrl) return context.json({ status: 'ok', redirectUrl });
        } catch (error) {
          console.warn(`OIDC end-session URL could not be built; logging out locally: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

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
      const user = database.getAuthUserById(session.userId);
      const personalSettings = {
        hasPassword: Boolean(user?.password_hash),
        passkeysAvailable: !isOidcOnlyAccount(user),
        totpEnabled: isTotpEnabled(user),
        authMethod: session.authMethod ?? null,
      };
      // Only administrators see how sign-in is configured.
      if (session.role !== 'admin') return context.json(personalSettings);
      const effectiveConfig = getEffectiveConfig();
      return context.json({
        ...getPasswordLoginSettings(),
        oidcIssuerUrl: effectiveConfig.oidcIssuerUrl || '',
        oidcClientId: effectiveConfig.oidcClientId || '',
        hasOidcClientSecret: Boolean(effectiveConfig.oidcClientSecret),
        oidcScope: effectiveConfig.oidcScope,
        oidcGroupsClaim: effectiveConfig.oidcGroupsClaim,
        oidcAdminGroups: effectiveConfig.oidcAdminGroups.join(','),
        oidcReadOnlyGroups: effectiveConfig.oidcReadOnlyGroups.join(','),
        oidcUnmatchedRole: effectiveConfig.oidcUnmatchedRole,
        oidcEndSession: effectiveConfig.oidcEndSession,
        oidcBackchannelLogout: effectiveConfig.oidcBackchannelLogout,
        ...getOidcAutoLoginSettings(),
        managedSettings: getManagedSettings(),
        ...personalSettings,
      });
    });

    auth.put('/settings', async (context) => {
      const session = getSession(context);
      if (!session || !enabled) return context.json({ error: 'Not authenticated' }, 401);
      if (session.passwordChangeRequired) return passwordChangeRequiredResponse(context);
      if (session.role !== 'admin' || instanceReadOnly) return context.json({ error: 'Read-only mode is enabled', code: 'READ_ONLY' }, 403);
      const body = asObject(await context.req.json().catch(() => null));
      if (!body) return context.json({ error: 'Invalid request body' }, 400);

      if ('disablePasswordLogin' in body && passwordLoginManaged) {
        return context.json({ error: 'Password login is managed by the application configuration', code: 'MANAGED_BY_CONFIG' }, 409);
      }
      const managedFields = [...managedOidcSettings].filter((setting) => setting in body);
      if (managedFields.length > 0) {
        return context.json({
          error: `${managedFields.join(', ')} ${managedFields.length === 1 ? 'is' : 'are'} managed by the application configuration`,
          code: 'MANAGED_BY_CONFIG',
        }, 409);
      }

      const updates = new Map<MutableAuthSettingKey, string>();
      if ('disablePasswordLogin' in body) updates.set('disable_password_login', body.disablePasswordLogin === true ? 'true' : 'false');
      if ('oidcGroupsClaim' in body) updates.set('oidc_groups_claim', typeof body.oidcGroupsClaim === 'string' && body.oidcGroupsClaim.trim() ? body.oidcGroupsClaim.trim() : 'groups');
      if ('oidcScope' in body) {
        try {
          updates.set('oidc_scope', parseOidcScope(typeof body.oidcScope === 'string' && body.oidcScope.trim() ? body.oidcScope : config.oidcScope));
        } catch {
          return context.json({ error: 'OIDC scopes must include openid' }, 400);
        }
      }
      for (const [field, key] of [['oidcAdminGroups', 'oidc_admin_groups'], ['oidcReadOnlyGroups', 'oidc_read_only_groups']] as const) {
        if (field in body) updates.set(key, typeof body[field] === 'string' ? formatCsvList(body[field]) : '');
      }
      if ('oidcUnmatchedRole' in body) {
        try {
          if (typeof body.oidcUnmatchedRole !== 'string') throw new Error('Invalid role');
          updates.set('oidc_unmatched_role', parseOidcUnmatchedRole(body.oidcUnmatchedRole));
        } catch {
          return context.json({ error: 'Invalid OIDC unmatched role' }, 400);
        }
      }
      if ('oidcEndSession' in body) updates.set('oidc_end_session', body.oidcEndSession === true ? 'true' : 'false');
      if ('oidcAutoLogin' in body) updates.set('oidc_auto_login', body.oidcAutoLogin === true ? 'true' : 'false');
      if ('oidcBackchannelLogout' in body) updates.set('oidc_backchannel_logout', body.oidcBackchannelLogout === true ? 'true' : 'false');
      if (typeof body.oidcIssuerUrl === 'string') updates.set('oidc_issuer_url', body.oidcIssuerUrl.trim());
      if (typeof body.oidcClientId === 'string') updates.set('oidc_client_id', body.oidcClientId.trim());
      if (typeof body.oidcClientSecret === 'string' && body.oidcClientSecret.trim()) {
        updates.set('oidc_client_secret', encryptSecret(body.oidcClientSecret.trim(), sessionSecret));
      }
      const saved = await writeDatabase(() => {
        const current = getEffectiveConfig();
        const issuer = updates.get('oidc_issuer_url') ?? current.oidcIssuerUrl;
        const clientId = updates.get('oidc_client_id') ?? current.oidcClientId;
        const passwordDisabled = (updates.get('disable_password_login') ?? String(isPasswordLoginDisabled())) === 'true';
        if (!passwordLoginManaged && passwordDisabled && !hasAdminPasskey() && !(issuer && clientId)) return false;
        if (!issuer && !clientId && (updates.has('oidc_issuer_url') || updates.has('oidc_client_id'))) updates.set('oidc_client_secret', '');
        database.transaction<void>(() => {
          for (const [key, value] of updates) writeAuthSetting(database, key, value);
        })(undefined);
        return true;
      });
      if (!saved) return context.json({ error: 'Register a passkey for an administrator or configure OIDC before disabling password login' }, 400);
      // Log right away when this change leaves auto-login enabled but inactive.
      isOidcAutoLoginActive();
      if (updates.has('oidc_issuer_url') || updates.has('oidc_client_id') || updates.has('oidc_client_secret')) {
        if (oidc.enabled) {
          try {
            await oidc.getConfiguration();
          } catch (error) {
            return context.json({ status: 'ok', oidcError: error instanceof Error ? error.message : String(error) });
          }
        }
      }

      const effectiveConfig = getEffectiveConfig();
      return context.json({
        status: 'ok',
        settings: {
          ...getPasswordLoginSettings(),
          oidcIssuerUrl: effectiveConfig.oidcIssuerUrl || '',
          oidcClientId: effectiveConfig.oidcClientId || '',
          hasOidcClientSecret: Boolean(effectiveConfig.oidcClientSecret),
          oidcScope: effectiveConfig.oidcScope,
          oidcGroupsClaim: effectiveConfig.oidcGroupsClaim,
          oidcAdminGroups: effectiveConfig.oidcAdminGroups.join(','),
          oidcReadOnlyGroups: effectiveConfig.oidcReadOnlyGroups.join(','),
          oidcUnmatchedRole: effectiveConfig.oidcUnmatchedRole,
          oidcEndSession: effectiveConfig.oidcEndSession,
          oidcBackchannelLogout: effectiveConfig.oidcBackchannelLogout,
          ...getOidcAutoLoginSettings(),
          managedSettings: getManagedSettings(),
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
      if (newPassword === currentPassword) {
        return context.json({ error: 'New password must be different from the current password' }, 400);
      }
      const passwordError = validatePassword(newPassword);
      if (passwordError) return context.json({ error: passwordError }, 400);

      const passwordHash = await hashPassword(newPassword);
      await writeDatabase(() => database.updateAuthUserPassword(user.id, passwordHash));
      createSession(context, database.getAuthUserById(user.id)!, 'password');
      return context.json({ status: 'ok' });
    });

    registerUserRoutes(auth);

    auth.post('/totp/setup', (context) => {
      const session = getSession(context);
      if (!session || !enabled) return context.json({ error: 'Not authenticated' }, 401);
      if (session.passwordChangeRequired) return passwordChangeRequiredResponse(context);
      if (session.authMethod !== 'password') {
        return context.json({ error: 'Log in with your password before setting up TOTP' }, 403);
      }

      const user = database.getAuthUserById(session.userId);
      if (!user?.password_hash) return context.json({ error: 'No password set for this account' }, 400);
      if (isTotpEnabled(user)) return context.json({ error: 'TOTP is already enabled for this account' }, 400);
      const secret = generateSecret();
      const otpauthUrl = generateURI({
        issuer: getAppName(database),
        label: user.username,
        secret,
      });
      setShortCookie(context, TOTP_SETUP_COOKIE, signShortValue(secret, sessionSecret));
      return context.json({ secret, otpauthUrl });
    });

    auth.post('/totp/enable', async (context) => {
      const session = getSession(context);
      if (!session || !enabled) return context.json({ error: 'Not authenticated' }, 401);
      if (session.passwordChangeRequired) return passwordChangeRequiredResponse(context);
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
      if (isTotpEnabled(user)) return context.json({ error: 'TOTP is already enabled for this account' }, 400);
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
      if (session.passwordChangeRequired) return passwordChangeRequiredResponse(context);
      if (session.authMethod !== 'password') {
        return context.json({ error: 'Log in with your password before disabling TOTP' }, 403);
      }

      const body = asObject(await context.req.json().catch(() => null));
      const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : '';
      if (!currentPassword) return context.json({ error: 'Current password required' }, 400);
      const user = database.getAuthUserById(session.userId);
      if (!user?.password_hash) return context.json({ error: 'No password set for this account' }, 400);
      if (config.totpSeed) {
        return context.json({ error: 'TOTP is managed by the application configuration and cannot be disabled from Settings' }, 400);
      }
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
      if (session.passwordChangeRequired) return passwordChangeRequiredResponse(context);
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
      if (session.passwordChangeRequired) return passwordChangeRequiredResponse(context);
      const user = database.getAuthUserById(session.userId);
      if (isOidcOnlyAccount(user)) {
        return context.json({ error: 'Passkeys are unavailable for OIDC-only accounts' }, 403);
      }
      const id = Number(context.req.param('id'));
      const result = await writeDatabase(() => {
        if (!Number.isInteger(id) || !database.listWebAuthnCredentialsByUser(session.userId).some((credential) => credential.id === id)) return 'missing';
        if (session.role === 'admin' && wouldLockOutAdministrators({ credentialId: id })) return 'last';
        database.deleteWebAuthnCredential(id, session.userId);
        return 'deleted';
      });
      if (result === 'missing') return context.json({ error: 'Passkey not found' }, 404);
      if (result === 'last') return context.json({ error: 'Enable password login or configure OIDC before deleting the last administrator passkey' }, 400);
      return context.json({ status: 'ok' });
    });

    auth.post('/webauthn/register/options', async (context) => {
      const session = getSession(context);
      if (!session || !enabled) return context.json({ error: 'Not authenticated' }, 401);
      if (session.passwordChangeRequired) return passwordChangeRequiredResponse(context);
      const user = database.getAuthUserById(session.userId);
      if (!user || isOidcOnlyAccount(user)) {
        return context.json({ error: 'Passkeys cannot be registered for OIDC-only accounts' }, 403);
      }
      const origin = getPublicOrigin(context);
      const options = await createRegistrationOptions(session, database, new URL(origin).hostname);
      issueWebAuthnChallenge(context, options.challenge, 'register', session.userId);
      return context.json(options);
    });

    auth.post('/webauthn/register/verify', async (context) => {
      const session = getSession(context);
      if (!session || !enabled) return context.json({ error: 'Not authenticated' }, 401);
      if (session.passwordChangeRequired) return passwordChangeRequiredResponse(context);
      const user = database.getAuthUserById(session.userId);
      if (!user || isOidcOnlyAccount(user)) {
        return context.json({ error: 'Passkeys cannot be registered for OIDC-only accounts' }, 403);
      }
      const body = asObject(await context.req.json().catch(() => null));
      const challenge = consumeWebAuthnChallenge(context, 'register', session.userId);
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
      issueWebAuthnChallenge(context, options.challenge, 'login');
      return context.json(options);
    });

    auth.post('/webauthn/login/verify', async (context) => {
      if (!enabled) return context.json({ error: 'Authentication is disabled' }, 400);
      const body = asObject(await context.req.json().catch(() => null));
      const challenge = consumeWebAuthnChallenge(context, 'login');
      const credentialId = typeof body?.id === 'string' ? body.id : '';
      const credential = credentialId ? database.getWebAuthnCredentialByCredentialId(credentialId) : null;
      if (!body || !challenge || !credential) return context.json({ error: 'Credential not found' }, 400);
      const user = database.getAuthUserById(credential.user_id);
      if (!user) return context.json({ error: 'User not found' }, 400);
      if (user.disabled) return context.json({ error: 'This account is disabled' }, 403);
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
        createSession(context, user, 'oidc', undefined, result.sessionId);
        // Kept as id_token_hint for RP-initiated logout. Oversized tokens are
        // skipped; logout then falls back to client_id only.
        if (result.idToken && result.idToken.length <= MAX_ID_TOKEN_COOKIE_LENGTH) {
          setCookie(context, OIDC_ID_TOKEN_COOKIE, result.idToken, {
            httpOnly: true,
            sameSite: 'Lax',
            secure: isSecureRequest(context),
            maxAge: OIDC_SESSION_LIFETIME_SECONDS,
            path: cookiePath,
          });
        } else {
          deleteCookie(context, OIDC_ID_TOKEN_COOKIE, { path: cookiePath });
        }
        deleteCookie(context, OIDC_STATE_COOKIE, { path: cookiePath });
        deleteCookie(context, OIDC_NONCE_COOKIE, { path: cookiePath });
        deleteCookie(context, OIDC_REDIRECT_COOKIE, { path: cookiePath });
        return context.redirect(`${getPublicOrigin(context)}${basePath || '/'}`);
      } catch (error) {
        console.error('OIDC callback error:', error);
        return context.json({ error: 'OIDC authentication failed' }, 400);
      }
    });

    // OpenID Connect Back-Channel Logout: the provider calls this directly when an SSO session ends.
    auth.post('/oidc/backchannel-logout', async (context) => {
      context.header('Cache-Control', 'no-store');
      if (!enabled || !oidc.enabled) return context.json({ error: 'invalid_request', error_description: 'OIDC is not configured' }, 400);
      if (!getEffectiveConfig().oidcBackchannelLogout) {
        return context.json({ error: 'invalid_request', error_description: 'Back-channel logout is disabled' }, 400);
      }
      const body = await context.req.parseBody().catch(() => null);
      const logoutToken = typeof body?.logout_token === 'string' ? body.logout_token : '';
      if (!logoutToken) return context.json({ error: 'invalid_request', error_description: 'Missing logout_token' }, 400);

      let identity: Awaited<ReturnType<OidcRuntime['verifyLogoutToken']>>;
      try {
        identity = await oidc.verifyLogoutToken(logoutToken);
      } catch (error) {
        console.warn(`OIDC back-channel logout failed: ${error instanceof Error ? error.message : String(error)}`);
        return context.json({ error: 'invalid_request', error_description: 'Logout token could not be verified' }, 400);
      }
      if (!identity) return context.json({ error: 'invalid_request', error_description: 'Invalid logout token' }, 400);

      await writeDatabase(() => database.applyOidcLogout({
        ...identity,
        sessionExpiresAt: Math.floor(Date.now() / 1000) + OIDC_SESSION_LIFETIME_SECONDS,
      }));
      return context.body(null, 200);
    });

    app.route(`${basePath}/api/auth`, auth);
  }

  // Surface a config-induced password login fallback at startup instead of on the first login attempt.
  if (enabled) isPasswordLoginConfigFallbackActive();
  isOidcAutoLoginActive();

  // Without password setup, only an OIDC admin group can create the first administrator.
  if (enabled && isPasswordLoginDisabled() && database.countAuthUsers() === 0 && getEffectiveConfig().oidcAdminGroups.length === 0) {
    console.warn('Password login is disabled and no users exist, but no OIDC admin groups are configured; no one can sign in as administrator.');
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
