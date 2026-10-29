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

function allowlistResolver(url: string): Response | undefined {
  if (url.endsWith('/v1/allowlists?with_content=true')) return Response.json(lapiAllowlists);
  if (url.endsWith('/v1/allowlists/check/10.1.2.3')) return Response.json({ allowlisted: true, reason: '10.0.0.0/8 from office (VPN)' });
  if (url.includes('/v1/allowlists/check/')) return Response.json({});
  return undefined;
}

// Runs the service against a real cache database without worker processes.
function createDirectService(fetchers: Record<string, () => Promise<unknown[]>>) {
  const database = new CrowdsecDatabase({ cachePath: path.join(tempDir, 'allowlists.db') });
  const config = {
    instances: Object.keys(fetchers).map((id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1) })),
  } as unknown as RuntimeConfig;
  const onChange = vi.fn();
  const service = createAllowlistService({
    config,
    lapiClients: new Map(Object.entries(fetchers).map(([id, fetchAllowlists]) => [id, { fetchAllowlists } as never])),
    database,
    queryWorker: { all: async (sql: string, params: unknown[] = []) => database.db.prepare(sql).all(...params) } as never,
    syncWorker: {},
    runConsistentDatabaseRefresh: async (operation) => ({ result: await operation(), releasePublishedRevision: () => {} }),
    onChange,
  });
  return { service, config, database, onChange };
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
        instances: [{ instance_id: 'default', instance_name: 'CrowdSec', status: 'available' }],
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
        { instance_id: 'east', instance_name: 'East', status: 'unsupported' },
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
