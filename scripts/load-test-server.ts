import { serve } from '@hono/node-server';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import path from 'node:path';
import type { AlertDecision, AlertRecord } from '../shared/contracts';
import { createApp } from '../server/app';
import { createRuntimeConfig } from '../server/config';
import { CrowdsecDatabase } from '../server/database';
import { installTimestampedConsole } from '../server/logging';
import { parseGoDuration } from '../server/utils/duration';
import {
  createLoadTestRuntimeEnv,
  ensureLoadTestUser,
  LOAD_TEST_PASSWORD,
  LOAD_TEST_USERNAME,
} from './load-test-auth';
import {
  DEFAULT_LOAD_TEST_BLOCKLIST_DECISIONS,
  getLoadTestSourceAlertIdForDecision,
  normalizeLoadTestBlocklistDecisionCount,
} from './load-test-shape';

const LOADTEST_SOURCE_TABLE = 'loadtest_alert_source';
installTimestampedConsole();
const dbDir = process.env.LOADTEST_DB_DIR || process.env.DB_DIR || path.join(process.env.TMPDIR || '/tmp', 'crowdsec-web-ui-load-test');
const port = Number(process.env.LOADTEST_BACKEND_PORT || process.env.PORT || 3000);
const database = new CrowdsecDatabase({ dbDir });
const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
eventLoopDelay.enable();
const eventLoopDelayReporter = setInterval(() => {
  const maxDelayMs = eventLoopDelay.max / 1_000_000;
  if (maxDelayMs >= 100) {
    console.warn(`[loadtest event-loop] blocked for up to ${maxDelayMs.toFixed(0)}ms during the last second`);
  }
  eventLoopDelay.reset();
}, 1_000);
const initialAlertCount = parseIntegerEnv('LOADTEST_ALERTS', 300_000);
const initialDecisionCount = parseIntegerEnv('LOADTEST_DECISIONS', 300_000);
const initialBlocklistDecisionCount = normalizeLoadTestBlocklistDecisionCount(
  initialAlertCount,
  initialDecisionCount,
  parseIntegerEnv('LOADTEST_BLOCKLIST_DECISIONS', DEFAULT_LOAD_TEST_BLOCKLIST_DECISIONS),
);
const refreshAlertCount = parseIntegerEnv('LOADTEST_REFRESH_ALERTS', 100);
const refreshDecisionCount = parseIntegerEnv('LOADTEST_REFRESH_DECISIONS', 100);
const loadTestSeed = parseIntegerEnv('LOADTEST_SEED', 1337);
const activeDecisionRatio = parseRatioEnv('LOADTEST_ACTIVE_DECISION_RATIO', 0.7);
const simulationRatio = parseRatioEnv('LOADTEST_SIMULATION_RATIO', 0.1);

const config = createRuntimeConfig({
  ...createLoadTestRuntimeEnv(process.env),
  PORT: String(port),
  DB_DIR: dbDir,
  CROWDSEC_REFRESH_INTERVAL: process.env.CROWDSEC_REFRESH_INTERVAL || '1m',
  CROWDSEC_LOOKBACK_PERIOD: process.env.CROWDSEC_LOOKBACK_PERIOD || '30d',
  CROWDSEC_HEARTBEAT_INTERVAL: '0',
  CROWDSEC_BOOTSTRAP_RETRY_ENABLED: 'false',
  CROWDSEC_SIMULATIONS_ENABLED: process.env.CROWDSEC_SIMULATIONS_ENABLED || 'true',
  CROWDSEC_WEB_UI_MODE: 'load-test',
  VITE_VERSION: process.env.VITE_VERSION || 'loadtest',
  VITE_BRANCH: process.env.VITE_BRANCH || 'loadtest',
  VITE_COMMIT_HASH: process.env.VITE_COMMIT_HASH || 'loadtest',
});
const authEnabled = config.dashboardAuth.enabled ?? !database.isAuthMigrationDefaultDisabled();
await ensureLoadTestUser(database, authEnabled);

ensureLoadTestSourceTable(database);

