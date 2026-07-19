import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { RuntimeConfig } from './config';
import { parseInstancesConfig, type CrowdsecInstanceConfig } from './instances-config';

type UnknownRecord = Record<string, unknown>;

export interface ParsedConfigFile {
  environment: NodeJS.ProcessEnv;
  instances: CrowdsecInstanceConfig[];
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
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new Error(`Configuration error: ${label} must be an array of non-empty strings.`);
  }
  return [...new Set(value.map((entry) => String(entry).trim()))];
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
  knownKeys(storage, ['dataDir', 'geonamesDir'], 'storage');
  setString(env, storage, 'dataDir', 'DB_DIR', 'storage');
  setString(env, storage, 'geonamesDir', 'GEONAMES_DUMP_DIR', 'storage');

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
    updateCheckEnabled,
  };
}

export function loadApplicationConfig(file: string, sourceEnv: NodeJS.ProcessEnv): ParsedConfigFile {
  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Configuration error: failed to read CONFIG_FILE at "${file}": ${message}`);
  }
  return parseApplicationConfig(parsed, sourceEnv);
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
    storage: { dataDir: config.dbDir, geonamesDir: config.geonamesDumpDir },
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

export function saveApplicationConfig(file: string, document: UnknownRecord): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, stringifyYaml(document, { lineWidth: 0 }), {
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
