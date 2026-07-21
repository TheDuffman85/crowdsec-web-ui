import fs from 'node:fs';
import path from 'node:path';
import { isSeq, parse as parseYaml, parseDocument as parseYamlDocument, stringify as stringifyYaml } from 'yaml';
import type { RuntimeConfig } from './config';
import { parseInstancesConfig, type CrowdsecInstanceConfig } from './instances-config';

type UnknownRecord = Record<string, unknown>;
type ConfigPath = readonly (string | number)[];

export interface ParsedConfigFile {
  environment: NodeJS.ProcessEnv;
  instances: CrowdsecInstanceConfig[];
  sqliteWalEnabled: boolean;
  updateCheckEnabled?: boolean;
}

// These values describe the build or bootstrap the process. They intentionally
// remain environment variables and are never treated as application settings.
const RETAINED_METADATA_ENV = [
  'DOCKER_IMAGE_REF',
  'VITE_VERSION',
  'VITE_BRANCH',
  'VITE_COMMIT_HASH',
  'CROWDSEC_WEB_UI_MODE',
  'LOADTEST_PROFILE',
] as const;

export const DEPRECATED_CONFIG_ENV = [
  'PORT', 'BASE_PATH', 'DB_DIR', 'GEONAMES_DUMP_DIR', 'TZ', 'TIME_FORMAT', 'CROWDSEC_TIME_FORMAT',
  'PERMISSION_READ_ONLY',
  'AUTH_ENABLED', 'CROWDSEC_AUTH_ENABLED',
  'AUTH_SECRET_FILE', 'AUTH_TOTP_SECRET_FILE', 'AUTH_TOTP_SEED_FILE',
  'AUTH_OIDC_ISSUER_URL', 'AUTH_OIDC_CLIENT_ID', 'AUTH_OIDC_CLIENT_SECRET_FILE', 'AUTH_OIDC_SCOPE',
  'AUTH_OIDC_GROUPS_CLAIM', 'AUTH_OIDC_ADMIN_GROUPS', 'AUTH_OIDC_READ_ONLY_GROUPS', 'AUTH_OIDC_UNMATCHED_ROLE',
  'CROWDSEC_AUTH_SECRET', 'CROWDSEC_AUTH_SECRET_FILE', 'CROWDSEC_AUTH_TOTP_SECRET', 'CROWDSEC_AUTH_TOTP_SECRET_FILE',
  'CROWDSEC_AUTH_TOTP_SEED', 'CROWDSEC_AUTH_TOTP_SEED_FILE', 'CROWDSEC_AUTH_OIDC_ISSUER_URL',
  'CROWDSEC_AUTH_OIDC_CLIENT_ID', 'CROWDSEC_AUTH_OIDC_CLIENT_SECRET', 'CROWDSEC_AUTH_OIDC_CLIENT_SECRET_FILE',
  'CROWDSEC_AUTH_OIDC_SCOPE', 'CROWDSEC_AUTH_OIDC_GROUPS_CLAIM', 'CROWDSEC_AUTH_OIDC_ADMIN_GROUPS',
  'CROWDSEC_AUTH_OIDC_READ_ONLY_GROUPS', 'CROWDSEC_AUTH_OIDC_UNMATCHED_ROLE',
  'CROWDSEC_INSTANCES_CONFIG_FILE', 'CROWDSEC_URL', 'CROWDSEC_USER', 'CROWDSEC_PASSWORD_FILE',
  'CROWDSEC_TLS_CERT_PATH', 'CROWDSEC_TLS_KEY_PATH', 'CROWDSEC_TLS_CA_CERT_PATH',
  'CROWDSEC_INSTANCE_NAME', 'CROWDSEC_INSTANCE_ICON', 'CROWDSEC_PROMETHEUS_URL',
  'CROWDSEC_PROMETHEUS_REQUEST_TIMEOUT', 'CROWDSEC_SIMULATIONS_ENABLED', 'CROWDSEC_LOOKBACK_PERIOD',
  'CROWDSEC_REFRESH_INTERVAL', 'CROWDSEC_MANUAL_REFRESH_ENABLED', 'CROWDSEC_IDLE_REFRESH_INTERVAL',
  'CROWDSEC_IDLE_THRESHOLD', 'CROWDSEC_LAPI_REQUEST_TIMEOUT', 'CROWDSEC_BOUNCER_PROPAGATION_DELAY',
  'CROWDSEC_HEARTBEAT_INTERVAL', 'CROWDSEC_ALERT_SYNC_CHUNK', 'CROWDSEC_ALERT_SYNC_MIN_CHUNK',
  'CROWDSEC_RECONCILE_WINDOW', 'CROWDSEC_RECONCILE_RECENT_AGE', 'CROWDSEC_RECONCILE_RECENT_INTERVAL',
  'CROWDSEC_RECONCILE_ACTIVE_INTERVAL', 'CROWDSEC_RECONCILE_OLD_INTERVAL',
  'CROWDSEC_RECONCILE_WINDOWS_PER_REFRESH', 'CROWDSEC_BOOTSTRAP_RETRY_DELAY',
  'CROWDSEC_BOOTSTRAP_RETRY_ENABLED', 'CROWDSEC_ALERT_INCLUDE_ORIGINS', 'CROWDSEC_ALERT_EXCLUDE_ORIGINS',
  'CROWDSEC_ALERT_INCLUDE_CAPI', 'CROWDSEC_ALERT_INCLUDE_ORIGIN_EMPTY', 'CROWDSEC_ALERT_EXCLUDE_ORIGIN_EMPTY',
  'CROWDSEC_ALERT_ORIGINS', 'CROWDSEC_ALERT_EXTRA_SCENARIOS',
  'NOTIFICATION_SECRET_KEY_FILE', 'NOTIFICATION_ALLOW_PRIVATE_ADDRESSES', 'NOTIFICATION_DEBUG_PAYLOADS',
] as const;

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Configuration error: ${label} must be an object.`);
  }
  return value as UnknownRecord;
}

function section(root: UnknownRecord, key: string): UnknownRecord {
  return root[key] === undefined ? {} : record(root[key], key);
}

function knownKeys(input: UnknownRecord, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`Configuration error: unknown ${label} setting(s): ${unknown.join(', ')}.`);
}

function string(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new Error(`Configuration error: ${label} must be ${allowEmpty ? 'a string' : 'a non-empty string'}.`);
  }
  return value.trim();
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Configuration error: ${label} must be a boolean.`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`Configuration error: ${label} must be a positive integer.`);
  }
  return Number(value);
}

function stringArray(value: unknown, label: string): string[] {
  const entries = Array.isArray(value) ? Array.from(value) : null;
  if (!entries || entries.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new Error(`Configuration error: ${label} must be an array of non-empty strings.`);
  }
  return [...new Set(entries.map((entry) => String(entry).trim()))];
}

function setString(env: NodeJS.ProcessEnv, input: UnknownRecord, key: string, envName: string, label: string, allowEmpty = false): void {
  if (input[key] !== undefined) env[envName] = string(input[key], `${label}.${key}`, allowEmpty);
}

function setDuration(env: NodeJS.ProcessEnv, input: UnknownRecord, key: string, envName: string, label: string, allowZero: boolean): void {
  if (input[key] === undefined) return;
  if (allowZero && input[key] === 0) {
    env[envName] = '0';
    return;
  }
  setString(env, input, key, envName, label);
}

function setBoolean(env: NodeJS.ProcessEnv, input: UnknownRecord, key: string, envName: string, label: string): void {
  if (input[key] !== undefined) env[envName] = String(boolean(input[key], `${label}.${key}`));
}

function setInteger(env: NodeJS.ProcessEnv, input: UnknownRecord, key: string, envName: string, label: string): void {
  if (input[key] !== undefined) env[envName] = String(positiveInteger(input[key], `${label}.${key}`));
}

function setArray(env: NodeJS.ProcessEnv, input: UnknownRecord, key: string, envName: string, label: string): void {
  if (input[key] !== undefined) env[envName] = stringArray(input[key], `${label}.${key}`).join(',');
}

function applySecretReference(
  value: unknown,
  label: string,
  env: NodeJS.ProcessEnv,
  sourceEnv: NodeJS.ProcessEnv,
  targetName: string,
): void {
  if (value === undefined) return;
  if (typeof value === 'string') {
    if (value.length === 0) throw new Error(`Configuration error: ${label} must be a non-empty string.`);
    env[targetName] = value;
    return;
  }
  const reference = record(value, label);
  knownKeys(reference, ['env', 'file'], label);
  const envName = reference.env === undefined ? undefined : string(reference.env, `${label}.env`);
  const file = reference.file === undefined ? undefined : string(reference.file, `${label}.file`);
  if ((envName ? 1 : 0) + (file ? 1 : 0) !== 1) {
    throw new Error(`Configuration error: ${label} must set exactly one of env or file.`);
  }
  if (envName) {
    const secret = sourceEnv[envName];
    if (!secret) throw new Error(`Configuration error: ${label}.env references missing or empty ${envName}.`);
    env[targetName] = secret;
    return;
  }
  env[`${targetName}_FILE`] = file;
}

