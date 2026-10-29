import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CrowdsecDatabase, OIDC_END_SESSION_LEGACY_DEFAULT_KEY } from '../../database';
import { createAuthSessionCookie, createController } from './harness';

const ISSUER = 'https://idp.example.com/application/o/crowdsec/';
const END_SESSION_ENDPOINT = 'https://idp.example.com/application/o/crowdsec/end-session/';

function stubDiscovery(metadata: Record<string, unknown> = { end_session_endpoint: END_SESSION_ENDPOINT }) {
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${ISSUER}.well-known/openid-configuration`) {
      return new Response(JSON.stringify({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}authorize/`,
        token_endpoint: `${ISSUER}token/`,
        jwks_uri: `${ISSUER}jwks/`,
        ...metadata,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(input, init);
  }));
}

// An undefined value removes the variable, for example to fall back to a default.
function createOidcController(env: Record<string, string | undefined> = {}, database?: CrowdsecDatabase) {
  const result = createController({
    database,
    env: Object.fromEntries(Object.entries({
      AUTH_ENABLED: 'true',
      AUTH_OIDC_ISSUER_URL: ISSUER,
      AUTH_OIDC_CLIENT_ID: 'crowdsec-client',
      AUTH_OIDC_CLIENT_SECRET: 'oidc-secret',
      CONFIG_AUTH_OIDC_END_SESSION: 'true',
      ...env,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  });
  const user = result.database.upsertOidcUser({
    username: 'oidc-admin',
    role: 'admin',
    issuer: ISSUER,
    subject: 'oidc-subject',
  });
  const sessionCookie = createAuthSessionCookie(result.database, {
    userId: user.id,
    username: user.username,
    role: user.role,
    authMethod: 'oidc',
  });
  return { ...result, sessionCookie };
}

function logout(controller: ReturnType<typeof createController>['controller'], cookie: string) {
  return controller.fetch(new Request('https://ui.example.com/crowdsec/api/auth/logout', {
    method: 'POST',
    headers: { cookie },
  }));
}

describe('OIDC RP-initiated logout', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('redirects SSO users to the provider end-session endpoint with an id_token_hint', async () => {
    stubDiscovery();
    const { controller, sessionCookie } = createOidcController();

    const response = await logout(controller, `${sessionCookie}; crowdsec_web_ui_oidc_id_token=id-token-value`);
    expect(response.status).toBe(200);
    const payload = await response.json() as { status: string; redirectUrl?: string };
    expect(payload.status).toBe('ok');
    const redirectUrl = new URL(payload.redirectUrl!);
    expect(`${redirectUrl.origin}${redirectUrl.pathname}`).toBe(END_SESSION_ENDPOINT);
    expect(redirectUrl.searchParams.get('post_logout_redirect_uri')).toBe('https://ui.example.com/crowdsec/login');
    expect(redirectUrl.searchParams.get('id_token_hint')).toBe('id-token-value');
    expect(redirectUrl.searchParams.get('client_id')).toBe('crowdsec-client');

    const cookies = response.headers.getSetCookie();
    expect(cookies.some((cookie) => cookie.startsWith('crowdsec_web_ui_session=;'))).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith('crowdsec_web_ui_oidc_id_token=;'))).toBe(true);
  });

  test('falls back to client_id only when no ID token cookie is present', async () => {
    stubDiscovery();
    const { controller, sessionCookie } = createOidcController();

    const payload = await (await logout(controller, sessionCookie)).json() as { redirectUrl?: string };
    const redirectUrl = new URL(payload.redirectUrl!);
    expect(redirectUrl.searchParams.has('id_token_hint')).toBe(false);
    expect(redirectUrl.searchParams.get('client_id')).toBe('crowdsec-client');
  });

  test('logs out locally when the provider has no end-session endpoint', async () => {
    stubDiscovery({});
    const { controller, sessionCookie } = createOidcController();

    expect(await (await logout(controller, sessionCookie)).json()).toEqual({ status: 'ok' });
  });

  test('logs out locally when provider discovery fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));
    const { controller, sessionCookie } = createOidcController();

    expect(await (await logout(controller, sessionCookie)).json()).toEqual({ status: 'ok' });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('OIDC end-session URL could not be built'));
  });

  test('does not redirect password sessions', async () => {
    stubDiscovery();
    const { controller, database } = createOidcController();
    const passwordUserId = database.createAuthUser({
      username: 'local-admin',
      passwordHash: 'unused',
      role: 'admin',
      authProvider: 'password',
    });
    const passwordCookie = createAuthSessionCookie(database, {
      userId: passwordUserId,
      username: 'local-admin',
      role: 'admin',
      authMethod: 'password',
    });

    expect(await (await logout(controller, passwordCookie)).json()).toEqual({ status: 'ok' });
  });

  test('only clears the dashboard session by default', async () => {
    stubDiscovery();
    const { controller, sessionCookie } = createOidcController({ CONFIG_AUTH_OIDC_END_SESSION: undefined });

    expect(await (await logout(controller, sessionCookie)).json()).toEqual({ status: 'ok' });
  });

  test('revokes the logged-out session server-side but keeps the user\'s other sessions', async () => {
    stubDiscovery();
    const { controller, database, sessionCookie } = createOidcController({ CONFIG_AUTH_OIDC_END_SESSION: undefined });
    const otherCookie = createAuthSessionCookie(database, {
      userId: database.getAuthUserByUsername('oidc-admin')!.id,
      username: 'oidc-admin',
      role: 'admin',
      authMethod: 'oidc',
    }, undefined, { issuedAt: Math.floor(Date.now() / 1000) - 1 });
    const me = (cookie: string) => controller.fetch(new Request('https://ui.example.com/crowdsec/api/auth/me', { headers: { cookie } }));

    expect((await me(sessionCookie)).status).toBe(200);
    await logout(controller, sessionCookie);

    // Replaying the token that was logged out no longer authenticates.
    expect((await me(sessionCookie)).status).toBe(401);
    expect((await me(otherCookie)).status).toBe(200);
  });

  test('respects auth.oidc.endSession from the application config', async () => {
    stubDiscovery();
    const { controller, sessionCookie } = createOidcController({ CONFIG_AUTH_OIDC_END_SESSION: 'false' });

    expect(await (await logout(controller, sessionCookie)).json()).toEqual({ status: 'ok' });
  });

  test('admins can toggle end-session in settings while the config leaves it unset', async () => {
    stubDiscovery();
    const { controller, database } = createOidcController({ CONFIG_AUTH_OIDC_END_SESSION: undefined });
    // Logging out revokes a session, so each step signs in afresh with a token of its own.
    const now = Math.floor(Date.now() / 1000);
    const signIn = (issuedAt: number) => createAuthSessionCookie(database, {
      userId: database.getAuthUserByUsername('oidc-admin')!.id,
      username: 'oidc-admin',
      role: 'admin',
      authMethod: 'oidc',
    }, undefined, { issuedAt });
    const adminCookie = signIn(now - 1);

    const initial = await controller.fetch(new Request('https://ui.example.com/crowdsec/api/auth/settings', {
      headers: { cookie: adminCookie },
    }));
    expect(await initial.json()).toMatchObject({ oidcEndSession: false });

    const enable = await controller.fetch(new Request('https://ui.example.com/crowdsec/api/auth/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ oidcEndSession: true }),
    }));
    expect(enable.status).toBe(200);
    expect(await enable.json()).toMatchObject({ settings: { oidcEndSession: true } });
    const payload = await (await logout(controller, signIn(now - 2))).json() as { redirectUrl?: string };
    expect(payload.redirectUrl).toContain(END_SESSION_ENDPOINT);

    const disable = await controller.fetch(new Request('https://ui.example.com/crowdsec/api/auth/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ oidcEndSession: false }),
    }));
    expect(await disable.json()).toMatchObject({ settings: { oidcEndSession: false } });
    expect(await (await logout(controller, signIn(now - 3))).json()).toEqual({ status: 'ok' });
  });

  test('locks end-session when the application config sets it', async () => {
    stubDiscovery();
    const { controller, database, sessionCookie } = createOidcController();
    const adminCookie = createAuthSessionCookie(database, {
      userId: database.getAuthUserByUsername('oidc-admin')!.id,
      username: 'oidc-admin',
      role: 'admin',
      authMethod: 'oidc',
    });
    // A value saved in Settings earlier no longer applies once the config sets one.
    database.setMeta('auth_oidc_end_session', 'false');

    const initial = await controller.fetch(new Request('https://ui.example.com/crowdsec/api/auth/settings', {
      headers: { cookie: adminCookie },
    }));
    expect(await initial.json()).toMatchObject({
      oidcEndSession: true,
      managedSettings: {
        oidcIssuerUrl: { path: 'auth.oidc.issuerUrl' },
        oidcClientId: { path: 'auth.oidc.clientId' },
        oidcClientSecret: { path: 'auth.oidc.clientSecret' },
        oidcEndSession: { path: 'auth.oidc.endSession', env: 'CONFIG_AUTH_OIDC_END_SESSION' },
      },
    });

    const change = await controller.fetch(new Request('https://ui.example.com/crowdsec/api/auth/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ oidcEndSession: false }),
    }));
    expect(change.status).toBe(409);
    expect(await change.json()).toMatchObject({ code: 'MANAGED_BY_CONFIG' });
    const payload = await (await logout(controller, sessionCookie)).json() as { redirectUrl?: string };
    expect(payload.redirectUrl).toContain(END_SESSION_ENDPOINT);
  });
});