const dynamicAlerts = new Map<string, AlertRecord>();
const loadTestStartedAt = Date.now();
let generatedBatches = 0;
let nextGeneratedAlertId = initialAlertCount + 1;
let nextGeneratedDecisionId = initialDecisionCount + 1;
const getSourceAlertStatement = database.db.prepare(`SELECT raw_data FROM ${LOADTEST_SOURCE_TABLE} WHERE id = ?`);
const updateSourceAlertStatement = database.db.prepare(`
  UPDATE ${LOADTEST_SOURCE_TABLE}
  SET scenario = ?, origins = ?, raw_data = ?
  WHERE id = ?
`);
const deleteSourceAlertStatement = database.db.prepare(`DELETE FROM ${LOADTEST_SOURCE_TABLE} WHERE id = ?`);

const lapiStatus = {
  isConnected: true,
  lastCheck: new Date().toISOString(),
  lastError: null as string | null,
  offline_since: null as string | null,
};

const scenarios = [
  ['crowdsecurity/ssh-bf', 'SSH brute force', 'ssh'],
  ['crowdsecurity/http-probing', 'HTTP probing', 'reverse-proxy'],
  ['crowdsecurity/http-cve-probing', 'HTTP CVE probing', 'app'],
  ['crowdsecurity/appsec-vpatch', 'Virtual patch match', 'appsec'],
  ['crowdsecurity/mysql-bf', 'MySQL brute force', 'database'],
  ['crowdsecurity/postfix-spam', 'Postfix spam attempt', 'mail'],
  ['crowdsecurity/nginx-req-limit-exceeded', 'HTTP rate limit exceeded', 'reverse-proxy'],
] as const;

const countries = [
  ['US', 37.7749, -122.4194],
  ['DE', 50.1109, 8.6821],
  ['NL', 52.3676, 4.9041],
  ['FR', 48.8566, 2.3522],
  ['GB', 51.5072, -0.1276],
  ['BR', -23.5505, -46.6333],
  ['IN', 28.6139, 77.2090],
  ['JP', 35.6762, 139.6503],
  ['SG', 1.3521, 103.8198],
  ['AU', -33.8688, 151.2093],
] as const;

const asNames = [
  ['Hetzner Online GmbH', 24940],
  ['DigitalOcean LLC', 14061],
  ['OVH SAS', 16276],
  ['Amazon.com, Inc.', 16509],
  ['Google LLC', 15169],
  ['Microsoft Corporation', 8075],
  ['Akamai Technologies', 20940],
  ['Comcast Cable', 7922],
  ['Telecom Italia', 3269],
  ['NTT Communications', 2914],
] as const;

const machines = [
  'edge-gateway-01',
  'edge-gateway-02',
  'proxy-01',
  'proxy-02',
  'appsec-01',
  'mail-01',
  'database-01',
  'dev-bastion',
] as const;

const refreshOrigins = ['crowdsec', 'manual', 'cscli-import', 'lists'] as const;

function parseIntegerEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function parseRatioEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be a number between 0 and 1.`);
  }
  return parsed;
}

function ensureLoadTestSourceTable(database: CrowdsecDatabase): void {
  database.db.exec(`
    CREATE TABLE IF NOT EXISTS ${LOADTEST_SOURCE_TABLE} (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      scenario TEXT,
      origins TEXT,
      raw_data TEXT NOT NULL
    );
  `);

  const columns = database.db.prepare(`PRAGMA table_info(${LOADTEST_SOURCE_TABLE})`).all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('scenario')) {
    database.db.exec(`ALTER TABLE ${LOADTEST_SOURCE_TABLE} ADD COLUMN scenario TEXT`);
  }
  if (!names.has('origins')) {
    database.db.exec(`ALTER TABLE ${LOADTEST_SOURCE_TABLE} ADD COLUMN origins TEXT`);
  }

  database.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_${LOADTEST_SOURCE_TABLE}_created_at
      ON ${LOADTEST_SOURCE_TABLE}(created_at);
    DROP INDEX IF EXISTS idx_${LOADTEST_SOURCE_TABLE}_active_created_at;
  `);
}

function hash32(value: number, seed: number): number {
  let next = Math.imul(value ^ seed, 0x45d9f3b);
  next ^= next >>> 16;
  next = Math.imul(next, 0x45d9f3b);
  next ^= next >>> 16;
  return next >>> 0;
}

function fraction(value: number, seed: number, salt: number): number {
  return hash32(value + Math.imul(salt, 1_000_003), seed) / 0x1_0000_0000;
}