export function parseApplicationConfig(parsed: unknown, sourceEnv: NodeJS.ProcessEnv): ParsedConfigFile {
  const root = record(parsed, 'config');
  knownKeys(root, ['server', 'storage', 'ui', 'auth', 'notifications', 'updates', 'crowdsec', 'instances'], 'root');

  const env: NodeJS.ProcessEnv = {};
  for (const name of RETAINED_METADATA_ENV) {
    if (sourceEnv[name] !== undefined) env[name] = sourceEnv[name];
  }

  const server = section(root, 'server');
  knownKeys(server, ['port', 'basePath'], 'server');
  setInteger(env, server, 'port', 'PORT', 'server');
  setString(env, server, 'basePath', 'BASE_PATH', 'server', true);

  const storage = section(root, 'storage');
  knownKeys(storage, ['dataDir', 'geonamesDir', 'walEnabled'], 'storage');
  setString(env, storage, 'dataDir', 'DB_DIR', 'storage');
  setString(env, storage, 'geonamesDir', 'GEONAMES_DUMP_DIR', 'storage');
  const sqliteWalEnabled = storage.walEnabled === undefined
    ? true
    : boolean(storage.walEnabled, 'storage.walEnabled');

  const ui = section(root, 'ui');
  knownKeys(ui, ['timeZone', 'timeFormat', 'readOnly'], 'ui');
  if (ui.timeZone !== undefined && ui.timeZone !== null && ui.timeZone !== 'browser') {
    env.TZ = string(ui.timeZone, 'ui.timeZone');
  }
  if (ui.timeFormat !== undefined && ui.timeFormat !== 'browser') setString(env, ui, 'timeFormat', 'TIME_FORMAT', 'ui');
  setBoolean(env, ui, 'readOnly', 'PERMISSION_READ_ONLY', 'ui');

  const auth = section(root, 'auth');
  knownKeys(auth, ['enabled', 'sessionSecret', 'totpSecret', 'totpSeed', 'oidc'], 'auth');
  if (auth.enabled !== undefined && auth.enabled !== 'auto') setBoolean(env, auth, 'enabled', 'AUTH_ENABLED', 'auth');
  applySecretReference(auth.sessionSecret, 'auth.sessionSecret', env, sourceEnv, 'AUTH_SECRET');
  applySecretReference(auth.totpSecret, 'auth.totpSecret', env, sourceEnv, 'AUTH_TOTP_SECRET');
  applySecretReference(auth.totpSeed, 'auth.totpSeed', env, sourceEnv, 'AUTH_TOTP_SEED');
  const oidc = auth.oidc === undefined ? {} : record(auth.oidc, 'auth.oidc');
  knownKeys(oidc, ['issuerUrl', 'clientId', 'clientSecret', 'scope', 'groupsClaim', 'adminGroups', 'readOnlyGroups', 'unmatchedRole'], 'auth.oidc');
  setString(env, oidc, 'issuerUrl', 'AUTH_OIDC_ISSUER_URL', 'auth.oidc');
  setString(env, oidc, 'clientId', 'AUTH_OIDC_CLIENT_ID', 'auth.oidc');
  applySecretReference(oidc.clientSecret, 'auth.oidc.clientSecret', env, sourceEnv, 'AUTH_OIDC_CLIENT_SECRET');
  setString(env, oidc, 'scope', 'AUTH_OIDC_SCOPE', 'auth.oidc');
  setString(env, oidc, 'groupsClaim', 'AUTH_OIDC_GROUPS_CLAIM', 'auth.oidc');
  setArray(env, oidc, 'adminGroups', 'AUTH_OIDC_ADMIN_GROUPS', 'auth.oidc');
  setArray(env, oidc, 'readOnlyGroups', 'AUTH_OIDC_READ_ONLY_GROUPS', 'auth.oidc');
  setString(env, oidc, 'unmatchedRole', 'AUTH_OIDC_UNMATCHED_ROLE', 'auth.oidc');

  const notifications = section(root, 'notifications');
  knownKeys(notifications, ['secretKey', 'allowPrivateAddresses', 'debugPayloads'], 'notifications');
  applySecretReference(notifications.secretKey, 'notifications.secretKey', env, sourceEnv, 'NOTIFICATION_SECRET_KEY');
  setBoolean(env, notifications, 'allowPrivateAddresses', 'NOTIFICATION_ALLOW_PRIVATE_ADDRESSES', 'notifications');
  setBoolean(env, notifications, 'debugPayloads', 'NOTIFICATION_DEBUG_PAYLOADS', 'notifications');

  const updates = section(root, 'updates');
  knownKeys(updates, ['enabled'], 'updates');
  const updateCheckEnabled = updates.enabled === undefined ? undefined : boolean(updates.enabled, 'updates.enabled');

  const crowdsec = section(root, 'crowdsec');
  knownKeys(crowdsec, ['simulationsEnabled', 'alertFilters', 'sync'], 'crowdsec');
  setBoolean(env, crowdsec, 'simulationsEnabled', 'CROWDSEC_SIMULATIONS_ENABLED', 'crowdsec');
  const filters = crowdsec.alertFilters === undefined ? {} : record(crowdsec.alertFilters, 'crowdsec.alertFilters');
  knownKeys(filters, ['includeOrigins', 'excludeOrigins', 'includeCapi', 'includeOriginEmpty', 'excludeOriginEmpty', 'legacy'], 'crowdsec.alertFilters');
  setArray(env, filters, 'includeOrigins', 'CROWDSEC_ALERT_INCLUDE_ORIGINS', 'crowdsec.alertFilters');
  setArray(env, filters, 'excludeOrigins', 'CROWDSEC_ALERT_EXCLUDE_ORIGINS', 'crowdsec.alertFilters');
  setBoolean(env, filters, 'includeCapi', 'CROWDSEC_ALERT_INCLUDE_CAPI', 'crowdsec.alertFilters');
  setBoolean(env, filters, 'includeOriginEmpty', 'CROWDSEC_ALERT_INCLUDE_ORIGIN_EMPTY', 'crowdsec.alertFilters');
  setBoolean(env, filters, 'excludeOriginEmpty', 'CROWDSEC_ALERT_EXCLUDE_ORIGIN_EMPTY', 'crowdsec.alertFilters');
  const legacyFilters = filters.legacy === undefined ? undefined : record(filters.legacy, 'crowdsec.alertFilters.legacy');
  if (legacyFilters) {
    knownKeys(legacyFilters, ['origins', 'extraScenarios'], 'crowdsec.alertFilters.legacy');
    setArray(env, legacyFilters, 'origins', 'CROWDSEC_ALERT_ORIGINS', 'crowdsec.alertFilters.legacy');
    setArray(env, legacyFilters, 'extraScenarios', 'CROWDSEC_ALERT_EXTRA_SCENARIOS', 'crowdsec.alertFilters.legacy');
  }

  const sync = crowdsec.sync === undefined ? {} : record(crowdsec.sync, 'crowdsec.sync');
  const syncKeys = {
    lookback: 'CROWDSEC_LOOKBACK_PERIOD', refreshInterval: 'CROWDSEC_REFRESH_INTERVAL',
    idleRefreshInterval: 'CROWDSEC_IDLE_REFRESH_INTERVAL', idleThreshold: 'CROWDSEC_IDLE_THRESHOLD',
    requestTimeout: 'CROWDSEC_LAPI_REQUEST_TIMEOUT', bouncerPropagationDelay: 'CROWDSEC_BOUNCER_PROPAGATION_DELAY',
    metricsRequestTimeout: 'CROWDSEC_PROMETHEUS_REQUEST_TIMEOUT', heartbeatInterval: 'CROWDSEC_HEARTBEAT_INTERVAL',
    alertSyncChunk: 'CROWDSEC_ALERT_SYNC_CHUNK', alertSyncMinChunk: 'CROWDSEC_ALERT_SYNC_MIN_CHUNK',
    reconcileWindow: 'CROWDSEC_RECONCILE_WINDOW', reconcileRecentAge: 'CROWDSEC_RECONCILE_RECENT_AGE',
    reconcileRecentInterval: 'CROWDSEC_RECONCILE_RECENT_INTERVAL', reconcileActiveInterval: 'CROWDSEC_RECONCILE_ACTIVE_INTERVAL',
    reconcileOldInterval: 'CROWDSEC_RECONCILE_OLD_INTERVAL', bootstrapRetryDelay: 'CROWDSEC_BOOTSTRAP_RETRY_DELAY',
  } as const;
  knownKeys(sync, [...Object.keys(syncKeys), 'manualRefreshEnabled', 'reconcileWindowsPerRefresh', 'bootstrapRetryEnabled'], 'crowdsec.sync');
  const zeroDurationKeys = new Set([
    'refreshInterval', 'idleRefreshInterval', 'idleThreshold', 'bouncerPropagationDelay',
    'heartbeatInterval', 'bootstrapRetryDelay',
  ]);
  for (const [key, envName] of Object.entries(syncKeys)) {
    setDuration(env, sync, key, envName, 'crowdsec.sync', zeroDurationKeys.has(key));
  }
  setBoolean(env, sync, 'manualRefreshEnabled', 'CROWDSEC_MANUAL_REFRESH_ENABLED', 'crowdsec.sync');
  setInteger(env, sync, 'reconcileWindowsPerRefresh', 'CROWDSEC_RECONCILE_WINDOWS_PER_REFRESH', 'crowdsec.sync');
  setBoolean(env, sync, 'bootstrapRetryEnabled', 'CROWDSEC_BOOTSTRAP_RETRY_ENABLED', 'crowdsec.sync');

  return {
    environment: env,
    instances: parseInstancesConfig({ instances: root.instances }, sourceEnv),
    sqliteWalEnabled,
    updateCheckEnabled,
  };
}

