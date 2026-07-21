import { describe, expect, test, vi } from 'vitest';
import path from 'path';
import { CrowdsecDatabase } from '../../database';
import type { CreateAppOptions } from '../../app';
import { parseGoDuration } from '../../utils/duration';
import {
  createController,
  destroyTempDir,
  sampleAlert,
  sampleImplicitSimulatedAlert,
  sampleRangeAlert,
  sampleSimulatedAlert,
  seedAlert,
  tempDir,
} from './harness';

describe('createApp synchronization bootstrap', () => {
  test('bootstraps successfully with mTLS authentication', async () => {
    const { controller, database, fetchCalls } = createController({ authMode: 'mtls' });

    const alerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alerts.status).toBe(200);

    const loginRequest = fetchCalls.find((call) => call.url.endsWith('/v1/watchers/login'));
    expect(loginRequest).toBeDefined();
    expect(loginRequest?.body).toEqual({ scenarios: ['manual/web-ui'] });
    expect(loginRequest?.dispatcher).toBeTruthy();

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('logs decision counts during bootstrap sync', async () => {
    const stopAt = new Date(Date.now() + 30 * 60 * 1_000).toISOString();
    const alert = sampleAlert({
      id: 71,
      uuid: 'alert-71',
      decisions: [
        {
          id: 710,
          type: 'ban',
          value: '1.2.3.4',
          duration: '30m',
          stop_at: stopAt,
          origin: 'manual',
          simulated: false,
        },
        {
          id: 711,
          type: 'ban',
          value: '1.2.3.5',
          duration: '30m',
          stop_at: stopAt,
          origin: 'manual',
          simulated: false,
        },
      ],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { controller, database } = createController({
      fetchResolver: (url) => {
        if (url.includes('/v1/alerts?')) {
          return Response.json([alert]);
        }
        return undefined;
      },
    });

    try {
      const alerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
      expect(alerts.status).toBe(200);

      const logs = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logs).toContain('Fetched 1 alerts and 2 decisions.');
      expect(logs).toContain(
        `Cache initialized successfully:
  Historical: 1 alerts and 2 decisions fetched
  Cache: 1 alerts and 2 decisions
  Status: complete
  Refresh Interval: 30s
`,
      );
      expect(logs).not.toContain('Historical chunk sync complete');
    } finally {
      logSpy.mockRestore();
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('bounds sync transactions by decision volume so interactive writes can run between them', async () => {
    const alerts = Array.from({ length: 4 }, (_, alertIndex) => sampleAlert({
      id: 100 + alertIndex,
      uuid: `alert-${100 + alertIndex}`,
      decisions: Array.from({ length: 300 }, (_, decisionIndex) => ({
        id: `${alertIndex}-${decisionIndex}`,
        type: 'ban',
        value: `10.${alertIndex}.${Math.floor(decisionIndex / 255)}.${decisionIndex % 255}`,
        duration: '30m',
        stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
        origin: 'crowdsec',
        simulated: false,
      })),
    }));
    const syncWorker: NonNullable<CreateAppOptions['syncWorker']> = {
      persistAlerts: vi.fn(async () => ({ changed: false })),
      deleteAlertsMissingBetween: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      deleteCachedAlerts: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      deleteCachedDecisions: vi.fn(async () => 0),
      beginDeferredSearchIndexUpdates: vi.fn(async () => {}),
      rebuildSearchIndexes: vi.fn(async () => {}),
      refreshDecisionDuplicateFlags: vi.fn(async () => {}),
      cleanupOldData: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      clearSyncData: vi.fn(async () => {}),
      runExclusive: vi.fn(async (operation) => operation()),
      close: vi.fn(),
    };
    const { controller, database } = createController({
      syncWorker,
      fetchResolver: (url) => {
        if (!url.includes('/v1/alerts?')) return undefined;
        return Response.json(alerts);
      },
    });

    try {
      const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
      expect(response.status).toBe(200);

      const batches = vi.mocked(syncWorker.persistAlerts).mock.calls.map(([mutations]) => mutations);
      expect(batches).toHaveLength(4);
      expect(batches.every((mutations) =>
        mutations.reduce((total, mutation) => total + mutation.decisions.length, 0) <= 500,
      )).toBe(true);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('splits a single blocklist alert across bounded decision transactions', async () => {
    const decisionCount = 1_201;
    const blocklistAlert = sampleAlert({
      id: 200,
      uuid: 'alert-200',
      scenario: 'crowdsecurity/blocklist-import',
      decisions: Array.from({ length: decisionCount }, (_, decisionIndex) => ({
        id: `blocklist-${decisionIndex}`,
        type: 'ban',
        value: `198.51.${Math.floor(decisionIndex / 255)}.${decisionIndex % 255}`,
        duration: '24h',
        stop_at: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
        origin: 'lists',
        simulated: false,
      })),
    });
    const syncWorker: NonNullable<CreateAppOptions['syncWorker']> = {
      persistAlerts: vi.fn(async () => ({ changed: false })),
      deleteAlertsMissingBetween: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      deleteCachedAlerts: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      deleteCachedDecisions: vi.fn(async () => 0),
      beginDeferredSearchIndexUpdates: vi.fn(async () => {}),
      rebuildSearchIndexes: vi.fn(async () => {}),
      refreshDecisionDuplicateFlags: vi.fn(async () => {}),
      cleanupOldData: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      clearSyncData: vi.fn(async () => {}),
      runExclusive: vi.fn(async (operation) => operation()),
      close: vi.fn(),
    };
    const { controller, database } = createController({
      syncWorker,
      fetchResolver: (url) => {
        if (!url.includes('/v1/alerts?')) return undefined;
        return Response.json([blocklistAlert]);
      },
    });

    try {
      const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
      expect(response.status).toBe(200);

      const batches = vi.mocked(syncWorker.persistAlerts).mock.calls.map(([mutations]) => mutations);
      expect(batches).toHaveLength(3);
      expect(batches.map((mutations) =>
        mutations.reduce((total, mutation) => total + mutation.decisions.length, 0),
      )).toEqual([500, 500, 201]);

      const fragments = batches.flat();
      expect(fragments.filter((mutation) => mutation.alert)).toHaveLength(1);
      expect(fragments.slice(0, -1).every((mutation) =>
        mutation.reconcileDecisions === false && mutation.keepDecisionIds.length === 0,
      )).toBe(true);
      expect(fragments.at(-1)).toMatchObject({
        alertId: 200,
        reconcileDecisions: false,
        keepDecisionIds: [],
      });
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('skips database writes when a reconciled alert is unchanged', async () => {
    const decisionCount = 1_201;
    const activeAlert = sampleAlert({
      id: 205,
      uuid: 'alert-205',
      decisions: Array.from({ length: decisionCount }, (_, decisionIndex) => ({
        id: `active-${decisionIndex}`,
        type: 'ban',
        value: `198.51.${Math.floor(decisionIndex / 255)}.${decisionIndex % 255}`,
        duration: '24h',
        stop_at: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
        origin: 'lists',
        simulated: false,
      })),
    });
    const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
    seedAlert(database, activeAlert);
    const decisionStopAtLookup = vi.spyOn(database, 'getDecisionStopAtBatch');
    const syncWorker: NonNullable<CreateAppOptions['syncWorker']> = {
      persistAlerts: vi.fn(async () => ({ changed: false })),
      deleteAlertsMissingBetween: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      deleteCachedAlerts: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      deleteCachedDecisions: vi.fn(async () => 0),
      beginDeferredSearchIndexUpdates: vi.fn(async () => {}),
      rebuildSearchIndexes: vi.fn(async () => {}),
      refreshDecisionDuplicateFlags: vi.fn(async () => {}),
      cleanupOldData: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      clearSyncData: vi.fn(async () => {}),
      runExclusive: vi.fn(async (operation) => operation()),
      close: vi.fn(),
    };
    const { controller } = createController({
      database,
      syncWorker,
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
        CROWDSEC_LOOKBACK_PERIOD: '1m',
      },
      initialCacheState: {
        isInitialized: true,
        isComplete: true,
        lastUpdate: new Date().toISOString(),
      },
      fetchResolver: (url) => {
        if (!url.includes('/v1/alerts?')) return undefined;
        return Response.json(new URL(url).searchParams.has('until') ? [activeAlert] : []);
      },
    });

    try {
      const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=10'));
      expect(response.status).toBe(200);
      expect(syncWorker.persistAlerts).not.toHaveBeenCalled();
      expect(decisionStopAtLookup).not.toHaveBeenCalled();
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('writes only added decisions and does not replay survivors during window reconciliation', async () => {
    const initialAlert = sampleAlert({
      id: 207,
      uuid: 'alert-207',
      decisions: Array.from({ length: 1_201 }, (_, index) => ({
        id: `delta-${index}`,
        type: 'ban',
        value: `203.0.${Math.floor(index / 255)}.${index % 255}`,
        stop_at: new Date(Date.now() + 60_000).toISOString(),
      })),
    });
    const addedAlert = {
      ...initialAlert,
      decisions: [
        ...(initialAlert.decisions || []),
        { id: 'delta-new', type: 'ban', value: '203.0.113.250', stop_at: new Date(Date.now() + 60_000).toISOString() },
      ],
    };
    const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
    seedAlert(database, initialAlert);
    const syncWorker: NonNullable<CreateAppOptions['syncWorker']> = {
      persistAlerts: vi.fn(async () => ({ changed: true })),
      deleteAlertsMissingBetween: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      deleteCachedAlerts: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      deleteCachedDecisions: vi.fn(async () => 0),
      beginDeferredSearchIndexUpdates: vi.fn(async () => {}),
      rebuildSearchIndexes: vi.fn(async () => {}),
      refreshDecisionDuplicateFlags: vi.fn(async () => {}),
      cleanupOldData: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      clearSyncData: vi.fn(async () => {}),
      runExclusive: vi.fn(async (operation) => operation()),
      close: vi.fn(),
    };
    const initialSyncCursor = new Date(Date.now() - 60_000).toISOString();
    const { controller } = createController({
      database,
      syncWorker,
      env: { CROWDSEC_REFRESH_INTERVAL: '0', CROWDSEC_LOOKBACK_PERIOD: '1m' },
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: initialSyncCursor },
      fetchResolver: (url) => {
        if (!url.includes('/v1/alerts?')) return undefined;
        return Response.json(new URL(url).searchParams.has('until') ? [addedAlert] : []);
      },
    });

    try {
      const cacheUpdates: string[] = [];
      const unsubscribe = controller.subscribeCacheUpdates((updatedAt) => cacheUpdates.push(updatedAt));
      const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=10'));
      unsubscribe();
      expect(response.status).toBe(200);
      const mutations = vi.mocked(syncWorker.persistAlerts).mock.calls.flatMap(([batch]) => batch);
      expect(mutations).toHaveLength(1);
      expect(mutations[0]?.decisions.map((decision) => decision.$id)).toEqual(['delta-new']);
      expect(mutations[0]?.keepDecisionIds).toEqual([]);
      expect(mutations[0]?.reconcileDecisions).toBe(false);
      expect(mutations[0]?.updateAlertRawDataOnly).toBe(true);
      expect(syncWorker.deleteCachedDecisions).not.toHaveBeenCalled();
      expect(cacheUpdates).toEqual([controller.getCacheLastUpdate()]);
      expect(controller.getCacheLastUpdate()).not.toBe(initialSyncCursor);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('defers search-index writes while importing a large delta alert', async () => {
    const largeDeltaAlert = sampleAlert({
      id: 209,
      uuid: 'alert-209',
      decisions: Array.from({ length: 10_001 }, (_, index) => ({
        id: `large-delta-${index}`,
        type: 'ban',
        value: `198.${Math.floor(index / 65_025)}.${Math.floor(index / 255) % 255}.${index % 255}`,
        stop_at: new Date(Date.now() + 60_000).toISOString(),
        origin: 'lists',
      })),
    });
    const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
    const syncWorker: NonNullable<CreateAppOptions['syncWorker']> = {
      persistAlerts: vi.fn(async () => ({ changed: true })),
      deleteAlertsMissingBetween: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      deleteCachedAlerts: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      deleteCachedDecisions: vi.fn(async () => 0),
      beginDeferredSearchIndexUpdates: vi.fn(async () => {}),
      rebuildSearchIndexes: vi.fn(async () => {}),
      refreshDecisionDuplicateFlags: vi.fn(async () => {}),
      cleanupOldData: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      clearSyncData: vi.fn(async () => {}),
      runExclusive: vi.fn(async (operation) => operation()),
      close: vi.fn(),
    };
    const { controller } = createController({
      database,
      syncWorker,
      env: { CROWDSEC_REFRESH_INTERVAL: '0', CROWDSEC_LOOKBACK_PERIOD: '1m' },
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
      fetchResolver: (url) => {
        if (!url.includes('/v1/alerts?')) return undefined;
        return Response.json(new URL(url).searchParams.has('until') ? [largeDeltaAlert] : []);
      },
    });

    try {
      const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=10'));
      expect(response.status).toBe(200);
      expect(syncWorker.beginDeferredSearchIndexUpdates).toHaveBeenCalledWith(false, false);
      expect(syncWorker.rebuildSearchIndexes).toHaveBeenCalledWith({
        alertIds: ['209'],
        decisionIds: largeDeltaAlert.decisions?.map((decision) => String(decision.id)),
      });
      expect(vi.mocked(syncWorker.persistAlerts).mock.calls).toHaveLength(21);
      expect(vi.mocked(syncWorker.persistAlerts).mock.calls.every(([mutations]) =>
        mutations.reduce((total, mutation) => total + mutation.decisions.length, 0) <= 500,
      )).toBe(true);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('deletes a missing decision without replaying survivors during window reconciliation', async () => {
    const initialAlert = sampleAlert({
      id: 208,
      uuid: 'alert-208',
      decisions: Array.from({ length: 1_201 }, (_, index) => ({
        id: `delete-delta-${index}`,
        type: 'ban',
        value: `192.0.${Math.floor(index / 255)}.${index % 255}`,
        stop_at: new Date(Date.now() + 60_000).toISOString(),
      })),
    });
    const refreshedAlert = { ...initialAlert, decisions: initialAlert.decisions?.slice(0, -1) };
    const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
    seedAlert(database, initialAlert);
    const syncWorker: NonNullable<CreateAppOptions['syncWorker']> = {
      persistAlerts: vi.fn(async () => ({ changed: true })),
      deleteAlertsMissingBetween: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      deleteCachedAlerts: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      deleteCachedDecisions: vi.fn(async () => 0),
      beginDeferredSearchIndexUpdates: vi.fn(async () => {}),
      rebuildSearchIndexes: vi.fn(async () => {}),
      refreshDecisionDuplicateFlags: vi.fn(async () => {}),
      cleanupOldData: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      clearSyncData: vi.fn(async () => {}),
      runExclusive: vi.fn(async (operation) => operation()),
      close: vi.fn(),
    };
    const { controller } = createController({
      database,
      syncWorker,
      env: { CROWDSEC_REFRESH_INTERVAL: '0', CROWDSEC_LOOKBACK_PERIOD: '1m' },
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
      fetchResolver: (url) => {
        if (!url.includes('/v1/alerts?')) return undefined;
        return Response.json(new URL(url).searchParams.has('until') ? [refreshedAlert] : []);
      },
    });

    try {
      const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=10'));
      expect(response.status).toBe(200);
      const mutations = vi.mocked(syncWorker.persistAlerts).mock.calls.flatMap(([batch]) => batch);
      expect(mutations).toHaveLength(1);
      expect(mutations[0]?.decisions).toEqual([]);
      expect(mutations[0]?.keepDecisionIds).toEqual([]);
      expect(mutations[0]?.reconcileDecisions).toBe(false);
      expect(mutations[0]?.updateAlertRawDataOnly).toBe(true);
      expect(syncWorker.deleteCachedDecisions).toHaveBeenCalledWith(['delete-delta-1200']);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('repairs an incomplete decision cache even when the cached alert lists every decision', async () => {
    const activeAlert = sampleAlert({
      id: 206,
      uuid: 'alert-206',
      decisions: [
        { id: 2060, type: 'ban', value: '198.51.100.1', stop_at: new Date(Date.now() + 60_000).toISOString() },
        { id: 2061, type: 'ban', value: '198.51.100.2', stop_at: new Date(Date.now() + 60_000).toISOString() },
      ],
    });
    const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
    seedAlert(database, activeAlert);
    database.deleteDecision('2061');
    const syncWorker: NonNullable<CreateAppOptions['syncWorker']> = {
      persistAlerts: vi.fn(async () => ({ changed: true })),
      deleteAlertsMissingBetween: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      deleteCachedAlerts: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      deleteCachedDecisions: vi.fn(async () => 0),
      beginDeferredSearchIndexUpdates: vi.fn(async () => {}),
      rebuildSearchIndexes: vi.fn(async () => {}),
      refreshDecisionDuplicateFlags: vi.fn(async () => {}),
      cleanupOldData: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      clearSyncData: vi.fn(async () => {}),
      runExclusive: vi.fn(async (operation) => operation()),
      close: vi.fn(),
    };
    const { controller } = createController({
      database,
      syncWorker,
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
        CROWDSEC_LOOKBACK_PERIOD: '1m',
      },
      initialCacheState: {
        isInitialized: true,
        isComplete: true,
        lastUpdate: new Date().toISOString(),
      },
      fetchResolver: (url) => {
        if (!url.includes('/v1/alerts?')) return undefined;
        return Response.json(new URL(url).searchParams.has('until') ? [activeAlert] : []);
      },
    });

    try {
      const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=10'));
      expect(response.status).toBe(200);
      expect(syncWorker.persistAlerts).toHaveBeenCalled();
      expect(vi.mocked(syncWorker.persistAlerts).mock.calls.flatMap(([mutations]) => mutations).flatMap((mutation) => mutation.decisions)).toHaveLength(1);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

 });
