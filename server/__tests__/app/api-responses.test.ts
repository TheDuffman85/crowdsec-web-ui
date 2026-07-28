import { describe, expect, test, vi } from 'vitest';
import path from 'path';
import type {
  AlertRecord,
  DashboardStatsResponse,
  DecisionListItem,
  PaginatedResponse,
  SlimAlert,
} from '../../../shared/contracts';
import { CrowdsecDatabase } from '../../database';
import { DatabaseQueryWorker } from '../../query-worker-client';
import {
  createController,
  dashboardDateKey,
  destroyTempDir,
  sampleAlert,
  sampleSimulatedAlert,
  seedAlert,
  tempDir,
} from './harness';

describe('createApp API responses', () => {
  test('reuses alert totals and a narrow ID window across consecutive pages', async () => {
    const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
    const now = Date.now();
    for (let index = 0; index < 25; index += 1) {
      seedAlert(database, sampleAlert({
        id: 8_000 + index,
        uuid: `alert-page-window-${index}`,
        created_at: new Date(now - index * 1_000).toISOString(),
        decisions: [],
      }));
    }
    const queryWorker = new DatabaseQueryWorker({ dbPath: database.dbPath });
    const getSpy = vi.spyOn(queryWorker, 'get');
    const { controller } = createController({
      database,
      queryWorker,
      env: {
        CROWDSEC_LOOKBACK_PERIOD: '1h',
        CROWDSEC_REFRESH_INTERVAL: '1m',
      },
      initialCacheState: {
        isInitialized: true,
        isComplete: true,
        lastUpdate: new Date().toISOString(),
      },
    });
    const combinedFilters = new URLSearchParams({
      country: 'DE',
      scenario: 'crowdsecurity/ssh-bf',
      as: 'Hetzner',
      ip: '1.2.3.4',
      target: 'ssh',
      dateStart: new Date(now - 60_000).toISOString(),
      simulation: 'live',
      q: 'country:DE AND (scenario:crowdsecurity/ssh-bf OR target:ssh) AND ip:1.2.3.4 AND sim:live',
    }).toString();

    try {
      const firstResponse = await controller.fetch(new Request(
        `http://localhost/crowdsec/api/alerts?page=1&page_size=10&${combinedFilters}`,
      ));
      const firstPage = await firstResponse.json() as PaginatedResponse<SlimAlert>;
      expect(firstResponse.status).toBe(200);
      expect(firstPage.data).toHaveLength(10);
      expect(firstPage.pagination.total).toBe(25);

      const countCalls = () => getSpy.mock.calls.filter(([sql]) => (
        sql.includes('COUNT(*) AS count') && sql.includes('MIN(created_at) AS oldest_created_at')
      ));
      const windowCalls = () => getSpy.mock.calls.filter(([sql]) => sql.includes('json_group_array(id) AS ids'));
      expect(countCalls()).toHaveLength(2);
      expect(windowCalls()).toHaveLength(1);
      expect(windowCalls()[0]?.[0]).not.toContain('raw_data');

      const secondResponse = await controller.fetch(new Request(
        `http://localhost/crowdsec/api/alerts?page=2&page_size=10&${combinedFilters}`,
      ));
      const secondPage = await secondResponse.json() as PaginatedResponse<SlimAlert>;
      expect(secondResponse.status).toBe(200);
      expect(secondPage.data).toHaveLength(10);
      expect(secondPage.pagination.total).toBe(25);
      expect(secondPage.data.map((alert) => alert.id)).not.toEqual(firstPage.data.map((alert) => alert.id));
      expect(countCalls()).toHaveLength(2);
      expect(windowCalls()).toHaveLength(1);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('reuses one narrow dynamic ranking window across consecutive decision pages', async () => {
    const alert = sampleAlert({
      id: 902,
      uuid: 'decision-page-window-alert',
      scenario: 'crowdsecurity/page-window',
      decisions: Array.from({ length: 25 }, (_, index) => ({
        id: 9020 + index,
        value: `198.51.100.${index + 1}`,
        stop_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        type: 'ban',
        origin: 'lists',
        scenario: 'crowdsecurity/page-window',
      })),
    });
    const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
    seedAlert(database, alert);
    const queryWorker = new DatabaseQueryWorker({ dbPath: database.dbPath });
    const getSpy = vi.spyOn(queryWorker, 'get');
    const { controller } = createController({
      database,
      queryWorker,
      env: { CROWDSEC_REFRESH_INTERVAL: '1m' },
      initialCacheState: {
        isInitialized: true,
        isComplete: true,
        lastUpdate: new Date().toISOString(),
      },
      fetchResolver: (url) => url.includes('/v1/alerts?') ? Response.json([alert]) : undefined,
    });

    try {
      const query = 'q=scenario%3Dcrowdsecurity%2Fpage-window';
      const firstResponse = await controller.fetch(new Request(
        `http://localhost/crowdsec/api/decisions?page=1&page_size=10&${query}`,
      ));
      const firstPage = await firstResponse.json() as PaginatedResponse<DecisionListItem>;
      expect(firstResponse.status).toBe(200);
      expect(firstPage.data).toHaveLength(10);
      expect(firstPage.pagination.total).toBe(25);

      const rankingCalls = () => getSpy.mock.calls.filter(([sql]) => sql.includes('ranked_filtered_decisions'));
      expect(rankingCalls()).toHaveLength(1);
      expect(rankingCalls()[0]?.[0]).toContain('SELECT id, created_at, stop_at');
      expect(rankingCalls()[0]?.[0]).not.toContain('SELECT decisions.*');

      const secondResponse = await controller.fetch(new Request(
        `http://localhost/crowdsec/api/decisions?page=2&page_size=10&${query}`,
      ));
      const secondPage = await secondResponse.json() as PaginatedResponse<DecisionListItem>;
      expect(secondResponse.status).toBe(200);
      expect(secondPage.data).toHaveLength(10);
      expect(secondPage.pagination.total).toBe(25);
      expect(secondPage.data.map((decision) => decision.id)).not.toEqual(firstPage.data.map((decision) => decision.id));
      expect(rankingCalls()).toHaveLength(1);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('keeps duplicate-group-invariant filter combinations on indexed paging', async () => {
    const value = '198.51.100.77';
    const alert = sampleAlert({
      id: 903,
      uuid: 'decision-invariant-filter-alert',
      decisions: [
        {
          id: 9031,
          value,
          stop_at: new Date(Date.now() + 30 * 60_000).toISOString(),
          type: 'ban',
          origin: 'lists',
          simulated: false,
        },
        {
          id: 9032,
          value,
          stop_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          type: 'ban',
          origin: 'lists',
          simulated: false,
        },
      ],
    });
    const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
    seedAlert(database, alert);
    database.refreshDecisionDuplicateFlags(new Date().toISOString());
    const queryWorker = new DatabaseQueryWorker({ dbPath: database.dbPath });
    const getSpy = vi.spyOn(queryWorker, 'get');
    const allSpy = vi.spyOn(queryWorker, 'all');
    const { controller } = createController({
      database,
      queryWorker,
      env: { CROWDSEC_REFRESH_INTERVAL: '1m' },
      initialCacheState: {
        isInitialized: true,
        isComplete: true,
        lastUpdate: new Date().toISOString(),
      },
      fetchResolver: (url) => url.includes('/v1/alerts?') ? Response.json([alert]) : undefined,
    });

    try {
      const response = await controller.fetch(new Request(
        `http://localhost/crowdsec/api/decisions?page=1&page_size=10&simulation=live&q=${encodeURIComponent(`ip:${value} AND sim:live AND status:active`)}`,
      ));
      const page = await response.json() as PaginatedResponse<DecisionListItem>;
      expect(response.status).toBe(200);
      expect(page.data).toEqual([
        expect.objectContaining({ id: 9032, is_duplicate: false }),
      ]);
      expect([...getSpy.mock.calls, ...allSpy.mock.calls].some(([sql]) => sql.includes('ROW_NUMBER()'))).toBe(false);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('reuses active decision totals while paging until data or expiration changes', async () => {
    const alert = sampleAlert({
      id: 901,
      uuid: 'decision-count-cache-alert',
      decisions: [
        { id: 9011, value: '198.51.100.1', stop_at: new Date(Date.now() + 30 * 60_000).toISOString(), type: 'ban', origin: 'lists' },
        { id: 9012, value: '198.51.100.2', stop_at: new Date(Date.now() + 30 * 60_000).toISOString(), type: 'ban', origin: 'lists' },
      ],
    });
    const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
    seedAlert(database, alert);
    const queryWorker = new DatabaseQueryWorker({ dbPath: database.dbPath });
    const countQuerySpy = vi.spyOn(queryWorker, 'get');
    const { controller } = createController({
      database,
      queryWorker,
      env: { CROWDSEC_REFRESH_INTERVAL: '1m' },
      initialCacheState: {
        isInitialized: true,
        isComplete: true,
        lastUpdate: new Date().toISOString(),
      },
      fetchResolver: (url) => url.includes('/v1/alerts?') ? Response.json([alert]) : undefined,
    });

    try {
      const firstResponse = await controller.fetch(new Request(
        'http://localhost/crowdsec/api/decisions?page=1&page_size=1',
      ));
      expect(firstResponse.status).toBe(200);
      expect((await firstResponse.json() as PaginatedResponse<DecisionListItem>).pagination.total).toBe(2);
      const firstCountQueries = countQuerySpy.mock.calls.filter(([sql]) => (
        sql.includes('COUNT(*) AS count') && sql.includes('MIN(stop_at) AS next_expiration')
      )).length;
      expect(firstCountQueries).toBe(2);

      const secondResponse = await controller.fetch(new Request(
        'http://localhost/crowdsec/api/decisions?page=2&page_size=1',
      ));
      expect(secondResponse.status).toBe(200);
      expect((await secondResponse.json() as PaginatedResponse<DecisionListItem>).pagination.total).toBe(2);
      expect(countQuerySpy.mock.calls.filter(([sql]) => (
        sql.includes('COUNT(*) AS count') && sql.includes('MIN(stop_at) AS next_expiration')
      ))).toHaveLength(firstCountQueries);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('adds resolved city and region to paginated alerts and linked decisions', async () => {
    const alert = sampleAlert({
      source: {
        ...sampleAlert().source,
        city: 'Berlin',
        region: 'State of Berlin',
      },
    });
    const { controller, database, lapiClient } = createController({
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
      attackLocationResolver: {
        resolve: async (locations) => locations.map((location) => ({
          ...location,
          city: 'Berlin',
          region: 'State of Berlin',
          countryCode: 'DE',
        })),
      },
    });
    seedAlert(database, alert);
    await lapiClient.login();

    const alertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=10'));
    expect(alertsResponse.status).toBe(200);
    expect((await alertsResponse.json()) as PaginatedResponse<SlimAlert>).toEqual(expect.objectContaining({
      data: [expect.objectContaining({
        source: expect.objectContaining({ city: 'Berlin', region: 'State of Berlin' }),
      })],
    }));

    const decisionsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions?page=1&page_size=10'));
    expect(decisionsResponse.status).toBe(200);
    expect(await decisionsResponse.json()).toEqual(expect.objectContaining({
      data: [expect.objectContaining({
        detail: expect.objectContaining({ city: 'Berlin', region: 'State of Berlin' }),
      })],
    }));

    const cityAlertsResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/alerts?page=1&page_size=10&q=city:berl',
    ));
    expect(cityAlertsResponse.status).toBe(200);
    expect(await cityAlertsResponse.json()).toEqual(expect.objectContaining({
      data: [expect.objectContaining({ id: alert.id })],
      pagination: expect.objectContaining({ total: 1 }),
    }));

    const regionDecisionsResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/decisions?page=1&page_size=10&q=region:%22state%20of%20berl%22',
    ));
    expect(regionDecisionsResponse.status).toBe(200);
    expect(await regionDecisionsResponse.json()).toEqual(expect.objectContaining({
      data: [expect.objectContaining({ id: alert.decisions?.[0]?.id })],
      pagination: expect.objectContaining({ total: 1 }),
    }));

    const unmatchedCityResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/alerts?page=1&page_size=10&q=city:Baixa',
    ));
    expect(unmatchedCityResponse.status).toBe(200);
    expect(await unmatchedCityResponse.json()).toEqual(expect.objectContaining({
      data: [],
      pagination: expect.objectContaining({ total: 0 }),
    }));

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('summarizes paginated alert decisions without embedding decision rows', async () => {
    const now = Date.now();
    const alert = sampleAlert({
      id: 77,
      uuid: 'alert-77',
      decisions: [
        { id: 7701, stop_at: new Date(now + 60_000).toISOString(), origin: 'lists', simulated: false },
        { id: 7702, stop_at: new Date(now + 60_000).toISOString(), origin: 'CAPI', simulated: true },
        { id: 7703, stop_at: new Date(now - 60_000).toISOString(), origin: 'lists', simulated: false },
        { id: 7704, stop_at: new Date(now - 60_000).toISOString(), origin: 'CAPI', simulated: true },
      ],
      simulated: false,
    });
    const { controller, database } = createController({
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
      alertDetailPayload: alert,
    });
    seedAlert(database, alert);

    const response = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/alerts?page=1&page_size=10&include_decisions=false',
    ));
    expect(response.status).toBe(200);
    const payload = await response.json() as PaginatedResponse<SlimAlert>;
    expect(payload.data[0]).toMatchObject({
      id: 77,
      decisions: [],
      decision_summary: {
        origins: ['CAPI', 'lists'],
        active_count: 2,
        expired_count: 2,
        simulated_active_count: 1,
        simulated_expired_count: 1,
      },
    });

    const fullListResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/alerts?page=1&page_size=10',
    ));
    expect(fullListResponse.status).toBe(200);
    expect((await fullListResponse.json() as PaginatedResponse<SlimAlert>).data[0].decisions).toHaveLength(4);

    const detailResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/alerts/77?include_decisions=false',
    ));
    expect(detailResponse.status).toBe(200);
    expect(await detailResponse.json()).toEqual(expect.objectContaining({ id: 77, decisions: [] }));

    const fullDetailResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/1'));
    expect(fullDetailResponse.status).toBe(200);
    expect((await fullDetailResponse.json() as AlertRecord).decisions).toHaveLength(4);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('serves health, config, alerts, decisions, stats, update-check, and mutations', async () => {
    const alert = sampleAlert();
    const simulatedAlert = sampleSimulatedAlert();
    const { controller, database, lapiClient } = createController({
      fetchResolver: (url) => {
        if (url.includes('/v1/alerts?')) {
          return Response.json([alert, simulatedAlert]);
        }
        return undefined;
      },
    });

    database.insertAlert({
      $id: alert.id,
      $uuid: alert.uuid || String(alert.id),
      $created_at: alert.created_at,
      $scenario: alert.scenario,
      $source_ip: alert.source?.ip || '',
      $message: alert.message || '',
      $raw_data: JSON.stringify(alert),
    });
    database.insertDecision({
      $id: '10',
      $uuid: '10',
      $alert_id: 1,
      $created_at: alert.created_at,
      $stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
      $value: '1.2.3.4',
      $type: 'ban',
      $origin: 'manual',
      $scenario: alert.scenario,
      $raw_data: JSON.stringify({
        id: 10,
        created_at: alert.created_at,
        scenario: alert.scenario,
        value: '1.2.3.4',
        stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
        type: 'ban',
        origin: 'manual',
        country: 'DE',
        as: 'Hetzner',
        target: 'ssh',
        simulated: false,
      }),
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
        country: 'US',
        as: 'AWS',
        target: 'nginx',
        simulated: true,
      }),
    });

    await lapiClient.login();

    const health = await controller.fetch(new Request('http://localhost/api/health'));
    expect(await health.json()).toEqual({ status: 'ok' });

    const configResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
    expect(configResponse.status).toBe(200);
    expect(((await configResponse.json()) as {
      lookback_period: string;
      simulations_enabled: boolean;
      machine_features_enabled: boolean;
      origin_features_enabled: boolean;
      metrics_enabled: boolean;
      metrics_sidebar_visible: boolean;
      permissions: { mode: string; can_manage_enforcement: boolean; can_manage_settings: boolean };
    })).toEqual(
      expect.objectContaining({
        lookback_period: '1m',
        simulations_enabled: true,
        machine_features_enabled: true,
        origin_features_enabled: true,
        metrics_enabled: false,
        metrics_sidebar_visible: true,
        permissions: {
          mode: 'admin',
          can_manage_enforcement: true,
          can_manage_settings: true,
        },
      }),
    );

    const alerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alerts.status).toBe(200);
    expect(((await alerts.json()) as Array<{ simulated?: boolean }>)).toEqual(
      expect.arrayContaining([expect.objectContaining({ simulated: true })]),
    );

    const paginatedAlerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=10&simulation=simulated'));
    expect(paginatedAlerts.status).toBe(200);
    expect((await paginatedAlerts.json()) as {
      data: Array<{ id: number; simulated?: boolean }>;
      pagination: { total: number; unfiltered_total: number };
      selectable_ids: number[];
    }).toEqual({
      data: [expect.objectContaining({ id: 2, simulated: true })],
      pagination: expect.objectContaining({ total: 1, unfiltered_total: 2 }),
      selectable_ids: [2],
    });

    const alertDetails = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/1'));
    expect(alertDetails.status).toBe(200);
    expect(((await alertDetails.json()) as { id: number; simulated?: boolean }).id).toBe(1);

    const decisions = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions'));
    expect(decisions.status).toBe(200);
    expect(((await decisions.json()) as Array<{ simulated?: boolean }>)).toEqual(
      expect.arrayContaining([expect.objectContaining({ simulated: true })]),
    );

    const paginatedDecisions = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions?page=1&page_size=10&alert_id=2'));
    expect(paginatedDecisions.status).toBe(200);
    expect((await paginatedDecisions.json()) as {
      data: Array<{ id: number; detail: { alert_id?: number } }>;
      pagination: { total: number; unfiltered_total: number };
      selectable_ids: number[];
    }).toEqual({
      data: [expect.objectContaining({ id: 20, detail: expect.objectContaining({ alert_id: 2 }) })],
      pagination: expect.objectContaining({ total: 1, unfiltered_total: 2 }),
      selectable_ids: [20],
    });

    const statsAlerts = await controller.fetch(new Request('http://localhost/crowdsec/api/stats/alerts'));
    expect(statsAlerts.status).toBe(200);
    expect((await statsAlerts.json()) as Array<{ target?: string; simulated?: boolean }>).toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'nginx', simulated: true })]),
    );

    const statsDecisions = await controller.fetch(new Request('http://localhost/crowdsec/api/stats/decisions'));
    expect(statsDecisions.status).toBe(200);
    expect((await statsDecisions.json()) as Array<{ value?: string; simulated?: boolean }>).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: '5.6.7.8', simulated: true })]),
    );

    const dashboardStats = await controller.fetch(new Request('http://localhost/crowdsec/api/dashboard/stats?granularity=day'));
    expect(dashboardStats.status).toBe(200);
    expect((await dashboardStats.json()) as {
      totals: { alerts: number; decisions: number; simulatedAlerts: number; simulatedDecisions: number };
      filteredTotals: { alerts: number; decisions: number; simulatedAlerts: number; simulatedDecisions: number };
      series: { simulatedAlertsHistory: Array<{ count: number }> };
      allCountries: Array<{ simulatedCount?: number }>;
      attackLocations: Array<{ latitude: number; longitude: number; count: number; simulatedCount: number }>;
    }).toEqual(
      expect.objectContaining({
        totals: { alerts: 2, decisions: 1, simulatedAlerts: 1, simulatedDecisions: 1 },
        filteredTotals: { alerts: 2, decisions: 1, simulatedAlerts: 1, simulatedDecisions: 1 },
        series: expect.objectContaining({
          simulatedAlertsHistory: expect.arrayContaining([expect.objectContaining({ count: 1 })]),
        }),
        allCountries: expect.arrayContaining([expect.objectContaining({ countryCode: 'US', simulatedCount: 1 })]),
        attackLocations: expect.arrayContaining([
          expect.objectContaining({ latitude: 52.52, longitude: 13.405, count: 1 }),
          expect.objectContaining({ latitude: 37.7749, longitude: -122.4194, count: 1, simulatedCount: 1 }),
        ]),
      }),
    );

    const updateCheck = await controller.fetch(new Request('http://localhost/crowdsec/api/update-check'));
    expect(updateCheck.status).toBe(200);
    expect(((await updateCheck.json()) as { update_available: boolean }).update_available).toBe(true);

    const refreshUpdate = await controller.fetch(
      new Request('http://localhost/crowdsec/api/config/refresh-interval', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interval: '5s' }),
      }),
    );
    expect(refreshUpdate.status).toBe(200);
    expect(((await refreshUpdate.json()) as { new_interval_ms: number }).new_interval_ms).toBe(5000);

    const languageUpdate = await controller.fetch(
      new Request('http://localhost/crowdsec/api/config/language', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: 'de' }),
      }),
    );
    expect(languageUpdate.status).toBe(200);
    expect(((await languageUpdate.json()) as { language: string }).language).toBe('de');
    expect(database.getMeta('language')?.value).toBe('de');

    const addDecision = await controller.fetch(
      new Request('http://localhost/crowdsec/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: '5.6.7.8', duration: '4h', type: 'ban', reason: 'manual' }),
      }),
    );
    expect(addDecision.status).toBe(200);

    const deleteDecision = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions/10', { method: 'DELETE' }));
    expect(deleteDecision.status).toBe(200);

    const deleteAlert = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/1', { method: 'DELETE' }));
    expect(deleteAlert.status).toBe(200);

    const clearCache = await controller.fetch(new Request('http://localhost/crowdsec/api/cache/clear', { method: 'POST' }));
    expect(clearCache.status).toBe(200);

    const manifest = await controller.fetch(new Request('http://localhost/crowdsec/site.webmanifest'));
    expect(manifest.status).toBe(200);
    expect(((await manifest.json()) as { start_url: string }).start_url).toBe('/crowdsec');

    const worldMap = await controller.fetch(new Request('http://localhost/crowdsec/world-50m.json'));
    expect(worldMap.status).toBe(200);
    expect(worldMap.headers.get('cache-control')).toBe('public, max-age=86400, stale-while-revalidate=604800');
    expect((await worldMap.text()).startsWith('{"type"')).toBe(true);

    const logo = await controller.fetch(new Request('http://localhost/crowdsec/logo.svg'));
    expect(logo.status).toBe(200);
    expect((await logo.text()).includes('<svg')).toBe(true);

    const sidebarLogo = await controller.fetch(new Request('http://localhost/crowdsec/logo-sidebar.png'));
    expect(sidebarLogo.status).toBe(200);

    const asset = await controller.fetch(new Request('http://localhost/crowdsec/assets/app.js'));
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    const missingAsset = await controller.fetch(new Request('http://localhost/crowdsec/assets/Notifications-old.js'));
    expect(missingAsset.status).toBe(404);
    expect(await missingAsset.text()).toBe('Not Found');

    const route = await controller.fetch(new Request('http://localhost/crowdsec/alerts'));
    expect(route.status).toBe(200);
    expect(route.headers.get('cache-control')).toBe('no-store, no-cache, must-revalidate');

    const redirect = await controller.fetch(new Request('http://localhost/'));
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('/crowdsec/');

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('read-only mode blocks enforcement and management mutations but allows preferences and notification read state', async () => {
    const alert = sampleAlert();
    const { controller, database, lapiClient, fetchCalls } = createController({
      env: { PERMISSION_READ_ONLY: 'true' },
    });
    await lapiClient.login();
    seedAlert(database, alert);
    const now = new Date().toISOString();
    database.insertNotification({
      $id: 'notif-1',
      $created_at: now,
      $updated_at: now,
      $rule_id: 'rule-1',
      $rule_name: 'Rule 1',
      $rule_type: 'alert-threshold',
      $severity: 'warning',
      $title: 'Notification 1',
      $message: 'Notification body',
      $read_at: null,
      $metadata_json: '{}',
      $deliveries_json: '[]',
      $dedupe_key: 'notif-1',
    });

    const configResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
    expect(configResponse.status).toBe(200);
    expect((await configResponse.json()) as { permissions?: { mode: string; can_manage_enforcement: boolean; can_manage_settings: boolean } }).toEqual(
      expect.objectContaining({
        permissions: {
          mode: 'read-only',
          can_manage_enforcement: false,
          can_manage_settings: false,
        },
      }),
    );

    const guardedRequests = [
      new Request('http://localhost/crowdsec/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: '5.6.7.8', duration: '4h', type: 'ban', reason: 'manual' }),
      }),
      new Request('http://localhost/crowdsec/api/decisions/10', { method: 'DELETE' }),
      new Request('http://localhost/crowdsec/api/decisions/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ['10'] }),
      }),
      new Request('http://localhost/crowdsec/api/alerts/1', { method: 'DELETE' }),
      new Request('http://localhost/crowdsec/api/alerts/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ['1'] }),
      }),
      new Request('http://localhost/crowdsec/api/cleanup/by-ip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: '1.2.3.4' }),
      }),
      new Request('http://localhost/crowdsec/api/cache/clear', { method: 'POST' }),
      new Request('http://localhost/crowdsec/api/config/refresh-interval', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interval: '5s' }),
      }),
      new Request('http://localhost/crowdsec/api/config/manual-refresh', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }),
      new Request('http://localhost/crowdsec/api/notifications/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ['notif-1'] }),
      }),
      new Request('http://localhost/crowdsec/api/notifications/delete-read', { method: 'POST' }),
      new Request('http://localhost/crowdsec/api/notifications/notif-1', { method: 'DELETE' }),
      new Request('http://localhost/crowdsec/api/notification-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      new Request('http://localhost/crowdsec/api/notification-channels/channel-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      new Request('http://localhost/crowdsec/api/notification-channels/channel-1', { method: 'DELETE' }),
      new Request('http://localhost/crowdsec/api/notification-channels/channel-1/test', { method: 'POST' }),
      new Request('http://localhost/crowdsec/api/notification-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      new Request('http://localhost/crowdsec/api/notification-rules/rule-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      new Request('http://localhost/crowdsec/api/notification-rules/rule-1', { method: 'DELETE' }),
    ];

    for (const request of guardedRequests) {
      const response = await controller.fetch(request);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'Read-only mode is enabled',
        code: 'READ_ONLY',
      });
    }

    expect(database.countAlerts()).toBe(1);
    expect(database.countDecisions()).toBe(1);
    expect(database.getDecisionById('10')).not.toBeNull();
    expect(fetchCalls.filter((call) =>
      (call.url.endsWith('/v1/alerts') && call.method === 'POST') ||
      (/\/v1\/alerts\/\d+$/.test(call.url) && call.method === 'DELETE') ||
      (/\/v1\/decisions\/\d+$/.test(call.url) && call.method === 'DELETE')
    )).toEqual([]);

    const languageUpdate = await controller.fetch(
      new Request('http://localhost/crowdsec/api/config/language', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: 'de' }),
      }),
    );
    expect(languageUpdate.status).toBe(200);

    const markRead = await controller.fetch(new Request('http://localhost/crowdsec/api/notifications/notif-1/read', { method: 'POST' }));
    expect(markRead.status).toBe(200);
    const bulkRead = await controller.fetch(new Request('http://localhost/crowdsec/api/notifications/bulk-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['notif-1'] }),
    }));
    expect(bulkRead.status).toBe(200);
    expect(database.countNotifications()).toBe(1);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

 });
