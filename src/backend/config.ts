export interface RuntimeConfig {
  port: number;
  basePath: string;
  crowdsecUrl: string;
  crowdsecUser?: string;
  crowdsecPassword?: string;
  alertOrigins: string[];
  alertExtraScenarios: string[];
  simulationsEnabled: boolean;
  lookbackPeriod: string;
  lookbackMs: number;
  refreshIntervalMs: number;
  idleRefreshIntervalMs: number;
  idleThresholdMs: number;
  fullRefreshIntervalMs: number;
  bootstrapRetryDelayMs: number;
  bootstrapRetryEnabled: boolean;
  dockerImageRef: string;
  version: string;
  branch: string;
  commitHash: string;
  updateCheckEnabled: boolean;
  dbDir: string;
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
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function getIntervalName(intervalMs: number): string {
  if (intervalMs === 0) return 'Off';
  if (intervalMs === 5_000) return '5s';
  if (intervalMs === 30_000) return '30s';
  if (intervalMs === 60_000) return '1m';
  if (intervalMs === 300_000) return '5m';
  return `${intervalMs}ms`;
}

export function createRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const lookbackPeriod = env.CROWDSEC_LOOKBACK_PERIOD || '168h';
  const refreshIntervalMs = parseRefreshInterval(env.CROWDSEC_REFRESH_INTERVAL || '30s');

  return {
    port: Number(env.PORT || 3000),
    basePath: (env.BASE_PATH || '').replace(/\/$/, ''),
    crowdsecUrl: env.CROWDSEC_URL || 'http://crowdsec:8080',
    crowdsecUser: env.CROWDSEC_USER,
    crowdsecPassword: env.CROWDSEC_PASSWORD,
    alertOrigins: parseCsvEnv(env.CROWDSEC_ALERT_ORIGINS),
    alertExtraScenarios: parseCsvEnv(env.CROWDSEC_ALERT_EXTRA_SCENARIOS),
    simulationsEnabled: parseBooleanEnv(env.CROWDSEC_SIMULATIONS_ENABLED, false),
    lookbackPeriod,
    lookbackMs: parseLookbackToMs(lookbackPeriod),
    refreshIntervalMs,
    idleRefreshIntervalMs: parseRefreshInterval(env.CROWDSEC_IDLE_REFRESH_INTERVAL || '5m'),
    idleThresholdMs: parseRefreshInterval(env.CROWDSEC_IDLE_THRESHOLD || '2m'),
    fullRefreshIntervalMs: parseRefreshInterval(env.CROWDSEC_FULL_REFRESH_INTERVAL || '5m'),
    bootstrapRetryDelayMs: parseRefreshInterval(env.CROWDSEC_BOOTSTRAP_RETRY_DELAY || '30s'),
    bootstrapRetryEnabled: parseBooleanEnv(env.CROWDSEC_BOOTSTRAP_RETRY_ENABLED, true),
    dockerImageRef: (env.DOCKER_IMAGE_REF || 'theduffman85/crowdsec-web-ui').toLowerCase(),
    version: env.VITE_VERSION || '0.0.0',
    branch: env.VITE_BRANCH || 'main',
    commitHash: env.VITE_COMMIT_HASH || '',
    updateCheckEnabled: Boolean(env.VITE_COMMIT_HASH || env.VITE_VERSION),
    dbDir: env.DB_DIR || '/app/data',
  };
}
