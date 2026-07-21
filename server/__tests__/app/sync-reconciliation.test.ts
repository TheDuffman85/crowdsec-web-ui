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

describe('createApp synchronization reconciliation', () => {
  test('queries every alert scope for each bootstrap window', async () => {
    const { controller, database, fetchCalls } = createController({
      env: {
        CROWDSEC_LOOKBACK_PERIOD: '2h',
        CROWDSEC_ALERT_SYNC_CHUNK: '1h',
      },
      fetchResolver: () => undefined,
    });

    const alerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alerts.status).toBe(200);

    expect(fetchCalls.filter((call) => call.url.includes('/v1/alerts?'))).toHaveLength(6);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('keeps an incomplete bootstrap partial without using a filtered deletion fallback', async () => {
    const importedAlert = sampleAlert({
      id: 81,
      uuid: 'alert-81',
      decisions: [{
        id: 810,
        type: 'ban',
        value: '8.8.8.8',
        duration: '30m',
        origin: 'crowdsec',
        simulated: false,
      }],
    });
    const { controller, database } = createController({
      env: {
        CROWDSEC_LOOKBACK_PERIOD: '1h',
        CROWDSEC_ALERT_SYNC_CHUNK: '30m',
        CROWDSEC_ALERT_SYNC_MIN_CHUNK: '30m',
      },
      fetchResolver: (url) => {
        if (!url.includes('/v1/alerts?')) return undefined;
        const parsed = new URL(url);
        const params = parsed.searchParams;
        if (params.get('since')?.startsWith('1h')) {
          const error = new Error('Historical request timeout') as Error & { code?: string };
          error.code = 'ETIMEDOUT';
          throw error;
        }
        return Response.json([importedAlert]);
      },
    });

    const alerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alerts.status).toBe(200);
    expect(database.getDecisionById('810')).not.toBeNull();
    expect(controller.getSyncStatus().state).toBe('partial');

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('prioritizes an older window that contains active decisions without using an active-only query', async () => {
    const alert = sampleAlert({
      id: 82,
      uuid: 'alert-82',
      created_at: new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString(),
      decisions: [{
        id: 820,
        type: 'ban',
        value: '8.8.4.4',
        stop_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      }],
    });
    let bootstrap = true;
    const { controller, database, fetchCalls } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
        CROWDSEC_LOOKBACK_PERIOD: '3h',
        CROWDSEC_ALERT_SYNC_CHUNK: '3h',
        CROWDSEC_RECONCILE_WINDOW: '1h',
        CROWDSEC_RECONCILE_RECENT_AGE: '1h',
        CROWDSEC_RECONCILE_RECENT_INTERVAL: '1s',
        CROWDSEC_RECONCILE_ACTIVE_INTERVAL: '1s',
        CROWDSEC_RECONCILE_OLD_INTERVAL: '1h',
        CROWDSEC_RECONCILE_WINDOWS_PER_REFRESH: '1',
      },
      fetchResolver: (url) => {
        if (!url.includes('/v1/alerts?')) return undefined;
        const params = new URL(url).searchParams;
        if (bootstrap) return Response.json([alert]);
        return Response.json(params.has('until') ? [alert] : []);
      },
    });

    const initial = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(initial.status).toBe(200);
    bootstrap = false;
    const callsBeforeRefresh = fetchCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const refreshed = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(refreshed.status).toBe(200);
    const refreshCalls = fetchCalls.slice(callsBeforeRefresh).filter((call) => call.url.includes('/v1/alerts?'));
    const unscopedCalls = refreshCalls.filter((call) => !new URL(call.url).searchParams.has('scope'));
    expect(unscopedCalls).toHaveLength(2);
    const observedAt = Date.now();
    const alertCreatedAt = Date.parse(alert.created_at);
    expect(unscopedCalls.some((call) => {
      const params = new URL(call.url).searchParams;
      const start = observedAt - parseGoDuration(params.get('since'));
      const end = observedAt - parseGoDuration(params.get('until'));
      return alertCreatedAt >= start && alertCreatedAt < end;
    })).toBe(true);
    expect(database.getDecisionById('820')).not.toBeNull();

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('reserves reconciliation capacity for the least recently checked due window', async () => {
    const now = Date.now();
    const lookbackStart = now - 6 * 60 * 60 * 1_000;
    const firstWindowEnd = (Math.floor(lookbackStart / (60 * 60 * 1_000)) + 1) * 60 * 60 * 1_000;
    const oldCreatedAt = new Date(lookbackStart + Math.max(1, Math.floor((firstWindowEnd - lookbackStart) / 2))).toISOString();
    const activeCreatedAt = new Date(now - 2 * 60 * 60 * 1_000).toISOString();
    const oldAlert = sampleAlert({ id: 85, uuid: 'alert-85', created_at: oldCreatedAt, decisions: [] });
    const activeAlert = sampleAlert({
      id: 86,
      uuid: 'alert-86',
      created_at: activeCreatedAt,
      decisions: [{ id: 860, value: '8.6.0.1', stop_at: new Date(now + 60 * 60 * 1_000).toISOString() }],
    });
    const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
    seedAlert(database, oldAlert);
    seedAlert(database, activeAlert);
    const { controller, fetchCalls } = createController({
      database,
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
        CROWDSEC_LOOKBACK_PERIOD: '6h',
        CROWDSEC_RECONCILE_WINDOW: '1h',
        CROWDSEC_RECONCILE_WINDOWS_PER_REFRESH: '2',
      },
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
      fetchResolver: (url) => url.includes('/v1/alerts?') ? Response.json([oldAlert, activeAlert]) : undefined,
    });

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=50'));
    expect(response.status).toBe(200);
    const unscopedCalls = fetchCalls.filter((call) =>
      call.url.includes('/v1/alerts?') && !new URL(call.url).searchParams.has('scope'),
    );
    expect(unscopedCalls).toHaveLength(3);
    const observedAt = Date.now();
    const requestedRanges = unscopedCalls.map((call) => {
      const params = new URL(call.url).searchParams;
      return {
        start: observedAt - parseGoDuration(params.get('since')),
        end: observedAt - parseGoDuration(params.get('until')),
      };
    });
    expect(requestedRanges.some((range) => Date.parse(oldCreatedAt) >= range.start && Date.parse(oldCreatedAt) < range.end)).toBe(true);
    expect(requestedRanges.some((range) => Date.parse(activeCreatedAt) >= range.start && Date.parse(activeCreatedAt) < range.end)).toBe(true);
    expect(Math.min(...requestedRanges.map((range) => range.start))).toBeGreaterThanOrEqual(lookbackStart - 35_000);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('pads relative LAPI boundaries before exact local reconciliation', async () => {
    const now = Date.now();
    const windowMs = 60 * 60 * 1_000;
    const boundary = Math.floor((now - 2 * windowMs) / windowMs) * windowMs;
    const boundaryAlert = sampleAlert({
      id: 87,
      uuid: 'alert-87',
      created_at: new Date(boundary).toISOString(),
      decisions: [{ id: 870, value: '8.7.0.1', stop_at: new Date(now + windowMs).toISOString() }],
    });
    const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
    seedAlert(database, boundaryAlert);
    const { controller } = createController({
      database,
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
        CROWDSEC_LOOKBACK_PERIOD: '3h',
        CROWDSEC_LAPI_REQUEST_TIMEOUT: '5s',
        CROWDSEC_RECONCILE_WINDOW: '1h',
        CROWDSEC_RECONCILE_WINDOWS_PER_REFRESH: '2',
      },
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
      fetchResolver: (url) => {
        if (!url.includes('/v1/alerts?')) return undefined;
        const params = new URL(url).searchParams;
        const requestNow = Date.now();
        const requestStart = requestNow - parseGoDuration(params.get('since'));
        const requestEnd = requestNow - parseGoDuration(params.get('until'));
        return Response.json(boundary >= requestStart && boundary < requestEnd ? [boundaryAlert] : []);
      },
    });

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=50'));
    expect(response.status).toBe(200);
    expect(database.getAlertsSince(new Date(boundary).toISOString()).map((row) => JSON.parse(row.raw_data).id)).toContain(87);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('reuses the delta request when the moving head is due', async () => {
    const now = Date.now();
    const currentWindowStart = Math.floor(now / (60 * 60 * 1_000)) * 60 * 60 * 1_000;
    const alert = sampleAlert({
      id: 88,
      uuid: 'alert-88',
      created_at: new Date(Math.max(now - 30_000, currentWindowStart)).toISOString(),
      decisions: [{ id: 880, value: '8.8.0.1', stop_at: new Date(now + 60 * 60 * 1_000).toISOString() }],
    });
    let bootstrap = true;
    const { controller, database, fetchCalls } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
        CROWDSEC_LOOKBACK_PERIOD: '2h',
        CROWDSEC_ALERT_SYNC_CHUNK: '2h',
        CROWDSEC_RECONCILE_WINDOW: '1h',
        CROWDSEC_RECONCILE_ACTIVE_INTERVAL: '1s',
        CROWDSEC_RECONCILE_RECENT_INTERVAL: '1h',
        CROWDSEC_RECONCILE_OLD_INTERVAL: '1h',
        CROWDSEC_RECONCILE_WINDOWS_PER_REFRESH: '1',
      },
      fetchResolver: (url) => {
        if (!url.includes('/v1/alerts?')) return undefined;
        if (bootstrap) return Response.json([alert]);
        return Response.json([alert]);
      },
    });

    expect((await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'))).status).toBe(200);
    bootstrap = false;
    const callsBeforeRefresh = fetchCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect((await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'))).status).toBe(200);

    const refreshAlertCalls = fetchCalls.slice(callsBeforeRefresh).filter((call) => call.url.includes('/v1/alerts?'));
    expect(refreshAlertCalls).toHaveLength(3);
    expect(refreshAlertCalls.every((call) => new URL(call.url).searchParams.has('until'))).toBe(true);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('reuses persisted reconciliation progress after restart', async () => {
    const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
    const env = {
      CROWDSEC_REFRESH_INTERVAL: '0',
      CROWDSEC_LOOKBACK_PERIOD: '2h',
      CROWDSEC_ALERT_SYNC_CHUNK: '2h',
      CROWDSEC_RECONCILE_WINDOW: '1h',
      CROWDSEC_RECONCILE_ACTIVE_INTERVAL: '1h',
      CROWDSEC_RECONCILE_RECENT_INTERVAL: '1h',
      CROWDSEC_RECONCILE_OLD_INTERVAL: '1h',
      CROWDSEC_RECONCILE_WINDOWS_PER_REFRESH: '2',
    };
    const first = createController({
      database,
      env,
      fetchResolver: (url) => url.includes('/v1/alerts?') ? Response.json([]) : undefined,
    });
    expect((await first.controller.fetch(new Request('http://localhost/crowdsec/api/alerts'))).status).toBe(200);
    first.controller.stopBackgroundTasks();

    const second = createController({
      database,
      env,
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
      fetchResolver: (url) => url.includes('/v1/alerts?') ? Response.json([]) : undefined,
    });
    expect((await second.controller.fetch(new Request('http://localhost/crowdsec/api/alerts'))).status).toBe(200);
    expect(second.fetchCalls.filter((call) => call.url.includes('/v1/alerts?'))).toHaveLength(3);

    second.controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('does not delete cached alerts when any reconciliation scope fails', async () => {
    const createdAt = new Date(Date.now() - 30_000).toISOString();
    const keptAlert = sampleAlert({ id: 83, uuid: 'alert-83', created_at: createdAt });
    const cachedOnlyAlert = sampleAlert({ id: 84, uuid: 'alert-84', created_at: createdAt });
    const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
    seedAlert(database, keptAlert);
    seedAlert(database, cachedOnlyAlert);
    const { controller } = createController({
      database,
      env: { CROWDSEC_REFRESH_INTERVAL: '0' },
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
      fetchResolver: (url) => {
        if (!url.includes('/v1/alerts?')) return undefined;
        const params = new URL(url).searchParams;
        if (!params.has('until')) return Response.json([]);
        if (params.get('scope') === 'ip') throw new Error('ip scope failed');
        return Response.json([keptAlert]);
      },
    });

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=50'));
    expect(response.status).toBe(200);
    expect((await response.json() as { pagination: { total: number } }).pagination.total).toBe(2);
    expect(database.getAlertsSince(new Date(Date.now() - 60_000).toISOString())).toHaveLength(2);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('keeps the initial sync visible until indexes and dashboard data are finalized', async () => {
    let releaseIndexRebuild = () => {};
    const indexRebuild = new Promise<void>((resolve) => {
      releaseIndexRebuild = resolve;
    });
    const syncWorker: NonNullable<CreateAppOptions['syncWorker']> = {
      persistAlerts: vi.fn(async () => ({ changed: false })),
      deleteAlertsMissingBetween: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      deleteCachedAlerts: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      deleteCachedDecisions: vi.fn(async () => 0),
      beginDeferredSearchIndexUpdates: vi.fn(async () => {}),
      rebuildSearchIndexes: vi.fn(() => indexRebuild),
      refreshDecisionDuplicateFlags: vi.fn(async () => {}),
      cleanupOldData: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      clearSyncData: vi.fn(async () => {}),
      runExclusive: vi.fn(async (operation) => operation()),
      close: vi.fn(),
    };
    const { controller, database } = createController({ syncWorker });

    const alertsRequest = controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    await vi.waitFor(() => expect(syncWorker.rebuildSearchIndexes).toHaveBeenCalled());
    expect(syncWorker.beginDeferredSearchIndexUpdates).toHaveBeenCalledWith(true);
    expect(controller.getSyncStatus()).toEqual(expect.objectContaining({
      isSyncing: true,
      progress: 98,
      message: 'Building search indexes...',
      completedAt: null,
    }));

    releaseIndexRebuild();
    expect((await alertsRequest).status).toBe(200);
    expect(controller.getSyncStatus()).toEqual(expect.objectContaining({
      isSyncing: false,
      progress: 100,
      completedAt: expect.any(String),
    }));

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('defers search writes while reconciling a populated startup cache', async () => {
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
    const syncedAlert = sampleAlert({ id: 301, uuid: 'alert-301' });
    const { controller, database } = createController({
      syncWorker,
      fetchResolver: (url) => url.includes('/v1/alerts?') ? Response.json([syncedAlert]) : undefined,
    });
    seedAlert(database, sampleAlert({ id: 300, uuid: 'alert-300' }));

    try {
      const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
      expect(response.status).toBe(200);
      expect(syncWorker.beginDeferredSearchIndexUpdates).toHaveBeenCalledWith(false);
      expect(syncWorker.deleteAlertsMissingBetween).toHaveBeenCalled();
      expect(syncWorker.rebuildSearchIndexes).toHaveBeenCalledOnce();
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('completes historical bootstrap without a follow-up filtered sync', async () => {
    const activeAlert = sampleAlert({
      id: 91,
      uuid: 'alert-91',
      decisions: [{
        id: 910,
        type: 'ban',
        value: '9.9.9.9',
        duration: '30m',
        origin: 'crowdsec',
        simulated: false,
      }],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { controller, database, fetchCalls } = createController({
      env: {
        CROWDSEC_LOOKBACK_PERIOD: '30m',
        CROWDSEC_ALERT_SYNC_CHUNK: '30m',
        CROWDSEC_ALERT_SYNC_MIN_CHUNK: '30m',
        CROWDSEC_BOOTSTRAP_RETRY_DELAY: '5m',
      },
      fetchResolver: (url) => {
        if (!url.includes('/v1/alerts?')) return undefined;
        return Response.json([activeAlert]);
      },
    });

    try {
      const alerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
      expect(alerts.status).toBe(200);
      expect(database.getDecisionById('910')).not.toBeNull();
      expect(controller.getSyncStatus()).toEqual(expect.objectContaining({
        state: 'complete',
        errors: [],
      }));
      expect(fetchCalls.filter((call) => call.url.includes('/v1/alerts?'))).toHaveLength(3);

      const logs = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      const warnings = warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logs).toContain('Cache initialized successfully');
      expect(warnings).not.toContain('Cache initialized partially');
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

 });