export function readApplicationConfig(file: string): unknown {
  try {
    return parseYaml(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Configuration error: failed to read CONFIG_FILE at "${file}": ${message}`);
  }
}

export function loadApplicationConfig(file: string, sourceEnv: NodeJS.ProcessEnv): ParsedConfigFile {
  return parseApplicationConfig(readApplicationConfig(file), sourceEnv);
}

function duration(milliseconds: number): string {
  if (milliseconds === 0) return '0';
  if (milliseconds % 86_400_000 === 0) return `${milliseconds / 86_400_000}d`;
  if (milliseconds % 3_600_000 === 0) return `${milliseconds / 3_600_000}h`;
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000}m`;
  if (milliseconds % 1_000 === 0) return `${milliseconds / 1_000}s`;
  return `${milliseconds}ms`;
}

function has(env: NodeJS.ProcessEnv, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, name);
}

const INITIAL_CONFIG_HEADER = [
  'This file was created automatically because no application config existed.',
  'Commented settings show the defaults that applied when the file was created.',
  'While a setting remains commented out, the application uses its current default,',
  'so defaults may change when the application is updated. Uncomment a setting to',
  'manage and pin its value. After creation, this file is the user\'s responsibility;',
  'the application does not update these comments or defaults automatically.',
] as const;

const CONFIG_KEY_ORDER = new Map<string, readonly string[]>([
  ['', ['server', 'storage', 'ui', 'updates', 'auth', 'notifications', 'crowdsec', 'instances']],
  ['server', ['port', 'basePath']],
  ['storage', ['dataDir', 'geonamesDir', 'walEnabled']],
  ['ui', ['timeZone', 'timeFormat', 'readOnly']],
  ['updates', ['enabled']],
  ['auth', ['enabled', 'sessionSecret', 'totpSecret', 'totpSeed', 'oidc']],
  ['auth.oidc', ['issuerUrl', 'clientId', 'clientSecret', 'scope', 'groupsClaim', 'adminGroups', 'readOnlyGroups', 'unmatchedRole']],
  ['notifications', ['secretKey', 'allowPrivateAddresses', 'debugPayloads']],
  ['crowdsec', ['simulationsEnabled', 'alertFilters', 'sync']],
  ['crowdsec.alertFilters', ['includeOrigins', 'excludeOrigins', 'includeCapi', 'includeOriginEmpty', 'excludeOriginEmpty', 'legacy']],
  ['crowdsec.alertFilters.legacy', ['origins', 'extraScenarios']],
  ['crowdsec.sync', [
    'lookback', 'refreshInterval', 'manualRefreshEnabled', 'idleRefreshInterval', 'idleThreshold',
    'requestTimeout', 'bouncerPropagationDelay', 'metricsRequestTimeout', 'heartbeatInterval',
    'alertSyncChunk', 'alertSyncMinChunk', 'reconcileWindow', 'reconcileRecentAge',
    'reconcileRecentInterval', 'reconcileActiveInterval', 'reconcileOldInterval',
    'reconcileWindowsPerRefresh', 'bootstrapRetryDelay', 'bootstrapRetryEnabled',
  ]],
  ['instances[]', ['id', 'name', 'icon', 'lapi', 'metrics', 'sync']],
  ['instances[].lapi', ['url', 'auth', 'tls']],
  ['instances[].lapi.auth', ['type', 'username', 'password', 'certFile', 'keyFile']],
  ['instances[].lapi.tls', ['caFile']],
  ['instances[].metrics[]', ['id', 'name', 'url', 'requestTimeout', 'auth', 'tls']],
  ['instances[].metrics[].auth', ['type', 'username', 'password', 'token']],
  ['instances[].metrics[].tls', ['caFile', 'certFile', 'keyFile']],
  ['instances[].sync', [
    'lookback', 'refreshInterval', 'idleRefreshInterval', 'idleThreshold', 'requestTimeout',
    'heartbeatInterval', 'alertSyncChunk', 'alertSyncMinChunk', 'reconcileWindow',
    'reconcileRecentAge', 'reconcileRecentInterval', 'reconcileActiveInterval',
    'reconcileOldInterval', 'reconcileWindowsPerRefresh', 'bootstrapRetryDelay',
    'bootstrapRetryEnabled', 'bouncerPropagationDelay',
  ]],
]);

function configOrderPath(path: ConfigPath): string {
  return path.reduce<string>((result, part) => (
    typeof part === 'number' ? `${result}[]` : `${result}${result ? '.' : ''}${part}`
  ), '');
}

function canonicalizeConfig(value: unknown, path: ConfigPath = []): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalizeConfig(item, [...path, index]));
  }
  if (!value || typeof value !== 'object') return value;

  const source = value as UnknownRecord;
  const order = CONFIG_KEY_ORDER.get(configOrderPath(path)) || [];
  const rank = new Map(order.map((key, index) => [key, index]));
  const keys = Object.keys(source).sort((left, right) => {
    const leftRank = rank.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.localeCompare(right);
  });
  const result: UnknownRecord = {};
  for (const key of keys) {
    const child = canonicalizeConfig(source[key], [...path, key]);
    if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 0) continue;
    result[key] = child;
  }
  return result;
}

