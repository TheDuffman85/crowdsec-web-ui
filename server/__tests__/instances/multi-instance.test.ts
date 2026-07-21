import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../../app';
import { createRuntimeConfig } from '../../config';
import { CrowdsecDatabase } from '../../database';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeClient(name: string, options: { failAdd?: boolean } = {}) {
  const status = { isConnected: true, lastCheck: null, lastError: null, offline_since: null };
  return {
    hasAuthConfig: () => true,
    hasToken: () => true,
    login: vi.fn(async () => true),
    updateStatus: vi.fn(),
    getStatus: () => ({ ...status }),
    heartbeat: vi.fn(async () => {}),
    sendUsageMetrics: vi.fn(async () => {}),
    fetchAlerts: vi.fn(async (): Promise<any[]> => []),
    getAlertById: vi.fn(async (id: string) => ({ id: Number(id), created_at: new Date().toISOString(), decisions: [] })),
    addDecision: vi.fn(async () => {
      if (options.failAdd) throw new Error(`${name} unavailable`);
      return { message: `${name} added` };
    }),
    deleteAlert: vi.fn(async () => ({ message: `${name} alert deleted` })),
    deleteDecision: vi.fn(async () => ({ message: `${name} decision deleted` })),
  };
}

function createMultiController(options: {
  secondaryAddFails?: boolean;
  secondarySyncNeverCompletes?: boolean;
  secondaryName?: string;
  startBackgroundTasks?: boolean;
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-multi-test-'));
  tempDirs.push(dir);
  const config = createRuntimeConfig({
    DB_DIR: dir,
    CROWDSEC_USER: 'watcher',
    CROWDSEC_PASSWORD: 'secret',
    CROWDSEC_REFRESH_INTERVAL: '1h',
    CROWDSEC_BOUNCER_PROPAGATION_DELAY: '0',
    AUTH_ENABLED: 'false',
  }, { defaultConfigFile: path.join(dir, 'config.yaml') });
  const base = config.instances[0];
  config.instances = [
    { ...base, id: 'primary', name: 'Primary', lapiUrl: 'http://primary:8080' },
    { ...base, id: 'secondary', name: options.secondaryName || 'Secondary', lapiUrl: 'http://secondary:8080' },
  ];
  const database = new CrowdsecDatabase({ dbDir: dir });
  const primary = fakeClient('primary');
  const secondary = fakeClient('secondary', { failAdd: options.secondaryAddFails });
  if (options.secondarySyncNeverCompletes) {
    secondary.fetchAlerts.mockImplementation(() => new Promise(() => {}));
  }
  const controller = createApp({
    config,
    database,
    lapiClients: new Map([
      ['primary', primary as never],
      ['secondary', secondary as never],
    ]),
    startBackgroundTasks: options.startBackgroundTasks === true,
    initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
    updateChecker: async () => ({ update_available: false, current_version: 'test', remote_version: 'test', tag: 'test', release_url: '', checked_at: new Date().toISOString() }),
  });
  return { controller, database, primary, secondary };
}

describe('multi-instance API', () => {
  test('runs every historical sync through chunk windows with a global concurrency limit of two', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-multi-chunk-test-'));
    tempDirs.push(dir);
    const config = createRuntimeConfig({
      DB_DIR: dir,
      CROWDSEC_USER: 'watcher',
      CROWDSEC_PASSWORD: 'secret',
      CROWDSEC_LOOKBACK_PERIOD: '2d',
      CROWDSEC_ALERT_SYNC_CHUNK: '1d',
      CROWDSEC_REFRESH_INTERVAL: '1h',
      CROWDSEC_MANUAL_REFRESH_ENABLED: 'true',
      AUTH_ENABLED: 'false',
    }, { defaultConfigFile: path.join(dir, 'config.yaml') });
    const base = config.instances[0];
    config.instances = [
      { ...base, id: 'primary', name: 'Primary', lapiUrl: 'http://primary:8080' },
      { ...base, id: 'secondary', name: 'Secondary', lapiUrl: 'http://secondary:8080' },
      { ...base, id: 'edge', name: 'Edge', lapiUrl: 'http://edge:8080' },
    ];
    const database = new CrowdsecDatabase({ dbDir: dir });
    const primary = fakeClient('primary');
    const secondary = fakeClient('secondary');
    const edge = fakeClient('edge');
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const releases = new Map<string, () => void>();
    const firstRequestGates = new Map(['primary', 'secondary', 'edge'].map((instanceId) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      releases.set(instanceId, release);
      return [instanceId, gate] as const;
    }));
    for (const [instanceId, client] of [['primary', primary], ['secondary', secondary], ['edge', edge]] as const) {
      let callCount = 0;
      client.fetchAlerts.mockImplementation(async () => {
        callCount += 1;
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        try {
          if (callCount === 1) await firstRequestGates.get(instanceId);
          return [];
        } finally {
          activeRequests -= 1;
        }
      });
    }
    const controller = createApp({
      config,
      database,
      lapiClients: new Map([
        ['primary', primary as never],
        ['secondary', secondary as never],
        ['edge', edge as never],
      ]),
      startBackgroundTasks: false,
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
      updateChecker: async () => ({ update_available: false, current_version: 'test', remote_version: 'test', tag: 'test', release_url: '', checked_at: new Date().toISOString() }),
    });

    try {
      const refresh = controller.fetch(new Request('http://localhost/api/cache/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'full' }),
      }));
      await vi.waitFor(() => {
        expect(primary.fetchAlerts).toHaveBeenCalledTimes(1);
        expect(secondary.fetchAlerts).toHaveBeenCalledTimes(1);
      }, { timeout: 5_000 });
      expect(edge.fetchAlerts).not.toHaveBeenCalled();

      const pending = await (await controller.fetch(new Request('http://localhost/api/config'))).json() as any;
      expect(pending.sync_status.instances).toEqual(expect.arrayContaining([
        expect.objectContaining({ instance_id: 'primary', state: 'syncing', message: expect.stringContaining('alerts') }),
        expect.objectContaining({ instance_id: 'secondary', state: 'syncing', message: expect.stringContaining('alerts') }),
        expect.objectContaining({ instance_id: 'edge', state: 'idle', progress: 0 }),
      ]));

      releases.get('primary')!();
      await vi.waitFor(() => expect(edge.fetchAlerts).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      releases.get('secondary')!();
      releases.get('edge')!();
      expect((await refresh).status).toBe(200);
      expect(primary.fetchAlerts).toHaveBeenCalledTimes(2);
      expect(secondary.fetchAlerts).toHaveBeenCalledTimes(2);
      expect(edge.fetchAlerts).toHaveBeenCalledTimes(2);
      expect(maxActiveRequests).toBe(2);
    } finally {
      for (const release of releases.values()) release();
      controller.stopBackgroundTasks();
      database.close();
    }
  }, 10_000);

  test('a manual full historical refresh synchronizes every configured instance', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-multi-full-refresh-test-'));
    tempDirs.push(dir);
    const config = createRuntimeConfig({
      DB_DIR: dir,
      CROWDSEC_USER: 'watcher',
      CROWDSEC_PASSWORD: 'secret',
      CROWDSEC_LOOKBACK_PERIOD: '1h',
      CROWDSEC_REFRESH_INTERVAL: '1h',
      CROWDSEC_MANUAL_REFRESH_ENABLED: 'true',
      AUTH_ENABLED: 'false',
    }, { defaultConfigFile: path.join(dir, 'config.yaml') });
    const base = config.instances[0];
    config.instances = [
      { ...base, id: 'primary', name: 'Primary', lapiUrl: 'http://primary:8080' },
      { ...base, id: 'secondary', name: 'Secondary', lapiUrl: 'http://secondary:8080' },
      { ...base, id: 'edge', name: 'Edge', lapiUrl: 'http://edge:8080' },
    ];
    const database = new CrowdsecDatabase({ dbDir: dir });
    const primary = fakeClient('primary');
    const secondary = fakeClient('secondary');
    const edge = fakeClient('edge');
    const controller = createApp({
      config,
      database,
      lapiClients: new Map([
        ['primary', primary as never],
        ['secondary', secondary as never],
        ['edge', edge as never],
      ]),
      startBackgroundTasks: false,
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
      updateChecker: async () => ({ update_available: false, current_version: 'test', remote_version: 'test', tag: 'test', release_url: '', checked_at: new Date().toISOString() }),
    });

    try {
      const response = await controller.fetch(new Request('http://localhost/api/cache/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'full' }),
      }));
      expect(response.status).toBe(200);
      expect(primary.fetchAlerts).toHaveBeenCalled();
      expect(secondary.fetchAlerts).toHaveBeenCalled();
      expect(edge.fetchAlerts).toHaveBeenCalled();

      const configResponse = await (await controller.fetch(new Request('http://localhost/api/config'))).json() as any;
      expect(configResponse.sync_status).toEqual(expect.objectContaining({
        isSyncing: false,
        progress: 100,
        state: 'complete',
      }));
      expect(configResponse.sync_status.instances.map((instance: any) => instance.instance_id)).toEqual([
        'primary',
        'secondary',
        'edge',
      ]);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
    }
  });

  test('historical reconciliation keeps colliding upstream IDs isolated by instance', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-multi-reconcile-test-'));
    tempDirs.push(dir);
    const config = createRuntimeConfig({
      DB_DIR: dir,
      CROWDSEC_USER: 'watcher',
      CROWDSEC_PASSWORD: 'secret',
      CROWDSEC_LOOKBACK_PERIOD: '1h',
      CROWDSEC_ALERT_SYNC_CHUNK: '1h',
      CROWDSEC_REFRESH_INTERVAL: '1h',
      CROWDSEC_MANUAL_REFRESH_ENABLED: 'true',
      AUTH_ENABLED: 'false',
    }, { defaultConfigFile: path.join(dir, 'config.yaml') });
    const base = config.instances[0];
    config.instances = [
      { ...base, id: 'primary', name: 'Primary', lapiUrl: 'http://primary:8080' },
      { ...base, id: 'secondary', name: 'Secondary', lapiUrl: 'http://secondary:8080' },
    ];
    const database = new CrowdsecDatabase({ dbDir: dir });
    const createdAt = new Date(Date.now() - 10_000).toISOString();
    const stopAt = new Date(Date.now() + 3_600_000).toISOString();
    const alert = {
      id: 7,
      uuid: 'shared-alert-uuid',
      created_at: createdAt,
      message: 'Colliding alert',
      decisions: [{ id: '9', uuid: 'shared-decision-uuid', created_at: createdAt, stop_at: stopAt, value: '192.0.2.7', type: 'ban' }],
    };
    for (const instanceId of ['primary', 'secondary']) {
      database.insertAlert({
        $id: 7,
        $instance_id: instanceId,
        $uuid: alert.uuid,
        $created_at: createdAt,
        $message: alert.message,
        $record: alert,
      });
      database.insertDecision({
        $id: '9',
        $instance_id: instanceId,
        $uuid: 'shared-decision-uuid',
        $alert_id: 7,
        $created_at: createdAt,
        $stop_at: stopAt,
        $value: '192.0.2.7',
        $type: 'ban',
        $record: alert.decisions[0],
      });
    }
    const primary = fakeClient('primary');
    const secondary = fakeClient('secondary');
    primary.fetchAlerts.mockResolvedValue([alert]);
    secondary.fetchAlerts.mockResolvedValue([]);
    const controller = createApp({
      config,
      database,
      lapiClients: new Map([
        ['primary', primary as never],
        ['secondary', secondary as never],
      ]),
      startBackgroundTasks: false,
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: createdAt },
      updateChecker: async () => ({ update_available: false, current_version: 'test', remote_version: 'test', tag: 'test', release_url: '', checked_at: createdAt }),
    });

    try {
      const response = await controller.fetch(new Request('http://localhost/api/cache/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'full' }),
      }));
      expect(response.status).toBe(200);
      expect(database.db.prepare('SELECT instance_id, upstream_id FROM alerts ORDER BY instance_id').all()).toEqual([
        { instance_id: 'primary', upstream_id: '7' },
      ]);
      expect(database.db.prepare('SELECT instance_id, upstream_id FROM decisions ORDER BY instance_id').all()).toEqual([
        { instance_id: 'primary', upstream_id: '9' },
      ]);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
    }
  });

  test('keeps Combined dashboard pending until every initial instance sync settles', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-multi-dashboard-test-'));
    tempDirs.push(dir);
    const config = createRuntimeConfig({
      DB_DIR: dir,
      CROWDSEC_USER: 'watcher',
      CROWDSEC_PASSWORD: 'secret',
      CROWDSEC_REFRESH_INTERVAL: '1h',
      AUTH_ENABLED: 'false',
    }, { defaultConfigFile: path.join(dir, 'config.yaml') });
    const base = config.instances[0];
    config.instances = [
      { ...base, id: 'primary', name: 'Primary', lapiUrl: 'http://primary:8080' },
      { ...base, id: 'secondary', name: 'Secondary', lapiUrl: 'http://secondary:8080' },
    ];
    const database = new CrowdsecDatabase({ dbDir: dir });
    const createdAt = new Date().toISOString();

    let releaseSecondary!: () => void;
    const secondaryGate = new Promise<void>((resolve) => { releaseSecondary = resolve; });
    const primary = fakeClient('primary');
    primary.fetchAlerts.mockResolvedValue([{
      id: 1,
      uuid: 'primary-dashboard-alert',
      created_at: createdAt,
      message: 'Primary dashboard alert',
      decisions: [],
    }]);
    const secondary = fakeClient('secondary');
    secondary.fetchAlerts.mockImplementation(async () => {
      await secondaryGate;
      return [{
        id: 1,
        uuid: 'secondary-dashboard-alert',
        created_at: createdAt,
        message: 'Secondary dashboard alert',
        decisions: [],
      }];
    });

    const controller = createApp({
      config,
      database,
      lapiClients: new Map([
        ['primary', primary as never],
        ['secondary', secondary as never],
      ]),
      startBackgroundTasks: false,
      initialCacheState: { isInitialized: false, isComplete: false, lastUpdate: null },
      updateChecker: async () => ({ update_available: false, current_version: 'test', remote_version: 'test', tag: 'test', release_url: '', checked_at: createdAt }),
    });
    database.insertAlert({
      $id: 1,
      $instance_id: 'primary',
      $uuid: 'primary-dashboard-alert',
      $created_at: createdAt,
      $message: 'Primary dashboard alert',
      $record: { id: 1, uuid: 'primary-dashboard-alert', created_at: createdAt, message: 'Primary dashboard alert', decisions: [] },
    });

    try {
      const secondaryPublished = new Promise<void>((resolve) => {
        const unsubscribe = controller.subscribeCacheUpdates((_updatedAt, instanceIds) => {
          if (instanceIds.includes('secondary')) {
            unsubscribe();
            resolve();
          }
        });
      });
      controller.startBackgroundTasks();
      const pendingConfigResponse = await controller.fetch(new Request('http://localhost/api/config'));
      expect(pendingConfigResponse.status).toBe(200);
      const pendingConfig = await pendingConfigResponse.json() as any;
      expect(pendingConfig.sync_status).toEqual(expect.objectContaining({
        isSyncing: true,
        state: 'syncing',
        instances: expect.arrayContaining([
          expect.objectContaining({ instance_id: 'primary', instance_name: 'Primary' }),
          expect.objectContaining({ instance_id: 'secondary', instance_name: 'Secondary' }),
        ]),
      }));
      const pendingResponse = await controller.fetch(new Request('http://localhost/api/dashboard/stats?instance=all'));
      expect(pendingResponse.status).toBe(200);
      expect(await pendingResponse.json()).toEqual(expect.objectContaining({
        pending: true,
        totals: expect.objectContaining({ alerts: 0 }),
      }));
      const secondaryPendingResponse = await controller.fetch(new Request('http://localhost/api/dashboard/stats?instance=secondary'));
      expect(await secondaryPendingResponse.json()).toEqual(expect.objectContaining({ pending: true }));
      const primaryResponse = await controller.fetch(new Request('http://localhost/api/dashboard/stats?instance=primary'));
      expect(await primaryResponse.json()).toEqual(expect.objectContaining({
        pending: true,
      }));

      releaseSecondary();
      await secondaryPublished;
      expect(database.db.prepare('SELECT instance_id FROM alerts ORDER BY instance_id').all()).toEqual([
        { instance_id: 'primary' },
        { instance_id: 'secondary' },
      ]);

      const response = await controller.fetch(new Request('http://localhost/api/dashboard/stats?instance=all'));
      expect(response.status).toBe(200);
      expect((await response.json() as { totals: { alerts: number } }).totals.alerts).toBe(2);
      const completeConfig = await (await controller.fetch(new Request('http://localhost/api/config'))).json() as any;
      expect(completeConfig.sync_status).toEqual(expect.objectContaining({
        isSyncing: false,
        progress: 100,
        state: 'complete',
      }));
    } finally {
      releaseSecondary();
      controller.stopBackgroundTasks();
      database.close();
    }
  });

  test('Combined reads do not wait for an unfinished secondary bootstrap', async () => {
    const { controller, database } = createMultiController({
      secondarySyncNeverCompletes: true,
      startBackgroundTasks: true,
    });
    const createdAt = new Date().toISOString();
    try {
      database.insertAlert({
        $id: 1,
        $instance_id: 'primary',
        $uuid: 'primary-alert',
        $created_at: createdAt,
        $message: 'Primary is ready',
        $record: { id: 1, uuid: 'primary-alert', created_at: createdAt, message: 'Primary is ready', decisions: [] },
      });

      const response = await Promise.race([
        controller.fetch(new Request('http://localhost/api/alerts?page=1&page_size=50&include_decisions=false&instance=all')),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Combined read remained blocked')), 1_000)),
      ]);
      expect(response.status).toBe(200);
      expect((await response.json() as any).data).toEqual([
        expect.objectContaining({ instance_id: 'primary', message: 'Primary is ready' }),
      ]);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
    }
  });

  test('Combined and scoped reads return rows from every configured instance', async () => {
    const { controller, database } = createMultiController();
    const createdAt = new Date().toISOString();
    const stopAt = new Date(Date.now() + 3_600_000).toISOString();
    try {
      for (const instanceId of ['primary', 'secondary']) {
        database.insertAlert({
          $id: 7,
          $instance_id: instanceId,
          $uuid: 'shared-alert-uuid',
          $created_at: createdAt,
          $message: `${instanceId} alert`,
          $record: { id: 7, uuid: 'shared-alert-uuid', created_at: createdAt, message: `${instanceId} alert`, decisions: [] },
        });
        database.insertDecision({
          $id: '9',
          $instance_id: instanceId,
          $uuid: 'shared-decision-uuid',
          $alert_id: 7,
          $created_at: createdAt,
          $stop_at: stopAt,
          $value: '1.2.3.4',
          $record: { id: 9, uuid: 'shared-decision-uuid', alert_id: 7, created_at: createdAt, stop_at: stopAt, value: '1.2.3.4', type: 'ban' },
        });
      }

      const combinedAlerts = await controller.fetch(new Request('http://localhost/api/alerts?page=1&page_size=50&include_decisions=false&instance=all'));
      expect(combinedAlerts.status).toBe(200);
      expect((await combinedAlerts.json() as any).data.map((row: any) => row.instance_id).sort()).toEqual(['primary', 'secondary']);

      const combinedDecisions = await controller.fetch(new Request('http://localhost/api/decisions?page=1&page_size=50&instance=all'));
      expect(combinedDecisions.status).toBe(200);
      expect((await combinedDecisions.json() as any).data.map((row: any) => row.instance_id).sort()).toEqual(['primary', 'secondary']);

      const secondaryAlerts = await controller.fetch(new Request('http://localhost/api/alerts?page=1&page_size=50&include_decisions=false&instance=secondary'));
      expect((await secondaryAlerts.json() as any).data).toEqual([
        expect.objectContaining({ instance_id: 'secondary', instance_name: 'Secondary' }),
      ]);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
    }
  });

  test('filters alerts and decisions by configured instance name', async () => {
    const { controller, database } = createMultiController({ secondaryName: 'Branch Office' });
    const createdAt = new Date().toISOString();
    const stopAt = new Date(Date.now() + 3_600_000).toISOString();
    try {
      for (const instanceId of ['primary', 'secondary']) {
        database.insertAlert({
          $id: 7,
          $instance_id: instanceId,
          $uuid: `${instanceId}-alert-uuid`,
          $created_at: createdAt,
          $message: `${instanceId} alert`,
          $record: { id: 7, uuid: `${instanceId}-alert-uuid`, created_at: createdAt, message: `${instanceId} alert`, decisions: [] },
        });
        database.insertDecision({
          $id: '9',
          $instance_id: instanceId,
          $uuid: `${instanceId}-decision-uuid`,
          $alert_id: 7,
          $created_at: createdAt,
          $stop_at: stopAt,
          $value: '1.2.3.4',
          $record: { id: 9, uuid: `${instanceId}-decision-uuid`, alert_id: 7, created_at: createdAt, stop_at: stopAt, value: '1.2.3.4', type: 'ban' },
        });
      }

      const query = new URLSearchParams({
        page: '1',
        page_size: '50',
        instance: 'all',
        q: 'instance:"Branch Office"',
      });
      const alerts = await controller.fetch(new Request(`http://localhost/api/alerts?${query}`));
      const decisions = await controller.fetch(new Request(`http://localhost/api/decisions?${query}`));

      expect(alerts.status).toBe(200);
      expect((await alerts.json() as any).data).toEqual([
        expect.objectContaining({ instance_id: 'secondary', instance_name: 'Branch Office' }),
      ]);
      expect(decisions.status).toBe(200);
      expect((await decisions.json() as any).data).toEqual([
        expect.objectContaining({ instance_id: 'secondary', instance_name: 'Branch Office' }),
      ]);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
    }
  });

  test('returns per-instance partial results for Combined decision creation', async () => {
    const { controller, database, primary, secondary } = createMultiController({ secondaryAddFails: true });
    try {
      const response = await controller.fetch(new Request('http://localhost/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: '1.2.3.4', duration: '4h', type: 'ban', scope: 'all' }),
      }));
      expect(response.status).toBe(207);
      expect(await response.json()).toMatchObject({ succeeded: 1, failed: 1, results: [
        { instance_id: 'primary', success: true },
        { instance_id: 'secondary', success: false },
      ] });
      expect(primary.addDecision).toHaveBeenCalledTimes(1);
      expect(secondary.addDecision).toHaveBeenCalledTimes(1);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
    }
  });

  test('bulk row deletion routes colliding IDs only to their owning LAPIs', async () => {
    const { controller, database, primary, secondary } = createMultiController();
    try {
      const response = await controller.fetch(new Request('http://localhost/api/decisions/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refs: [
          { instance_id: 'primary', id: 7 },
          { instance_id: 'secondary', id: 7 },
        ] }),
      }));
      expect(response.status).toBe(200);
      expect(primary.deleteDecision).toHaveBeenCalledExactlyOnceWith('7');
      expect(secondary.deleteDecision).toHaveBeenCalledExactlyOnceWith('7');

      const ambiguous = await controller.fetch(new Request('http://localhost/api/decisions/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [7] }),
      }));
      expect(ambiguous.status).toBe(400);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
    }
  });

  test('Combined IP cleanup evaluates and deletes on every owning LAPI', async () => {
    const { controller, database, primary, secondary } = createMultiController();
    const alert = {
      id: 7,
      created_at: new Date().toISOString(),
      source: { ip: '1.2.3.4', value: '1.2.3.4' },
      decisions: [{ id: 9, value: '1.2.3.4', type: 'ban' }],
    };
    primary.fetchAlerts.mockResolvedValue([alert]);
    secondary.fetchAlerts.mockResolvedValue([alert]);
    try {
      const response = await controller.fetch(new Request('http://localhost/api/cleanup/by-ip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: '1.2.3.4', scope: 'all' }),
      }));
      expect(response.status).toBe(200);
      expect(primary.deleteDecision).toHaveBeenCalledExactlyOnceWith('9');
      expect(primary.deleteAlert).toHaveBeenCalledExactlyOnceWith('7');
      expect(secondary.deleteDecision).toHaveBeenCalledExactlyOnceWith('9');
      expect(secondary.deleteAlert).toHaveBeenCalledExactlyOnceWith('7');
      expect(await response.json()).toMatchObject({ succeeded: 2, failed: 0 });
    } finally {
      controller.stopBackgroundTasks();
      database.close();
    }
  });
});
