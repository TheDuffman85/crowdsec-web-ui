import { describe, expect, test } from 'vitest';
import { generate } from 'otplib';
import { resolveOidcClaims, resolveOidcRole } from '../../app-auth';
import {
  createAuthSessionCookie,
  createController,
} from './harness';

test('dashboard auth protects API routes and allows initial setup login', async () => {
  const { controller } = createController({
    env: {
      AUTH_ENABLED: 'true',
    },
  });

  const unauthenticated = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
  expect(unauthenticated.status).toBe(401);

  const statusBeforeSetup = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/status'));
  expect(await statusBeforeSetup.json()).toMatchObject({
    authEnabled: true,
    setupRequired: true,
    authenticated: false,
  });

  const setup = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123' }),
  }));
  expect(setup.status).toBe(200);
  const cookie = setup.headers.get('set-cookie');
  expect(cookie).toContain('crowdsec_web_ui_session=');

  const authenticated = await controller.fetch(new Request('http://localhost/crowdsec/api/config', {
    headers: { cookie: cookie || '' },
  }));
  expect(authenticated.status).toBe(200);
  const payload = await authenticated.json() as { permissions?: { mode?: string } };
  expect(payload.permissions?.mode).toBe('admin');
});

test('security middleware applies CSP, private API caching, origin checks, and body limits', async () => {
  const { controller } = createController();

  const page = await controller.fetch(new Request('http://localhost/crowdsec/'));
  const pageHtml = await page.text();
  const csp = page.headers.get('content-security-policy') || '';
  const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
  expect(nonce).toBeTruthy();
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(pageHtml).toContain(`<script nonce="${nonce}">window.__BASE_PATH__="/crowdsec";</script>`);
  expect(page.headers.get('strict-transport-security')).toBeNull();

  const apiResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
  expect(apiResponse.headers.get('cache-control')).toBe('private, no-store');

  const crossOrigin = await controller.fetch(new Request('http://localhost/crowdsec/api/config/language', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
    body: JSON.stringify({ language: 'de' }),
  }));
  expect(crossOrigin.status).toBe(403);
  expect(await crossOrigin.json()).toEqual({ error: 'Cross-origin request rejected' });

  const oversized = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'x'.repeat(1024 * 1024) }),
  }));
  expect(oversized.status).toBe(413);
});

test('password throttling cannot be bypassed with spoofed forwarded addresses', async () => {
  const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
  await controller.fetch(new Request('http://localhost/crowdsec/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123' }),
  }));

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${attempt + 1}` },
      body: JSON.stringify({ username: 'admin', password: 'WrongSecret123' }),
    }));
    expect(response.status).toBe(401);
  }

  const throttled = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.250' },
    body: JSON.stringify({ username: 'admin', password: 'WrongSecret123' }),
  }));
  expect(throttled.status).toBe(429);
});

test('CrowdSec metrics endpoint is disabled until Prometheus URL is configured', async () => {
  const { controller } = createController();

  const configResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
  expect(await configResponse.json()).toEqual(expect.objectContaining({
    metrics_enabled: false,
    metrics_sidebar_visible: true,
  }));

  const response = await controller.fetch(new Request('http://localhost/crowdsec/api/metrics/crowdsec'));
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'CrowdSec Prometheus metrics are not enabled' });
});

test('config endpoint identifies the load-test deployment mode', async () => {
  const { controller } = createController({
    env: { CROWDSEC_WEB_UI_MODE: 'load-test', LOADTEST_PROFILE: 'blocklists-mixed' },
  });

  const response = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(expect.objectContaining({
    cache_last_update: null,
    deployment_mode: 'load-test',
    load_test_profile: 'blocklists-mixed',
  }));
});

test('CrowdSec metrics endpoint proxies and summarizes Prometheus metrics', async () => {
  const { controller } = createController({
    env: {
      CROWDSEC_PROMETHEUS_URL: 'http://crowdsec:6060/metrics',
    },
    metricsFetchResolver: async (url) => {
      expect(url).toBe('http://crowdsec:6060/metrics');
      return new Response(`
