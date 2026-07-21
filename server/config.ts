import fs from 'node:fs';
import path from 'node:path';
import { createCrowdsecAuthConfig, type CrowdsecAuthConfig } from './auth';
import {
  DEPRECATED_CONFIG_ENV,
  applyConfigSetupEnvironment,
  generateApplicationConfig,
  hasConfigEnvironmentOverrides,
  loadApplicationConfig,
  mergeApplicationConfigEnvironment,
  parseApplicationConfig,
  saveApplicationConfig,
  type ParsedConfigFile,
} from './config-file';
import { resolveSecretEnv } from './env-secrets';
import { hasLegacyConnectionEnvironment, loadInstancesConfig, type CrowdsecInstanceConfig } from './instances-config';

export type AlertFilterMode = 'default' | 'new' | 'legacy';
export type TimeFormat = 'browser' | '12h' | '24h';
export type OidcUnmatchedRole = 'deny' | 'admin' | 'read-only';
export const DEFAULT_OIDC_SCOPE = 'openid profile email';

export interface DashboardAuthConfig {
  enabled: boolean | null;
  sessionSecret?: string;
  totpSecret?: string;
  totpSeed?: string;
  oidcIssuerUrl?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  oidcScope: string;
  oidcGroupsClaim: string;
  oidcAdminGroups: string[];
  oidcReadOnlyGroups: string[];
  oidcUnmatchedRole: OidcUnmatchedRole;
}

export interface RuntimeConfig {
  port: number;
  basePath: string;
  crowdsecUrl: string;
  crowdsecAuth: CrowdsecAuthConfig;
  crowdsecAuthMode: CrowdsecAuthConfig['mode'];
  crowdsecTlsCertPath?: string;
  crowdsecTlsKeyPath?: string;
  crowdsecTlsCaCertPath?: string;
  alertFilterMode: AlertFilterMode;
  alertIncludeOrigins: string[];
  alertExcludeOrigins: string[];
  alertIncludeCapi: boolean;
  alertIncludeOriginEmpty: boolean;
  alertExcludeOriginEmpty: boolean;
  legacyAlertOrigins: string[];
  legacyAlertExtraScenarios: string[];
  simulationsEnabled: boolean;
  lookbackPeriod: string;
  lookbackMs: number;
  refreshIntervalMs: number;
  manualRefreshEnabled: boolean;
  idleRefreshIntervalMs: number;
  idleThresholdMs: number;
  lapiRequestTimeoutMs: number;
  bouncerPropagationDelayMs: number;
  prometheusUrl?: string;
  prometheusRequestTimeoutMs: number;
  heartbeatIntervalMs: number;
  alertSyncChunkMs: number;
  alertSyncMinChunkMs: number;
  reconcileWindowMs: number;
  reconcileRecentAgeMs: number;
  reconcileRecentIntervalMs: number;
  reconcileActiveIntervalMs: number;
  reconcileOldIntervalMs: number;
  reconcileWindowsPerRefresh: number;
  bootstrapRetryDelayMs: number;
  bootstrapRetryEnabled: boolean;
  dockerImageRef: string;
  version: string;
  branch: string;
  commitHash: string;
  updateCheckEnabled: boolean;
  deploymentMode: 'standard' | 'load-test';
  loadTestProfile: string | null;
  dbDir: string;
  geonamesDumpDir: string;
  sqliteWalEnabled: boolean;
  notificationSecretKey?: string;
  notificationAllowPrivateAddresses: boolean;
  notificationDebugPayloads: boolean;
  timeZone: string | null;
  timeFormat: TimeFormat;
  readOnly: boolean;
  dashboardAuth: DashboardAuthConfig;
  instances: CrowdsecInstanceConfig[];
}

export function parseTimeZone(value: string | undefined): string | null {
  const timeZone = value?.trim();
  if (!timeZone) return null;

  try {
    return new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`Invalid TZ value "${timeZone}". Use an IANA time zone such as Europe/Berlin or UTC.`);
  }
}