function pick<T>(items: readonly T[], value: number, seed: number, salt: number): T {
  return items[hash32(value + salt, seed) % items.length];
}

function ipFor(index: number, seed: number): string {
  const value = hash32(index, seed);
  const second = 1 + (value % 223);
  const third = 1 + ((value >>> 8) % 254);
  const fourth = 1 + ((value >>> 16) % 254);
  return `45.${second}.${third}.${fourth}`;
}

function decisionSummary(decision: AlertDecision & { duration: string }) {
  return {
    id: decision.id,
    type: decision.type,
    value: decision.value,
    duration: decision.duration,
    stop_at: decision.stop_at,
    created_at: decision.created_at,
    origin: decision.origin,
    scenario: decision.scenario,
    simulated: decision.simulated,
  };
}

function buildEvents(createdAt: string, target: string) {
  return [{
    timestamp: createdAt,
    meta: [
      { key: 'target_fqdn', value: target },
      { key: 'service', value: target },
      { key: 'log_type', value: target === 'ssh' ? 'auth' : 'access' },
      { key: 'method', value: target === 'ssh' ? 'password' : 'GET' },
      { key: 'status', value: target === 'ssh' ? 'failed' : '403' },
    ],
  }];
}

function buildGeneratedAlert(alertId: number, createdAt: string, decisions: AlertDecision[] = []): AlertRecord {
  const scenarioTuple = pick(scenarios, alertId, loadTestSeed, 11);
  const countryTuple = pick(countries, alertId, loadTestSeed, 17);
  const asTuple = pick(asNames, alertId, loadTestSeed, 23);
  const ip = ipFor(alertId, loadTestSeed);
  const target = scenarioTuple[2];
  const machine = pick(machines, alertId, loadTestSeed, 31);
  const simulated = fraction(alertId, loadTestSeed, 47) < simulationRatio || decisions.some((decision) => decision.simulated === true);
  const eventsCount = 1 + Math.floor(fraction(alertId, loadTestSeed, 53) * 120);

  return {
    id: alertId,
    uuid: `loadtest-alert-${alertId}`,
    created_at: createdAt,
    scenario: scenarioTuple[0],
    reason: scenarioTuple[1],
    message: `${eventsCount} events matched ${scenarioTuple[0]} from ${ip}`,
    machine_id: machine,
    machine_alias: machine,
    events_count: eventsCount,
    events: buildEvents(createdAt, target),
    decisions,
    target,
    simulated,
    source: {
      scope: 'ip',
      value: ip,
      ip,
      cn: countryTuple[0],
      as_name: asTuple[0],
      as_number: asTuple[1],
      latitude: Number((countryTuple[1] + (fraction(alertId, loadTestSeed, 41) - 0.5) * 4).toFixed(4)),
      longitude: Number((countryTuple[2] + (fraction(alertId, loadTestSeed, 43) - 0.5) * 4).toFixed(4)),
    },
  };
}

function buildGeneratedDecision(decisionId: number, alert: AlertRecord, createdAt: string): AlertDecision & { duration: string } {
  const active = fraction(decisionId, loadTestSeed, 59) < activeDecisionRatio;
  const hours = 1 + Math.floor(fraction(decisionId, loadTestSeed, 71) * 168);
  const stopAt = new Date(Date.now() + (active ? hours : -hours) * 3_600_000).toISOString();
  const origin = pick(refreshOrigins, decisionId, loadTestSeed, 37);

  return {
    id: decisionId,
    type: fraction(decisionId, loadTestSeed, 73) < 0.08 ? 'captcha' : 'ban',
    value: alert.source?.value || ipFor(decisionId, loadTestSeed),
    duration: `${hours}h`,
    stop_at: stopAt,
    created_at: createdAt,
    origin,
    scenario: alert.scenario,
    simulated: alert.simulated === true || fraction(decisionId, loadTestSeed, 67) < simulationRatio,
  };
}

