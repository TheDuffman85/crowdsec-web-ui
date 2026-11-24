import { describe, expect, test, vi } from 'vitest';
import { createController } from './harness';

type Controller = ReturnType<typeof createController>['controller'];

const BASE = 'http://localhost/crowdsec/api/auth';

const json = (path: string, method: string, body: unknown, headers: Record<string, string> = {}) => new Request(`${BASE}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

async function setupAdmin(controller: Controller): Promise<string> {
  const response = await controller.fetch(json('/setup', 'POST', { username: 'admin', password: 'Secret123' }));
  expect(response.status).toBe(200);
  return (response.headers.get('set-cookie') || '').split(';')[0];
}

async function createViewer(controller: Controller, adminCookie: string): Promise<void> {
  const created = await controller.fetch(json('/users', 'POST', { username: 'viewer', password: 'Initial123', role: 'read-only' }, { cookie: adminCookie }));
  expect(created.status).toBe(201);
  // Clear the forced password change so the viewer can use the app.
  const id = (await created.json() as { user: { id: number } }).user.id;
  controller.database.db.query('UPDATE auth_users SET password_change_required = 0 WHERE id = ?').run(id);
}

async function signIn(controller: Controller, username: string, password: string, headers: Record<string, string> = {}): Promise<string> {
  const response = await controller.fetch(json('/login', 'POST', { username, password }, headers));
  expect(response.status).toBe(200);
  return (response.headers.get('set-cookie') || '').split(';')[0];
}

const get = async (controller: Controller, path: string, cookie: string): Promise<Response> =>
  await controller.fetch(new Request(`${BASE}${path}`, { headers: { cookie } }));

type SessionRow = { id: string; username: string; method: string; current: boolean; ip: string | null; user_agent: string | null };
const sessions = async (controller: Controller, cookie: string, query = ''): Promise<SessionRow[]> =>
  (await get(controller, `/sessions${query}`, cookie).then((response) => response.json()) as { sessions: SessionRow[] }).sessions;

describe('last sign-in', () => {
  test('shows when and how each user last signed in', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
    const adminCookie = await setupAdmin(controller);
    await createViewer(controller, adminCookie);
    await vi.waitFor(async () => {
      const users = await get(controller, '/users', adminCookie).then((response) => response.json()) as { users: Array<{ username: string; lastLoginAt: string | null }> };
      expect(users.users.find((user) => user.username === 'admin')?.lastLoginAt).toBeTruthy();
    });

    let users = (await get(controller, '/users', adminCookie).then((response) => response.json()) as { users: Array<Record<string, unknown>> }).users;
    expect(users.find((user) => user.username === 'viewer')).toMatchObject({ lastLoginAt: null, lastLoginMethod: null });
    expect(users.find((user) => user.username === 'admin')).toMatchObject({ lastLoginMethod: 'password' });

    await signIn(controller, 'viewer', 'Initial123');
    await vi.waitFor(async () => {
      users = (await get(controller, '/users', adminCookie).then((response) => response.json()) as { users: Array<Record<string, unknown>> }).users;
      expect(users.find((user) => user.username === 'viewer')?.lastLoginAt).toBeTruthy();
    });
    expect(users.find((user) => user.username === 'viewer')).toMatchObject({ lastLoginMethod: 'password' });
  });
});

describe('active sessions', () => {
  test('lists a user\'s own sessions with device details and marks the current one', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
    const adminCookie = await setupAdmin(controller);
    await createViewer(controller, adminCookie);
    const phone = await signIn(controller, 'viewer', 'Initial123', { 'user-agent': 'Phone Browser', 'x-forwarded-for': '203.0.113.7, 10.0.0.1' });
    const laptop = await signIn(controller, 'viewer', 'Initial123', { 'user-agent': 'Laptop Browser' });
    await vi.waitFor(async () => expect(await sessions(controller, phone)).toHaveLength(2));

    const own = await sessions(controller, phone);
    expect(own.map((session) => session.username)).toEqual(['viewer', 'viewer']);
    expect(own.filter((session) => session.current)).toHaveLength(1);
    const phoneSession = own.find((session) => session.current)!;
    expect(phoneSession).toMatchObject({ user_agent: 'Phone Browser', ip: '203.0.113.7', method: 'password' });
    expect((await sessions(controller, laptop)).find((session) => session.current)?.user_agent).toBe('Laptop Browser');
  });

  test('only administrators list everyone\'s sessions', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
    const adminCookie = await setupAdmin(controller);
    await createViewer(controller, adminCookie);
    const viewer = await signIn(controller, 'viewer', 'Initial123');
    await vi.waitFor(async () => expect((await sessions(controller, adminCookie, '?all=1')).length).toBeGreaterThanOrEqual(2));

    expect((await sessions(controller, adminCookie, '?all=1')).map((session) => session.username).sort()).toEqual(['admin', 'viewer']);
    expect((await get(controller, '/sessions?all=1', viewer)).status).toBe(403);
    expect((await sessions(controller, adminCookie)).map((session) => session.username)).toEqual(['admin']);
    expect((await get(controller, '/sessions', '')).status).toBe(401);
  });

  test('an administrator can revoke another user\'s session, which then stops working', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
    const adminCookie = await setupAdmin(controller);
    await createViewer(controller, adminCookie);
    const viewer = await signIn(controller, 'viewer', 'Initial123');
    await vi.waitFor(async () => expect((await sessions(controller, viewer)).length).toBe(1));
    const target = (await sessions(controller, viewer))[0];

    expect((await get(controller, '/me', viewer)).status).toBe(200);
    const revoke = await controller.fetch(new Request(`${BASE}/sessions/${target.id}`, { method: 'DELETE', headers: { cookie: adminCookie } }));
    expect(revoke.status).toBe(200);
    expect((await get(controller, '/me', viewer)).status).toBe(401);
    expect((await sessions(controller, adminCookie, '?all=1')).some((session) => session.id === target.id)).toBe(false);
    const again = await controller.fetch(new Request(`${BASE}/sessions/${target.id}`, { method: 'DELETE', headers: { cookie: adminCookie } }));
    expect(again.status).toBe(404);
  });

  test('people can end their own sessions but not other people\'s', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
    const adminCookie = await setupAdmin(controller);
    await createViewer(controller, adminCookie);
    const viewerOne = await signIn(controller, 'viewer', 'Initial123');
    const viewerTwo = await signIn(controller, 'viewer', 'Initial123');
    await vi.waitFor(async () => expect((await sessions(controller, viewerOne)).length).toBe(2));
    await vi.waitFor(async () => expect((await sessions(controller, adminCookie, '?all=1')).length).toBe(3));

    const all = await sessions(controller, adminCookie, '?all=1');
    const adminSession = all.find((session) => session.username === 'admin')!;
    const forbidden = await controller.fetch(new Request(`${BASE}/sessions/${adminSession.id}`, { method: 'DELETE', headers: { cookie: viewerOne } }));
    expect(forbidden.status).toBe(403);

    const other = (await sessions(controller, viewerOne)).find((session) => !session.current)!;
    const ended = await controller.fetch(new Request(`${BASE}/sessions/${other.id}`, { method: 'DELETE', headers: { cookie: viewerOne } }));
    expect(ended.status).toBe(200);
    expect((await get(controller, '/me', viewerTwo)).status).toBe(401);
    expect((await get(controller, '/me', viewerOne)).status).toBe(200);
  });

  test('reports no sessions when authentication is disabled', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'false' } });
    expect((await get(controller, '/sessions', '')).status).toBe(401);
  });
});
