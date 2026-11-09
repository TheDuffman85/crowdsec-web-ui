import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type JWTPayload } from 'jose';
import { generate, generateSecret } from 'otplib';
import { hashPassword } from '../../app-auth';
import { createAuthSessionCookie, createController } from './harness';

const ISSUER = 'https://idp.example.com/application/o/crowdsec/';
const OTHER_ISSUER = 'https://old-idp.example.com/';
const CLIENT_ID = 'crowdsec-client';
const BASE = 'https://ui.example.com/crowdsec';
const PASSWORD = 'Password1';
const ACCOUNT_COOKIE_PREFIX = 'crowdsec_web_ui_oidc_link_';
const DENIED_LOGIN_URL = `${BASE}/login?oidcError=denied`;

let signingKey: CryptoKey;
let publicJwk: JWK;
let currentNonce = '';

type Controller = ReturnType<typeof createController>['controller'];
type Database = ReturnType<typeof createController>['database'];

interface Claims extends JWTPayload {
  preferred_username?: string;
  groups?: string[];
}

/** A browser: keeps the cookies the server sets, as a real one would. */
class Browser {
  cookies = new Map<string, string>();

  constructor(private readonly controller: Controller) {}

  async request(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    const response = await this.controller.fetch(new Request(`${BASE}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }));
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(';');
      const name = pair.slice(0, pair.indexOf('='));
      const value = pair.slice(pair.indexOf('=') + 1);
      if (!value || attributes.some((attribute) => attribute.trim().toLowerCase() === 'max-age=0')) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
    return response;
  }

  async me(): Promise<Record<string, unknown> | null> {
    const response = await this.request('/api/auth/me');
    return response.status === 200 ? (await response.json() as { user: Record<string, unknown> }).user : null;
  }

  linkStatus(): Promise<Response> {
    return this.request('/api/auth/oidc/link');
  }
}

/** Answers discovery, JWKS and the token endpoint with an ID token for the given claims. */
function stubProvider(getClaims: () => Claims): void {
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url === `${ISSUER}.well-known/openid-configuration`) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}authorize/`,
        token_endpoint: `${ISSUER}token/`,
        jwks_uri: `${ISSUER}jwks/`,
      });
    }
    if (url === `${ISSUER}jwks/`) return json({ keys: [publicJwk] });
    if (url === `${ISSUER}token/`) {
      const idToken = await new SignJWT({ nonce: currentNonce, ...getClaims() })
        .setProtectedHeader({ alg: 'RS256', kid: publicJwk.kid })
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .setSubject(getClaims().sub ?? 'alice-sub')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(signingKey);
      return json({ access_token: 'access', token_type: 'Bearer', id_token: idToken });
    }
    return originalFetch(input, init);
  }));
}