const LEGACY_GENERATED_CONFIG_PATHS = [
  ['PORT', ['server', 'port']],
  ['BASE_PATH', ['server', 'basePath']],
  ['DB_DIR', ['storage', 'dataDir']],
  ['GEONAMES_DUMP_DIR', ['storage', 'geonamesDir']],
  ['TZ', ['ui', 'timeZone']],
  ['TIME_FORMAT', ['ui', 'timeFormat']],
  ['CROWDSEC_TIME_FORMAT', ['ui', 'timeFormat']],
  ['PERMISSION_READ_ONLY', ['ui', 'readOnly']],
  ['AUTH_ENABLED', ['auth', 'enabled']],
  ['CROWDSEC_AUTH_ENABLED', ['auth', 'enabled']],
  ['AUTH_SECRET', ['auth', 'sessionSecret']],
  ['AUTH_SECRET_FILE', ['auth', 'sessionSecret']],
  ['CROWDSEC_AUTH_SECRET', ['auth', 'sessionSecret']],
  ['CROWDSEC_AUTH_SECRET_FILE', ['auth', 'sessionSecret']],
  ['AUTH_TOTP_SECRET', ['auth', 'totpSecret']],
  ['AUTH_TOTP_SECRET_FILE', ['auth', 'totpSecret']],
  ['CROWDSEC_AUTH_TOTP_SECRET', ['auth', 'totpSecret']],
  ['CROWDSEC_AUTH_TOTP_SECRET_FILE', ['auth', 'totpSecret']],
  ['AUTH_TOTP_SEED', ['auth', 'totpSeed']],
  ['AUTH_TOTP_SEED_FILE', ['auth', 'totpSeed']],
  ['CROWDSEC_AUTH_TOTP_SEED', ['auth', 'totpSeed']],
  ['CROWDSEC_AUTH_TOTP_SEED_FILE', ['auth', 'totpSeed']],
  ['AUTH_OIDC_ISSUER_URL', ['auth', 'oidc', 'issuerUrl']],
  ['CROWDSEC_AUTH_OIDC_ISSUER_URL', ['auth', 'oidc', 'issuerUrl']],
  ['AUTH_OIDC_CLIENT_ID', ['auth', 'oidc', 'clientId']],
  ['CROWDSEC_AUTH_OIDC_CLIENT_ID', ['auth', 'oidc', 'clientId']],
  ['AUTH_OIDC_CLIENT_SECRET', ['auth', 'oidc', 'clientSecret']],
  ['AUTH_OIDC_CLIENT_SECRET_FILE', ['auth', 'oidc', 'clientSecret']],
  ['CROWDSEC_AUTH_OIDC_CLIENT_SECRET', ['auth', 'oidc', 'clientSecret']],
  ['CROWDSEC_AUTH_OIDC_CLIENT_SECRET_FILE', ['auth', 'oidc', 'clientSecret']],
  ['AUTH_OIDC_SCOPE', ['auth', 'oidc', 'scope']],
  ['CROWDSEC_AUTH_OIDC_SCOPE', ['auth', 'oidc', 'scope']],
  ['AUTH_OIDC_GROUPS_CLAIM', ['auth', 'oidc', 'groupsClaim']],
  ['CROWDSEC_AUTH_OIDC_GROUPS_CLAIM', ['auth', 'oidc', 'groupsClaim']],
  ['AUTH_OIDC_ADMIN_GROUPS', ['auth', 'oidc', 'adminGroups']],
  ['CROWDSEC_AUTH_OIDC_ADMIN_GROUPS', ['auth', 'oidc', 'adminGroups']],
  ['AUTH_OIDC_READ_ONLY_GROUPS', ['auth', 'oidc', 'readOnlyGroups']],
  ['CROWDSEC_AUTH_OIDC_READ_ONLY_GROUPS', ['auth', 'oidc', 'readOnlyGroups']],
  ['AUTH_OIDC_UNMATCHED_ROLE', ['auth', 'oidc', 'unmatchedRole']],
  ['CROWDSEC_AUTH_OIDC_UNMATCHED_ROLE', ['auth', 'oidc', 'unmatchedRole']],
  ['NOTIFICATION_SECRET_KEY', ['notifications', 'secretKey']],
  ['NOTIFICATION_SECRET_KEY_FILE', ['notifications', 'secretKey']],
  ['NOTIFICATION_ALLOW_PRIVATE_ADDRESSES', ['notifications', 'allowPrivateAddresses']],
  ['NOTIFICATION_DEBUG_PAYLOADS', ['notifications', 'debugPayloads']],
  ['CROWDSEC_SIMULATIONS_ENABLED', ['crowdsec', 'simulationsEnabled']],
  ['CROWDSEC_ALERT_INCLUDE_ORIGINS', ['crowdsec', 'alertFilters', 'includeOrigins']],
  ['CROWDSEC_ALERT_EXCLUDE_ORIGINS', ['crowdsec', 'alertFilters', 'excludeOrigins']],
  ['CROWDSEC_ALERT_INCLUDE_CAPI', ['crowdsec', 'alertFilters', 'includeCapi']],
  ['CROWDSEC_ALERT_INCLUDE_ORIGIN_EMPTY', ['crowdsec', 'alertFilters', 'includeOriginEmpty']],
  ['CROWDSEC_ALERT_EXCLUDE_ORIGIN_EMPTY', ['crowdsec', 'alertFilters', 'excludeOriginEmpty']],
  ['CROWDSEC_ALERT_ORIGINS', ['crowdsec', 'alertFilters', 'legacy', 'origins']],
  ['CROWDSEC_ALERT_EXTRA_SCENARIOS', ['crowdsec', 'alertFilters', 'legacy', 'extraScenarios']],
  ['CROWDSEC_LOOKBACK_PERIOD', ['crowdsec', 'sync', 'lookback']],
  ['CROWDSEC_REFRESH_INTERVAL', ['crowdsec', 'sync', 'refreshInterval']],
  ['CROWDSEC_MANUAL_REFRESH_ENABLED', ['crowdsec', 'sync', 'manualRefreshEnabled']],
  ['CROWDSEC_IDLE_REFRESH_INTERVAL', ['crowdsec', 'sync', 'idleRefreshInterval']],
  ['CROWDSEC_IDLE_THRESHOLD', ['crowdsec', 'sync', 'idleThreshold']],
  ['CROWDSEC_LAPI_REQUEST_TIMEOUT', ['crowdsec', 'sync', 'requestTimeout']],
  ['CROWDSEC_BOUNCER_PROPAGATION_DELAY', ['crowdsec', 'sync', 'bouncerPropagationDelay']],
  ['CROWDSEC_PROMETHEUS_REQUEST_TIMEOUT', ['crowdsec', 'sync', 'metricsRequestTimeout']],
  ['CROWDSEC_HEARTBEAT_INTERVAL', ['crowdsec', 'sync', 'heartbeatInterval']],
  ['CROWDSEC_ALERT_SYNC_CHUNK', ['crowdsec', 'sync', 'alertSyncChunk']],
  ['CROWDSEC_ALERT_SYNC_MIN_CHUNK', ['crowdsec', 'sync', 'alertSyncMinChunk']],
  ['CROWDSEC_RECONCILE_WINDOW', ['crowdsec', 'sync', 'reconcileWindow']],
  ['CROWDSEC_RECONCILE_RECENT_AGE', ['crowdsec', 'sync', 'reconcileRecentAge']],
  ['CROWDSEC_RECONCILE_RECENT_INTERVAL', ['crowdsec', 'sync', 'reconcileRecentInterval']],
  ['CROWDSEC_RECONCILE_ACTIVE_INTERVAL', ['crowdsec', 'sync', 'reconcileActiveInterval']],
  ['CROWDSEC_RECONCILE_OLD_INTERVAL', ['crowdsec', 'sync', 'reconcileOldInterval']],
  ['CROWDSEC_RECONCILE_WINDOWS_PER_REFRESH', ['crowdsec', 'sync', 'reconcileWindowsPerRefresh']],
  ['CROWDSEC_BOOTSTRAP_RETRY_DELAY', ['crowdsec', 'sync', 'bootstrapRetryDelay']],
  ['CROWDSEC_BOOTSTRAP_RETRY_ENABLED', ['crowdsec', 'sync', 'bootstrapRetryEnabled']],
] as const satisfies readonly (readonly [string, ConfigPath])[];

function secretReference(env: NodeJS.ProcessEnv, canonical: string, legacy?: string): UnknownRecord | undefined {
  for (const name of [canonical, legacy].filter((value): value is string => Boolean(value))) {
    if (has(env, name)) return { env: name };
    if (has(env, `${name}_FILE`)) return { file: env[`${name}_FILE`] };
  }
  return undefined;
}

function legacySingleInstance(env: NodeJS.ProcessEnv, config: RuntimeConfig): UnknownRecord {
  let auth: UnknownRecord = { type: 'none' };
  if (config.crowdsecAuth.mode === 'password') {
    auth = {
      type: 'password',
      username: config.crowdsecAuth.user,
      ...(has(env, 'CROWDSEC_PASSWORD_FILE')
        ? { password: { file: env.CROWDSEC_PASSWORD_FILE } }
        : { password: { env: 'CROWDSEC_PASSWORD' } }),
    };
  } else if (config.crowdsecAuth.mode === 'mtls') {
    auth = { type: 'mtls', certFile: config.crowdsecAuth.certPath, keyFile: config.crowdsecAuth.keyPath };
  }
  return {
    id: 'default',
    name: env.CROWDSEC_INSTANCE_NAME?.trim() || 'CrowdSec',
    ...(env.CROWDSEC_INSTANCE_ICON?.trim() ? { icon: env.CROWDSEC_INSTANCE_ICON.trim() } : {}),
    lapi: {
      url: config.crowdsecUrl,
      auth,
      ...(config.crowdsecTlsCaCertPath ? { tls: { caFile: config.crowdsecTlsCaCertPath } } : {}),
    },
    metrics: config.prometheusUrl ? [{
      id: 'default', name: 'CrowdSec', url: config.prometheusUrl, auth: { type: 'none' },
      requestTimeout: duration(config.prometheusRequestTimeoutMs),
    }] : [],
  };
}