function generateLoadTestBatch(): void {
  const alertSlots = Math.max(refreshAlertCount, refreshDecisionCount > 0 && refreshAlertCount === 0 ? refreshDecisionCount : 0);
  if (alertSlots === 0 && refreshDecisionCount === 0) return;

  const createdAtBase = Date.now() - 1_000;
  const generated: AlertRecord[] = [];
  for (let index = 0; index < alertSlots; index += 1) {
    const alertId = nextGeneratedAlertId++;
    const createdAt = new Date(createdAtBase - index).toISOString();
    generated.push(buildGeneratedAlert(alertId, createdAt));
  }

  for (let index = 0; index < refreshDecisionCount; index += 1) {
    if (generated.length === 0) break;
    const alert = generated[index % generated.length];
    const decision = buildGeneratedDecision(nextGeneratedDecisionId++, alert, alert.created_at);
    alert.decisions = [...(alert.decisions || []), decisionSummary(decision)];
    alert.simulated = alert.simulated === true || decision.simulated === true;
  }

  for (const alert of generated) {
    dynamicAlerts.set(String(alert.id), alert);
  }

  if (generated.length > 0 || refreshDecisionCount > 0) {
    console.log(`[loadtest sync] added ${generated.length} alerts and ${refreshDecisionCount} decisions to fake LAPI`);
  }
}

function generateDueLoadTestData(forceBatch = false): void {
  if (config.refreshIntervalMs <= 0) {
    if (forceBatch) {
      generateLoadTestBatch();
    }
    return;
  }

  const dueBatches = Math.floor((Date.now() - loadTestStartedAt) / config.refreshIntervalMs);
  while (generatedBatches < dueBatches) {
    generateLoadTestBatch();
    generatedBatches += 1;
  }
}

function parseSyncBoundary(value: string | null, fallbackMs: number, nowMs: number): number {
  if (!value) return fallbackMs;
  const parsedDate = Date.parse(value);
  if (Number.isFinite(parsedDate)) return parsedDate;
  const durationMs = parseGoDuration(value);
  if (durationMs > 0) return nowMs - durationMs;
  return fallbackMs;
}

function getSyncWindow(since: string | null, until: string | null): { start: string; end: string } {
  const nowMs = Date.now();
  const startMs = parseSyncBoundary(since, nowMs - config.lookbackMs, nowMs);
  const endMs = parseSyncBoundary(until, nowMs + 1_000, nowMs);
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
  };
}

function alertOrigins(alert: AlertRecord): string[] {
  return (alert.decisions || [])
    .map((decision) => typeof decision.origin === 'string' ? decision.origin : '')
    .filter((origin) => origin.length > 0);
}

function matchesLoadTestFilters(alert: AlertRecord, filters: { origin?: string; scenario?: string; includeCapi?: boolean }): boolean {
  if (filters.scenario && alert.scenario !== filters.scenario) return false;

  const originsForAlert = alertOrigins(alert);
  if (filters.origin) {
    return originsForAlert.some((origin) => origin.toLowerCase() === filters.origin?.toLowerCase());
  }

  if (filters.includeCapi === false && originsForAlert.some((origin) => origin.toUpperCase() === 'CAPI')) {
    return false;
  }

  return true;
}

function parseSourceAlertRow(row: { raw_data?: string } | undefined | null): AlertRecord | null {
  if (!row?.raw_data) return null;
  try {
    return JSON.parse(row.raw_data) as AlertRecord;
  } catch {
    return null;
  }
}

function getSourceAlert(alertId: string | number): AlertRecord | null {
  return parseSourceAlertRow(getSourceAlertStatement.get(String(alertId)) as { raw_data?: string } | undefined);
}

function updateSourceAlert(alert: AlertRecord): void {
  updateSourceAlertStatement.run(
    alert.scenario || null,
    sourceOrigins(alert),
    JSON.stringify(alert),
    String(alert.id),
  );
}

function deleteSourceAlert(alertId: string | number): void {
  deleteSourceAlertStatement.run(String(alertId));
}

function getSourceAlertIdForDecision(decisionId: string | number): string | null {
  const parsed = Number.parseInt(String(decisionId), 10);
  if (!Number.isFinite(parsed)) return null;
  const alertId = getLoadTestSourceAlertIdForDecision(
    parsed,
    initialAlertCount,
    initialDecisionCount,
    initialBlocklistDecisionCount,
  );
  return alertId === null ? null : String(alertId);
}