describe('linking local and SSO sign-in', () => {
  let controller: Controller;
  let database: Database;
  let adminId: number;
  let passwordHash: string;
  let claims: Claims;

  const identity = (overrides: Claims = {}): Claims => ({
    sub: 'alice-sub',
    preferred_username: 'alice',
    groups: ['admins'],
    ...overrides,
  });

  function createOidcController(env: Record<string, string> = {}, existingDatabase?: Database) {
    return createController({
      database: existingDatabase,
      env: {
        AUTH_ENABLED: 'true',
        AUTH_OIDC_ISSUER_URL: ISSUER,
        AUTH_OIDC_CLIENT_ID: CLIENT_ID,
        AUTH_OIDC_CLIENT_SECRET: 'oidc-secret',
        AUTH_OIDC_ADMIN_GROUPS: 'admins',
        AUTH_OIDC_READ_ONLY_GROUPS: 'viewers',
        ...env,
      },
    });
  }

  function browser(): Browser {
    return new Browser(controller);
  }

  async function signedIn(username = 'admin', password = PASSWORD): Promise<Browser> {
    const client = browser();
    const response = await client.request('/api/auth/login', { method: 'POST', body: { username, password } });
    expect(response.status).toBe(200);
    return client;
  }

  /** Follows a redirect to the provider and back, as the browser does. */
  async function throughProvider(client: Browser, authorizationUrl: string, result: Claims): Promise<Response> {
    const url = new URL(authorizationUrl);
    currentNonce = url.searchParams.get('nonce') ?? '';
    claims = result;
    return client.request(`/api/auth/oidc/callback?code=auth-code&state=${url.searchParams.get('state')}`);
  }

  async function ssoSignIn(client: Browser, result: Claims = identity()): Promise<Response> {
    const login = await client.request('/api/auth/oidc/login');
    expect(login.status).toBe(302);
    return throughProvider(client, login.headers.get('location')!, result);
  }

  /** Takes a local session through the provider, up to the confirmation step. */
  async function reachConfirmation(client: Browser, result: Claims = identity()): Promise<string> {
    const start = await client.request('/api/auth/oidc/link/start', { method: 'POST' });
    expect(start.status).toBe(200);
    const { redirectUrl } = await start.json() as { redirectUrl: string };
    const response = await throughProvider(client, redirectUrl, result);
    expect(response.status).toBe(302);
    return response.headers.get('location')!;
  }

  async function pendingId(client: Browser): Promise<string | undefined> {
    const status = await (await client.linkStatus()).json() as { pending: { id: string } | null };
    return status.pending?.id;
  }

  /** Confirms what the status currently shows, as a form that was just loaded does. */
  async function confirm(client: Browser, body: Record<string, unknown> = { password: PASSWORD }): Promise<Response> {
    return client.request('/api/auth/oidc/link/confirm', { method: 'POST', body: { confirmationId: await pendingId(client), ...body } });
  }

  function unlink(client: Browser, body: Record<string, unknown> = { password: PASSWORD }): Promise<Response> {
    return client.request('/api/auth/oidc/link', { method: 'DELETE', body });
  }

  async function linkedAdmin(result: Claims = identity()): Promise<Browser> {
    const client = await signedIn();
    expect(await reachConfirmation(client, result)).toContain('oidcLink=confirm');
    expect((await confirm(client)).status).toBe(200);
    return client;
  }

  function addLinkedUser(username: string, issuer = ISSUER): number {
    const id = database.createAuthUser({ username, passwordHash, role: 'read-only', authProvider: 'password' });
    database.linkOidcIdentity(id, { username: `${username}-sso`, role: 'admin', issuer, subject: `${username}-sub` }, 'verified');
    return id;
  }

  // An SSO session of a linked account; for an old issuer, one from before the provider changed.
  function ssoSessionOf(userId: number): Browser {
    const user = database.getAuthUserById(userId)!;
    const cookie = createAuthSessionCookie(database, {
      userId,
      username: user.username,
      role: 'admin',
      authMethod: 'oidc',
      sessionVersion: user.session_version,
      oidcSessionVersion: user.oidc_session_version,
    });
    const client = browser();
    client.cookies.set('crowdsec_web_ui_session', cookie.slice(cookie.indexOf('=') + 1));
    return client;
  }

  function addSsoAccount(disabled = false): number {
    const user = database.upsertOidcUser({ username: 'admin#oidc-1a2b3c4d5e', role: 'admin', issuer: ISSUER, subject: 'alice-sub' });
    if (disabled) database.setAuthUserDisabled(user.id, true);
    return user.id;
  }

  beforeAll(async () => {
    const keyPair = await generateKeyPair('RS256');
    signingKey = keyPair.privateKey;
    publicJwk = { ...await exportJWK(keyPair.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
    passwordHash = await hashPassword(PASSWORD);
  });

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    claims = identity();
    stubProvider(() => claims);
    ({ controller, database } = createOidcController());
    adminId = database.createAuthUser({ username: 'admin', passwordHash, role: 'admin', authProvider: 'password' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('linking', () => {
    test('nothing changes until the account holder confirms the identity they saw', async () => {
      const client = await signedIn();
      const before = database.getAuthUserById(adminId);

      const start = await client.request('/api/auth/oidc/link/start', { method: 'POST' });
      const { redirectUrl } = await start.json() as { redirectUrl: string };
      expect(new URL(redirectUrl).searchParams.get('prompt')).toBe('login');

      const response = await throughProvider(client, redirectUrl, identity());
      expect(response.headers.get('location')).toBe(`${BASE}/settings?oidcLink=confirm`);
      expect(database.countAuthUsers()).toBe(1);
      expect(database.getAuthUserById(adminId)).toEqual(before);

      const status = await (await client.linkStatus()).json() as Record<string, unknown>;
      expect(status).toMatchObject({ available: true, canManage: true, link: null });
      expect(status.pending).toEqual({ id: expect.any(String), issuer: ISSUER, username: 'alice', role: 'admin', merge: null });
    });

    describe('confirming what the form showed', () => {
      const bob = (): Claims => identity({ sub: 'bob-sub', preferred_username: 'bob' });

      test('a form showing an attempt another tab replaced links nothing and leaves that tab able to confirm', async () => {
        const client = await signedIn();
        await reachConfirmation(client);
        const shownInFirstTab = await pendingId(client);
        await reachConfirmation(client, bob());

        // Before the credentials are checked, so the attempt does not use up an authenticator code.
        const response = await confirm(client, { confirmationId: shownInFirstTab, password: 'Wrong-password1' });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: 'OIDC_LINK_CHANGED' });
        expect((await confirm(client, { confirmationId: shownInFirstTab })).status).toBe(409);
        expect(database.getAuthUserById(adminId)?.oidc_subject).toBeNull();

        expect((await confirm(client)).status).toBe(200);
        expect(database.getAuthUserById(adminId)?.oidc_subject).toBe('bob-sub');
      });

      test('repeating the attempt for the same identity still needs the newer form', async () => {
        const client = await signedIn();
        await reachConfirmation(client);
        const earlier = await pendingId(client);
        await reachConfirmation(client);

        expect(await pendingId(client)).not.toBe(earlier);
        expect((await confirm(client, { confirmationId: earlier })).status).toBe(409);
      });

      test('a confirmation that names no attempt is refused', async () => {
        const client = await signedIn();
        await reachConfirmation(client);
        expect((await confirm(client, { confirmationId: undefined })).status).toBe(409);
        expect(database.getAuthUserById(adminId)?.oidc_subject).toBeNull();
      });

      test('another attempt\'s separate SSO account is not merged', async () => {
        const bobAccount = database.upsertOidcUser({ username: 'bob', role: 'admin', issuer: ISSUER, subject: 'bob-sub' });
        const client = await signedIn();
        await reachConfirmation(client);
        const shownInFirstTab = await pendingId(client);
        await reachConfirmation(client, bob());

        expect((await confirm(client, { confirmationId: shownInFirstTab })).status).toBe(409);
        expect(database.getAuthUserById(bobAccount.id)).not.toBeNull();
      });

      test('an account to merge that appeared after the form loaded needs a new look', async () => {
        const client = await signedIn();
        await reachConfirmation(client);
        const shown = await pendingId(client);
        const ssoId = addSsoAccount();

        expect((await confirm(client, { confirmationId: shown })).status).toBe(409);
        expect(database.getAuthUserById(ssoId)).not.toBeNull();

        const status = await (await client.linkStatus()).json() as { pending: { merge: unknown } };
        expect(status.pending.merge).toEqual({ username: 'admin#oidc-1a2b3c4d5e' });
        expect((await confirm(client)).status).toBe(200);
        expect(database.getAuthUserById(ssoId)).toBeNull();
      });

      test('an account to merge that appears while the credentials are checked is not merged', async () => {
        const client = await signedIn();
        await reachConfirmation(client);
        const shown = await pendingId(client);

        const confirming = client.request('/api/auth/oidc/link/confirm', { method: 'POST', body: { confirmationId: shown, password: PASSWORD } });
        await new Promise((resolve) => setTimeout(resolve, 5));
        const ssoId = addSsoAccount();

        expect((await confirming).status).toBe(409);
        expect(database.getAuthUserById(ssoId)).not.toBeNull();
        expect(database.getAuthUserById(adminId)?.oidc_subject).toBeNull();
      });
    });

    test('a sign-in without a link in progress keeps its own login URL', async () => {
      const login = await browser().request('/api/auth/oidc/login');
      expect(new URL(login.headers.get('location')!).searchParams.has('prompt')).toBe(false);
    });

    test('confirming needs the password, then links and ends the other sessions', async () => {
      const client = await signedIn();
      const otherDevice = await signedIn();
      await reachConfirmation(client);

      const wrong = await confirm(client, { password: 'Wrong-password1' });
      expect(wrong.status).toBe(401);
      expect(await wrong.json()).toMatchObject({ error: 'Current password is incorrect' });
      expect(database.getAuthUserById(adminId)?.oidc_subject).toBeNull();

      expect((await confirm(client)).status).toBe(200);
      expect(database.getAuthUserById(adminId)).toMatchObject({
        username: 'admin',
        role: 'admin',
        oidc_issuer: ISSUER,
        oidc_subject: 'alice-sub',
        oidc_username: 'alice',
        oidc_role: 'admin',
        oidc_link_method: 'verified',
      });
      expect(database.getAuthUserById(adminId)?.oidc_linked_at).toBeTruthy();
      expect(await client.me()).toMatchObject({ authMethod: 'password' });
      expect(await otherDevice.me()).toBeNull();
    });

    test('a used confirmation cannot be replayed', async () => {
      const client = await signedIn();
      await reachConfirmation(client);
      const pending = client.cookies.get(`${ACCOUNT_COOKIE_PREFIX}pending`)!;
      expect((await confirm(client)).status).toBe(200);
      expect(client.cookies.has(`${ACCOUNT_COOKIE_PREFIX}pending`)).toBe(false);

      client.cookies.set(`${ACCOUNT_COOKIE_PREFIX}pending`, pending);
      expect((await confirm(client)).status).toBe(400);
    });

    test('a forged confirmation is rejected', async () => {
      const client = await signedIn();
      await reachConfirmation(client);
      const pending = client.cookies.get(`${ACCOUNT_COOKIE_PREFIX}pending`)!;
      const forged = Buffer.from(JSON.stringify({
        ...JSON.parse(Buffer.from(pending.split('.')[0], 'base64url').toString('utf8')),
        subject: 'mallory-sub',
      })).toString('base64url');
      client.cookies.set(`${ACCOUNT_COOKIE_PREFIX}pending`, `${forged}.${pending.split('.')[1]}`);

      expect((await confirm(client)).status).toBe(400);
      expect(database.getAuthUserById(adminId)?.oidc_subject).toBeNull();
    });

    test('the authenticator code is required when TOTP is on', async () => {
      const client = await signedIn();
      const setupResponse = await client.request('/api/auth/totp/setup', { method: 'POST' });
      const setupPayload = await setupResponse.json() as { secret: string };
      expect((await client.request('/api/auth/totp/enable', { method: 'POST', body: { code: await generate({ secret: setupPayload.secret }) } })).status).toBe(200);
      await reachConfirmation(client);

      const missing = await confirm(client);
      expect(missing.status).toBe(400);
      expect(await missing.json()).toMatchObject({ error: 'Authenticator code required' });
      expect((await confirm(client, { password: PASSWORD, totpCode: await generate({ secret: generateSecret() }) })).status).toBe(400);
      expect(database.getAuthUserById(adminId)?.oidc_subject).toBeNull();

      const response = await confirm(client, { password: PASSWORD, totpCode: await generate({ secret: setupPayload.secret }) });
      expect(response.status).toBe(200);
      expect(database.getAuthUserById(adminId)?.oidc_subject).toBe('alice-sub');
    });

    test('only local sessions can start or confirm a link', async () => {
      const sso = browser();
      await ssoSignIn(sso);
      expect(await sso.me()).toMatchObject({ authMethod: 'oidc' });
      expect((await sso.request('/api/auth/oidc/link/start', { method: 'POST' })).status).toBe(403);
      expect((await confirm(sso)).status).toBe(403);
      expect((await browser().request('/api/auth/oidc/link/start', { method: 'POST' })).status).toBe(401);
    });

    test('a pending password change blocks starting a link', async () => {
      database.createAuthUser({ username: 'fresh', passwordHash, role: 'read-only', authProvider: 'password', passwordChangeRequired: true });
      const client = await signedIn('fresh');
      expect((await client.request('/api/auth/oidc/link/start', { method: 'POST' })).status).toBe(403);
    });

    test('credentials changed at the provider step invalidate the intent', async () => {
      const client = await signedIn();
      const start = await client.request('/api/auth/oidc/link/start', { method: 'POST' });
      const { redirectUrl } = await start.json() as { redirectUrl: string };
      database.resetAuthUserPassword(adminId, passwordHash, false);

      const response = await throughProvider(client, redirectUrl, identity());
      expect(response.headers.get('location')).toContain('oidcLink=session');
      expect(client.cookies.has(`${ACCOUNT_COOKIE_PREFIX}pending`)).toBe(false);
    });

    test('a sign-in started after the link attempt stays a sign-in', async () => {
      const client = await signedIn();
      await client.request('/api/auth/oidc/link/start', { method: 'POST' });
      const response = await ssoSignIn(client);

      expect(response.headers.get('location')).toBe(BASE);
      expect(database.getAuthUserById(adminId)?.oidc_subject).toBeNull();
      expect(database.countAuthUsers()).toBe(2);
    });

    test('a denied identity cannot be linked and the attempt ends no sessions', async () => {
      const client = await signedIn();
      const location = await reachConfirmation(client, identity({ groups: ['strangers'] }));
      expect(location).toContain('oidcLink=denied');
      expect(client.cookies.has(`${ACCOUNT_COOKIE_PREFIX}pending`)).toBe(false);
      expect(await client.me()).not.toBeNull();
    });

    test('an identity on another account with a password cannot be taken', async () => {
      addLinkedUser('bob');
      const client = await signedIn();
      expect(await reachConfirmation(client, identity({ sub: 'bob-sub' }))).toContain('oidcLink=taken');
    });

    test('a failed provider sign-in returns to the account page', async () => {
      const client = await signedIn();
      const start = await client.request('/api/auth/oidc/link/start', { method: 'POST' });
      const { redirectUrl } = await start.json() as { redirectUrl: string };
      const state = new URL(redirectUrl).searchParams.get('state');
      const response = await client.request(`/api/auth/oidc/callback?error=access_denied&state=${state}`);
      expect(response.headers.get('location')).toContain('oidcLink=failed');
    });

    test('an account that is already linked has to unlink first', async () => {
      const client = await linkedAdmin();
      expect((await client.request('/api/auth/oidc/link/start', { method: 'POST' })).status).toBe(409);
    });

    test('an unreachable provider fails the start without changing anything', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw new TypeError('fetch failed');
      }));
      const client = await signedIn();
      expect((await client.request('/api/auth/oidc/link/start', { method: 'POST' })).status).toBe(502);
    });
  });

  describe('a linked account', () => {
    test('SSO sign-in keeps the local username and role and has its own role', async () => {
      const local = await linkedAdmin();
      const sso = browser();
      const response = await ssoSignIn(sso, identity({ preferred_username: 'renamed', groups: ['viewers'] }));
      expect(response.headers.get('location')).toBe(BASE);

      expect(database.countAuthUsers()).toBe(1);
      expect(database.getAuthUserById(adminId)).toMatchObject({
        username: 'admin',
        role: 'admin',
        oidc_role: 'read-only',
        oidc_username: 'renamed',
      });
      expect(await sso.me()).toMatchObject({ userId: adminId, role: 'read-only', authMethod: 'oidc', linkedSso: true });
      expect(await local.me()).toMatchObject({ userId: adminId, role: 'admin', authMethod: 'password' });
    });

    test('a local read-only account gets the SSO role only through SSO', async () => {
      database.updateAuthUserRole(adminId, 'read-only');
      const local = await linkedAdmin();
      const sso = browser();
      await ssoSignIn(sso);
      expect(await sso.me()).toMatchObject({ role: 'admin' });
      expect(await local.me()).toMatchObject({ role: 'read-only' });
    });

    test('a changed SSO role ends earlier SSO sessions only', async () => {
      const local = await linkedAdmin();
      const first = browser();
      await ssoSignIn(first);

      const unchanged = browser();
      await ssoSignIn(unchanged);
      expect(await first.me()).not.toBeNull();

      await ssoSignIn(browser(), identity({ groups: ['viewers'] }));
      expect(await first.me()).toBeNull();
      expect(await unchanged.me()).toBeNull();
      expect(await local.me()).not.toBeNull();
    });

    test('denial ends SSO sessions and keeps local sign-in', async () => {
      const local = await linkedAdmin();
      const sso = browser();
      await ssoSignIn(sso);

      expect((await ssoSignIn(browser(), identity({ groups: ['strangers'] }))).headers.get('location')).toBe(DENIED_LOGIN_URL);
      expect(await sso.me()).toBeNull();
      expect(await local.me()).toMatchObject({ role: 'admin' });
      await signedIn();
      expect(database.getAuthUserById(adminId)).toMatchObject({ role: 'admin', oidc_role: null, oidc_subject: 'alice-sub' });
      expect(await (await local.linkStatus()).json()).toMatchObject({ link: { username: 'alice', role: null } });
    });

    test('the next allowed sign-in restores the SSO role of a denied identity', async () => {
      await linkedAdmin();
      await ssoSignIn(browser(), identity({ groups: ['strangers'] }));

      const sso = browser();
      await ssoSignIn(sso);
      expect(database.getAuthUserById(adminId)?.oidc_role).toBe('admin');
      expect(await sso.me()).toMatchObject({ role: 'admin', linkedSso: true });
    });

    test('back-channel logout without a session ID ends SSO sessions only', async () => {
      const local = await linkedAdmin();
      const sso = browser();
      await ssoSignIn(sso);

      database.applyOidcLogout({
        issuer: ISSUER,
        subject: 'alice-sub',
        tokenId: crypto.randomUUID(),
        tokenExpiresAt: Math.floor(Date.now() / 1000) + 300,
        sessionExpiresAt: Math.floor(Date.now() / 1000) + 300,
      });
      expect(await sso.me()).toBeNull();
      expect(await local.me()).not.toBeNull();
      expect(database.getAuthUserById(adminId)?.oidc_role).toBe('admin');
    });

    test('disabling the account blocks both sign-in methods', async () => {
      const local = await linkedAdmin();
      const sso = browser();
      await ssoSignIn(sso);
      database.setAuthUserDisabled(adminId, true);

      expect(await local.me()).toBeNull();
      expect(await sso.me()).toBeNull();
      const again = browser();
      await ssoSignIn(again);
      expect(await again.me()).toBeNull();
    });

    test('local credential changes end the SSO sessions too', async () => {
      await linkedAdmin();
      const sso = browser();
      await ssoSignIn(sso);
      database.resetAuthUserPassword(adminId, passwordHash, false);
      expect(await sso.me()).toBeNull();
    });

    test('an SSO session cannot touch local credentials or the link', async () => {
      await linkedAdmin();
      const sso = browser();
      await ssoSignIn(sso);

      const settings = await (await sso.request('/api/auth/settings')).json() as Record<string, unknown>;
      expect(settings).toMatchObject({ passkeysAvailable: false, totpEnabled: false, authMethod: 'oidc' });

      const refused = [
        await sso.request('/api/auth/change-password', { method: 'POST', body: { currentPassword: PASSWORD, newPassword: 'NewPassword2' } }),
        await sso.request('/api/auth/webauthn/register/options', { method: 'POST' }),
        await sso.request('/api/auth/webauthn/register/verify', { method: 'POST', body: {} }),
        await sso.request('/api/auth/totp/setup', { method: 'POST' }),
        await sso.request('/api/auth/passkeys'),
        await sso.request('/api/auth/passkeys/1', { method: 'PATCH', body: { name: 'x' } }),
        await sso.request('/api/auth/passkeys/1', { method: 'DELETE' }),
        await unlink(sso),
      ];
      expect(refused.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403, 403, 403]);

      const status = await (await sso.linkStatus()).json() as Record<string, unknown>;
      expect(status).toMatchObject({ canManage: false, link: { username: 'alice', provider: 'current' } });
    });

    test('a local session on a linked account can still manage passkeys', async () => {
      const local = await linkedAdmin();
      expect((await local.request('/api/auth/passkeys')).status).toBe(200);
    });

    test('an SSO session gets the permissions of the SSO role', async () => {
      await linkedAdmin();
      const sso = browser();
      await ssoSignIn(sso, identity({ groups: ['viewers'] }));
      expect((await sso.request('/api/auth/users')).status).toBe(403);
    });
  });

  describe('last-administrator checks', () => {
    function addAdmin(username = 'boss'): number {
      return database.createAuthUser({ username, passwordHash, role: 'admin', authProvider: 'password' });
    }

    test('an SSO session of a previous provider cannot remove the last local administrator', async () => {
      const bossId = addAdmin();
      database.updateAuthUserRole(adminId, 'read-only');
      const stale = ssoSessionOf(addLinkedUser('stale', OTHER_ISSUER));
      expect(await stale.me()).toMatchObject({ role: 'admin' });

      expect((await stale.request(`/api/auth/users/${bossId}`, { method: 'DELETE' })).status).toBe(400);
      expect((await stale.request(`/api/auth/users/${bossId}`, { method: 'PATCH', body: { disabled: true } })).status).toBe(400);
      expect((await stale.request(`/api/auth/users/${bossId}`, { method: 'PATCH', body: { role: 'read-only' } })).status).toBe(400);
      expect(database.getAuthUserById(bossId)).toMatchObject({ disabled: 0, role: 'admin' });
    });

    test('the configured provider\'s SSO admin can remove a local administrator', async () => {
      const bossId = addAdmin();
      database.updateAuthUserRole(adminId, 'read-only');
      await linkedAdmin();
      const sso = browser();
      await ssoSignIn(sso);
      expect((await sso.request(`/api/auth/users/${bossId}`, { method: 'DELETE' })).status).toBe(200);
    });

    test('disabling the account with the last SSO administrator access is refused', async () => {
      database.updateAuthUserRole(adminId, 'read-only');
      await linkedAdmin();
      const stale = ssoSessionOf(addLinkedUser('stale', OTHER_ISSUER));
      expect((await stale.request(`/api/auth/users/${adminId}`, { method: 'PATCH', body: { disabled: true } })).status).toBe(400);
      expect(database.getAuthUserById(adminId)?.disabled).toBe(0);
    });

    test('unlinking cannot remove the only administrator access', async () => {
      database.updateAuthUserRole(adminId, 'read-only');
      const local = await linkedAdmin();
      expect((await unlink(local)).status).toBe(400);
      expect(database.getAuthUserById(adminId)?.oidc_subject).toBe('alice-sub');
    });

    test('a denied SSO role no longer blocks unlinking', async () => {
      database.updateAuthUserRole(adminId, 'read-only');
      const local = await linkedAdmin();
      expect((await unlink(local)).status).toBe(400);

      expect((await ssoSignIn(browser(), identity({ groups: ['strangers'] }))).headers.get('location')).toBe(DENIED_LOGIN_URL);
      expect((await unlink(local)).status).toBe(200);
      expect(database.getAuthUserById(adminId)).toMatchObject({ role: 'read-only', oidc_subject: null });
    });

    test('a denied SSO role no longer counts as another administrator', async () => {
      const bossId = addAdmin();
      database.updateAuthUserRole(adminId, 'read-only');
      addLinkedUser('denied');
      const stale = ssoSessionOf(addLinkedUser('stale', OTHER_ISSUER));

      expect((await ssoSignIn(browser(), identity({ sub: 'denied-sub', groups: ['strangers'] }))).headers.get('location')).toBe(DENIED_LOGIN_URL);
      expect((await stale.request(`/api/auth/users/${bossId}`, { method: 'DELETE' })).status).toBe(400);
    });

    test('a denied SSO-only administrator no longer counts until allowed again', async () => {
      const bossId = addAdmin();
      database.updateAuthUserRole(adminId, 'read-only');
      const ssoId = addSsoAccount();
      const stale = ssoSessionOf(addLinkedUser('stale', OTHER_ISSUER));

      expect((await ssoSignIn(browser(), identity({ groups: ['strangers'] }))).headers.get('location')).toBe(DENIED_LOGIN_URL);
      expect(database.getAuthUserById(ssoId)?.role).toBe('read-only');
      expect((await stale.request(`/api/auth/users/${bossId}`, { method: 'DELETE' })).status).toBe(400);

      await ssoSignIn(browser());
      expect(database.getAuthUserById(ssoId)?.role).toBe('admin');
    });

    test('denying an identity leaves the role of an account with a password alone', async () => {
      database.db.prepare('UPDATE auth_users SET auth_provider = ?, oidc_issuer = ?, oidc_subject = ? WHERE id = ?').run('oidc', ISSUER, 'alice-sub', adminId);

      expect((await ssoSignIn(browser(), identity({ groups: ['strangers'] }))).headers.get('location')).toBe(DENIED_LOGIN_URL);
      expect(database.getAuthUserById(adminId)?.role).toBe('admin');
    });

    test('an administrator cannot remove the link holding the only other administrator access', async () => {
      database.updateAuthUserRole(adminId, 'read-only');
      await linkedAdmin();
      const stale = ssoSessionOf(addLinkedUser('stale', OTHER_ISSUER));
      expect((await stale.request(`/api/auth/users/${adminId}/unlink-oidc`, { method: 'POST' })).status).toBe(400);
      expect(database.getAuthUserById(adminId)?.oidc_subject).toBe('alice-sub');
    });

    test('a local administrator can unlink, because the local role stays', async () => {
      const local = await linkedAdmin();
      expect((await unlink(local)).status).toBe(200);
    });
  });

  describe('merging a separate SSO account', () => {
    test('the confirmation names it, and it is removed on confirm', async () => {
      addSsoAccount();
      const client = await signedIn();
      await reachConfirmation(client);

      const status = await (await client.linkStatus()).json() as { pending: { merge: unknown } };
      expect(status.pending.merge).toEqual({ username: 'admin#oidc-1a2b3c4d5e' });
      expect(database.countAuthUsers()).toBe(2);

      expect((await confirm(client)).status).toBe(200);
      expect(database.listAuthUsers().map((user) => user.username)).toEqual(['admin']);
    });

    test('its saved filters move over and its sessions end', async () => {
      const ssoId = addSsoAccount();
      const now = new Date().toISOString();
      const insert = database.db.prepare('INSERT INTO saved_search_filters (id, owner_id, name, query, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
      insert.run('moved', ssoId, 'Moved', 'ip:1.2.3.4', now, now);
      insert.run('kept', adminId, 'Taken', 'ip:5.6.7.8', now, now);
      insert.run('dropped', ssoId, 'Taken', 'ip:9.9.9.9', now, now);
      database.setUserPreference(ssoId, 'language', 'de');
      const sso = browser();
      await ssoSignIn(sso);
      expect(await sso.me()).toMatchObject({ userId: ssoId });

      await linkedAdmin();

      expect(await sso.me()).toBeNull();
      const filters = database.db.prepare('SELECT id, owner_id FROM saved_search_filters ORDER BY id').all();
      expect(filters).toEqual([
        { id: 'kept', owner_id: adminId },
        { id: 'moved', owner_id: adminId },
      ]);
      expect(database.getUserPreferences(adminId)).toEqual({});
    });

    test('a disabled SSO account cannot be merged, so it stays disabled', async () => {
      const ssoId = addSsoAccount(true);
      const client = await signedIn();
      expect(await reachConfirmation(client)).toContain('oidcLink=disabled');
      expect(client.cookies.has(`${ACCOUNT_COOKIE_PREFIX}pending`)).toBe(false);
      expect(database.getAuthUserById(ssoId)?.disabled).toBe(1);
      expect(database.getAuthUserById(adminId)?.oidc_subject).toBeNull();
    });

    test('an SSO account disabled after the provider step is not merged on confirm', async () => {
      const ssoId = addSsoAccount();
      const client = await signedIn();
      expect(await reachConfirmation(client)).toContain('oidcLink=confirm');
      database.setAuthUserDisabled(ssoId, true);

      expect((await confirm(client)).status).toBe(409);
      expect(database.getAuthUserById(ssoId)?.disabled).toBe(1);
      expect(database.getAuthUserById(adminId)?.oidc_subject).toBeNull();
    });
  });

  describe('unlinking', () => {
    test('needs the password, ends other sessions, and SSO creates a separate account again', async () => {
      const client = await linkedAdmin();
      const otherDevice = await signedIn();
      const sso = browser();
      await ssoSignIn(sso);

      expect((await unlink(client, { password: 'Wrong-password1' })).status).toBe(401);

      expect((await unlink(client)).status).toBe(200);
      expect(database.getAuthUserById(adminId)).toMatchObject({
        auth_provider: 'password',
        oidc_issuer: null,
        oidc_subject: null,
        oidc_role: null,
        oidc_linked_at: null,
        oidc_auto_link_blocked: 1,
      });
      expect(await client.me()).toMatchObject({ authMethod: 'password' });
      expect(await otherDevice.me()).toBeNull();
      expect(await sso.me()).toBeNull();

      const again = browser();
      await ssoSignIn(again);
      expect((await again.me())?.userId).not.toBe(adminId);
    });

    test('another administrator can remove the link; the owner uses their profile', async () => {
      const client = await linkedAdmin();
      const otherId = database.createAuthUser({ username: 'other', passwordHash, role: 'admin', authProvider: 'password' });
      const other = await signedIn('other');

      const list = await (await other.request('/api/auth/users')).json() as {
        users: Array<{ username: string; source: string; oidcLink: Record<string, unknown> | null }>;
      };
      const admin = list.users.find((user) => user.username === 'admin')!;
      expect(admin.source).toBe('local');
      expect(admin.oidcLink).toMatchObject({ username: 'alice', role: 'admin', method: 'verified', issuer: ISSUER });
      expect(list.users.find((user) => user.username === 'other')?.oidcLink).toBeNull();

      expect((await client.request(`/api/auth/users/${adminId}/unlink-oidc`, { method: 'POST' })).status).toBe(400);
      expect((await other.request(`/api/auth/users/${otherId}/unlink-oidc`, { method: 'POST' })).status).toBe(400);

      const response = await other.request(`/api/auth/users/${adminId}/unlink-oidc`, { method: 'POST' });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ user: { username: 'admin', oidcLink: null } });
      expect(await client.me()).toBeNull();
    });

    async function linkProvider(client: Browser): Promise<string> {
      const status = await (await client.linkStatus()).json() as { link: { provider: string } };
      return status.link.provider;
    }

    test('a link to the configured provider is current', async () => {
      expect(await linkProvider(await linkedAdmin())).toBe('current');
    });

    test('an unreachable provider does not make a link stale', async () => {
      addLinkedUser('reachable');
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw new TypeError('fetch failed');
      }));
      expect(await linkProvider(await signedIn('reachable'))).toBe('unavailable');
    });

    test('a provider that goes offline after the link is reported as unavailable', async () => {
      const client = await linkedAdmin();
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw new TypeError('fetch failed');
      }));
      expect(await linkProvider(client)).toBe('unavailable');
    });

    test('a recent answer is reused, and later checks notice the provider leaving and returning', async () => {
      const client = await linkedAdmin();
      expect(await linkProvider(client)).toBe('current');
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });

      const offline = vi.fn(async () => {
        throw new TypeError('fetch failed');
      });
      vi.stubGlobal('fetch', offline);
      expect(await linkProvider(client)).toBe('current');
      expect(offline).not.toHaveBeenCalled();

      vi.setSystemTime(Date.now() + 30_000);
      expect(await linkProvider(client)).toBe('unavailable');
      expect(await linkProvider(client)).toBe('unavailable');
      expect(offline).toHaveBeenCalledTimes(1);

      stubProvider(() => claims);
      vi.setSystemTime(Date.now() + 30_000);
      expect(await linkProvider(client)).toBe('current');
    });

    test('a provider that stops answering is unavailable after the timeout', async () => {
      const client = await linkedAdmin();
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(10));
      vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })));

      expect(await linkProvider(client)).toBe('unavailable');
      expect(timeoutSpy).toHaveBeenCalledWith(5000);
    });

    test('a link from a previous issuer is reported as changed and can be unlinked', async () => {
      addLinkedUser('stale', OTHER_ISSUER);
      const client = await signedIn('stale');
      expect(await linkProvider(client)).toBe('changed');
      expect((await unlink(client)).status).toBe(200);
    });
  });

  describe('automatic linking by username', () => {
    const adminClaims = (overrides: Claims = {}) => identity({ preferred_username: 'admin', ...overrides });

    beforeEach(() => {
      database.setMeta('auth_oidc_auto_link_username', 'true');
    });

    test('is off by default', async () => {
      database.setMeta('auth_oidc_auto_link_username', 'false');
      await ssoSignIn(browser(), adminClaims());
      expect(database.getAuthUserById(adminId)?.oidc_subject).toBeNull();
      expect(database.getAuthUserByOidcIdentity(ISSUER, 'alice-sub')?.username).toMatch(/^admin#oidc-/);
    });

    test('links an existing account without touching its sessions or local access', async () => {
      const local = await signedIn();
      const sso = browser();
      await ssoSignIn(sso, adminClaims({ groups: ['viewers'] }));

      expect(database.countAuthUsers()).toBe(1);
      expect(database.getAuthUserById(adminId)).toMatchObject({ role: 'admin', oidc_role: 'read-only', oidc_link_method: 'username' });
      expect(await local.me()).toMatchObject({ role: 'admin', authMethod: 'password' });
      expect(await sso.me()).toMatchObject({ userId: adminId, role: 'read-only', linkedSso: true });
    });

    test('merges the identity\'s separate SSO account', async () => {
      addSsoAccount();
      await ssoSignIn(browser(), adminClaims());
      expect(database.listAuthUsers().map((user) => user.username)).toEqual(['admin']);
    });

    test('ignores usernames that came from a fallback claim', async () => {
      await ssoSignIn(browser(), identity({ preferred_username: undefined, email: 'admin' } as Claims));
      expect(database.getAuthUserById(adminId)?.oidc_subject).toBeNull();
    });

    test('needs an exact match', async () => {
      await ssoSignIn(browser(), adminClaims({ preferred_username: 'ADMIN' }));
      expect(database.getAuthUserById(adminId)?.oidc_subject).toBeNull();
    });

    test('never links a denied identity', async () => {
      await ssoSignIn(browser(), adminClaims({ groups: ['strangers'] }));
      expect(database.getAuthUserById(adminId)?.oidc_subject).toBeNull();
    });

    test('leaves out disabled accounts', async () => {
      database.setAuthUserDisabled(adminId, true);
      await ssoSignIn(browser(), adminClaims());
      expect(database.getAuthUserById(adminId)?.oidc_subject).toBeNull();
    });

    test('leaves out accounts created while it is on', async () => {
      const admin = await signedIn();
      const created = await admin.request('/api/auth/users', { method: 'POST', body: { username: 'bob', password: PASSWORD, role: 'read-only' } });
      expect(created.status).toBe(201);

      await ssoSignIn(browser(), identity({ sub: 'bob-sub', preferred_username: 'bob' }));
      expect(database.getAuthUserByUsername('bob')?.oidc_subject).toBeNull();
      expect(database.getAuthUserByOidcIdentity(ISSUER, 'bob-sub')?.username).toMatch(/^bob#oidc-/);
    });

    test('does not relink an account that was unlinked', async () => {
      await ssoSignIn(browser(), adminClaims());
      const local = await signedIn();
      expect((await unlink(local)).status).toBe(200);

      await ssoSignIn(browser(), adminClaims());
      expect(database.getAuthUserById(adminId)?.oidc_subject).toBeNull();
    });

    test('cannot replace an existing link', async () => {
      await ssoSignIn(browser(), adminClaims());
      await ssoSignIn(browser(), adminClaims({ sub: 'mallory-sub' }));
      expect(database.getAuthUserById(adminId)?.oidc_subject).toBe('alice-sub');
    });

    test('does not bring back a disabled SSO account', async () => {
      const ssoId = addSsoAccount(true);
      const sso = browser();
      await ssoSignIn(sso, adminClaims());
      expect(await sso.me()).toBeNull();
      expect(database.getAuthUserById(ssoId)?.disabled).toBe(1);
      expect(database.getAuthUserById(adminId)?.oidc_subject).toBeNull();
    });

    test('an automatically linked SSO session gets no local credentials', async () => {
      const sso = browser();
      await ssoSignIn(sso, adminClaims());
      const change = await sso.request('/api/auth/change-password', { method: 'POST', body: { currentPassword: PASSWORD, newPassword: 'NewPassword2' } });
      expect(change.status).toBe(403);
    });

    test('can be changed in Settings unless the application config sets it', async () => {
      const admin = await signedIn();
      expect((await admin.request('/api/auth/settings', { method: 'PUT', body: { oidcAutoLinkUsername: false } })).status).toBe(200);
      expect(await (await admin.request('/api/auth/settings')).json()).toMatchObject({ oidcAutoLinkUsername: false });

      ({ controller } = createOidcController({ CONFIG_AUTH_OIDC_AUTO_LINK_USERNAME: 'true' }, database));
      const managed = await signedIn();
      expect(await (await managed.request('/api/auth/settings')).json()).toMatchObject({
        oidcAutoLinkUsername: true,
        managedSettings: { oidcAutoLinkUsername: { path: 'auth.oidc.autoLinkUsername' } },
      });
      const refused = await managed.request('/api/auth/settings', { method: 'PUT', body: { oidcAutoLinkUsername: false } });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: 'MANAGED_BY_CONFIG' });
    });
  });
});