function generatedInstances(env: NodeJS.ProcessEnv, config: RuntimeConfig): unknown[] {
  const oldFile = env.CROWDSEC_INSTANCES_CONFIG_FILE?.trim();
  if (!oldFile) return [legacySingleInstance(env, config)];
  try {
    const oldRoot = record(parseYaml(fs.readFileSync(oldFile, 'utf8')), 'instances config');
    if (!Array.isArray(oldRoot.instances)) throw new Error('instances must be an array');
    return oldRoot.instances;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Configuration error: cannot migrate CROWDSEC_INSTANCES_CONFIG_FILE at "${oldFile}": ${message}`);
  }
}

export function generateApplicationConfig(env: NodeJS.ProcessEnv, config: RuntimeConfig): UnknownRecord {
  const document: UnknownRecord = {
    server: { port: config.port, basePath: config.basePath },
    storage: {
      dataDir: config.dbDir,
      geonamesDir: config.geonamesDumpDir,
      walEnabled: config.sqliteWalEnabled,
    },
    ui: { timeZone: config.timeZone || 'browser', timeFormat: config.timeFormat, readOnly: config.readOnly },
    auth: {
      enabled: config.dashboardAuth.enabled === null ? 'auto' : config.dashboardAuth.enabled,
      ...(secretReference(env, 'AUTH_SECRET', 'CROWDSEC_AUTH_SECRET') ? { sessionSecret: secretReference(env, 'AUTH_SECRET', 'CROWDSEC_AUTH_SECRET') } : {}),
      ...(secretReference(env, 'AUTH_TOTP_SECRET', 'CROWDSEC_AUTH_TOTP_SECRET') ? { totpSecret: secretReference(env, 'AUTH_TOTP_SECRET', 'CROWDSEC_AUTH_TOTP_SECRET') } : {}),
      ...(secretReference(env, 'AUTH_TOTP_SEED', 'CROWDSEC_AUTH_TOTP_SEED') ? { totpSeed: secretReference(env, 'AUTH_TOTP_SEED', 'CROWDSEC_AUTH_TOTP_SEED') } : {}),
      oidc: {
        ...(config.dashboardAuth.oidcIssuerUrl ? { issuerUrl: config.dashboardAuth.oidcIssuerUrl } : {}),
        ...(config.dashboardAuth.oidcClientId ? { clientId: config.dashboardAuth.oidcClientId } : {}),
        ...(secretReference(env, 'AUTH_OIDC_CLIENT_SECRET', 'CROWDSEC_AUTH_OIDC_CLIENT_SECRET') ? { clientSecret: secretReference(env, 'AUTH_OIDC_CLIENT_SECRET', 'CROWDSEC_AUTH_OIDC_CLIENT_SECRET') } : {}),
        scope: config.dashboardAuth.oidcScope,
        groupsClaim: config.dashboardAuth.oidcGroupsClaim,
        adminGroups: config.dashboardAuth.oidcAdminGroups,
        readOnlyGroups: config.dashboardAuth.oidcReadOnlyGroups,
        unmatchedRole: config.dashboardAuth.oidcUnmatchedRole,
      },
    },
    notifications: {
      ...(secretReference(env, 'NOTIFICATION_SECRET_KEY') ? { secretKey: secretReference(env, 'NOTIFICATION_SECRET_KEY') } : {}),
      allowPrivateAddresses: config.notificationAllowPrivateAddresses,
      debugPayloads: config.notificationDebugPayloads,
    },
    updates: { enabled: config.updateCheckEnabled },
    crowdsec: {
      simulationsEnabled: config.simulationsEnabled,
      alertFilters: {
        ...(config.alertFilterMode === 'new' ? {
          includeOrigins: config.alertIncludeOrigins,
          excludeOrigins: config.alertExcludeOrigins,
          includeCapi: config.alertIncludeCapi,
          includeOriginEmpty: config.alertIncludeOriginEmpty,
          excludeOriginEmpty: config.alertExcludeOriginEmpty,
        } : {}),
        ...(config.alertFilterMode === 'legacy'
          || has(env, 'CROWDSEC_ALERT_ORIGINS')
          || has(env, 'CROWDSEC_ALERT_EXTRA_SCENARIOS')
          ? { legacy: { origins: config.legacyAlertOrigins, extraScenarios: config.legacyAlertExtraScenarios } }
          : {}),
      },
      sync: {
        lookback: config.lookbackPeriod,
        refreshInterval: duration(config.refreshIntervalMs),
        manualRefreshEnabled: config.manualRefreshEnabled,
        idleRefreshInterval: duration(config.idleRefreshIntervalMs),
        idleThreshold: duration(config.idleThresholdMs),
        requestTimeout: duration(config.lapiRequestTimeoutMs),
        bouncerPropagationDelay: duration(config.bouncerPropagationDelayMs),
        metricsRequestTimeout: duration(config.prometheusRequestTimeoutMs),
        heartbeatInterval: duration(config.heartbeatIntervalMs),
        alertSyncChunk: duration(config.alertSyncChunkMs),
        alertSyncMinChunk: duration(config.alertSyncMinChunkMs),
        reconcileWindow: duration(config.reconcileWindowMs),
        reconcileRecentAge: duration(config.reconcileRecentAgeMs),
        reconcileRecentInterval: duration(config.reconcileRecentIntervalMs),
        reconcileActiveInterval: duration(config.reconcileActiveIntervalMs),
        reconcileOldInterval: duration(config.reconcileOldIntervalMs),
        reconcileWindowsPerRefresh: config.reconcileWindowsPerRefresh,
        bootstrapRetryDelay: duration(config.bootstrapRetryDelayMs),
        bootstrapRetryEnabled: config.bootstrapRetryEnabled,
      },
    },
    instances: generatedInstances(env, config),
  };
  return document;
}

const CONFIG_SECTION_ENV = [
  ['CONFIG_SERVER', ['server']],
  ['CONFIG_STORAGE', ['storage']],
  ['CONFIG_UI', ['ui']],
  ['CONFIG_AUTH', ['auth']],
  ['CONFIG_NOTIFICATIONS', ['notifications']],
  ['CONFIG_UPDATES', ['updates']],
  ['CONFIG_CROWDSEC', ['crowdsec']],
  ['CONFIG_INSTANCES', ['instances']],
] as const;

const CONFIG_VALUE_ENV = [
  ['CONFIG_SERVER_PORT', ['server', 'port']],
  ['CONFIG_SERVER_BASE_PATH', ['server', 'basePath']],
  ['CONFIG_STORAGE_DATA_DIR', ['storage', 'dataDir']],
  ['CONFIG_STORAGE_GEONAMES_DIR', ['storage', 'geonamesDir']],
  ['CONFIG_STORAGE_WAL_ENABLED', ['storage', 'walEnabled']],
  ['CONFIG_UI_TIME_ZONE', ['ui', 'timeZone']],
  ['CONFIG_UI_TIME_FORMAT', ['ui', 'timeFormat']],
  ['CONFIG_UI_READ_ONLY', ['ui', 'readOnly']],
  ['CONFIG_AUTH_ENABLED', ['auth', 'enabled']],
  ['CONFIG_AUTH_OIDC_ISSUER_URL', ['auth', 'oidc', 'issuerUrl']],
  ['CONFIG_AUTH_OIDC_CLIENT_ID', ['auth', 'oidc', 'clientId']],
  ['CONFIG_AUTH_OIDC_SCOPE', ['auth', 'oidc', 'scope']],
  ['CONFIG_AUTH_OIDC_GROUPS_CLAIM', ['auth', 'oidc', 'groupsClaim']],
  ['CONFIG_AUTH_OIDC_ADMIN_GROUPS', ['auth', 'oidc', 'adminGroups']],
  ['CONFIG_AUTH_OIDC_READ_ONLY_GROUPS', ['auth', 'oidc', 'readOnlyGroups']],
  ['CONFIG_AUTH_OIDC_UNMATCHED_ROLE', ['auth', 'oidc', 'unmatchedRole']],
  ['CONFIG_NOTIFICATIONS_ALLOW_PRIVATE_ADDRESSES', ['notifications', 'allowPrivateAddresses']],
  ['CONFIG_NOTIFICATIONS_DEBUG_PAYLOADS', ['notifications', 'debugPayloads']],
  ['CONFIG_UPDATES_ENABLED', ['updates', 'enabled']],
  ['CONFIG_CROWDSEC_SIMULATIONS_ENABLED', ['crowdsec', 'simulationsEnabled']],
  ['CONFIG_CROWDSEC_ALERT_FILTERS_INCLUDE_ORIGINS', ['crowdsec', 'alertFilters', 'includeOrigins']],
  ['CONFIG_CROWDSEC_ALERT_FILTERS_EXCLUDE_ORIGINS', ['crowdsec', 'alertFilters', 'excludeOrigins']],
  ['CONFIG_CROWDSEC_ALERT_FILTERS_INCLUDE_CAPI', ['crowdsec', 'alertFilters', 'includeCapi']],
  ['CONFIG_CROWDSEC_ALERT_FILTERS_INCLUDE_ORIGIN_EMPTY', ['crowdsec', 'alertFilters', 'includeOriginEmpty']],
  ['CONFIG_CROWDSEC_ALERT_FILTERS_EXCLUDE_ORIGIN_EMPTY', ['crowdsec', 'alertFilters', 'excludeOriginEmpty']],
  ['CONFIG_CROWDSEC_ALERT_FILTERS_LEGACY_ORIGINS', ['crowdsec', 'alertFilters', 'legacy', 'origins']],
  ['CONFIG_CROWDSEC_ALERT_FILTERS_LEGACY_EXTRA_SCENARIOS', ['crowdsec', 'alertFilters', 'legacy', 'extraScenarios']],
  ['CONFIG_CROWDSEC_SYNC_LOOKBACK', ['crowdsec', 'sync', 'lookback']],
  ['CONFIG_CROWDSEC_SYNC_REFRESH_INTERVAL', ['crowdsec', 'sync', 'refreshInterval']],
  ['CONFIG_CROWDSEC_SYNC_MANUAL_REFRESH_ENABLED', ['crowdsec', 'sync', 'manualRefreshEnabled']],
  ['CONFIG_CROWDSEC_SYNC_IDLE_REFRESH_INTERVAL', ['crowdsec', 'sync', 'idleRefreshInterval']],
  ['CONFIG_CROWDSEC_SYNC_IDLE_THRESHOLD', ['crowdsec', 'sync', 'idleThreshold']],
  ['CONFIG_CROWDSEC_SYNC_REQUEST_TIMEOUT', ['crowdsec', 'sync', 'requestTimeout']],
  ['CONFIG_CROWDSEC_SYNC_BOUNCER_PROPAGATION_DELAY', ['crowdsec', 'sync', 'bouncerPropagationDelay']],
  ['CONFIG_CROWDSEC_SYNC_METRICS_REQUEST_TIMEOUT', ['crowdsec', 'sync', 'metricsRequestTimeout']],
  ['CONFIG_CROWDSEC_SYNC_HEARTBEAT_INTERVAL', ['crowdsec', 'sync', 'heartbeatInterval']],
  ['CONFIG_CROWDSEC_SYNC_ALERT_SYNC_CHUNK', ['crowdsec', 'sync', 'alertSyncChunk']],
  ['CONFIG_CROWDSEC_SYNC_ALERT_SYNC_MIN_CHUNK', ['crowdsec', 'sync', 'alertSyncMinChunk']],
  ['CONFIG_CROWDSEC_SYNC_RECONCILE_WINDOW', ['crowdsec', 'sync', 'reconcileWindow']],
  ['CONFIG_CROWDSEC_SYNC_RECONCILE_RECENT_AGE', ['crowdsec', 'sync', 'reconcileRecentAge']],
  ['CONFIG_CROWDSEC_SYNC_RECONCILE_RECENT_INTERVAL', ['crowdsec', 'sync', 'reconcileRecentInterval']],
  ['CONFIG_CROWDSEC_SYNC_RECONCILE_ACTIVE_INTERVAL', ['crowdsec', 'sync', 'reconcileActiveInterval']],
  ['CONFIG_CROWDSEC_SYNC_RECONCILE_OLD_INTERVAL', ['crowdsec', 'sync', 'reconcileOldInterval']],
  ['CONFIG_CROWDSEC_SYNC_RECONCILE_WINDOWS_PER_REFRESH', ['crowdsec', 'sync', 'reconcileWindowsPerRefresh']],
  ['CONFIG_CROWDSEC_SYNC_BOOTSTRAP_RETRY_DELAY', ['crowdsec', 'sync', 'bootstrapRetryDelay']],
  ['CONFIG_CROWDSEC_SYNC_BOOTSTRAP_RETRY_ENABLED', ['crowdsec', 'sync', 'bootstrapRetryEnabled']],
] as const;

const CONFIG_SECRET_ENV = [
  ['CONFIG_AUTH_SESSION_SECRET', ['auth', 'sessionSecret']],
  ['CONFIG_AUTH_TOTP_SECRET', ['auth', 'totpSecret']],
  ['CONFIG_AUTH_TOTP_SEED', ['auth', 'totpSeed']],
  ['CONFIG_AUTH_OIDC_CLIENT_SECRET', ['auth', 'oidc', 'clientSecret']],
  ['CONFIG_NOTIFICATIONS_SECRET_KEY', ['notifications', 'secretKey']],
] as const;

const CONFIG_ARRAY_ENV = [
  ['CONFIG_AUTH_OIDC_ADMIN_GROUPS', ['auth', 'oidc', 'adminGroups']],
  ['CONFIG_AUTH_OIDC_READ_ONLY_GROUPS', ['auth', 'oidc', 'readOnlyGroups']],
  ['CONFIG_CROWDSEC_ALERT_FILTERS_INCLUDE_ORIGINS', ['crowdsec', 'alertFilters', 'includeOrigins']],
  ['CONFIG_CROWDSEC_ALERT_FILTERS_EXCLUDE_ORIGINS', ['crowdsec', 'alertFilters', 'excludeOrigins']],
  ['CONFIG_CROWDSEC_ALERT_FILTERS_LEGACY_ORIGINS', ['crowdsec', 'alertFilters', 'legacy', 'origins']],
  ['CONFIG_CROWDSEC_ALERT_FILTERS_LEGACY_EXTRA_SCENARIOS', ['crowdsec', 'alertFilters', 'legacy', 'extraScenarios']],
] as const;

const CONFIG_INSTANCE_VALUE_SUFFIX = new Map<string, readonly string[]>([
  ['ID', ['id']],
  ['NAME', ['name']],
  ['ICON', ['icon']],
  ['LAPI', ['lapi']],
  ['LAPI_URL', ['lapi', 'url']],
  ['LAPI_AUTH', ['lapi', 'auth']],
  ['LAPI_AUTH_TYPE', ['lapi', 'auth', 'type']],
  ['LAPI_AUTH_USERNAME', ['lapi', 'auth', 'username']],
  ['LAPI_AUTH_CERT_FILE', ['lapi', 'auth', 'certFile']],
  ['LAPI_AUTH_KEY_FILE', ['lapi', 'auth', 'keyFile']],
  ['LAPI_TLS', ['lapi', 'tls']],
  ['LAPI_TLS_CA_FILE', ['lapi', 'tls', 'caFile']],
  ['METRICS', ['metrics']],
  ['SYNC', ['sync']],
  ['SYNC_LOOKBACK', ['sync', 'lookback']],
  ['SYNC_REFRESH_INTERVAL', ['sync', 'refreshInterval']],
  ['SYNC_IDLE_REFRESH_INTERVAL', ['sync', 'idleRefreshInterval']],
  ['SYNC_IDLE_THRESHOLD', ['sync', 'idleThreshold']],
  ['SYNC_REQUEST_TIMEOUT', ['sync', 'requestTimeout']],
  ['SYNC_HEARTBEAT_INTERVAL', ['sync', 'heartbeatInterval']],
  ['SYNC_ALERT_SYNC_CHUNK', ['sync', 'alertSyncChunk']],
  ['SYNC_ALERT_SYNC_MIN_CHUNK', ['sync', 'alertSyncMinChunk']],
  ['SYNC_RECONCILE_WINDOW', ['sync', 'reconcileWindow']],
  ['SYNC_RECONCILE_RECENT_AGE', ['sync', 'reconcileRecentAge']],
  ['SYNC_RECONCILE_RECENT_INTERVAL', ['sync', 'reconcileRecentInterval']],
  ['SYNC_RECONCILE_ACTIVE_INTERVAL', ['sync', 'reconcileActiveInterval']],
  ['SYNC_RECONCILE_OLD_INTERVAL', ['sync', 'reconcileOldInterval']],
  ['SYNC_RECONCILE_WINDOWS_PER_REFRESH', ['sync', 'reconcileWindowsPerRefresh']],
  ['SYNC_BOOTSTRAP_RETRY_DELAY', ['sync', 'bootstrapRetryDelay']],
  ['SYNC_BOOTSTRAP_RETRY_ENABLED', ['sync', 'bootstrapRetryEnabled']],
  ['SYNC_BOUNCER_PROPAGATION_DELAY', ['sync', 'bouncerPropagationDelay']],
]);

const CONFIG_METRICS_VALUE_SUFFIX = new Map<string, readonly string[]>([
  ['ID', ['id']],
  ['NAME', ['name']],
  ['URL', ['url']],
  ['REQUEST_TIMEOUT', ['requestTimeout']],
  ['AUTH', ['auth']],
  ['AUTH_TYPE', ['auth', 'type']],
  ['AUTH_USERNAME', ['auth', 'username']],
  ['TLS', ['tls']],
  ['TLS_CA_FILE', ['tls', 'caFile']],
  ['TLS_CERT_FILE', ['tls', 'certFile']],
  ['TLS_KEY_FILE', ['tls', 'keyFile']],
]);

type IndexedConfigOverride = {
  name: string;
  path: ConfigPath;
  secret: 'direct' | 'file' | null;
};

function indexedConfigOverrides(env: NodeJS.ProcessEnv): IndexedConfigOverride[] {
  const overrides: IndexedConfigOverride[] = [];
  for (const name of Object.keys(env)) {
    for (const [prefix, path] of CONFIG_ARRAY_ENV) {
      const match = name.match(new RegExp(`^${prefix}_(\\d+)$`));
      if (match) {
        overrides.push({ name, path: [...path, Number(match[1])], secret: null });
        break;
      }
      if (name.startsWith(`${prefix}_`)) {
        throw new Error(`Configuration error: unknown indexed CONFIG_ variable ${name}.`);
      }
    }

    const indexedInstanceMatch = name.match(/^CONFIG_INSTANCES_(\d+)_(.+)$/);
    const defaultInstanceMatch = name.match(/^CONFIG_INSTANCE_(.+)$/);
    if (!indexedInstanceMatch && name.match(/^CONFIG_INSTANCES_(.+)$/)) {
      throw new Error(`Configuration error: unknown indexed CONFIG_ variable ${name}. Use CONFIG_INSTANCE_* for the default instance or CONFIG_INSTANCES_<INDEX>_* for an indexed instance.`);
    }
    if (!indexedInstanceMatch && !defaultInstanceMatch) continue;
    const instanceIndex = indexedInstanceMatch ? Number(indexedInstanceMatch[1]) : 0;
    const suffix = indexedInstanceMatch ? indexedInstanceMatch[2] : defaultInstanceMatch![1];
    const instancePath: ConfigPath = ['instances', instanceIndex];

    if (suffix === 'LAPI_AUTH_PASSWORD' || suffix === 'LAPI_AUTH_PASSWORD_FILE') {
      overrides.push({
        name,
        path: [...instancePath, 'lapi', 'auth', 'password'],
        secret: suffix.endsWith('_FILE') ? 'file' : 'direct',
      });
      continue;
    }

    const indexedMetricsMatch = suffix.match(/^METRICS_(\d+)_(.+)$/);
    const defaultMetricsMatch = suffix.match(/^METRICS_(.+)$/);
    const metricsMatch = indexedMetricsMatch || defaultMetricsMatch;
    if (metricsMatch) {
      const metricsIndex = indexedMetricsMatch ? Number(indexedMetricsMatch[1]) : 0;
      const metricsSuffix = indexedMetricsMatch ? indexedMetricsMatch[2] : defaultMetricsMatch![1];
      const metricsPath: ConfigPath = [...instancePath, 'metrics', metricsIndex];
      if (['AUTH_PASSWORD', 'AUTH_PASSWORD_FILE', 'AUTH_TOKEN', 'AUTH_TOKEN_FILE'].includes(metricsSuffix)) {
        overrides.push({
          name,
          path: [...metricsPath, 'auth', metricsSuffix.startsWith('AUTH_TOKEN') ? 'token' : 'password'],
          secret: metricsSuffix.endsWith('_FILE') ? 'file' : 'direct',
        });
        continue;
      }
      const relativePath = CONFIG_METRICS_VALUE_SUFFIX.get(metricsSuffix);
      if (!relativePath) throw new Error(`Configuration error: unknown indexed CONFIG_ variable ${name}.`);
      overrides.push({ name, path: [...metricsPath, ...relativePath], secret: null });
      continue;
    }

    const relativePath = CONFIG_INSTANCE_VALUE_SUFFIX.get(suffix);
    if (!relativePath) throw new Error(`Configuration error: unknown indexed CONFIG_ variable ${name}.`);
    overrides.push({ name, path: [...instancePath, ...relativePath], secret: null });
  }
  const paths = new Map<string, string>();
  for (const override of overrides) {
    const pathKey = JSON.stringify(override.path);
    const existing = paths.get(pathKey);
    if (existing) {
      throw new Error(`Configuration error: both ${existing} and ${override.name} target the same setting. Set only one.`);
    }
    paths.set(pathKey, override.name);
  }
  return overrides.sort((left, right) => {
    if (left.path.length !== right.path.length) return left.path.length - right.path.length;
    const leftIsAuthType = left.name.endsWith('_AUTH_TYPE');
    const rightIsAuthType = right.name.endsWith('_AUTH_TYPE');
    return Number(rightIsAuthType) - Number(leftIsAuthType);
  });
}

export function hasConfigEnvironmentOverrides(env: NodeJS.ProcessEnv): boolean {
  for (const [name] of [...CONFIG_SECTION_ENV, ...CONFIG_VALUE_ENV]) if (has(env, name)) return true;
  for (const [name] of CONFIG_SECRET_ENV) if (has(env, name) || has(env, `${name}_FILE`)) return true;
  return indexedConfigOverrides(env).length > 0;
}

function parseConfigEnvironmentValue(name: string, value: string | undefined): unknown {
  if (!value) return '';
  try {
    return parseYaml(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Configuration error: failed to parse ${name} as YAML: ${message}`);
  }
}