export function parseTimeFormat(value: string | undefined): TimeFormat {
  const timeFormat = value?.trim().toLowerCase();
  if (!timeFormat) return 'browser';
  if (timeFormat === '12h' || timeFormat === '24h') return timeFormat;
  throw new Error('Invalid TIME_FORMAT value. Must be one of: 12h, 24h.');
}

export function parseTotpSeed(value: string | undefined): string | undefined {
  const seed = value?.trim().replace(/\s+/g, '').replace(/=+$/g, '').toUpperCase();
  if (!seed) return undefined;
  if (seed.length < 26 || !/^[A-Z2-7]+$/.test(seed)) {
    throw new Error('Invalid AUTH_TOTP_SEED value. Must be a base32 seed containing at least 26 characters (128 bits).');
  }
  return seed;
}

export function parseRefreshInterval(intervalStr: string | undefined | null): number {
  if (!intervalStr) return 0;
  const str = intervalStr.toLowerCase();

  if (str === 'manual' || str === '0') return 0;

  const match = str.match(/^(\d+)(ms|[smhd])$/);
  if (match) {
    const value = Number.parseInt(match[1], 10);
    const unit = match[2];
    if (unit === 'ms') return value;
    if (unit === 's') return value * 1_000;
    if (unit === 'm') return value * 60_000;
    if (unit === 'h') return value * 3_600_000;
    if (unit === 'd') return value * 86_400_000;
  }
  return 0;
}

export function parseLookbackToMs(lookbackPeriod: string | undefined | null): number {
  if (!lookbackPeriod) return 7 * 24 * 60 * 60 * 1_000;
  const match = lookbackPeriod.match(/^(\d+)([hmd])$/);
  if (!match) return 7 * 24 * 60 * 60 * 1_000;

  const value = Number.parseInt(match[1], 10);
  const unit = match[2];

  if (unit === 'h') return value * 3_600_000;
  if (unit === 'd') return value * 86_400_000;
  if (unit === 'm') return value * 60_000;
  return 7 * 24 * 60 * 60 * 1_000;
}

export function parseBooleanEnv(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  const normalized = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

export function parseOptionalBooleanEnv(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

export function parseOidcUnmatchedRole(value: string | undefined): OidcUnmatchedRole {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return 'deny';
  if (normalized === 'deny' || normalized === 'admin' || normalized === 'read-only') return normalized;
  throw new Error('Invalid AUTH_OIDC_UNMATCHED_ROLE value. Must be one of: deny, admin, read-only.');
}

export function parseOidcScope(value: string | undefined): string {
  const scope = value?.trim();
  if (!scope) return DEFAULT_OIDC_SCOPE;
  const scopes = scope.split(/\s+/);
  if (!scopes.includes('openid')) {
    throw new Error('Invalid AUTH_OIDC_SCOPE value. Must include openid.');
  }
  return scopes.join(' ');
}

export function parseCsvEnv(value: string | undefined): string[] {
  if (!value) return [];
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const deduped = new Set<string>();
  for (const entry of entries) {
    deduped.add(entry);
  }
  return Array.from(deduped);
}

function resolveDashboardAuthEnabled(env: NodeJS.ProcessEnv): boolean | null {
  if (env.AUTH_ENABLED !== undefined) {
    return parseOptionalBooleanEnv(env.AUTH_ENABLED);
  }
  return parseOptionalBooleanEnv(env.CROWDSEC_AUTH_ENABLED);
}

function hasEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, name);
}

function resolveRenamedEnv(env: NodeJS.ProcessEnv, name: string, legacyName: string): string | undefined {
  return hasEnv(env, name) ? env[name] : env[legacyName];
}

function resolveRenamedSecretEnv(env: NodeJS.ProcessEnv, name: string, legacyName: string): string | undefined {
  if (hasEnv(env, name) || hasEnv(env, `${name}_FILE`)) {
    return resolveSecretEnv(name, env);
  }
  return resolveSecretEnv(legacyName, env);
}

