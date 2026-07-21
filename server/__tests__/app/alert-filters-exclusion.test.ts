import { describe, expect, test } from 'vitest';
import type { AlertRecord } from '../../../shared/contracts';
import {
  createController,
  destroyTempDir,
  sampleAlert,
  sampleAppSecAlert,
  sampleBlocklistImportAlert,
  sampleCapiAlert,
  sampleListsAlert,
  sampleManualWebUiAlert,
  sampleRangeAlert,
  seedAlert,
} from './harness';

describe('createApp alert source filter exclusion', () => {
  test('exclude no origin drops no-origin alerts from the default unfiltered lane', async () => {
    const noOriginAlert = sampleAlert({
      id: 58,
      uuid: 'alert-58',
      decisions: [],
      message: 'No origin alert to exclude',
    });
    const crowdsecAlert = sampleAlert({
      id: 59,
      uuid: 'alert-59',
      decisions: [
        {
          id: 590,
          type: 'ban',
          value: '6.6.6.6',
          duration: '30m',
          origin: 'crowdsec',
          scenario: 'crowdsecurity/ssh-bf',
          simulated: false,
        },
      ],
    });

    const { controller, database, fetchCalls } = createController({
      env: {
        CROWDSEC_ALERT_EXCLUDE_ORIGIN_EMPTY: 'true',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (!url.includes('/v1/alerts?')) {
          return undefined;
        }
        if (!url.includes('origin=') && !url.includes('scope=')) {
          return Response.json([noOriginAlert]);
        }
        if (!url.includes('origin=') && url.includes('scope=ip')) {
          return Response.json([crowdsecAlert]);
        }
        return Response.json([]);
      },
    });

    const alertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alertsResponse.status).toBe(200);
    const alerts = await alertsResponse.json() as Array<{ id: number }>;
    expect(alerts).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 59 })]),
    );
    expect(alerts.some((alert) => alert.id === 58)).toBe(false);

    const alertRequests = fetchCalls.filter((call) => call.url.includes('/v1/alerts?'));
    expect(alertRequests).toHaveLength(3);
    expect(alertRequests.every((call) => call.url.includes('include_capi=false'))).toBe(true);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('exclude no origin wins over include no origin', async () => {
    const noOriginAlert = sampleAlert({
      id: 60,
      uuid: 'alert-60',
      decisions: [],
      message: 'No origin alert to exclude',
    });

    const { controller, database, fetchCalls } = createController({
      env: {
        CROWDSEC_ALERT_INCLUDE_ORIGIN_EMPTY: 'true',
        CROWDSEC_ALERT_EXCLUDE_ORIGIN_EMPTY: 'true',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (!url.includes('/v1/alerts?')) {
          return undefined;
        }
        if (!url.includes('origin=') && !url.includes('scope=')) {
          return Response.json([noOriginAlert]);
        }
        return Response.json([]);
      },
    });

    const alertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alertsResponse.status).toBe(200);
    expect(await alertsResponse.json()).toEqual([]);

    const alertRequests = fetchCalls.filter((call) => call.url.includes('/v1/alerts?'));
    expect(alertRequests).toHaveLength(3);
    expect(alertRequests.every((call) => !call.url.includes('origin='))).toBe(true);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('exclude origins drops mixed-origin alerts from the merged result set', async () => {
    const mixedAlert = sampleAlert({
      id: 21,
      uuid: 'alert-21',
      decisions: [
        {
          id: 210,
          type: 'ban',
          value: '1.2.3.4',
          duration: '30m',
          origin: 'crowdsec',
          scenario: 'crowdsecurity/ssh-bf',
          simulated: false,
        },
        {
          id: 211,
          type: 'ban',
          value: '1.2.3.4',
          duration: '30m',
          origin: 'cscli',
          scenario: 'manual/web-ui',
          simulated: false,
        },
      ],
    });
    const cleanAlert = sampleAlert({
      id: 22,
      uuid: 'alert-22',
      decisions: [
        {
          id: 220,
          type: 'ban',
          value: '2.2.2.2',
          duration: '30m',
          origin: 'crowdsec',
          scenario: 'crowdsecurity/http-bf',
          simulated: false,
        },
      ],
    });

    const { controller, database, fetchCalls } = createController({
      env: {
        CROWDSEC_ALERT_EXCLUDE_ORIGINS: 'cscli',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (!url.includes('/v1/alerts?')) {
          return undefined;
        }
        if (!url.includes('origin=') && !url.includes('scope=')) {
          return Response.json([mixedAlert]);
        }
        if (!url.includes('origin=') && url.includes('scope=ip')) {
          return Response.json([cleanAlert]);
        }
        return Response.json([]);
      },
    });

    const alertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alertsResponse.status).toBe(200);

    const alerts = await alertsResponse.json() as Array<{ id: number }>;
    expect(alerts).toEqual([expect.objectContaining({ id: 22 })]);

    const alertRequests = fetchCalls.filter((call) => call.url.includes('/v1/alerts?'));
    expect(alertRequests).toHaveLength(3);
    expect(alertRequests.every((call) => call.url.includes('include_capi=false'))).toBe(true);
    expect(alertRequests.every((call) => !call.url.includes('origin='))).toBe(true);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('exclude origins drops no-decision lists alerts using source scope fallbacks', async () => {
    const listsAlert = sampleListsAlert({
      id: 52,
      uuid: 'alert-52',
      decisions: [],
    });

    const { controller, database, fetchCalls } = createController({
      env: {
        CROWDSEC_ALERT_INCLUDE_ORIGINS: 'lists',
        CROWDSEC_ALERT_EXCLUDE_ORIGINS: 'lists',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (!url.includes('/v1/alerts?')) {
          return undefined;
        }
        if (url.includes('origin=lists') && !url.includes('scope=')) {
          return Response.json([listsAlert]);
        }
        return Response.json([]);
      },
    });

    const alertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alertsResponse.status).toBe(200);
    expect(await alertsResponse.json()).toEqual([]);

    const alertRequests = fetchCalls.filter((call) => call.url.includes('/v1/alerts?'));
    expect(alertRequests).toHaveLength(1);
    expect(alertRequests.every((call) => call.url.includes('origin=lists'))).toBe(true);
    expect(alertRequests.every((call) => !call.url.includes('scope='))).toBe(true);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('excluding CAPI suppresses the extra CAPI query but keeps the default feed', async () => {
    const { controller, database, fetchCalls } = createController({
      env: {
        CROWDSEC_ALERT_INCLUDE_CAPI: 'true',
        CROWDSEC_ALERT_EXCLUDE_ORIGINS: 'CAPI',
      },
    });

    const alertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alertsResponse.status).toBe(200);
    expect(await alertsResponse.json()).toEqual([]);

    const alertRequests = fetchCalls.filter((call) => call.url.includes('/v1/alerts?'));
    expect(alertRequests.some((call) => !call.url.includes('origin=') && call.url.includes('include_capi=false'))).toBe(true);
    expect(alertRequests.some((call) => call.url.includes('origin=CAPI'))).toBe(false);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('boot cleanup applies CAPI and non-CAPI exclude origins to cached rows', async () => {
    const crowdsecAlert = sampleAlert({
      id: 68,
      uuid: 'alert-68',
      decisions: [
        {
          id: 680,
          type: 'ban',
          value: '8.8.8.8',
          duration: '30m',
          origin: 'crowdsec',
          scenario: 'crowdsecurity/ssh-bf',
          simulated: false,
        },
      ],
    });
    const staleManualAlert = sampleManualWebUiAlert({ id: 69, uuid: 'alert-69' });
    const staleCapiAlert = sampleCapiAlert({ id: 70, uuid: 'alert-70' });

    const { controller, database, fetchCalls } = createController({
      env: {
        CROWDSEC_ALERT_INCLUDE_CAPI: 'true',
        CROWDSEC_ALERT_EXCLUDE_ORIGINS: 'CAPI,cscli',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (!url.includes('/v1/alerts?')) {
          return undefined;
        }
        if (!url.includes('origin=') && url.includes('scope=ip')) {
          return Response.json([crowdsecAlert]);
        }
        return Response.json([]);
      },
    });

    seedAlert(database, crowdsecAlert);
    seedAlert(database, staleManualAlert);
    seedAlert(database, staleCapiAlert);

    const alertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alertsResponse.status).toBe(200);
    expect(await alertsResponse.json()).toEqual([expect.objectContaining({ id: 68 })]);

    const storedAlerts = database.db.query('SELECT id FROM alerts ORDER BY id').all() as Array<{ id: number }>;
    expect(storedAlerts).toEqual([{ id: 68 }]);
    const storedDecisions = database.db.query('SELECT origin FROM decisions ORDER BY id').all() as Array<{ origin: string }>;
    expect(storedDecisions).toEqual([{ origin: 'crowdsec' }]);

    const alertRequests = fetchCalls.filter((call) => call.url.includes('/v1/alerts?'));
    expect(alertRequests.some((call) => call.url.includes('origin=CAPI'))).toBe(false);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('alert source filters intentionally prune replayed crowdsec alerts when excluded', async () => {
    const replayStartAt = new Date(Date.now() - 30_000).toISOString();
    const replayStopAt = new Date(Date.now() - 5_000).toISOString();
    const replayAlert = sampleAlert({
      id: 71,
      uuid: 'alert-71',
      created_at: new Date().toISOString(),
      start_at: replayStartAt,
      stop_at: replayStopAt,
      decisions: [
        {
          id: 710,
          type: 'ban',
          value: '71.71.71.71',
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
        CROWDSEC_ALERT_EXCLUDE_ORIGINS: 'crowdsec',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (url.includes('/v1/alerts?')) {
          return Response.json([replayAlert]);
        }
        return undefined;
      },
    });

    seedAlert(database, replayAlert);

    const alertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alertsResponse.status).toBe(200);
    expect(await alertsResponse.json()).toEqual([]);
    expect(database.countAlerts()).toBe(0);
    expect(database.getDecisionById('710')).toBeNull();

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('origin allowlist can combine the unfiltered feed with CAPI alerts', async () => {
    const crowdsecAlert = sampleAlert({
      id: 14,
      uuid: 'alert-14',
      decisions: [
        {
          id: 140,
          type: 'ban',
          value: '1.2.3.4',
          duration: '30m',
          origin: 'crowdsec',
          scenario: 'crowdsecurity/ssh-bf',
          simulated: false,
        },
      ],
    });
    const capiAlert = sampleCapiAlert({
      id: 15,
      uuid: 'alert-15',
      decisions: [
        {
          id: 150,
          type: 'ban',
          value: '8.8.8.8',
          duration: '24h',
          stop_at: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
          origin: 'CAPI',
          scenario: 'http:scan',
          simulated: false,
        },
      ],
    });

    const { controller, database, fetchCalls } = createController({
      env: {
        CROWDSEC_ALERT_ORIGINS: 'none,CAPI',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (!url.includes('/v1/alerts?')) {
          return undefined;
        }
        if (url.includes('origin=CAPI') && !url.includes('scope=')) {
          return Response.json([capiAlert]);
        }
        if (!url.includes('origin=') && url.includes('scope=ip')) {
          return Response.json([crowdsecAlert]);
        }
        return Response.json([]);
      },
    });

    const alertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alertsResponse.status).toBe(200);

    const alerts = await alertsResponse.json() as Array<{ id: number; scenario?: string }>;
    expect(alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 14, scenario: 'crowdsecurity/ssh-bf' }),
      expect.objectContaining({ id: 15, scenario: 'crowdsecurity/community-blocklist' }),
    ]));

    const alertRequests = fetchCalls.filter((call) => call.url.includes('/v1/alerts?'));
    expect(alertRequests.some((call) => !call.url.includes('origin=') && call.url.includes('include_capi=false') && !call.url.includes('scope='))).toBe(true);
    expect(alertRequests.some((call) => !call.url.includes('origin=') && call.url.includes('include_capi=false') && call.url.includes('scope=ip'))).toBe(true);
    expect(alertRequests.some((call) => !call.url.includes('origin=') && call.url.includes('include_capi=false') && call.url.includes('scope=range'))).toBe(true);
    expect(alertRequests.some((call) => call.url.includes('origin=CAPI') && call.url.includes('include_capi=true') && !call.url.includes('scope='))).toBe(true);

    const alertCount = (database.db.query('SELECT COUNT(*) AS count FROM alerts').get() as { count: number }).count;
    expect(alertCount).toBe(2);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('crowdsec AppSec alerts keep their raw scenario in the alerts list', async () => {
    const appSecAlert = sampleAppSecAlert();
    const crowdsecAlert = sampleAlert({
      id: 7,
      uuid: 'alert-7',
      decisions: [
        {
          id: 70,
          type: 'ban',
          value: '1.2.3.4',
          duration: '30m',
          origin: 'crowdsec',
          scenario: 'crowdsecurity/ssh-bf',
          simulated: false,
        },
      ],
    });

    const { controller, database, fetchCalls } = createController({
      env: {
        CROWDSEC_ALERT_INCLUDE_ORIGINS: 'crowdsec',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (!url.includes('/v1/alerts?')) {
          return undefined;
        }
        if (url.includes('origin=crowdsec') && url.includes('scope=ip')) {
          return Response.json([appSecAlert, crowdsecAlert]);
        }
        return Response.json([]);
      },
    });

    const alertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alertsResponse.status).toBe(200);

    const alerts = await alertsResponse.json() as Array<{ id: number; scenario?: string; reason?: string }>;
    expect(alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 6,
        scenario: 'crowdsecurity/appsec-vpatch',
      }),
      expect.objectContaining({
        id: 7,
        scenario: 'crowdsecurity/ssh-bf',
      }),
    ]));

    const alertRequests = fetchCalls.filter((call) => call.url.includes('/v1/alerts?'));
    expect(alertRequests.some((call) => call.url.includes('origin=crowdsec') && call.url.includes('include_capi=false') && call.url.includes('scope=ip'))).toBe(true);
    expect(alertRequests.some((call) => call.url.includes('origin=crowdsec') && call.url.includes('include_capi=false') && call.url.includes('scope=range'))).toBe(true);

    const storedAlert = database.getAlertDecisionSnapshot(6);
    expect(JSON.parse(storedAlert?.raw_data || 'null')).toEqual(expect.objectContaining({
      scenario: 'crowdsecurity/appsec-vpatch',
    }));

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });
});