function setConfigPath(document: UnknownRecord, keys: ConfigPath, value: unknown): void {
  let current: UnknownRecord | unknown[] = document;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];
    const nextIsIndex = typeof keys[index + 1] === 'number';
    const existing = Array.isArray(current) ? current[Number(key)] : current[String(key)];
    const valid = nextIsIndex
      ? Array.isArray(existing)
      : Boolean(existing) && typeof existing === 'object' && !Array.isArray(existing);
    if (!valid) {
      const replacement = nextIsIndex ? [] : {};
      if (Array.isArray(current)) current[Number(key)] = replacement;
      else current[String(key)] = replacement;
    }
    current = (Array.isArray(current) ? current[Number(key)] : current[String(key)]) as UnknownRecord | unknown[];
  }
  const lastKey = keys.at(-1)!;
  if (Array.isArray(current)) current[Number(lastKey)] = value;
  else current[String(lastKey)] = value;
}

function getConfigPath(document: UnknownRecord, keys: ConfigPath): unknown {
  let current: unknown = document;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = Array.isArray(current)
      ? current[Number(key)]
      : (current as UnknownRecord)[String(key)];
  }
  return current;
}

function applyIndexedCollectionDefaults(
  overrides: readonly IndexedConfigOverride[],
  setPath: (keys: ConfigPath, value: unknown) => void,
  getPath: (keys: ConfigPath) => unknown,
  forceSetupDefaults: boolean,
): void {
  const instanceIndexes = [...new Set(overrides.flatMap((override) => (
    override.path[0] === 'instances' && typeof override.path[1] === 'number'
      ? [override.path[1]]
      : []
  )))];

  for (const instanceIndex of instanceIndexes) {
    const instanceOverrides = overrides.filter((override) => override.path[0] === 'instances'
      && override.path[1] === instanceIndex);
    const hasPath = (...relativePath: ConfigPath): boolean => instanceOverrides.some((override) => (
      override.path.length === relativePath.length + 2
      && relativePath.every((part, index) => override.path[index + 2] === part)
    ));
    const idPath: ConfigPath = ['instances', instanceIndex, 'id'];
    if ((!hasPath('id') && forceSetupDefaults) || getPath(idPath) === undefined) {
      setPath(idPath, String(instanceIndex));
    }

    const namePath: ConfigPath = ['instances', instanceIndex, 'name'];
    if ((!hasPath('name') && forceSetupDefaults) || getPath(namePath) === undefined) {
      setPath(namePath, `Instance ${instanceIndex}`);
    }

    const authTypePath: ConfigPath = ['instances', instanceIndex, 'lapi', 'auth', 'type'];
    const hasAuthContainerOverride = hasPath('lapi') || hasPath('lapi', 'auth');
    const hasExplicitAuthType = hasPath('lapi', 'auth', 'type')
      || (hasAuthContainerOverride && getPath(authTypePath) !== undefined);
    const hasPasswordOverride = hasPath('lapi', 'auth', 'username') || hasPath('lapi', 'auth', 'password');
    const hasMtlsOverride = hasPath('lapi', 'auth', 'certFile') || hasPath('lapi', 'auth', 'keyFile');
    if (!hasExplicitAuthType) {
      if (hasPasswordOverride && hasMtlsOverride) {
        throw new Error(`Configuration error: instances[${instanceIndex}].lapi.auth.type cannot be inferred from mixed password and mTLS credentials.`);
      }
      const hasMtlsCredentials = hasMtlsOverride
        || getPath(['instances', instanceIndex, 'lapi', 'auth', 'certFile']) !== undefined
        || getPath(['instances', instanceIndex, 'lapi', 'auth', 'keyFile']) !== undefined;
      const hasPasswordCredentials = hasPasswordOverride
        || getPath(['instances', instanceIndex, 'lapi', 'auth', 'username']) !== undefined
        || getPath(['instances', instanceIndex, 'lapi', 'auth', 'password']) !== undefined;
      if (hasMtlsOverride || hasPasswordOverride || getPath(authTypePath) === undefined) {
        setPath(authTypePath, hasMtlsCredentials ? 'mtls' : hasPasswordCredentials ? 'password' : 'none');
      }
    }
  }

  const metricsIndexes = new Map<number, Set<number>>();
  for (const override of overrides) {
    if (override.path[0] !== 'instances'
      || typeof override.path[1] !== 'number'
      || override.path[2] !== 'metrics'
      || typeof override.path[3] !== 'number') continue;
    const endpoints = metricsIndexes.get(override.path[1]) || new Set<number>();
    endpoints.add(override.path[3]);
    metricsIndexes.set(override.path[1], endpoints);
  }
  for (const [instanceIndex, endpointIndexes] of metricsIndexes) {
    for (const endpointIndex of endpointIndexes) {
      const endpointOverrides = overrides.filter((override) => override.path[0] === 'instances'
        && override.path[1] === instanceIndex
        && override.path[2] === 'metrics'
        && override.path[3] === endpointIndex);
      const hasEndpointPath = (...relativePath: ConfigPath): boolean => endpointOverrides.some((override) => (
        override.path.length === relativePath.length + 4
        && relativePath.every((part, index) => override.path[index + 4] === part)
      ));
      const idPath: ConfigPath = ['instances', instanceIndex, 'metrics', endpointIndex, 'id'];
      const hasExplicitId = hasEndpointPath('id');
      if ((!hasExplicitId && forceSetupDefaults) || getPath(idPath) === undefined) {
        setPath(idPath, String(endpointIndex));
      }

      const namePath: ConfigPath = ['instances', instanceIndex, 'metrics', endpointIndex, 'name'];
      const hasExplicitName = hasEndpointPath('name');
      if ((!hasExplicitName && forceSetupDefaults) || getPath(namePath) === undefined) {
        setPath(namePath, `Metrics ${endpointIndex}`);
      }

      const authTypePath: ConfigPath = ['instances', instanceIndex, 'metrics', endpointIndex, 'auth', 'type'];
      const hasExplicitAuthType = hasEndpointPath('auth', 'type')
        || (hasEndpointPath('auth') && getPath(authTypePath) !== undefined);
      const hasBasicOverride = hasEndpointPath('auth', 'username') || hasEndpointPath('auth', 'password');
      const hasBearerOverride = hasEndpointPath('auth', 'token');
      if (!hasExplicitAuthType) {
        if (hasBasicOverride && hasBearerOverride) {
          throw new Error(`Configuration error: instances[${instanceIndex}].metrics[${endpointIndex}].auth.type cannot be inferred from mixed basic and bearer credentials.`);
        }
        const hasBearerCredentials = hasBearerOverride
          || getPath(['instances', instanceIndex, 'metrics', endpointIndex, 'auth', 'token']) !== undefined;
        const hasBasicCredentials = hasBasicOverride
          || getPath(['instances', instanceIndex, 'metrics', endpointIndex, 'auth', 'username']) !== undefined
          || getPath(['instances', instanceIndex, 'metrics', endpointIndex, 'auth', 'password']) !== undefined;
        if (hasBearerOverride || hasBasicOverride || getPath(authTypePath) === undefined) {
          setPath(authTypePath, hasBearerCredentials ? 'bearer' : hasBasicCredentials ? 'basic' : 'none');
        }
      }
    }
  }
}

