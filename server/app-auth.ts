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
import * as oidcClient from 'openid-client';
import type { DashboardAuthConfig } from './config';
import { CrowdsecDatabase, type AuthUserRow } from './database';

type HonoContext = any;
type HonoNext = any;
type Role = 'admin' | 'read-only';
type MutableAuthSettingKey =
  | 'disable_password_login'
  | 'oidc_issuer_url'
  | 'oidc_client_id'
  | 'oidc_client_secret'
  | 'oidc_groups_claim'
  | 'oidc_admin_groups'
  | 'oidc_read_only_groups';

interface EffectiveAuthConfig {
  oidcIssuerUrl?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  oidcGroupsClaim: string;
  oidcAdminGroups: string[];
  oidcReadOnlyGroups: string[];
}

export interface SessionData {
  userId: number;
  username: string;
  role: Role;
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
const SESSION_REFRESH_AFTER_SECONDS = 60 * 60 * 24;
const CHALLENGE_COOKIE = 'crowdsec_web_ui_webauthn_challenge';
const OIDC_STATE_COOKIE = 'crowdsec_web_ui_oidc_state';
const OIDC_NONCE_COOKIE = 'crowdsec_web_ui_oidc_nonce';
const OIDC_REDIRECT_COOKIE = 'crowdsec_web_ui_oidc_redirect_uri';
const DUMMY_PASSWORD_HASH_PROMISE = hashPassword('timing-safe-dummy-password-pad');
const ENCRYPTED_SECRET_PREFIX = 'enc:v1:';

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

function resolveOidcRole(config: EffectiveAuthConfig, groups: string[]): Role {
  const groupSet = new Set(groups);
  if (config.oidcAdminGroups.some((group) => groupSet.has(group))) return 'admin';
  if (config.oidcReadOnlyGroups.some((group) => groupSet.has(group))) return 'read-only';
  if (config.oidcAdminGroups.length > 0 || config.oidcReadOnlyGroups.length > 0) return 'read-only';
  return 'admin';
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

function resolveSessionSecret(database: CrowdsecDatabase, configuredSecret?: string): string {
  if (configuredSecret) return configuredSecret;
  const existing = database.getMeta('auth_session_secret')?.value;
  if (existing) return existing;
  const generated = crypto.randomBytes(32).toString('base64url');
  database.setMeta('auth_session_secret', generated);
  return generated;
}

function signSession(payload: Record<string, unknown>, secret: string): string {
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

function verifySessionToken(token: string, secret: string): SessionData | null {
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) return null;
  const expectedSignature = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(fromBase64url(encodedPayload).toString('utf8')) as Partial<SessionData> & { exp?: number; iat?: number };
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof payload.userId !== 'number' || typeof payload.username !== 'string') return null;
    const role: Role = payload.role === 'read-only' ? 'read-only' : 'admin';
    return { userId: payload.userId, username: payload.username, role };
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
      scope: 'openid profile email',
      state,
      nonce,
    });
    return `${authorizationEndpoint}?${params.toString()}`;
  }

  async handleCallback(currentUrl: URL, expectedNonce?: string, expectedState?: string): Promise<{ username: string; role: Role } | null> {
    const configuration = await this.getConfiguration();
    const config = this.getConfig();
    const tokens = await oidcClient.authorizationCodeGrant(configuration, currentUrl, {
      expectedNonce,
      expectedState,
    });
    const claims = tokens.claims() as Record<string, unknown> | undefined;
    if (!claims) return null;

    const username =
      (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
      (typeof claims.email === 'string' && claims.email) ||
      (typeof claims.sub === 'string' && claims.sub) ||
      '';
    if (!username) return null;

    return {
      username,
      role: resolveOidcRole(config, readClaimGroups(claims, config.oidcGroupsClaim)),
    };
  }
}

