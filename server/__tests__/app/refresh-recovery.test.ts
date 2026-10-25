import { test, expect, vi } from 'vitest';
import path from 'node:path';
import { DatabaseSyncWorker } from '../../sync-worker-client';
import { CrowdsecDatabase } from '../../database';
import type { CreateAppOptions } from '../../app';
import { createController, destroyTempDir, tempDir, seedAlert, sampleAlert } from './harness';

test.each(['wake', 'restart', 'stop'] as const)('keeps one scheduler owner when %s interrupts a refresh', async (action) => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const queryWorker = {
    all: vi.fn(async () => { if (first) { first = false; await gate; } return []; }),
    get: vi.fn(async () => ({ count: 0 })), close: vi.fn(),
  } as unknown as NonNullable<CreateAppOptions['queryWorker']>;
  const syncWorker: NonNullable<CreateAppOptions['syncWorker']> = {
    persistAlerts: vi.fn(async () => ({ changed: false })),
    deleteAlertsMissingBetween: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
    deleteCachedAlerts: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
    deleteCachedDecisions: vi.fn(async () => 0),
    beginDeferredSearchIndexUpdates: vi.fn(async () => {}),
    rebuildSearchIndexes: vi.fn(async () => {}),
    refreshDecisionDuplicateFlags: vi.fn(async () => {}),
    cleanupOldData: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
    clearSyncData: vi.fn(async () => {}), setMeta: vi.fn(async () => {}),
    runExclusive: vi.fn(async operation => operation()), close: vi.fn(),
  };
  const { controller, database, lapiClient } = createController({
    queryWorker, syncWorker,
    env: { CROWDSEC_REFRESH_INTERVAL: '30s', CROWDSEC_IDLE_THRESHOLD: '1m', CROWDSEC_HEARTBEAT_INTERVAL: 'manual' },
    initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
  });
  try {
    await lapiClient.login();
    controller.startBackgroundTasks();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(first).toBe(false);
    if (action === 'wake') {
      vi.setSystemTime(Date.now() + 61_000);
      await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
    } else if (action === 'restart') {
      await controller.fetch(new Request('http://localhost/crowdsec/api/config/refresh-interval', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ interval: '5s' }),
      }));
    } else {
      controller.stopBackgroundTasks();
    }
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(log.mock.calls.some(call => String(call[0]).includes('Delta update complete'))).toBe(true);
    expect(vi.getTimerCount()).toBe(action === 'stop' ? 0 : 1);
    controller.stopBackgroundTasks();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release();
    controller.stopBackgroundTasks();
    vi.clearAllTimers();
    vi.useRealTimers();
    log.mockRestore();
    database.close();
    destroyTempDir();
  }
});

test('rolls back a refresh blocked by a reader and permits queued writes and a later refresh', async () => {
  const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
  seedAlert(database, sampleAlert());
  const worker = new DatabaseSyncWorker({ dbPath: database.dbPath, timeoutMs: 5000 });
  await worker.setMeta('ready', 'true');
  let releaseLookup!: () => void;
  let startedLookup!: () => void;
  const lookupStarted = new Promise<void>(resolve => { startedLookup = resolve; });
  const lookupGate = new Promise<void>(resolve => { releaseLookup = resolve; });
  const lastUpdate = new Date().toISOString();
  const { controller, lapiClient } = createController({
    database, syncWorker: worker,
    env: { CONFIG_STORAGE_QUERY_TIMEOUT: '1s', CONFIG_STORAGE_ANALYTICS_QUERY_TIMEOUT: '1s' },
    attackLocationResolver: { resolve: async locations => { startedLookup(); await lookupGate; return locations; } },
    initialCacheState: { isInitialized: true, isComplete: true, lastUpdate },
  });
  let reachedCommit!: () => void;
  const atCommit = new Promise<void>(resolve => { reachedCommit = resolve; });
  const transaction = worker.runTransaction.bind(worker);
  let transactions = 0;
  vi.spyOn(worker, 'runTransaction').mockImplementation((operation, options) => {
    // The first transaction is the retention cleanup batch, which commits
    // before the delta transaction that the reader blocks.
    const isDelta = transactions++ > 0;
    return transaction(operation, {
      beforeCommit: async () => { if (isDelta) reachedCommit(); await options?.beforeCommit?.(); },
    });
  });
  await lapiClient.login();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const read = controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
  await lookupStarted;
  const requestRefresh = () => controller.fetch(new Request('http://localhost/crowdsec/api/cache/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'delta' }),
  }));
  const refresh = requestRefresh();
  await atCommit;
  const write = worker.runExclusive(() => database.setMeta('later_write', 'done'));
  try {
    await vi.advanceTimersByTimeAsync(31_000);
    expect((await refresh).status).toBe(502);
    await write;
    expect(database.getMeta('later_write')?.value).toBe('done');
    expect(database.countAlerts()).toBe(1);
    expect(controller.getCacheLastUpdate()).toBe(lastUpdate);
    releaseLookup();
    expect((await read).status).toBe(200);
    expect((await requestRefresh()).status).toBe(200);
    expect(database.countAlerts()).toBe(0);
  } finally {
    releaseLookup();
    await read;
    await refresh;
    await write;
    vi.useRealTimers();
    controller.stopBackgroundTasks();
    vi.restoreAllMocks();
    database.close();
    destroyTempDir();
  }
}, 10000);

