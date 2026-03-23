import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import type { AlertRecord } from '../../shared/contracts';
import { createRuntimeConfig } from './config';
import { CrowdsecDatabase } from './database';
import { LapiClient } from './lapi';
import { createApp } from './app';

let tempDir: string;

function sampleAlert(overrides: Partial<AlertRecord> = {}): AlertRecord {
  const createdAt = new Date().toISOString();
  const stopAt = new Date(Date.now() + 30 * 60 * 1_000).toISOString();
  return {
    id: 1,
    uuid: 'alert-1',
    created_at: createdAt,
    scenario: 'crowdsecurity/ssh-bf',
    message: 'Blocked ssh bruteforce',
    source: {
      ip: '1.2.3.4',
      value: '1.2.3.4',
      cn: 'DE',
      as_name: 'Hetzner',
    },
    target: 'ssh',
    events: [{ meta: [{ key: 'service', value: 'ssh' }] }],
    decisions: [
      {
        id: 10,
        type: 'ban',
        value: '1.2.3.4',
        duration: '30m',
        stop_at: stopAt,
        origin: 'manual',
        simulated: false,
      },
    ],
    simulated: false,
    ...overrides,
  };
}

function sampleSimulatedAlert(): AlertRecord {
  const createdAt = new Date().toISOString();
  const stopAt = new Date(Date.now() + 45 * 60 * 1_000).toISOString();
  return {
    id: 2,
    uuid: 'alert-2',
    created_at: createdAt,
    scenario: 'crowdsecurity/nginx-bf',
    message: 'Simulated nginx bruteforce',
    source: {
      ip: '5.6.7.8',
      value: '5.6.7.8',
      cn: 'US',
      as_name: 'AWS',
    },
    target: 'nginx',
    events: [{ meta: [{ key: 'service', value: 'nginx' }] }],
    decisions: [
      {
        id: 20,
        type: 'ban',
        value: '5.6.7.8',
        duration: '45m',
        stop_at: stopAt,
        origin: 'crowdsec',
        simulated: true,
      },
    ],
    simulated: true,
  };
}

function sampleImplicitSimulatedAlert(): AlertRecord {
  const createdAt = new Date().toISOString();
  const stopAt = new Date(Date.now() + 45 * 60 * 1_000).toISOString();
  return {
    id: 5,
    uuid: 'alert-5',
    created_at: createdAt,
    scenario: 'crowdsecurity/http-probing',
    message: 'Implicitly simulated http probing alert',
    source: {
      ip: '93.238.58.10',
      value: '93.238.58.10',
      cn: 'DE',
      as_name: 'Deutsche Telekom AG',
    },
    target: 'http',
    events: [{ meta: [{ key: 'service', value: 'http' }] }],
    decisions: [
      {
        id: 50,
        type: '(simul)ban',
        value: '93.238.58.10',
        duration: '45m',
        stop_at: stopAt,
        origin: 'crowdsec',
        scenario: 'crowdsecurity/http-probing',
      },
    ],
  };
}

function sampleManualWebUiAlert(overrides: Partial<AlertRecord> = {}): AlertRecord {
  const createdAt = new Date().toISOString();
  const stopAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
  return {
    id: 3,
    uuid: 'alert-3',
    created_at: createdAt,
    scenario: 'manual/web-ui',
    message: 'Manual decision from Web UI',
    source: {
      ip: '9.9.9.9',
      value: '9.9.9.9',
      cn: 'FR',
      as_name: 'OVH',
    },
    target: 'manual',
    events: [],
    decisions: [
      {
        id: 30,
        type: 'ban',
        value: '9.9.9.9',
        duration: '1h',
        stop_at: stopAt,
        origin: 'cscli',
        scenario: 'manual/web-ui',
        simulated: false,
      },
    ],
    simulated: false,
    ...overrides,
  };
}

