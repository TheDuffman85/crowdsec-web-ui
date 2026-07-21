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

describe('createApp synchronization consistency and pruning', () => {
  test('keeps alerts and decisions endpoints consistent when sync repairs stale cached decisions', async () => {
    const createdAt = new Date().toISOString();
    const stopAt = new Date(Date.now() + 30 * 60 * 1_000).toISOString();
    const syncedAlert = sampleAlert({
      id: 200,
      uuid: 'alert-200',
      created_at: createdAt,
      source: {
        ip: '2.2.2.2',
        value: '2.2.2.2',
        cn: 'DE',
        as_name: 'Hetzner',
      },
      decisions: [
        {
          id: 2001,
          type: 'ban',
          value: '2.2.2.2',
          duration: '30m',
          stop_at: stopAt,
          origin: 'manual',
          scenario: 'crowdsecurity/ssh-bf',
          simulated: false,
        },
      ],
      simulated: false,
    });

    const { controller, database } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (url.includes('/v1/alerts?')) {
          return Response.json([syncedAlert]);
        }
        return undefined;
      },
    });

    seedAlert(database, syncedAlert);
    database.insertDecision({
      $id: '2999',
      $uuid: '2999',
      $alert_id: 200,
      $created_at: createdAt,
      $stop_at: new Date(Date.now() + 45 * 60 * 1_000).toISOString(),
      $value: '2.2.2.2',
      $type: 'ban',
      $origin: 'manual',
      $scenario: 'crowdsecurity/ssh-bf',
      $raw_data: JSON.stringify({
        id: 2999,
        created_at: createdAt,
        scenario: 'crowdsecurity/ssh-bf',
        value: '2.2.2.2',
        stop_at: new Date(Date.now() + 45 * 60 * 1_000).toISOString(),
        type: 'ban',
        origin: 'manual',
        country: 'DE',
        as: 'Hetzner',
        target: 'ssh',
        alert_id: 200,
        simulated: false,
      }),
    });

    const alertsResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/alerts?page=1&page_size=50&include_decisions=false',
    ));
    expect(alertsResponse.status).toBe(200);
    const alertsJson = await alertsResponse.json() as {
      data: Array<{ id: number; decisions: unknown[]; decision_summary: { active_count: number; expired_count: number } }>;
    };
    const alertRow = alertsJson.data.find((alert) => alert.id === 200);
    expect(alertRow).toMatchObject({
      decisions: [],
      decision_summary: { active_count: 1, expired_count: 0 },
    });

    const decisionsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions?page=1&page_size=50&alert_id=200&include_expired=true'));
    expect(decisionsResponse.status).toBe(200);
    const decisionsJson = await decisionsResponse.json() as {
      data: Array<{ id: number }>;
      pagination: { total: number };
    };
    expect(decisionsJson.pagination.total).toBe(1);
    expect(decisionsJson.data.map((decision) => decision.id)).toEqual([2001]);
    expect(database.getDecisionById('2999')).toBeNull();

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('removes stale decisions during scheduled window reconciliation and updates alert payloads to match', async () => {
    const createdAt = new Date(Date.now() - 30_000).toISOString();
    const initialStopAt = new Date(Date.now() + 30 * 60 * 1_000).toISOString();
    const staleStopAt = new Date(Date.now() + 45 * 60 * 1_000).toISOString();
    const initialAlert = sampleAlert({
      id: 210,
      uuid: 'alert-210',
      created_at: createdAt,
      source: {
        ip: '3.3.3.3',
        value: '3.3.3.3',
        cn: 'US',
        as_name: 'DigitalOcean',
      },
      decisions: [
        {
          id: 2101,
          type: 'ban',
          value: '3.3.3.3',
          duration: '30m',
          stop_at: initialStopAt,
          origin: 'manual',
          scenario: 'crowdsecurity/http-probing',
          simulated: false,
        },
        {
          id: 2102,
          type: 'ban',
          value: '3.3.3.3',
          duration: '45m',
          stop_at: staleStopAt,
          origin: 'manual',
          scenario: 'crowdsecurity/http-probing',
          simulated: false,
        },
      ],
      simulated: false,
    });
    const refreshedAlert = sampleAlert({
      id: 210,
      uuid: 'alert-210',
      created_at: createdAt,
      source: initialAlert.source,
      decisions: [
        {
          id: 2101,
          type: 'ban',
          value: '3.3.3.3',
          duration: '30m',
          stop_at: initialStopAt,
          origin: 'manual',
          scenario: 'crowdsecurity/http-probing',
          simulated: false,
        },
      ],
      simulated: false,
    });
    const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
    seedAlert(database, initialAlert);
    const { controller } = createController({
      database,
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
      },
      initialCacheState: {
        isInitialized: true,
        isComplete: true,
        lastUpdate: new Date().toISOString(),
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (url.includes('/v1/alerts?')) {
          return Response.json(new URL(url).searchParams.has('until') ? [refreshedAlert] : []);
        }
        return undefined;
      },
    });

    const refreshedAlertsResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/alerts?page=1&page_size=50&include_decisions=false',
    ));
    expect(refreshedAlertsResponse.status).toBe(200);
    const refreshedAlertsJson = await refreshedAlertsResponse.json() as {
      data: Array<{ id: number; decisions: unknown[]; decision_summary: { active_count: number; expired_count: number } }>;
    };
    const refreshedAlertRow = refreshedAlertsJson.data.find((alert) => alert.id === 210);
    expect(refreshedAlertRow).toMatchObject({
      decisions: [],
      decision_summary: { active_count: 1, expired_count: 0 },
    });

    const refreshedDecisionsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions?page=1&page_size=50&alert_id=210&include_expired=true'));
    expect(refreshedDecisionsResponse.status).toBe(200);
    const refreshedDecisionsJson = await refreshedDecisionsResponse.json() as {
      data: Array<{ id: number }>;
      pagination: { total: number };
    };
    expect(refreshedDecisionsJson.pagination.total).toBe(1);
    expect(refreshedDecisionsJson.data.map((decision) => decision.id)).toEqual([2101]);
    expect(database.getDecisionById('2102')).toBeNull();

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('prunes cached alerts missing from a successful historical sync window', async () => {
    const createdAt = new Date(Date.now() - 30_000).toISOString();
    const syncedAlert = sampleAlert({
      id: 220,
      uuid: 'alert-220',
      created_at: createdAt,
      decisions: [
        {
          id: 2201,
          type: 'ban',
          value: '4.4.4.4',
          duration: '30m',
          stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
          origin: 'manual',
          scenario: 'crowdsecurity/ssh-bf',
          simulated: false,
        },
      ],
    });
    const staleAlert = sampleAlert({
      id: 221,
      uuid: 'alert-221',
      created_at: createdAt,
      decisions: [
        {
          id: 2211,
          type: 'ban',
          value: '5.5.5.5',
          duration: '30m',
          stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
          origin: 'manual',
          scenario: 'crowdsecurity/ssh-bf',
          simulated: false,
        },
      ],
    });

    const { controller, database } = createController({
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (url.includes('/v1/alerts?')) {
          return Response.json([syncedAlert]);
        }
        return undefined;
      },
    });

    seedAlert(database, syncedAlert);
    seedAlert(database, staleAlert);

    const alertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=50'));
    expect(alertsResponse.status).toBe(200);
    const alertsJson = await alertsResponse.json() as {
      data: Array<{ id: number }>;
      pagination: { total: number };
    };

    expect(alertsJson.pagination.total).toBe(1);
    expect(alertsJson.data.map((alert) => alert.id)).toEqual([220]);
    expect(database.getAlertsSince(new Date(Date.now() - 60_000).toISOString())).toHaveLength(1);
    expect(database.getDecisionById('2201')).not.toBeNull();
    expect(database.getDecisionById('2211')).toBeNull();

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('does not prune cached alerts when historical sync has a partial scope failure', async () => {
    const createdAt = new Date(Date.now() - 30_000).toISOString();
    const syncedAlert = sampleAlert({
      id: 240,
      uuid: 'alert-240',
      created_at: createdAt,
      decisions: [
        {
          id: 2401,
          type: 'ban',
          value: '7.7.7.7',
          duration: '30m',
          stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
          origin: 'manual',
          scenario: 'crowdsecurity/ssh-bf',
          simulated: false,
        },
      ],
    });
    const cachedOnlyAlert = sampleAlert({
      id: 241,
      uuid: 'alert-241',
      created_at: createdAt,
      decisions: [
        {
          id: 2411,
          type: 'ban',
          value: '8.8.8.8',
          duration: '30m',
          stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
          origin: 'manual',
          scenario: 'crowdsecurity/ssh-bf',
          simulated: false,
        },
      ],
    });

    const { controller, database } = createController({
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (url.includes('/v1/alerts?') && url.includes('scope=ip')) {
          throw new Error('ip scope failed');
        }
        if (url.includes('/v1/alerts?')) {
          return Response.json([syncedAlert]);
        }
        return undefined;
      },
    });

    seedAlert(database, syncedAlert);
    seedAlert(database, cachedOnlyAlert);

    const alertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=50'));
    expect(alertsResponse.status).toBe(200);
    const alertsJson = await alertsResponse.json() as {
      data: Array<{ id: number }>;
      pagination: { total: number };
    };

    expect(alertsJson.pagination.total).toBe(2);
    expect(alertsJson.data.map((alert) => alert.id).sort()).toEqual([240, 241]);
    expect(database.getDecisionById('2411')).not.toBeNull();

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('uses replay alert start time for cache history, visibility, and dashboard buckets', async () => {
    const replayStartMs = Date.now() - 2 * 24 * 60 * 60 * 1_000;
    const replayStartAt = new Date(replayStartMs).toISOString();
    const replayCreatedAt = new Date().toISOString();
    const replayStopAt = new Date(replayStartMs + 30 * 60 * 1_000).toISOString();
    const replayAlert = sampleAlert({
      id: 242,
      uuid: 'alert-242',
      created_at: replayCreatedAt,
      start_at: replayStartAt,
      stop_at: replayStopAt,
      decisions: [
        {
          id: 2421,
          type: 'ban',
          value: '10.10.10.10',
          duration: '30m',
          stop_at: replayStopAt,
          origin: 'crowdsec',
          scenario: 'crowdsecurity/ssh-bf',
          simulated: false,
        },
      ],
    });

    const { controller, database } = createController({
      env: {
        CROWDSEC_LOOKBACK_PERIOD: '72h',
        CROWDSEC_ALERT_SYNC_CHUNK: '24h',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (url.includes('/v1/alerts?')) {
          const params = new URL(url).searchParams;
          const sinceMs = parseGoDuration(params.get('since'));
          const untilMs = parseGoDuration(params.get('until') || '0s');
          const requestNow = Date.now();
          const windowStart = requestNow - sinceMs;
          const windowEnd = requestNow - untilMs;
          return Response.json(replayStartMs >= windowStart && replayStartMs < windowEnd ? [replayAlert] : []);
        }
        return undefined;
      },
    });

    const alertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=50'));
    expect(alertsResponse.status).toBe(200);
    const alertsJson = await alertsResponse.json() as {
      data: Array<{ id: number; created_at: string }>;
      pagination: { total: number };
    };
    expect(alertsJson.pagination.total).toBe(1);
    expect(alertsJson.data).toEqual([
      expect.objectContaining({ id: 242, created_at: replayStartAt }),
    ]);

    const storedAlerts = database.db.query('SELECT id, created_at FROM alerts ORDER BY id').all() as Array<{ id: number; created_at: string }>;
    expect(storedAlerts).toEqual([{ id: 242, created_at: replayStartAt }]);

    const dashboardResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/dashboard/stats?granularity=day'));
    expect(dashboardResponse.status).toBe(200);
    const dashboardJson = await dashboardResponse.json() as {
      series: { alertsHistory: Array<{ date: string; count: number }> };
    };
    expect(dashboardJson.series.alertsHistory).toEqual(
      expect.arrayContaining([expect.objectContaining({ date: replayStartAt.slice(0, 10), count: 1 })]),
    );

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('prunes stale cached alerts from the refreshed delta window without full lookback reconciliation', async () => {
    const createdAt = new Date().toISOString();
    const keptAlert = sampleAlert({
      id: 250,
      uuid: 'alert-250',
      created_at: createdAt,
      decisions: [],
    });
    const deletedAlert = sampleAlert({
      id: 251,
      uuid: 'alert-251',
      created_at: createdAt,
      decisions: [],
    });
    let phase: 'initial' | 'refresh' = 'initial';

    const { controller, database } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (url.includes('/v1/alerts?')) {
          return Response.json(phase === 'initial' ? [keptAlert, deletedAlert] : [keptAlert]);
        }
        return undefined;
      },
    });

    const initialResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=50'));
    expect(initialResponse.status).toBe(200);
    expect(((await initialResponse.json()) as { pagination: { total: number } }).pagination.total).toBe(2);

    phase = 'refresh';

    const refreshedResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=50'));
    expect(refreshedResponse.status).toBe(200);
    const refreshedJson = await refreshedResponse.json() as {
      data: Array<{ id: number }>;
      pagination: { total: number };
    };

    expect(refreshedJson.pagination.total).toBe(1);
    expect(refreshedJson.data.map((alert) => alert.id)).toEqual([250]);
    expect(database.getAlertsSince(new Date(Date.now() - 60_000).toISOString())).toHaveLength(1);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('imports a real LAPI alert created after one delta cutoff on the next overlapped refresh', async () => {
    vi.useFakeTimers();
    const firstCutoff = Date.parse('2026-07-15T13:10:02.116Z');
    vi.setSystemTime(firstCutoff);
    const lateAlert = sampleAlert({
      id: 252,
      uuid: 'alert-252',
      created_at: new Date(firstCutoff + 1_000).toISOString(),
      decisions: [{
        id: 2520,
        type: 'ban',
        value: '192.0.2.252',
        stop_at: new Date(firstCutoff + 60 * 60_000).toISOString(),
        origin: 'crowdsec',
        simulated: false,
      }],
    });
    let advancedPastFirstCutoff = false;
    const { controller, database } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
      },
      initialCacheState: {
        isInitialized: true,
        isComplete: true,
        lastUpdate: new Date(firstCutoff - 30_000).toISOString(),
      },
      fetchResolver: (url) => {
        if (!url.includes('/v1/alerts?')) return undefined;
        if (!advancedPastFirstCutoff) {
          // Emulate CrowdSec creating an alert while the first delta request is
          // in flight. The padded response may contain it, but the application
          // must not advance its authoritative cursor past the earlier cutoff.
          advancedPastFirstCutoff = true;
          vi.setSystemTime(firstCutoff + 2_000);
        }
        return Response.json([lateAlert]);
      },
    });

    try {
      const firstResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=50'));
      expect(firstResponse.status).toBe(200);
      expect(((await firstResponse.json()) as { pagination: { total: number } }).pagination.total).toBe(0);
      expect(database.getAlertDecisionSnapshot(252)).toBeNull();

      const secondResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=50'));
      expect(secondResponse.status).toBe(200);
      const secondJson = await secondResponse.json() as {
        data: Array<{ id: number }>;
        pagination: { total: number };
      };
      expect(secondJson.pagination.total).toBe(1);
      expect(secondJson.data.map((alert) => alert.id)).toEqual([252]);
      expect(database.getDecisionById('2520')).not.toBeNull();
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      vi.useRealTimers();
      destroyTempDir();
    }
  });

  test('prunes stale cached alerts only from a complete unfiltered reconciliation window', async () => {
    const createdAt = new Date(Date.now() - 30_000).toISOString();
    const keptAlert = sampleAlert({
      id: 260,
      uuid: 'alert-260',
      created_at: createdAt,
      decisions: [
        {
          id: 2601,
          type: 'ban',
          value: '11.11.11.11',
          duration: '30m',
          stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
          origin: 'manual',
          scenario: 'crowdsecurity/ssh-bf',
          simulated: false,
        },
      ],
    });
    const deletedActiveAlert = sampleAlert({
      id: 261,
      uuid: 'alert-261',
      created_at: createdAt,
      decisions: [
        {
          id: 2611,
          type: 'ban',
          value: '12.12.12.12',
          duration: '30m',
          stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
          origin: 'manual',
          scenario: 'crowdsecurity/ssh-bf',
          simulated: false,
        },
      ],
    });
    const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
    seedAlert(database, keptAlert);
    seedAlert(database, deletedActiveAlert);
    const { controller } = createController({
      database,
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
      },
      initialCacheState: {
        isInitialized: true,
        isComplete: true,
        lastUpdate: new Date().toISOString(),
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (url.includes('/v1/alerts?')) {
          return Response.json(new URL(url).searchParams.has('until') ? [keptAlert] : []);
        }
        return undefined;
      },
    });

    const refreshedResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=50'));
    expect(refreshedResponse.status).toBe(200);
    const refreshedJson = await refreshedResponse.json() as {
      data: Array<{ id: number }>;
      pagination: { total: number };
    };

    expect(refreshedJson.pagination.total).toBe(1);
    expect(refreshedJson.data.map((alert) => alert.id)).toEqual([260]);
    expect(database.getDecisionById('2601')).not.toBeNull();
    expect(database.getDecisionById('2611')).toBeNull();

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('deleting already removed LAPI resources still cleans up the local cache', async () => {
    const staleAlert = sampleAlert({
      id: 230,
      uuid: 'alert-230',
      decisions: [
        {
          id: 2301,
          type: 'ban',
          value: '6.6.6.6',
          duration: '30m',
          stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
          origin: 'manual',
          scenario: 'crowdsecurity/ssh-bf',
          simulated: false,
        },
      ],
    });

    const { controller, database, lapiClient } = createController({
      fetchResolver: (url, init) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (url.endsWith('/v1/decisions/2301') && init?.method === 'DELETE') {
          return new Response('', { status: 404, statusText: 'Not Found' });
        }
        if (url.endsWith('/v1/alerts/230') && init?.method === 'DELETE') {
          return new Response('', { status: 404, statusText: 'Not Found' });
        }
        return undefined;
      },
    });

    seedAlert(database, staleAlert);
    await lapiClient.login();

    const deleteResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/230', { method: 'DELETE' }));
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toEqual(expect.objectContaining({
      requested_alerts: 1,
      requested_decisions: 1,
      deleted_alerts: 1,
      deleted_decisions: 1,
      failed: [],
    }));
    await vi.waitFor(() => {
      expect(database.getAlertDeletionTombstone('230')?.completed_at).not.toBeNull();
    });
    expect(database.getAlertsSince(new Date(Date.now() - 60_000).toISOString())).toHaveLength(0);
    expect(database.getDecisionById('2301')).toBeNull();

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });
 });
