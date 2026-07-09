import { rmSync } from 'node:fs';
import path from 'node:path';
import { parseLookbackToMs } from '../server/config';
import { CrowdsecDatabase } from '../server/database';

const DEFAULT_ALERTS = 300_000;
const DEFAULT_DECISIONS = 300_000;
const DEFAULT_SEED = 1337;
const DEFAULT_DB_DIR = path.join(process.env.TMPDIR || '/tmp', 'crowdsec-web-ui-load-test');
const DEFAULT_ACTIVE_DECISION_RATIO = 0.7;
const DEFAULT_SIMULATION_RATIO = 0.1;
const DEFAULT_DUPLICATE_VALUE_RATIO = 0.15;

interface LoadTestConfig {
  alerts: number;
  decisions: number;
  seed: number;
  dbDir: string;
  activeDecisionRatio: number;
  simulationRatio: number;
  duplicateValueRatio: number;
  lookbackMs: number;
}

interface AlertTemplate {
  id: number;
  createdAt: string;
  scenario: string;
  reason: string;
  ip: string;
  country: string;
  asName: string;
  asNumber: number;
  target: string;
  machine: string;
  origin: string;
  latitude: number;
  longitude: number;
  simulated: boolean;
  eventsCount: number;
}

interface DecisionTemplate {
  id: number;
  alertId: number;
  createdAt: string;
  stopAt: string;
  value: string;
  type: string;
  origin: string;
  scenario: string;
  machine: string;
  country: string;
  asName: string;
  target: string;
  simulated: boolean;
  duration: string;
}

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

const origins = ['crowdsec', 'CAPI', 'manual', 'cscli-import', 'lists'] as const;

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

