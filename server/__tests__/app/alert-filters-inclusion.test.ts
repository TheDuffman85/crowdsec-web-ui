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

describe('createApp alert source filter inclusion', () => {
  test('uses unfiltered alert queries by default during bootstrap', async () => {
    const crowdsecAlert = sampleAlert();
    const rangeAlert = sampleRangeAlert();
    const { controller, database, fetchCalls } = createController({
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (url.includes('/v1/alerts?') && url.includes('scope=range')) {
          return Response.json([rangeAlert]);
        }
        if (url.includes('/v1/alerts?') && url.includes('scope=ip')) {
          return Response.json([crowdsecAlert]);
        }
        return undefined;
      },
    });

    const alerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alerts.status).toBe(200);

    const alertRequests = fetchCalls.filter((call) => call.url.includes('/v1/alerts?'));
    expect(alertRequests).toHaveLength(3);
    expect(alertRequests.every((call) => call.url.includes('include_capi=false'))).toBe(true);
    expect(alertRequests.some((call) => !call.url.includes('scope='))).toBe(true);
    expect(alertRequests.some((call) => call.url.includes('scope=ip'))).toBe(true);
    expect(alertRequests.some((call) => call.url.includes('scope=range'))).toBe(true);
    expect(alertRequests.every((call) => !call.url.includes('origin='))).toBe(true);
    expect(alertRequests.every((call) => !call.url.includes('scenario='))).toBe(true);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('allowlist sync excludes blocklist-import alerts while keeping manual web-ui alerts and deduping overlaps', async () => {
    const crowdsecAlert = sampleAlert({
      id: 11,
      uuid: 'alert-11',
      decisions: [
        {
          id: 110,
          type: 'ban',
          value: '1.2.3.4',
          duration: '30m',
          origin: 'crowdsec',
          scenario: 'crowdsecurity/ssh-bf',
          simulated: false,
        },
      ],
    });
    const manualAlert = sampleManualWebUiAlert({
      id: 12,
      uuid: 'alert-12',
      decisions: [
        {
          id: 120,
          type: 'ban',
          value: '9.9.9.9',
          duration: '1h',
          origin: 'cscli',
          scenario: 'manual/web-ui',
          simulated: false,
        },
      ],
    });
    const blocklistAlert = sampleBlocklistImportAlert();
    const overlappingAlert = sampleManualWebUiAlert({
      id: 13,
      uuid: 'alert-13',
      decisions: [
        {
          id: 130,
          type: 'ban',
          value: '7.7.7.7',
          duration: '2h',
          origin: 'crowdsec',
          scenario: 'manual/web-ui',
          simulated: false,
        },
      ],
    });

    const { controller, database, fetchCalls } = createController({
      env: {
        CROWDSEC_ALERT_ORIGINS: 'crowdsec',
        CROWDSEC_ALERT_EXTRA_SCENARIOS: 'manual/web-ui',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (!url.includes('/v1/alerts?')) {
          return undefined;
        }
        if (url.includes('origin=crowdsec')) {
          return Response.json([crowdsecAlert, overlappingAlert]);
        }
        if (url.includes('scenario=manual%2Fweb-ui')) {
          return Response.json([manualAlert, overlappingAlert]);
        }
        return Response.json([crowdsecAlert, manualAlert, overlappingAlert, blocklistAlert]);
      },
    });

    const alerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alerts.status).toBe(200);
    expect((await alerts.json()) as Array<{ id: number }>).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 11 }),
        expect.objectContaining({ id: 12 }),
        expect.objectContaining({ id: 13 }),
      ]),
    );

    const alertRequests = fetchCalls.filter((call) => call.url.includes('/v1/alerts?'));
    expect(alertRequests).toHaveLength(6);
    expect(alertRequests.some((call) => call.url.includes('origin=crowdsec'))).toBe(true);
    expect(alertRequests.some((call) => call.url.includes('scenario=manual%2Fweb-ui'))).toBe(true);
    expect(alertRequests.every((call) => call.url.includes('origin=') || call.url.includes('scenario='))).toBe(true);
    expect(alertRequests.every((call) => call.url.includes('include_capi=false'))).toBe(true);
    expect(alertRequests.some((call) => call.url.includes('origin=crowdsec') && !call.url.includes('scope='))).toBe(true);
    expect(alertRequests.some((call) => call.url.includes('origin=crowdsec') && call.url.includes('scope=ip'))).toBe(true);
    expect(alertRequests.some((call) => call.url.includes('origin=crowdsec') && call.url.includes('scope=range'))).toBe(true);
    expect(alertRequests.some((call) => call.url.includes('scenario=manual%2Fweb-ui') && !call.url.includes('scope='))).toBe(true);
    expect(alertRequests.some((call) => call.url.includes('scenario=manual%2Fweb-ui') && call.url.includes('scope=ip'))).toBe(true);
    expect(alertRequests.some((call) => call.url.includes('scenario=manual%2Fweb-ui') && call.url.includes('scope=range'))).toBe(true);
    expect(alertRequests.every((call) => !call.url.match(/[?&]scope=ip&scope=range/))).toBe(true);

    const alertCount = (database.db.query('SELECT COUNT(*) AS count FROM alerts').get() as { count: number }).count;
    const decisionCount = (database.db.query('SELECT COUNT(*) AS count FROM decisions').get() as { count: number }).count;
    expect(alertCount).toBe(3);
    expect(decisionCount).toBe(3);
    expect(controller.getSyncStatus().message).toContain('3 alerts and 3 decisions cached');

    const storedAlerts = database.db.query('SELECT scenario, record_scenario FROM alerts').all() as Array<{ scenario?: string; record_scenario?: string }>;
    expect(
      storedAlerts.some((row) => [row.scenario, row.record_scenario].includes('crowdsec-blocklist-import/external_blocklist')),
    ).toBe(false);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('imports unscoped cscli alerts that only expose the IP on decisions', async () => {
    const createdAt = new Date().toISOString();
    const importedAlert = {
      id: 17511,
      uuid: 'c2685940-4dec-47b5-871f-996c890b2634',
      created_at: createdAt,
      scenario: 'import stdin: 1 IPs',
      message: '',
      kind: 'cscli',
      source: {
        scope: '',
        value: '',
      },
      events: [],
      events_count: 1,
      decisions: [
        {
          id: 26211171,
          type: 'ban',
          value: '1.2.3.4',
          duration: '11h52m40s',
          origin: 'cscli-import',
          scenario: 'test-import',
          scope: 'Ip',
          simulated: false,
        },
      ],
      simulated: false,
    } satisfies AlertRecord;

    const { controller, database, fetchCalls } = createController({
      env: {
        CROWDSEC_ALERT_INCLUDE_ORIGINS: 'cscli-import',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (!url.includes('/v1/alerts?')) {
          return undefined;
        }
        if (url.includes('origin=cscli-import') && !url.includes('scope=')) {
          return Response.json([importedAlert]);
        }
        return Response.json([]);
      },
    });

    const alertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alertsResponse.status).toBe(200);

    const alerts = await alertsResponse.json() as Array<{ id: number; decisions: Array<{ origin?: string; value?: string }> }>;
    expect(alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 17511,
        scenario: 'import stdin: 1 IPs',
        decisions: expect.arrayContaining([
          expect.objectContaining({
            origin: 'cscli-import',
            value: '1.2.3.4',
          }),
        ]),
      }),
    ]));

    const alertRequests = fetchCalls.filter((call) => call.url.includes('/v1/alerts?'));
    expect(alertRequests).toHaveLength(3);
    expect(alertRequests.every((call) => call.url.includes('include_capi=false'))).toBe(true);
    expect(alertRequests.some((call) => call.url.includes('origin=cscli-import') && !call.url.includes('scope='))).toBe(true);
    expect(alertRequests.some((call) => call.url.includes('origin=cscli-import') && call.url.includes('scope=ip'))).toBe(true);
    expect(alertRequests.some((call) => call.url.includes('origin=cscli-import') && call.url.includes('scope=range'))).toBe(true);

    const storedAlert = database.getAlertDecisionSnapshot(17511);
    const storedAlertPayload = JSON.parse(storedAlert?.raw_data || 'null') as AlertRecord;
    expect(storedAlertPayload).toEqual(expect.objectContaining({
      id: 17511,
      kind: 'cscli',
    }));
    expect(storedAlertPayload).not.toHaveProperty('decisions');
    expect(database.getDecisionIdsByAlertId(17511)).toEqual(['26211171']);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('none allowlist matches cscli alerts list defaults by excluding CAPI but keeping other unfiltered alerts', async () => {
    const crowdsecAlert = sampleAlert({ id: 16, uuid: 'alert-16' });
    const importedAlert = {
      id: 17511,
      uuid: 'c2685940-4dec-47b5-871f-996c890b2634',
      created_at: new Date().toISOString(),
      scenario: 'import stdin: 1 IPs',
      message: '',
      kind: 'cscli',
      source: {
        scope: '',
        value: '',
      },
      events: [],
      events_count: 1,
      decisions: [
        {
          id: 26211171,
          type: 'ban',
          value: '1.2.3.4',
          duration: '11h52m40s',
          origin: 'cscli-import',
          scenario: 'test-import',
          scope: 'Ip',
          simulated: false,
        },
      ],
      simulated: false,
    } satisfies AlertRecord;
    const capiAlert = sampleCapiAlert({ id: 17, uuid: 'alert-17' });

    const { controller, database, fetchCalls } = createController({
      env: {
        CROWDSEC_ALERT_ORIGINS: 'none',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (!url.includes('/v1/alerts?')) {
          return undefined;
        }
        if (!url.includes('origin=') && !url.includes('scope=')) {
          if (url.includes('include_capi=false')) {
            return Response.json([importedAlert]);
          }
          return Response.json([importedAlert, capiAlert]);
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
      expect.objectContaining({ id: 16, scenario: 'crowdsecurity/ssh-bf' }),
      expect.objectContaining({ id: 17511, scenario: 'import stdin: 1 IPs' }),
    ]));
    expect(alerts.some((alert) => alert.id === 17)).toBe(false);

    const alertRequests = fetchCalls.filter((call) => call.url.includes('/v1/alerts?'));
    expect(alertRequests).toHaveLength(3);
    expect(alertRequests.every((call) => call.url.includes('include_capi=false'))).toBe(true);
    expect(alertRequests.some((call) => !call.url.includes('scope='))).toBe(true);
    expect(alertRequests.some((call) => call.url.includes('scope=ip'))).toBe(true);
    expect(alertRequests.some((call) => call.url.includes('scope=range'))).toBe(true);
    expect(alertRequests.every((call) => !call.url.includes('origin='))).toBe(true);

    const alertCount = (database.db.query('SELECT COUNT(*) AS count FROM alerts').get() as { count: number }).count;
    expect(alertCount).toBe(2);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('include capi adds CAPI alerts alongside the default non-CAPI feed and persists their decisions', async () => {
    const crowdsecAlert = sampleAlert({
      id: 6,
      uuid: 'alert-6',
      decisions: [
        {
          id: 60,
          type: 'ban',
          value: '1.2.3.4',
          duration: '30m',
          origin: 'crowdsec',
          scenario: 'crowdsecurity/ssh-bf',
          simulated: false,
        },
      ],
    });
    const capiAlert = sampleCapiAlert();

    const { controller, database, fetchCalls } = createController({
      env: {
        CROWDSEC_ALERT_INCLUDE_CAPI: 'true',
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

    const alerts = await alertsResponse.json() as Array<{ id: number; decisions: Array<{ origin?: string }> }>;
    expect(alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 6,
        scenario: 'crowdsecurity/ssh-bf',
      }),
      expect.objectContaining({
        id: 5,
        scenario: 'crowdsecurity/community-blocklist',
        reason: 'update : +15000/-0 IPs',
        decisions: expect.arrayContaining([expect.objectContaining({ origin: 'CAPI' })]),
      }),
    ]));

    const statsAlertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/stats/alerts'));
    expect(statsAlertsResponse.status).toBe(200);
    expect((await statsAlertsResponse.json()) as Array<{ scenario?: string }>).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scenario: 'crowdsecurity/ssh-bf' }),
        expect.objectContaining({ scenario: 'crowdsecurity/community-blocklist' }),
      ]),
    );

    const alertRequests = fetchCalls.filter((call) => call.url.includes('/v1/alerts?'));
    expect(alertRequests.some((call) => !call.url.includes('origin=') && call.url.includes('include_capi=false') && !call.url.includes('scope='))).toBe(true);
    expect(alertRequests.some((call) => !call.url.includes('origin=') && call.url.includes('include_capi=false') && call.url.includes('scope=ip'))).toBe(true);
    expect(alertRequests.some((call) => !call.url.includes('origin=') && call.url.includes('include_capi=false') && call.url.includes('scope=range'))).toBe(true);
    expect(alertRequests.some((call) => call.url.includes('origin=CAPI') && call.url.includes('include_capi=true') && !call.url.includes('scope='))).toBe(true);

    const decisionCount = (database.db.query('SELECT COUNT(*) AS count FROM decisions').get() as { count: number }).count;
    expect(decisionCount).toBe(2);

    const storedDecisions = database.db.query('SELECT origin, raw_data FROM decisions').all() as Array<{ origin: string; raw_data: string | null }>;
    expect(storedDecisions.map((row) => row.origin)).toEqual(expect.arrayContaining(['crowdsec', 'CAPI']));
    expect(storedDecisions.every((row) => row.raw_data === null)).toBe(true);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('boot cleanup removes stale cached CAPI alerts and orphan decisions when CAPI is disabled', async () => {
    const crowdsecAlert = sampleAlert({
      id: 66,
      uuid: 'alert-66',
      decisions: [
        {
          id: 660,
          type: 'ban',
          value: '6.6.6.6',
          duration: '30m',
          origin: 'crowdsec',
          scenario: 'crowdsecurity/ssh-bf',
          simulated: false,
        },
      ],
    });
    const staleCapiAlert = sampleCapiAlert({ id: 67, uuid: 'alert-67' });

    const { controller, database, fetchCalls } = createController({
      env: {
        CROWDSEC_ALERT_INCLUDE_CAPI: 'false',
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

    seedAlert(database, staleCapiAlert);
    seedAlert(database, crowdsecAlert);
    database.insertDecision({
      $id: '6700',
      $uuid: '6700',
      $alert_id: 6700,
      $created_at: new Date().toISOString(),
      $stop_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      $value: '7.7.7.7',
      $type: 'ban',
      $origin: 'CAPI',
      $scenario: 'http:scan',
      $raw_data: JSON.stringify({
        id: 6700,
        alert_id: 6700,
        value: '7.7.7.7',
        origin: 'CAPI',
        stop_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      }),
    });

    const alertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alertsResponse.status).toBe(200);

    const alerts = await alertsResponse.json() as Array<{ id: number }>;
    expect(alerts).toEqual([expect.objectContaining({ id: 66 })]);

    const storedAlerts = database.db.query('SELECT id FROM alerts ORDER BY id').all() as Array<{ id: number }>;
    expect(storedAlerts).toEqual([{ id: 66 }]);
    const storedDecisions = database.db.query('SELECT origin FROM decisions ORDER BY id').all() as Array<{ origin: string }>;
    expect(storedDecisions).toEqual([{ origin: 'crowdsec' }]);

    const alertRequests = fetchCalls.filter((call) => call.url.includes('/v1/alerts?'));
    expect(alertRequests.every((call) => call.url.includes('include_capi=false'))).toBe(true);
    expect(alertRequests.some((call) => call.url.includes('origin=CAPI'))).toBe(false);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('include origins can fetch lists alerts with unscoped queries only', async () => {
    const listsAlert = sampleListsAlert();

    const { controller, database, fetchCalls } = createController({
      env: {
        CROWDSEC_ALERT_INCLUDE_ORIGINS: 'lists',
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

    const alerts = await alertsResponse.json() as Array<{ id: number; decisions: Array<{ origin?: string }> }>;
    expect(alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 51,
        decisions: expect.arrayContaining([expect.objectContaining({ origin: 'lists' })]),
      }),
    ]));

    const alertRequests = fetchCalls.filter((call) => call.url.includes('/v1/alerts?'));
    expect(alertRequests).toHaveLength(1);
    expect(alertRequests.every((call) => call.url.includes('origin=lists'))).toBe(true);
    expect(alertRequests.every((call) => !call.url.includes('scope='))).toBe(true);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('include origins keeps no-decision lists alerts using source scope fallbacks', async () => {
    const listsAlert = sampleListsAlert({
      id: 53,
      uuid: 'alert-53',
      decisions: [],
    });

    const { controller, database, fetchCalls } = createController({
      env: {
        CROWDSEC_ALERT_INCLUDE_ORIGINS: 'lists',
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
    expect(await alertsResponse.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 53 })]),
    );

    const alertRequests = fetchCalls.filter((call) => call.url.includes('/v1/alerts?'));
    expect(alertRequests).toHaveLength(1);
    expect(alertRequests.every((call) => call.url.includes('origin=lists'))).toBe(true);
    expect(alertRequests.every((call) => !call.url.includes('scope='))).toBe(true);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('include capi keeps no-decision community blocklist alerts while preserving the default feed', async () => {
    const capiAlert = sampleCapiAlert({
      id: 54,
      uuid: 'alert-54',
      decisions: [],
    });

    const { controller, database, fetchCalls } = createController({
      env: {
        CROWDSEC_ALERT_INCLUDE_CAPI: 'true',
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
        return Response.json([]);
      },
    });

    const alertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alertsResponse.status).toBe(200);
    expect(await alertsResponse.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 54, scenario: 'crowdsecurity/community-blocklist' })]),
    );

    const alertRequests = fetchCalls.filter((call) => call.url.includes('/v1/alerts?'));
    expect(alertRequests.some((call) => !call.url.includes('origin=') && call.url.includes('include_capi=false'))).toBe(true);
    expect(alertRequests.some((call) => call.url.includes('origin=CAPI') && !call.url.includes('scope='))).toBe(true);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('include no origin keeps no-origin alerts from the unfiltered query lane', async () => {
    const noOriginAlert = sampleAlert({
      id: 55,
      uuid: 'alert-55',
      decisions: [],
      message: 'Alert without decision origin',
    });

    const { controller, database, fetchCalls } = createController({
      env: {
        CROWDSEC_ALERT_INCLUDE_ORIGIN_EMPTY: 'true',
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
    expect(await alertsResponse.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 55 })]),
    );

    const alertRequests = fetchCalls.filter((call) => call.url.includes('/v1/alerts?'));
    expect(alertRequests).toHaveLength(3);
    expect(alertRequests.every((call) => call.url.includes('include_capi=false'))).toBe(true);
    expect(alertRequests.every((call) => !call.url.includes('origin='))).toBe(true);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('include no origin can be combined with explicit origin includes', async () => {
    const noOriginAlert = sampleAlert({
      id: 56,
      uuid: 'alert-56',
      decisions: [],
      message: 'No origin alert',
    });
    const crowdsecAlert = sampleAlert({
      id: 57,
      uuid: 'alert-57',
      decisions: [
        {
          id: 570,
          type: 'ban',
          value: '5.5.5.5',
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
        CROWDSEC_ALERT_INCLUDE_ORIGIN_EMPTY: 'true',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (!url.includes('/v1/alerts?')) {
          return undefined;
        }
        if (url.includes('origin=crowdsec') && url.includes('scope=ip')) {
          return Response.json([crowdsecAlert]);
        }
        if (!url.includes('origin=') && !url.includes('scope=')) {
          return Response.json([noOriginAlert]);
        }
        return Response.json([]);
      },
    });

    const alertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alertsResponse.status).toBe(200);
    expect(await alertsResponse.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 56 }),
        expect.objectContaining({ id: 57 }),
      ]),
    );

    const alertRequests = fetchCalls.filter((call) => call.url.includes('/v1/alerts?'));
    expect(alertRequests).toHaveLength(6);
    expect(alertRequests.filter((call) => !call.url.includes('origin=')).length).toBe(3);
    expect(alertRequests.filter((call) => call.url.includes('origin=crowdsec')).length).toBe(3);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

});