function applyConfigEnvironment(
  env: NodeJS.ProcessEnv,
  setPath: (keys: ConfigPath, value: unknown) => void,
): IndexedConfigOverride[] {
  for (const [name, keys] of [...CONFIG_SECTION_ENV, ...CONFIG_VALUE_ENV]) {
    if (has(env, name)) setPath(keys, parseConfigEnvironmentValue(name, env[name]));
  }
  for (const [name, keys] of CONFIG_SECRET_ENV) {
    const fileName = `${name}_FILE`;
    if (has(env, name) && has(env, fileName)) {
      throw new Error(`Configuration error: both ${name} and ${fileName} are set. Set only one.`);
    }
    if (has(env, name)) setPath(keys, { env: name });
    if (has(env, fileName)) setPath(keys, { file: env[fileName] });
  }

  const indexedOverrides = indexedConfigOverrides(env);
  const secrets = new Map<string, IndexedConfigOverride>();
  for (const override of indexedOverrides) {
    if (override.secret) {
      const pathKey = JSON.stringify(override.path);
      const existing = secrets.get(pathKey);
      if (existing) {
        throw new Error(`Configuration error: both ${existing.name} and ${override.name} are set. Set only one.`);
      }
      secrets.set(pathKey, override);
      setPath(override.path, override.secret === 'file' ? { file: env[override.name] } : { env: override.name });
    } else {
      const value = parseConfigEnvironmentValue(override.name, env[override.name]);
      if (override.name.endsWith('_AUTH_TYPE')) setPath(override.path.slice(0, -1), { type: value });
      else setPath(override.path, value);
    }
  }
  return indexedOverrides;
}

