import { expect, test } from 'vitest';
import { createAuthSessionCookie, createController } from './harness';

type Controller = ReturnType<typeof createController>['controller'];

const BASE = 'http://localhost/crowdsec/api/auth';

function jsonRequest(path: string, method: string, body: unknown, cookie = ''): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

async function setupAdmin(controller: Controller): Promise<string> {
  const response = await controller.fetch(jsonRequest('/setup', 'POST', { username: 'admin', password: 'Secret123' }));
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie') || '';
}

async function login(controller: Controller, username: string, password: string): Promise<Response> {
  return controller.fetch(jsonRequest('/login', 'POST', { username, password }));
}

async function listUsers(controller: Controller, cookie: string) {
  const response = await controller.fetch(new Request(`${BASE}/users`, { headers: { cookie } }));
  expect(response.status).toBe(200);
  return (await response.json() as { users: Array<Record<string, unknown>> }).users;
}

test('administrators create local users who must change the initial password', async () => {
  const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
  const adminCookie = await setupAdmin(controller);

  const created = await controller.fetch(jsonRequest('/users', 'POST', {
    username: 'viewer',
    password: 'Initial123',
    role: 'read-only',
  }, adminCookie));
  expect(created.status).toBe(201);
  expect((await created.json() as { user: unknown }).user).toMatchObject({
    username: 'viewer',
    role: 'read-only',
    source: 'local',
    disabled: false,
    passwordChangeRequired: true,
    current: false,
  });

  const duplicate = await controller.fetch(jsonRequest('/users', 'POST', {
    username: 'viewer',
    password: 'Initial123',
    role: 'admin',
  }, adminCookie));
  expect(duplicate.status).toBe(409);

  const weak = await controller.fetch(jsonRequest('/users', 'POST', { username: 'other', password: 'short', role: 'admin' }, adminCookie));
  expect(weak.status).toBe(400);

  const viewerLogin = await login(controller, 'viewer', 'Initial123');
  expect(viewerLogin.status).toBe(200);
  const viewerCookie = viewerLogin.headers.get('set-cookie') || '';

  const status = await controller.fetch(new Request(`${BASE}/status`, { headers: { cookie: viewerCookie } }));
  expect(await status.json()).toMatchObject({ authenticated: true, passwordChangeRequired: true });

  const blocked = await controller.fetch(new Request('http://localhost/crowdsec/api/config', { headers: { cookie: viewerCookie } }));
  expect(blocked.status).toBe(403);
  expect(await blocked.json()).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });

  const changed = await controller.fetch(jsonRequest('/change-password', 'POST', {
    currentPassword: 'Initial123',
    newPassword: 'Changed123',
  }, viewerCookie));
  expect(changed.status).toBe(200);
  const changedCookie = changed.headers.get('set-cookie') || '';

  const config = await controller.fetch(new Request('http://localhost/crowdsec/api/config', { headers: { cookie: changedCookie } }));
  expect(config.status).toBe(200);
  expect((await config.json() as { permissions: { mode: string } }).permissions.mode).toBe('read-only');

  const forbidden = await controller.fetch(new Request(`${BASE}/users`, { headers: { cookie: changedCookie } }));
  expect(forbidden.status).toBe(403);
});

