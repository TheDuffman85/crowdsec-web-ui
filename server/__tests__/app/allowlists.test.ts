import { describe, expect, test, vi, type MockInstance } from 'vitest';
import path from 'node:path';
import type { RuntimeConfig } from '../../config';
import { createAllowlistService } from '../../app/allowlists';
import { CrowdsecDatabase } from '../../database';
import { createAuthSessionCookie, createController, destroyTempDir, tempDir } from './harness';

const ZERO_TIME = '0001-01-01T00:00:00.000Z';

const lapiAllowlists = [
  {
    allowlist_id: 'b1',
    name: 'office',
    description: 'Office network',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    console_managed: false,
    items: [
      { value: '10.0.0.0/8', description: 'VPN', created_at: '2026-01-01T00:00:00.000Z', expiration: ZERO_TIME },
      { value: '192.0.2.10', created_at: '2026-01-01T00:00:00.000Z', expiration: '2099-12-01T00:00:00.000Z' },
    ],
  },
  { allowlist_id: 'a1', name: 'console', console_managed: true, created_at: ZERO_TIME, items: null },
];

// Like every CrowdSec release without allowlist write routes.
function allowlistResolver(url: string): Response | undefined {
  if (url.endsWith('/v1/allowlists/-/items')) return new Response(null, { status: 404 });
  if (url.endsWith('/v1/allowlists?with_content=true')) return Response.json(lapiAllowlists);
  if (url.endsWith('/v1/allowlists/check/10.1.2.3')) return Response.json({ allowlisted: true, reason: '10.0.0.0/8 from office (VPN)' });
  if (url.includes('/v1/allowlists/check/')) return Response.json({});
  return undefined;
}

// Runs the service against a real cache database without worker processes.
function createDirectService(fetchers: Record<string, () => Promise<unknown[]>>, clients: Record<string, object> = {}) {
  const database = new CrowdsecDatabase({ cachePath: path.join(tempDir, 'allowlists.db') });
  const config = {
    instances: Object.keys(fetchers).map((id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1) })),
  } as unknown as RuntimeConfig;
  const onChange = vi.fn();
  const onDecisionsExpired = vi.fn();
  const service = createAllowlistService({
    config,
    lapiClients: new Map(Object.entries(fetchers).map(([id, fetchAllowlists]) => [id, { fetchAllowlists, ...clients[id] } as never])),
    database,
    queryWorker: { all: async (sql: string, params: unknown[] = []) => database.db.prepare(sql).all(...params) } as never,
    syncWorker: {},
    runConsistentDatabaseRefresh: async (operation) => ({ result: await operation(), releasePublishedRevision: () => {} }),
    onChange,
    onDecisionsExpired,
  });
  return { service, config, database, onChange, onDecisionsExpired };
}

type FakeItem = { value: string; description?: string; expiration?: string };

/**
 * A LAPI with allowlist write routes. `untrusted` answers like one that does not list the Web UI
 * in `trusted_ips`, `legacy` like a release without the routes.
 */
function fakeLapi(mode: 'trusted' | 'untrusted' | 'legacy' = 'trusted') {
  const lists = new Map<string, { description?: string; console_managed?: boolean; items: FakeItem[] }>();
  const message = (text: string, status: number) => Response.json({ message: text }, { status });
  const resolver = (url: string, init?: { method?: string; body?: unknown }): Response | undefined => {
    const { pathname, searchParams } = new URL(url);
    const method = init?.method || 'GET';
    if (pathname === '/v1/allowlists' && method === 'GET') {
      return Response.json([...lists].map(([name, list]) => ({ name, ...list })));
    }
    const match = /^\/v1\/allowlists(?:\/([^/]+)(\/items)?)?$/.exec(pathname);
    if (!match || pathname.startsWith('/v1/allowlists/check')) return undefined;
    if (mode === 'legacy') return new Response(null, { status: match[1] && !match[2] ? 405 : match[1] ? 404 : 405 });
    if (mode === 'untrusted') return message('access forbidden from this IP (172.18.0.5)', 403);
    const name = match[1] ? decodeURIComponent(match[1]) : '';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (!name) {
      if (lists.has(body.name)) return message(`allowlist '${body.name}' already exists`, 409);
      lists.set(body.name, { ...(body.description ? { description: body.description } : {}), items: [] });
      return Response.json({ name: body.name, items: [] }, { status: 201 });
    }
    if (match[2] && method === 'DELETE' && searchParams.getAll('value').length === 0) return message('value is required', 400);
    const list = lists.get(name);
    if (!list) return message(`allowlist '${name}' not found`, 404);
    if (list.console_managed) return message(`allowlist ${name} is managed by console`, 403);
    if (!match[2]) {
      lists.delete(name);
      return new Response(null, { status: 204 });
    }
    if (method === 'POST') {
      const added = (body.items as FakeItem[]).filter((item) => !list.items.some((known) => known.value === item.value));
      list.items.push(...added);
      return Response.json({ added: added.length, decisions_expired: added.some((item) => item.value === '203.0.113.7') ? 2 : 0 });
    }
    const values = searchParams.getAll('value');
    const before = list.items.length;
    list.items = list.items.filter((item) => !values.includes(item.value));
    return Response.json({ removed: before - list.items.length });
  };
  return { lists, resolver };
}

