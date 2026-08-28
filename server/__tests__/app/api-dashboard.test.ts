import { describe, expect, test, vi } from 'vitest';
import path from 'path';
import type { AlertRecord, DashboardStatsResponse, PaginatedResponse, SlimAlert } from '../../../shared/contracts';
import { parseDashboardBucketKey } from '../../app/dashboard-stats';
import { CrowdsecDatabase } from '../../database';
import { DatabaseQueryWorker, QueryWorkerTimeoutError } from '../../query-worker-client';
import {
  createController,
  dashboardDateKey,
  destroyTempDir,
  sampleAlert,
  sampleSimulatedAlert,
  seedAlert,
  tempDir,
} from './harness';

describe('createApp dashboard API', () => {
  test('filters cached dashboard alerts by first-class kind', async () => {
    const { controller, database } = createController({
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
    });
    seedAlert(database, sampleAlert({ id: 1, uuid: 'dashboard-kind-waf', kind: 'waf' }));
    seedAlert(database, sampleAlert({
      id: 2,
      uuid: 'dashboard-kind-crowdsec',
      kind: 'crowdsec',
      source: { ip: '5.6.7.8', value: '5.6.7.8' },
      decisions: (sampleAlert().decisions || []).map((decision) => ({
        ...decision,
        id: 20,
        value: '5.6.7.8',
      })),
    }));

    try {
      const params = new URLSearchParams({ q: 'kind=waf', decision_q: 'kind=waf' });
      const response = await controller.fetch(new Request(
        `http://localhost/crowdsec/api/dashboard/stats?${params}`,
      ));
      expect(response.status).toBe(200);
      expect((await response.json() as DashboardStatsResponse).filteredTotals).toEqual(expect.objectContaining({
        alerts: 1,
        decisions: 1,
      }));
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('serializes changing dashboard ranges and only warms the newest pending response', async () => {
    const createdAt = new Date().toISOString();
    const dateKey = dashboardDateKey(createdAt, 0);
    const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
    seedAlert(database, sampleAlert({
      id: 99,
      uuid: 'dashboard-serialized-range-alert',
      created_at: createdAt,
    }));
    const queryWorker = new DatabaseQueryWorker({ dbPath: database.dbPath });
    const analyticsQueryWorker = new DatabaseQueryWorker({ dbPath: database.dbPath });
    const realAll = analyticsQueryWorker.all.bind(analyticsQueryWorker);
    let releaseFirstTotals!: () => void;
    const firstTotalsGate = new Promise<void>((resolve) => {
      releaseFirstTotals = resolve;
    });
    let firstTotalsStarted!: () => void;
    const firstTotalsStart = new Promise<void>((resolve) => {
      firstTotalsStarted = resolve;
    });
    let totalsCalls = 0;
    let activeTotalsCalls = 0;
    let maximumActiveTotalsCalls = 0;
    vi.spyOn(analyticsQueryWorker, 'all').mockImplementation(async (sql, params, options) => {
      if (options?.label === 'dashboard alert totals') {
        totalsCalls += 1;
        activeTotalsCalls += 1;
        maximumActiveTotalsCalls = Math.max(maximumActiveTotalsCalls, activeTotalsCalls);
        try {
          if (totalsCalls === 1) {
            firstTotalsStarted();
            await Promise.race([
              firstTotalsGate,
              new Promise<void>((_resolve, reject) => {
                options.signal?.addEventListener('abort', () => {
                  const error = new Error('Database query aborted');
                  error.name = 'AbortError';
                  reject(error);
                }, { once: true });
              }),
            ]);
          }
          return await realAll(sql, params, options);
        } finally {
          activeTotalsCalls -= 1;
        }
      }
      return realAll(sql, params, options);
    });
    const { controller } = createController({
      database,
      queryWorker,
      analyticsQueryWorker,
      initialCacheState: {
        isInitialized: true,
        isComplete: true,
        lastUpdate: createdAt,
      },
    });

    try {
      const firstRequest = controller.fetch(new Request(
        `http://localhost/crowdsec/api/dashboard/stats?dateStart=${dateKey}&dateEnd=${dateKey}`,
      ));
      await firstTotalsStart;

      const pendingResponse = await controller.fetch(new Request(
        `http://localhost/crowdsec/api/dashboard/stats?granularity=hour&dateStart=${dateKey}&dateEnd=${dateKey}`,
      ));
      expect(await pendingResponse.json()).toEqual(expect.objectContaining({ pending: true }));

      releaseFirstTotals();
      expect((await firstRequest).status).toBe(200);
      await vi.waitFor(() => expect(totalsCalls).toBe(2));
      await vi.waitFor(() => expect(activeTotalsCalls).toBe(0));
      expect(maximumActiveTotalsCalls).toBe(1);
    } finally {
      releaseFirstTotals();
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('handles an analytics timeout immediately while dashboard enrichment is still pending', async () => {
    const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
    seedAlert(database, sampleAlert());
    const queryWorker = new DatabaseQueryWorker({ dbPath: database.dbPath });
    const realAll = queryWorker.all.bind(queryWorker);
    vi.spyOn(queryWorker, 'all').mockImplementation((sql, params, options) => {
      if (sql.includes('SELECT simulated, COUNT(*) AS count')) {
        return Promise.reject(new QueryWorkerTimeoutError(30_000, {
          label: 'dashboard totals regression query',
        }));
      }
      return realAll(sql, params, options);
    });
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    const { controller } = createController({
      database,
      queryWorker,
      initialCacheState: {
        isInitialized: true,
        isComplete: true,
        lastUpdate: new Date().toISOString(),
      },
      attackLocationResolver: {
        resolve: (locations) => new Promise((resolve) => {
          setTimeout(() => resolve(locations), 25);
        }),
      },
    });

    try {
      const response = await controller.fetch(new Request('http://localhost/crowdsec/api/dashboard/stats'));
      expect(response.status).toBe(504);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      controller.stopBackgroundTasks();
      database.close();
    }
  });

  test('aggregates dashboard stats with mutual filters, simulation mode, and timezone date ranges', async () => {
    const createdAt = new Date().toISOString();
    const stopAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    const timezoneOffset = -120;
    const dateKey = dashboardDateKey(createdAt, timezoneOffset);
    const dashboardAlerts = [
      sampleAlert({
        id: 101,
        uuid: 'dashboard-alert-101',
        created_at: createdAt,
        scenario: 'crowdsecurity/ssh-bf',
        source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner', latitude: 52.52, longitude: 13.405 },
        target: 'ssh',
        decisions: [
          { id: 1010, value: '1.2.3.4', stop_at: stopAt, type: 'ban', origin: 'manual', simulated: false },
          {
            id: 1099,
            value: '1.2.3.4',
            stop_at: new Date(Date.now() - 60_000).toISOString(),
            type: 'ban',
            origin: 'manual',
            simulated: false,
          },
        ],
        simulated: false,
      }),
      sampleAlert({
        id: 102,
        uuid: 'dashboard-alert-102',
        created_at: createdAt,
        scenario: 'crowdsecurity/http-probing',
        source: { ip: '9.9.9.9', value: '9.9.9.9', cn: 'DE', as_name: 'OVH', latitude: 52.51, longitude: 13.41 },
        target: 'http',
        decisions: [{ id: 1020, value: '9.9.9.9', stop_at: stopAt, type: 'ban', origin: 'manual', simulated: false }],
        simulated: false,
      }),
      sampleAlert({
        id: 103,
        uuid: 'dashboard-alert-103',
        created_at: createdAt,
        scenario: 'crowdsecurity/nginx-bf',
        source: { ip: '5.6.7.8', value: '5.6.7.8', cn: 'US', as_name: 'AWS', latitude: 37.7749, longitude: -122.4194 },
        target: 'nginx',
        decisions: [{ id: 1030, value: '5.6.7.8', stop_at: stopAt, type: 'ban', origin: 'crowdsec', simulated: true }],
        simulated: true,
      }),
    ];
    const { controller, database, lapiClient } = createController({
      fetchResolver: (url) => {
        if (url.includes('/v1/alerts?')) {
          return Response.json(dashboardAlerts);
        }
        return undefined;
      },
    });

    for (const alert of dashboardAlerts) {
      seedAlert(database, alert);
    }
    await lapiClient.login();

    const countryResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/dashboard/stats?country=DE'));
    expect(countryResponse.status).toBe(200);
    expect((await countryResponse.json()) as {
      filteredTotals: { alerts: number; decisions: number; simulatedAlerts: number; simulatedDecisions: number };
      topCountries: Array<{ countryCode?: string; count: number }>;
      allCountries: Array<{ countryCode: string; liveDecisionCount?: number; activeLiveDecisionCount?: number }>;
      attackLocations: Array<{ latitude: number; longitude: number; count: number }>;
      series: { decisionsHistory: Array<{ count: number }>; activeDecisionsHistory: Array<{ count: number }> };
    }).toEqual(expect.objectContaining({
      filteredTotals: { alerts: 2, decisions: 2, simulatedAlerts: 0, simulatedDecisions: 0 },
      topCountries: [expect.objectContaining({ countryCode: 'DE', count: 2 })],
      allCountries: [expect.objectContaining({ countryCode: 'DE', liveDecisionCount: 3, activeLiveDecisionCount: 2 })],
      attackLocations: [expect.objectContaining({ latitude: 52.515, longitude: 13.4075, count: 2 })],
      series: expect.objectContaining({
        decisionsHistory: expect.arrayContaining([expect.objectContaining({ count: 3 })]),
        activeDecisionsHistory: expect.arrayContaining([expect.objectContaining({ count: 2 })]),
      }),
    }));

    const combinedResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/dashboard/stats?country=DE&scenario=crowdsecurity/ssh-bf&target=ssh'));
    expect((await combinedResponse.json()) as {
      filteredTotals: { alerts: number; decisions: number };
      topScenarios: Array<{ label: string; count: number }>;
    }).toEqual(expect.objectContaining({
      filteredTotals: expect.objectContaining({ alerts: 1, decisions: 1 }),
      topScenarios: [expect.objectContaining({ label: 'crowdsecurity/ssh-bf', count: 1 })],
    }));

    const sharedFilterParams = new URLSearchParams({
      q: 'country:(DE OR US) AND -scenario:http-probing',
    });
    const sharedFilterResponse = await controller.fetch(new Request(
      `http://localhost/crowdsec/api/dashboard/stats?${sharedFilterParams.toString()}`,
    ));
    expect((await sharedFilterResponse.json()) as {
      filteredTotals: { alerts: number; decisions: number; simulatedAlerts: number; simulatedDecisions: number };
      topScenarios: Array<{ label: string; count: number }>;
    }).toEqual(expect.objectContaining({
      filteredTotals: { alerts: 2, decisions: 1, simulatedAlerts: 1, simulatedDecisions: 1 },
      topScenarios: expect.arrayContaining([
        expect.objectContaining({ label: 'crowdsecurity/ssh-bf', count: 1 }),
        expect.objectContaining({ label: 'crowdsecurity/nginx-bf', count: 1 }),
      ]),
    }));

    const simulatedResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/dashboard/stats?simulation=simulated'));
    expect((await simulatedResponse.json()) as {
      filteredTotals: { alerts: number; decisions: number; simulatedAlerts: number; simulatedDecisions: number };
    }).toEqual(expect.objectContaining({
      filteredTotals: { alerts: 1, decisions: 0, simulatedAlerts: 1, simulatedDecisions: 1 },
    }));

    const timelineResponse = await controller.fetch(new Request(
      `http://localhost/crowdsec/api/dashboard/stats?tz_offset=${timezoneOffset}`,
    ));
    const timelinePayload = await timelineResponse.json() as DashboardStatsResponse;
    const dateResponse = await controller.fetch(new Request(`http://localhost/crowdsec/api/dashboard/stats?dateStart=${dateKey}&dateEnd=${dateKey}&tz_offset=${timezoneOffset}`));
    const datePayload = await dateResponse.json() as DashboardStatsResponse;
    expect(datePayload).toEqual(expect.objectContaining({
      filteredTotals: { alerts: 3, decisions: 2, simulatedAlerts: 1, simulatedDecisions: 1 },
    }));
    expect(datePayload.series.unfilteredAlertsHistory.map((bucket) => bucket.date)).toEqual(
      timelinePayload.series.unfilteredAlertsHistory.map((bucket) => bucket.date),
    );
    expect(datePayload.series.unfilteredDecisionsHistory.map((bucket) => bucket.date)).toEqual(
      timelinePayload.series.unfilteredDecisionsHistory.map((bucket) => bucket.date),
    );

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('keeps an exact target selection consistent between dashboard stats and alert drilldown', async () => {
    const alerts = [
      sampleAlert({
        id: 701,
        uuid: 'dashboard-target-root',
        source: { ip: '192.0.2.1', value: '192.0.2.1', cn: 'DE' },
        target: 'tausend.me',
        events: [{ meta: [{ key: 'target_host', value: 'tausend.me' }] }],
      }),
      sampleAlert({
        id: 702,
        uuid: 'dashboard-target-subdomain',
        source: { ip: '192.0.2.2', value: '192.0.2.2', cn: 'DE' },
        target: 'bw.tausend.me',
        events: [{ meta: [{ key: 'target_host', value: 'bw.tausend.me' }] }],
      }),
    ];
    const { controller, database } = createController({
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
    });
    alerts.forEach((alert) => seedAlert(database, alert));

    try {
      const exactParams = new URLSearchParams({ q: 'target=tausend.me' });
      const dashboardResponse = await controller.fetch(new Request(
        `http://localhost/crowdsec/api/dashboard/stats?${exactParams.toString()}`,
      ));
      expect((await dashboardResponse.json()) as DashboardStatsResponse).toEqual(expect.objectContaining({
        filteredTotals: expect.objectContaining({ alerts: 1 }),
        topTargets: [expect.objectContaining({ label: 'tausend.me', count: 1 })],
      }));

      exactParams.set('page', '1');
      exactParams.set('page_size', '10');
      const exactAlertsResponse = await controller.fetch(new Request(
        `http://localhost/crowdsec/api/alerts?${exactParams.toString()}`,
      ));
      const exactAlerts = (await exactAlertsResponse.json()) as PaginatedResponse<SlimAlert>;
      expect(exactAlerts.pagination.total).toBe(1);
      expect(exactAlerts.data.map((alert) => alert.target)).toEqual(['tausend.me']);

      const broadParams = new URLSearchParams({ q: 'target:tausend.me', page: '1', page_size: '10' });
      const broadAlertsResponse = await controller.fetch(new Request(
        `http://localhost/crowdsec/api/alerts?${broadParams.toString()}`,
      ));
      expect(((await broadAlertsResponse.json()) as PaginatedResponse<SlimAlert>).pagination.total).toBe(2);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('matches filtered list totals and promotes a matching duplicate decision', async () => {
    const createdAt = new Date().toISOString();
    const source = { ip: '192.0.2.80', value: '192.0.2.80', cn: 'DE', as_name: 'Example AS' };
    const matchingAlert = sampleAlert({
      id: 801,
      uuid: 'dashboard-filter-matching-alert',
      created_at: createdAt,
      scenario: 'crowdsecurity/http-probing',
      source,
      target: 'bw.tausend.me',
      events: [{ meta: [{ key: 'target_host', value: 'bw.tausend.me' }] }],
      decisions: [{
        id: 8010,
        value: source.ip,
        type: 'ban',
        scenario: 'crowdsecurity/http-probing',
        stop_at: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
        simulated: false,
      }],
    });
    const globallyPreferredAlert = sampleAlert({
      id: 802,
      uuid: 'dashboard-filter-global-duplicate',
      created_at: createdAt,
      scenario: 'crowdsecurity/ssh-bf',
      source,
      target: 'ssh',
      decisions: [{
        id: 8020,
        value: source.ip,
        type: 'ban',
        scenario: 'crowdsecurity/ssh-bf',
        stop_at: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
        simulated: false,
      }],
    });
    const { controller, database } = createController({
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
    });
    seedAlert(database, matchingAlert);
    seedAlert(database, globallyPreferredAlert);
    database.refreshDecisionDuplicateFlags(new Date().toISOString(), true);

    try {
      expect(database.db.prepare('SELECT is_duplicate FROM decisions WHERE upstream_id = ?').get('8010')).toEqual({
        is_duplicate: 1,
      });

      const query = 'scenario=crowdsecurity/http-probing AND country=DE AND target=bw.tausend.me';
      const dashboardParams = new URLSearchParams({ q: query, decision_q: query });
      const listParams = new URLSearchParams({ q: query, page: '1', page_size: '10' });
      const [dashboardResponse, alertsResponse, decisionsResponse] = await Promise.all([
        controller.fetch(new Request(`http://localhost/crowdsec/api/dashboard/stats?${dashboardParams}`)),
        controller.fetch(new Request(`http://localhost/crowdsec/api/alerts?${listParams}`)),
        controller.fetch(new Request(`http://localhost/crowdsec/api/decisions?${listParams}`)),
      ]);
      const dashboard = (await dashboardResponse.json()) as DashboardStatsResponse;
      const alerts = (await alertsResponse.json()) as PaginatedResponse<SlimAlert>;
      const decisions = (await decisionsResponse.json()) as PaginatedResponse<{
        id: string | number;
        is_duplicate: boolean;
      }>;

      expect(alerts.pagination.total).toBe(1);
      expect(decisions.pagination.total).toBe(1);
      expect(decisions.data).toEqual([
        expect.objectContaining({ id: 8010, is_duplicate: false }),
      ]);
      expect(dashboard.filteredTotals.alerts).toBe(alerts.pagination.total);
      expect(
        dashboard.filteredTotals.decisions + dashboard.filteredTotals.simulatedDecisions,
      ).toBe(decisions.pagination.total);
      expect(dashboard.series.activeDecisionsHistory.some((bucket) => bucket.count === 1)).toBe(true);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('refreshes cached dashboard active totals when a decision expires without a database mutation', async () => {
    vi.useRealTimers();
    const stopAt = new Date(Date.now() + 1_000).toISOString();
    const alert = sampleAlert({
      id: 104,
      uuid: 'dashboard-expiring-alert',
      created_at: new Date().toISOString(),
      decisions: [{ id: 1040, value: '1.2.3.4', stop_at: stopAt, type: 'ban', origin: 'crowdsec', simulated: false }],
    });
    const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
    const queryWorker = new DatabaseQueryWorker({ dbPath: database.dbPath });
    const queryAllSpy = vi.spyOn(queryWorker, 'all');
    seedAlert(database, alert);
    const { controller } = createController({
      database,
      queryWorker,
      env: { CROWDSEC_REFRESH_INTERVAL: '0', CROWDSEC_LOOKBACK_PERIOD: '1h' },
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
      fetchResolver: (url) => {
        if (!url.includes('/v1/alerts?')) return undefined;
        return Response.json([alert]);
      },
    });

    try {
      const firstResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/dashboard/stats'));
      expect((await firstResponse.json()) as { filteredTotals: { decisions: number } }).toEqual(
        expect.objectContaining({ filteredTotals: expect.objectContaining({ decisions: 1 }) }),
      );
      const initialDecisionIndexQueries = queryAllSpy.mock.calls.filter(([sql]) => (
        sql.includes('SELECT rowid')
        && sql.includes('FROM decisions')
        && sql.includes('ORDER BY rowid ASC')
      )).length;
      expect(initialDecisionIndexQueries).toBeGreaterThan(0);
      expect(queryAllSpy.mock.calls.some(([sql]) => (
        sql.includes('SELECT rowid')
        && sql.includes('FROM decisions NOT INDEXED')
        && sql.includes('ORDER BY rowid ASC')
      ))).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      let secondResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/dashboard/stats'));
      let secondDashboard = (await secondResponse.json()) as DashboardStatsResponse;
      if (secondDashboard.pending) {
        await vi.waitFor(async () => {
          secondResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/dashboard/stats'));
          secondDashboard = (await secondResponse.json()) as DashboardStatsResponse;
          expect(secondDashboard.pending).not.toBe(true);
        });
      }
      expect(secondDashboard as {
        totals: { decisions: number };
        filteredTotals: { decisions: number };
      }).toEqual(
        expect.objectContaining({
          totals: expect.objectContaining({ decisions: 0 }),
          filteredTotals: expect.objectContaining({ decisions: 0 }),
        }),
      );
      const refreshedDecisionIndexQueries = queryAllSpy.mock.calls.filter(([sql]) => (
        sql.includes('SELECT rowid')
        && sql.includes('FROM decisions')
        && sql.includes('ORDER BY rowid ASC')
      )).length;
      expect(refreshedDecisionIndexQueries).toBe(initialDecisionIndexQueries);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('serves finalized dashboard stats immediately after initial sync', async () => {
    const alert = sampleAlert({
      id: 301,
      uuid: 'dashboard-alert-301',
      created_at: new Date().toISOString(),
      source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
      target: 'ssh',
    });
    const { controller, database, lapiClient } = createController({
      fetchResolver: (url) => url.includes('/v1/alerts?') ? Response.json([alert]) : undefined,
    });

    seedAlert(database, alert);
    await lapiClient.login();

    const alertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=10'));
    expect(alertsResponse.status).toBe(200);

    const dashboardResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/dashboard/stats?granularity=day'));
    expect(dashboardResponse.status).toBe(200);
    expect((await dashboardResponse.json()) as {
      totals: { alerts: number; decisions: number };
      topCountries: Array<{ countryCode?: string; count: number }>;
    }).toEqual(expect.objectContaining({
      totals: expect.objectContaining({ alerts: 1, decisions: 1 }),
      topCountries: [expect.objectContaining({ countryCode: 'DE', count: 1 })],
    }));

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('keeps initial history sync active until the requested dashboard is warmed', async () => {
    const alert = sampleAlert({
      id: 303,
      uuid: 'dashboard-alert-303',
      created_at: new Date().toISOString(),
    });
    const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
    const analyticsQueryWorker = new DatabaseQueryWorker({ dbPath: database.dbPath });
    const realAll = analyticsQueryWorker.all.bind(analyticsQueryWorker);
    let releaseHistory!: () => void;
    const historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    let releaseWarmup!: () => void;
    const warmupGate = new Promise<void>((resolve) => {
      releaseWarmup = resolve;
    });
    let warmupStarted!: () => void;
    const warmupStart = new Promise<void>((resolve) => {
      warmupStarted = resolve;
    });
    let historyReleased = false;
    let dateNowSpy: { mockRestore: () => void } | null = null;
    vi.spyOn(analyticsQueryWorker, 'all').mockImplementation(async (sql, params, options) => {
      if (historyReleased && options?.label === 'dashboard alert totals') {
        warmupStarted();
        await warmupGate;
      }
      return realAll(sql, params, options);
    });
    const { controller } = createController({
      database,
      analyticsQueryWorker,
      env: { CROWDSEC_REFRESH_INTERVAL: '5s' },
      fetchResolver: (url) => {
        if (!url.includes('/v1/alerts?')) return undefined;
        return historyGate.then(() => Response.json([alert]));
      },
    });

    try {
      controller.startBackgroundTasks();
      await vi.waitFor(() => expect(controller.getSyncStatus().isSyncing).toBe(true));

      const initialDashboardResponse = await controller.fetch(new Request(
        'http://localhost/crowdsec/api/dashboard/stats?granularity=hour',
      ));
      expect(initialDashboardResponse.status).toBe(200);

      const requestTime = Date.now();
      dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(requestTime + 11_000);
      historyReleased = true;
      releaseHistory();
      await warmupStart;
      expect(controller.getSyncStatus()).toEqual(expect.objectContaining({
        isSyncing: true,
        progress: 99,
        message: 'Preparing dashboard data for faster loading...',
        completedAt: null,
      }));

      releaseWarmup();
      await vi.waitFor(() => expect(controller.getSyncStatus()).toEqual(expect.objectContaining({
        isSyncing: false,
        progress: 100,
        completedAt: expect.any(String),
      })));

      const readyResponse = await controller.fetch(new Request(
        'http://localhost/crowdsec/api/dashboard/stats?granularity=hour',
      ));
      const readyDashboard = await readyResponse.json() as DashboardStatsResponse;
      expect(readyDashboard.pending).toBeUndefined();
      expect(readyDashboard.totals.alerts).toBe(1);
    } finally {
      dateNowSpy?.mockRestore();
      releaseHistory();
      releaseWarmup();
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('serves a fresh dashboard snapshot on the first request after invalidation', async () => {
    const alert = sampleAlert({
      id: 302,
      uuid: 'dashboard-alert-302',
      created_at: new Date().toISOString(),
    });
    const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
    const analyticsQueryWorker = new DatabaseQueryWorker({ dbPath: database.dbPath });
    const analyticsAllSpy = vi.spyOn(analyticsQueryWorker, 'all');
    const { controller } = createController({
      database,
      analyticsQueryWorker,
      initialCacheState: {
        isInitialized: true,
        isComplete: true,
        lastUpdate: new Date().toISOString(),
      },
      alertDetailPayload: alert,
    });
    seedAlert(database, alert);

    const initialResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/dashboard/stats'));
    expect((await initialResponse.json() as DashboardStatsResponse).totals.alerts).toBe(1);
    analyticsAllSpy.mockClear();

    const deleteResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/302', {
      method: 'DELETE',
    }));
    expect(deleteResponse.status).toBe(200);

    vi.spyOn(database, 'countAlerts').mockReturnValue(100_001);
    const readyResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/dashboard/stats'));
    const readyPayload = await readyResponse.json() as DashboardStatsResponse;
    expect(readyPayload.pending).toBeUndefined();
    expect(readyPayload).toEqual(expect.objectContaining({
      totals: expect.objectContaining({ alerts: 0 }),
    }));
    expect(analyticsAllSpy.mock.calls.some(([, , options]) => options?.label === 'dashboard alert delta')).toBe(true);
    expect(analyticsAllSpy.mock.calls.some(([, , options]) => (
      options?.label === 'dashboard alert index' || options?.label === 'dashboard decision index'
    ))).toBe(false);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('dashboard scenario filters only include exact scenario matches', async () => {
    const envAccessAlert = sampleAlert({
      id: 201,
      uuid: 'dashboard-vpatch-env-access',
      scenario: 'crowdsecurity/vpatch-env-access',
      decisions: [
        {
          id: 2010,
          type: 'ban',
          value: '1.2.3.4',
          duration: '30m',
          stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
          origin: 'crowdsec',
          scenario: 'crowdsecurity/vpatch-env-access',
          simulated: false,
        },
      ],
    });
    const gitConfigAlert = sampleAlert({
      id: 202,
      uuid: 'dashboard-vpatch-git-config',
      scenario: 'crowdsecurity/vpatch-git-config',
      source: {
        ip: '5.6.7.8',
        value: '5.6.7.8',
        cn: 'US',
        as_name: 'AWS',
      },
      decisions: [
        {
          id: 2020,
          type: 'ban',
          value: '5.6.7.8',
          duration: '30m',
          stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
          origin: 'crowdsec',
          scenario: 'crowdsecurity/vpatch-git-config',
          simulated: false,
        },
      ],
    });
    const dashboardAlerts = [envAccessAlert, gitConfigAlert];
    const { controller, database, lapiClient } = createController({
      fetchResolver: (url) => {
        if (url.includes('/v1/alerts?')) {
          return Response.json(dashboardAlerts);
        }
        return undefined;
      },
    });

    for (const alert of dashboardAlerts) {
      seedAlert(database, alert);
    }
    await lapiClient.login();

    const filteredResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/dashboard/stats?granularity=day&scenario=crowdsecurity/vpatch-env-access'));
    expect(filteredResponse.status).toBe(200);
    const filteredStats = await filteredResponse.json() as {
      filteredTotals: { alerts: number; decisions: number };
      topScenarios: Array<{ label: string; count: number }>;
    };
    expect(filteredStats.filteredTotals).toEqual(expect.objectContaining({ alerts: 1, decisions: 1 }));
    expect(filteredStats.topScenarios).toEqual([
      expect.objectContaining({ label: 'crowdsecurity/vpatch-env-access', count: 1 }),
    ]);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('uses configured TZ for dashboard buckets and date filters', async () => {
    const createdAt = new Date().toISOString();
    const berlinParts = new Intl.DateTimeFormat('en', {
      timeZone: 'Europe/Berlin',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(createdAt));
    const berlinPart = (type: Intl.DateTimeFormatPartTypes) => berlinParts.find((part) => part.type === type)?.value;
    const berlinHour = `${berlinPart('year')}-${berlinPart('month')}-${berlinPart('day')}T${berlinPart('hour')}`;
    const alert = sampleAlert({
      id: 1801,
      uuid: 'configured-timezone-alert',
      created_at: createdAt,
      decisions: [],
    });
    const { controller, database, lapiClient } = createController({
      env: {
        TZ: 'Europe/Berlin',
        TIME_FORMAT: '24h',
      },
      fetchResolver: (url) => url.includes('/v1/alerts?') ? Response.json([alert]) : undefined,
    });
    seedAlert(database, alert);
    await lapiClient.login();

    const configResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
    expect(await configResponse.json()).toEqual(expect.objectContaining({
      time_zone: 'Europe/Berlin',
      time_format: '24h',
    }));

    const hourOne = await controller.fetch(new Request(
      `http://localhost/crowdsec/api/dashboard/stats?granularity=hour&dateStart=${berlinHour}&dateEnd=${berlinHour}&tz_offset=720&browser_tz=America%2FLos_Angeles`,
    ));
    expect(await hourOne.json()).toEqual(expect.objectContaining({
      filteredTotals: expect.objectContaining({ alerts: 1 }),
      series: expect.objectContaining({
        alertsHistory: [expect.objectContaining({ date: berlinHour, count: 1 })],
      }),
    }));

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('keeps dashboard and alert counts aligned at a browser timezone day boundary', async () => {
    const browserTimeZone = 'America/Los_Angeles';
    const localDateParts = new Intl.DateTimeFormat('en', {
      timeZone: browserTimeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(Date.now() - 24 * 60 * 60 * 1_000));
    const localDatePart = (type: Intl.DateTimeFormatPartTypes) => (
      localDateParts.find((part) => part.type === type)?.value
    );
    const localDate = `${localDatePart('year')}-${localDatePart('month')}-${localDatePart('day')}`;
    const dayStart = parseDashboardBucketKey(localDate, 0, browserTimeZone).getTime();
    const insideDay = new Date(dayStart + 60 * 60 * 1_000).toISOString();
    const outsideDay = new Date(dayStart - 60 * 60 * 1_000).toISOString();
    const alerts = [
      sampleAlert({
        id: 1901,
        uuid: 'browser-timezone-inside-day',
        created_at: insideDay,
        decisions: [],
      }),
      sampleAlert({
        id: 1902,
        uuid: 'browser-timezone-outside-day',
        created_at: outsideDay,
        decisions: [],
      }),
    ];
    const { controller, database } = createController({
      env: {
        CROWDSEC_LOOKBACK_PERIOD: '168h',
      },
      initialCacheState: {
        isInitialized: true,
        isComplete: true,
        lastUpdate: new Date().toISOString(),
      },
    });
    alerts.forEach((alert) => seedAlert(database, alert));
    const filters = new URLSearchParams({
      dateStart: localDate,
      dateEnd: localDate,
      tz_offset: '0',
      browser_tz: browserTimeZone,
    });

    const dashboardResponse = await controller.fetch(new Request(
      `http://localhost/crowdsec/api/dashboard/stats?${filters.toString()}`,
    ));
    const dashboard = await dashboardResponse.json() as DashboardStatsResponse;
    filters.set('page', '1');
    filters.set('page_size', '10');
    const alertsResponse = await controller.fetch(new Request(
      `http://localhost/crowdsec/api/alerts?${filters.toString()}`,
    ));
    const alertPage = await alertsResponse.json() as PaginatedResponse<SlimAlert>;

    expect(dashboard.filteredTotals.alerts).toBe(1);
    expect(alertPage.pagination.total).toBe(dashboard.filteredTotals.alerts);
    expect(alertPage.data.map((alert) => alert.id)).toEqual([1901]);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('includes machine in decision payloads', async () => {
    const firstAlert = sampleAlert({
      id: 101,
      uuid: 'alert-101',
      machine_id: 'machine-1',
      machine_alias: 'host-a',
      decisions: [
        {
          id: 1010,
          type: 'ban',
          value: '1.2.3.4',
          duration: '30m',
          origin: 'manual',
          simulated: false,
        },
      ],
    });
    const secondAlert = sampleAlert({
      id: 102,
      uuid: 'alert-102',
      source: {
        ip: '5.6.7.8',
        value: '5.6.7.8',
        cn: 'US',
        as_name: 'AWS',
      },
      machine_id: 'machine-2',
      decisions: [
        {
          id: 1020,
          type: 'ban',
          value: '5.6.7.8',
          duration: '30m',
          origin: 'manual',
          simulated: false,
        },
      ],
    });

    const { controller } = createController({
      fetchResolver: (url) => {
        if (url.includes('/v1/alerts?') && url.includes('scope=ip')) {
          return Response.json([firstAlert, secondAlert]);
        }
        if (url.includes('/v1/alerts?') && url.includes('scope=range')) {
          return Response.json([]);
        }
        return undefined;
      },
    });

    const alertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alertsResponse.status).toBe(200);

    const decisionsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions'));
    expect(decisionsResponse.status).toBe(200);
    expect((await decisionsResponse.json()) as Array<{ id: number; machine?: string }>).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 1010, machine: 'host-a' }),
        expect.objectContaining({ id: 1020, machine: 'machine-2' }),
      ]),
    );
  });

 });