function deleteSourceDecision(decisionId: string | number): void {
  const sourceAlertId = getSourceAlertIdForDecision(decisionId);
  if (!sourceAlertId) return;

  const alert = getSourceAlert(sourceAlertId);
  if (!alert) return;

  const decisions = alert.decisions || [];
  const nextDecisions = decisions.filter((decision) => String(decision.id) !== String(decisionId));
  if (nextDecisions.length === decisions.length) return;

  updateSourceAlert({
    ...alert,
    decisions: nextDecisions,
    simulated: alert.simulated === true || nextDecisions.some((decision) => decision.simulated === true),
  });
}

function loadAlertsFromSource(start: string, end: string): AlertRecord[] {
  const rows = database.db.prepare(`
    SELECT raw_data
    FROM ${LOADTEST_SOURCE_TABLE}
    WHERE created_at >= ? AND created_at < ?
    ORDER BY created_at DESC
  `).all(start, end) as Array<{ raw_data: string }>;

  return rows.flatMap((row) => {
    const alert = parseSourceAlertRow(row);
    return alert ? [alert] : [];
  });
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function sourceOrigins(alert: AlertRecord): string {
  const origins = new Set<string>();
  for (const decision of alert.decisions || []) {
    if (decision.origin) origins.add(String(decision.origin));
  }
  return `\n${Array.from(origins).join('\n')}\n`;
}

function loadAlertsFromSourceWithFilters(
  start: string,
  end: string,
  filters: { origin?: string; scenario?: string; includeCapi?: boolean },
): AlertRecord[] {
  const conditions = ['created_at >= ?', 'created_at < ?'];
  const params: unknown[] = [start, end];

  if (filters.scenario) {
    conditions.push('scenario = ?');
    params.push(filters.scenario);
  }
  if (filters.origin) {
    conditions.push("origins LIKE ? ESCAPE '\\'");
    params.push(`%\n${escapeLike(filters.origin)}\n%`);
  } else if (filters.includeCapi === false) {
    conditions.push("origins NOT LIKE '%\nCAPI\n%'");
  }

  const rows = database.db.prepare(`
    SELECT raw_data
    FROM ${LOADTEST_SOURCE_TABLE}
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC
  `).all(...params) as Array<{ raw_data: string }>;

  return rows.flatMap((row) => {
    const alert = parseSourceAlertRow(row);
    return alert ? [alert] : [];
  });
}

function loadSyntheticAlerts(since: string | null, until: string | null, filters: { origin?: string; scenario?: string; includeCapi?: boolean }): AlertRecord[] {
  generateDueLoadTestData(config.refreshIntervalMs <= 0 && until === null);
  const window = getSyncWindow(since, until);
  const merged = new Map<string, AlertRecord>();

  for (const alert of loadAlertsFromSourceWithFilters(window.start, window.end, filters)) {
    merged.set(String(alert.id), alert);
  }

  for (const alert of dynamicAlerts.values()) {
    if (alert.created_at >= window.start && alert.created_at < window.end && matchesLoadTestFilters(alert, filters)) {
      merged.set(String(alert.id), alert);
    }
  }

  return Array.from(merged.values()).sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
}

const fakeLapiClient = {
  hasAuthConfig: () => true,
  hasToken: () => true,
  login: async () => {
    lapiStatus.isConnected = true;
    lapiStatus.lastCheck = new Date().toISOString();
    lapiStatus.lastError = null;
    lapiStatus.offline_since = null;
    return true;
  },
  updateStatus: (isConnected = true, error: { message?: string } | null = null) => {
    lapiStatus.isConnected = isConnected;
    lapiStatus.lastCheck = new Date().toISOString();
    lapiStatus.lastError = error?.message || null;
    lapiStatus.offline_since = isConnected ? null : (lapiStatus.offline_since || lapiStatus.lastCheck);
  },
  getStatus: () => ({ ...lapiStatus }),
  heartbeat: async () => {},
  sendUsageMetrics: async () => {},
  fetchAlerts: async (
    since: string | null = null,
    until: string | null = null,
    filters: { origin?: string; scenario?: string; includeCapi?: boolean } = {},
  ) => loadSyntheticAlerts(since, until, filters),
  getAlertById: async (alertId: string | number) => {
    const dynamicAlert = dynamicAlerts.get(String(alertId));
    if (dynamicAlert) return dynamicAlert;
    const sourceAlert = getSourceAlert(alertId);
    if (sourceAlert) return sourceAlert;
    const row = database.db.prepare('SELECT raw_data FROM alerts WHERE id = ?').get(String(alertId)) as { raw_data?: string } | undefined;
    return row?.raw_data ? JSON.parse(row.raw_data) : null;
  },
  addDecision: async (ip: string, type: string, duration: string, reason = 'Manual decision from Web UI') => {
    const createdAt = new Date(Date.now() - 1_000).toISOString();
    const alertId = nextGeneratedAlertId++;
    const alert = buildGeneratedAlert(alertId, createdAt);
    alert.source = { ...(alert.source || {}), scope: 'ip', value: ip, ip };
    alert.scenario = 'manual/web-ui';
    alert.reason = reason;
    const stopAt = new Date(Date.now() + parseGoDuration(duration)).toISOString();
    alert.decisions = [{
      id: nextGeneratedDecisionId++,
      type,
      value: ip,
      duration,
      stop_at: stopAt,
      created_at: createdAt,
      origin: 'cscli',
      scenario: 'manual/web-ui',
      simulated: false,
    }];
    dynamicAlerts.set(String(alert.id), alert);
    return { message: 'Decision added for load-test demo' };
  },
  deleteDecision: async (decisionId: string | number) => {
    for (const alert of dynamicAlerts.values()) {
      alert.decisions = (alert.decisions || []).filter((decision) => String(decision.id) !== String(decisionId));
    }
    deleteSourceDecision(decisionId);
    return { message: 'Decision deleted for load-test demo' };
  },
  deleteAlert: async (alertId: string | number) => {
    dynamicAlerts.delete(String(alertId));
    deleteSourceAlert(alertId);
    return { message: 'Alert deleted for load-test demo' };
  },
};

const updateChecker = async () => ({
  update_available: false,
  current_version: 'loadtest',
  remote_version: 'loadtest',
  tag: 'loadtest',
  release_url: '',
  checked_at: new Date().toISOString(),
});

const controller = createApp({
  config,
  database,
  lapiClient: fakeLapiClient as never,
  startBackgroundTasks: true,
  updateChecker,
  initialCacheState: {
    isInitialized: false,
    isComplete: false,
    lastUpdate: null,
  },
  notificationFetchImpl: async () => new Response('ok', { status: 200 }),
  mqttPublishImpl: async () => {},
});

function formatElapsed(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  return `${(ms / 1_000).toFixed(2)}s`;
}

function isApiRequest(pathname: string): boolean {
  const basePath = controller.config.basePath;
  const apiPrefix = basePath ? `${basePath}/api` : '/api';
  return pathname === apiPrefix || pathname.startsWith(`${apiPrefix}/`);
}

async function fetchWithApiLogging(...args: Parameters<typeof controller.fetch>): Promise<Response> {
  const [request] = args;
  const url = new URL(request.url);
  const startedAt = Date.now();

  try {
    const response = await controller.fetch(...args);
    if (isApiRequest(url.pathname)) {
      console.log(`[loadtest api] ${request.method} ${url.pathname}${url.search} -> ${response.status} ${formatElapsed(Date.now() - startedAt)}`);
    }
    return response;
  } catch (error) {
    if (isApiRequest(url.pathname)) {
      console.log(`[loadtest api] ${request.method} ${url.pathname}${url.search} -> error ${formatElapsed(Date.now() - startedAt)}`);
    }
    throw error;
  }
}

const server = serve({
  fetch: fetchWithApiLogging,
  port: controller.config.port,
});

console.log(`Load-test backend running at http://127.0.0.1:${controller.config.port}/`);
if (authEnabled) {
  console.log(`Auth is enabled for load-test mode. Default login: ${LOAD_TEST_USERNAME} / ${LOAD_TEST_PASSWORD}`);
  console.log('A dummy passkey is attached to the load-test user so the passkey login flow can be exercised. Authentication is expected to fail.');
} else {
  console.log(`Auth is disabled for load-test mode.`);
}

let shutdownInProgress = false;

function shutdown() {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  process.exitCode = 0;
  clearInterval(eventLoopDelayReporter);
  eventLoopDelay.disable();
  controller.stopBackgroundTasks();
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
