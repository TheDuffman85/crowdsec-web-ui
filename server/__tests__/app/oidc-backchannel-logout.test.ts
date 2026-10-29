import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type JWTPayload } from 'jose';
import { createAuthSessionCookie, createController } from './harness';

const ISSUER = 'https://idp.example.com/application/o/crowdsec/';
const JWKS_URI = `${ISSUER}jwks/`;
const CLIENT_ID = 'crowdsec-client';
const CLIENT_SECRET = 'oidc-secret';
const BACKCHANNEL_URL = 'https://ui.example.com/crowdsec/api/auth/oidc/backchannel-logout';
const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

let signingKey: CryptoKey;
let publicJwk: JWK;

function stubProvider(metadata: Record<string, unknown> = {}) {
  const originalFetch = globalThis.fetch;
  const jwksRequests = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${ISSUER}.well-known/openid-configuration`) {
      return new Response(JSON.stringify({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}authorize/`,
        token_endpoint: `${ISSUER}token/`,
        jwks_uri: JWKS_URI,
        ...metadata,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === JWKS_URI) {
      jwksRequests();
      return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(input, init);
  }));
  return { jwksRequests };
}

// An undefined value removes the variable, for example to fall back to a default.
function createOidcController(env: Record<string, string | undefined> = {}) {
  const result = createController({
    env: Object.fromEntries(Object.entries({
      AUTH_ENABLED: 'true',
      AUTH_OIDC_ISSUER_URL: ISSUER,
      AUTH_OIDC_CLIENT_ID: CLIENT_ID,
      AUTH_OIDC_CLIENT_SECRET: CLIENT_SECRET,
      CONFIG_AUTH_OIDC_BACKCHANNEL_LOGOUT: 'true',
      ...env,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  });
  const user = result.database.upsertOidcUser({
    username: 'oidc-admin',
    role: 'admin',
    issuer: ISSUER,
    subject: 'oidc-subject',
  });
  const createCookie = (sid?: string) => {
    const payload = {
      userId: user.id,
      username: user.username,
      role: user.role,
      authMethod: 'oidc' as const,
      sessionVersion: result.database.getAuthUserById(user.id)!.session_version,
      ...(sid ? { sid } : {}),
    };
    return createAuthSessionCookie(result.database, payload);
  };
  return { ...result, user, createCookie };
}

function logoutClaims(overrides: JWTPayload = {}): JWTPayload {
  return {
    sub: 'oidc-subject',
    sid: 'idp-session-1',
    events: { [LOGOUT_EVENT]: {} },
    jti: crypto.randomUUID(),
    ...overrides,
  };
}

async function signLogoutToken(
  claims: JWTPayload = logoutClaims(),
  options: { issuer?: string; audience?: string; issuedAt?: number; key?: CryptoKey | Uint8Array; alg?: string } = {},
): Promise<string> {
  const alg = options.alg ?? 'RS256';
  return new SignJWT(claims)
    .setProtectedHeader({ alg, kid: alg === 'RS256' ? publicJwk.kid : undefined, typ: 'logout+jwt' })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? CLIENT_ID)
    .setIssuedAt(options.issuedAt)
    .setExpirationTime('2m')
    .sign(options.key ?? signingKey);
}

function postLogoutToken(controller: ReturnType<typeof createController>['controller'], logoutToken?: string) {
  return controller.fetch(new Request(BACKCHANNEL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: logoutToken === undefined ? '' : new URLSearchParams({ logout_token: logoutToken }).toString(),
  }));
}

type Controller = ReturnType<typeof createController>['controller'];

/** Runs the SSO login and callback against the stubbed provider and returns the session cookie. */
async function signInThroughCallback(controller: Controller, idTokenClaims: JWTPayload = {}): Promise<string> {
  const loginResponse = await controller.fetch(new Request('https://ui.example.com/crowdsec/api/auth/oidc/login'));
  const flowCookies = loginResponse.headers.getSetCookie().map((cookie) => cookie.split(';')[0]);
  const readFlowCookie = (name: string) => flowCookies.find((cookie) => cookie.startsWith(`${name}=`))!.slice(name.length + 1);
  const nonce = readFlowCookie('crowdsec_web_ui_oidc_nonce');
  const state = readFlowCookie('crowdsec_web_ui_oidc_state');

  const providerFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== `${ISSUER}token/`) return providerFetch(input, init);
    const idToken = await new SignJWT({ nonce, preferred_username: 'oidc-admin', groups: ['admins'], ...idTokenClaims })
      .setProtectedHeader({ alg: 'RS256', kid: publicJwk.kid })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setSubject('oidc-subject')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signingKey);
    return new Response(JSON.stringify({ access_token: 'access', token_type: 'Bearer', id_token: idToken }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }));
  try {
    const callbackResponse = await controller.fetch(new Request(
      `https://ui.example.com/crowdsec/api/auth/oidc/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: flowCookies.join('; ') } },
    ));
    expect(callbackResponse.status).toBe(302);
    return callbackResponse.headers.getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .find((cookie) => cookie.startsWith('crowdsec_web_ui_session='))!;
  } finally {
    vi.stubGlobal('fetch', providerFetch);
  }
}

function readSessionPayload(cookie: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[0], 'base64url').toString('utf8'));
}

async function isAuthenticated(controller: ReturnType<typeof createController>['controller'], cookie: string): Promise<boolean> {
  const response = await controller.fetch(new Request('https://ui.example.com/crowdsec/api/auth/me', { headers: { cookie } }));
  return response.status === 200;
}

describe('OIDC back-channel logout', () => {
  beforeAll(async () => {
    const keyPair = await generateKeyPair('RS256');
    signingKey = keyPair.privateKey;
    publicJwk = { ...await exportJWK(keyPair.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
  });

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('ends every dashboard session when the logout token has no session ID', async () => {
    stubProvider();
    const { controller, createCookie } = createOidcController();
    const firstDevice = createCookie('idp-session-1');
    const secondDevice = createCookie('idp-session-2');
    expect(await isAuthenticated(controller, firstDevice)).toBe(true);

    const response = await postLogoutToken(controller, await signLogoutToken(logoutClaims({ sid: undefined })));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await isAuthenticated(controller, firstDevice)).toBe(false);
    expect(await isAuthenticated(controller, secondDevice)).toBe(false);
  });

  test.each([undefined, 'oidc-subject'])('ends only the matching session when sid is present (sub=%s)', async (sub) => {
    stubProvider();
    const { controller, createCookie } = createOidcController();
    const loggedOut = createCookie('idp-session-1');
    const otherSession = createCookie('idp-session-2');

    const token = await signLogoutToken(logoutClaims({ sub, sid: 'idp-session-1' }));
    expect((await postLogoutToken(controller, token)).status).toBe(200);

    expect(await isAuthenticated(controller, loggedOut)).toBe(false);
    expect(await isAuthenticated(controller, otherSession)).toBe(true);
  });

  test('duplicate subject-only notifications do not revoke a later sign-in', async () => {
    stubProvider();
    const { controller, createCookie } = createOidcController();
    const oldCookie = createCookie('old-session');
    const token = await signLogoutToken(logoutClaims({ sid: undefined }));
    expect((await postLogoutToken(controller, token)).status).toBe(200);
    expect(await isAuthenticated(controller, oldCookie)).toBe(false);

    const newCookie = createCookie('new-session');
    expect(await isAuthenticated(controller, newCookie)).toBe(true);
    const retries = await Promise.all([postLogoutToken(controller, token), postLogoutToken(controller, token)]);
    expect(retries.map((response) => response.status)).toEqual([200, 200]);
    expect(await isAuthenticated(controller, newCookie)).toBe(true);

    // A distinct logout event must still revoke the new sign-in.
    const nextToken = await signLogoutToken(logoutClaims({ sid: undefined }));
    expect((await postLogoutToken(controller, nextToken)).status).toBe(200);
    expect(await isAuthenticated(controller, newCookie)).toBe(false);
  });

  test('accepts tokens signed with the client secret', async () => {
    stubProvider();
    const { controller, createCookie } = createOidcController();
    const cookie = createCookie('idp-session-1');

    const token = await signLogoutToken(logoutClaims(), { alg: 'HS256', key: new TextEncoder().encode(CLIENT_SECRET) });
    expect((await postLogoutToken(controller, token)).status).toBe(200);
    expect(await isAuthenticated(controller, cookie)).toBe(false);
  });

  test('acknowledges tokens for unknown users without side effects', async () => {
    stubProvider();
    const { controller, createCookie } = createOidcController();
    const cookie = createCookie('idp-session-1');

    const token = await signLogoutToken(logoutClaims({ sub: 'someone-else', sid: 'other-session' }));
    expect((await postLogoutToken(controller, token)).status).toBe(200);
    expect(await isAuthenticated(controller, cookie)).toBe(true);
  });

  test.each([
    ['a missing token', async () => undefined],
    ['a malformed token', async () => 'not-a-jwt'],
    ['a token from another issuer', async () => signLogoutToken(logoutClaims(), { issuer: 'https://evil.example.com/' })],
    ['a token for another client', async () => signLogoutToken(logoutClaims(), { audience: 'other-client' })],
    ['a token signed with an unknown key', async () => signLogoutToken(logoutClaims(), { key: (await generateKeyPair('RS256')).privateKey })],
    ['a token signed with the wrong client secret', async () => signLogoutToken(logoutClaims(), { alg: 'HS256', key: new TextEncoder().encode('wrong-secret') })],
    ['a token without the logout event', async () => signLogoutToken(logoutClaims({ events: { 'https://example.com/other': {} } }))],
    ['a token with a nonce', async () => signLogoutToken(logoutClaims({ nonce: 'abc' }))],
    ['a token without sub or sid', async () => signLogoutToken(logoutClaims({ sub: undefined, sid: undefined }))],
    ['a token without a token ID', async () => signLogoutToken(logoutClaims({ jti: undefined }))],
    ['a token with an empty token ID', async () => signLogoutToken(logoutClaims({ jti: '' }))],
    ['a stale token', async () => signLogoutToken(logoutClaims(), { issuedAt: Math.floor(Date.now() / 1000) - 10 * 60 })],
  ])('rejects %s', async (_label, buildToken) => {
    stubProvider();
    const { controller, createCookie } = createOidcController();
    const cookie = createCookie('idp-session-1');

    const response = await postLogoutToken(controller, await buildToken());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    expect(await isAuthenticated(controller, cookie)).toBe(true);
  });

  test('rejects unsigned tokens', async () => {
    stubProvider();
    const { controller, createCookie } = createOidcController();
    const cookie = createCookie();
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: 'none' })}.${encode({ ...logoutClaims(), iss: ISSUER, aud: CLIENT_ID, iat: now })}.`;

    expect((await postLogoutToken(controller, unsigned)).status).toBe(400);
    expect(await isAuthenticated(controller, cookie)).toBe(true);
  });

  test('rejects logout tokens by default', async () => {
    stubProvider();
    const { controller, createCookie } = createOidcController({ CONFIG_AUTH_OIDC_BACKCHANNEL_LOGOUT: undefined });
    const cookie = createCookie('idp-session-1');

    const response = await postLogoutToken(controller, await signLogoutToken());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request', error_description: 'Back-channel logout is disabled' });
    expect(await isAuthenticated(controller, cookie)).toBe(true);
  });

  test('rejects logout tokens while back-channel logout is disabled in the configuration', async () => {
    stubProvider();
    const { controller, createCookie } = createOidcController({ CONFIG_AUTH_OIDC_BACKCHANNEL_LOGOUT: 'false' });
    const cookie = createCookie('idp-session-1');

    const response = await postLogoutToken(controller, await signLogoutToken());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request', error_description: 'Back-channel logout is disabled' });
    expect(await isAuthenticated(controller, cookie)).toBe(true);
  });

  test('admins can enable back-channel logout in settings while the config leaves it unset', async () => {
    stubProvider();
    const { controller, createCookie } = createOidcController({ CONFIG_AUTH_OIDC_BACKCHANNEL_LOGOUT: undefined });
    const adminCookie = createCookie('idp-session-1');
    const putSettings = (body: Record<string, unknown>) => controller.fetch(new Request('https://ui.example.com/crowdsec/api/auth/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify(body),
    }));

    const initial = await controller.fetch(new Request('https://ui.example.com/crowdsec/api/auth/settings', { headers: { cookie: adminCookie } }));
    expect(await initial.json()).toMatchObject({ oidcBackchannelLogout: false });
    expect((await postLogoutToken(controller, await signLogoutToken())).status).toBe(400);
    expect(await isAuthenticated(controller, adminCookie)).toBe(true);

    const enable = await putSettings({ oidcBackchannelLogout: true });
    expect(await enable.json()).toMatchObject({ settings: { oidcBackchannelLogout: true } });
    expect((await postLogoutToken(controller, await signLogoutToken())).status).toBe(200);
    expect(await isAuthenticated(controller, adminCookie)).toBe(false);
  });

  test('locks back-channel logout when the application config sets it', async () => {
    stubProvider();
    const { controller, createCookie } = createOidcController();
    const adminCookie = createCookie('idp-session-1');

    const change = await controller.fetch(new Request('https://ui.example.com/crowdsec/api/auth/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ oidcBackchannelLogout: false }),
    }));
    expect(change.status).toBe(409);
    expect(await change.json()).toMatchObject({ code: 'MANAGED_BY_CONFIG' });
    expect((await postLogoutToken(controller, await signLogoutToken())).status).toBe(200);
  });

  test('rejects logout requests while OIDC is not configured', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });

    const response = await postLogoutToken(controller, 'token');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
  });

  test('rejects logout requests when provider discovery fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));
    const { controller, createCookie } = createOidcController();
    const cookie = createCookie();

    expect((await postLogoutToken(controller, 'token')).status).toBe(400);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('OIDC back-channel logout failed'));
    expect(await isAuthenticated(controller, cookie)).toBe(true);
  });

  test('binds sessions from the SSO callback to the provider session ID', async () => {
    stubProvider();
    const { controller } = createOidcController({ AUTH_OIDC_ADMIN_GROUPS: 'admins' });

    const sessionCookie = await signInThroughCallback(controller, { sid: 'callback-session' });
    expect(readSessionPayload(sessionCookie)).toMatchObject({ authMethod: 'oidc', sid: 'callback-session' });
    expect(readSessionPayload(sessionCookie)).not.toHaveProperty('oidcLogoutVersion');
    expect(await isAuthenticated(controller, sessionCookie)).toBe(true);

    const token = await signLogoutToken(logoutClaims({ sub: undefined, sid: 'callback-session' }));
    expect((await postLogoutToken(controller, token)).status).toBe(200);
    expect(await isAuthenticated(controller, sessionCookie)).toBe(false);
  });

  test('a logout with sid and sub also ends sessions of that user without a stored sid', async () => {
    stubProvider();
    const { controller, createCookie } = createOidcController();
    // Cookies issued before back-channel logout existed carry neither sid nor a logout version.
    const legacyCookie = createCookie();
    const otherProviderSession = createCookie('idp-session-2');

    const token = await signLogoutToken(logoutClaims({ sid: 'idp-session-1' }));
    expect((await postLogoutToken(controller, token)).status).toBe(200);

    expect(await isAuthenticated(controller, legacyCookie)).toBe(false);
    expect(await isAuthenticated(controller, otherProviderSession)).toBe(true);
  });

  test('a logout with only sid leaves sessions without a stored sid alone', async () => {
    stubProvider();
    const { controller, createCookie } = createOidcController();
    const legacyCookie = createCookie();

    const token = await signLogoutToken(logoutClaims({ sub: undefined, sid: 'idp-session-1' }));
    expect((await postLogoutToken(controller, token)).status).toBe(200);

    expect(await isAuthenticated(controller, legacyCookie)).toBe(true);
  });

  test('a sign-in without sid in the same second as a logout survives it and its duplicate delivery', async () => {
    stubProvider();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const { controller } = createOidcController({ AUTH_OIDC_ADMIN_GROUPS: 'admins' });
    const before = await signInThroughCallback(controller);
    expect(readSessionPayload(before)).toMatchObject({ oidcLogoutVersion: 1 });

    const token = await signLogoutToken(logoutClaims({ sid: 'idp-session-1' }));
    expect((await postLogoutToken(controller, token)).status).toBe(200);
    expect(await isAuthenticated(controller, before)).toBe(false);

    const after = await signInThroughCallback(controller);
    expect(readSessionPayload(after)).toMatchObject({ oidcLogoutVersion: 2 });
    expect(readSessionPayload(after).iat).toBe(readSessionPayload(before).iat);
    expect(await isAuthenticated(controller, after)).toBe(true);

    expect((await postLogoutToken(controller, token)).status).toBe(200);
    expect(await isAuthenticated(controller, after)).toBe(true);

    const nextToken = await signLogoutToken(logoutClaims({ sid: 'idp-session-2' }));
    expect((await postLogoutToken(controller, nextToken)).status).toBe(200);
    expect(await isAuthenticated(controller, after)).toBe(false);
  });
});