test('does not resume bootstrap after shutdown during authentication', async () => {
  let releaseLogin!: (response: Response) => void;
  let startedLogin!: () => void;
  const loginStarted = new Promise<void>(resolve => { startedLogin = resolve; });
  const loginGate = new Promise<Response>(resolve => { releaseLogin = resolve; });
  const { controller, database, fetchCalls } = createController({
    env: { CROWDSEC_HEARTBEAT_INTERVAL: 'manual' },
    fetchResolver: url => {
      if (url.endsWith('/v1/watchers/login')) { startedLogin(); return loginGate; }
      return undefined;
    },
  });
  try {
    controller.startBackgroundTasks();
    await loginStarted;
    controller.stopBackgroundTasks();
    database.close();
    releaseLogin(Response.json({ code: 200, token: 'token' }));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fetchCalls.some(call => call.url.includes('/v1/alerts?'))).toBe(false);
    controller.startBackgroundTasks();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fetchCalls.filter(call => call.url.endsWith('/v1/watchers/login'))).toHaveLength(1);
  } finally {
    releaseLogin(Response.json({ code: 200, token: 'token' }));
    controller.stopBackgroundTasks();
    destroyTempDir();
  }
});

test('retries failed cleanup at the minimum batch size and still completes deltas', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['Date'] });
  const cleanupOldData = vi.fn()
    .mockResolvedValueOnce({ alerts: 0, decisions: 1_000 })
    .mockRejectedValueOnce(new Error('Database maintenance exceeded 600000ms timeout (cleanup-old-data)'))
    .mockRejectedValueOnce(new Error('Database maintenance exceeded 600000ms timeout (cleanup-old-data)'))
    .mockResolvedValueOnce({ alerts: 0, decisions: 1 });
  const syncWorker: NonNullable<CreateAppOptions['syncWorker']> = {
    persistAlerts: vi.fn(async () => ({ changed: false })),
    deleteAlertsMissingBetween: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
    deleteCachedAlerts: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
    deleteCachedDecisions: vi.fn(async () => 0),
    beginDeferredSearchIndexUpdates: vi.fn(async () => {}),
    rebuildSearchIndexes: vi.fn(async () => {}),
    refreshDecisionDuplicateFlags: vi.fn(async () => {}),
    cleanupOldData,
    clearSyncData: vi.fn(async () => {}), setMeta: vi.fn(async () => {}),
    runExclusive: vi.fn(async operation => operation()), close: vi.fn(),
  };
  const { controller, database, lapiClient } = createController({
    syncWorker,
    env: { CROWDSEC_HEARTBEAT_INTERVAL: 'manual' },
    initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
  });
  const refresh = () => controller.fetch(new Request('http://localhost/crowdsec/api/cache/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'delta' }),
  }));
  try {
    await lapiClient.login();
    const response = await refresh();
    expect(response.status).toBe(200);
    expect(cleanupOldData).toHaveBeenCalledTimes(2);
    expect(cleanupOldData.mock.calls.map(call => call[1])).toEqual([1_000, 2_000]);
    expect(error.mock.calls.some(call => String(call[0]).includes('Cleanup failed'))).toBe(true);
    expect(log.mock.calls.some(call => String(call[0]).includes('Delta update complete'))).toBe(true);

    // The oversized batch timed out; retry smaller on the next refresh.
    expect((await refresh()).status).toBe(200);
    expect(cleanupOldData.mock.calls.map(call => call[1])).toEqual([1_000, 2_000, 1_000]);
    // A further timeout at the minimum must not shrink the batch below it.
    expect((await refresh()).status).toBe(200);
    expect(cleanupOldData.mock.calls.map(call => call[1])).toEqual([1_000, 2_000, 1_000, 1_000]);
  } finally {
    controller.stopBackgroundTasks();
    vi.useRealTimers();
    log.mockRestore();
    error.mockRestore();
    database.close();
    destroyTempDir();
  }
});

test('adapts cleanup batch size to batch duration and keeps it across refreshes', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['Date'] });
  // Full fast, full fast, full slow, then partial batches.
  const durations = [0, 0, 10_000, 0, 0];
  const cleanupOldData = vi.fn(async (_cutoff: string, limit?: number) => {
    const call = cleanupOldData.mock.calls.length;
    vi.setSystemTime(Date.now() + (durations[call - 1] ?? 0));
    return { alerts: 0, decisions: call <= 3 ? limit ?? 0 : 1 };
  });
  const syncWorker: NonNullable<CreateAppOptions['syncWorker']> = {
    persistAlerts: vi.fn(async () => ({ changed: false })),
    deleteAlertsMissingBetween: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
    deleteCachedAlerts: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
    deleteCachedDecisions: vi.fn(async () => 0),
    beginDeferredSearchIndexUpdates: vi.fn(async () => {}),
    rebuildSearchIndexes: vi.fn(async () => {}),
    refreshDecisionDuplicateFlags: vi.fn(async () => {}),
    cleanupOldData,
    clearSyncData: vi.fn(async () => {}), setMeta: vi.fn(async () => {}),
    runExclusive: vi.fn(async operation => operation()), close: vi.fn(),
  };
  const { controller, database, lapiClient } = createController({
    syncWorker,
    env: { CROWDSEC_HEARTBEAT_INTERVAL: 'manual' },
    initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
  });
  const refresh = () => controller.fetch(new Request('http://localhost/crowdsec/api/cache/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'delta' }),
  }));
  try {
    await lapiClient.login();
    expect((await refresh()).status).toBe(200);
    expect(cleanupOldData.mock.calls.map(call => call[1])).toEqual([1_000, 2_000, 4_000, 2_000]);
    expect((await refresh()).status).toBe(200);
    expect(cleanupOldData.mock.calls.at(-1)?.[1]).toBe(2_000);
  } finally {
    controller.stopBackgroundTasks();
    vi.useRealTimers();
    log.mockRestore();
    database.close();
    destroyTempDir();
  }
});
