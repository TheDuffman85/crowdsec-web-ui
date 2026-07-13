import { beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import crypto from 'node:crypto';
import { generate } from 'otplib';
import type { AlertRecord, PaginatedResponse, SlimAlert } from '../shared/contracts';
import { resolveMachineName } from '../shared/machine';
import { createRuntimeConfig } from './config';
import { CrowdsecDatabase } from './database';
import { LapiClient, type LapiRequestInit } from './lapi';
import { createApp, type CreateAppOptions } from './app';
import { resolveOidcClaims, resolveOidcRole } from './app-auth';
import { resolveAlertHistoryAt } from './utils/alerts';
import { parseGoDuration } from './utils/duration';
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

function createAuthSessionCookie(
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
  writeFileSync(path.join(distRoot, 'assets', 'app.js'), 'console.log("ok");');
  writeFileSync(path.join(distRoot, 'world-50m.json'), '{"type":"Topology"}');
  writeFileSync(path.join(distRoot, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  writeFileSync(path.join(distRoot, 'logo-sidebar.png'), 'png');
  return distRoot;
}

function createController(options: {
  alertDetailPayload?: unknown;
  simulationsEnabled?: boolean;
  authMode?: 'password' | 'mtls' | 'none';
  env?: Record<string, string>;
  fetchResolver?: (url: string, init?: LapiRequestInit) => Response | Promise<Response> | undefined;
  notificationFetchResolver?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
  metricsFetchResolver?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
  mqttPublishResolver?: (config: MqttPublishConfig, payload: string) => void | Promise<void>;
  syncWorker?: CreateAppOptions['syncWorker'];
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
    VITE_VERSION: '1.0.0',
    VITE_BRANCH: 'main',
    VITE_COMMIT_HASH: 'abc123',
    DB_DIR: tempDir,
    NOTIFICATION_ALLOW_PRIVATE_ADDRESSES: 'true',
    AUTH_ENABLED: 'false',
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
    syncWorker: options.syncWorker,
  });

  return { controller, database, lapiClient, fetchCalls };
}

test('dashboard auth protects API routes and allows initial setup login', async () => {
  const { controller } = createController({
    env: {
      AUTH_ENABLED: 'true',
    },
  });

  const unauthenticated = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
  expect(unauthenticated.status).toBe(401);

  const statusBeforeSetup = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/status'));
  expect(await statusBeforeSetup.json()).toMatchObject({
    authEnabled: true,
    setupRequired: true,
    authenticated: false,
  });

  const setup = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123' }),
  }));
  expect(setup.status).toBe(200);
  const cookie = setup.headers.get('set-cookie');
  expect(cookie).toContain('crowdsec_web_ui_session=');

  const authenticated = await controller.fetch(new Request('http://localhost/crowdsec/api/config', {
    headers: { cookie: cookie || '' },
  }));
  expect(authenticated.status).toBe(200);
  const payload = await authenticated.json() as { permissions?: { mode?: string } };
  expect(payload.permissions?.mode).toBe('admin');
});

test('security middleware applies CSP, private API caching, origin checks, and body limits', async () => {
  const { controller } = createController();

  const page = await controller.fetch(new Request('http://localhost/crowdsec/'));
  const pageHtml = await page.text();
  const csp = page.headers.get('content-security-policy') || '';
  const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
  expect(nonce).toBeTruthy();
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(pageHtml).toContain(`<script nonce="${nonce}">window.__BASE_PATH__="/crowdsec";</script>`);
  expect(page.headers.get('strict-transport-security')).toBeNull();

  const apiResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
  expect(apiResponse.headers.get('cache-control')).toBe('private, no-store');

  const crossOrigin = await controller.fetch(new Request('http://localhost/crowdsec/api/config/language', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
    body: JSON.stringify({ language: 'de' }),
  }));
  expect(crossOrigin.status).toBe(403);
  expect(await crossOrigin.json()).toEqual({ error: 'Cross-origin request rejected' });

  const oversized = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'x'.repeat(1024 * 1024) }),
  }));
  expect(oversized.status).toBe(413);
});

test('password throttling cannot be bypassed with spoofed forwarded addresses', async () => {
  const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
  await controller.fetch(new Request('http://localhost/crowdsec/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123' }),
  }));

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${attempt + 1}` },
      body: JSON.stringify({ username: 'admin', password: 'WrongSecret123' }),
    }));
    expect(response.status).toBe(401);
  }

  const throttled = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.250' },
    body: JSON.stringify({ username: 'admin', password: 'WrongSecret123' }),
  }));
  expect(throttled.status).toBe(429);
});

test('CrowdSec metrics endpoint is disabled until Prometheus URL is configured', async () => {
  const { controller } = createController();

  const configResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
  expect(await configResponse.json()).toEqual(expect.objectContaining({
    metrics_enabled: false,
    metrics_sidebar_visible: true,
  }));

  const response = await controller.fetch(new Request('http://localhost/crowdsec/api/metrics/crowdsec'));
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'CrowdSec Prometheus metrics are not enabled' });
});

test('CrowdSec metrics endpoint proxies and summarizes Prometheus metrics', async () => {
  const { controller } = createController({
    env: {
      CROWDSEC_PROMETHEUS_URL: 'http://crowdsec:6060/metrics',
    },
    metricsFetchResolver: async (url) => {
      expect(url).toBe('http://crowdsec:6060/metrics');
      return new Response(`