test('administrators change roles, disable accounts and reset passwords', async () => {
  const { controller, database } = createController({ env: { AUTH_ENABLED: 'true' } });
  const adminCookie = await setupAdmin(controller);
  await controller.fetch(jsonRequest('/users', 'POST', {
    username: 'operator',
    password: 'Initial123',
    role: 'read-only',
    requirePasswordChange: false,
  }, adminCookie));
  const operatorId = database.getAuthUserByUsername('operator')!.id;

  const operatorLogin = await login(controller, 'operator', 'Initial123');
  const operatorCookie = operatorLogin.headers.get('set-cookie') || '';
  const operatorConfig = await controller.fetch(new Request('http://localhost/crowdsec/api/config', { headers: { cookie: operatorCookie } }));
  expect(operatorConfig.status).toBe(200);

  const promoted = await controller.fetch(jsonRequest(`/users/${operatorId}`, 'PATCH', { role: 'admin' }, adminCookie));
  expect(promoted.status).toBe(200);
  // The role change applies to the existing session right away.
  const promotedConfig = await controller.fetch(new Request('http://localhost/crowdsec/api/config', { headers: { cookie: operatorCookie } }));
  expect((await promotedConfig.json() as { permissions: { mode: string } }).permissions.mode).toBe('admin');

  const disabled = await controller.fetch(jsonRequest(`/users/${operatorId}`, 'PATCH', { disabled: true }, adminCookie));
  expect(disabled.status).toBe(200);
  const afterDisable = await controller.fetch(new Request('http://localhost/crowdsec/api/config', { headers: { cookie: operatorCookie } }));
  expect(afterDisable.status).toBe(401);
  const disabledLogin = await login(controller, 'operator', 'Initial123');
  expect(disabledLogin.status).toBe(403);

  await controller.fetch(jsonRequest(`/users/${operatorId}`, 'PATCH', { disabled: false }, adminCookie));
  const reset = await controller.fetch(jsonRequest(`/users/${operatorId}/password`, 'POST', { password: 'Temporary123' }, adminCookie));
  expect(reset.status).toBe(200);
  expect((await reset.json() as { user: unknown }).user).toMatchObject({ passwordChangeRequired: true });
  expect((await login(controller, 'operator', 'Initial123')).status).toBe(401);
  const resetLogin = await login(controller, 'operator', 'Temporary123');
  expect(resetLogin.status).toBe(200);
  const resetStatus = await controller.fetch(new Request(`${BASE}/status`, { headers: { cookie: resetLogin.headers.get('set-cookie') || '' } }));
  expect(await resetStatus.json()).toMatchObject({ passwordChangeRequired: true });
});

test('administrators reset second factors but cannot change their own account', async () => {
  const { controller, database } = createController({ env: { AUTH_ENABLED: 'true' } });
  const adminCookie = await setupAdmin(controller);
  const adminId = database.getAuthUserByUsername('admin')!.id;
  await controller.fetch(jsonRequest('/users', 'POST', { username: 'second', password: 'Initial123', role: 'admin' }, adminCookie));
  const second = database.getAuthUserByUsername('second')!;
  database.updateAuthUserTotp(second.id, 'secret', true);
  database.createWebAuthnCredential({
    userId: second.id,
    credentialId: 'credential-1',
    publicKey: 'public-key',
    signCount: 0,
    transports: null,
    name: 'Phone',
  });

  const listed = (await listUsers(controller, adminCookie)).find((user) => user.username === 'second');
  expect(listed).toMatchObject({ totpEnabled: true, passkeyCount: 1 });

  const resetMfa = await controller.fetch(jsonRequest(`/users/${second.id}/reset-mfa`, 'POST', {}, adminCookie));
  expect(resetMfa.status).toBe(200);
  expect((await resetMfa.json() as { user: unknown }).user).toMatchObject({ totpEnabled: false, passkeyCount: 0 });
  expect(database.listWebAuthnCredentialsByUser(second.id)).toEqual([]);

  const selfDelete = await controller.fetch(new Request(`${BASE}/users/${adminId}`, { method: 'DELETE', headers: { cookie: adminCookie } }));
  expect(selfDelete.status).toBe(400);
  expect(await selfDelete.json()).toEqual({ error: 'You cannot delete your own account' });
  for (const body of [{ role: 'read-only' }, { disabled: true }]) {
    const selfChange = await controller.fetch(jsonRequest(`/users/${adminId}`, 'PATCH', body, adminCookie));
    expect(selfChange.status).toBe(400);
  }
  expect(database.getAuthUserById(adminId)).toMatchObject({ role: 'admin', disabled: 0 });

  const missing = await controller.fetch(new Request(`${BASE}/users/9999`, { method: 'DELETE', headers: { cookie: adminCookie } }));
  expect(missing.status).toBe(404);
});