function parseDashboardAuthConfig(env: NodeJS.ProcessEnv): DashboardAuthConfig {
  return {
    enabled: resolveDashboardAuthEnabled(env),
    sessionSecret: resolveRenamedSecretEnv(env, 'AUTH_SECRET', 'CROWDSEC_AUTH_SECRET')?.trim() || undefined,
    totpSecret: resolveRenamedSecretEnv(env, 'AUTH_TOTP_SECRET', 'CROWDSEC_AUTH_TOTP_SECRET')?.trim() || undefined,
    totpSeed: parseTotpSeed(resolveRenamedSecretEnv(env, 'AUTH_TOTP_SEED', 'CROWDSEC_AUTH_TOTP_SEED')),
    oidcIssuerUrl: resolveRenamedEnv(env, 'AUTH_OIDC_ISSUER_URL', 'CROWDSEC_AUTH_OIDC_ISSUER_URL')?.trim() || undefined,
    oidcClientId: resolveRenamedEnv(env, 'AUTH_OIDC_CLIENT_ID', 'CROWDSEC_AUTH_OIDC_CLIENT_ID')?.trim() || undefined,
    oidcClientSecret: resolveRenamedSecretEnv(env, 'AUTH_OIDC_CLIENT_SECRET', 'CROWDSEC_AUTH_OIDC_CLIENT_SECRET')?.trim() || undefined,
    oidcScope: parseOidcScope(resolveRenamedEnv(env, 'AUTH_OIDC_SCOPE', 'CROWDSEC_AUTH_OIDC_SCOPE')),
    oidcGroupsClaim: resolveRenamedEnv(env, 'AUTH_OIDC_GROUPS_CLAIM', 'CROWDSEC_AUTH_OIDC_GROUPS_CLAIM')?.trim() || 'groups',
    oidcAdminGroups: parseCsvEnv(resolveRenamedEnv(env, 'AUTH_OIDC_ADMIN_GROUPS', 'CROWDSEC_AUTH_OIDC_ADMIN_GROUPS')),
    oidcReadOnlyGroups: parseCsvEnv(resolveRenamedEnv(env, 'AUTH_OIDC_READ_ONLY_GROUPS', 'CROWDSEC_AUTH_OIDC_READ_ONLY_GROUPS')),
    oidcUnmatchedRole: parseOidcUnmatchedRole(resolveRenamedEnv(env, 'AUTH_OIDC_UNMATCHED_ROLE', 'CROWDSEC_AUTH_OIDC_UNMATCHED_ROLE')),
  };
}

export function getIntervalName(intervalMs: number): string {
  if (intervalMs === 0) return 'Off';
  if (intervalMs === 5_000) return '5s';
  if (intervalMs === 30_000) return '30s';
  if (intervalMs === 60_000) return '1m';
  if (intervalMs === 300_000) return '5m';
  if (intervalMs % 86_400_000 === 0) return `${intervalMs / 86_400_000}d`;
  if (intervalMs % 3_600_000 === 0) return `${intervalMs / 3_600_000}h`;
  if (intervalMs % 60_000 === 0) return `${intervalMs / 60_000}m`;
  if (intervalMs % 1_000 === 0) return `${intervalMs / 1_000}s`;
  return `${intervalMs}ms`;
}

function parsePositiveIntervalEnv(value: string | undefined, defaultValue: string): number {
  const parsed = parseRefreshInterval(value || defaultValue);
  if (parsed > 0) return parsed;
  return parseRefreshInterval(defaultValue);
}

function parseNonNegativeIntervalEnv(value: string | undefined, defaultValue: string): number {
  const normalized = (value ?? defaultValue).trim().toLowerCase();
  if (normalized === '0') return 0;

  const match = normalized.match(/^(\d+)(ms|[smhd])$/);
  if (match) {
    if (match[2] === 'ms') return Number.parseInt(match[1], 10);
    return parseRefreshInterval(normalized);
  }
  return parseRefreshInterval(defaultValue);
}

