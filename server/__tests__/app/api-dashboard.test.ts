import { describe, expect, test, vi } from 'vitest';
import path from 'path';
import type { AlertRecord, DashboardStatsResponse, PaginatedResponse, SlimAlert } from '../../../shared/contracts';
import { CrowdsecDatabase } from '../../database';
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

    const simulatedResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/dashboard/stats?simulation=simulated'));
    expect((await simulatedResponse.json()) as {
      filteredTotals: { alerts: number; decisions: number; simulatedAlerts: number; simulatedDecisions: number };
    }).toEqual(expect.objectContaining({
      filteredTotals: { alerts: 1, decisions: 0, simulatedAlerts: 1, simulatedDecisions: 1 },
    }));

    const dateResponse = await controller.fetch(new Request(`http://localhost/crowdsec/api/dashboard/stats?dateStart=${dateKey}&dateEnd=${dateKey}&tz_offset=${timezoneOffset}`));
    expect((await dateResponse.json()) as {
      filteredTotals: { alerts: number; decisions: number; simulatedAlerts: number; simulatedDecisions: number };
    }).toEqual(expect.objectContaining({
      filteredTotals: { alerts: 3, decisions: 2, simulatedAlerts: 1, simulatedDecisions: 1 },
    }));

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
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
    seedAlert(database, alert);
    const { controller } = createController({
      database,
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

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const secondResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/dashboard/stats'));
      expect((await secondResponse.json()) as { filteredTotals: { decisions: number } }).toEqual(
        expect.objectContaining({ filteredTotals: expect.objectContaining({ decisions: 0 }) }),
      );
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

  test('serves a fresh dashboard snapshot on the first request after invalidation', async () => {
    const alert = sampleAlert({
      id: 302,
      uuid: 'dashboard-alert-302',
      created_at: new Date().toISOString(),
    });
    const { controller, database } = createController({
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
      `http://localhost/crowdsec/api/dashboard/stats?granularity=hour&dateStart=${berlinHour}&dateEnd=${berlinHour}&tz_offset=720`,
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
