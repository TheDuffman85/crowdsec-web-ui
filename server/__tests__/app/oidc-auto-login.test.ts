import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createAuthSessionCookie, createController } from './harness';

const ISSUER = 'https://idp.example.com/application/o/crowdsec/';
const OIDC_ENV = {
  AUTH_ENABLED: 'true',
  AUTH_OIDC_ISSUER_URL: ISSUER,
  AUTH_OIDC_CLIENT_ID: 'crowdsec-client',
  AUTH_OIDC_CLIENT_SECRET: 'oidc-secret',
};

type Controller = ReturnType<typeof createController>['controller'];

async function readStatus(controller: Controller): Promise<{ oidcAutoLogin: boolean; passwordLoginDisabled: boolean }> {
  return await (await controller.fetch(new Request('https://ui.example.com/crowdsec/api/auth/status'))).json();
}

function autoLoginWarnings(): string[] {
  return vi.mocked(console.warn).mock.calls
    .map(([message]) => String(message))
    .filter((message) => message.startsWith('OIDC auto-login is enabled but inactive'));
}

function createAdminCookie(database: ReturnType<typeof createController>['database']): string {
  const userId = database.createAuthUser({
    username: 'local-admin',
    passwordHash: 'unused',
    role: 'admin',
    authProvider: 'password',
  });
  return createAuthSessionCookie(database, { userId, username: 'local-admin', role: 'admin', authMethod: 'password' });
}

function putSettings(controller: Controller, cookie: string, body: Record<string, unknown>) {
  return controller.fetch(new Request('https://ui.example.com/crowdsec/api/auth/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  }));
}

describe('OIDC auto-login', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('is active when OIDC is configured and password login is disabled', async () => {
    const { controller } = createController({
      env: { ...OIDC_ENV, CONFIG_AUTH_PASSWORD_LOGIN_ENABLED: 'false', CONFIG_AUTH_OIDC_AUTO_LOGIN: 'true' },
    });

    expect(await readStatus(controller)).toMatchObject({ oidcAutoLogin: true, passwordLoginDisabled: true });
    expect(autoLoginWarnings()).toEqual([]);
  });

  test('stays off without a warning when it is not enabled', async () => {
    const { controller } = createController({ env: { ...OIDC_ENV, CONFIG_AUTH_PASSWORD_LOGIN_ENABLED: 'false' } });

    expect(await readStatus(controller)).toMatchObject({ oidcAutoLogin: false });
    expect(autoLoginWarnings()).toEqual([]);
  });

  test('is inactive and logs why while password login is enabled', async () => {
    const { controller } = createController({ env: { ...OIDC_ENV, CONFIG_AUTH_OIDC_AUTO_LOGIN: 'true' } });

    expect(await readStatus(controller)).toMatchObject({ oidcAutoLogin: false });
    expect(await readStatus(controller)).toMatchObject({ oidcAutoLogin: false });
    expect(autoLoginWarnings()).toEqual([
      'OIDC auto-login is enabled but inactive because password login is enabled. It requires OIDC to be configured and password login to be disabled.',
    ]);
  });

  test('names every unmet requirement when OIDC is not configured', async () => {
    const { controller } = createController({
      env: { AUTH_ENABLED: 'true', CONFIG_AUTH_PASSWORD_LOGIN_ENABLED: 'false', CONFIG_AUTH_OIDC_AUTO_LOGIN: 'true' },
    });

    expect(await readStatus(controller)).toMatchObject({ oidcAutoLogin: false, passwordLoginDisabled: false });
    expect(autoLoginWarnings()).toEqual([
      'OIDC auto-login is enabled but inactive because OIDC is not configured, password login is enabled. It requires OIDC to be configured and password login to be disabled.',
    ]);
  });

  test('follows changes made in settings and logs when they leave it inactive', async () => {
    const { controller, database } = createController({ env: OIDC_ENV });
    const adminCookie = createAdminCookie(database);

    const enable = await putSettings(controller, adminCookie, { oidcAutoLogin: true });
    expect(enable.status).toBe(200);
    expect(await enable.json()).toMatchObject({ settings: { oidcAutoLogin: true, oidcAutoLoginActive: false } });
    expect(autoLoginWarnings()).toHaveLength(1);
    expect(autoLoginWarnings()[0]).toContain('because password login is enabled');
    expect(await readStatus(controller)).toMatchObject({ oidcAutoLogin: false });

    const disablePassword = await putSettings(controller, adminCookie, { disablePasswordLogin: true });
    expect(await disablePassword.json()).toMatchObject({ settings: { oidcAutoLogin: true, oidcAutoLoginActive: true } });
    expect(await readStatus(controller)).toMatchObject({ oidcAutoLogin: true });

    const settings = await controller.fetch(new Request('https://ui.example.com/crowdsec/api/auth/settings', {
      headers: { cookie: adminCookie },
    }));
    expect(await settings.json()).toMatchObject({ oidcAutoLogin: true, oidcAutoLoginActive: true });

    await putSettings(controller, adminCookie, { disablePasswordLogin: false });
    expect(await readStatus(controller)).toMatchObject({ oidcAutoLogin: false });
    expect(autoLoginWarnings()).toHaveLength(2);
  });
});