function parsePositiveIntegerEnv(value: string | undefined, defaultValue: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

function parseAlertFilterConfig(env: NodeJS.ProcessEnv): Pick<
  RuntimeConfig,
  | 'alertFilterMode'
  | 'alertIncludeOrigins'
  | 'alertExcludeOrigins'
  | 'alertIncludeCapi'
  | 'alertIncludeOriginEmpty'
  | 'alertExcludeOriginEmpty'
  | 'legacyAlertOrigins'
  | 'legacyAlertExtraScenarios'
> {
  const includeOriginEmpty = env.CROWDSEC_ALERT_INCLUDE_ORIGIN_EMPTY;
  const excludeOriginEmpty = env.CROWDSEC_ALERT_EXCLUDE_ORIGIN_EMPTY;
  const hasNewAlertFilters = env.CROWDSEC_ALERT_INCLUDE_ORIGINS !== undefined
    || env.CROWDSEC_ALERT_EXCLUDE_ORIGINS !== undefined
    || env.CROWDSEC_ALERT_INCLUDE_CAPI !== undefined
    || includeOriginEmpty !== undefined
    || excludeOriginEmpty !== undefined;
  const hasLegacyAlertFilters = env.CROWDSEC_ALERT_ORIGINS !== undefined
    || env.CROWDSEC_ALERT_EXTRA_SCENARIOS !== undefined;

  const legacyAlertOrigins = parseCsvEnv(env.CROWDSEC_ALERT_ORIGINS);
  const legacyAlertExtraScenarios = parseCsvEnv(env.CROWDSEC_ALERT_EXTRA_SCENARIOS);

  if (hasNewAlertFilters) {
    return {
      alertFilterMode: 'new',
      alertIncludeOrigins: parseCsvEnv(env.CROWDSEC_ALERT_INCLUDE_ORIGINS),
      alertExcludeOrigins: parseCsvEnv(env.CROWDSEC_ALERT_EXCLUDE_ORIGINS),
      alertIncludeCapi: parseBooleanEnv(env.CROWDSEC_ALERT_INCLUDE_CAPI, false),
      alertIncludeOriginEmpty: parseBooleanEnv(includeOriginEmpty, false),
      alertExcludeOriginEmpty: parseBooleanEnv(excludeOriginEmpty, false),
      legacyAlertOrigins,
      legacyAlertExtraScenarios,
    };
  }

  if (hasLegacyAlertFilters) {
    const alertIncludeOrigins: string[] = [];
    let alertIncludeCapi = false;

    for (const origin of legacyAlertOrigins) {
      if (origin.trim().toLowerCase() === 'none') {
        continue;
      }
      if (origin.trim().toUpperCase() === 'CAPI') {
        alertIncludeCapi = true;
        continue;
      }
      alertIncludeOrigins.push(origin);
    }

    return {
      alertFilterMode: 'legacy',
      alertIncludeOrigins,
      alertExcludeOrigins: [],
      alertIncludeCapi,
      alertIncludeOriginEmpty: false,
      alertExcludeOriginEmpty: false,
      legacyAlertOrigins,
      legacyAlertExtraScenarios,
    };
  }

  return {
    alertFilterMode: 'default',
    alertIncludeOrigins: [],
    alertExcludeOrigins: [],
    alertIncludeCapi: false,
    alertIncludeOriginEmpty: false,
    alertExcludeOriginEmpty: false,
    legacyAlertOrigins: [],
    legacyAlertExtraScenarios: [],
  };
}

function warnRemovedColumnVisibilityEnv(env: NodeJS.ProcessEnv): void {
  const removedVars = [
    env.CROWDSEC_ALWAYS_SHOW_MACHINE !== undefined ? 'CROWDSEC_ALWAYS_SHOW_MACHINE' : undefined,
    env.CROWDSEC_ALWAYS_SHOW_ORIGIN !== undefined ? 'CROWDSEC_ALWAYS_SHOW_ORIGIN' : undefined,
  ].filter((name): name is string => Boolean(name));

  if (removedVars.length === 0) return;

  console.warn(
    `${removedVars.join(' and ')} ${removedVars.length === 1 ? 'is' : 'are'} deprecated and ignored. Use the table Columns dialog to configure Machine and Origin visibility.`,
  );
}

function createRuntimeConfigFromEnvironment(env: NodeJS.ProcessEnv): RuntimeConfig {
  const lookbackPeriod = env.CROWDSEC_LOOKBACK_PERIOD || '168h';
  const refreshIntervalMs = parseRefreshInterval(env.CROWDSEC_REFRESH_INTERVAL || '1m');
  const crowdsecAuth = createCrowdsecAuthConfig(env);
  const notificationSecretKey = resolveSecretEnv('NOTIFICATION_SECRET_KEY', env)?.trim() || undefined;
  const alertFilterConfig = parseAlertFilterConfig(env);
  warnRemovedColumnVisibilityEnv(env);

  const runtimeConfig: RuntimeConfig = {
    port: Number(env.PORT || 3000),
    basePath: (env.BASE_PATH || '').replace(/\/$/, ''),
    crowdsecUrl: env.CROWDSEC_URL || 'http://crowdsec:8080',
    crowdsecAuth,
    crowdsecAuthMode: crowdsecAuth.mode,
    crowdsecTlsCertPath: crowdsecAuth.mode === 'mtls' ? crowdsecAuth.certPath : undefined,
    crowdsecTlsKeyPath: crowdsecAuth.mode === 'mtls' ? crowdsecAuth.keyPath : undefined,
    crowdsecTlsCaCertPath: crowdsecAuth.mode === 'mtls' ? crowdsecAuth.caCertPath : undefined,
    ...alertFilterConfig,
    simulationsEnabled: parseBooleanEnv(env.CROWDSEC_SIMULATIONS_ENABLED, false),
    lookbackPeriod,
    lookbackMs: parseLookbackToMs(lookbackPeriod),
    refreshIntervalMs,
    manualRefreshEnabled: parseBooleanEnv(env.CROWDSEC_MANUAL_REFRESH_ENABLED, false),
    idleRefreshIntervalMs: parseRefreshInterval(env.CROWDSEC_IDLE_REFRESH_INTERVAL || '10m'),
    idleThresholdMs: parseRefreshInterval(env.CROWDSEC_IDLE_THRESHOLD || '2m'),
    lapiRequestTimeoutMs: parsePositiveIntervalEnv(env.CROWDSEC_LAPI_REQUEST_TIMEOUT, '30s'),
    bouncerPropagationDelayMs: parseNonNegativeIntervalEnv(env.CROWDSEC_BOUNCER_PROPAGATION_DELAY, '15s'),
    prometheusUrl: env.CROWDSEC_PROMETHEUS_URL?.trim() || undefined,
    prometheusRequestTimeoutMs: parsePositiveIntervalEnv(env.CROWDSEC_PROMETHEUS_REQUEST_TIMEOUT, '5s'),
    heartbeatIntervalMs: parseRefreshInterval(env.CROWDSEC_HEARTBEAT_INTERVAL || '30s'),
    alertSyncChunkMs: parsePositiveIntervalEnv(env.CROWDSEC_ALERT_SYNC_CHUNK, '12h'),
    alertSyncMinChunkMs: parsePositiveIntervalEnv(env.CROWDSEC_ALERT_SYNC_MIN_CHUNK, '15m'),
    reconcileWindowMs: parsePositiveIntervalEnv(env.CROWDSEC_RECONCILE_WINDOW, '1h'),
    reconcileRecentAgeMs: parsePositiveIntervalEnv(env.CROWDSEC_RECONCILE_RECENT_AGE, '24h'),
    reconcileRecentIntervalMs: parsePositiveIntervalEnv(env.CROWDSEC_RECONCILE_RECENT_INTERVAL, '15m'),
    reconcileActiveIntervalMs: parsePositiveIntervalEnv(env.CROWDSEC_RECONCILE_ACTIVE_INTERVAL, '5m'),
    reconcileOldIntervalMs: parsePositiveIntervalEnv(env.CROWDSEC_RECONCILE_OLD_INTERVAL, '3h'),
    reconcileWindowsPerRefresh: parsePositiveIntegerEnv(env.CROWDSEC_RECONCILE_WINDOWS_PER_REFRESH, 2),
    bootstrapRetryDelayMs: parseRefreshInterval(env.CROWDSEC_BOOTSTRAP_RETRY_DELAY || '30s'),
    bootstrapRetryEnabled: parseBooleanEnv(env.CROWDSEC_BOOTSTRAP_RETRY_ENABLED, true),
    dockerImageRef: (env.DOCKER_IMAGE_REF || 'theduffman85/crowdsec-web-ui').toLowerCase(),
    version: env.VITE_VERSION || '0.0.0',
    branch: env.VITE_BRANCH || 'main',
    commitHash: env.VITE_COMMIT_HASH || '',
    updateCheckEnabled: Boolean(env.VITE_COMMIT_HASH || env.VITE_VERSION),
    deploymentMode: env.CROWDSEC_WEB_UI_MODE === 'load-test' ? 'load-test' : 'standard',
    loadTestProfile: env.CROWDSEC_WEB_UI_MODE === 'load-test'
      ? env.LOADTEST_PROFILE?.trim() || 'default'
      : null,
    dbDir: env.DB_DIR || '/app/data',
    geonamesDumpDir: env.GEONAMES_DUMP_DIR || path.resolve(process.cwd(), 'geonames'),
    sqliteWalEnabled: true,
    notificationSecretKey,
    notificationAllowPrivateAddresses: parseBooleanEnv(env.NOTIFICATION_ALLOW_PRIVATE_ADDRESSES, true),
    notificationDebugPayloads: parseBooleanEnv(env.NOTIFICATION_DEBUG_PAYLOADS, false),
    timeZone: parseTimeZone(env.TZ),
    timeFormat: parseTimeFormat(resolveRenamedEnv(env, 'TIME_FORMAT', 'CROWDSEC_TIME_FORMAT')),
    readOnly: parseBooleanEnv(env.PERMISSION_READ_ONLY, false),
    dashboardAuth: parseDashboardAuthConfig(env),
    instances: [],
  };

  const instancesFile = env.CROWDSEC_INSTANCES_CONFIG_FILE?.trim();
  if (instancesFile) {
    const legacyVariables = hasLegacyConnectionEnvironment(env);
    if (legacyVariables.length > 0) {
      throw new Error(`Configuration error: CROWDSEC_INSTANCES_CONFIG_FILE cannot be combined with legacy connection variables: ${legacyVariables.join(', ')}.`);
    }
    runtimeConfig.instances = loadInstancesConfig(instancesFile, env);
  } else {
    runtimeConfig.instances = [{
      id: 'default',
      name: env.CROWDSEC_INSTANCE_NAME?.trim() || 'CrowdSec',
      icon: env.CROWDSEC_INSTANCE_ICON?.trim() || undefined,
      lapiUrl: runtimeConfig.crowdsecUrl,
      lapiAuth: runtimeConfig.crowdsecAuth,
      lapiTls: {
        caFile: runtimeConfig.crowdsecTlsCaCertPath,
        certFile: runtimeConfig.crowdsecTlsCertPath,
        keyFile: runtimeConfig.crowdsecTlsKeyPath,
      },
      prometheus: runtimeConfig.prometheusUrl ? [{
        id: 'default',
        name: 'CrowdSec',
        url: runtimeConfig.prometheusUrl,
        auth: { type: 'none' },
        tls: {},
        requestTimeoutMs: runtimeConfig.prometheusRequestTimeoutMs,
      }] : [],
      sync: {},
    }];
  }

  return runtimeConfig;
}

function configuredDeprecatedEnvironment(env: NodeJS.ProcessEnv): string[] {
  return DEPRECATED_CONFIG_ENV.filter((name) => Object.prototype.hasOwnProperty.call(env, name));
}

function warnDeprecatedEnvironment(
  env: NodeJS.ProcessEnv,
  options: { configFile: string; migrated: boolean },
): void {
  const names = configuredDeprecatedEnvironment(env);
  if (names.length === 0) return;
  console.warn(
    `Deprecated environment-based settings detected: ${names.join(', ')}. `
    + (options.migrated
      ? `They were migrated into the generated YAML at "${options.configFile}". `
        + 'This YAML is now authoritative; these variables no longer affect application settings and can be removed.'
      : `The application YAML at "${options.configFile}" takes precedence; `
        + 'these variables do not affect application settings and can be removed.'),
  );
}

function createRuntimeConfigFromParsedConfig(parsed: ParsedConfigFile): RuntimeConfig {
  const runtimeConfig = createRuntimeConfigFromEnvironment(parsed.environment);
  runtimeConfig.instances = parsed.instances;
  runtimeConfig.sqliteWalEnabled = parsed.sqliteWalEnabled;
  const primaryInstance = parsed.instances[0];
  runtimeConfig.crowdsecUrl = primaryInstance.lapiUrl;
  runtimeConfig.crowdsecAuth = primaryInstance.lapiAuth.mode === 'mtls'
    ? { ...primaryInstance.lapiAuth, caCertPath: primaryInstance.lapiTls.caFile }
    : primaryInstance.lapiAuth;
  runtimeConfig.crowdsecAuthMode = primaryInstance.lapiAuth.mode;
  runtimeConfig.crowdsecTlsCertPath = primaryInstance.lapiTls.certFile;
  runtimeConfig.crowdsecTlsKeyPath = primaryInstance.lapiTls.keyFile;
  runtimeConfig.crowdsecTlsCaCertPath = primaryInstance.lapiTls.caFile;
  runtimeConfig.prometheusUrl = primaryInstance.prometheus[0]?.url;
  if (parsed.updateCheckEnabled !== undefined) runtimeConfig.updateCheckEnabled = parsed.updateCheckEnabled;
  return runtimeConfig;
}

export interface RuntimeConfigOptions {
  defaultConfigFile?: string;
}

function defaultApplicationConfigFile(): string {
  const dockerDataDir = '/app/data';
  const dataDir = fs.existsSync(dockerDataDir) ? dockerDataDir : path.resolve(process.cwd(), 'data');
  return path.join(dataDir, 'config.yaml');
}

export function createRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: RuntimeConfigOptions = {},
): RuntimeConfig {
  const explicitConfigFile = env.CONFIG_FILE?.trim() || undefined;
  const defaultConfigFile = options.defaultConfigFile || defaultApplicationConfigFile();
  const configFile = explicitConfigFile || defaultConfigFile;
  let migrated = false;
  let parsedConfig: ParsedConfigFile | undefined;

  if (!explicitConfigFile && !fs.existsSync(configFile)) {
    const legacyConfig = createRuntimeConfigFromEnvironment(env);
    const generatedConfig = applyConfigSetupEnvironment(generateApplicationConfig(env, legacyConfig), env);
    parseApplicationConfig(generatedConfig, env);
    migrated = saveApplicationConfig(configFile, generatedConfig, env);
    if (migrated) console.log(`Saved generated configuration to ${configFile}.`);
  }

  if (!migrated && fs.existsSync(configFile) && hasConfigEnvironmentOverrides(env)) {
    const mergedConfig = mergeApplicationConfigEnvironment(configFile, env);
    parsedConfig = parseApplicationConfig(mergedConfig.document, env);
    console.log(`Applied CONFIG_ overrides to application configuration from ${configFile}.`);
  }

  warnDeprecatedEnvironment(env, { configFile, migrated });
  const runtimeConfig = createRuntimeConfigFromParsedConfig(parsedConfig || loadApplicationConfig(configFile, env));
  console.log(`Loaded application configuration from ${configFile}.`);
  return runtimeConfig;
}