describe('OIDC end-session default for existing installations', () => {
  const tempDirs: string[] = [];

  // Releases before end-session defaulted to off did not record a per-install default.
  function openExistingInstallDatabase(): CrowdsecDatabase {
    const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-'));
    tempDirs.push(dir);
    const cachePath = path.join(dir, 'test.db');
    const initial = new CrowdsecDatabase({ cachePath });
    initial.db.exec(`DELETE FROM state.settings WHERE key = '${OIDC_END_SESSION_LEGACY_DEFAULT_KEY}'`);
    initial.close();
    return new CrowdsecDatabase({ cachePath });
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('new installations default to off', () => {
    const { database } = createOidcController({ CONFIG_AUTH_OIDC_END_SESSION: undefined });
    expect(database.getMeta(OIDC_END_SESSION_LEGACY_DEFAULT_KEY)?.value).toBe('false');
  });

  test('installations that already used OIDC keep ending the provider session', async () => {
    stubDiscovery();
    const database = openExistingInstallDatabase();
    expect(database.getMeta(OIDC_END_SESSION_LEGACY_DEFAULT_KEY)?.value).toBe('pending');

    const { controller, sessionCookie } = createOidcController({ CONFIG_AUTH_OIDC_END_SESSION: undefined }, database);

    expect(database.getMeta(OIDC_END_SESSION_LEGACY_DEFAULT_KEY)?.value).toBe('true');
    const payload = await (await logout(controller, sessionCookie)).json() as { redirectUrl?: string };
    expect(payload.redirectUrl).toContain(END_SESSION_ENDPOINT);
  });

  test('the application config still overrides the kept default', async () => {
    stubDiscovery();
    const { controller, sessionCookie } = createOidcController({ CONFIG_AUTH_OIDC_END_SESSION: 'false' }, openExistingInstallDatabase());

    expect(await (await logout(controller, sessionCookie)).json()).toEqual({ status: 'ok' });
  });

  test('installations that configure OIDC only after upgrading get the new default', async () => {
    stubDiscovery();
    const database = openExistingInstallDatabase();
    createController({ env: { AUTH_ENABLED: 'true' }, database });
    expect(database.getMeta(OIDC_END_SESSION_LEGACY_DEFAULT_KEY)?.value).toBe('false');

    const { controller, sessionCookie } = createOidcController({ CONFIG_AUTH_OIDC_END_SESSION: undefined }, database);

    expect(await (await logout(controller, sessionCookie)).json()).toEqual({ status: 'ok' });
  });
});
