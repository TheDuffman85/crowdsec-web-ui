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

describe('createApp synchronization runtime', () => {
  test('fails fast on mixed password and mTLS configuration', () => {
    expect(() => createController({
      env: {
        CROWDSEC_TLS_CERT_PATH: '/certs/agent.pem',
        CROWDSEC_TLS_KEY_PATH: '/certs/agent-key.pem',
      },
    })).toThrow(/choose either CROWDSEC_USER with CROWDSEC_PASSWORD or CROWDSEC_PASSWORD_FILE, or CROWDSEC_TLS_CERT_PATH\/CROWDSEC_TLS_KEY_PATH/i);

    destroyTempDir();
  });

  test('starts without LAPI auth configured but rejects protected API access', async () => {
    const { controller, database } = createController({ authMode: 'none' });

    const health = await controller.fetch(new Request('http://localhost/api/health'));
    expect(health.status).toBe(200);

    const alerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alerts.status).toBe(502);
    expect(await alerts.json()).toEqual({ error: 'Failed to authenticate with CrowdSec LAPI' });

    controller.startBackgroundTasks();
    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('starts a CrowdSec machine heartbeat with background tasks', async () => {
    const { controller, database, lapiClient, fetchCalls } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: 'manual',
        CROWDSEC_HEARTBEAT_INTERVAL: '5s',
      },
    });

    await lapiClient.login();
    vi.useFakeTimers();

    try {
      controller.startBackgroundTasks();
      await vi.advanceTimersByTimeAsync(0);

      const heartbeatRequest = fetchCalls.find((call) => call.url.endsWith('/v1/heartbeat'));
      const usageMetricsRequest = fetchCalls.find((call) => call.url.endsWith('/v1/usage-metrics'));
      expect(heartbeatRequest).toEqual(expect.objectContaining({
        method: 'GET',
      }));
      expect(heartbeatRequest?.headers).toEqual(expect.objectContaining({
        Authorization: 'Bearer token',
      }));
      expect(usageMetricsRequest).toEqual(expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          log_processors: [
            expect.objectContaining({
              os: expect.objectContaining({
                name: expect.any(String),
                version: expect.any(String),
              }),
              version: '1.0.0',
            }),
          ],
        }),
      }));
      expect(usageMetricsRequest?.headers).toEqual(expect.objectContaining({
        Authorization: 'Bearer token',
      }));
    } finally {
      controller.stopBackgroundTasks();
      vi.useRealTimers();
      database.close();
      destroyTempDir();
    }
  });

  test('ignores health checks when deciding whether the refresh scheduler is idle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T06:00:00.000Z'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { controller, database } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '2m',
        CROWDSEC_IDLE_THRESHOLD: '1m',
        CROWDSEC_IDLE_REFRESH_INTERVAL: '10m',
        CROWDSEC_HEARTBEAT_INTERVAL: 'manual',
      },
      initialCacheState: {
        isInitialized: true,
        isComplete: true,
        lastUpdate: new Date().toISOString(),
      },
    });

    try {
      controller.startBackgroundTasks();
      await vi.advanceTimersByTimeAsync(61_000);

      const rootHealth = await controller.fetch(new Request('http://localhost/api/health'));
      const basePathHealth = await controller.fetch(new Request('http://localhost/crowdsec/api/health'));
      expect(rootHealth.status).toBe(200);
      expect(basePathHealth.status).toBe(200);

      await vi.advanceTimersByTimeAsync(59_001);

      const logs = logSpy.mock.calls.map((call) => String(call[0]));
      expect(logs).toContain('Background refresh triggered (IDLE)...');

      const configResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
      expect(configResponse.status).toBe(200);
      expect(logSpy.mock.calls.map((call) => String(call[0]))).toContain(
        'System waking up from idle mode. Triggering immediate refresh...',
      );
    } finally {
      controller.stopBackgroundTasks();
      logSpy.mockRestore();
      vi.useRealTimers();
      database.close();
      destroyTempDir();
    }
  });

  test('pauses background refresh without scheduling retries during an active bootstrap', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let releaseBootstrap!: () => void;
    let bootstrapReleased = false;
    const bootstrapGate = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    const syncWorker: NonNullable<CreateAppOptions['syncWorker']> = {
      persistAlerts: vi.fn(async () => ({ changed: false })),
      deleteAlertsMissingBetween: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      deleteCachedAlerts: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      deleteCachedDecisions: vi.fn(async () => 0),
      beginDeferredSearchIndexUpdates: vi.fn(() => bootstrapGate),
      rebuildSearchIndexes: vi.fn(async () => {}),
      refreshDecisionDuplicateFlags: vi.fn(async () => {}),
      cleanupOldData: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      clearSyncData: vi.fn(async () => {}),
      runExclusive: vi.fn(async (operation) => operation()),
      close: vi.fn(),
    };
    const { controller, database, lapiClient } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '30s',
        CROWDSEC_HEARTBEAT_INTERVAL: '5m',
        CROWDSEC_LAPI_REQUEST_TIMEOUT: '5m',
        CROWDSEC_BOOTSTRAP_RETRY_DELAY: '10s',
      },
      syncWorker,
    });
    await lapiClient.login();
    const realSetTimeout = globalThis.setTimeout;
    vi.useFakeTimers();

    try {
      controller.startBackgroundTasks();
      await vi.advanceTimersByTimeAsync(0);
      expect(syncWorker.beginDeferredSearchIndexUpdates).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(65_000);

      const logs = logSpy.mock.calls.map((call) => String(call[0]));
      expect(logs.filter((message) =>
        message === 'Background refresh paused until bootstrap recovery completes.',
      )).toHaveLength(1);
      expect(logs.some((message) => message.startsWith('Next bootstrap attempt scheduled'))).toBe(false);
      expect(logs.some((message) => message.includes('joining it (bootstrap retry)'))).toBe(false);

      bootstrapReleased = true;
      releaseBootstrap();
      for (let attempt = 0; attempt < 100 && !logSpy.mock.calls.some((call) =>
        String(call[0]).includes('Bootstrap recovery completed successfully'),
      ); attempt += 1) {
        await vi.advanceTimersByTimeAsync(100);
        await new Promise((resolve) => realSetTimeout(resolve, 5));
      }
      expect(controller.getSyncStatus().state).toBe('complete');
    } finally {
      if (!bootstrapReleased) {
        releaseBootstrap();
        await vi.advanceTimersByTimeAsync(1_000);
        await new Promise((resolve) => realSetTimeout(resolve, 0));
      }
      controller.stopBackgroundTasks();
      logSpy.mockRestore();
      vi.useRealTimers();
      database.close();
      destroyTempDir();
    }
  });

  test('does not start a refresh after cache data is visible while bootstrap is still finalizing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let releaseDashboard!: () => void;
    let dashboardReleased = false;
    let dashboardQueryStarted!: () => void;
    const dashboardGate = new Promise<void>((resolve) => {
      releaseDashboard = resolve;
    });
    const dashboardStarted = new Promise<void>((resolve) => {
      dashboardQueryStarted = resolve;
    });
    const queryWorker = {
      all: vi.fn(async () => {
        dashboardQueryStarted();
        await dashboardGate;
        return [];
      }),
      get: vi.fn(async () => ({ count: 0 })),
      close: vi.fn(),
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
      clearSyncData: vi.fn(async () => {}),
      runExclusive: vi.fn(async (operation) => operation()),
      close: vi.fn(),
    };
    const { controller, database, lapiClient, fetchCalls } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '30s',
        CROWDSEC_HEARTBEAT_INTERVAL: 'manual',
      },
      queryWorker,
      syncWorker,
    });
    await lapiClient.login();
    vi.useFakeTimers();

    try {
      controller.startBackgroundTasks();
      await vi.advanceTimersByTimeAsync(0);
      await dashboardStarted;
      const alertRequestsBeforeScheduler = fetchCalls.filter(({ url }) => url.includes('/v1/alerts?')).length;
      await vi.advanceTimersByTimeAsync(30_001);

      const logs = logSpy.mock.calls.map((call) => String(call[0]));
      expect(logs).toContain('Background refresh paused until bootstrap recovery completes.');
      expect(fetchCalls.filter(({ url }) => url.includes('/v1/alerts?'))).toHaveLength(alertRequestsBeforeScheduler);

      dashboardReleased = true;
      releaseDashboard();
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      if (!dashboardReleased) releaseDashboard();
      controller.stopBackgroundTasks();
      logSpy.mockRestore();
      vi.useRealTimers();
      database.close();
      destroyTempDir();
    }
  });

  test('normalizes array-shaped alert detail payloads to a single alert', async () => {
    const { controller, database, lapiClient } = createController({
      alertDetailPayload: [sampleAlert()],
    });
    await lapiClient.login();

    const alertDetails = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/1'));
    expect(alertDetails.status).toBe(200);
    expect(((await alertDetails.json()) as { id: number }).id).toBe(1);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('keeps range-only alerts visible in alerts and decision payloads', async () => {
    const rangeAlert = sampleRangeAlert();
    const { controller, database } = createController({
      fetchResolver: (url) => {
        if (url.includes('/v1/alerts?') && url.includes('scope=range')) {
          return Response.json([rangeAlert]);
        }
        if (url.includes('/v1/alerts?')) {
          return Response.json([]);
        }
        return undefined;
      },
    });

    const alertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alertsResponse.status).toBe(200);
    expect((await alertsResponse.json()) as Array<{ id: number; source: { range?: string } | null }>).toEqual([
      expect.objectContaining({
        id: 14302,
        source: expect.objectContaining({ range: '192.168.5.0/24' }),
      }),
    ]);

    const decisionsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions'));
    expect(decisionsResponse.status).toBe(200);
    expect((await decisionsResponse.json()) as Array<{ id: number; value?: string }>).toEqual([
      expect.objectContaining({ id: 14302, value: '192.168.5.0/24' }),
    ]);

    const statsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/stats/alerts'));
    expect(statsResponse.status).toBe(200);
    expect((await statsResponse.json()) as Array<{ source: { range?: string } | null }>).toEqual([
      expect.objectContaining({
        source: expect.objectContaining({ range: '192.168.5.0/24' }),
      }),
    ]);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('detects simulated decisions from CrowdSec markers when boolean flags are omitted', async () => {
    const implicitSimulatedAlert = sampleImplicitSimulatedAlert();
    const { controller, database, fetchCalls } = createController({
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (url.includes('/v1/alerts?')) {
          return Response.json([implicitSimulatedAlert]);
        }
        return undefined;
      },
    });

    const alerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alerts.status).toBe(200);
    expect((await alerts.json()) as Array<{ id: number; simulated?: boolean }>).toEqual([
      expect.objectContaining({ id: 5, simulated: true }),
    ]);

    const decisions = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions'));
    expect(decisions.status).toBe(200);
    expect((await decisions.json()) as Array<{ id: number; simulated?: boolean; detail: { simulated?: boolean } }>).toEqual([
      expect.objectContaining({
        id: 50,
        simulated: true,
        detail: expect.objectContaining({ simulated: true }),
      }),
    ]);

    const statsAlerts = await controller.fetch(new Request('http://localhost/crowdsec/api/stats/alerts'));
    expect((await statsAlerts.json()) as Array<{ simulated?: boolean }>).toEqual([
      expect.objectContaining({ simulated: true }),
    ]);

    const statsDecisions = await controller.fetch(new Request('http://localhost/crowdsec/api/stats/decisions'));
    expect((await statsDecisions.json()) as Array<{ simulated?: boolean }>).toEqual([
      expect.objectContaining({ simulated: true }),
    ]);

    const alertRequests = fetchCalls.filter((call) => call.url.includes('/v1/alerts?'));
    expect(alertRequests.length).toBeGreaterThan(0);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('filters simulated alerts and decisions when simulations are disabled', async () => {
    const liveAlert = sampleAlert();
    const simulatedAlert = sampleSimulatedAlert();
    const { controller, database, lapiClient } = createController({
      simulationsEnabled: false,
      fetchResolver: (url) => {
        if (url.includes('/v1/alerts?')) {
          return Response.json([liveAlert, simulatedAlert]);
        }
        return undefined;
      },
    });

    database.insertAlert({
      $id: liveAlert.id,
      $uuid: liveAlert.uuid || String(liveAlert.id),
      $created_at: liveAlert.created_at,
      $scenario: liveAlert.scenario,
      $source_ip: liveAlert.source?.ip || '',
      $message: liveAlert.message || '',
      $raw_data: JSON.stringify(liveAlert),
    });
    database.insertAlert({
      $id: simulatedAlert.id,
      $uuid: simulatedAlert.uuid || String(simulatedAlert.id),
      $created_at: simulatedAlert.created_at,
      $scenario: simulatedAlert.scenario,
      $source_ip: simulatedAlert.source?.ip || '',
      $message: simulatedAlert.message || '',
      $raw_data: JSON.stringify(simulatedAlert),
    });
    database.insertDecision({
      $id: '10',
      $uuid: '10',
      $alert_id: 1,
      $created_at: liveAlert.created_at,
      $stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
      $value: '1.2.3.4',
      $type: 'ban',
      $origin: 'manual',
      $scenario: liveAlert.scenario,
      $raw_data: JSON.stringify({
        id: 10,
        created_at: liveAlert.created_at,
        scenario: liveAlert.scenario,
        value: '1.2.3.4',
        stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
        type: 'ban',
        origin: 'manual',
        target: 'ssh',
        simulated: false,
      }),
    });
    database.insertDecision({
      $id: '20',
      $uuid: '20',
      $alert_id: 2,
      $created_at: simulatedAlert.created_at,
      $stop_at: new Date(Date.now() + 45 * 60 * 1_000).toISOString(),
      $value: '5.6.7.8',
      $type: 'ban',
      $origin: 'crowdsec',
      $scenario: simulatedAlert.scenario,
      $raw_data: JSON.stringify({
        id: 20,
        created_at: simulatedAlert.created_at,
        scenario: simulatedAlert.scenario,
        value: '5.6.7.8',
        stop_at: new Date(Date.now() + 45 * 60 * 1_000).toISOString(),
        type: 'ban',
        origin: 'crowdsec',
        target: 'nginx',
        simulated: true,
      }),
    });

    await lapiClient.login();

    const alerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    const alertsJson = await alerts.json() as Array<{ id: number }>;
    expect(alertsJson).toHaveLength(1);
    expect(alertsJson[0]?.id).toBe(1);

    const decisions = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions'));
    const decisionsJson = await decisions.json() as Array<{ id: number }>;
    expect(decisionsJson).toHaveLength(1);
    expect(decisionsJson[0]?.id).toBe(10);

    const statsAlerts = await controller.fetch(new Request('http://localhost/crowdsec/api/stats/alerts'));
    expect(((await statsAlerts.json()) as Array<{ simulated?: boolean }>).every((alert) => alert.simulated !== true)).toBe(true);

    const statsDecisions = await controller.fetch(new Request('http://localhost/crowdsec/api/stats/decisions'));
    expect(((await statsDecisions.json()) as Array<{ simulated?: boolean }>).every((decision) => decision.simulated !== true)).toBe(true);

    const simulatedDetails = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/2'));
    expect(simulatedDetails.status).toBe(404);

    const configResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
    expect(((await configResponse.json()) as { simulations_enabled: boolean }).simulations_enabled).toBe(false);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

 });