test('the last active administrator cannot lose admin access', async () => {
  const { controller, database } = createController({ env: { AUTH_ENABLED: 'true' } });
  const adminCookie = await setupAdmin(controller);
  const adminId = database.getAuthUserByUsername('admin')!.id;
  await controller.fetch(jsonRequest('/users', 'POST', {
    username: 'other',
    password: 'Initial123',
    role: 'admin',
    requirePasswordChange: false,
  }, adminCookie));
  const otherId = database.getAuthUserByUsername('other')!.id;
  const otherCookie = (await login(controller, 'other', 'Initial123')).headers.get('set-cookie') || '';

  // Two administrators demoting each other at the same time: the second change must not leave no admin.
  const [first, second] = await Promise.all([
    controller.fetch(jsonRequest(`/users/${otherId}`, 'PATCH', { role: 'read-only' }, adminCookie)),
    controller.fetch(jsonRequest(`/users/${adminId}`, 'PATCH', { role: 'read-only' }, otherCookie)),
  ]);
  expect([first.status, second.status].sort()).toEqual([200, 400]);
  expect(database.countActiveAdmins()).toBe(1);
});

test('OIDC users are listed read-only and can be deleted', async () => {
  const { controller, database } = createController({ env: { AUTH_ENABLED: 'true' } });
  const adminCookie = await setupAdmin(controller);
  const oidcUser = database.upsertOidcUser({ username: 'sso-user', role: 'read-only', issuer: 'https://idp.example', subject: 'sub-1' });
  database.db.prepare(`INSERT INTO saved_search_filters (id, owner_id, name, query, created_at, updated_at)
    VALUES ('filter-1', ?, 'Mine', 'ip:1.2.3.4', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run(oidcUser.id);
  const oidcCookie = createAuthSessionCookie(database, { userId: oidcUser.id, username: 'sso-user', role: 'read-only', authMethod: 'oidc' });

  const listed = (await listUsers(controller, adminCookie)).find((user) => user.username === 'sso-user');
  expect(listed).toMatchObject({ source: 'oidc', role: 'read-only' });

  const roleChange = await controller.fetch(jsonRequest(`/users/${oidcUser.id}`, 'PATCH', { role: 'admin' }, adminCookie));
  expect(roleChange.status).toBe(400);
  expect(await roleChange.json()).toEqual({ error: 'OIDC users are managed by the identity provider' });
  const passwordReset = await controller.fetch(jsonRequest(`/users/${oidcUser.id}/password`, 'POST', { password: 'Secret123' }, adminCookie));
  expect(passwordReset.status).toBe(400);

  const deleted = await controller.fetch(new Request(`${BASE}/users/${oidcUser.id}`, { method: 'DELETE', headers: { cookie: adminCookie } }));
  expect(deleted.status).toBe(200);
  expect(database.getAuthUserById(oidcUser.id)).toBeNull();
  expect(database.db.prepare('SELECT COUNT(*) AS count FROM saved_search_filters WHERE owner_id = ?').get(oidcUser.id)).toEqual({ count: 0 });

  const afterDelete = await controller.fetch(new Request('http://localhost/crowdsec/api/config', { headers: { cookie: oidcCookie } }));
  expect(afterDelete.status).toBe(401);
});

test('user management mutations are rejected on read-only instances', async () => {
  const { controller } = createController({ env: { AUTH_ENABLED: 'true', PERMISSION_READ_ONLY: 'true' } });
  const adminCookie = await setupAdmin(controller);
  expect((await listUsers(controller, adminCookie)).length).toBe(1);
  const created = await controller.fetch(jsonRequest('/users', 'POST', { username: 'x', password: 'Initial123', role: 'admin' }, adminCookie));
  expect(created.status).toBe(403);
});

test('the new password must differ from the current one', async () => {
  const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
  const adminCookie = await setupAdmin(controller);
  const response = await controller.fetch(jsonRequest('/change-password', 'POST', {
    currentPassword: 'Secret123',
    newPassword: 'Secret123',
  }, adminCookie));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'New password must be different from the current password' });
});

test('display preferences are saved per user', async () => {
  const { controller, database } = createController({ env: { AUTH_ENABLED: 'true' } });
  const adminCookie = await setupAdmin(controller);
  await controller.fetch(jsonRequest('/users', 'POST', {
    username: 'viewer',
    password: 'Initial123',
    role: 'read-only',
    requirePasswordChange: false,
  }, adminCookie));
  const viewerCookie = (await login(controller, 'viewer', 'Initial123')).headers.get('set-cookie') || '';
  const put = (path: string, body: unknown, cookie: string) => controller.fetch(new Request(`http://localhost/crowdsec/api/config/${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  }));
  const readConfig = async (cookie: string) => (await controller.fetch(new Request('http://localhost/crowdsec/api/config', { headers: { cookie } }))).json();
  const readStatus = async (cookie: string) => (await controller.fetch(new Request(`${BASE}/status`, { headers: { cookie } }))).json();

  // Read-only users may change their own sidebar, language and font.
  expect((await put('allowlists-sidebar', { visible: false }, viewerCookie)).status).toBe(200);
  expect((await put('metrics-sidebar', { visible: false }, viewerCookie)).status).toBe(200);
  expect((await put('language', { language: 'de' }, viewerCookie)).status).toBe(200);
  expect((await put('font', { font: 'inter' }, viewerCookie)).status).toBe(200);
  expect((await put('font', { font: '../evil' }, viewerCookie)).status).toBe(400);

  expect(await readConfig(viewerCookie)).toMatchObject({ allowlists_sidebar_visible: false, metrics_sidebar_visible: false });
  expect(await readConfig(adminCookie)).toMatchObject({ allowlists_sidebar_visible: true, metrics_sidebar_visible: true });
  expect(await readStatus(viewerCookie)).toMatchObject({ preferences: { language: 'de', font: 'inter' } });
  expect(await readStatus(adminCookie)).toMatchObject({ preferences: {} });
  // A read-only user's language does not change the instance-wide notification language.
  expect(database.getMeta('language')?.value).not.toBe('de');

  expect((await put('language', { language: 'fr' }, adminCookie)).status).toBe(200);
  expect(database.getMeta('language')?.value).toBe('fr');
});

test('sign-in configuration is only returned to administrators', async () => {
  const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
  const adminCookie = await setupAdmin(controller);
  await controller.fetch(jsonRequest('/users', 'POST', {
    username: 'viewer',
    password: 'Initial123',
    role: 'read-only',
    requirePasswordChange: false,
  }, adminCookie));
  const viewerCookie = (await login(controller, 'viewer', 'Initial123')).headers.get('set-cookie') || '';

  const viewerSettings = await (await controller.fetch(new Request(`${BASE}/settings`, { headers: { cookie: viewerCookie } }))).json();
  expect(viewerSettings).toEqual({ hasPassword: true, passkeysAvailable: true, totpEnabled: false, authMethod: 'password' });
  const adminSettings = await (await controller.fetch(new Request(`${BASE}/settings`, { headers: { cookie: adminCookie } }))).json();
  expect(adminSettings).toHaveProperty('oidcIssuerUrl');
});

test('passkeys and TOTP cannot be enrolled while a password change is pending', async () => {
  const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
  const adminCookie = await setupAdmin(controller);
  await controller.fetch(jsonRequest('/users', 'POST', { username: 'viewer', password: 'Initial123', role: 'read-only' }, adminCookie));
  const viewerCookie = (await login(controller, 'viewer', 'Initial123')).headers.get('set-cookie') || '';

  for (const path of ['/webauthn/register/options', '/webauthn/register/verify', '/totp/setup']) {
    const response = await controller.fetch(jsonRequest(path, 'POST', {}, viewerCookie));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
  }
});

test('passkey-only sign-in keeps an administrator with a passkey', async () => {
  const { controller, database } = createController({ env: { AUTH_ENABLED: 'true' } });
  await setupAdmin(controller);
  const addPasskey = (userId: number, credentialId: string) => database.createWebAuthnCredential({
    userId, credentialId, publicKey: 'public-key', signCount: 0, transports: null, name: null,
  });
  const adminId = database.getAuthUserByUsername('admin')!.id;
  const keeperId = database.createAuthUser({ username: 'keeper', passwordHash: 'hash', role: 'admin', authProvider: 'password' });
  const viewerId = database.createAuthUser({ username: 'viewer', passwordHash: 'hash', role: 'read-only', authProvider: 'password' });
  addPasskey(keeperId, 'keeper-key');
  addPasskey(viewerId, 'viewer-key');
  database.setMeta('auth_disable_password_login', 'true');
  // The acting administrator has no passkey, so "keeper" is the only administrator who can still sign in.
  const adminCookie = createAuthSessionCookie(database, { userId: adminId, username: 'admin', role: 'admin', authMethod: 'password' });

  const blocked = [
    jsonRequest(`/users/${keeperId}`, 'PATCH', { disabled: true }, adminCookie),
    jsonRequest(`/users/${keeperId}`, 'PATCH', { role: 'read-only' }, adminCookie),
    jsonRequest(`/users/${keeperId}/reset-mfa`, 'POST', {}, adminCookie),
    new Request(`${BASE}/users/${keeperId}`, { method: 'DELETE', headers: { cookie: adminCookie } }),
  ];
  for (const request of blocked) {
    const response = await controller.fetch(request);
    expect(response.status).toBe(400);
  }
  expect(database.getAuthUserById(keeperId)).toMatchObject({ role: 'admin', disabled: 0 });

  // The read-only user's passkey does not matter for administration.
  expect((await controller.fetch(jsonRequest(`/users/${viewerId}`, 'PATCH', { disabled: true }, adminCookie))).status).toBe(200);

  // The last administrator passkey cannot be deleted by its owner either.
  const keeperCookie = createAuthSessionCookie(database, { userId: keeperId, username: 'keeper', role: 'admin', authMethod: 'passkey' });
  const keeperKey = database.listWebAuthnCredentialsByUser(keeperId)[0]!;
  const deleteKey = await controller.fetch(new Request(`${BASE}/passkeys/${keeperKey.id}`, { method: 'DELETE', headers: { cookie: keeperCookie } }));
  expect(deleteKey.status).toBe(400);

  // Once another administrator has a passkey, "keeper" can be disabled.
  addPasskey(adminId, 'admin-key');
  expect((await controller.fetch(jsonRequest(`/users/${keeperId}`, 'PATCH', { disabled: true }, adminCookie))).status).toBe(200);
});

test('password login cannot be disabled while only non-administrators have passkeys', async () => {
  const { controller, database } = createController({ env: { AUTH_ENABLED: 'true' } });
  const adminCookie = await setupAdmin(controller);
  const viewerId = database.createAuthUser({ username: 'viewer', passwordHash: 'hash', role: 'read-only', authProvider: 'password' });
  database.createWebAuthnCredential({ userId: viewerId, credentialId: 'viewer-key', publicKey: 'public-key', signCount: 0, transports: null, name: null });

  const response = await controller.fetch(jsonRequest('/settings', 'PUT', { disablePasswordLogin: true }, adminCookie));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'Register a passkey for an administrator or configure OIDC before disabling password login' });
});