export function createDashboardAuth(options: {
  config: DashboardAuthConfig;
  database: CrowdsecDatabase;
  basePath: string;
  instanceReadOnly: boolean;
}): DashboardAuth {
  const { config, database, basePath, instanceReadOnly } = options;
  const enabled = config.enabled ?? !database.isAuthMigrationDefaultDisabled();
  const cookiePath = getCookiePath(basePath);
  const sessionSecret = resolveSessionSecret(database, config.sessionSecret);

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
      oidcGroupsClaim: readAuthSetting(database, 'oidc_groups_claim') || config.oidcGroupsClaim || 'groups',
      oidcAdminGroups: parseCsvList(readAuthSetting(database, 'oidc_admin_groups') ?? config.oidcAdminGroups.join(',')),
      oidcReadOnlyGroups: parseCsvList(readAuthSetting(database, 'oidc_read_only_groups') ?? config.oidcReadOnlyGroups.join(',')),
    };
  }

  function isPasswordLoginDisabled(): boolean {
    return readAuthSetting(database, 'disable_password_login') === 'true';
  }

  const oidc = new OidcRuntime(getEffectiveConfig);

  function createSession(context: HonoContext, user: AuthUserRow | SessionData): void {
    const now = Math.floor(Date.now() / 1000);
    const token = signSession({
      userId: 'id' in user ? user.id : user.userId,
      username: user.username,
      role: user.role,
      iat: now,
      exp: now + SESSION_LIFETIME_SECONDS,
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
    return verifySessionToken(token, sessionSecret);
  }

  function refreshSessionIfNeeded(context: HonoContext, session: SessionData): void {
    const token = getCookie(context, SESSION_COOKIE);
    if (!token) return;
    try {
      const payload = JSON.parse(fromBase64url(token.split('.')[0] || '').toString('utf8')) as { iat?: number };
      if (!payload.iat) return;
      const age = Math.floor(Date.now() / 1000) - payload.iat;
      if (age > SESSION_REFRESH_AFTER_SECONDS) {
        createSession(context, session);
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
        oidcEnabled: enabled && oidc.enabled,
        passwordLoginDisabled: enabled && isPasswordLoginDisabled(),
        passkeysEnabled: enabled && database.countWebAuthnCredentials() > 0,
        hasPassword: Boolean(user?.password_hash),
      });
    });

    auth.post('/setup', async (context) => {
      if (!enabled) return context.json({ error: 'Authentication is disabled' }, 400);
      if (database.countAuthUsers() > 0) return context.json({ error: 'Setup already completed' }, 400);
      const body = asObject(await context.req.json().catch(() => null));
      const username = typeof body?.username === 'string' ? body.username.trim() : '';
      const password = typeof body?.password === 'string' ? body.password : '';
      if (!username || !password) return context.json({ error: 'Username and password required' }, 400);
      const passwordError = validatePassword(password);
      if (passwordError) return context.json({ error: passwordError }, 400);

      const userId = database.createAuthUser({
        username,
        passwordHash: await hashPassword(password),
        role: 'admin',
        authProvider: 'password',
      });
      const user = database.getAuthUserById(userId)!;
      createSession(context, user);
      return context.json({ status: 'ok', user: { userId: user.id, username: user.username, role: user.role } });
    });

    auth.post('/login', async (context) => {
      if (!enabled) return context.json({ error: 'Authentication is disabled' }, 400);
      if (isPasswordLoginDisabled()) return context.json({ error: 'Password login is disabled' }, 403);
      const body = asObject(await context.req.json().catch(() => null));
      const username = typeof body?.username === 'string' ? body.username.trim() : '';
      const password = typeof body?.password === 'string' ? body.password : '';
      if (!username || !password) return context.json({ error: 'Username and password required' }, 400);

      const user = database.getAuthUserByUsername(username);
      const hashToVerify = user?.password_hash || await DUMMY_PASSWORD_HASH_PROMISE;
      const valid = await verifyPassword(password, hashToVerify);
      if (!user || !user.password_hash || !valid) {
        return context.json({ error: 'Invalid credentials' }, 401);
      }

      createSession(context, user);
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
        oidcGroupsClaim: effectiveConfig.oidcGroupsClaim,
        oidcAdminGroups: effectiveConfig.oidcAdminGroups.join(','),
        oidcReadOnlyGroups: effectiveConfig.oidcReadOnlyGroups.join(','),
        hasPassword: Boolean(user?.password_hash),
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
        writeAuthSetting(database, 'disable_password_login', nextDisabled ? 'true' : 'false');
      }

      if ('oidcGroupsClaim' in body) {
        const groupsClaim = typeof body.oidcGroupsClaim === 'string' && body.oidcGroupsClaim.trim()
          ? body.oidcGroupsClaim.trim()
          : 'groups';
        writeAuthSetting(database, 'oidc_groups_claim', groupsClaim);
      }

      if ('oidcAdminGroups' in body) {
        const adminGroups = typeof body.oidcAdminGroups === 'string' ? formatCsvList(body.oidcAdminGroups) : '';
        writeAuthSetting(database, 'oidc_admin_groups', adminGroups);
      }

      if ('oidcReadOnlyGroups' in body) {
        const readOnlyGroups = typeof body.oidcReadOnlyGroups === 'string' ? formatCsvList(body.oidcReadOnlyGroups) : '';
        writeAuthSetting(database, 'oidc_read_only_groups', readOnlyGroups);
      }

      if ('oidcIssuerUrl' in body || 'oidcClientId' in body || 'oidcClientSecret' in body) {
        const currentConfig = getEffectiveConfig();
        const issuer = typeof body.oidcIssuerUrl === 'string' ? body.oidcIssuerUrl.trim() : (currentConfig.oidcIssuerUrl || '');
        const clientId = typeof body.oidcClientId === 'string' ? body.oidcClientId.trim() : (currentConfig.oidcClientId || '');
        const clientSecretInput = typeof body.oidcClientSecret === 'string' ? body.oidcClientSecret.trim() : undefined;

        writeAuthSetting(database, 'oidc_issuer_url', issuer);
        writeAuthSetting(database, 'oidc_client_id', clientId);
        if (clientSecretInput !== undefined && clientSecretInput !== '') {
          writeAuthSetting(database, 'oidc_client_secret', encryptSecret(clientSecretInput, sessionSecret));
        } else if (!issuer && !clientId) {
          writeAuthSetting(database, 'oidc_client_secret', '');
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
          oidcGroupsClaim: effectiveConfig.oidcGroupsClaim,
          oidcAdminGroups: effectiveConfig.oidcAdminGroups.join(','),
          oidcReadOnlyGroups: effectiveConfig.oidcReadOnlyGroups.join(','),
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

      const user = database.getAuthUserById(session.userId);
      if (!user?.password_hash) return context.json({ error: 'No password set for this account' }, 400);
      if (!await verifyPassword(currentPassword, user.password_hash)) {
        return context.json({ error: 'Current password is incorrect' }, 401);
      }
      const passwordError = validatePassword(newPassword);
      if (passwordError) return context.json({ error: passwordError }, 400);

      database.updateAuthUserPassword(user.id, await hashPassword(newPassword));
      return context.json({ status: 'ok' });
    });

    auth.get('/passkeys', (context) => {
      const session = getSession(context);
      if (!session || !enabled) return context.json({ error: 'Not authenticated' }, 401);
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
      const id = Number(context.req.param('id'));
      const body = asObject(await context.req.json().catch(() => null));
      const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : null;
      if (!Number.isInteger(id) || !database.renameWebAuthnCredential(id, session.userId, name)) {
        return context.json({ error: 'Passkey not found' }, 404);
      }
      return context.json({ status: 'ok' });
    });

    auth.delete('/passkeys/:id', (context) => {
      const session = getSession(context);
      if (!session || !enabled) return context.json({ error: 'Not authenticated' }, 401);
      const id = Number(context.req.param('id'));
      if (!Number.isInteger(id) || !database.deleteWebAuthnCredential(id, session.userId)) {
        return context.json({ error: 'Passkey not found' }, 404);
      }
      return context.json({ status: 'ok' });
    });

    auth.post('/webauthn/register/options', async (context) => {
      const session = getSession(context);
      if (!session || !enabled) return context.json({ error: 'Not authenticated' }, 401);
      const origin = getPublicOrigin(context);
      const options = await createRegistrationOptions(session, database, new URL(origin).hostname);
      setShortCookie(context, CHALLENGE_COOKIE, options.challenge);
      return context.json(options);
    });

    auth.post('/webauthn/register/verify', async (context) => {
      const session = getSession(context);
      if (!session || !enabled) return context.json({ error: 'Not authenticated' }, 401);
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
        database.createWebAuthnCredential({
          userId: session.userId,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString('base64url'),
          signCount: credential.counter,
          transports: JSON.stringify((body.response as { transports?: unknown[] } | undefined)?.transports || []),
          name,
        });
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

      try {
        const origin = getPublicOrigin(context);
        const verification = await verifyAuthentication(body, challenge, origin, new URL(origin).hostname, {
          credentialId: credential.credential_id,
          publicKey: credential.public_key,
          signCount: credential.sign_count,
        });
        if (!verification.verified) return context.json({ error: 'Verification failed' }, 400);
        database.updateWebAuthnCredentialCounter(credential.id, verification.authenticationInfo.newCounter);
        createSession(context, user);
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
        const user = database.upsertOidcUser(result.username, result.role);
        createSession(context, user);
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
