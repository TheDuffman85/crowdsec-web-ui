import { createCrowdsecAuthConfig, type CrowdsecAuthConfig } from './auth';

export type AlertFilterMode = 'default' | 'new' | 'legacy';

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
  alwaysShowMachine: boolean;
  alwaysShowOrigin: boolean;
  lookbackPeriod: string;
  lookbackMs: number;
  refreshIntervalMs: number;
  idleRefreshIntervalMs: number;
  idleThresholdMs: number;
  fullRefreshIntervalMs: number;
  lapiRequestTimeoutMs: number;
  alertSyncChunkMs: number;
  alertSyncMinChunkMs: number;
  bootstrapRetryDelayMs: number;
  bootstrapRetryEnabled: boolean;
  dockerImageRef: string;
  version: string;
  branch: string;
  commitHash: string;
  updateCheckEnabled: boolean;
  dbDir: string;
  notificationSecretKey?: string;
  notificationAllowPrivateAddresses: boolean;
}

export function parseRefreshInterval(intervalStr: string | undefined | null): number {
  if (!intervalStr) return 0;
  const str = intervalStr.toLowerCase();

  if (str === 'manual' || str === '0') return 0;

  const match = str.match(/^(\d+)([smhd])$/);
  if (match) {
    const value = Number.parseInt(match[1], 10);
    const unit = match[2];
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

  if (hasNewAlertFilters && hasLegacyAlertFilters) {
    console.warn(
      'Both new and deprecated CrowdSec alert filter environment variables are set. Using CROWDSEC_ALERT_INCLUDE_ORIGINS/CROWDSEC_ALERT_EXCLUDE_ORIGINS/CROWDSEC_ALERT_INCLUDE_CAPI/CROWDSEC_ALERT_INCLUDE_ORIGIN_EMPTY/CROWDSEC_ALERT_EXCLUDE_ORIGIN_EMPTY.',
    );
  }

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
    console.warn(
      'CROWDSEC_ALERT_ORIGINS and CROWDSEC_ALERT_EXTRA_SCENARIOS are deprecated. Please migrate to CROWDSEC_ALERT_INCLUDE_ORIGINS/CROWDSEC_ALERT_EXCLUDE_ORIGINS/CROWDSEC_ALERT_INCLUDE_CAPI/CROWDSEC_ALERT_INCLUDE_ORIGIN_EMPTY/CROWDSEC_ALERT_EXCLUDE_ORIGIN_EMPTY.',
    );

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

export function createRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const lookbackPeriod = env.CROWDSEC_LOOKBACK_PERIOD || '168h';
  const refreshIntervalMs = parseRefreshInterval(env.CROWDSEC_REFRESH_INTERVAL || '30s');
  const crowdsecAuth = createCrowdsecAuthConfig(env);
  const notificationSecretKey = env.NOTIFICATION_SECRET_KEY?.trim() || undefined;
  const alertFilterConfig = parseAlertFilterConfig(env);

  return {
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
    alwaysShowMachine: parseBooleanEnv(env.CROWDSEC_ALWAYS_SHOW_MACHINE, false),
    alwaysShowOrigin: parseBooleanEnv(env.CROWDSEC_ALWAYS_SHOW_ORIGIN, false),
    lookbackPeriod,
    lookbackMs: parseLookbackToMs(lookbackPeriod),
    refreshIntervalMs,
    idleRefreshIntervalMs: parseRefreshInterval(env.CROWDSEC_IDLE_REFRESH_INTERVAL || '5m'),
    idleThresholdMs: parseRefreshInterval(env.CROWDSEC_IDLE_THRESHOLD || '2m'),
    fullRefreshIntervalMs: parseRefreshInterval(env.CROWDSEC_FULL_REFRESH_INTERVAL || '5m'),
    lapiRequestTimeoutMs: parsePositiveIntervalEnv(env.CROWDSEC_LAPI_REQUEST_TIMEOUT, '30s'),
    alertSyncChunkMs: parsePositiveIntervalEnv(env.CROWDSEC_ALERT_SYNC_CHUNK, '6h'),
    alertSyncMinChunkMs: parsePositiveIntervalEnv(env.CROWDSEC_ALERT_SYNC_MIN_CHUNK, '15m'),
    bootstrapRetryDelayMs: parseRefreshInterval(env.CROWDSEC_BOOTSTRAP_RETRY_DELAY || '30s'),
    bootstrapRetryEnabled: parseBooleanEnv(env.CROWDSEC_BOOTSTRAP_RETRY_ENABLED, true),
    dockerImageRef: (env.DOCKER_IMAGE_REF || 'theduffman85/crowdsec-web-ui').toLowerCase(),
    version: env.VITE_VERSION || '0.0.0',
    branch: env.VITE_BRANCH || 'main',
    commitHash: env.VITE_COMMIT_HASH || '',
    updateCheckEnabled: Boolean(env.VITE_COMMIT_HASH || env.VITE_VERSION),
    dbDir: env.DB_DIR || '/app/data',
    notificationSecretKey,
    notificationAllowPrivateAddresses: parseBooleanEnv(env.NOTIFICATION_ALLOW_PRIVATE_ADDRESSES, true),
  };
}