export function applyConfigSetupEnvironment(document: unknown, env: NodeJS.ProcessEnv): UnknownRecord {
  const root = record(document, 'config');
  const setPath = (keys: ConfigPath, value: unknown): void => setConfigPath(root, keys, value);
  const indexedOverrides = applyConfigEnvironment(env, setPath);
  applyIndexedCollectionDefaults(indexedOverrides, setPath, (keys) => getConfigPath(root, keys), true);
  return root;
}

export interface MergedApplicationConfig {
  document: UnknownRecord;
}

export function mergeApplicationConfigEnvironment(file: string, env: NodeJS.ProcessEnv): MergedApplicationConfig {
  let yamlDocument;
  try {
    yamlDocument = parseYamlDocument(fs.readFileSync(file, 'utf8'));
    if (yamlDocument.errors.length > 0) throw yamlDocument.errors[0];
    record(yamlDocument.toJS(), 'config');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Configuration error: failed to read CONFIG_FILE at "${file}": ${message}`);
  }

  const setPath = (keys: ConfigPath, value: unknown): void => {
    for (let index = 0; index < keys.length - 1; index += 1) {
      if (typeof keys[index + 1] !== 'number') continue;
      const prefix = keys.slice(0, index + 1);
      const collection = yamlDocument.getIn(prefix, true);
      if (!isSeq(collection)) {
        yamlDocument.setIn(prefix, yamlDocument.createNode([]));
      }
    }
    yamlDocument.setIn(keys, yamlDocument.createNode(value));
  };
  const indexedOverrides = applyConfigEnvironment(env, setPath);
  applyIndexedCollectionDefaults(indexedOverrides, setPath, (keys) => yamlDocument.getIn(keys), false);
  return {
    document: record(yamlDocument.toJS(), 'config'),
  };
}

function sameConfigPath(left: ConfigPath, right: ConfigPath): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function configPathStartsWith(path: ConfigPath, prefix: ConfigPath): boolean {
  return prefix.length <= path.length && prefix.every((part, index) => part === path[index]);
}

function initialExplicitConfigPaths(env: NodeJS.ProcessEnv): ConfigPath[] {
  // Unlike the optional application sections, at least one complete instance
  // definition is required for the generated file to remain loadable.
  const paths: ConfigPath[] = [['instances']];
  for (const [name, path] of LEGACY_GENERATED_CONFIG_PATHS) {
    if (has(env, name)) paths.push(path);
  }
  for (const [name, path] of [...CONFIG_SECTION_ENV, ...CONFIG_VALUE_ENV]) {
    if (has(env, name)) paths.push(path);
  }
  for (const [name, path] of CONFIG_SECRET_ENV) {
    if (has(env, name) || has(env, `${name}_FILE`)) paths.push(path);
  }
  for (const override of indexedConfigOverrides(env)) {
    const arrayPath = CONFIG_ARRAY_ENV.find(([, candidate]) => (
      configPathStartsWith(override.path, candidate)
      && typeof override.path[candidate.length] === 'number'
    ))?.[1];
    paths.push(arrayPath || override.path);
  }
  return paths.filter((path, index) => paths.findIndex((candidate) => sameConfigPath(candidate, path)) === index);
}

function indentYaml(yaml: string, indentation: number): string[] {
  const prefix = ' '.repeat(indentation);
  return yaml.trimEnd().split('\n').map((line) => `${prefix}${line}`);
}

function commentYaml(yaml: string, indentation: number): string[] {
  const prefix = ' '.repeat(indentation);
  return yaml.trimEnd().split('\n').map((line) => `${prefix}#${line ? ` ${line}` : ''}`);
}

function stringifyConfigEntry(key: string, value: unknown): string {
  return stringifyYaml({ [key]: value }, { lineWidth: 0 });
}

function renderInitialConfigMap(
  value: UnknownRecord,
  path: ConfigPath,
  indentation: number,
  explicitPaths: readonly ConfigPath[],
): { lines: string[]; active: boolean } {
  const lines: string[] = [];
  let active = false;
  for (const [key, child] of Object.entries(value)) {
    const childPath: ConfigPath = [...path, key];
    const explicitlyActive = explicitPaths.some((explicitPath) => configPathStartsWith(childPath, explicitPath));
    const hasExplicitDescendant = explicitPaths.some((explicitPath) => configPathStartsWith(explicitPath, childPath));

    if (explicitlyActive) {
      lines.push(...indentYaml(stringifyConfigEntry(key, child), indentation));
      active = true;
      continue;
    }

    if (hasExplicitDescendant && child && typeof child === 'object' && !Array.isArray(child)) {
      const rendered = renderInitialConfigMap(child as UnknownRecord, childPath, indentation + 2, explicitPaths);
      if (rendered.active) {
        lines.push(`${' '.repeat(indentation)}${key}:`, ...rendered.lines);
        active = true;
        continue;
      }
    }

    lines.push(...commentYaml(stringifyConfigEntry(key, child), indentation));
  }
  return { lines, active };
}

function stringifyInitialApplicationConfig(document: UnknownRecord, env: NodeJS.ProcessEnv): string {
  const explicitPaths = initialExplicitConfigPaths(env);
  const rendered = renderInitialConfigMap(canonicalizeConfig(document) as UnknownRecord, [], 0, explicitPaths);
  if (!rendered.active) throw new Error('Configuration error: generated configuration has no active settings.');
  const header = INITIAL_CONFIG_HEADER.map((line) => `# ${line}`).join('\n');
  return `${header}\n\n${rendered.lines.join('\n')}\n`;
}

export function saveApplicationConfig(
  file: string,
  document: UnknownRecord,
  initialEnvironment?: NodeJS.ProcessEnv,
): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const yaml = initialEnvironment
      ? stringifyInitialApplicationConfig(document, initialEnvironment)
      : stringifyYaml(document, { lineWidth: 0 });
    fs.writeFileSync(file, yaml, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return true;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'EEXIST') return false;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Configuration error: failed to save generated configuration at "${file}": ${message}`);
  }
}
