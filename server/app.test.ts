import { beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import type { AlertRecord } from '../shared/contracts';
import { resolveMachineName } from '../shared/machine';
import { createRuntimeConfig } from './config';
import { CrowdsecDatabase } from './database';
import { LapiClient, type LapiRequestInit } from './lapi';
import { createApp } from './app';
import type { MqttPublishConfig } from './notifications/mqtt-client';

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

function sampleCapiAlert(overrides: Partial<AlertRecord> = {}): AlertRecord {
  const createdAt = new Date().toISOString();
  const stopAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
  return {
    id: 5,
    uuid: 'alert-5',
    created_at: createdAt,
    kind: 'capi',
    scenario: 'update : +15000/-0 IPs',
    message: '',
    source: {
      ip: '8.8.8.8',
      value: '8.8.8.8',
      cn: 'US',
      as_name: 'Google',
      scope: 'crowdsecurity/community-blocklist',
    },
    target: 'blocklist',
    events: [],
    decisions: [
      {
        id: 50,
        type: 'ban',
        value: '8.8.8.8',
        duration: '24h',
        stop_at: stopAt,
        origin: 'CAPI',
        scenario: 'http:scan',
        simulated: false,
      },
    ],
    simulated: false,
    ...overrides,
  };
}

function sampleListsAlert(overrides: Partial<AlertRecord> = {}): AlertRecord {
  const createdAt = new Date().toISOString();
  const stopAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
  return {
    id: 51,
    uuid: 'alert-51',
    created_at: createdAt,
    scenario: 'lists:firehol_voipbl',
    message: '',
    source: {
      ip: '4.4.4.4',
      value: '4.4.4.4',
      cn: 'US',
      as_name: 'Example ISP',
      scope: 'lists:firehol_voipbl',
    },
    target: 'blocklist',
    events: [],
    decisions: [
      {
        id: 510,
        type: 'ban',
        value: '4.4.4.4',
        duration: '24h',
        stop_at: stopAt,
        origin: 'lists',
        scenario: 'firehol_voipbl',
        simulated: false,
      },
    ],
    simulated: false,
    ...overrides,
  };
}

function sampleAppSecAlert(overrides: Partial<AlertRecord> = {}): AlertRecord {
  const createdAt = new Date().toISOString();
  const stopAt = new Date(Date.now() + 3 * 60 * 60 * 1_000).toISOString();
  return {
    id: 6,
    uuid: 'alert-6',
    created_at: createdAt,
    scenario: 'crowdsecurity/appsec-vpatch',
    message: 'WAF block: crowdsecurity/vpatch-git-config from 159.65.167.144',
    source: {
      ip: '159.65.167.144',
      value: '159.65.167.144',
      cn: 'US',
      as_name: 'DigitalOcean',
      scope: 'Ip',
    },
    target: 'tausend.me',
    events: [
      {
        timestamp: createdAt,
        meta: [
          { key: 'rule_name', value: 'crowdsecurity/vpatch-git-config' },
          { key: 'matched_zones', value: 'REQUEST_FILENAME' },
          { key: 'service', value: 'appsec' },
          { key: 'target_host', value: 'tausend.me' },
          { key: 'target_uri', value: '/.git/config' },
        ],
      },
    ],
    decisions: [
      {
        id: 60,
        type: 'ban',
        value: '159.65.167.144',
        duration: '3h',
        stop_at: stopAt,
        origin: 'crowdsec',
        scenario: 'crowdsecurity/appsec-vpatch',
        simulated: false,
      },
    ],
    simulated: false,
    ...overrides,
  };
}

function sampleRangeAlert(overrides: Partial<AlertRecord> = {}): AlertRecord {
  const createdAt = new Date().toISOString();
  const stopAt = new Date(Date.now() + 30 * 60 * 1_000).toISOString();
  return {
    id: 14302,
    uuid: 'alert-14302',
    created_at: createdAt,
    scenario: 'manual/web-ui',
    message: "manual 'ban' from 'localhost'",
    source: {
      range: '192.168.5.0/24',
      scope: 'Range',
      cn: 'Unknown',
      as_name: 'Unknown',
    },
    target: 'manual',
    events: [],
    decisions: [
      {
        id: 14302,
        type: 'ban',
        duration: '30m',
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
  authMode?: 'password' | 'mtls' | 'none';
  env?: Record<string, string>;
  fetchResolver?: (url: string, init?: LapiRequestInit) => Response | Promise<Response> | undefined;
  notificationFetchResolver?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
  mqttPublishResolver?: (config: MqttPublishConfig, payload: string) => void | Promise<void>;
} = {}) {
  const authMode = options.authMode || 'password';
  const mtlsCertPath = path.join(tempDir, 'agent.pem');
  const mtlsKeyPath = path.join(tempDir, 'agent-key.pem');
  const mtlsCaPath = path.join(tempDir, 'ca.pem');
  const authEnv = authMode === 'password'
    ? {
        CROWDSEC_USER: 'watcher',
        CROWDSEC_PASSWORD: 'secret',
      }
    : authMode === 'mtls'
      ? {
          CROWDSEC_TLS_CERT_PATH: mtlsCertPath,
          CROWDSEC_TLS_KEY_PATH: mtlsKeyPath,
          CROWDSEC_TLS_CA_CERT_PATH: mtlsCaPath,
        }
      : {};

  if (authMode === 'mtls') {
    writeFileSync(mtlsCertPath, 'test-cert');
    writeFileSync(mtlsKeyPath, 'test-key');
    writeFileSync(mtlsCaPath, 'test-ca');
  }

  const config = createRuntimeConfig({
    PORT: '3000',
    BASE_PATH: '/crowdsec',
    CROWDSEC_URL: 'http://crowdsec:8080',
    CROWDSEC_SIMULATIONS_ENABLED: options.simulationsEnabled === false ? 'false' : 'true',
    CROWDSEC_ALWAYS_SHOW_MACHINE: 'false',
    CROWDSEC_LOOKBACK_PERIOD: '1m',
    CROWDSEC_REFRESH_INTERVAL: '30s',
    VITE_VERSION: '1.0.0',
    VITE_BRANCH: 'main',
    VITE_COMMIT_HASH: 'abc123',
    DB_DIR: tempDir,
    NOTIFICATION_ALLOW_PRIVATE_ADDRESSES: 'true',
    ...authEnv,
    ...options.env,
  });

  const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
  const fetchCalls: Array<{ url: string; method: string; body?: unknown; headers?: RequestInit['headers']; dispatcher?: unknown }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: LapiRequestInit): Promise<Response> => {
    const requestInit = init;
    const url = String(input);
    fetchCalls.push({
      url,
      method: requestInit?.method || 'GET',
      body: requestInit?.body ? JSON.parse(String(requestInit.body)) : undefined,
      headers: requestInit?.headers,
      dispatcher: requestInit?.dispatcher,
    });
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
    if (/\/v1\/alerts\/\d+$/.test(url) && init?.method === 'DELETE') {
      return Response.json({ message: 'Deleted' });
    }
    if (/\/v1\/decisions\/\d+$/.test(url) && init?.method === 'DELETE') {
      return Response.json({ message: 'Deleted' });
    }
    if (url.endsWith('/v1/alerts') && init?.method === 'POST') {
      return Response.json({ ok: true });
    }
    return Response.json({});
  };

  const lapiClient = new LapiClient({
    crowdsecUrl: config.crowdsecUrl,
    auth: config.crowdsecAuth,
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
    notificationFetchImpl: async (input, init) => {
      const url = String(input);
      const resolved = await options.notificationFetchResolver?.(url, init);
      if (resolved) {
        return resolved;
      }
      return Response.json({});
    },
    mqttPublishImpl: async (config, payload) => {
      await options.mqttPublishResolver?.(config, payload);
    },
  });

  return { controller, database, lapiClient, fetchCalls };
}

function seedAlert(database: CrowdsecDatabase, alert: AlertRecord): void {
  database.insertAlert({
    $id: alert.id,
    $uuid: alert.uuid || String(alert.id),
    $created_at: alert.created_at,
    $scenario: alert.scenario,
    $source_ip: alert.source?.ip || alert.source?.value || alert.source?.range || '',
    $message: alert.message || '',
    $raw_data: JSON.stringify(alert),
  });

  for (const decision of alert.decisions || []) {
    const createdAt = decision.created_at || alert.created_at;
    const stopAt = decision.stop_at || new Date(Date.now() + 30 * 60 * 1_000).toISOString();
    database.insertDecision({
      $id: String(decision.id),
      $uuid: String(decision.id),
      $alert_id: alert.id,
      $created_at: createdAt,
      $stop_at: stopAt,
      $value: decision.value || alert.source?.ip || alert.source?.value || alert.source?.range || '',
      $type: decision.type,
      $origin: decision.origin,
      $scenario: decision.scenario || alert.scenario,
      $raw_data: JSON.stringify({
        id: decision.id,
        created_at: createdAt,
        scenario: decision.scenario || alert.scenario,
        value: decision.value || alert.source?.ip || alert.source?.value || alert.source?.range || '',
        stop_at: stopAt,
        type: decision.type || 'ban',
        origin: decision.origin || 'manual',
        country: alert.source?.cn,
        as: alert.source?.as_name,
        machine: resolveMachineName(alert),
        target: alert.target,
        alert_id: alert.id,
        simulated: decision.simulated === true,
      }),
    });
  }
}

function dashboardDateKey(isoString: string, timezoneOffsetMinutes: number, includeHour = false): string {
  const source = new Date(isoString);
  const localDate = new Date(source.getTime() - timezoneOffsetMinutes * 60_000);
  const year = localDate.getUTCFullYear();
  const month = String(localDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(localDate.getUTCDate()).padStart(2, '0');
  if (includeHour) {
    return `${year}-${month}-${day}T${String(localDate.getUTCHours()).padStart(2, '0')}`;
  }
  return `${year}-${month}-${day}`;
}

describe('createApp', () => {
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
    })).toEqual(
      expect.objectContaining({
        lookback_period: '1m',
        simulations_enabled: true,
        machine_features_enabled: false,
        origin_features_enabled: true,
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
    }).toEqual(
      expect.objectContaining({
        totals: { alerts: 2, decisions: 1, simulatedAlerts: 1, simulatedDecisions: 1 },
        filteredTotals: { alerts: 2, decisions: 1, simulatedAlerts: 1, simulatedDecisions: 1 },
        series: expect.objectContaining({
          simulatedAlertsHistory: expect.arrayContaining([expect.objectContaining({ count: 1 })]),
        }),
        allCountries: expect.arrayContaining([expect.objectContaining({ countryCode: 'US', simulatedCount: 1 })]),
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
        source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
        target: 'ssh',
        decisions: [{ id: 1010, value: '1.2.3.4', stop_at: stopAt, type: 'ban', origin: 'manual', simulated: false }],
        simulated: false,
      }),
      sampleAlert({
        id: 102,
        uuid: 'dashboard-alert-102',
        created_at: createdAt,
        scenario: 'crowdsecurity/http-probing',
        source: { ip: '9.9.9.9', value: '9.9.9.9', cn: 'DE', as_name: 'OVH' },
        target: 'http',
        decisions: [{ id: 1020, value: '9.9.9.9', stop_at: stopAt, type: 'ban', origin: 'manual', simulated: false }],
        simulated: false,
      }),
      sampleAlert({
        id: 103,
        uuid: 'dashboard-alert-103',
        created_at: createdAt,
        scenario: 'crowdsecurity/nginx-bf',
        source: { ip: '5.6.7.8', value: '5.6.7.8', cn: 'US', as_name: 'AWS' },
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
    }).toEqual(expect.objectContaining({
      filteredTotals: { alerts: 2, decisions: 2, simulatedAlerts: 0, simulatedDecisions: 0 },
      topCountries: [expect.objectContaining({ countryCode: 'DE', count: 2 })],
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

  test('reports machine features enabled immediately when always-show override is configured', async () => {
    const { controller } = createController({
      env: {
        CROWDSEC_ALWAYS_SHOW_MACHINE: 'true',
      },
    });

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { machine_features_enabled: boolean }).machine_features_enabled).toBe(true);
  });

  test('reports origin features enabled immediately when always-show override is configured', async () => {
    const { controller, database } = createController({
      env: {
        CROWDSEC_ALWAYS_SHOW_ORIGIN: 'true',
      },
    });

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { origin_features_enabled: boolean }).origin_features_enabled).toBe(true);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('enables machine features after multiple machine ids are observed and includes machine in decision payloads', async () => {
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

    const configResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
    expect(((await configResponse.json()) as { machine_features_enabled: boolean }).machine_features_enabled).toBe(true);

    const decisionsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions'));
    expect(decisionsResponse.status).toBe(200);
    expect((await decisionsResponse.json()) as Array<{ id: number; machine?: string }>).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 1010, machine: 'host-a' }),
        expect.objectContaining({ id: 1020, machine: 'machine-2' }),
      ]),
    );
  });

  test('keeps machine features disabled when only cached alerts use one machine id', async () => {
    const cachedAlert = sampleAlert({
      id: 1,
      uuid: 'alert-1',
      machine_id: 'machine-1',
      machine_alias: 'localhost',
      decisions: [
        {
          id: 10,
          type: 'ban',
          value: '1.2.3.4',
          duration: '30m',
          origin: 'manual',
          simulated: false,
        },
      ],
    });

    const { controller, database } = createController({
      alertDetailPayload: sampleAlert({
        id: 1,
        uuid: 'alert-1',
        machine_id: 'machine-2',
      }),
    });

    seedAlert(database, cachedAlert);

    const detailResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/1'));
    expect(detailResponse.status).toBe(200);

    const configResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
    expect(((await configResponse.json()) as { machine_features_enabled: boolean }).machine_features_enabled).toBe(false);
  });

  test('enables origin features after multiple decision origins are observed', async () => {
    const { controller, database } = createController();

    seedAlert(database, sampleAlert({
      id: 1,
      uuid: 'alert-1',
      decisions: [{ id: 10, value: '1.2.3.4', stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(), type: 'ban', origin: 'manual', simulated: false }],
    }));
    seedAlert(database, sampleAlert({
      id: 2,
      uuid: 'alert-2',
      source: { ip: '5.6.7.8', value: '5.6.7.8', cn: 'US', as_name: 'AWS' },
      decisions: [{ id: 20, value: '5.6.7.8', stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(), type: 'ban', origin: 'CAPI', simulated: false }],
    }));

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { origin_features_enabled: boolean }).origin_features_enabled).toBe(true);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('keeps origin features disabled when only one cached decision origin exists', async () => {
    const { controller, database } = createController();

    seedAlert(database, sampleAlert({
      id: 1,
      uuid: 'alert-1',
      decisions: [{ id: 10, value: '1.2.3.4', stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(), type: 'ban', origin: 'manual', simulated: false }],
    }));

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { origin_features_enabled: boolean }).origin_features_enabled).toBe(false);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('matches alert search queries against decision origins', async () => {
    const searchAlerts = [
      sampleAlert({
      id: 1,
      uuid: 'alert-1',
      decisions: [
        { id: 10, value: '1.2.3.4', stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(), type: 'ban', origin: 'manual', simulated: false },
        { id: 11, value: '1.2.3.4', stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(), type: 'ban', origin: 'CAPI', simulated: false },
      ],
      }),
      sampleAlert({
      id: 2,
      uuid: 'alert-2',
      source: { ip: '5.6.7.8', value: '5.6.7.8', cn: 'US', as_name: 'AWS' },
      decisions: [{ id: 20, value: '5.6.7.8', stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(), type: 'ban', origin: 'crowdsec', simulated: false }],
      }),
    ];
    const { controller, database } = createController({
      fetchResolver: (url) => {
        if (url.includes('/v1/alerts?')) {
          return Response.json(searchAlerts);
        }
        return undefined;
      },
    });

    for (const alert of searchAlerts) {
      seedAlert(database, alert);
    }

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=10&q=capi'));
    expect(response.status).toBe(200);
    expect((await response.json()) as { data: Array<{ id: number }>; pagination: { total: number } }).toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ id: 1 })],
        pagination: expect.objectContaining({ total: 1 }),
      }),
    );

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('matches decision search queries against machine and origin', async () => {
    const searchAlerts = [
      sampleAlert({
        id: 1,
        uuid: 'alert-1',
        machine_id: 'machine-1',
        machine_alias: 'host-a',
        decisions: [{ id: 10, value: '1.2.3.4', stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(), type: 'ban', origin: 'manual', simulated: false }],
      }),
      sampleAlert({
        id: 2,
        uuid: 'alert-2',
        source: { ip: '5.6.7.8', value: '5.6.7.8', cn: 'US', as_name: 'AWS' },
        decisions: [{ id: 20, value: '5.6.7.8', stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(), type: 'ban', origin: 'crowdsec', simulated: false }],
      }),
    ];
    const { controller, database } = createController({
      env: {
        CROWDSEC_ALWAYS_SHOW_MACHINE: 'true',
      },
      fetchResolver: (url) => {
        if (url.includes('/v1/alerts?')) {
          return Response.json(searchAlerts);
        }
        return undefined;
      },
    });

    for (const alert of searchAlerts) {
      seedAlert(database, alert);
    }

    const machineResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions?page=1&page_size=10&q=host-a'));
    expect(machineResponse.status).toBe(200);
    expect((await machineResponse.json()) as { data: Array<{ id: number }>; pagination: { total: number } }).toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ id: 10 })],
        pagination: expect.objectContaining({ total: 1 }),
      }),
    );

    const originResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions?page=1&page_size=10&q=manual'));
    expect(originResponse.status).toBe(200);
    expect((await originResponse.json()) as { data: Array<{ id: number }>; pagination: { total: number } }).toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ id: 10 })],
        pagination: expect.objectContaining({ total: 1 }),
      }),
    );

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('supports advanced boolean search for alerts and decisions', async () => {
    const searchAlerts = [
      sampleAlert({
        id: 1,
        uuid: 'alert-1',
        machine_id: 'machine-1',
        machine_alias: 'host-a',
        source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
        decisions: [
          { id: 10, value: '1.2.3.4', stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(), type: 'ban', origin: 'manual', simulated: false },
          { id: 11, value: '1.2.3.4', stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(), type: 'ban', origin: 'CAPI', simulated: false },
        ],
      }),
      sampleAlert({
        id: 2,
        uuid: 'alert-2',
        machine_id: 'machine-2',
        machine_alias: 'host-b',
        source: { ip: '5.6.7.8', value: '5.6.7.8', cn: 'US', as_name: 'AWS' },
        decisions: [{ id: 20, value: '5.6.7.8', stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(), type: 'ban', origin: 'crowdsec', simulated: true }],
        simulated: true,
      }),
    ];
    const { controller, database } = createController({
      env: {
        CROWDSEC_ALWAYS_SHOW_MACHINE: 'true',
        CROWDSEC_ALWAYS_SHOW_ORIGIN: 'true',
      },
      fetchResolver: (url) => {
        if (url.includes('/v1/alerts?')) {
          return Response.json(searchAlerts);
        }
        return undefined;
      },
    });

    for (const alert of searchAlerts) {
      seedAlert(database, alert);
    }

    const alertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=10&q=origin:(manual%20OR%20CAPI)%20AND%20-country:us'));
    expect(alertsResponse.status).toBe(200);
    expect((await alertsResponse.json()) as { data: Array<{ id: number }>; pagination: { total: number } }).toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ id: 1 })],
        pagination: expect.objectContaining({ total: 1 }),
      }),
    );

    const decisionsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions?page=1&page_size=10&q=status:active%20AND%20alert:1%20AND%20duplicate:false'));
    expect(decisionsResponse.status).toBe(200);
    expect((await decisionsResponse.json()) as { data: Array<{ id: number }>; pagination: { total: number } }).toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ id: 10 })],
        pagination: expect.objectContaining({ total: 1 }),
      }),
    );

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('returns a 400 for invalid advanced search queries', async () => {
    const { controller, database } = createController({
      env: {
        CROWDSEC_ALWAYS_SHOW_ORIGIN: 'true',
      },
    });

    seedAlert(database, sampleAlert({
      id: 1,
      uuid: 'alert-1',
      decisions: [{ id: 10, value: '1.2.3.4', stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(), type: 'ban', origin: 'manual', simulated: false }],
    }));

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions?page=1&page_size=10&q=origin:(manual%20OR'));
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string; details: { position: number } }).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('Missing closing parenthesis'),
        details: expect.objectContaining({
          position: expect.any(Number),
        }),
      }),
    );

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

    const badBulkAlerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['oops'] }),
    }));
    expect(badBulkAlerts.status).toBe(400);

    const badBulkDecisions = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['oops'] }),
    }));
    expect(badBulkDecisions.status).toBe(400);

    const badCleanupIp = await controller.fetch(new Request('http://localhost/crowdsec/api/cleanup/by-ip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: 'bad-ip' }),
    }));
    expect(badCleanupIp.status).toBe(400);

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

  test('bulk alert delete removes alerts and cascaded decisions from the cache', async () => {
    const { controller, database, lapiClient } = createController();
    seedAlert(database, sampleAlert());
    seedAlert(database, sampleManualWebUiAlert());
    await lapiClient.login();

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1, 3] }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      requested_alerts: 2,
      deleted_alerts: 2,
      deleted_decisions: 2,
      failed: [],
    }));
    expect(database.countAlerts()).toBe(0);
    expect(database.getActiveDecisions(new Date().toISOString())).toHaveLength(0);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('bulk decision delete removes only the selected decisions', async () => {
    const { controller, database, lapiClient } = createController();
    seedAlert(database, sampleAlert());
    seedAlert(database, sampleSimulatedAlert());
    await lapiClient.login();

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [10] }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      requested_decisions: 1,
      deleted_alerts: 0,
      deleted_decisions: 1,
      failed: [],
    }));
    expect(database.getDecisionById('10')).toBeNull();
    expect(database.getDecisionById('20')).not.toBeNull();
    expect(database.countAlerts()).toBe(2);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('cleanup by IP removes matching alerts and standalone decisions across resources', async () => {
    const { controller, database, lapiClient } = createController();
    seedAlert(database, sampleAlert());
    seedAlert(database, sampleSimulatedAlert());
    database.insertDecision({
      $id: '90',
      $uuid: '90',
      $alert_id: 999,
      $created_at: '2026-03-23T12:00:00.000Z',
      $stop_at: '2030-01-01T00:00:00.000Z',
      $value: '1.2.3.4',
      $type: 'ban',
      $origin: 'manual',
      $scenario: 'manual/web-ui',
      $raw_data: JSON.stringify({
        id: 90,
        created_at: '2026-03-23T12:00:00.000Z',
        scenario: 'manual/web-ui',
        value: '1.2.3.4',
        stop_at: '2030-01-01T00:00:00.000Z',
        type: 'ban',
        origin: 'manual',
        country: 'DE',
        as: 'Hetzner',
        target: 'ssh',
        alert_id: 999,
        simulated: false,
      }),
    });
    await lapiClient.login();

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/cleanup/by-ip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: '1.2.3.4' }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      ip: '1.2.3.4',
      requested_alerts: 1,
      requested_decisions: 2,
      deleted_alerts: 1,
      deleted_decisions: 2,
      failed: [],
    }));
    expect(database.countAlerts()).toBe(1);
    expect(database.getDecisionById('10')).toBeNull();
    expect(database.getDecisionById('90')).toBeNull();
    expect(database.getDecisionById('20')).not.toBeNull();

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('bulk delete reports partial failures and only prunes successful items from the cache', async () => {
    const { controller, database, lapiClient } = createController({
      fetchResolver: (url, init) => {
        if (url.endsWith('/v1/alerts/2') && init?.method === 'DELETE') {
          return Response.json({ error: 'boom' }, { status: 500 });
        }
        return undefined;
      },
    });
    seedAlert(database, sampleAlert());
    seedAlert(database, sampleSimulatedAlert());
    await lapiClient.login();

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1, 2] }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      requested_alerts: 2,
      deleted_alerts: 1,
      deleted_decisions: 1,
      failed: [expect.objectContaining({ kind: 'alert', id: '2' })],
    }));
    expect(database.countAlerts()).toBe(1);
    expect(database.getDecisionById('10')).toBeNull();
    expect(database.getDecisionById('20')).not.toBeNull();

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('bootstraps successfully with mTLS authentication', async () => {
    const { controller, database, fetchCalls } = createController({ authMode: 'mtls' });

    const alerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alerts.status).toBe(200);

    const loginRequest = fetchCalls.find((call) => call.url.endsWith('/v1/watchers/login'));
    expect(loginRequest).toBeDefined();
    expect(loginRequest?.body).toEqual({ scenarios: ['manual/web-ui'] });
    expect(loginRequest?.dispatcher).toBeTruthy();

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('logs decision counts during bootstrap sync', async () => {
    const stopAt = new Date(Date.now() + 30 * 60 * 1_000).toISOString();
    const alert = sampleAlert({
      id: 71,
      uuid: 'alert-71',
      decisions: [
        {
          id: 710,
          type: 'ban',
          value: '1.2.3.4',
          duration: '30m',
          stop_at: stopAt,
          origin: 'manual',
          simulated: false,
        },
        {
          id: 711,
          type: 'ban',
          value: '1.2.3.5',
          duration: '30m',
          stop_at: stopAt,
          origin: 'manual',
          simulated: false,
        },
      ],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { controller, database } = createController({
      fetchResolver: (url) => {
        if (url.includes('/v1/alerts?')) {
          return Response.json([alert]);
        }
        return undefined;
      },
    });

    try {
      const alerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
      expect(alerts.status).toBe(200);

      const logs = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logs).toContain('Imported 1 alerts and 2 decisions.');
      expect(logs).toContain(
        `Cache initialized successfully:
  Historical: 1 alerts and 2 decisions fetched
  Active decisions: checked 1 alerts and 2 decisions; no cache changes
  Cache: 1 alerts and 2 decisions
  Refresh Interval: 30s
`,
      );
      expect(logs).not.toContain('Historical chunk sync complete');
      expect(logs).not.toContain('-> Synced 1 active-decision alerts');
    } finally {
      logSpy.mockRestore();
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('fails fast on mixed password and mTLS configuration', () => {
    expect(() => createController({
      env: {
        CROWDSEC_TLS_CERT_PATH: '/certs/agent.pem',
        CROWDSEC_TLS_KEY_PATH: '/certs/agent-key.pem',
      },
    })).toThrow(/choose either CROWDSEC_USER\/CROWDSEC_PASSWORD or CROWDSEC_TLS_CERT_PATH\/CROWDSEC_TLS_KEY_PATH/i);

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

    const alertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=50'));
    expect(alertsResponse.status).toBe(200);
    const alertsJson = await alertsResponse.json() as {
      data: Array<{ id: number; decisions: Array<{ id: number; expired?: boolean }> }>;
    };
    const alertRow = alertsJson.data.find((alert) => alert.id === 200);
    expect(alertRow?.decisions.filter((decision) => decision.expired !== true)).toHaveLength(1);

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

  test('removes stale decisions during active-decision delta refresh and updates alert payloads to match', async () => {
    const createdAt = new Date().toISOString();
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
    let phase: 'initial' | 'delta' = 'initial';

    const { controller, database } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (url.includes('/v1/alerts?')) {
          if (phase === 'initial') {
            return Response.json([initialAlert]);
          }
          if (url.includes('has_active_decision=true')) {
            return Response.json([refreshedAlert]);
          }
          return Response.json([]);
        }
        return undefined;
      },
    });

    const initialAlertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=50'));
    expect(initialAlertsResponse.status).toBe(200);

    const initialDecisionsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions?page=1&page_size=50&alert_id=210&include_expired=true'));
    expect(initialDecisionsResponse.status).toBe(200);
    const initialDecisionsJson = await initialDecisionsResponse.json() as {
      data: Array<{ id: number }>;
      pagination: { total: number };
    };
    expect(initialDecisionsJson.pagination.total).toBe(2);
    expect(initialDecisionsJson.data.map((decision) => decision.id).sort()).toEqual([2101, 2102]);

    phase = 'delta';

    const refreshedAlertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=50'));
    expect(refreshedAlertsResponse.status).toBe(200);
    const refreshedAlertsJson = await refreshedAlertsResponse.json() as {
      data: Array<{ id: number; decisions: Array<{ id: number; expired?: boolean }> }>;
    };
    const refreshedAlertRow = refreshedAlertsJson.data.find((alert) => alert.id === 210);
    expect(refreshedAlertRow?.decisions.filter((decision) => decision.expired !== true).map((decision) => decision.id)).toEqual([2101]);

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
        if (url.includes('/v1/alerts?') && url.includes('has_active_decision=true')) {
          return Response.json([]);
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

  test('prunes stale cached alerts from active-decision refresh only', async () => {
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
    let phase: 'initial' | 'refresh' = 'initial';

    const { controller, database } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (url.includes('/v1/alerts?') && url.includes('has_active_decision=true')) {
          return Response.json(phase === 'initial' ? [keptAlert, deletedActiveAlert] : [keptAlert]);
        }
        if (url.includes('/v1/alerts?')) {
          return Response.json(phase === 'initial' ? [keptAlert, deletedActiveAlert] : []);
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
    expect(refreshedJson.data.map((alert) => alert.id)).toEqual([260]);
    expect(database.getDecisionById('2601')).not.toBeNull();
    expect(database.getDecisionById('2611')).toBeNull();

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('deleting an already removed LAPI alert cleans up the local cache', async () => {
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
    expect(await deleteResponse.json()).toEqual({ message: 'Deleted' });
    expect(database.getAlertsSince(new Date(Date.now() - 60_000).toISOString())).toHaveLength(0);
    expect(database.getDecisionById('2301')).toBeNull();

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('supports notification settings APIs and records fired notifications', async () => {
    const liveAlert = sampleAlert({
      id: 99,
      uuid: 'alert-99',
      created_at: new Date().toISOString(),
    });

    const { controller, database } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
        CROWDSEC_LOOKBACK_PERIOD: '168h',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (url.includes('/v1/alerts?')) {
          return Response.json([liveAlert]);
        }
        return undefined;
      },
      notificationFetchResolver: (url) => {
        if (url.includes('ntfy.sh')) {
          return Response.json({ id: 'msg' });
        }
        return undefined;
      },
    });

    const createChannel = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Main ntfy',
          type: 'ntfy',
          enabled: true,
          config: { topic: 'crowdsec-test' },
        }),
      }),
    );
    expect(createChannel.status).toBe(201);
    const channelPayload = await createChannel.json() as { id: string };

    const createRule = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'High volume',
          type: 'alert-threshold',
          enabled: true,
          severity: 'warning',
          channel_ids: [channelPayload.id],
          config: {
            window_minutes: 60,
            alert_threshold: 1,
            filters: {},
          },
        }),
      }),
    );
    expect(createRule.status).toBe(201);

    const alerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alerts.status).toBe(200);

    const notifications = await controller.fetch(new Request('http://localhost/crowdsec/api/notifications'));
    expect(notifications.status).toBe(200);
    const notificationsPayload = await notifications.json() as { unread_count: number; data: Array<{ id: string; deliveries: Array<{ status: string }> }> };
    expect(notificationsPayload.unread_count).toBe(1);
    expect(notificationsPayload.data[0]?.deliveries[0]?.status).toBe('delivered');

    const settings = await controller.fetch(new Request('http://localhost/crowdsec/api/notifications/settings'));
    expect(settings.status).toBe(200);
    expect((await settings.json()) as { channels: Array<{ name: string }>; rules: Array<{ name: string }> }).toEqual(
      expect.objectContaining({
        channels: [expect.objectContaining({ name: 'Main ntfy' })],
        rules: [expect.objectContaining({ name: 'High volume' })],
      }),
    );

    const testChannel = await controller.fetch(new Request(`http://localhost/crowdsec/api/notification-channels/${channelPayload.id}/test`, { method: 'POST' }));
    expect(testChannel.status).toBe(200);

    const markRead = await controller.fetch(new Request(`http://localhost/crowdsec/api/notifications/${notificationsPayload.data[0]?.id}/read`, { method: 'POST' }));
    expect(markRead.status).toBe(200);

    const bulkRead = await controller.fetch(new Request('http://localhost/crowdsec/api/notifications/bulk-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: notificationsPayload.data.map((notification) => notification.id) }),
    }));
    expect(bulkRead.status).toBe(200);

    const deleteRead = await controller.fetch(new Request('http://localhost/crowdsec/api/notifications/delete-read', { method: 'POST' }));
    expect(deleteRead.status).toBe(200);

    const deleteRule = await controller.fetch(new Request('http://localhost/crowdsec/api/notification-rules/not-real', { method: 'DELETE' }));
    expect(deleteRule.status).toBe(200);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('stores notification channel secrets encrypted at rest', async () => {
    const { controller, database } = createController();

    const createChannel = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'SMTP main',
          type: 'email',
          enabled: true,
          config: {
            smtpHost: 'smtp.example.com',
            smtpPort: 587,
            smtpTlsMode: 'starttls',
            smtpUser: 'ops',
            smtpPassword: 'super-secret-password',
            smtpFrom: 'ops@example.com',
            emailTo: 'team@example.com',
          },
        }),
      }),
    );
    expect(createChannel.status).toBe(201);
    const channelPayload = await createChannel.json() as { id: string; config: { smtpPassword: string } };
    expect(channelPayload.config.smtpPassword).toBe('(stored)');

    const stored = database.getNotificationChannelById(channelPayload.id);
    if (!stored?.config_json) {
      throw new Error('Expected stored notification channel config to be persisted');
    }
    expect(stored.config_json.startsWith('enc:v1:')).toBe(true);
    expect(stored.config_json.includes('super-secret-password')).toBe(false);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('auto-generates and persists the notification secret key when not configured', async () => {
    const first = createController();
    const generatedKey = first.database.getMeta('notification_secret_key')?.value;
    expect(generatedKey).toBeTruthy();

    const createChannel = await first.controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'SMTP main',
          type: 'email',
          enabled: true,
          config: {
            smtpHost: 'smtp.example.com',
            smtpPort: 587,
            smtpTlsMode: 'starttls',
            smtpUser: 'ops',
            smtpPassword: 'super-secret-password',
            smtpFrom: 'ops@example.com',
            emailTo: 'team@example.com',
          },
        }),
      }),
    );
    expect(createChannel.status).toBe(201);
    first.controller.stopBackgroundTasks();
    first.database.close();

    const second = createController();
    expect(second.database.getMeta('notification_secret_key')?.value).toBe(generatedKey);

    const settings = await second.controller.fetch(new Request('http://localhost/crowdsec/api/notifications/settings'));
    expect(settings.status).toBe(200);
    expect((await settings.json()) as { channels: Array<{ name: string; configured_secrets: string[] }> }).toEqual(
      expect.objectContaining({
        channels: [expect.objectContaining({ name: 'SMTP main', configured_secrets: ['smtpPassword'] })],
      }),
    );

    second.controller.stopBackgroundTasks();
    second.database.close();
    destroyTempDir();
  });

  test('blocks private notification destinations unless explicitly allowed', async () => {
    const { controller, database } = createController({
      env: {
        NOTIFICATION_ALLOW_PRIVATE_ADDRESSES: 'false',
      },
    });

    const createChannel = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Local webhook',
          type: 'webhook',
          enabled: true,
          config: {
            url: 'http://127.0.0.1/hooks/notify',
            method: 'POST',
            body: { mode: 'json', template: '{"ok":true}' },
            retryAttempts: 0,
          },
        }),
      }),
    );
    expect(createChannel.status).toBe(201);
    const channelPayload = database.listNotificationChannels()[0] as { id?: string };

    const testChannel = await controller.fetch(new Request(`http://localhost/crowdsec/api/notification-channels/${channelPayload.id}/test`, { method: 'POST' }));
    expect(testChannel.status).toBe(400);
    expect((await testChannel.json()) as { error: string }).toEqual({
      error: 'Webhook URL points to a restricted address (127.0.0.1)',
    });

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('allows private notification destinations when explicitly enabled', async () => {
    const { controller, database } = createController({
      env: {
        NOTIFICATION_ALLOW_PRIVATE_ADDRESSES: 'true',
      },
      notificationFetchResolver: (url) => {
        if (url.includes('127.0.0.1')) {
          return Response.json({ ok: true });
        }
        return undefined;
      },
    });

    const createChannel = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Local webhook',
          type: 'webhook',
          enabled: true,
          config: {
            url: 'http://127.0.0.1/hooks/notify',
            method: 'POST',
            body: { mode: 'json', template: '{"ok":true}' },
            retryAttempts: 0,
          },
        }),
      }),
    );
    expect(createChannel.status).toBe(201);
    const channelPayload = database.listNotificationChannels()[0] as { id?: string };

    const testChannel = await controller.fetch(new Request(`http://localhost/crowdsec/api/notification-channels/${channelPayload.id}/test`, { method: 'POST' }));
    expect(testChannel.status).toBe(200);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('does not expose remote notification response bodies to clients', async () => {
    const { controller, database } = createController({
      notificationFetchResolver: (url) => {
        if (url.includes('198.51.100.10')) {
          return new Response('internal token leaked', { status: 500 });
        }
        return undefined;
      },
    });

    const createChannel = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Webhook prod',
          type: 'webhook',
          enabled: true,
          config: {
            url: 'https://198.51.100.10/hooks/notify',
            method: 'POST',
            body: { mode: 'json', template: '{"ok":true}' },
            retryAttempts: 0,
          },
        }),
      }),
    );
    expect(createChannel.status).toBe(201);
    const channelPayload = database.listNotificationChannels()[0] as { id?: string };

    const testChannel = await controller.fetch(new Request(`http://localhost/crowdsec/api/notification-channels/${channelPayload.id}/test`, { method: 'POST' }));
    expect(testChannel.status).toBe(400);
    expect((await testChannel.json()) as { error: string }).toEqual({
      error: 'Webhook request failed with status 500',
    });

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('delivers rule notifications to MQTT destinations', async () => {
    const liveAlert = sampleAlert({
      id: 100,
      uuid: 'alert-100',
      created_at: new Date().toISOString(),
    });

    const mqttPublishes: Array<{ config: MqttPublishConfig; payload: string }> = [];
    const { controller, database } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
        CROWDSEC_LOOKBACK_PERIOD: '168h',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (url.includes('/v1/alerts?')) {
          return Response.json([liveAlert]);
        }
        return undefined;
      },
      mqttPublishResolver: (config, payload) => {
        mqttPublishes.push({ config, payload });
      },
    });

    const createChannel = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Primary MQTT',
          type: 'mqtt',
          enabled: true,
          config: {
            brokerUrl: 'mqtt://broker.example.com:1883',
            topic: 'crowdsec/notifications',
            keepaliveSeconds: 45,
            connectTimeoutMs: 5000,
            qos: 1,
            retainEvents: true,
          },
        }),
      }),
    );
    expect(createChannel.status).toBe(201);
    const channelPayload = await createChannel.json() as { id: string };

    const createRule = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'MQTT threshold',
          type: 'alert-threshold',
          enabled: true,
          severity: 'critical',
          channel_ids: [channelPayload.id],
          config: {
            window_minutes: 60,
            alert_threshold: 1,
            filters: {},
          },
        }),
      }),
    );
    expect(createRule.status).toBe(201);

    const alerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alerts.status).toBe(200);

    expect(mqttPublishes).toHaveLength(1);
    expect(mqttPublishes[0]?.config).toEqual(expect.objectContaining({
      brokerUrl: 'mqtt://broker.example.com:1883',
      topic: 'crowdsec/notifications',
      qos: 1,
      retainEvents: true,
    }));
    expect(JSON.parse(mqttPublishes[0]?.payload || '{}')).toEqual(expect.objectContaining({
      title: 'MQTT threshold: threshold exceeded',
      severity: 'critical',
      channel_name: 'Primary MQTT',
      rule_name: 'MQTT threshold',
    }));

    const testChannel = await controller.fetch(new Request(`http://localhost/crowdsec/api/notification-channels/${channelPayload.id}/test`, { method: 'POST' }));
    expect(testChannel.status).toBe(200);
    expect(mqttPublishes).toHaveLength(2);
    expect(JSON.parse(mqttPublishes[1]?.payload || '{}')).toEqual(expect.objectContaining({
      rule_name: null,
      severity: 'info',
    }));

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('fires application update rules when a newer version is available', async () => {
    const { controller, database } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
        CROWDSEC_LOOKBACK_PERIOD: '168h',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (url.includes('/v1/alerts?')) {
          return Response.json([]);
        }
        return undefined;
      },
      notificationFetchResolver: (url) => {
        if (url.includes('ntfy.sh')) {
          return Response.json({ id: 'msg' });
        }
        return undefined;
      },
    });

    const createChannel = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Update ntfy',
          type: 'ntfy',
          enabled: true,
          config: { topic: 'crowdsec-updates' },
        }),
      }),
    );
    expect(createChannel.status).toBe(201);
    const channelPayload = await createChannel.json() as { id: string };

    const createRule = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'App updates',
          type: 'application-update',
          enabled: true,
          severity: 'info',
          channel_ids: [channelPayload.id],
          config: {},
        }),
      }),
    );
    expect(createRule.status).toBe(201);

    const alerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alerts.status).toBe(200);

    const notifications = await controller.fetch(new Request('http://localhost/crowdsec/api/notifications'));
    expect(notifications.status).toBe(200);
    expect((await notifications.json()) as {
      data: Array<{ rule_type: string; title: string; metadata: { remote_version?: string | null } }>;
    }).toEqual(expect.objectContaining({
      data: [
        expect.objectContaining({
          rule_type: 'application-update',
          title: 'App updates: application update available',
          metadata: expect.objectContaining({ remote_version: '2.0.0' }),
        }),
      ],
    }));

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('creates and evaluates lapi availability rules through the API', async () => {
    const { controller, database, lapiClient } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
        CROWDSEC_LOOKBACK_PERIOD: '168h',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (url.includes('/v1/alerts?')) {
          return Response.json([]);
        }
        return undefined;
      },
    });

    const initialAlerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(initialAlerts.status).toBe(200);

    const createRule = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'LAPI health',
          type: 'lapi-availability',
          enabled: true,
          severity: 'critical',
          channel_ids: [],
          config: {
            outage_threshold_seconds: 60,
            notify_on_recovery: true,
          },
        }),
      }),
    );
    expect(createRule.status).toBe(201);

    const offlineSince = new Date(Date.now() - 90_000).toISOString();
    lapiClient.updateStatus(false, { message: 'LAPI offline' });
    (lapiClient as unknown as { lapiStatus: { offline_since: string | null } }).lapiStatus.offline_since = offlineSince;
    lapiClient.fetchAlerts = async () => {
      throw new Error('LAPI offline');
    };

    const alertsDuringOutage = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alertsDuringOutage.status).toBe(200);

    const notifications = await controller.fetch(new Request('http://localhost/crowdsec/api/notifications'));
    expect(notifications.status).toBe(200);
    expect((await notifications.json()) as {
      data: Array<{ rule_type: string; title: string; severity: string; metadata: { offline_since?: string; last_error?: string } }>;
    }).toEqual(expect.objectContaining({
      data: [
        expect.objectContaining({
          rule_type: 'lapi-availability',
          title: 'LAPI health: LAPI unavailable',
          severity: 'critical',
          metadata: expect.objectContaining({
            offline_since: offlineSince,
            last_error: 'LAPI offline',
          }),
        }),
      ],
    }));

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('marks the dashboard offline after failed refreshes and then creates lapi availability notifications', async () => {
    let failAlerts = false;
    const { controller, database, lapiClient } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
        CROWDSEC_LOOKBACK_PERIOD: '168h',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (url.includes('/v1/alerts?')) {
          if (failAlerts) {
            throw new Error('fetch failed');
          }
          return Response.json([]);
        }
        return undefined;
      },
    });

    const bootstrapAlerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(bootstrapAlerts.status).toBe(200);

    const createRule = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'LAPI health',
          type: 'lapi-availability',
          enabled: true,
          severity: 'critical',
          channel_ids: [],
          config: {
            outage_threshold_seconds: 1,
            notify_on_recovery: true,
          },
        }),
      }),
    );
    expect(createRule.status).toBe(201);

    failAlerts = true;
    const failedRefresh = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(failedRefresh.status).toBe(200);

    const configAfterFailure = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
    expect(configAfterFailure.status).toBe(200);
    expect((await configAfterFailure.json()) as { lapi_status: { isConnected: boolean; offline_since: string | null; lastError: string | null } }).toEqual(
      expect.objectContaining({
        lapi_status: expect.objectContaining({
          isConnected: false,
          offline_since: expect.any(String),
          lastError: 'fetch failed',
        }),
      }),
    );

    const offlineSince = new Date(Date.now() - 2_000).toISOString();
    (lapiClient as unknown as { lapiStatus: { offline_since: string | null } }).lapiStatus.offline_since = offlineSince;

    const secondFailedRefresh = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(secondFailedRefresh.status).toBe(200);

    const notifications = await controller.fetch(new Request('http://localhost/crowdsec/api/notifications'));
    expect(notifications.status).toBe(200);
    expect((await notifications.json()) as {
      data: Array<{ rule_type: string; title: string; severity: string; metadata: { offline_since?: string; last_error?: string } }>;
    }).toEqual(expect.objectContaining({
      data: [
        expect.objectContaining({
          rule_type: 'lapi-availability',
          title: 'LAPI health: LAPI unavailable',
          severity: 'critical',
          metadata: expect.objectContaining({
            offline_since: offlineSince,
            last_error: 'fetch failed',
          }),
        }),
      ],
    }));

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

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
        if (url.includes('/v1/alerts?') && url.includes('scope=ip') && url.includes('has_active_decision=true')) {
          return Response.json([crowdsecAlert]);
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
    expect(alertRequests).toHaveLength(6);
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
    expect(alertRequests).toHaveLength(12);
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

    const storedAlerts = database.db.query('SELECT raw_data FROM alerts').all() as Array<{ raw_data: string }>;
    expect(
      storedAlerts.some((row) => String((JSON.parse(row.raw_data) as AlertRecord).scenario) === 'crowdsec-blocklist-import/external_blocklist'),
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
    expect(alertRequests).toHaveLength(6);
    expect(alertRequests.every((call) => call.url.includes('include_capi=false'))).toBe(true);
    expect(alertRequests.some((call) => call.url.includes('origin=cscli-import') && !call.url.includes('scope='))).toBe(true);
    expect(alertRequests.some((call) => call.url.includes('origin=cscli-import') && call.url.includes('scope=ip'))).toBe(true);
    expect(alertRequests.some((call) => call.url.includes('origin=cscli-import') && call.url.includes('scope=range'))).toBe(true);

    const storedAlert = database.db.query('SELECT raw_data FROM alerts WHERE id = 17511').get() as { raw_data: string };
    expect(JSON.parse(storedAlert.raw_data)).toEqual(expect.objectContaining({
      id: 17511,
      kind: 'cscli',
    }));

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
    expect(alertRequests).toHaveLength(6);
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

    const storedDecisions = database.db.query('SELECT raw_data FROM decisions').all() as Array<{ raw_data: string }>;
    expect(storedDecisions.map((row) => JSON.parse(row.raw_data))).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: 'crowdsec' }),
      expect.objectContaining({ origin: 'CAPI' }),
    ]));

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
    expect(alertRequests).toHaveLength(2);
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
    expect(alertRequests).toHaveLength(2);
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
    expect(alertRequests).toHaveLength(6);
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
    expect(alertRequests).toHaveLength(12);
    expect(alertRequests.filter((call) => !call.url.includes('origin=')).length).toBe(6);
    expect(alertRequests.filter((call) => call.url.includes('origin=crowdsec')).length).toBe(6);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

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
    expect(alertRequests).toHaveLength(6);
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
    expect(alertRequests).toHaveLength(6);
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
    expect(alertRequests).toHaveLength(6);
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
    expect(alertRequests).toHaveLength(2);
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

    const storedAlert = database.db.query('SELECT raw_data FROM alerts WHERE id = 6').get() as { raw_data: string };
    expect(JSON.parse(storedAlert.raw_data)).toEqual(expect.objectContaining({
      scenario: 'crowdsecurity/appsec-vpatch',
    }));

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });
});