cs_lapi_bouncer_requests_total{bouncer="firewall",route="/v1/decisions",method="GET"} 7
cs_lapi_machine_requests_total{machine="edge-1",route="/v1/alerts",method="GET"} 3
cs_appsec_reqs_total{source="0.0.0.0:7422",appsec_engine="appsec"} 11
cs_appsec_block_total{source="0.0.0.0:7422",appsec_engine="appsec"} 2
cs_parser_hits_total{source="/var/log/auth.log",type="syslog"} 20
cs_parser_hits_ok_total{source="/var/log/auth.log",type="syslog",acquis_type="file"} 19
cs_parser_hits_ko_total{source="/var/log/auth.log",type="syslog",acquis_type="file"} 1
cs_node_wl_hits_total{name="crowdsecurity/whitelists",source="/var/log/auth.log",type="syslog",reason="private",stage="s02-enrich",acquis_type="file"} 5
cs_node_wl_hits_ok_total{name="crowdsecurity/whitelists",source="/var/log/auth.log",type="syslog",reason="private",stage="s02-enrich",acquis_type="file"} 3
`, { status: 200 });
    },
  });

  const configResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
  expect(await configResponse.json()).toEqual(expect.objectContaining({
    metrics_enabled: true,
    metrics_sidebar_visible: true,
  }));

  const response = await controller.fetch(new Request('http://localhost/crowdsec/api/metrics/crowdsec'));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(expect.objectContaining({
    totals: expect.objectContaining({
      bouncerRequests: 7,
      machineRequests: 3,
      appsecRequests: 11,
      appsecBlocked: 2,
      parserProcessed: 20,
      parserOk: 19,
      parserKo: 1,
      whitelistHits: 5,
      whitelisted: 3,
    }),
    bouncers: [expect.objectContaining({ name: 'firewall', requests: 7 })],
    machines: [expect.objectContaining({ name: 'edge-1', requests: 3 })],
    parserSources: [expect.objectContaining({ source: '/var/log/auth.log', successRate: 0.95 })],
    whitelists: [expect.objectContaining({ name: 'crowdsecurity/whitelists', reason: 'private', hits: 5, whitelisted: 3 })],
  }));

  const preferenceResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/config/metrics-sidebar', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visible: false }),
  }));
  expect(preferenceResponse.status).toBe(200);
  expect(await preferenceResponse.json()).toEqual({ success: true, metrics_sidebar_visible: false });

  const updatedConfigResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
  expect(await updatedConfigResponse.json()).toEqual(expect.objectContaining({ metrics_sidebar_visible: false }));
});

test('dashboard auth exposes account settings and password changes', async () => {
  const { controller, database } = createController({
    env: {
      AUTH_ENABLED: 'true',
    },
  });

  const setup = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123' }),
  }));
  const cookie = setup.headers.get('set-cookie') || '';

  const settings = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/settings', {
    headers: { cookie },
  }));
  expect(settings.status).toBe(200);
  expect(await settings.json()).toMatchObject({
    disablePasswordLogin: false,
    oidcIssuerUrl: '',
    oidcClientId: '',
    hasOidcClientSecret: false,
    oidcScope: 'openid profile email',
    oidcGroupsClaim: 'groups',
    oidcAdminGroups: '',
    oidcReadOnlyGroups: '',
    oidcUnmatchedRole: 'deny',
    hasPassword: true,
    passkeysAvailable: true,
    totpEnabled: false,
    authMethod: 'password',
  });

  const passkeyCookie = createAuthSessionCookie(database, {
    userId: 1,
    username: 'admin',
    role: 'admin',
    authMethod: 'passkey',
  });
  const passkeySettings = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/settings', {
    headers: { cookie: passkeyCookie },
  }));
  expect(passkeySettings.status).toBe(200);
  expect(await passkeySettings.json()).toMatchObject({
    hasPassword: true,
    totpEnabled: false,
    authMethod: 'passkey',
  });

  const passkeyPasswordChange = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: passkeyCookie },
    body: JSON.stringify({ currentPassword: 'Secret123', newPassword: 'NewSecret123' }),
  }));
  expect(passkeyPasswordChange.status).toBe(403);

  const saveGroupMapping = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({
      oidcGroupsClaim: 'roles',
      oidcScope: 'openid profile email groups offline_access',
      oidcAdminGroups: 'admins, secops, admins',
      oidcReadOnlyGroups: 'viewers',
      oidcUnmatchedRole: 'admin',
    }),
  }));
  expect(saveGroupMapping.status).toBe(200);
  expect(await saveGroupMapping.json()).toMatchObject({
    settings: {
      oidcGroupsClaim: 'roles',
      oidcScope: 'openid profile email groups offline_access',
      oidcAdminGroups: 'admins,secops',
      oidcReadOnlyGroups: 'viewers',
      oidcUnmatchedRole: 'admin',
    },
  });

  const invalidScope = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ oidcScope: 'profile email groups' }),
  }));
  expect(invalidScope.status).toBe(400);
  expect(await invalidScope.json()).toMatchObject({
    error: 'OIDC scopes must include openid',
  });

  const disableWithoutAlternative = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ disablePasswordLogin: true }),
  }));
  expect(disableWithoutAlternative.status).toBe(400);

  const wrongCurrentPassword = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ currentPassword: 'WrongSecret123', newPassword: 'NewSecret123' }),
  }));
  expect(wrongCurrentPassword.status).toBe(401);

  const changePassword = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ currentPassword: 'Secret123', newPassword: 'NewSecret123' }),
  }));
  expect(changePassword.status).toBe(200);
  const refreshedCookie = changePassword.headers.get('set-cookie') || '';
  expect(refreshedCookie).toContain('crowdsec_web_ui_session=');

  const revokedOldSession = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/settings', {
    headers: { cookie },
  }));
  expect(revokedOldSession.status).toBe(401);
  const refreshedSession = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/settings', {
    headers: { cookie: refreshedCookie },
  }));
  expect(refreshedSession.status).toBe(200);

  const oldLogin = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123' }),
  }));
  expect(oldLogin.status).toBe(401);

  const newLogin = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'NewSecret123' }),
  }));
  expect(newLogin.status).toBe(200);
});

test('OIDC-only users cannot persist SSO access by registering or using passkeys', async () => {
  const { controller, database } = createController({ env: { AUTH_ENABLED: 'true' } });
  const user = database.upsertOidcUser({
    username: 'oidc-admin',
    role: 'admin',
    issuer: 'https://idp.example.com',
    subject: 'oidc-subject',
  });
  const oidcCookie = createAuthSessionCookie(database, {
    userId: user.id,
    username: user.username,
    role: user.role,
    authMethod: 'oidc',
  });

  const settings = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/settings', {
    headers: { cookie: oidcCookie },
  }));
  expect(settings.status).toBe(200);
  expect(await settings.json()).toMatchObject({
    hasPassword: false,
    passkeysAvailable: false,
    authMethod: 'oidc',
  });

  const passkeys = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/passkeys', {
    headers: { cookie: oidcCookie },
  }));
  expect(passkeys.status).toBe(403);
  expect(await passkeys.json()).toMatchObject({
    error: 'Passkeys are unavailable for OIDC-only accounts',
  });

  const registration = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/webauthn/register/options', {
    method: 'POST',
    headers: { cookie: oidcCookie },
  }));
  expect(registration.status).toBe(403);
  expect(await registration.json()).toMatchObject({
    error: 'Passkeys cannot be registered for OIDC-only accounts',
  });

  database.createWebAuthnCredential({
    userId: user.id,
    credentialId: 'oidc-only-passkey',
    publicKey: 'unused-for-oidc-only-account',
    signCount: 0,
    transports: '[]',
    name: 'Legacy passkey',
  });
  const loginOptions = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/webauthn/login/options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user.username }),
  }));
  const blockedPasskeyLogin = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/webauthn/login/verify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: loginOptions.headers.get('set-cookie') || '',
    },
    body: JSON.stringify({ id: 'oidc-only-passkey' }),
  }));
  expect(blockedPasskeyLogin.status).toBe(403);
  expect(await blockedPasskeyLogin.json()).toMatchObject({
    error: 'This passkey belongs to an OIDC-only account. Sign in with SSO instead.',
  });

  const now = Math.floor(Date.now() / 1000);
  const staleOidcCookie = createAuthSessionCookie(database, {
    userId: user.id,
    username: user.username,
    role: user.role,
    authMethod: 'oidc',
  }, undefined, {
    issuedAt: now - 25 * 60 * 60,
    expiresAt: now + 60 * 60,
  });
  const staleSession = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/settings', {
    headers: { cookie: staleOidcCookie },
  }));
  expect(staleSession.status).toBe(401);
});

test('dashboard auth supports optional TOTP for password login', async () => {
  const { controller, database } = createController({
    env: {
      AUTH_ENABLED: 'true',
    },
  });

  const setup = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123' }),
  }));
  const sessionCookie = setup.headers.get('set-cookie') || '';

  const totpSetup = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/totp/setup', {
    method: 'POST',
    headers: { cookie: sessionCookie },
  }));
  expect(totpSetup.status).toBe(200);
  const totpSetupPayload = await totpSetup.json() as { secret: string; otpauthUrl: string };
  expect(totpSetupPayload.secret).toMatch(/^[A-Z2-7]+$/);
  expect(totpSetupPayload.otpauthUrl).toContain('otpauth://totp/');
  expect(totpSetupPayload.otpauthUrl).toContain('issuer=CrowdSec%20Web%20UI');

  const setupCookie = totpSetup.headers.get('set-cookie') || '';
  const malformedEnableTotp = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/totp/enable', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: `${sessionCookie}; ${setupCookie.split(';')[0]}`,
    },
    body: JSON.stringify({ code: 'not-a-code' }),
  }));
  expect(malformedEnableTotp.status).toBe(400);
  expect(await malformedEnableTotp.json()).toMatchObject({ error: 'Invalid authenticator code' });

  const enableTotp = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/totp/enable', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: `${sessionCookie}; ${setupCookie.split(';')[0]}`,
    },
    body: JSON.stringify({ code: await generate({ secret: totpSetupPayload.secret }) }),
  }));
  expect(enableTotp.status).toBe(200);
  expect(await enableTotp.json()).toMatchObject({ totpEnabled: true });
  const user = database.getAuthUserByUsername('admin');
  expect(user?.totp_enabled).toBe(1);
  expect(user?.totp_secret).toMatch(/^enc:v1:/);
  expect(database.getMeta('auth_session_secret')?.value).toBeTruthy();

  const setupAlreadyEnabled = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/totp/setup', {
    method: 'POST',
    headers: { cookie: sessionCookie },
  }));
  expect(setupAlreadyEnabled.status).toBe(400);
  expect(await setupAlreadyEnabled.json()).toMatchObject({ error: 'TOTP is already enabled for this account' });

  const disableWithoutPassword = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/totp', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
    body: JSON.stringify({}),
  }));
  expect(disableWithoutPassword.status).toBe(400);
  expect(await disableWithoutPassword.json()).toMatchObject({
    error: 'Current password required',
  });

  const passwordOnlyLogin = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123' }),
  }));
  expect(passwordOnlyLogin.status).toBe(401);
  expect(await passwordOnlyLogin.json()).toMatchObject({ requiresTotp: true });

  const invalidTotpLogin = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123', totpCode: '000000' }),
  }));
  expect(invalidTotpLogin.status).toBe(401);
  expect(await invalidTotpLogin.json()).toMatchObject({ requiresTotp: true });

  const validTotpCode = await generate({ secret: totpSetupPayload.secret });
  const validTotpLogin = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123', totpCode: validTotpCode }),
  }));
  expect(validTotpLogin.status).toBe(200);

  const replayedTotpLogin = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123', totpCode: validTotpCode }),
  }));
  expect(replayedTotpLogin.status).toBe(401);
  expect(await replayedTotpLogin.json()).toMatchObject({ requiresTotp: true });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const throttledSoon = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Secret123', totpCode: '000000' }),
    }));
    expect(throttledSoon.status).toBe(401);
  }
  const throttledTotpLogin = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123', totpCode: '000000' }),
  }));
  expect(throttledTotpLogin.status).toBe(429);
  expect(throttledTotpLogin.headers.get('retry-after')).toBeTruthy();

  const disableTotp = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/totp', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
    body: JSON.stringify({ currentPassword: 'Secret123' }),
  }));
  expect(disableTotp.status).toBe(200);
  expect(await disableTotp.json()).toMatchObject({ totpEnabled: false });
  expect(database.getAuthUserByUsername('admin')?.totp_enabled).toBe(0);
});

test('dashboard auth auto-generates an auth secret for new TOTP setup', async () => {
  const { controller, database } = createController({
    env: {
      AUTH_ENABLED: 'true',
    },
  });

  const setup = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123' }),
  }));
  const sessionCookie = setup.headers.get('set-cookie') || '';

  const totpSetup = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/totp/setup', {
    method: 'POST',
    headers: { cookie: sessionCookie },
  }));
  expect(totpSetup.status).toBe(200);
  expect(database.getMeta('auth_session_secret')?.value).toBeTruthy();
});

test('dashboard auth settings use OIDC environment values as defaults', async () => {
  const { controller } = createController({
    env: {
      AUTH_ENABLED: 'true',
      CROWDSEC_AUTH_OIDC_ISSUER_URL: 'https://idp.example.com/application/o/crowdsec/',
      CROWDSEC_AUTH_OIDC_CLIENT_ID: 'crowdsec-client',
      CROWDSEC_AUTH_OIDC_CLIENT_SECRET: 'oidc-secret',
      CROWDSEC_AUTH_OIDC_SCOPE: 'openid profile email roles',
      CROWDSEC_AUTH_OIDC_GROUPS_CLAIM: 'roles',
      CROWDSEC_AUTH_OIDC_ADMIN_GROUPS: 'admins,secops',
      CROWDSEC_AUTH_OIDC_READ_ONLY_GROUPS: 'viewers',
      CROWDSEC_AUTH_OIDC_UNMATCHED_ROLE: 'read-only',
    },
  });

  const setup = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Secret123' }),
  }));
  const cookie = setup.headers.get('set-cookie') || '';

  const settings = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/settings', {
    headers: { cookie },
  }));
  expect(settings.status).toBe(200);
  expect(await settings.json()).toMatchObject({
    oidcIssuerUrl: 'https://idp.example.com/application/o/crowdsec/',
    oidcClientId: 'crowdsec-client',
    hasOidcClientSecret: true,
    oidcScope: 'openid profile email roles',
    oidcGroupsClaim: 'roles',
    oidcAdminGroups: 'admins,secops',
    oidcReadOnlyGroups: 'viewers',
    oidcUnmatchedRole: 'read-only',
  });
});

function seedAlert(database: CrowdsecDatabase, alert: AlertRecord): void {
  const alertHistoryAt = resolveAlertHistoryAt(alert);
  database.insertAlert({
    $id: alert.id,
    $uuid: alert.uuid || String(alert.id),
    $created_at: alertHistoryAt,
    $scenario: alert.scenario,
    $source_ip: alert.source?.ip || alert.source?.value || alert.source?.range || '',
    $message: alert.message || '',
    $raw_data: JSON.stringify(alert),
  });

  for (const decision of alert.decisions || []) {
    const createdAt = decision.created_at || alertHistoryAt;
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

describe('OIDC role mapping', () => {
  const baseConfig = {
    oidcAdminGroups: ['admins'],
    oidcReadOnlyGroups: ['viewers'],
    oidcUnmatchedRole: 'deny' as const,
  };

  test('uses matching groups before the unmatched-user policy', () => {
    expect(resolveOidcRole(baseConfig, ['admins'])).toBe('admin');
    expect(resolveOidcRole(baseConfig, ['viewers'])).toBe('read-only');
    expect(resolveOidcRole(baseConfig, ['admins', 'viewers'])).toBe('admin');
  });

  test('applies the configured unmatched-user policy when no group matches', () => {
    expect(resolveOidcRole({ ...baseConfig, oidcUnmatchedRole: 'deny' }, ['auditors'])).toBeNull();
    expect(resolveOidcRole({ ...baseConfig, oidcUnmatchedRole: 'admin' }, ['auditors'])).toBe('admin');
    expect(resolveOidcRole({ ...baseConfig, oidcUnmatchedRole: 'read-only' }, ['auditors'])).toBe('read-only');
  });

  test('also applies the unmatched-user policy when group lists are empty', () => {
    const emptyGroups = { oidcAdminGroups: [], oidcReadOnlyGroups: [], oidcUnmatchedRole: 'deny' as const };
    expect(resolveOidcRole(emptyGroups, ['admins'])).toBeNull();
    expect(resolveOidcRole({ ...emptyGroups, oidcUnmatchedRole: 'admin' }, [])).toBe('admin');
    expect(resolveOidcRole({ ...emptyGroups, oidcUnmatchedRole: 'read-only' }, [])).toBe('read-only');
  });
});

describe('resolveOidcClaims', () => {
  const config = {
    oidcGroupsClaim: 'https://sso.example.net/roles',
    oidcAdminGroups: ['crowdsec-ui.crowdsec-admin'],
    oidcReadOnlyGroups: ['crowdsec-ui.crowdsec-viewer'],
    oidcUnmatchedRole: 'deny' as const,
  };

  test('resolves username and role from UserInfo when the ID token is minimal', () => {
    const idClaims = { iss: 'https://sso.example.net', sub: '1' };
    const userinfo = {
      sub: '1',
      email: 'admin@example.com',
      name: 'Example Admin',
      'https://sso.example.net/roles': ['crowdsec-ui.crowdsec-admin'],
    };
    expect(resolveOidcClaims(idClaims, userinfo, config)).toEqual({
      username: 'admin@example.com',
      role: 'admin',
    });
  });

  test('falls back to ID-token claims when UserInfo is absent', () => {
    const idClaims = {
      sub: '1',
      preferred_username: 'id-token-user',
      'https://sso.example.net/roles': ['crowdsec-ui.crowdsec-viewer'],
    };
    expect(resolveOidcClaims(idClaims, undefined, config)).toEqual({
      username: 'id-token-user',
      role: 'read-only',
    });
  });

  test('unions groups so an empty UserInfo groups value cannot erase ID-token groups', () => {
    const idClaims = {
      sub: '1',
      email: 'user@example.com',
      'https://sso.example.net/roles': ['crowdsec-ui.crowdsec-admin'],
    };
    const userinfo = { sub: '1', 'https://sso.example.net/roles': [] as string[] };
    expect(resolveOidcClaims(idClaims, userinfo, config)?.role).toBe('admin');
  });

  test('unions groups drawn from both sources', () => {
    const idClaims = { sub: '1', email: 'user@example.com', 'https://sso.example.net/roles': ['crowdsec-ui.crowdsec-viewer'] };
    const userinfo = { sub: '1', 'https://sso.example.net/roles': ['crowdsec-ui.crowdsec-admin'] };
    // admin wins over read-only via resolveOidcRole precedence
    expect(resolveOidcClaims(idClaims, userinfo, config)?.role).toBe('admin');
  });

  test('returns null when no username claim can be resolved', () => {
    const idClaims = { iss: 'https://sso.example.net' };
    expect(resolveOidcClaims(idClaims, {}, config)).toBeNull();
  });
});

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
      allCountries: Array<{ countryCode: string; liveDecisionCount?: number; activeLiveDecisionCount?: number }>;
      series: { decisionsHistory: Array<{ count: number }>; activeDecisionsHistory: Array<{ count: number }> };
    }).toEqual(expect.objectContaining({
      filteredTotals: { alerts: 2, decisions: 2, simulatedAlerts: 0, simulatedDecisions: 0 },
      topCountries: [expect.objectContaining({ countryCode: 'DE', count: 2 })],
      allCountries: [expect.objectContaining({ countryCode: 'DE', liveDecisionCount: 3, activeLiveDecisionCount: 2 })],
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
        CROWDSEC_TIME_FORMAT: '24h',
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

  test('keeps the longest active decision visible when duplicate values are hidden', async () => {
    const createdAt = new Date().toISOString();
    const shortStopAt = new Date(Date.now() + 14 * 60 * 60 * 1_000).toISOString();
    const longStopAt = new Date(Date.now() + 62 * 60 * 60 * 1_000).toISOString();
    const duplicateAlert = sampleAlert({
      id: 110,
      uuid: 'alert-110',
      created_at: createdAt,
      source: { ip: '85.121.208.95', value: '85.121.208.95', cn: 'RO', as_name: 'Stylish By A&I Srl' },
      decisions: [
        {
          id: 10,
          type: 'ban',
          value: '85.121.208.95',
          duration: '14h',
          stop_at: shortStopAt,
          origin: 'crowdsec',
          scenario: 'crowdsecurity/appsec-native',
          simulated: false,
        },
        {
          id: 49,
          type: 'ban',
          value: '85.121.208.95',
          duration: '62h',
          stop_at: longStopAt,
          origin: 'crowdsec',
          scenario: 'crowdsecurity/http-probing',
          simulated: false,
        },
      ],
    });
    const { controller, database } = createController({
      fetchResolver: (url) => {
        if (url.includes('/v1/alerts?')) {
          return Response.json([duplicateAlert]);
        }
        return undefined;
      },
    });
    seedAlert(database, duplicateAlert);

    const defaultResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions?page=1&page_size=10'));
    expect(defaultResponse.status).toBe(200);
    expect((await defaultResponse.json()) as { data: Array<{ id: number; detail: { reason: string } }> }).toEqual(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            id: 49,
            detail: expect.objectContaining({ reason: 'crowdsecurity/http-probing' }),
          }),
        ],
      }),
    );

    const duplicatesResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions?page=1&page_size=10&hide_duplicates=false'));
    expect(duplicatesResponse.status).toBe(200);
    expect((await duplicatesResponse.json()) as { data: Array<{ id: number; is_duplicate: boolean }> }).toEqual(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ id: 10, is_duplicate: true }),
          expect.objectContaining({ id: 49, is_duplicate: false }),
        ]),
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

    const liveAlertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=10&q=sim<>simulated'));
    expect(liveAlertsResponse.status).toBe(200);
    expect((await liveAlertsResponse.json()) as { data: Array<{ id: number }>; pagination: { total: number } }).toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ id: 1 })],
        pagination: expect.objectContaining({ total: 1 }),
      }),
    );

    const typoAlertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=10&q=sim<>simulatd'));
    expect(typoAlertsResponse.status).toBe(200);
    expect((await typoAlertsResponse.json()) as { data: Array<{ id: number }>; pagination: { total: number } }).toEqual(
      expect.objectContaining({
        data: [],
        pagination: expect.objectContaining({ total: 0 }),
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

  test('serves the first paginated alert page from a 100k-row cache', async () => {
    const { controller, database } = createController({
      env: {
        CROWDSEC_LOOKBACK_PERIOD: '168h',
      },
    });
    const bootstrap = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(bootstrap.status).toBe(200);
    const now = Date.now();
    const insert = database.db.prepare(`
      INSERT INTO alerts (
        id, uuid, created_at, scenario, source_ip, message, raw_data,
        country, country_name, as_name, target, machine, meta_search, origins, simulated, search_text
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSearch = database.db.prepare('INSERT INTO alerts_fts(rowid, alert_id, search_text) VALUES (?, ?, ?)');
    const insertMany = database.db.transaction((count: number) => {
      for (let index = 1; index <= count; index += 1) {
        const createdAt = new Date(now - index * 1_000).toISOString();
        const ip = `10.42.${Math.floor(index / 256) % 256}.${index % 256}`;
        const searchText = `perf scenario ${ip} germany ssh`;
        insert.run(
          index,
          `perf-alert-${index}`,
          createdAt,
          'perf/scenario',
          ip,
          'perf alert',
          JSON.stringify({
            id: index,
            uuid: `perf-alert-${index}`,
            created_at: createdAt,
            scenario: 'perf/scenario',
            source: { ip, value: ip, cn: 'DE', as_name: 'Perf AS' },
            target: 'ssh',
            decisions: [],
            simulated: false,
          }),
          'DE',
          'Germany',
          'Perf AS',
          'ssh',
          'perf-host',
          'perf',
          '',
          0,
          searchText,
        );
        insertSearch.run(index, String(index), searchText);
      }
    });
    insertMany(100_000);

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=50&q=perf'));
    expect(response.status).toBe(200);
    const payload = await response.json() as PaginatedResponse<SlimAlert>;
    expect(payload.data).toHaveLength(50);
    expect(payload.pagination.total).toBe(100_000);
    expect(payload.selectable_ids).toHaveLength(50);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('returns a 400 for invalid advanced search queries', async () => {
    const { controller, database } = createController();

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
  Status: complete
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

  test('syncs active decisions in configured windows unless timeout splitting is needed', async () => {
    const { controller, database, fetchCalls } = createController({
      env: {
        CROWDSEC_LOOKBACK_PERIOD: '2h',
        CROWDSEC_ALERT_SYNC_CHUNK: '1h',
      },
      fetchResolver: (url) => {
        if (url.includes('/v1/alerts?') && url.includes('has_active_decision=true')) {
          return Response.json([]);
        }
        return undefined;
      },
    });

    const alerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alerts.status).toBe(200);

    const activeRequests = fetchCalls.filter((call) =>
      call.url.includes('/v1/alerts?') && call.url.includes('has_active_decision=true'),
    );
    expect(activeRequests).toHaveLength(6);
    expect(activeRequests.every((call) => call.url.includes('until='))).toBe(true);
    expect(activeRequests.some((call) => call.url.includes('since=2h') && call.url.includes('until=1h'))).toBe(true);
    expect(activeRequests.some((call) => call.url.includes('since=1h') && call.url.includes('until=0h'))).toBe(true);
    expect(activeRequests.some((call) => !call.url.includes('scope='))).toBe(true);
    expect(activeRequests.some((call) => call.url.includes('scope=ip'))).toBe(true);
    expect(activeRequests.some((call) => call.url.includes('scope=range'))).toBe(true);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('splits timed-out active decision windows and imports successful smaller windows', async () => {
    const activeAlert = sampleAlert({
      id: 81,
      uuid: 'alert-81',
      decisions: [{
        id: 810,
        type: 'ban',
        value: '8.8.8.8',
        duration: '30m',
        origin: 'crowdsec',
        simulated: false,
      }],
    });
    const { controller, database, fetchCalls } = createController({
      env: {
        CROWDSEC_LOOKBACK_PERIOD: '1h',
        CROWDSEC_ALERT_SYNC_CHUNK: '1h',
        CROWDSEC_ALERT_SYNC_MIN_CHUNK: '15m',
      },
      fetchResolver: (url) => {
        if (!url.includes('/v1/alerts?')) return undefined;
        const parsed = new URL(url);
        const params = parsed.searchParams;
        if (
          params.get('has_active_decision') === 'true' &&
          params.get('since')?.startsWith('1h') &&
          params.get('until') === '0h0m0s'
        ) {
          const error = new Error('Request timeout') as Error & { code?: string };
          error.code = 'ETIMEDOUT';
          throw error;
        }
        if (params.get('has_active_decision') === 'true') {
          return Response.json([activeAlert]);
        }
        return Response.json([]);
      },
    });

    const alerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alerts.status).toBe(200);
    expect(database.getDecisionById('810')).not.toBeNull();
    expect(controller.getSyncStatus().state).toBe('complete');

    const activeRequests = fetchCalls.filter((call) =>
      call.url.includes('/v1/alerts?') && call.url.includes('has_active_decision=true'),
    );
    expect(activeRequests.length).toBeGreaterThan(3);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('keeps the initial sync visible until indexes and dashboard data are finalized', async () => {
    let releaseIndexRebuild = () => {};
    const indexRebuild = new Promise<void>((resolve) => {
      releaseIndexRebuild = resolve;
    });
    const syncWorker: NonNullable<CreateAppOptions['syncWorker']> = {
      persistAlerts: vi.fn(async () => ({ changed: false })),
      deleteAlertsMissingBetween: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      deleteCachedAlerts: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      deleteCachedDecisions: vi.fn(async () => 0),
      beginDeferredSearchIndexUpdates: vi.fn(async () => {}),
      rebuildSearchIndexes: vi.fn(() => indexRebuild),
      refreshDecisionDuplicateFlags: vi.fn(async () => {}),
      cleanupOldData: vi.fn(async () => ({ alerts: 0, decisions: 0 })),
      clearSyncData: vi.fn(async () => {}),
      close: vi.fn(),
    };
    const { controller, database } = createController({ syncWorker });

    const alertsRequest = controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    await vi.waitFor(() => expect(syncWorker.rebuildSearchIndexes).toHaveBeenCalled());
    expect(controller.getSyncStatus()).toEqual(expect.objectContaining({
      isSyncing: true,
      progress: 100,
      completedAt: null,
    }));

    releaseIndexRebuild();
    expect((await alertsRequest).status).toBe(200);
    expect(controller.getSyncStatus()).toEqual(expect.objectContaining({
      isSyncing: false,
      progress: 100,
      completedAt: expect.any(String),
    }));

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('marks bootstrap partial when minimum active windows fail and skips active pruning', async () => {
    const activeAlert = sampleAlert({
      id: 91,
      uuid: 'alert-91',
      decisions: [{
        id: 910,
        type: 'ban',
        value: '9.9.9.9',
        duration: '30m',
        origin: 'crowdsec',
        simulated: false,
      }],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { controller, database } = createController({
      env: {
        CROWDSEC_LOOKBACK_PERIOD: '30m',
        CROWDSEC_ALERT_SYNC_CHUNK: '30m',
        CROWDSEC_ALERT_SYNC_MIN_CHUNK: '30m',
        CROWDSEC_BOOTSTRAP_RETRY_DELAY: '5m',
      },
      fetchResolver: (url) => {
        if (!url.includes('/v1/alerts?')) return undefined;
        if (url.includes('has_active_decision=true')) {
          const error = new Error('Request timeout') as Error & { code?: string };
          error.code = 'ETIMEDOUT';
          throw error;
        }
        return Response.json([activeAlert]);
      },
    });

    try {
      const alerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
      expect(alerts.status).toBe(200);
      expect(database.getDecisionById('910')).not.toBeNull();
      expect(controller.getSyncStatus()).toEqual(expect.objectContaining({
        state: 'partial',
        errors: expect.arrayContaining([expect.stringContaining('Active decisions')]),
      }));

      const logs = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      const warnings = warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logs).not.toContain('Cache initialized successfully');
      expect(warnings).toContain('Cache initialized partially');
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
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
        if (url.includes('/v1/alerts?') && url.includes('has_active_decision=true')) {
          return Response.json([]);
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
        CROWDSEC_LOOKBACK_PERIOD: '1m',
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

    const bootstrap = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(bootstrap.status).toBe(200);

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

  test('runs IP ban notification evaluation after adding a manual decision', async () => {
    const manualAlert = sampleManualWebUiAlert({
      id: 377,
      uuid: 'alert-377',
      created_at: new Date().toISOString(),
      source: {
        ip: '203.0.113.10',
        value: '203.0.113.10',
      },
      decisions: [
        {
          id: 3770,
          type: 'ban',
          value: '203.0.113.10',
          duration: '4h',
          stop_at: new Date(Date.now() + 4 * 60 * 60 * 1_000).toISOString(),
          origin: 'cscli',
          scenario: 'manual/web-ui',
          simulated: false,
        },
      ],
    });

    const { controller, database } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
        CROWDSEC_LOOKBACK_PERIOD: '1m',
      },
      fetchResolver: (url, init) => {
        if (url.endsWith('/v1/alerts') && init?.method === 'POST') {
          return Response.json({ ok: true });
        }
        if (url.includes('/v1/alerts?')) {
          return Response.json([manualAlert]);
        }
        return undefined;
      },
    });

    const createRule = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Manual bans',
          type: 'ip-ban',
          enabled: true,
          severity: 'warning',
          channel_ids: [],
          config: {
            window_minutes: 60,
            filters: {
              values: ['203.0.113.10'],
            },
          },
        }),
      }),
    );
    expect(createRule.status).toBe(201);

    const addDecision = await controller.fetch(
      new Request('http://localhost/crowdsec/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: '203.0.113.10',
          type: 'ban',
          duration: '4h',
          reason: 'manual test',
        }),
      }),
    );
    expect(addDecision.status).toBe(200);

    const notifications = await controller.fetch(new Request('http://localhost/crowdsec/api/notifications'));
    expect(notifications.status).toBe(200);
    expect((await notifications.json()) as {
      data: Array<{ rule_type: string; metadata: Record<string, unknown> }>;
    }).toEqual(expect.objectContaining({
      data: [
        expect.objectContaining({
          rule_type: 'ip-ban',
          metadata: expect.objectContaining({
            decision_id: '3770',
            value: '203.0.113.10',
          }),
        }),
      ],
    }));

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('does not wait for outbound IP ban notification delivery when adding a manual decision', async () => {
    const manualAlert = sampleManualWebUiAlert({
      id: 399,
      uuid: 'alert-399',
      created_at: new Date().toISOString(),
      source: {
        ip: '1.2.3.4',
        value: '1.2.3.4',
      },
      decisions: [
        {
          id: 3990,
          type: 'ban',
          value: '1.2.3.4',
          duration: '4h',
          stop_at: new Date(Date.now() + 4 * 60 * 60 * 1_000).toISOString(),
          origin: 'cscli',
          scenario: 'manual/web-ui',
          simulated: false,
        },
      ],
    });
    let releaseNotification!: () => void;
    let notificationStarted = false;
    let notificationFinished = false;
    const notificationGate = new Promise<void>((resolve) => {
      releaseNotification = resolve;
    });

    const { controller, database } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
        CROWDSEC_LOOKBACK_PERIOD: '168h',
      },
      fetchResolver: (url, init) => {
        if (url.endsWith('/v1/alerts') && init?.method === 'POST') {
          return Response.json({ ok: true });
        }
        if (url.includes('/v1/alerts?')) {
          return Response.json([manualAlert]);
        }
        return undefined;
      },
      notificationFetchResolver: async () => {
        notificationStarted = true;
        await notificationGate;
        notificationFinished = true;
        return Response.json({ ok: true });
      },
    });

    const bootstrap = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(bootstrap.status).toBe(200);

    const createChannel = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Slow webhook',
          type: 'webhook',
          enabled: true,
          config: {
            url: 'https://example.com/webhook',
            method: 'POST',
            retryAttempts: 0,
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
          name: 'CrowdSec: IP Ban',
          type: 'ip-ban',
          enabled: true,
          severity: 'warning',
          channel_ids: [channelPayload.id],
          config: {
            window_minutes: 60,
            filters: {
              values: ['1.2.3.4'],
            },
          },
        }),
      }),
    );
    expect(createRule.status).toBe(201);

    const addDecision = await controller.fetch(
      new Request('http://localhost/crowdsec/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: '1.2.3.4',
          type: 'ban',
          duration: '4h',
          reason: 'manual test',
        }),
      }),
    );

    expect(addDecision.status).toBe(200);
    expect(notificationFinished).toBe(false);

    await vi.waitFor(() => expect(notificationStarted).toBe(true));

    releaseNotification();
    for (let index = 0; index < 10 && !notificationFinished; index += 1) {
      await Promise.resolve();
    }
    expect(notificationFinished).toBe(true);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('treats duration-only decisions as remaining time from sync', async () => {
    const remainingMs = 44 * 60 * 1_000 + 40 * 1_000;
    const createdAt = new Date(Date.now() - 4 * 60 * 60 * 1_000).toISOString();
    const durationOnlyAlert = sampleManualWebUiAlert({
      id: 388,
      uuid: 'alert-388',
      created_at: createdAt,
      decisions: [
        {
          id: 3880,
          type: 'ban',
          value: '1.2.3.4',
          duration: '44m40s',
          origin: 'cscli',
          scenario: 'manual/web-ui',
          simulated: false,
        },
      ],
    });

    const { controller, database } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
        CROWDSEC_LOOKBACK_PERIOD: '168h',
      },
      fetchResolver: (url) => {
        if (url.includes('/v1/alerts?')) {
          return Response.json([durationOnlyAlert]);
        }
        return undefined;
      },
    });

    const beforeRefresh = Date.now();
    const firstRefresh = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    const afterRefresh = Date.now();
    expect(firstRefresh.status).toBe(200);
    const cachedStopAt = Date.parse(database.getDecisionById('3880')?.stop_at || '');
    expect(cachedStopAt).toBeGreaterThanOrEqual(beforeRefresh + remainingMs);
    expect(cachedStopAt).toBeLessThanOrEqual(afterRefresh + remainingMs);
    expect(cachedStopAt).toBeGreaterThan(Date.now());

    const decisionsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions?page=1&page_size=50&alert_id=388&include_expired=true'));
    expect(decisionsResponse.status).toBe(200);
    const decisionsJson = await decisionsResponse.json() as {
      data: Array<{ id: number; expired: boolean; detail: { duration: string } }>;
      selectable_ids: number[];
    };
    expect(decisionsJson.data).toEqual([
      expect.objectContaining({
        id: 3880,
        expired: false,
        detail: expect.objectContaining({ duration: '44m40s' }),
      }),
    ]);
    expect(decisionsJson.selectable_ids).toEqual([3880]);

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

  test('exposes truncated remote notification response snippets to clients', async () => {
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
      error: 'Webhook request failed with status 500: internal token leaked',
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
      rule_name: 'Test notification',
      rule_type: 'test',
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
        if (url.includes('/v1/alerts?') && !url.includes('has_active_decision=true')) {
          return Response.json([replayAlert]);
        }
        if (url.includes('/v1/alerts?')) {
          return Response.json([]);
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

    const storedAlert = database.db.query('SELECT raw_data FROM alerts WHERE id = 6').get() as { raw_data: string };
    expect(JSON.parse(storedAlert.raw_data)).toEqual(expect.objectContaining({
      scenario: 'crowdsecurity/appsec-vpatch',
    }));

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });
});