function request(method: string, pathAndQuery: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/crowdsec/api/allowlists${pathAndQuery}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function auditEntries(logSpy: MockInstance): Array<Record<string, unknown>> {
  return logSpy.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith('[audit] '))
    .map((line) => JSON.parse(line.slice('[audit] '.length)) as Record<string, unknown>);
}

function postDecision(controller: ReturnType<typeof createController>['controller'], body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return controller.fetch(new Request('http://localhost/crowdsec/api/decisions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }));
}

describe('allowlists API', () => {
  test('summarizes allowlists and pages their normalized entries', async () => {
    const { controller, database, fetchCalls } = createController({ fetchResolver: allowlistResolver });
    try {
      const response = await controller.fetch(new Request('http://localhost/crowdsec/api/allowlists'));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        partial: false,
        instances: [{ instance_id: 'default', instance_name: 'CrowdSec', status: 'available', management: 'unsupported' }],
        allowlists: [
          { name: 'console', console_managed: true, instance_ids: ['default'], entry_count: 0, matching_entries: 0 },
          {
            name: 'office',
            description: 'Office network',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-02T00:00:00.000Z',
            console_managed: false,
            instance_ids: ['default'],
            entry_count: 2,
            matching_entries: 2,
          },
        ],
      });

      const page = await controller.fetch(new Request('http://localhost/crowdsec/api/allowlists/office/entries?page=1&page_size=10'));
      expect(await page.json()).toEqual({
        allowlist: expect.objectContaining({ name: 'office', entry_count: 2, matching_entries: 2 }),
        data: [
          { value: '10.0.0.0/8', description: 'VPN', created_at: '2026-01-01T00:00:00.000Z', expiration: null, instance_ids: ['default'] },
          { value: '192.0.2.10', created_at: '2026-01-01T00:00:00.000Z', expiration: '2099-12-01T00:00:00.000Z', instance_ids: ['default'] },
        ],
        pagination: { page: 1, page_size: 10, total: 2, total_pages: 1, unfiltered_total: 2 },
      });
      const beyond = await controller.fetch(new Request('http://localhost/crowdsec/api/allowlists/office/entries?page=2'));
      expect(await beyond.json()).toMatchObject({ data: [], pagination: { page: 2, page_size: 50, total: 2, total_pages: 1 } });

      const filtered = await controller.fetch(new Request('http://localhost/crowdsec/api/allowlists/office/entries?q=vpn'));
      expect(await filtered.json()).toMatchObject({
        allowlist: { matching_entries: 1 },
        data: [{ value: '10.0.0.0/8', description: 'VPN', expiration: null }],
        pagination: { page: 1, page_size: 50, total: 1, unfiltered_total: 2 },
      });
      const summaries = await controller.fetch(new Request('http://localhost/crowdsec/api/allowlists?q=vpn'));
      expect((await summaries.json() as any).allowlists).toEqual([expect.objectContaining({ name: 'office', matching_entries: 1 })]);
      // Paging and filtering reuse one LAPI download.
      expect(fetchCalls.filter((call) => call.url.includes('/v1/allowlists?'))).toHaveLength(1);

      expect((await controller.fetch(new Request('http://localhost/crowdsec/api/allowlists/missing/entries'))).status).toBe(404);
      expect((await controller.fetch(new Request('http://localhost/crowdsec/api/allowlists?instance=missing'))).status).toBe(404);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('refreshes cached allowlists with every cache refresh', async () => {
    let items = [{ value: '10.0.0.0/8' }];
    const { controller, database, fetchCalls } = createController({
      fetchResolver: (url) => url.endsWith('/v1/allowlists?with_content=true') ? Response.json([{ name: 'office', items }]) : undefined,
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
    });
    const entries = async () => (await (await controller.fetch(new Request('http://localhost/crowdsec/api/allowlists/office/entries'))).json() as any)
      .data.map((entry: { value: string }) => entry.value);
    try {
      expect(await entries()).toEqual(['10.0.0.0/8']);
      items = [{ value: '10.0.0.0/8' }, { value: '192.0.2.1' }];
      // Until the next refresh, pages read the cache instead of LAPI.
      expect(await entries()).toEqual(['10.0.0.0/8']);

      const refresh = await controller.fetch(new Request('http://localhost/crowdsec/api/cache/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'delta' }),
      }));
      expect(refresh.status).toBe(200);
      expect(await entries()).toEqual(['10.0.0.0/8', '192.0.2.1']);
      expect(fetchCalls.filter((call) => call.url.includes('/v1/allowlists?'))).toHaveLength(2);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('combines allowlists of the same name and keeps per-entry instance membership', async () => {
    const lists = {
      east: [{ name: 'office', console_managed: false, updated_at: '2026-01-01T00:00:00.000Z', items: [{ value: '10.0.0.0/8' }, { value: '192.0.2.1' }] }],
      west: [
        { name: 'office', console_managed: true, updated_at: '2026-02-01T00:00:00.000Z', items: [{ value: '10.0.0.0/8' }] },
        { name: 'west-only', items: [{ value: '203.0.113.1' }] },
      ],
    };
    const { service, config, database } = createDirectService(Object.fromEntries(Object.entries(lists)
      .map(([id, allowlists]) => [id, async () => allowlists])));
    try {
      await service.ensureSynced(config.instances);
      expect((await service.listAllowlists(config.instances)).allowlists).toEqual([
        { name: 'office', console_managed: true, updated_at: '2026-02-01T00:00:00.000Z', instance_ids: ['east', 'west'], entry_count: 2, matching_entries: 2 },
        { name: 'west-only', console_managed: false, instance_ids: ['west'], entry_count: 1, matching_entries: 1 },
      ]);
      expect((await service.listEntries(config.instances, 'office', { page: 1, pageSize: 50 }))?.data).toEqual([
        { value: '10.0.0.0/8', expiration: null, instance_ids: ['east', 'west'] },
        { value: '192.0.2.1', expiration: null, instance_ids: ['east'] },
      ]);
      expect((await service.listEntries(config.instances.slice(1), 'office', { page: 1, pageSize: 50 }))?.data).toEqual([
        { value: '10.0.0.0/8', expiration: null, instance_ids: ['west'] },
      ]);
    } finally {
      database.close();
      destroyTempDir();
    }
  });

  test('filters values by any active comment while preserving their full instance membership and metadata', async () => {
    const { service, config, database } = createDirectService({
      east: async () => [{ name: 'office', items: [
        { value: '10.0.0.1', description: 'VPN', created_at: '2026-02-01T00:00:00Z', expiration: '2099-01-01T00:00:00Z' },
        { value: '10.0.0.2', description: 'VPN', expiration: '2020-01-01T00:00:00Z' },
      ] }],
      west: async () => [{ name: 'office', items: [
        { value: '10.0.0.1', description: 'Office', created_at: '2026-01-01T00:00:00Z' },
        { value: '10.0.0.2', description: 'Office' },
      ] }],
    });
    try {
      await service.ensureSynced(config.instances);
      const page = await service.listEntries(config.instances, 'office', { page: 1, pageSize: 50 }, 'VPN');
      expect(page?.data).toEqual([{
        value: '10.0.0.1',
        description: 'VPN',
        created_at: '2026-01-01T00:00:00.000Z',
        expiration: null,
        instance_ids: ['east', 'west'],
      }]);
      expect(page?.pagination).toMatchObject({ total: 1, unfiltered_total: 2 });
      expect((await service.listAllowlists(config.instances, 'VPN')).allowlists[0].matching_entries).toBe(1);
      expect((await service.listEntries(config.instances.slice(1), 'office', { page: 1, pageSize: 50 }, 'VPN'))?.data).toEqual([]);
    } finally {
      database.close();
      destroyTempDir();
    }
  });

  test('keeps cached entries when LAPI fails and reports why', async () => {
    let fetchAllowlists: () => Promise<unknown[]> = async () => [{ name: 'office', items: [{ value: '10.0.0.0/8' }] }];
    const { service, config, database, onChange } = createDirectService({ east: () => fetchAllowlists() });
    try {
      await service.syncInstance('east');
      fetchAllowlists = async () => { throw Object.assign(new Error('HTTP 500: Internal Server Error'), { status: 500 }); };
      await service.syncInstance('east');
      expect(await service.listAllowlists(config.instances)).toMatchObject({
        partial: true,
        instances: [{ instance_id: 'east', status: 'unavailable', error: 'HTTP 500: Internal Server Error' }],
        allowlists: [{ name: 'office', entry_count: 1 }],
      });

      fetchAllowlists = async () => { throw Object.assign(new Error('HTTP 404: Not Found'), { status: 404 }); };
      await service.syncInstance('east');
      expect((await service.listAllowlists(config.instances)).instances).toEqual([
        { instance_id: 'east', instance_name: 'East', status: 'unsupported', management: 'unknown' },
      ]);
      // The first sync has nothing to update on open pages.
      expect(onChange).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
      destroyTempDir();
    }
  });

  test('writes only changed snapshots, removes deleted entries, and hides expired ones', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    const past = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
    let snapshot: unknown[] = [
      { name: 'office', items: [{ value: '10.0.0.0/8' }, { value: '192.0.2.1', expiration: future }, { value: '192.0.2.2', expiration: past }] },
      { name: 'old', items: [{ value: '203.0.113.1' }] },
    ];
    const { service, config, database, onChange } = createDirectService({ east: async () => snapshot });
    const replace = vi.spyOn(database, 'replaceAllowlists');
    try {
      await service.syncInstance('east');
      await service.syncInstance('east');
      expect(replace).toHaveBeenCalledTimes(1);
      expect(onChange).not.toHaveBeenCalled();
      expect((await service.listEntries(config.instances, 'office', { page: 1, pageSize: 50 }))?.data.map((entry) => entry.value))
        .toEqual(['10.0.0.0/8', '192.0.2.1']);

      snapshot = [{ name: 'office', items: [{ value: '10.0.0.0/8', description: 'VPN' }] }];
      await service.syncInstance('east');
      expect(onChange).toHaveBeenCalledExactlyOnceWith(['east']);
      expect((await service.listAllowlists(config.instances)).allowlists.map((allowlist) => allowlist.name)).toEqual(['office']);
      expect((await service.listEntries(config.instances, 'office', { page: 1, pageSize: 50 }))?.data).toEqual([
        { value: '10.0.0.0/8', description: 'VPN', expiration: null, instance_ids: ['east'] },
      ]);
      expect(await service.listEntries(config.instances, 'old', { page: 1, pageSize: 50 })).toBeNull();

      database.clearSyncData();
      expect(database.db.prepare('SELECT COUNT(*) AS count FROM allowlist_items').get()).toEqual({ count: 0 });
    } finally {
      database.close();
      destroyTempDir();
    }
  });

  test('checks a value against the allowlists of the selected scope', async () => {
    const { controller, database } = createController({ fetchResolver: allowlistResolver });
    try {
      const allowlisted = await controller.fetch(new Request('http://localhost/crowdsec/api/allowlists/check?value=10.1.2.3'));
      expect(await allowlisted.json()).toEqual({
        value: '10.1.2.3',
        allowlisted: true,
        results: [{
          instance_id: 'default',
          instance_name: 'CrowdSec',
          status: 'available',
          allowlisted: true,
          reason: '10.0.0.0/8 from office (VPN)',
        }],
      });

      const clear = await controller.fetch(new Request('http://localhost/crowdsec/api/allowlists/check?value=203.0.113.0%2F24&instance=default'));
      expect(await clear.json()).toMatchObject({ value: '203.0.113.0/24', allowlisted: false });

      const invalid = await controller.fetch(new Request('http://localhost/crowdsec/api/allowlists/check?value=example.com'));
      expect(invalid.status).toBe(400);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('lets read-only users view allowlists', async () => {
    const { controller, database } = createController({ env: { AUTH_ENABLED: 'true' }, fetchResolver: allowlistResolver });
    try {
      database.createAuthUser({ username: 'admin', passwordHash: 'hash', role: 'admin', authProvider: 'password' });
      const viewerId = database.createAuthUser({ username: 'viewer', passwordHash: 'hash', role: 'read-only', authProvider: 'password' });
      const cookie = createAuthSessionCookie(database, { userId: viewerId, username: 'viewer', role: 'read-only', authMethod: 'password' });

      const list = await controller.fetch(new Request('http://localhost/crowdsec/api/allowlists', { headers: { Cookie: cookie } }));
      expect(list.status).toBe(200);
      const check = await controller.fetch(new Request('http://localhost/crowdsec/api/allowlists/check?value=10.1.2.3', { headers: { Cookie: cookie } }));
      expect(check.status).toBe(200);

      const anonymous = await controller.fetch(new Request('http://localhost/crowdsec/api/allowlists'));
      expect(anonymous.status).toBe(401);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });
});

describe('manual decisions and allowlists', () => {
  test('refuses an allowlisted value until the allowlist is explicitly bypassed', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { controller, database, lapiClient, fetchCalls } = createController({
      fetchResolver: allowlistResolver,
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
    });
    const alertPosts = () => fetchCalls.filter((call) => call.url.endsWith('/v1/alerts') && call.method === 'POST');
    try {
      await lapiClient.login();

      const refused = await postDecision(controller, { ip: '10.1.2.3', duration: '4h' });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({
        error: '10.1.2.3 is allowlisted',
        code: 'ALLOWLISTED',
        allowlisted: [{ instance_id: 'default', instance_name: 'CrowdSec', reason: '10.0.0.0/8 from office (VPN)' }],
      });
      expect(alertPosts()).toHaveLength(0);
      expect(auditEntries(logSpy)).toEqual([]);

      const bypassed = await postDecision(controller, { ip: '10.1.2.3', duration: '4h', bypass_allowlist: true });
      expect(bypassed.status).toBe(200);
      expect(alertPosts()).toHaveLength(1);
      expect(fetchCalls.filter((call) => call.url.includes('/v1/allowlists/check/'))).toHaveLength(1);
      expect(auditEntries(logSpy)).toEqual([expect.objectContaining({
        action: 'decision.add',
        ip: '10.1.2.3',
        bypass_allowlist: true,
        outcome: 'success',
      })]);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      logSpy.mockRestore();
      destroyTempDir();
    }
  });

  test('bulk add skips allowlisted values in one LAPI request and adds them when bypassed', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { controller, database, lapiClient, fetchCalls } = createController({
      fetchResolver: allowlistResolver,
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
    });
    const alertPosts = () => fetchCalls.filter((call) => call.url.endsWith('/v1/alerts') && call.method === 'POST');
    const bulkAdd = (body: Record<string, unknown>) => controller.fetch(new Request('http://localhost/crowdsec/api/decisions/bulk-add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
    try {
      await lapiClient.login();

      expect((await bulkAdd({ values: [] })).status).toBe(400);
      expect((await bulkAdd({ values: ['203.0.113.5', 'example.com'] })).status).toBe(400);
      expect((await bulkAdd({ values: Array.from({ length: 501 }, (_, index) => `203.0.${index >> 8}.${index & 255}`) })).status).toBe(400);
      expect((await bulkAdd({ values: ['203.0.113.5'], duration: 'soon' })).status).toBe(400);
      expect(alertPosts()).toHaveLength(0);

      const response = await bulkAdd({ values: ['203.0.113.5', '10.1.2.3', '198.51.100.0/24', '203.0.113.5'], duration: '4h', reason: 'scanner' });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        added: ['203.0.113.5', '198.51.100.0/24'],
        allowlisted: [{ value: '10.1.2.3', allowlisted: [{ instance_id: 'default', instance_name: 'CrowdSec', reason: '10.0.0.0/8 from office (VPN)' }] }],
        succeeded: 1,
        failed: 0,
      });
      expect(alertPosts()).toHaveLength(1);
      expect((alertPosts()[0].body as Array<{ source: { value: string } }>).map((alert) => alert.source.value)).toEqual(['203.0.113.5', '198.51.100.0/24']);
      expect(auditEntries(logSpy)).toEqual([expect.objectContaining({ action: 'decision.add', values: ['203.0.113.5', '198.51.100.0/24'], outcome: 'success' })]);

      const bypassed = await bulkAdd({ values: ['10.1.2.3'], bypass_allowlist: true });
      expect(await bypassed.json()).toMatchObject({ added: ['10.1.2.3'], allowlisted: [], succeeded: 1 });
      expect(alertPosts()).toHaveLength(2);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      logSpy.mockRestore();
      destroyTempDir();
    }
  });

  test('adds decisions when the value is not allowlisted or the LAPI cannot check', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let checkStatus = 200;
    const { controller, database, lapiClient } = createController({
      fetchResolver: (url) => url.includes('/v1/allowlists/check/')
        ? Response.json(checkStatus === 200 ? {} : { message: 'failure' }, { status: checkStatus })
        : undefined,
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
    });
    try {
      await lapiClient.login();
      expect((await postDecision(controller, { ip: '203.0.113.5' })).status).toBe(200);

      checkStatus = 404;
      expect((await postDecision(controller, { ip: '203.0.113.6' })).status).toBe(200);
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Allowlist check'));

      checkStatus = 500;
      expect((await postDecision(controller, { ip: '203.0.113.7' })).status).toBe(200);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Allowlist check for 203.0.113.7 failed on CrowdSec'));
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      warnSpy.mockRestore();
      destroyTempDir();
    }
  });
});

describe('allowlist sync progress', () => {
  test('reports caching progress, results, and failures per instance', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let fetchAllowlists: () => Promise<unknown[]> = async () => {
      await gate;
      return [{ name: 'office', items: [{ value: '10.0.0.0/8' }, { value: '192.0.2.1' }] }];
    };
    const { service, database } = createDirectService({ east: () => fetchAllowlists() });
    try {
      expect(service.getSyncProgress('east')).toEqual({ state: 'pending' });
      const sync = service.syncInstance('east');
      expect(service.getSyncProgress('east')).toEqual({ state: 'syncing' });
      release();
      await sync;
      expect(service.getSyncProgress('east')).toEqual({ state: 'complete', allowlists: 1, entries: 2 });

      fetchAllowlists = async () => { throw Object.assign(new Error('HTTP 500: Internal Server Error'), { status: 500 }); };
      await service.syncInstance('east');
      expect(service.getSyncProgress('east')).toEqual({ state: 'failed', error: 'HTTP 500: Internal Server Error' });

      fetchAllowlists = async () => { throw Object.assign(new Error('HTTP 404: Not Found'), { status: 404 }); };
      await service.syncInstance('east');
      expect(service.getSyncProgress('east')).toEqual({ state: 'unsupported' });
    } finally {
      database.close();
      destroyTempDir();
    }
  });

  test('is part of the sync status shown by the sync overlay', async () => {
    const { controller, database } = createController({
      fetchResolver: (url) => url.endsWith('/v1/allowlists?with_content=true') ? Response.json([{ name: 'office', items: [{ value: '10.0.0.0/8' }] }]) : undefined,
    });
    try {
      expect(((await (await controller.fetch(new Request('http://localhost/crowdsec/api/config'))).json()) as any).sync_status.allowlists)
        .toEqual({ state: 'pending' });
      await controller.fetch(new Request('http://localhost/crowdsec/api/allowlists'));
      expect(((await (await controller.fetch(new Request('http://localhost/crowdsec/api/config'))).json()) as any).sync_status.allowlists)
        .toEqual({ state: 'complete', allowlists: 1, entries: 1 });
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });
});

describe('allowlist management', () => {
  test('creates an allowlist, changes its entries, and deletes it through LAPI', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const lapi = fakeLapi();
    const { controller, database, fetchCalls } = createController({ fetchResolver: lapi.resolver });
    const list = async () => await (await controller.fetch(request('GET', ''))).json() as any;
    try {
      expect((await list()).instances).toEqual([
        { instance_id: 'default', instance_name: 'CrowdSec', status: 'available', management: 'available' },
      ]);

      const created = await controller.fetch(request('POST', '', { name: ' office ', description: 'Office network' }));
      expect(created.status).toBe(200);
      expect(await created.json()).toEqual({
        results: [{ instance_id: 'default', instance_name: 'CrowdSec', success: true }],
        succeeded: 1,
        failed: 0,
      });
      // The cache is read again before the response, so the page can reload right away.
      expect((await list()).allowlists).toEqual([expect.objectContaining({ name: 'office', description: 'Office network', entry_count: 0 })]);

      const before = Date.now();
      const added = await controller.fetch(request('POST', '/office/entries', {
        values: ['203.0.113.7', ' 198.51.100.0/24 ', '203.0.113.7'],
        description: 'CI runners',
        duration: '4h',
      }));
      expect(added.status).toBe(200);
      expect((await added.json() as any).results).toEqual([
        { instance_id: 'default', instance_name: 'CrowdSec', success: true, result: { added: 2, decisions_expired: 2 } },
      ]);
      const sent = fetchCalls.find((call) => call.url.endsWith('/v1/allowlists/office/items') && call.method === 'POST')!.body as any;
      expect(sent.items.map((item: FakeItem) => [item.value, item.description])).toEqual([
        ['203.0.113.7', 'CI runners'],
        ['198.51.100.0/24', 'CI runners'],
      ]);
      const expiration = Date.parse(sent.items[0].expiration);
      expect(expiration).toBeGreaterThanOrEqual(before + 4 * 3_600_000);
      expect(expiration).toBeLessThanOrEqual(Date.now() + 4 * 3_600_000);

      const permanent = await controller.fetch(request('POST', '/office/entries', { values: ['10.0.0.0/8'] }));
      expect(permanent.status).toBe(200);
      expect(lapi.lists.get('office')!.items.at(-1)).toEqual({ value: '10.0.0.0/8' });
      const entries = await (await controller.fetch(request('GET', '/office/entries'))).json() as any;
      expect(entries.data.map((entry: any) => entry.value).sort()).toEqual(['10.0.0.0/8', '198.51.100.0/24', '203.0.113.7']);

      const removed = await controller.fetch(request('DELETE', '/office/entries?value=198.51.100.0%2F24&value=192.0.2.1'));
      expect((await removed.json() as any).results[0].result).toEqual({ removed: 1 });
      expect((await list()).allowlists[0].entry_count).toBe(2);

      const deleted = await controller.fetch(request('DELETE', '/office'));
      expect(deleted.status).toBe(200);
      expect((await list()).allowlists).toEqual([]);

      expect(auditEntries(logSpy)).toEqual([
        expect.objectContaining({ action: 'allowlist.create', allowlist: 'office', description: 'Office network', instances: ['CrowdSec'], outcome: 'success' }),
        expect.objectContaining({
          action: 'allowlist.entries.add',
          allowlist: 'office',
          values: ['203.0.113.7', '198.51.100.0/24'],
          description: 'CI runners',
          duration: '4h',
          outcome: 'success',
        }),
        expect.objectContaining({ action: 'allowlist.entries.add', values: ['10.0.0.0/8'], outcome: 'success' }),
        expect.objectContaining({ action: 'allowlist.entries.remove', values: ['198.51.100.0/24', '192.0.2.1'], outcome: 'success' }),
        expect.objectContaining({ action: 'allowlist.delete', allowlist: 'office', outcome: 'success' }),
      ]);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      logSpy.mockRestore();
      destroyTempDir();
    }
  });

  test('rejects invalid changes without sending them to LAPI', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const lapi = fakeLapi();
    lapi.lists.set('office', { items: [{ value: '10.0.0.0/8' }] });
    lapi.lists.set('console', { console_managed: true, items: [{ value: '192.0.2.1' }] });
    const { controller, database, fetchCalls } = createController({ fetchResolver: lapi.resolver });
    const tooMany = Array.from({ length: 501 }, (_value, index) => `10.0.${Math.floor(index / 250)}.${index % 250}`);
    const cases: Array<[string, Request, number, string]> = [
      ['a missing name', request('POST', '', { description: 'x' }), 400, 'An allowlist name is required'],
      ['a name that is too long', request('POST', '', { name: 'x'.repeat(256) }), 400, 'An allowlist name has at most 255 characters'],
      ['a body that is not JSON', request('POST', '', undefined), 400, 'An allowlist name is required'],
      ['an unknown instance', request('POST', '?instance=missing', { name: 'x' }), 404, 'Unknown CrowdSec instance scope "missing"'],
      ['no values', request('POST', '/office/entries', { values: [] }), 400, 'At least one IP address or range is required'],
      ['an invalid value', request('POST', '/office/entries', { values: ['192.0.2.1', 'example.com'] }), 400, 'Invalid IP address or range: example.com'],
      ['too many values', request('POST', '/office/entries', { values: tooMany }), 400, 'At most 500 values are accepted at once'],
      ['an invalid duration', request('POST', '/office/entries', { values: ['192.0.2.1'], duration: 'soon' }), 400, 'Invalid duration format. Use e.g. "4h", "30m", "1d"'],
      ['entries for an unknown allowlist', request('POST', '/missing/entries', { values: ['192.0.2.1'] }), 404, 'Unknown allowlist'],
      ['entries for a console allowlist', request('POST', '/console/entries', { values: ['192.0.2.2'] }), 409, 'Allowlists managed by the CrowdSec Console cannot be changed here'],
      ['removing nothing', request('DELETE', '/office/entries'), 400, 'At least one value is required'],
      ['removing from a console allowlist', request('DELETE', '/console/entries?value=192.0.2.1'), 409, 'Allowlists managed by the CrowdSec Console cannot be changed here'],
      ['deleting a console allowlist', request('DELETE', '/console'), 409, 'Allowlists managed by the CrowdSec Console cannot be changed here'],
      ['deleting an unknown allowlist', request('DELETE', '/missing'), 404, 'Unknown allowlist'],
    ];
    try {
      for (const [label, invalid, status, error] of cases) {
        const response = await controller.fetch(invalid);
        expect(response.status, label).toBe(status);
        expect(await response.json(), label).toMatchObject({ error });
      }
      expect(fetchCalls.filter((call) => call.url.includes('/v1/allowlists') && call.method !== 'GET' && !call.url.endsWith('/-/items'))).toEqual([]);
      expect(auditEntries(logSpy)).toEqual([]);
      expect(lapi.lists.get('console')!.items).toHaveLength(1);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      logSpy.mockRestore();
      destroyTempDir();
    }
  });

  test('refuses changes from read-only users', async () => {
    const lapi = fakeLapi();
    lapi.lists.set('office', { items: [{ value: '10.0.0.0/8' }] });
    const { controller, database } = createController({ env: { AUTH_ENABLED: 'true' }, fetchResolver: lapi.resolver });
    try {
      database.createAuthUser({ username: 'admin', passwordHash: 'hash', role: 'admin', authProvider: 'password' });
      const viewerId = database.createAuthUser({ username: 'viewer', passwordHash: 'hash', role: 'read-only', authProvider: 'password' });
      const headers = { Cookie: createAuthSessionCookie(database, { userId: viewerId, username: 'viewer', role: 'read-only', authMethod: 'password' }) };
      for (const change of [
        request('POST', '', { name: 'new' }, headers),
        request('POST', '/office/entries', { values: ['192.0.2.1'] }, headers),
        request('DELETE', '/office/entries?value=10.0.0.0%2F8', undefined, headers),
        request('DELETE', '/office', undefined, headers),
      ]) {
        const response = await controller.fetch(change);
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: 'READ_ONLY' });
      }
      expect([...lapi.lists.keys()]).toEqual(['office']);
      expect(lapi.lists.get('office')!.items).toEqual([{ value: '10.0.0.0/8' }]);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('reports a LAPI without write routes and asks it again only after a while', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const lapi = fakeLapi('legacy');
    lapi.lists.set('office', { items: [] });
    const { controller, database, fetchCalls } = createController({ fetchResolver: lapi.resolver });
    const probes = () => fetchCalls.filter((call) => call.url.endsWith('/v1/allowlists/-/items')).length;
    const management = async () => (await (await controller.fetch(request('GET', ''))).json() as any).instances[0].management;
    const now = vi.spyOn(Date, 'now');
    try {
      expect(await management()).toBe('unsupported');
      expect(await management()).toBe('unsupported');
      expect(probes()).toBe(1);

      now.mockReturnValue(Date.now() + 10 * 60_000);
      expect(await management()).toBe('unsupported');
      expect(probes()).toBe(2);

      // A change that is attempted anyway explains why it failed.
      const created = await controller.fetch(request('POST', '', { name: 'new' }));
      expect(created.status).toBe(502);
      expect(await created.json()).toEqual({
        results: [{
          instance_id: 'default',
          instance_name: 'CrowdSec',
          success: false,
          error: 'This CrowdSec version cannot change allowlists through LAPI',
          code: 'UNSUPPORTED',
        }],
        succeeded: 0,
        failed: 1,
      });
      const added = await controller.fetch(request('POST', '/office/entries', { values: ['192.0.2.1'] }));
      expect((await added.json() as any).results[0].code).toBe('UNSUPPORTED');
      expect(auditEntries(logSpy)).toEqual([
        expect.objectContaining({ action: 'allowlist.create', outcome: 'failure' }),
        expect.objectContaining({ action: 'allowlist.entries.add', outcome: 'failure' }),
      ]);
    } finally {
      now.mockRestore();
      controller.stopBackgroundTasks();
      database.close();
      logSpy.mockRestore();
      destroyTempDir();
    }
  });

  test('reports a LAPI that does not trust the Web UI address', async () => {
    const lapi = fakeLapi('untrusted');
    lapi.lists.set('office', { items: [] });
    const { controller, database } = createController({ fetchResolver: lapi.resolver });
    try {
      const listed = await (await controller.fetch(request('GET', ''))).json() as any;
      expect(listed.instances[0].management).toBe('forbidden');

      const added = await controller.fetch(request('POST', '/office/entries', { values: ['192.0.2.1'] }));
      expect(added.status).toBe(502);
      expect((await added.json() as any).results).toEqual([{
        instance_id: 'default',
        instance_name: 'CrowdSec',
        success: false,
        error: 'access forbidden from this IP (172.18.0.5)',
        code: 'UNTRUSTED_IP',
      }]);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('changes every local copy of an allowlist and reports each instance', async () => {
    const copies: Record<string, any[]> = {
      east: [{ name: 'office', items: [{ value: '10.0.0.0/8' }] }],
      west: [{ name: 'office', items: [] }],
      south: [{ name: 'office', console_managed: true, items: [] }],
      north: [{ name: 'office', items: [] }],
    };
    const addAllowlistItems = {
      east: vi.fn(async (_name: string, items: FakeItem[]) => {
        copies.east[0].items.push(...items);
        return { added: items.length, decisions_expired: 1 };
      }),
      west: vi.fn(async () => {
        throw Object.assign(new Error('HTTP 500: Internal Server Error'), { status: 500, response: { data: { message: 'database is locked' } } });
      }),
      south: vi.fn(),
      north: vi.fn(),
    };
    const { service, config, database, onDecisionsExpired } = createDirectService(
      Object.fromEntries(Object.keys(copies).map((id) => [id, async () => copies[id]])),
      {
        east: { addAllowlistItems: addAllowlistItems.east, probeAllowlistManagement: async () => 'available' },
        west: { addAllowlistItems: addAllowlistItems.west, probeAllowlistManagement: async () => 'available' },
        south: { addAllowlistItems: addAllowlistItems.south, probeAllowlistManagement: async () => 'available' },
        north: { addAllowlistItems: addAllowlistItems.north, probeAllowlistManagement: async () => 'unsupported' },
      },
    );
    try {
      await service.syncInstances(Object.keys(copies));
      await service.ensureManagementProbed(config.instances);

      expect(await service.addEntries(config.instances, 'office', [{ value: '192.0.2.1' }])).toEqual([
        { instance_id: 'east', instance_name: 'East', success: true, result: { added: 1, decisions_expired: 1 } },
        { instance_id: 'west', instance_name: 'West', success: false, error: 'database is locked' },
      ]);
      // The console owns its copy, and an instance without write routes is skipped while others can change.
      expect(addAllowlistItems.south).not.toHaveBeenCalled();
      expect(addAllowlistItems.north).not.toHaveBeenCalled();
      expect(onDecisionsExpired).toHaveBeenCalledExactlyOnceWith(['east']);
      const entries = await service.listEntries(config.instances, 'office', { page: 1, pageSize: 50 });
      expect(entries!.data.map((entry) => [entry.value, entry.instance_ids])).toEqual(expect.arrayContaining([['192.0.2.1', ['east']]]));

      expect(await service.addEntries([config.instances[2]], 'office', [{ value: '192.0.2.2' }])).toBe('console-managed');
      expect(await service.removeEntries(config.instances, 'missing', ['192.0.2.1'])).toBe('unknown');
      // With no other target, the instance without write routes reports the reason itself.
      addAllowlistItems.north.mockRejectedValue(Object.assign(new Error('HTTP 404: Not Found'), { status: 404 }));
      expect(await service.addEntries([config.instances[3]], 'office', [{ value: '192.0.2.3' }])).toEqual([
        expect.objectContaining({ instance_id: 'north', success: false, code: 'UNSUPPORTED' }),
      ]);
    } finally {
      database.close();
      destroyTempDir();
    }
  });
});
