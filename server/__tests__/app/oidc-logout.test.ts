import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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

function createOidcController(env: Record<string, string> = {}) {
  const result = createController({
    env: {
      AUTH_ENABLED: 'true',
      AUTH_OIDC_ISSUER_URL: ISSUER,
      AUTH_OIDC_CLIENT_ID: 'crowdsec-client',
      AUTH_OIDC_CLIENT_SECRET: 'oidc-secret',
      ...env,
    },
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

  test('respects auth.oidc.endSession from the application config', async () => {
    stubDiscovery();
    const { controller, sessionCookie } = createOidcController({ CONFIG_AUTH_OIDC_END_SESSION: 'false' });

    expect(await (await logout(controller, sessionCookie)).json()).toEqual({ status: 'ok' });
  });

  test('admins can toggle end-session in settings, overriding the config default', async () => {
    stubDiscovery();
    const { controller, database, sessionCookie } = createOidcController();
    const adminCookie = createAuthSessionCookie(database, {
      userId: database.getAuthUserByUsername('oidc-admin')!.id,
      username: 'oidc-admin',
      role: 'admin',
      authMethod: 'oidc',
    });

    const initial = await controller.fetch(new Request('https://ui.example.com/crowdsec/api/auth/settings', {
      headers: { cookie: adminCookie },
    }));
    expect(await initial.json()).toMatchObject({ oidcEndSession: true });

    const disable = await controller.fetch(new Request('https://ui.example.com/crowdsec/api/auth/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ oidcEndSession: false }),
    }));
    expect(disable.status).toBe(200);
    expect(await disable.json()).toMatchObject({ settings: { oidcEndSession: false } });
    expect(await (await logout(controller, sessionCookie)).json()).toEqual({ status: 'ok' });

    const enable = await controller.fetch(new Request('https://ui.example.com/crowdsec/api/auth/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ oidcEndSession: true }),
    }));
    expect(await enable.json()).toMatchObject({ settings: { oidcEndSession: true } });
    const payload = await (await logout(controller, sessionCookie)).json() as { redirectUrl?: string };
    expect(payload.redirectUrl).toContain(END_SESSION_ENDPOINT);
  });
});
