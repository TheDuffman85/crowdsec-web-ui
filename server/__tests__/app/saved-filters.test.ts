import { describe, expect, test } from 'vitest';
import { createAuthSessionCookie, createController } from './harness';

const root = 'http://localhost/crowdsec/api/search-filters';

async function request(controller: ReturnType<typeof createController>['controller'], path = '', options: {
  method?: string;
  cookie?: string;
  body?: unknown;
} = {}) {
  return await controller.fetch(new Request(`${root}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  }));
}

describe('saved and recent search filters', () => {
  test('isolates users, allows read-only preference writes, and validates ownership', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
    const adminId = controller.database.createAuthUser({ username: 'admin', passwordHash: 'hash', role: 'admin', authProvider: 'password' });
    const viewerId = controller.database.createAuthUser({ username: 'viewer', passwordHash: 'hash', role: 'read-only', authProvider: 'password' });
    const admin = createAuthSessionCookie(controller.database, { userId: adminId, username: 'admin', role: 'admin', authMethod: 'password' });
    const viewer = createAuthSessionCookie(controller.database, { userId: viewerId, username: 'viewer', role: 'read-only', authMethod: 'password' });

    expect((await request(controller)).status).toBe(401);
    const created = await request(controller, '/saved', { method: 'POST', cookie: viewer, body: { name: 'WAF Germany', query: 'kind=waf AND country=DE' } });
    expect(created.status).toBe(201);
    const entry = await created.json() as { id: string };
    expect(entry.id).toBeTruthy();
    expect((await request(controller, '/saved', { method: 'POST', cookie: viewer, body: { name: 'waf germany', query: 'country=US' } })).status).toBe(409);
    expect((await request(controller, '/saved', { method: 'POST', cookie: viewer, body: { name: 'Bad', query: 'origin:(manual OR' } })).status).toBe(400);
    expect((await request(controller, `/saved/${entry.id}`, { method: 'PATCH', cookie: admin, body: { name: 'Stolen' } })).status).toBe(404);
    expect((await request(controller, `/saved/${entry.id}`, { method: 'DELETE', cookie: admin })).status).toBe(404);
    expect((await request(controller, '/recent', { method: 'POST', cookie: viewer, body: { query: 'country=DE' } })).status).toBe(200);
    const adminFilters = await request(controller, '', { cookie: admin }).then((response) => response.json()) as { saved: unknown[]; recent: unknown[] };
    expect(adminFilters.saved).toEqual([]);
    expect(adminFilters.recent).toEqual([]);
    const viewerFilters = await request(controller, '', { cookie: viewer }).then((response) => response.json()) as { saved: unknown[]; recent: unknown[] };
    expect(viewerFilters.saved).toHaveLength(1);
    expect(viewerFilters.recent).toHaveLength(1);
    expect((await request(controller, `/saved/${entry.id}`, { method: 'PATCH', cookie: viewer, body: { name: 'DE WAF' } })).status).toBe(200);
    expect((await request(controller, `/saved/${entry.id}`, { method: 'DELETE', cookie: viewer })).status).toBe(200);
  });

  test('keeps five distinct recent queries in use order per user', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
    const id = controller.database.createAuthUser({ username: 'operator', passwordHash: 'hash', role: 'admin', authProvider: 'password' });
    const cookie = createAuthSessionCookie(controller.database, { userId: id, username: 'operator', role: 'admin', authMethod: 'password' });
    for (let index = 0; index < 7; index += 1) {
      expect((await request(controller, '/recent', { method: 'POST', cookie, body: { query: `country=DE AND ip:192.0.2.${index}` } })).status).toBe(200);
    }
    let data = await request(controller, '', { cookie }).then((response) => response.json()) as { recent: Array<{ query: string }> };
    expect(data.recent).toHaveLength(5);
    expect(controller.database.db.query('SELECT COUNT(*) AS count FROM recent_search_filters WHERE owner_id = ?').get(id)).toEqual({ count: 5 });
    expect(data.recent[0].query).toContain('192.0.2.6');
    expect(data.recent.some((row) => row.query.includes('192.0.2.0'))).toBe(false);
    await request(controller, '/recent', { method: 'POST', cookie, body: { query: 'country=DE AND ip:192.0.2.2' } });
    data = await request(controller, '', { cookie }).then((response) => response.json()) as { recent: Array<{ query: string }> };
    expect(data.recent[0].query).toContain('192.0.2.2');
    expect((await request(controller, '/recent', { method: 'DELETE', cookie })).status).toBe(200);
    data = await request(controller, '', { cookie }).then((response) => response.json()) as { recent: Array<{ query: string }> };
    expect(data.recent).toEqual([]);
  });

  test('shares lists across requests when authentication is disabled', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'false' } });
    expect((await request(controller, '/saved', { method: 'POST', body: { name: 'Germany', query: 'country=DE' } })).status).toBe(201);
    const data = await request(controller).then((response) => response.json()) as { shared: boolean; saved: unknown[] };
    expect(data.shared).toBe(true);
    expect(data.saved).toHaveLength(1);
    expect((await request(controller, '/recent', { method: 'POST', body: { query: 'country=DE' } })).status).toBe(200);
    const onAnotherRequest = await request(controller).then((response) => response.json()) as { recent: unknown[] };
    expect(onAnotherRequest.recent).toHaveLength(1);
  });
});