function sampleBlocklistImportAlert(overrides: Partial<AlertRecord> = {}): AlertRecord {
  const createdAt = new Date().toISOString();
  const stopAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
  return {
    id: 4,
    uuid: 'alert-4',
    created_at: createdAt,
    scenario: 'crowdsec-blocklist-import/external_blocklist',
    message: 'External blocklist import batch 1',
    source: {
      ip: '127.0.0.1',
      value: '127.0.0.1',
      cn: 'Unknown',
      as_name: 'Unknown',
    },
    target: 'blocklist',
    events: [],
    decisions: [
      {
        id: 40,
        type: 'ban',
        value: '8.8.8.8',
        duration: '24h',
        stop_at: stopAt,
        origin: 'cscli',
        scenario: 'crowdsec-blocklist-import/external_blocklist',
        simulated: false,
      },
    ],
    simulated: false,
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-app-'));
});

function destroyTempDir(): void {
  rmSync(tempDir, { recursive: true, force: true });
}

function createTestDistRoot(): string {
  const distRoot = path.join(tempDir, 'dist');
  mkdirSync(path.join(distRoot, 'assets'), { recursive: true });
  writeFileSync(path.join(distRoot, 'index.html'), '<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  writeFileSync(path.join(distRoot, 'world-50m.json'), '{"type":"Topology"}');
  writeFileSync(path.join(distRoot, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  return distRoot;
}

function createController(options: {
  alertDetailPayload?: unknown;
  simulationsEnabled?: boolean;
  env?: Record<string, string>;
  fetchResolver?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
} = {}) {
  const config = createRuntimeConfig({
    PORT: '3000',
    BASE_PATH: '/crowdsec',
    CROWDSEC_URL: 'http://crowdsec:8080',
    CROWDSEC_USER: 'watcher',
    CROWDSEC_PASSWORD: 'secret',
    CROWDSEC_SIMULATIONS_ENABLED: options.simulationsEnabled === false ? 'false' : 'true',
    CROWDSEC_LOOKBACK_PERIOD: '1m',
    CROWDSEC_REFRESH_INTERVAL: '30s',
    VITE_VERSION: '1.0.0',
    VITE_BRANCH: 'main',
    VITE_COMMIT_HASH: 'abc123',
    DB_DIR: tempDir,
    ...options.env,
  });

  const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
  const fetchCalls: Array<{ url: string; method: string }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    fetchCalls.push({ url, method: init?.method || 'GET' });
    const resolved = await options.fetchResolver?.(url, init);
    if (resolved) {
      return resolved;
    }
    if (url.endsWith('/v1/watchers/login')) {
      return Response.json({ code: 200, token: 'token' });
    }
    if (url.includes('/v1/alerts?')) {
      return Response.json([]);
    }
    if (url.endsWith('/v1/alerts/1') && (!init?.method || init.method === 'GET')) {
      return Response.json(options.alertDetailPayload ?? sampleAlert());
    }
    if (url.endsWith('/v1/alerts/2') && (!init?.method || init.method === 'GET')) {
      return Response.json(sampleSimulatedAlert());
    }
    if (url.endsWith('/v1/alerts/1') && init?.method === 'DELETE') {
      return Response.json({ message: 'Deleted' });
    }
    if (url.endsWith('/v1/decisions/10') && init?.method === 'DELETE') {
      return Response.json({ message: 'Deleted' });
    }
    if (url.endsWith('/v1/alerts') && init?.method === 'POST') {
      return Response.json({ ok: true });
    }
    return Response.json({});
  };

  const lapiClient = new LapiClient({
    crowdsecUrl: config.crowdsecUrl,
    user: config.crowdsecUser,
    password: config.crowdsecPassword,
    simulationsEnabled: config.simulationsEnabled,
    lookbackPeriod: config.lookbackPeriod,
    version: config.version,
    fetchImpl,
  });

  const controller = createApp({
    config,
    database,
    lapiClient,
    distRoot: createTestDistRoot(),
    updateChecker: async () => ({ update_available: true, remote_version: '2.0.0' }),
  });

  return { controller, database, lapiClient, fetchCalls };
}

describe('createApp', () => {
  test('serves health, config, alerts, decisions, stats, update-check, and mutations', async () => {
    const { controller, database, lapiClient } = createController();
    const alert = sampleAlert();
    const simulatedAlert = sampleSimulatedAlert();

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
    expect(((await configResponse.json()) as { lookback_period: string; simulations_enabled: boolean })).toEqual(
      expect.objectContaining({ lookback_period: '1m', simulations_enabled: true }),
    );

    const alerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alerts.status).toBe(200);
    expect(((await alerts.json()) as Array<{ simulated?: boolean }>)).toEqual(
      expect.arrayContaining([expect.objectContaining({ simulated: true })]),
    );

    const alertDetails = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/1'));
    expect(alertDetails.status).toBe(200);
    expect(((await alertDetails.json()) as { id: number; simulated?: boolean }).id).toBe(1);

    const decisions = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions'));
    expect(decisions.status).toBe(200);
    expect(((await decisions.json()) as Array<{ simulated?: boolean }>)).toEqual(
      expect.arrayContaining([expect.objectContaining({ simulated: true })]),
    );

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
    expect((await worldMap.text()).startsWith('{"type"')).toBe(true);

    const logo = await controller.fetch(new Request('http://localhost/crowdsec/logo.svg'));
    expect(logo.status).toBe(200);
    expect((await logo.text()).includes('<svg')).toBe(true);

    const redirect = await controller.fetch(new Request('http://localhost/'));
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('/crowdsec/');

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('validates bad ids and malformed input', async () => {
    const { controller, database, lapiClient } = createController();
    await lapiClient.login();

    const badAlertId = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/not-a-number'));
    expect(badAlertId.status).toBe(400);

    const badDecisionId = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions/not-a-number', { method: 'DELETE' }));
    expect(badDecisionId.status).toBe(400);

    const badInterval = await controller.fetch(
      new Request('http://localhost/crowdsec/api/config/refresh-interval', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interval: '9m' }),
      }),
    );
    expect(badInterval.status).toBe(400);

    const badDecision = await controller.fetch(
      new Request('http://localhost/crowdsec/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: 'bad-ip' }),
      }),
    );
    expect(badDecision.status).toBe(400);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
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
    const { controller, database, lapiClient } = createController({ simulationsEnabled: false });
    const liveAlert = sampleAlert();
    const simulatedAlert = sampleSimulatedAlert();

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

  test('uses unfiltered alert queries by default during bootstrap', async () => {
    const crowdsecAlert = sampleAlert();
    const manualAlert = sampleManualWebUiAlert();
    const { controller, database, fetchCalls } = createController({
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (url.includes('/v1/alerts?') && url.includes('has_active_decision=true')) {
          return Response.json([crowdsecAlert]);
        }
        if (url.includes('/v1/alerts?')) {
          return Response.json([crowdsecAlert, manualAlert]);
        }
        return undefined;
      },
    });

    const alerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alerts.status).toBe(200);

    const alertRequests = fetchCalls.filter((call) => call.url.includes('/v1/alerts?'));
    expect(alertRequests).toHaveLength(2);
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
    expect(alertRequests.some((call) => call.url.includes('origin=crowdsec'))).toBe(true);
    expect(alertRequests.some((call) => call.url.includes('scenario=manual%2Fweb-ui'))).toBe(true);
    expect(alertRequests.every((call) => call.url.includes('origin=') || call.url.includes('scenario='))).toBe(true);

    const alertCount = (database.db.query('SELECT COUNT(*) AS count FROM alerts').get() as { count: number }).count;
    const decisionCount = (database.db.query('SELECT COUNT(*) AS count FROM decisions').get() as { count: number }).count;
    expect(alertCount).toBe(3);
    expect(decisionCount).toBe(3);
    expect(controller.getSyncStatus().message).toContain('3 alerts imported');

    const storedAlerts = database.db.query('SELECT raw_data FROM alerts').all() as Array<{ raw_data: string }>;
    expect(
      storedAlerts.some((row) => String((JSON.parse(row.raw_data) as AlertRecord).scenario) === 'crowdsec-blocklist-import/external_blocklist'),
    ).toBe(false);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });
});