cs_lapi_bouncer_requests_total{bouncer="firewall",route="/v1/decisions",method="GET"} 7
cs_lapi_machine_requests_total{machine="edge-1",route="/v1/alerts",method="GET"} 3
cs_appsec_reqs_total{source="0.0.0.0:7422",appsec_engine="appsec"} 11
cs_appsec_block_total{source="0.0.0.0:7422",appsec_engine="appsec"} 2
cs_parser_hits_total{source="/var/log/auth.log",type="syslog"} 20
cs_parser_hits_ok_total{source="/var/log/auth.log",type="syslog",acquis_type="file"} 19
cs_parser_hits_ko_total{source="/var/log/auth.log",type="syslog",acquis_type="file"} 1
cs_node_wl_hits_total{name="crowdsecurity/whitelists",source="/var/log/auth.log",type="syslog",reason="private",stage="s02-enrich",acquis_type="file"} 5
cs_node_wl_hits_ok_total{name="crowdsecurity/whitelists",source="/var/log/auth.log",type="syslog",reason="private",stage="s02-enrich",acquis_type="file"} 3
`, { status: 200 });
    },
  });

  const configResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
  expect(await configResponse.json()).toEqual(expect.objectContaining({
    metrics_enabled: true,
    metrics_sidebar_visible: true,
  }));

  const response = await controller.fetch(new Request('http://localhost/crowdsec/api/metrics/crowdsec'));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(expect.objectContaining({
    totals: expect.objectContaining({
      bouncerRequests: 7,
      machineRequests: 3,
      appsecRequests: 11,
      appsecBlocked: 2,
      parserProcessed: 20,
      parserOk: 19,
      parserKo: 1,
      whitelistHits: 5,
      whitelisted: 3,
    }),
    bouncers: [expect.objectContaining({ name: 'firewall', requests: 7 })],
    machines: [expect.objectContaining({ name: 'edge-1', requests: 3 })],
    parserSources: [expect.objectContaining({ source: '/var/log/auth.log', successRate: 0.95 })],
    whitelists: [expect.objectContaining({ name: 'crowdsecurity/whitelists', reason: 'private', hits: 5, whitelisted: 3 })],
  }));

  const preferenceResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/config/metrics-sidebar', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visible: false }),
  }));
  expect(preferenceResponse.status).toBe(200);
  expect(await preferenceResponse.json()).toEqual({ success: true, metrics_sidebar_visible: false });

  const updatedConfigResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
  expect(await updatedConfigResponse.json()).toEqual(expect.objectContaining({ metrics_sidebar_visible: false }));
});

test('dashboard auth exposes account settings and password changes', async () => {
  const { controller, database } = createController({
    env: {
      AUTH_ENABLED: 'true',
    },
  });

  const setup = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123' }),
  }));
  const cookie = setup.headers.get('set-cookie') || '';

  const settings = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/settings', {
    headers: { cookie },
  }));
  expect(settings.status).toBe(200);
  expect(await settings.json()).toMatchObject({
    disablePasswordLogin: false,
    oidcIssuerUrl: '',
    oidcClientId: '',
    hasOidcClientSecret: false,
    oidcScope: 'openid profile email',
    oidcGroupsClaim: 'groups',
    oidcAdminGroups: '',
    oidcReadOnlyGroups: '',
    oidcUnmatchedRole: 'deny',
    hasPassword: true,
    passkeysAvailable: true,
    totpEnabled: false,
    authMethod: 'password',
  });

  const passkeyCookie = createAuthSessionCookie(database, {
    userId: 1,
    username: 'admin',
    role: 'admin',
    authMethod: 'passkey',
  });
  const passkeySettings = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/settings', {
    headers: { cookie: passkeyCookie },
  }));
  expect(passkeySettings.status).toBe(200);
  expect(await passkeySettings.json()).toMatchObject({
    hasPassword: true,
    totpEnabled: false,
    authMethod: 'passkey',
  });

  const passkeyPasswordChange = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: passkeyCookie },
    body: JSON.stringify({ currentPassword: 'Secret123', newPassword: 'NewSecret123' }),
  }));
  expect(passkeyPasswordChange.status).toBe(403);

  const saveGroupMapping = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({
      oidcGroupsClaim: 'roles',
      oidcScope: 'openid profile email groups offline_access',
      oidcAdminGroups: 'admins, secops, admins',
      oidcReadOnlyGroups: 'viewers',
      oidcUnmatchedRole: 'admin',
    }),
  }));
  expect(saveGroupMapping.status).toBe(200);
  expect(await saveGroupMapping.json()).toMatchObject({
    settings: {
      oidcGroupsClaim: 'roles',
      oidcScope: 'openid profile email groups offline_access',
      oidcAdminGroups: 'admins,secops',
      oidcReadOnlyGroups: 'viewers',
      oidcUnmatchedRole: 'admin',
    },
  });

  const invalidScope = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ oidcScope: 'profile email groups' }),
  }));
  expect(invalidScope.status).toBe(400);
  expect(await invalidScope.json()).toMatchObject({
    error: 'OIDC scopes must include openid',
  });

  const disableWithoutAlternative = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ disablePasswordLogin: true }),
  }));
  expect(disableWithoutAlternative.status).toBe(400);

  const wrongCurrentPassword = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ currentPassword: 'WrongSecret123', newPassword: 'NewSecret123' }),
  }));
  expect(wrongCurrentPassword.status).toBe(401);

  const changePassword = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ currentPassword: 'Secret123', newPassword: 'NewSecret123' }),
  }));
  expect(changePassword.status).toBe(200);
  const refreshedCookie = changePassword.headers.get('set-cookie') || '';
  expect(refreshedCookie).toContain('crowdsec_web_ui_session=');

  const revokedOldSession = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/settings', {
    headers: { cookie },
  }));
  expect(revokedOldSession.status).toBe(401);
  const refreshedSession = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/settings', {
    headers: { cookie: refreshedCookie },
  }));
  expect(refreshedSession.status).toBe(200);

  const oldLogin = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123' }),
  }));
  expect(oldLogin.status).toBe(401);

  const newLogin = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'NewSecret123' }),
  }));
  expect(newLogin.status).toBe(200);
});

test('OIDC-only users cannot persist SSO access by registering or using passkeys', async () => {
  const { controller, database } = createController({ env: { AUTH_ENABLED: 'true' } });
  const user = database.upsertOidcUser({
    username: 'oidc-admin',
    role: 'admin',
    issuer: 'https://idp.example.com',
    subject: 'oidc-subject',
  });
  const oidcCookie = createAuthSessionCookie(database, {
    userId: user.id,
    username: user.username,
    role: user.role,
    authMethod: 'oidc',
  });

  const settings = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/settings', {
    headers: { cookie: oidcCookie },
  }));
  expect(settings.status).toBe(200);
  expect(await settings.json()).toMatchObject({
    hasPassword: false,
    passkeysAvailable: false,
    authMethod: 'oidc',
  });

  const passkeys = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/passkeys', {
    headers: { cookie: oidcCookie },
  }));
  expect(passkeys.status).toBe(403);
  expect(await passkeys.json()).toMatchObject({
    error: 'Passkeys are unavailable for OIDC-only accounts',
  });

  const registration = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/webauthn/register/options', {
    method: 'POST',
    headers: { cookie: oidcCookie },
  }));
  expect(registration.status).toBe(403);
  expect(await registration.json()).toMatchObject({
    error: 'Passkeys cannot be registered for OIDC-only accounts',
  });

  database.createWebAuthnCredential({
    userId: user.id,
    credentialId: 'oidc-only-passkey',
    publicKey: 'unused-for-oidc-only-account',
    signCount: 0,
    transports: '[]',
    name: 'Legacy passkey',
  });
  const loginOptions = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/webauthn/login/options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user.username }),
  }));
  const blockedPasskeyLogin = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/webauthn/login/verify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: loginOptions.headers.get('set-cookie') || '',
    },
    body: JSON.stringify({ id: 'oidc-only-passkey' }),
  }));
  expect(blockedPasskeyLogin.status).toBe(403);
  expect(await blockedPasskeyLogin.json()).toMatchObject({
    error: 'This passkey belongs to an OIDC-only account. Sign in with SSO instead.',
  });

  const now = Math.floor(Date.now() / 1000);
  const staleOidcCookie = createAuthSessionCookie(database, {
    userId: user.id,
    username: user.username,
    role: user.role,
    authMethod: 'oidc',
  }, undefined, {
    issuedAt: now - 25 * 60 * 60,
    expiresAt: now + 60 * 60,
  });
  const staleSession = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/settings', {
    headers: { cookie: staleOidcCookie },
  }));
  expect(staleSession.status).toBe(401);
});

test('dashboard auth supports optional TOTP for password login', async () => {
  const { controller, database } = createController({
    env: {
      AUTH_ENABLED: 'true',
    },
  });

  const setup = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123' }),
  }));
  const sessionCookie = setup.headers.get('set-cookie') || '';

  const totpSetup = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/totp/setup', {
    method: 'POST',
    headers: { cookie: sessionCookie },
  }));
  expect(totpSetup.status).toBe(200);
  const totpSetupPayload = await totpSetup.json() as { secret: string; otpauthUrl: string };
  expect(totpSetupPayload.secret).toMatch(/^[A-Z2-7]+$/);
  expect(totpSetupPayload.otpauthUrl).toContain('otpauth://totp/');
  expect(totpSetupPayload.otpauthUrl).toContain('issuer=CrowdSec%20Web%20UI');

  const setupCookie = totpSetup.headers.get('set-cookie') || '';
  const malformedEnableTotp = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/totp/enable', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: `${sessionCookie}; ${setupCookie.split(';')[0]}`,
    },
    body: JSON.stringify({ code: 'not-a-code' }),
  }));
  expect(malformedEnableTotp.status).toBe(400);
  expect(await malformedEnableTotp.json()).toMatchObject({ error: 'Invalid authenticator code' });

  const enableTotp = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/totp/enable', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: `${sessionCookie}; ${setupCookie.split(';')[0]}`,
    },
    body: JSON.stringify({ code: await generate({ secret: totpSetupPayload.secret }) }),
  }));
  expect(enableTotp.status).toBe(200);
  expect(await enableTotp.json()).toMatchObject({ totpEnabled: true });
  const user = database.getAuthUserByUsername('admin');
  expect(user?.totp_enabled).toBe(1);
  expect(user?.totp_secret).toMatch(/^enc:v1:/);
  expect(database.getMeta('auth_session_secret')?.value).toBeTruthy();

  const setupAlreadyEnabled = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/totp/setup', {
    method: 'POST',
    headers: { cookie: sessionCookie },
  }));
  expect(setupAlreadyEnabled.status).toBe(400);
  expect(await setupAlreadyEnabled.json()).toMatchObject({ error: 'TOTP is already enabled for this account' });

  const disableWithoutPassword = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/totp', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
    body: JSON.stringify({}),
  }));
  expect(disableWithoutPassword.status).toBe(400);
  expect(await disableWithoutPassword.json()).toMatchObject({
    error: 'Current password required',
  });

  const passwordOnlyLogin = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123' }),
  }));
  expect(passwordOnlyLogin.status).toBe(401);
  expect(await passwordOnlyLogin.json()).toMatchObject({ requiresTotp: true });

  const invalidTotpLogin = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123', totpCode: '000000' }),
  }));
  expect(invalidTotpLogin.status).toBe(401);
  expect(await invalidTotpLogin.json()).toMatchObject({ requiresTotp: true });

  const validTotpCode = await generate({ secret: totpSetupPayload.secret });
  const validTotpLogin = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123', totpCode: validTotpCode }),
  }));
  expect(validTotpLogin.status).toBe(200);

  const replayedTotpLogin = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123', totpCode: validTotpCode }),
  }));
  expect(replayedTotpLogin.status).toBe(401);
  expect(await replayedTotpLogin.json()).toMatchObject({ requiresTotp: true });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const throttledSoon = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Secret123', totpCode: '000000' }),
    }));
    expect(throttledSoon.status).toBe(401);
  }
  const throttledTotpLogin = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123', totpCode: '000000' }),
  }));
  expect(throttledTotpLogin.status).toBe(429);
  expect(throttledTotpLogin.headers.get('retry-after')).toBeTruthy();

  const disableTotp = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/totp', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
    body: JSON.stringify({ currentPassword: 'Secret123' }),
  }));
  expect(disableTotp.status).toBe(200);
  expect(await disableTotp.json()).toMatchObject({ totpEnabled: false });
  expect(database.getAuthUserByUsername('admin')?.totp_enabled).toBe(0);
});

test('dashboard auth enforces an environment-configured TOTP seed for the password user', async () => {
  const totpSeed = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const { controller, database } = createController({
    env: {
      AUTH_ENABLED: 'true',
      AUTH_TOTP_SEED: totpSeed,
    },
  });

  const setup = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123' }),
  }));
  const sessionCookie = setup.headers.get('set-cookie') || '';
  expect(database.getAuthUserByUsername('admin')).toMatchObject({ totp_enabled: 0, totp_secret: null });

  const status = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/status', {
    headers: { cookie: sessionCookie },
  }));
  expect(await status.json()).toMatchObject({ totpEnabled: true });

  const totpSetup = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/totp/setup', {
    method: 'POST',
    headers: { cookie: sessionCookie },
  }));
  expect(totpSetup.status).toBe(400);
  expect(await totpSetup.json()).toMatchObject({ error: 'TOTP is already enabled for this account' });

  const passwordOnlyLogin = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123' }),
  }));
  expect(passwordOnlyLogin.status).toBe(401);
  expect(await passwordOnlyLogin.json()).toMatchObject({ requiresTotp: true });

  const validLogin = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'admin',
      password: 'Secret123',
      totpCode: await generate({ secret: totpSeed }),
    }),
  }));
  expect(validLogin.status).toBe(200);

  const disableTotp = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/totp', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
    body: JSON.stringify({ currentPassword: 'Secret123' }),
  }));
  expect(disableTotp.status).toBe(400);
  expect(await disableTotp.json()).toMatchObject({
    error: 'TOTP is managed by the application configuration and cannot be disabled from Settings',
  });
});

test('dashboard auth auto-generates an auth secret for new TOTP setup', async () => {
  const { controller, database } = createController({
    env: {
      AUTH_ENABLED: 'true',
    },
  });

  const setup = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123' }),
  }));
  const sessionCookie = setup.headers.get('set-cookie') || '';

  const totpSetup = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/totp/setup', {
    method: 'POST',
    headers: { cookie: sessionCookie },
  }));
  expect(totpSetup.status).toBe(200);
  expect(database.getMeta('auth_session_secret')?.value).toBeTruthy();
});

test('dashboard auth uses the configured TOTP encryption secret and prefers the database seed', async () => {
  const { controller, database } = createController({
    env: {
      AUTH_ENABLED: 'true',
      AUTH_SECRET: 'first-session-secret',
      AUTH_TOTP_SECRET: 'stable-totp-secret',
    },
  });

  const setup = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123' }),
  }));
  const sessionCookie = setup.headers.get('set-cookie') || '';
  const totpSetup = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/totp/setup', {
    method: 'POST',
    headers: { cookie: sessionCookie },
  }));
  const totpSetupPayload = await totpSetup.json() as { secret: string };
  const setupCookie = totpSetup.headers.get('set-cookie') || '';
  const enableTotp = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/totp/enable', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: `${sessionCookie}; ${setupCookie.split(';')[0]}`,
    },
    body: JSON.stringify({ code: await generate({ secret: totpSetupPayload.secret }) }),
  }));
  expect(enableTotp.status).toBe(200);

  const { controller: restartedController } = createController({
    database,
    env: {
      AUTH_ENABLED: 'true',
      AUTH_SECRET: 'second-session-secret',
      AUTH_TOTP_SECRET: 'stable-totp-secret',
      AUTH_TOTP_SEED: 'NB2W45DFOIZGS3THNB2W45DFOIZGS3TH',
    },
  });
  const login = await restartedController.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'admin',
      password: 'Secret123',
      totpCode: await generate({ secret: totpSetupPayload.secret }),
    }),
  }));
  expect(login.status).toBe(200);
});

test('dashboard auth settings use OIDC environment values as defaults', async () => {
  const { controller } = createController({
    env: {
      AUTH_ENABLED: 'true',
      AUTH_OIDC_ISSUER_URL: 'https://idp.example.com/application/o/crowdsec/',
      AUTH_OIDC_CLIENT_ID: 'crowdsec-client',
      AUTH_OIDC_CLIENT_SECRET: 'oidc-secret',
      AUTH_OIDC_SCOPE: 'openid profile email roles',
      AUTH_OIDC_GROUPS_CLAIM: 'roles',
      AUTH_OIDC_ADMIN_GROUPS: 'admins,secops',
      AUTH_OIDC_READ_ONLY_GROUPS: 'viewers',
      AUTH_OIDC_UNMATCHED_ROLE: 'read-only',
    },
  });

  const setup = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123' }),
  }));
  const cookie = setup.headers.get('set-cookie') || '';

  const settings = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/settings', {
    headers: { cookie },
  }));
  expect(settings.status).toBe(200);
  expect(await settings.json()).toMatchObject({
    oidcIssuerUrl: 'https://idp.example.com/application/o/crowdsec/',
    oidcClientId: 'crowdsec-client',
    hasOidcClientSecret: true,
    oidcScope: 'openid profile email roles',
    oidcGroupsClaim: 'roles',
    oidcAdminGroups: 'admins,secops',
    oidcReadOnlyGroups: 'viewers',
    oidcUnmatchedRole: 'read-only',
  });
});

describe('OIDC role mapping', () => {
  const baseConfig = {
    oidcAdminGroups: ['admins'],
    oidcReadOnlyGroups: ['viewers'],
    oidcUnmatchedRole: 'deny' as const,
  };

  test('uses matching groups before the unmatched-user policy', () => {
    expect(resolveOidcRole(baseConfig, ['admins'])).toBe('admin');
    expect(resolveOidcRole(baseConfig, ['viewers'])).toBe('read-only');
    expect(resolveOidcRole(baseConfig, ['admins', 'viewers'])).toBe('admin');
  });

  test('applies the configured unmatched-user policy when no group matches', () => {
    expect(resolveOidcRole({ ...baseConfig, oidcUnmatchedRole: 'deny' }, ['auditors'])).toBeNull();
    expect(resolveOidcRole({ ...baseConfig, oidcUnmatchedRole: 'admin' }, ['auditors'])).toBe('admin');
    expect(resolveOidcRole({ ...baseConfig, oidcUnmatchedRole: 'read-only' }, ['auditors'])).toBe('read-only');
  });

  test('also applies the unmatched-user policy when group lists are empty', () => {
    const emptyGroups = { oidcAdminGroups: [], oidcReadOnlyGroups: [], oidcUnmatchedRole: 'deny' as const };
    expect(resolveOidcRole(emptyGroups, ['admins'])).toBeNull();
    expect(resolveOidcRole({ ...emptyGroups, oidcUnmatchedRole: 'admin' }, [])).toBe('admin');
    expect(resolveOidcRole({ ...emptyGroups, oidcUnmatchedRole: 'read-only' }, [])).toBe('read-only');
  });
});

describe('resolveOidcClaims', () => {
  const config = {
    oidcGroupsClaim: 'https://sso.example.net/roles',
    oidcAdminGroups: ['crowdsec-ui.crowdsec-admin'],
    oidcReadOnlyGroups: ['crowdsec-ui.crowdsec-viewer'],
    oidcUnmatchedRole: 'deny' as const,
  };

  test('resolves username and role from UserInfo when the ID token is minimal', () => {
    const idClaims = { iss: 'https://sso.example.net', sub: '1' };
    const userinfo = {
      sub: '1',
      email: 'admin@example.com',
      name: 'Example Admin',
      'https://sso.example.net/roles': ['crowdsec-ui.crowdsec-admin'],
    };
    expect(resolveOidcClaims(idClaims, userinfo, config)).toEqual({
      username: 'admin@example.com',
      role: 'admin',
    });
  });

  test('falls back to ID-token claims when UserInfo is absent', () => {
    const idClaims = {
      sub: '1',
      preferred_username: 'id-token-user',
      'https://sso.example.net/roles': ['crowdsec-ui.crowdsec-viewer'],
    };
    expect(resolveOidcClaims(idClaims, undefined, config)).toEqual({
      username: 'id-token-user',
      role: 'read-only',
    });
  });

  test('unions groups so an empty UserInfo groups value cannot erase ID-token groups', () => {
    const idClaims = {
      sub: '1',
      email: 'user@example.com',
      'https://sso.example.net/roles': ['crowdsec-ui.crowdsec-admin'],
    };
    const userinfo = { sub: '1', 'https://sso.example.net/roles': [] as string[] };
    expect(resolveOidcClaims(idClaims, userinfo, config)?.role).toBe('admin');
  });

  test('unions groups drawn from both sources', () => {
    const idClaims = { sub: '1', email: 'user@example.com', 'https://sso.example.net/roles': ['crowdsec-ui.crowdsec-viewer'] };
    const userinfo = { sub: '1', 'https://sso.example.net/roles': ['crowdsec-ui.crowdsec-admin'] };
    // admin wins over read-only via resolveOidcRole precedence
    expect(resolveOidcClaims(idClaims, userinfo, config)?.role).toBe('admin');
  });

  test('returns null when no username claim can be resolved', () => {
    const idClaims = { iss: 'https://sso.example.net' };
    expect(resolveOidcClaims(idClaims, {}, config)).toBeNull();
  });
});