function readConfig(): LoadTestConfig {
  return {
    alerts: parseIntegerEnv('LOADTEST_ALERTS', DEFAULT_ALERTS),
    decisions: parseIntegerEnv('LOADTEST_DECISIONS', DEFAULT_DECISIONS),
    seed: parseIntegerEnv('LOADTEST_SEED', DEFAULT_SEED),
    dbDir: process.env.LOADTEST_DB_DIR || process.env.DB_DIR || DEFAULT_DB_DIR,
    activeDecisionRatio: parseRatioEnv('LOADTEST_ACTIVE_DECISION_RATIO', DEFAULT_ACTIVE_DECISION_RATIO),
    simulationRatio: parseRatioEnv('LOADTEST_SIMULATION_RATIO', DEFAULT_SIMULATION_RATIO),
    duplicateValueRatio: parseRatioEnv('LOADTEST_DUPLICATE_VALUE_RATIO', DEFAULT_DUPLICATE_VALUE_RATIO),
    lookbackMs: parseLookbackToMs(process.env.CROWDSEC_LOOKBACK_PERIOD || '30d'),
  };
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

function duplicateIpFor(index: number, seed: number): string {
  return ipFor(10_000_000 + (hash32(index, seed) % 512), seed);
}

function isoFromOffset(nowMs: number, offsetMs: number): string {
  return new Date(nowMs - offsetMs).toISOString();
}

function buildAlertTemplate(id: number, config: LoadTestConfig, nowMs: number): AlertTemplate {
  const scenarioTuple = pick(scenarios, id, config.seed, 11);
  const countryTuple = pick(countries, id, config.seed, 17);
  const asTuple = pick(asNames, id, config.seed, 23);
  const createdAt = isoFromOffset(nowMs, Math.floor(fraction(id, config.seed, 29) * config.lookbackMs * 0.95));
  return {
    id,
    createdAt,
    scenario: scenarioTuple[0],
    reason: scenarioTuple[1],
    ip: ipFor(id, config.seed),
    country: countryTuple[0],
    asName: asTuple[0],
    asNumber: asTuple[1],
    target: scenarioTuple[2],
    machine: pick(machines, id, config.seed, 31),
    origin: pick(origins, id, config.seed, 37),
    latitude: countryTuple[1] + (fraction(id, config.seed, 41) - 0.5) * 4,
    longitude: countryTuple[2] + (fraction(id, config.seed, 43) - 0.5) * 4,
    simulated: fraction(id, config.seed, 47) < config.simulationRatio,
    eventsCount: 1 + Math.floor(fraction(id, config.seed, 53) * 120),
  };
}

function decisionAlertId(decisionId: number, alertCount: number): number {
  if (alertCount <= 0) return 0;
  return ((decisionId - 1) % alertCount) + 1;
}

function buildDecisionTemplate(
  id: number,
  alert: AlertTemplate,
  config: LoadTestConfig,
  nowMs: number,
): DecisionTemplate {
  const active = fraction(id, config.seed, 59) < config.activeDecisionRatio;
  const duplicate = fraction(id, config.seed, 61) < config.duplicateValueRatio;
  const simulated = alert.simulated || fraction(id, config.seed, 67) < config.simulationRatio;
  const hours = 1 + Math.floor(fraction(id, config.seed, 71) * 168);
  const stopOffsetMs = hours * 3_600_000;
  const stopAt = new Date(nowMs + (active ? stopOffsetMs : -stopOffsetMs)).toISOString();

  return {
    id,
    alertId: alert.id,
    createdAt: alert.createdAt,
    stopAt,
    value: duplicate ? duplicateIpFor(id, config.seed) : alert.ip,
    type: fraction(id, config.seed, 73) < 0.08 ? 'captcha' : 'ban',
    origin: alert.origin,
    scenario: alert.scenario,
    machine: alert.machine,
    country: alert.country,
    asName: alert.asName,
    target: alert.target,
    simulated,
    duration: `${hours}h`,
  };
}

function decisionSummary(decision: DecisionTemplate) {
  return {
    id: String(decision.id),
    type: decision.type,
    value: decision.value,
    duration: decision.duration,
    stop_at: decision.stopAt,
    created_at: decision.createdAt,
    origin: decision.origin,
    scenario: decision.scenario,
    simulated: decision.simulated,
  };
}

function buildEvents(alert: AlertTemplate) {
  return [{
    timestamp: alert.createdAt,
    meta: [
      { key: 'target_fqdn', value: alert.target },
      { key: 'service', value: alert.target },
      { key: 'log_type', value: alert.target === 'ssh' ? 'auth' : 'access' },
      { key: 'method', value: alert.target === 'ssh' ? 'password' : 'GET' },
      { key: 'status', value: alert.target === 'ssh' ? 'failed' : '403' },
    ],
  }];
}

function buildEmbeddedDecisions(alert: AlertTemplate, config: LoadTestConfig, nowMs: number) {
  if (config.decisions === 0 || config.alerts === 0) return [];
  const decisions = [];
  for (let decisionId = alert.id; decisionId <= config.decisions; decisionId += config.alerts) {
    decisions.push(decisionSummary(buildDecisionTemplate(decisionId, alert, config, nowMs)));
  }
  return decisions;
}

function buildAlertRecord(alert: AlertTemplate, config: LoadTestConfig, nowMs: number) {
  const decisions = buildEmbeddedDecisions(alert, config, nowMs);
  return {
    id: alert.id,
    uuid: `loadtest-alert-${alert.id}`,
    created_at: alert.createdAt,
    scenario: alert.scenario,
    reason: alert.reason,
    message: `${alert.eventsCount} events matched ${alert.scenario} from ${alert.ip}`,
    machine_id: alert.machine,
    machine_alias: alert.machine,
    events_count: alert.eventsCount,
    events: buildEvents(alert),
    decisions,
    target: alert.target,
    simulated: alert.simulated,
    source: {
      scope: 'ip',
      value: alert.ip,
      ip: alert.ip,
      cn: alert.country,
      as_name: alert.asName,
      as_number: alert.asNumber,
      latitude: Number(alert.latitude.toFixed(4)),
      longitude: Number(alert.longitude.toFixed(4)),
    },
  };
}

function buildDecisionRecord(decision: DecisionTemplate) {
  return {
    ...decisionSummary(decision),
    alert_id: decision.alertId,
    machine_id: decision.machine,
    machine_alias: decision.machine,
    machine: decision.machine,
    country: decision.country,
    as: decision.asName,
    target: decision.target,
    reason: decision.scenario,
  };
}

function removeExistingDatabase(dbDir: string): void {
  const dbPath = path.join(dbDir, 'crowdsec.db');
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
}

function logProgress(label: string, current: number, total: number): void {
  if (total === 0 || current === total || current % 25_000 === 0) {
    console.log(`${label}: ${current.toLocaleString('en-US')}/${total.toLocaleString('en-US')}`);
  }
}

function formatElapsed(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  return `${(ms / 1_000).toFixed(2)}s`;
}

const config = readConfig();
const dbPath = path.join(config.dbDir, 'crowdsec.db');
const nowMs = Date.now();
const seedStartedAt = Date.now();

console.log(`Seeding load-test database at ${dbPath}`);
console.log(`Alerts: ${config.alerts.toLocaleString('en-US')}`);
console.log(`Decisions: ${config.decisions.toLocaleString('en-US')}`);
console.log(`Seed: ${config.seed}`);

removeExistingDatabase(config.dbDir);

const database = new CrowdsecDatabase({ dbDir: config.dbDir });
database.beginDeferredSearchIndexUpdates();

const insertAlertsBatch = database.db.transaction((start: number, end: number) => {
  for (let id = start; id <= end; id += 1) {
    const alert = buildAlertTemplate(id, config, nowMs);
    const record = buildAlertRecord(alert, config, nowMs);
    database.insertAlert({
      $id: String(alert.id),
      $uuid: String(record.uuid),
      $created_at: alert.createdAt,
      $scenario: alert.scenario,
      $source_ip: alert.ip,
      $message: String(record.message),
      $raw_data: JSON.stringify(record),
      $record: record,
    });
  }
});

const insertDecisionsBatch = database.db.transaction((start: number, end: number) => {
  for (let id = start; id <= end; id += 1) {
    const alertId = decisionAlertId(id, config.alerts);
    const alert = buildAlertTemplate(alertId, config, nowMs);
    const decision = buildDecisionTemplate(id, alert, config, nowMs);
    const record = buildDecisionRecord(decision);
    database.insertDecision({
      $id: String(decision.id),
      $uuid: `loadtest-decision-${decision.id}`,
      $alert_id: String(decision.alertId),
      $created_at: decision.createdAt,
      $stop_at: decision.stopAt,
      $value: decision.value,
      $type: decision.type,
      $origin: decision.origin,
      $scenario: decision.scenario,
      $raw_data: JSON.stringify(record),
      $record: record,
    });
  }
});

const batchSize = 25_000;
const alertSeedStartedAt = Date.now();
for (let start = 1; start <= config.alerts; start += batchSize) {
  const end = Math.min(config.alerts, start + batchSize - 1);
  insertAlertsBatch(start, end);
  logProgress('Alerts', end, config.alerts);
}
console.log(`Alert seeding completed in ${formatElapsed(Date.now() - alertSeedStartedAt)}.`);

const decisionSeedStartedAt = Date.now();
for (let start = 1; start <= config.decisions; start += batchSize) {
  const end = Math.min(config.decisions, start + batchSize - 1);
  insertDecisionsBatch(start, end);
  logProgress('Decisions', end, config.decisions);
}
console.log(`Decision seeding completed in ${formatElapsed(Date.now() - decisionSeedStartedAt)}.`);

console.log('Rebuilding search indexes...');
const indexRebuildStartedAt = Date.now();
database.rebuildSearchIndexes();
console.log(`Search index rebuild completed in ${formatElapsed(Date.now() - indexRebuildStartedAt)}.`);
database.setMeta('refresh_interval_ms', '300000');
database.close();

console.log(`Seeded load-test database at ${dbPath}`);
console.log(`Total load-test seed time: ${formatElapsed(Date.now() - seedStartedAt)}.`);
