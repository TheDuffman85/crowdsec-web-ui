import { beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import crypto from 'node:crypto';
import type { AlertRecord } from '../../../shared/contracts';
import { resolveMachineName } from '../../../shared/machine';
import { createRuntimeConfig } from '../../config';
import { CrowdsecDatabase } from '../../database';
import { LapiClient, type LapiRequestInit } from '../../lapi';
import { createApp, type CreateAppOptions } from '../../app';
import { resolveAlertHistoryAt } from '../../utils/alerts';
import type { MqttPublishConfig } from '../../notifications/mqtt-client';

export let tempDir: string;

export function sampleAlert(overrides: Partial<AlertRecord> = {}): AlertRecord {
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
      latitude: 52.52,
      longitude: 13.405,
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

export function sampleSimulatedAlert(): AlertRecord {
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
      latitude: 37.7749,
      longitude: -122.4194,
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

export function sampleImplicitSimulatedAlert(): AlertRecord {
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

export function createAuthSessionCookie(
  database: CrowdsecDatabase,
  payload: { userId: number; username: string; role: 'admin' | 'read-only'; authMethod: 'password' | 'passkey' | 'oidc' },
  configuredSecret?: string,
  times: { issuedAt?: number; expiresAt?: number } = {},
): string {
  const secret = configuredSecret || database.getMeta('auth_session_secret')?.value;
  if (!secret) throw new Error('Auth session secret was not initialized');
  const now = Math.floor(Date.now() / 1000);
  const encodedPayload = Buffer.from(JSON.stringify({
    ...payload,
    iat: times.issuedAt ?? now,
    exp: times.expiresAt ?? now + 60 * 60,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  return `crowdsec_web_ui_session=${encodedPayload}.${signature}`;
}

export function sampleManualWebUiAlert(overrides: Partial<AlertRecord> = {}): AlertRecord {
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

export function sampleBlocklistImportAlert(overrides: Partial<AlertRecord> = {}): AlertRecord {
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

export function sampleCapiAlert(overrides: Partial<AlertRecord> = {}): AlertRecord {
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

export function sampleListsAlert(overrides: Partial<AlertRecord> = {}): AlertRecord {
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

export function sampleAppSecAlert(overrides: Partial<AlertRecord> = {}): AlertRecord {
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

export function sampleRangeAlert(overrides: Partial<AlertRecord> = {}): AlertRecord {
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

export function destroyTempDir(): void {
  rmSync(tempDir, { recursive: true, force: true });
}

export function createTestDistRoot(): string {
  const distRoot = path.join(tempDir, 'dist');
  mkdirSync(path.join(distRoot, 'assets'), { recursive: true });
  writeFileSync(path.join(distRoot, 'index.html'), '<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  writeFileSync(path.join(distRoot, 'assets', 'app.js'), 'console.log("ok");');
  writeFileSync(path.join(distRoot, 'world-50m.json'), '{"type":"Topology"}');
  writeFileSync(path.join(distRoot, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  writeFileSync(path.join(distRoot, 'logo-sidebar.png'), 'png');
  return distRoot;
}

export function createController(options: {
  alertDetailPayload?: unknown;
  simulationsEnabled?: boolean;
  authMode?: 'password' | 'mtls' | 'none';
  env?: Record<string, string>;
  fetchResolver?: (url: string, init?: LapiRequestInit) => Response | Promise<Response> | undefined;
  notificationFetchResolver?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
  metricsFetchResolver?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
  mqttPublishResolver?: (config: MqttPublishConfig, payload: string) => void | Promise<void>;
  syncWorker?: CreateAppOptions['syncWorker'];
  queryWorker?: CreateAppOptions['queryWorker'];
  facetQueryWorker?: CreateAppOptions['facetQueryWorker'];
  database?: CrowdsecDatabase;
  initialCacheState?: CreateAppOptions['initialCacheState'];
  attackLocationResolver?: CreateAppOptions['attackLocationResolver'];
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
    CROWDSEC_LOOKBACK_PERIOD: '1m',
    CROWDSEC_REFRESH_INTERVAL: '30s',
    CROWDSEC_MANUAL_REFRESH_ENABLED: 'true',
    CROWDSEC_BOUNCER_PROPAGATION_DELAY: '0',
    VITE_VERSION: '1.0.0',
    VITE_BRANCH: 'main',
    VITE_COMMIT_HASH: 'abc123',
    DB_DIR: tempDir,
    NOTIFICATION_ALLOW_PRIVATE_ADDRESSES: 'true',
    AUTH_ENABLED: 'false',
    ...authEnv,
    ...options.env,
  }, { defaultConfigFile: path.join(tempDir, 'config.yaml') });

  const database = options.database || new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
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
    if (url.endsWith('/v1/usage-metrics') && init?.method === 'POST') {
      return Response.json({ ok: true }, { status: 201 });
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
    requestTimeoutMs: config.lapiRequestTimeoutMs,
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
    metricsFetchImpl: async (input, init) => {
      const url = String(input);
      const resolved = await options.metricsFetchResolver?.(url, init);
      if (resolved) {
        return resolved;
      }
      return new Response('', { status: 404 });
    },
    mqttPublishImpl: async (config, payload) => {
      await options.mqttPublishResolver?.(config, payload);
    },
    attackLocationResolver: options.attackLocationResolver || {
      resolve: async (locations) => locations,
    },
    syncWorker: options.syncWorker,
    queryWorker: options.queryWorker,
    facetQueryWorker: options.facetQueryWorker,
    initialCacheState: options.initialCacheState,
  });

  return { controller, database, lapiClient, fetchCalls };
}


export function seedAlert(database: CrowdsecDatabase, alert: AlertRecord): void {
  const insert = database.transaction<AlertRecord>((record) => {
    const alertHistoryAt = resolveAlertHistoryAt(record);
    database.insertAlert({
      $id: record.id,
      $uuid: record.uuid || String(record.id),
      $created_at: alertHistoryAt,
      $scenario: record.scenario,
      $source_ip: record.source?.ip || record.source?.value || record.source?.range || '',
      $message: record.message || '',
      $raw_data: JSON.stringify(record),
    });

    for (const decision of record.decisions || []) {
      const createdAt = decision.created_at || alertHistoryAt;
      const stopAt = decision.stop_at || new Date(Date.now() + 30 * 60 * 1_000).toISOString();
      database.insertDecision({
        $id: String(decision.id),
        $uuid: String(decision.id),
        $alert_id: record.id,
        $created_at: createdAt,
        $stop_at: stopAt,
        $value: decision.value || record.source?.ip || record.source?.value || record.source?.range || '',
        $type: decision.type,
        $origin: decision.origin,
        $scenario: decision.scenario || record.scenario,
        $raw_data: JSON.stringify({
          id: decision.id,
          created_at: createdAt,
          scenario: decision.scenario || record.scenario,
          value: decision.value || record.source?.ip || record.source?.value || record.source?.range || '',
          stop_at: stopAt,
          type: decision.type || 'ban',
          origin: decision.origin || 'manual',
          country: record.source?.cn,
          region: record.source?.region,
          city: record.source?.city,
          as: record.source?.as_name,
          machine: resolveMachineName(record),
          target: record.target,
          alert_id: record.id,
          simulated: decision.simulated === true,
        }),
      });
    }
  });
  insert(alert);
}

export function dashboardDateKey(isoString: string, timezoneOffsetMinutes: number, includeHour = false): string {
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
