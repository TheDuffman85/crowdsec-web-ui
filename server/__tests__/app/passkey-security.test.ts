import crypto from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { createAuthSessionCookie, createController, destroyTempDir } from './harness';

let active: ReturnType<typeof createController> | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  active?.controller.stopBackgroundTasks();
  active?.database.close();
  destroyTempDir();
  active = undefined;
});

function setup() {
  active = createController({ env: { AUTH_ENABLED: 'true' } });
  const { controller, database } = active;
  const userId = database.createAuthUser({ username: 'admin', passwordHash: 'unused', role: 'admin', authProvider: 'password' });
  const cookie = createAuthSessionCookie(database, { userId, username: 'admin', role: 'admin', authMethod: 'password' });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x!, 'base64url'), Buffer.from('225820', 'hex'), Buffer.from(jwk.y!, 'base64url')]);
  const credentialId = Buffer.from('test-credential').toString('base64url');
  const id = database.createWebAuthnCredential({ userId, credentialId, publicKey: cose.toString('base64url'), signCount: 0, transports: '[]', name: 'Passkey' });
  const request = (path: string, method: string, body?: unknown, requestCookie = cookie) => controller.fetch(new Request(`http://localhost/crowdsec/api/auth${path}`, {
    method, headers: { 'Content-Type': 'application/json', cookie: requestCookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  function assertion(challenge: string) {
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: 'http://localhost' }));
    const authData = Buffer.concat([crypto.createHash('sha256').update('localhost').digest(), Buffer.from([5, 0, 0, 0, 0])]);
    const signature = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(clientData).digest()]), privateKey);
    return { id: credentialId, rawId: credentialId, type: 'public-key', response: { clientDataJSON: clientData.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url') }, clientExtensionResults: {} };
  }
  async function options() {
    const response = await request('/webauthn/login/options', 'POST', {}, '');
    return { challenge: (await response.json()).challenge as string, cookie: response.headers.get('set-cookie')!.split(';')[0] };
  }
  return { database, userId, id, request, assertion, options };
}

test('accepts an issued assertion once, rejecting replay even with a zero counter', async () => {
  const { request, assertion, options } = setup();
  const issued = await options();
  const body = assertion(issued.challenge);
  const response = await request('/webauthn/login/verify', 'POST', body, issued.cookie);
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toContain('crowdsec_web_ui_session=');
  expect((await request('/webauthn/login/verify', 'POST', body, issued.cookie)).status).toBe(400);
});

test('rejects caller-selected and expired challenges', async () => {
  const { request, assertion, options } = setup();
  const forged = Buffer.from('never-issued').toString('base64url');
  expect((await request('/webauthn/login/verify', 'POST', assertion(forged), `crowdsec_web_ui_webauthn_challenge=${forged}`)).status).toBe(400);
  const issued = await options();
  const later = Date.now() + 300_001;
  vi.spyOn(Date, 'now').mockReturnValue(later);
  expect((await request('/webauthn/login/verify', 'POST', assertion(issued.challenge), issued.cookie)).status).toBe(400);
});

test('consumes challenges before asynchronous verification and binds ceremony purpose', async () => {
  const { request, assertion, options } = setup();
  const issued = await options();
  const results = await Promise.all([1, 2].map(() => request('/webauthn/login/verify', 'POST', assertion(issued.challenge), issued.cookie)));
  expect(results.map(response => response.status).sort()).toEqual([200, 400]);
  const registration = await request('/webauthn/register/options', 'POST');
  const challenge = (await registration.json()).challenge;
  const cookie = registration.headers.get('set-cookie')!.split(';')[0];
  expect((await request('/webauthn/login/verify', 'POST', assertion(challenge), cookie)).status).toBe(400);
});

test('protects the last passkey until password login is re-enabled', async () => {
  const { request, id } = setup();
  expect((await request('/settings', 'PUT', { disablePasswordLogin: true })).status).toBe(200);
  expect((await request(`/passkeys/${id}`, 'DELETE')).status).toBe(400);
  expect((await request('/status', 'GET')).status).toBe(200);
  expect((await request('/settings', 'PUT', { disablePasswordLogin: false })).status).toBe(200);
  expect((await request(`/passkeys/${id}`, 'DELETE')).status).toBe(200);
});

test('evaluates the final authentication configuration atomically', async () => {
  const { request, id, database } = setup();
  database.setMeta('auth_oidc_issuer_url', 'https://idp.example');
  database.setMeta('auth_oidc_client_id', 'client');
  expect((await request(`/passkeys/${id}`, 'DELETE')).status).toBe(200);
  expect((await request('/settings', 'PUT', { disablePasswordLogin: true })).status).toBe(200);
  expect((await request('/settings', 'PUT', { oidcIssuerUrl: '', oidcClientId: '' })).status).toBe(400);
  expect(database.getMeta('auth_oidc_client_id')?.value).toBe('client');
  expect((await request('/settings', 'PUT', { disablePasswordLogin: false, oidcScope: 'invalid' })).status).toBe(400);
  expect(database.getMeta('auth_disable_password_login')?.value).toBe('true');
  expect((await request('/settings', 'PUT', { disablePasswordLogin: false, oidcIssuerUrl: '', oidcClientId: '' })).status).toBe(200);
});

test('concurrent removals cannot delete all remaining passkeys', async () => {
  const { request, database, userId, id } = setup();
  const secondId = database.createWebAuthnCredential({ userId, credentialId: 'second', publicKey: 'unused', signCount: 0, transports: '[]', name: 'Second' });
  expect((await request('/settings', 'PUT', { disablePasswordLogin: true })).status).toBe(200);
  const responses = await Promise.all([id, secondId].map(credentialId => request(`/passkeys/${credentialId}`, 'DELETE')));
  expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
  expect(database.listWebAuthnCredentialsByUser(userId)).toHaveLength(1);
});
