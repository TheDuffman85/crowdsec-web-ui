import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createAuthSessionCookie, createController } from './harness';

const ISSUER = 'https://idp.example.com/application/o/crowdsec/';

type Controller = ReturnType<typeof createController>['controller'];

async function setupAdmin(controller: Controller): Promise<string> {
  const setup = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123' }),
  }));
  expect(setup.status).toBe(200);
  return setup.headers.get('set-cookie') || '';
}

function getJson(controller: Controller, path: string, cookie = '') {
  return controller.fetch(new Request(`http://localhost/crowdsec/api/auth/${path}`, { headers: { cookie } }));
}

function putSettings(controller: Controller, cookie: string, body: Record<string, unknown>) {
  return controller.fetch(new Request('http://localhost/crowdsec/api/auth/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  }));
}

function fallbackWarnings(warn: { mock: { calls: unknown[][] } }): number {
  return warn.mock.calls.filter(([message]) => String(message).includes('keeping password login enabled')).length;
}

function passwordLogin(controller: Controller) {
  return controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123' }),
  }));
}

describe('auth.passwordLogin.enabled', () => {
  let warn: { mock: { calls: unknown[][] } };

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('disables password login and locks the setting when OIDC is configured', async () => {
    const { controller, database } = createController({
      env: {
        AUTH_ENABLED: 'true',
        AUTH_OIDC_ISSUER_URL: ISSUER,
        AUTH_OIDC_CLIENT_ID: 'crowdsec-client',
        CONFIG_AUTH_PASSWORD_LOGIN_ENABLED: 'false',
      },
    });
    const user = database.upsertOidcUser({ username: 'oidc-admin', role: 'admin', issuer: ISSUER, subject: 'oidc-subject' });
    const cookie = createAuthSessionCookie(database, {
      userId: user.id, username: user.username, role: user.role, authMethod: 'oidc',
    });

    expect(await (await getJson(controller, 'status')).json()).toMatchObject({ passwordLoginDisabled: true });
    expect((await passwordLogin(controller)).status).toBe(403);
    expect(await (await getJson(controller, 'settings', cookie)).json()).toMatchObject({
      disablePasswordLogin: true,
      passwordLoginManaged: true,
      passwordLoginFallback: false,
    });

    const change = await putSettings(controller, cookie, { disablePasswordLogin: false });
    expect(change.status).toBe(409);
    expect(await change.json()).toMatchObject({ code: 'MANAGED_BY_CONFIG' });
    expect(database.getMeta('auth_disable_password_login')).toBeFalsy();

    const otherChange = await putSettings(controller, cookie, { oidcGroupsClaim: 'roles' });
    expect(otherChange.status).toBe(200);
    expect(await otherChange.json()).toMatchObject({ settings: { disablePasswordLogin: true, passwordLoginManaged: true } });
    expect(fallbackWarnings(warn)).toBe(0);
  });

  test('closes initial setup when password login is disabled', async () => {
    const { controller, database } = createController({
      env: {
        AUTH_ENABLED: 'true',
        AUTH_OIDC_ISSUER_URL: ISSUER,
        AUTH_OIDC_CLIENT_ID: 'crowdsec-client',
        AUTH_OIDC_ADMIN_GROUPS: 'crowdsec-admins',
        CONFIG_AUTH_PASSWORD_LOGIN_ENABLED: 'false',
      },
    });

    expect(await (await getJson(controller, 'status')).json()).toMatchObject({
      setupRequired: false,
      oidcEnabled: true,
      passwordLoginDisabled: true,
    });
    const setup = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Secret123' }),
    }));
    expect(setup.status).toBe(403);
    expect(setup.headers.get('set-cookie')).toBeFalsy();
    expect(database.countAuthUsers()).toBe(0);
    expect(warn.mock.calls.some(([message]) => String(message).includes('no OIDC admin groups'))).toBe(false);
  });

  test('warns when password login is disabled without OIDC admin groups on a fresh instance', () => {
    createController({
      env: {
        AUTH_ENABLED: 'true',
        AUTH_OIDC_ISSUER_URL: ISSUER,
        AUTH_OIDC_CLIENT_ID: 'crowdsec-client',
        CONFIG_AUTH_PASSWORD_LOGIN_ENABLED: 'false',
      },
    });
    expect(warn.mock.calls.some(([message]) => String(message).includes('no OIDC admin groups'))).toBe(true);
  });

  test('keeps password login enabled when no other sign-in method exists', async () => {
    const { controller } = createController({
      env: { AUTH_ENABLED: 'true', CONFIG_AUTH_PASSWORD_LOGIN_ENABLED: 'false' },
    });
    expect(fallbackWarnings(warn)).toBe(1);
    expect(await (await getJson(controller, 'status')).json()).toMatchObject({ setupRequired: true });

    const cookie = await setupAdmin(controller);
    expect(await (await getJson(controller, 'status')).json()).toMatchObject({ passwordLoginDisabled: false });
    expect((await passwordLogin(controller)).status).toBe(200);
    expect(await (await getJson(controller, 'settings', cookie)).json()).toMatchObject({
      disablePasswordLogin: false,
      passwordLoginManaged: true,
      passwordLoginFallback: true,
    });
    expect(fallbackWarnings(warn)).toBe(1);
  });

  test('re-enables password login over a saved setting', async () => {
    const { controller, database } = createController({
      env: { AUTH_ENABLED: 'true', CONFIG_AUTH_PASSWORD_LOGIN_ENABLED: 'true' },
    });
    const cookie = await setupAdmin(controller);
    database.setMeta('auth_disable_password_login', 'true');

    expect(await (await getJson(controller, 'status')).json()).toMatchObject({ passwordLoginDisabled: false });
    expect((await passwordLogin(controller)).status).toBe(200);
    expect(await (await getJson(controller, 'settings', cookie)).json()).toMatchObject({
      disablePasswordLogin: false,
      passwordLoginManaged: true,
    });
  });

  test('leaves the setting managed in Settings when unset', async () => {
    const { controller, database } = createController({ env: { AUTH_ENABLED: 'true' } });
    const cookie = await setupAdmin(controller);
    database.setMeta('auth_disable_password_login', 'true');

    expect(await (await getJson(controller, 'status')).json()).toMatchObject({ passwordLoginDisabled: true });
    expect(await (await getJson(controller, 'settings', cookie)).json()).toMatchObject({
      disablePasswordLogin: true,
      passwordLoginManaged: false,
      passwordLoginFallback: false,
    });
    expect((await putSettings(controller, cookie, { disablePasswordLogin: false })).status).toBe(200);
  });
});
