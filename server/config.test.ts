import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createRuntimeConfig as createRuntimeConfigImpl, getIntervalName, parseBooleanEnv, parseCsvEnv, parseLookbackToMs, parseOidcScope, parseOidcUnmatchedRole, parseOptionalBooleanEnv, parseRefreshInterval, parseTimeFormat, parseTimeZone } from './config';

const tempDirs: string[] = [];

function createTempSecret(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'crowdsec-web-ui-config-test-'));
  tempDirs.push(dir);
  const filePath = join(dir, 'secret.txt');
  writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

function createTempConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'crowdsec-web-ui-instances-test-'));
  tempDirs.push(dir);
  const filePath = join(dir, 'instances.yaml');
  writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

function createMissingConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crowdsec-web-ui-full-config-test-'));
  tempDirs.push(dir);
  return join(dir, 'config.yaml');
}

function createRuntimeConfig(env: NodeJS.ProcessEnv) {
  return createRuntimeConfigImpl(env, { defaultConfigFile: createMissingConfigPath() });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('config helpers', () => {
  test('parseRefreshInterval handles supported inputs', () => {
    expect(parseRefreshInterval('manual')).toBe(0);
    expect(parseRefreshInterval('0')).toBe(0);
    expect(parseRefreshInterval('5s')).toBe(5_000);
    expect(parseRefreshInterval('250ms')).toBe(250);
    expect(parseRefreshInterval('30s')).toBe(30_000);
    expect(parseRefreshInterval('1m')).toBe(60_000);
    expect(parseRefreshInterval('5m')).toBe(300_000);
    expect(parseRefreshInterval('2h')).toBe(7_200_000);
    expect(parseRefreshInterval('1d')).toBe(86_400_000);
    expect(parseRefreshInterval('invalid')).toBe(0);
  });

  test('parseLookbackToMs uses sane defaults', () => {
    expect(parseLookbackToMs(undefined)).toBe(604_800_000);
    expect(parseLookbackToMs('5d')).toBe(432_000_000);
    expect(parseLookbackToMs('12h')).toBe(43_200_000);
    expect(parseLookbackToMs('15m')).toBe(900_000);
  });

  test('parseBooleanEnv supports common truthy and falsy forms', () => {
    expect(parseBooleanEnv(undefined, true)).toBe(true);
    expect(parseBooleanEnv('yes')).toBe(true);
    expect(parseBooleanEnv('On')).toBe(true);
    expect(parseBooleanEnv('0', true)).toBe(false);
    expect(parseBooleanEnv('maybe', true)).toBe(true);
  });

  test('parseOptionalBooleanEnv only accepts explicit boolean values', () => {
    expect(parseOptionalBooleanEnv(undefined)).toBeNull();
    expect(parseOptionalBooleanEnv('true')).toBe(true);
    expect(parseOptionalBooleanEnv('OFF')).toBe(false);
    expect(parseOptionalBooleanEnv('maybe')).toBeNull();
  });

  test('parseOidcUnmatchedRole defaults to deny and validates supported values', () => {
    expect(parseOidcUnmatchedRole(undefined)).toBe('deny');
    expect(parseOidcUnmatchedRole(' DENY ')).toBe('deny');
    expect(parseOidcUnmatchedRole('admin')).toBe('admin');
    expect(parseOidcUnmatchedRole('read-only')).toBe('read-only');
    expect(() => parseOidcUnmatchedRole('viewer')).toThrow(/AUTH_OIDC_UNMATCHED_ROLE/);
  });

  test('parseOidcScope defaults, normalizes, and requires openid', () => {
    expect(parseOidcScope(undefined)).toBe('openid profile email');
    expect(parseOidcScope(' openid   profile email roles ')).toBe('openid profile email roles');
    expect(() => parseOidcScope('profile email groups')).toThrow(/AUTH_OIDC_SCOPE/);
  });

  test('parseCsvEnv splits, trims, and drops empty entries', () => {
    expect(parseCsvEnv(undefined)).toEqual([]);
    expect(parseCsvEnv(' crowdsec , manual/web-ui ,, cscli ')).toEqual(['crowdsec', 'manual/web-ui', 'cscli']);
  });

  test('getIntervalName formats known intervals', () => {
    expect(getIntervalName(0)).toBe('Off');
    expect(getIntervalName(30_000)).toBe('30s');
    expect(getIntervalName(900_000)).toBe('15m');
    expect(getIntervalName(21_600_000)).toBe('6h');
    expect(getIntervalName(12_345)).toBe('12345ms');
  });

  test('date and time configuration validates and normalizes supported values', () => {
    expect(parseTimeZone(undefined)).toBeNull();
    expect(parseTimeZone(' Europe/Berlin ')).toBe('Europe/Berlin');
    expect(parseTimeZone('UTC')).toBe('UTC');
    expect(() => parseTimeZone('Not/A_Timezone')).toThrow(/Invalid TZ value/);
    expect(parseTimeFormat(undefined)).toBe('browser');
    expect(parseTimeFormat('24H')).toBe('24h');
    expect(() => parseTimeFormat('auto')).toThrow(/TIME_FORMAT/);
  });

  test('uses the browser clock format when only TZ is configured', () => {
    const config = createRuntimeConfig({ TZ: 'Europe/Berlin' });
    expect(config.timeZone).toBe('Europe/Berlin');
    expect(config.timeFormat).toBe('browser');
  });

  test('marks the dedicated load-test runtime mode', () => {
    expect(createRuntimeConfig({})).toEqual(expect.objectContaining({
      deploymentMode: 'standard',
      loadTestProfile: null,
    }));
    expect(createRuntimeConfig({ CROWDSEC_WEB_UI_MODE: 'load-test' })).toEqual(expect.objectContaining({
      deploymentMode: 'load-test',
      loadTestProfile: 'default',
    }));
    expect(createRuntimeConfig({
      CROWDSEC_WEB_UI_MODE: 'load-test',
      LOADTEST_PROFILE: 'blocklists-mixed',
    }).loadTestProfile).toBe('blocklists-mixed');
  });

  test('uses a configurable grace period for bouncer deletion propagation', () => {
    expect(createRuntimeConfig({}).bouncerPropagationDelayMs).toBe(15_000);
    expect(createRuntimeConfig({ CROWDSEC_BOUNCER_PROPAGATION_DELAY: '0' }).bouncerPropagationDelayMs).toBe(0);
    expect(createRuntimeConfig({ CROWDSEC_BOUNCER_PROPAGATION_DELAY: '0s' }).bouncerPropagationDelayMs).toBe(0);
    expect(createRuntimeConfig({ CROWDSEC_BOUNCER_PROPAGATION_DELAY: '25ms' }).bouncerPropagationDelayMs).toBe(25);
    expect(createRuntimeConfig({ CROWDSEC_BOUNCER_PROPAGATION_DELAY: 'invalid' }).bouncerPropagationDelayMs).toBe(15_000);
  });

  test('createRuntimeConfig reads relevant environment values', () => {
    const config = createRuntimeConfig({
      PORT: '4000',
      BASE_PATH: '/crowdsec/',
      CROWDSEC_URL: 'http://localhost:8080',
      CROWDSEC_USER: 'watcher',
      CROWDSEC_PASSWORD: 'secret',
      CROWDSEC_ALERT_INCLUDE_ORIGINS: 'crowdsec, cscli, crowdsec',
      CROWDSEC_ALERT_EXCLUDE_ORIGINS: 'lists, crowdsec',
      CROWDSEC_ALERT_INCLUDE_CAPI: 'true',
      CROWDSEC_ALERT_INCLUDE_ORIGIN_EMPTY: 'true',
      CROWDSEC_ALERT_EXCLUDE_ORIGIN_EMPTY: 'true',
      CROWDSEC_SIMULATIONS_ENABLED: 'false',
      CROWDSEC_LOOKBACK_PERIOD: '2d',
      CROWDSEC_REFRESH_INTERVAL: '5s',
      CROWDSEC_MANUAL_REFRESH_ENABLED: 'true',
      CROWDSEC_IDLE_REFRESH_INTERVAL: '1m',
      CROWDSEC_IDLE_THRESHOLD: '30s',
      CROWDSEC_LAPI_REQUEST_TIMEOUT: '2m',
      CROWDSEC_BOUNCER_PROPAGATION_DELAY: '20s',
      CROWDSEC_PROMETHEUS_URL: 'http://crowdsec:6060/metrics',
      CROWDSEC_PROMETHEUS_REQUEST_TIMEOUT: '10s',
      CROWDSEC_HEARTBEAT_INTERVAL: '1m',
      CROWDSEC_ALERT_SYNC_CHUNK: '3h',
      CROWDSEC_ALERT_SYNC_MIN_CHUNK: '30m',
      CROWDSEC_RECONCILE_WINDOW: '2h',
      CROWDSEC_RECONCILE_RECENT_AGE: '12h',
      CROWDSEC_RECONCILE_RECENT_INTERVAL: '10m',
      CROWDSEC_RECONCILE_ACTIVE_INTERVAL: '2m',
      CROWDSEC_RECONCILE_OLD_INTERVAL: '6h',
      CROWDSEC_RECONCILE_WINDOWS_PER_REFRESH: '4',
      CROWDSEC_BOOTSTRAP_RETRY_DELAY: '1m',
      CROWDSEC_BOOTSTRAP_RETRY_ENABLED: 'false',
      DOCKER_IMAGE_REF: 'Example/Repo',
      VITE_VERSION: '1.2.3',
      VITE_BRANCH: 'dev',
      VITE_COMMIT_HASH: 'abc123',
      DB_DIR: '/tmp/app',
      GEONAMES_DUMP_DIR: '/tmp/geonames',
      NOTIFICATION_SECRET_KEY: 'notif-secret',
      NOTIFICATION_ALLOW_PRIVATE_ADDRESSES: 'true',
      NOTIFICATION_DEBUG_PAYLOADS: 'true',
      TZ: 'Europe/Berlin',
      TIME_FORMAT: '24h',
      AUTH_ENABLED: 'true',
      AUTH_SECRET: 'auth-secret',
      AUTH_TOTP_SECRET: 'totp-secret',
      AUTH_TOTP_SEED: 'jbsw y3dp ehpk 3pxp jbsw y3dp ehpk 3pxp====',
      AUTH_OIDC_ISSUER_URL: 'https://idp.example.com/application/o/crowdsec/',
      AUTH_OIDC_CLIENT_ID: 'crowdsec-client',
      AUTH_OIDC_CLIENT_SECRET: 'oidc-secret',
      AUTH_OIDC_SCOPE: 'openid profile email roles',
      AUTH_OIDC_GROUPS_CLAIM: 'roles',
      AUTH_OIDC_ADMIN_GROUPS: 'admins, secops',
      AUTH_OIDC_READ_ONLY_GROUPS: 'viewers',
      AUTH_OIDC_UNMATCHED_ROLE: 'read-only',
    });

    expect(config.port).toBe(4000);
    expect(config.basePath).toBe('/crowdsec');
    expect(config.crowdsecAuthMode).toBe('password');
    expect(config.crowdsecAuth).toEqual({ mode: 'password', user: 'watcher', password: 'secret' });
    expect(config.alertFilterMode).toBe('new');
    expect(config.alertIncludeOrigins).toEqual(['crowdsec', 'cscli']);
    expect(config.alertExcludeOrigins).toEqual(['lists', 'crowdsec']);
    expect(config.alertIncludeCapi).toBe(true);
    expect(config.alertIncludeOriginEmpty).toBe(true);
    expect(config.alertExcludeOriginEmpty).toBe(true);
    expect(config.legacyAlertOrigins).toEqual([]);
    expect(config.legacyAlertExtraScenarios).toEqual([]);
    expect(config.simulationsEnabled).toBe(false);
    expect(config.lookbackMs).toBe(172_800_000);
    expect(config.refreshIntervalMs).toBe(5_000);
    expect(config.manualRefreshEnabled).toBe(true);
    expect(config.idleRefreshIntervalMs).toBe(60_000);
    expect(config.lapiRequestTimeoutMs).toBe(120_000);
    expect(config.bouncerPropagationDelayMs).toBe(20_000);
    expect(config.prometheusUrl).toBe('http://crowdsec:6060/metrics');
    expect(config.prometheusRequestTimeoutMs).toBe(10_000);
    expect(config.heartbeatIntervalMs).toBe(60_000);
    expect(config.alertSyncChunkMs).toBe(10_800_000);
    expect(config.alertSyncMinChunkMs).toBe(1_800_000);
    expect(config.reconcileWindowMs).toBe(7_200_000);
    expect(config.reconcileRecentAgeMs).toBe(43_200_000);
    expect(config.reconcileRecentIntervalMs).toBe(600_000);
    expect(config.reconcileActiveIntervalMs).toBe(120_000);
    expect(config.reconcileOldIntervalMs).toBe(21_600_000);
    expect(config.reconcileWindowsPerRefresh).toBe(4);
    expect(config.bootstrapRetryEnabled).toBe(false);
    expect(config.dockerImageRef).toBe('example/repo');
    expect(config.updateCheckEnabled).toBe(true);
    expect(config.dbDir).toBe('/tmp/app');
    expect(config.geonamesDumpDir).toBe('/tmp/geonames');
    expect(config.notificationSecretKey).toBe('notif-secret');
    expect(config.notificationAllowPrivateAddresses).toBe(true);
    expect(config.notificationDebugPayloads).toBe(true);
    expect(config.timeZone).toBe('Europe/Berlin');
    expect(config.timeFormat).toBe('24h');
    expect(config.readOnly).toBe(false);
    expect(config.dashboardAuth).toEqual({
      enabled: true,
      sessionSecret: 'auth-secret',
      totpSecret: 'totp-secret',
      totpSeed: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      oidcIssuerUrl: 'https://idp.example.com/application/o/crowdsec/',
      oidcClientId: 'crowdsec-client',
      oidcClientSecret: 'oidc-secret',
      oidcScope: 'openid profile email roles',
      oidcGroupsClaim: 'roles',
      oidcAdminGroups: ['admins', 'secops'],
      oidcReadOnlyGroups: ['viewers'],
      oidcUnmatchedRole: 'read-only',
    });
  });

  test('createRuntimeConfig disables simulations by default', () => {
    const config = createRuntimeConfig({});
    expect(config.crowdsecAuthMode).toBe('none');
    expect(config.crowdsecAuth).toEqual({ mode: 'none' });
    expect(config.alertFilterMode).toBe('default');
    expect(config.alertIncludeOrigins).toEqual([]);
    expect(config.alertExcludeOrigins).toEqual([]);
    expect(config.alertIncludeCapi).toBe(false);
    expect(config.alertIncludeOriginEmpty).toBe(false);
    expect(config.alertExcludeOriginEmpty).toBe(false);
    expect(config.legacyAlertOrigins).toEqual([]);
    expect(config.legacyAlertExtraScenarios).toEqual([]);
    expect(config.simulationsEnabled).toBe(false);
    expect(config.notificationSecretKey).toBeUndefined();
    expect(config.notificationAllowPrivateAddresses).toBe(true);
    expect(config.notificationDebugPayloads).toBe(false);
    expect(config.timeZone).toBeNull();
    expect(config.timeFormat).toBe('browser');
    expect(config.refreshIntervalMs).toBe(60_000);
    expect(config.manualRefreshEnabled).toBe(false);
    expect(config.idleRefreshIntervalMs).toBe(600_000);
    expect(config.lapiRequestTimeoutMs).toBe(30_000);
    expect(config.prometheusUrl).toBeUndefined();
    expect(config.prometheusRequestTimeoutMs).toBe(5_000);
    expect(config.heartbeatIntervalMs).toBe(30_000);
    expect(config.alertSyncChunkMs).toBe(43_200_000);
    expect(config.alertSyncMinChunkMs).toBe(900_000);
    expect(config.reconcileWindowMs).toBe(3_600_000);
    expect(config.reconcileRecentAgeMs).toBe(86_400_000);
    expect(config.reconcileRecentIntervalMs).toBe(900_000);
    expect(config.reconcileActiveIntervalMs).toBe(300_000);
    expect(config.reconcileOldIntervalMs).toBe(10_800_000);
    expect(config.reconcileWindowsPerRefresh).toBe(2);
    expect(config.sqliteWalEnabled).toBe(true);
    expect(config.readOnly).toBe(false);
    expect(config.dashboardAuth.enabled).toBeNull();
    expect(config.dashboardAuth.oidcScope).toBe('openid profile email');
    expect(config.dashboardAuth.oidcGroupsClaim).toBe('groups');
    expect(config.dashboardAuth.oidcUnmatchedRole).toBe('deny');
  });

  test('createRuntimeConfig rejects OIDC scopes without openid', () => {
    expect(() => createRuntimeConfig({
      AUTH_OIDC_SCOPE: 'profile email groups',
    })).toThrow(/AUTH_OIDC_SCOPE/);
  });

  test('loads all application settings from CONFIG_FILE and ignores deprecated setting environment variables', () => {
    const configFile = createTempConfig(`
server:
  port: 4321
  basePath: /security
storage:
  dataDir: /tmp/yaml-data
  geonamesDir: /tmp/yaml-geonames
  walEnabled: false
ui:
  timeZone: UTC
  timeFormat: 12h
  readOnly: true
auth:
  enabled: false
  sessionSecret:
    env: YAML_AUTH_SECRET
  oidc:
    issuerUrl: https://idp.example.com/
    clientId: yaml-client
    clientSecret:
      env: YAML_OIDC_SECRET
    scope: openid email
    groupsClaim: roles
    adminGroups: [admins]
    readOnlyGroups: [viewers]
    unmatchedRole: read-only
notifications:
  secretKey:
    env: YAML_NOTIFICATION_KEY
  allowPrivateAddresses: false
  debugPayloads: true
updates:
  enabled: false
crowdsec:
  simulationsEnabled: true
  alertFilters:
    includeOrigins: [crowdsec]
    excludeOrigins: [lists]
    includeCapi: true
    includeOriginEmpty: true
    excludeOriginEmpty: false
  sync:
    lookback: 2d
    refreshInterval: 30s
    manualRefreshEnabled: true
    idleRefreshInterval: 5m
    idleThreshold: 1m
    requestTimeout: 45s
    bouncerPropagationDelay: 5s
    metricsRequestTimeout: 8s
    heartbeatInterval: 1m
    alertSyncChunk: 4h
    alertSyncMinChunk: 10m
    reconcileWindow: 2h
    reconcileRecentAge: 12h
    reconcileRecentInterval: 5m
    reconcileActiveInterval: 1m
    reconcileOldInterval: 4h
    reconcileWindowsPerRefresh: 3
    bootstrapRetryDelay: 20s
    bootstrapRetryEnabled: false
instances:
  - id: main
    name: Main
    lapi:
      url: https://crowdsec.example.com:8080
      auth:
        username: watcher
        password:
          env: YAML_LAPI_PASSWORD
    metrics: []
`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const config = createRuntimeConfig({
        CONFIG_FILE: configFile,
        PORT: 'not-a-number',
        TZ: 'not/a-time-zone',
        CROWDSEC_URL: 'http://ignored:8080',
        YAML_AUTH_SECRET: 'auth-secret',
        YAML_OIDC_SECRET: 'oidc-secret',
        YAML_NOTIFICATION_KEY: 'notification-secret',
        YAML_LAPI_PASSWORD: 'lapi-secret',
      });

      expect(config).toMatchObject({
        port: 4321,
        basePath: '/security',
        dbDir: '/tmp/yaml-data',
        geonamesDumpDir: '/tmp/yaml-geonames',
        sqliteWalEnabled: false,
        timeZone: 'UTC',
        timeFormat: '12h',
        readOnly: true,
        simulationsEnabled: true,
        lookbackMs: 172_800_000,
        refreshIntervalMs: 30_000,
        manualRefreshEnabled: true,
        notificationSecretKey: 'notification-secret',
        notificationAllowPrivateAddresses: false,
        notificationDebugPayloads: true,
        updateCheckEnabled: false,
      });
      expect(config.dashboardAuth.sessionSecret).toBe('auth-secret');
      expect(config.dashboardAuth.oidcClientSecret).toBe('oidc-secret');
      expect(config.instances[0].lapiAuth).toEqual({ mode: 'password', user: 'watcher', password: 'lapi-secret' });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/PORT.*CROWDSEC_URL.*application YAML.*takes precedence.*variables do not affect/i));
      expect(log).toHaveBeenCalledWith(`Loaded application configuration from ${configFile}.`);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  test('accepts direct application, LAPI, and metrics secrets in YAML', () => {
    const configFile = createTempConfig(`
auth:
  sessionSecret: direct-session-secret
  totpSecret: direct-totp-secret
  totpSeed: JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP
  oidc:
    clientSecret: direct-oidc-secret
notifications:
  secretKey: direct-notification-secret
instances:
  - id: direct
    name: Direct secrets
    lapi:
      url: https://crowdsec.example.com:8080
      auth:
        type: password
        username: watcher
        password: direct-lapi-password
    metrics:
      - id: lapi
        name: LAPI metrics
        url: https://crowdsec.example.com:6060/metrics
        auth:
          token: direct-metrics-token
`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const config = createRuntimeConfig({ CONFIG_FILE: configFile });
      expect(config.dashboardAuth).toMatchObject({
        sessionSecret: 'direct-session-secret',
        totpSecret: 'direct-totp-secret',
        totpSeed: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
        oidcClientSecret: 'direct-oidc-secret',
      });
      expect(config.notificationSecretKey).toBe('direct-notification-secret');
      expect(config.instances[0].lapiAuth).toEqual({
        mode: 'password', user: 'watcher', password: 'direct-lapi-password',
      });
      expect(config.instances[0].prometheus[0].auth).toEqual({
        type: 'bearer', token: 'direct-metrics-token',
      });
    } finally {
      log.mockRestore();
    }
  });

  test('maps legacy environment through generated configuration when CONFIG_FILE is unset', () => {
    const generatedConfigFile = createMissingConfigPath();
    const env = {
      PORT: '4100',
      CROWDSEC_URL: 'http://crowdsec:8080',
      CROWDSEC_USER: 'watcher',
      CROWDSEC_PASSWORD: 'do-not-write-this-password',
      AUTH_SECRET: 'do-not-write-this-auth-secret',
      CROWDSEC_REFRESH_INTERVAL: '5m',
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const generatedConfig = createRuntimeConfigImpl(env, { defaultConfigFile: generatedConfigFile });
      expect(generatedConfig.port).toBe(4100);
      expect(generatedConfig.refreshIntervalMs).toBe(300_000);
      expect(generatedConfig.instances[0].lapiAuth).toEqual({
        mode: 'password', user: 'watcher', password: 'do-not-write-this-password',
      });
      expect(generatedConfig.dashboardAuth.sessionSecret).toBe('do-not-write-this-auth-secret');
      const saved = readFileSync(generatedConfigFile, 'utf8');
      expect(saved).not.toContain('do-not-write-this-password');
      expect(saved).not.toContain('do-not-write-this-auth-secret');
      expect(saved).toContain('# This file was created automatically because no application config existed.');
      expect(saved).toContain('server:\n  port: 4100\n  # basePath: ""');
      expect(saved).toContain('# storage:\n#   dataDir: /app/data');
      expect(saved).toContain('    refreshInterval: 5m');
      expect(saved).toContain('    # lookback: 168h');
      const document = parseYaml(saved);
      expect(document.auth.sessionSecret).toEqual({ env: 'AUTH_SECRET' });
      expect(document.instances[0].lapi.auth.password).toEqual({ env: 'CROWDSEC_PASSWORD' });
      expect(document.server.port).toBe(4100);
      expect(document.server.basePath).toBeUndefined();
      expect(document.storage).toBeUndefined();
      expect(document.crowdsec.sync.lookback).toBeUndefined();
      expect(statSync(generatedConfigFile).mode & 0o777).toBe(0o600);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/migrated into the generated YAML.*config\.yaml.*now authoritative.*variables no longer affect/i));
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/Saved generated configuration.*config\.yaml/i));
      expect(log).toHaveBeenCalledWith(`Loaded application configuration from ${generatedConfigFile}.`);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  test('creates the initial YAML from CONFIG_ setup environment variables', () => {
    const generatedConfigFile = createMissingConfigPath();
    const env = {
      CONFIG_SERVER_PORT: '4200',
      CONFIG_SERVER_BASE_PATH: '/security',
      CONFIG_STORAGE_DATA_DIR: '/tmp/config-data',
      CONFIG_STORAGE_WAL_ENABLED: 'false',
      CONFIG_UI: '{ timeZone: UTC, timeFormat: 24h, readOnly: false }',
      CONFIG_UI_READ_ONLY: 'true',
      CONFIG_AUTH_SESSION_SECRET: 'do-not-write-this-auth-secret',
      CONFIG_AUTH_OIDC_ADMIN_GROUPS_0: 'admins',
      CONFIG_AUTH_OIDC_ADMIN_GROUPS_1: 'secops',
      CONFIG_UPDATES_ENABLED: 'false',
      CONFIG_CROWDSEC_SYNC_REFRESH_INTERVAL: '2m',
      CONFIG_INSTANCE_LAPI_URL: 'https://primary.example.com:8080',
      CONFIG_INSTANCE_LAPI_AUTH_USERNAME: 'watcher',
      CONFIG_INSTANCE_LAPI_AUTH_PASSWORD: 'do-not-write-this-password',
      CONFIG_INSTANCE_METRICS_URL: 'https://primary.example.com:6060/metrics',
      CONFIG_INSTANCE_METRICS_AUTH_TOKEN: 'do-not-write-this-token',
      CONFIG_INSTANCE_METRICS_REQUEST_TIMEOUT: '10s',
      CONFIG_INSTANCE_METRICS_1_URL: 'https://primary.example.com:6061/metrics',
      CONFIG_INSTANCES_1_ID: 'secondary',
      CONFIG_INSTANCES_1_NAME: 'Secondary',
      CONFIG_INSTANCES_1_LAPI_URL: 'http://secondary:8080',
      CONFIG_INSTANCES_1_LAPI_AUTH_TYPE: 'none',
      CONFIG_INSTANCES_1_SYNC_REFRESH_INTERVAL: '30s',
      CONFIG_INSTANCES_1_METRICS_URL: 'http://secondary:6060/metrics',
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const config = createRuntimeConfigImpl(env, { defaultConfigFile: generatedConfigFile });
      expect(config).toMatchObject({
        port: 4200,
        basePath: '/security',
        dbDir: '/tmp/config-data',
        sqliteWalEnabled: false,
        timeZone: 'UTC',
        readOnly: true,
        refreshIntervalMs: 120_000,
        updateCheckEnabled: false,
      });
      expect(config.dashboardAuth.sessionSecret).toBe('do-not-write-this-auth-secret');
      expect(config.dashboardAuth.oidcAdminGroups).toEqual(['admins', 'secops']);
      expect(config.instances).toHaveLength(2);
      expect(config.instances[0]).toMatchObject({
        id: '0',
        name: 'Instance 0',
        lapiUrl: 'https://primary.example.com:8080',
        lapiAuth: { mode: 'password', user: 'watcher', password: 'do-not-write-this-password' },
      });
      expect(config.instances[0].prometheus[0]).toMatchObject({
        id: '0',
        name: 'Metrics 0',
        url: 'https://primary.example.com:6060/metrics',
        auth: { type: 'bearer', token: 'do-not-write-this-token' },
        requestTimeoutMs: 10_000,
      });
      expect(config.instances[0].prometheus[1]).toMatchObject({ id: '1', name: 'Metrics 1', auth: { type: 'none' } });
      expect(config.instances[1]).toMatchObject({ id: 'secondary', lapiAuth: { mode: 'none' } });
      expect(config.instances[1].sync.refreshIntervalMs).toBe(30_000);
      expect(config.instances[1].prometheus[0]).toMatchObject({ id: '0', name: 'Metrics 0', auth: { type: 'none' } });

      const saved = readFileSync(generatedConfigFile, 'utf8');
      expect(saved).not.toContain('do-not-write-this-password');
      expect(saved).not.toContain('do-not-write-this-auth-secret');
      expect(saved).not.toContain('do-not-write-this-token');
      expect(saved).toContain('# This file was created automatically because no application config existed.');
      expect(saved).toContain('  basePath: /security');
      expect(saved).toContain('  # enabled: auto');
      expect(saved).toContain('  walEnabled: false');
      expect(saved).toContain('  # geonamesDir:');
      const document = parseYaml(saved);
      expect(document.server).toEqual({ port: 4200, basePath: '/security' });
      expect(document.storage.walEnabled).toBe(false);
      expect(document.auth.sessionSecret).toEqual({ env: 'CONFIG_AUTH_SESSION_SECRET' });
      expect(document.instances).toHaveLength(2);
      expect(document.instances[0].id).toBe('0');
      expect(document.instances[0].name).toBe('Instance 0');
      expect(document.instances[0].lapi.auth.type).toBe('password');
      expect(document.instances[0].metrics[0].id).toBe('0');
      expect(document.instances[0].metrics[0].name).toBe('Metrics 0');
      expect(document.instances[0].metrics[0].auth.type).toBe('bearer');
      expect(document.instances[0].metrics[1].id).toBe('1');
      expect(document.instances[0].metrics[1].name).toBe('Metrics 1');
      expect(document.instances[0].metrics[1].auth.type).toBe('none');
      expect(document.instances[0].lapi.auth.password).toEqual({ env: 'CONFIG_INSTANCE_LAPI_AUTH_PASSWORD' });
      expect(document.instances[0].metrics[0].auth.token).toEqual({ env: 'CONFIG_INSTANCE_METRICS_AUTH_TOKEN' });
      expect(warn).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(`Saved generated configuration to ${generatedConfigFile}.`);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  test('keeps explicitly supplied values active even when they equal the current default', () => {
    const generatedConfigFile = createMissingConfigPath();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const config = createRuntimeConfigImpl({
        CONFIG_SERVER_PORT: '3000',
      }, { defaultConfigFile: generatedConfigFile });
      const saved = readFileSync(generatedConfigFile, 'utf8');
      expect(config.port).toBe(3000);
      expect(saved).toContain('server:\n  port: 3000\n  # basePath: ""');
      expect(parseYaml(saved).server).toEqual({ port: 3000 });
    } finally {
      log.mockRestore();
    }
  });

  test('infers mTLS and basic metrics authentication from CONFIG_ credentials', () => {
    const generatedConfigFile = createMissingConfigPath();
    const certFile = createTempSecret('certificate');
    const keyFile = createTempSecret('private-key');
    const config = createRuntimeConfigImpl({
      CONFIG_INSTANCE_LAPI_URL: 'https://crowdsec.example.com:8080',
      CONFIG_INSTANCE_LAPI_AUTH_CERT_FILE: certFile,
      CONFIG_INSTANCE_LAPI_AUTH_KEY_FILE: keyFile,
      CONFIG_INSTANCE_METRICS_URL: 'https://crowdsec.example.com:6060/metrics',
      CONFIG_INSTANCE_METRICS_AUTH_USERNAME: 'metrics-user',
      CONFIG_INSTANCE_METRICS_AUTH_PASSWORD: 'metrics-password',
    }, { defaultConfigFile: generatedConfigFile });

    expect(config.instances[0].lapiAuth).toEqual({ mode: 'mtls', certPath: certFile, keyPath: keyFile });
    expect(config.instances[0].prometheus[0].auth).toEqual({
      type: 'basic', username: 'metrics-user', password: 'metrics-password',
    });
    const persisted = parseYaml(readFileSync(generatedConfigFile, 'utf8'));
    expect(persisted.instances[0].lapi.auth.type).toBe('mtls');
    expect(persisted.instances[0].metrics[0].auth.type).toBe('basic');
  });

  test('prefers CONFIG_ setup values over deprecated values during initial generation', () => {
    const generatedConfigFile = createMissingConfigPath();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const config = createRuntimeConfigImpl({
        PORT: '4100',
        CONFIG_SERVER_PORT: '4200',
      }, { defaultConfigFile: generatedConfigFile });
      expect(config.port).toBe(4200);
      expect(parseYaml(readFileSync(generatedConfigFile, 'utf8')).server.port).toBe(4200);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/PORT.*migrated into the generated YAML/i));
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  test('applies CONFIG_ values to an existing YAML and persists the merged result', () => {
    const generatedConfigFile = createMissingConfigPath();
    createRuntimeConfigImpl({ CONFIG_SERVER_PORT: '4100' }, { defaultConfigFile: generatedConfigFile });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const config = createRuntimeConfigImpl({
        CONFIG_SERVER_PORT: '4200',
        CONFIG_CROWDSEC_SYNC_REFRESH_INTERVAL: '5m',
      }, { defaultConfigFile: generatedConfigFile });
      expect(config.port).toBe(4200);
      expect(config.refreshIntervalMs).toBe(300_000);
      const persisted = parseYaml(readFileSync(generatedConfigFile, 'utf8'));
      expect(persisted.server.port).toBe(4200);
      expect(persisted.crowdsec.sync.refreshInterval).toBe('5m');
      expect(log).toHaveBeenCalledWith(`Applied CONFIG_ overrides and saved application configuration to ${generatedConfigFile}.`);
    } finally {
      log.mockRestore();
    }
  });

  test('merges CONFIG_ values into the file selected by CONFIG_FILE', () => {
    const configFile = createTempConfig(`
# This comment should survive environment merges.
server:
  port: 3100
ui:
  readOnly: false
instances:
  - id: default
    name: CrowdSec
    lapi:
      url: http://crowdsec:8080
      auth: { type: none }
    metrics: [ { url: http://old-crowdsec:6060/metrics, id: "0", name: Metrics 0, auth: { type: none } } ]
`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const config = createRuntimeConfigImpl({
        CONFIG_FILE: configFile,
        CONFIG_SERVER_PORT: '3200',
        CONFIG_UI_READ_ONLY: 'true',
        CONFIG_AUTH_OIDC_ADMIN_GROUPS_0: 'admins',
        CONFIG_AUTH_OIDC_ADMIN_GROUPS_1: 'secops',
        CONFIG_INSTANCE_LAPI_AUTH_USERNAME: 'watcher',
        CONFIG_INSTANCE_LAPI_AUTH_PASSWORD: 'persist-by-reference',
        CONFIG_INSTANCE_METRICS_URL: 'http://crowdsec:6060/metrics',
      });
      expect(config.port).toBe(3200);
      expect(config.readOnly).toBe(true);
      expect(config.dashboardAuth.oidcAdminGroups).toEqual(['admins', 'secops']);
      expect(config.instances[0].lapiAuth).toEqual({ mode: 'password', user: 'watcher', password: 'persist-by-reference' });
      expect(config.instances[0].prometheus[0]).toMatchObject({ id: '0', name: 'Metrics 0', auth: { type: 'none' } });
      const persisted = parseYaml(readFileSync(configFile, 'utf8'));
      expect(persisted.server.port).toBe(3200);
      expect(persisted.ui.readOnly).toBe(true);
      expect(persisted.auth.oidc.adminGroups).toEqual(['admins', 'secops']);
      expect(persisted.instances[0].lapi.auth.password).toEqual({ env: 'CONFIG_INSTANCE_LAPI_AUTH_PASSWORD' });
      expect(persisted.instances[0].metrics[0]).toMatchObject({ id: '0', name: 'Metrics 0' });
      expect(persisted.instances[0].metrics[0].auth.type).toBe('none');
      const persistedYaml = readFileSync(configFile, 'utf8');
      expect(persistedYaml).toContain('# This comment should survive environment merges.');
      expect(persistedYaml).not.toContain('This file was created automatically');
      expect(persistedYaml).toContain(`    metrics:
      - url: http://crowdsec:6060/metrics
        id: "0"
        name: Metrics 0
        auth:
          type: none`);
      expect(persistedYaml).not.toContain('metrics: [');

      const withoutAuth = createRuntimeConfigImpl({
        CONFIG_FILE: configFile,
        CONFIG_INSTANCE_LAPI_AUTH_TYPE: 'none',
        CONFIG_INSTANCE_METRICS_URL: 'http://crowdsec:6060/metrics',
      });
      expect(withoutAuth.instances[0].lapiAuth).toEqual({ mode: 'none' });
      expect(parseYaml(readFileSync(configFile, 'utf8')).instances[0].lapi.auth).toEqual({ type: 'none' });
      expect(readFileSync(configFile, 'utf8')).not.toContain('metrics: [');
    } finally {
      log.mockRestore();
    }
  });

  test('validates CONFIG_ setup values before writing the YAML', () => {
    const generatedConfigFile = createMissingConfigPath();
    expect(() => createRuntimeConfigImpl({
      CONFIG_SERVER_PORT: 'not-a-port',
    }, { defaultConfigFile: generatedConfigFile })).toThrow(/server\.port must be a positive integer/i);
    expect(existsSync(generatedConfigFile)).toBe(false);
  });

  test('does not modify an existing YAML when a CONFIG_ override is invalid', () => {
    const configFile = createTempConfig(`
server:
  port: 3100
instances:
  - id: default
    name: CrowdSec
    lapi:
      url: http://crowdsec:8080
      auth: { type: none }
`);
    const original = readFileSync(configFile, 'utf8');
    expect(() => createRuntimeConfigImpl({
      CONFIG_FILE: configFile,
      CONFIG_SERVER_PORT: 'not-a-port',
    })).toThrow(/server\.port must be a positive integer/i);
    expect(readFileSync(configFile, 'utf8')).toBe(original);
  });

  test('rejects unknown indexed CONFIG_ paths', () => {
    const generatedConfigFile = createMissingConfigPath();
    expect(() => createRuntimeConfigImpl({
      CONFIG_INSTANCES_0_LAPI_URl: 'http://typo:8080',
    }, { defaultConfigFile: generatedConfigFile })).toThrow(/unknown indexed CONFIG_ variable/i);
    expect(existsSync(generatedConfigFile)).toBe(false);
  });

  test('rejects duplicate shorthand and indexed CONFIG_ paths', () => {
    const generatedConfigFile = createMissingConfigPath();
    expect(() => createRuntimeConfigImpl({
      CONFIG_INSTANCES_NAME: 'Old shorthand',
    }, { defaultConfigFile: generatedConfigFile })).toThrow(/Use CONFIG_INSTANCE_\*/i);
    expect(() => createRuntimeConfigImpl({
      CONFIG_INSTANCE_NAME: 'Shorthand',
      CONFIG_INSTANCES_0_NAME: 'Indexed',
    }, { defaultConfigFile: generatedConfigFile })).toThrow(/both .* target the same setting/i);
    expect(() => createRuntimeConfigImpl({
      CONFIG_INSTANCE_METRICS_URL: 'http://crowdsec:6060/metrics',
      CONFIG_INSTANCES_0_METRICS_0_URL: 'http://crowdsec:6061/metrics',
    }, { defaultConfigFile: generatedConfigFile })).toThrow(/both .* target the same setting/i);
  });

  test('rejects gaps in indexed CONFIG_ scalar arrays', () => {
    const generatedConfigFile = createMissingConfigPath();
    expect(() => createRuntimeConfigImpl({
      CONFIG_AUTH_OIDC_ADMIN_GROUPS_1: 'secops',
    }, { defaultConfigFile: generatedConfigFile })).toThrow(/adminGroups must be an array of non-empty strings/i);
    expect(existsSync(generatedConfigFile)).toBe(false);
  });

  test('saves generated legacy configuration at the selected default path', () => {
    const generatedConfigFile = createMissingConfigPath();
    const dataDir = dirname(generatedConfigFile);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const config = createRuntimeConfigImpl(
        { DB_DIR: dataDir, PORT: '4100' },
        { defaultConfigFile: generatedConfigFile },
      );
      expect(config.dbDir).toBe(dataDir);
      expect(parseYaml(readFileSync(generatedConfigFile, 'utf8')).server.port).toBe(4100);
    } finally {
      log.mockRestore();
    }
  });

  test('uses the working-directory data folder as the default configuration path', () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), 'crowdsec-web-ui-default-config-test-'));
    tempDirs.push(workingDirectory);
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(workingDirectory);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const config = createRuntimeConfigImpl({ PORT: '4100' });
      const generatedConfigFile = join(workingDirectory, 'data', 'config.yaml');
      expect(config.port).toBe(4100);
      expect(parseYaml(readFileSync(generatedConfigFile, 'utf8')).server.port).toBe(4100);
      expect(log).toHaveBeenCalledWith(`Loaded application configuration from ${generatedConfigFile}.`);
    } finally {
      cwd.mockRestore();
      log.mockRestore();
    }
  });

  test('loads an existing default configuration without overwriting it or applying legacy settings', () => {
    const generatedConfigFile = createMissingConfigPath();
    createRuntimeConfigImpl({ PORT: '4100' }, { defaultConfigFile: generatedConfigFile });
    const userEdited = readFileSync(generatedConfigFile, 'utf8').replace('port: 4100', 'port: 4200');
    writeFileSync(generatedConfigFile, userEdited, 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const config = createRuntimeConfigImpl({ PORT: '4300' }, { defaultConfigFile: generatedConfigFile });
      expect(config.port).toBe(4200);
      expect(readFileSync(generatedConfigFile, 'utf8')).toBe(userEdited);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/YAML.*takes precedence.*variables do not affect/i));
      expect(log).toHaveBeenCalledWith(`Loaded application configuration from ${generatedConfigFile}.`);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  test('rejects a configured CONFIG_FILE that does not exist', () => {
    const configFile = createMissingConfigPath();
    expect(() => createRuntimeConfig({ CONFIG_FILE: configFile, PORT: '4100' }))
      .toThrow(/failed to read CONFIG_FILE.*ENOENT/i);
  });

  test('keeps the shipped example configuration executable', () => {
    const passwordSecretFile = createTempSecret('example-secret');
    const example = readFileSync(join(process.cwd(), 'config.example.yaml'), 'utf8')
      .replace('/run/secrets/crowdsec_password', passwordSecretFile);
    const configFile = createTempConfig(example);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const config = createRuntimeConfig({
        CONFIG_FILE: configFile,
      });
      expect(config.port).toBe(3000);
      expect(config.instances[0]).toMatchObject({
        id: 'default',
        lapiUrl: 'http://crowdsec:8080',
        lapiAuth: { mode: 'password', user: 'crowdsec-web-ui', password: 'example-secret' },
      });
    } finally {
      log.mockRestore();
    }
  });

  test('uses an unversioned application configuration schema', () => {
    const configFile = createTempConfig(`
version: 1
instances:
  - id: default
    name: CrowdSec
    lapi:
      url: http://crowdsec:8080
      auth: { type: none }
`);
    expect(() => createRuntimeConfig({ CONFIG_FILE: configFile })).toThrow(/unknown root setting.*version/i);
  });

  test('incorporates an existing instances YAML into generated legacy configuration', () => {
    const legacyInstancesFile = createTempConfig(`
instances:
  - id: existing
    name: Existing instance
    lapi:
      url: https://existing.example.com:8080
      auth:
        type: password
        username: watcher
        password:
          env: EXISTING_LAPI_PASSWORD
`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const config = createRuntimeConfig({
        CROWDSEC_INSTANCES_CONFIG_FILE: legacyInstancesFile,
        EXISTING_LAPI_PASSWORD: 'existing-secret',
      });
      expect(config.instances[0]).toMatchObject({
        id: 'existing',
        lapiUrl: 'https://existing.example.com:8080',
        lapiAuth: { mode: 'password', user: 'watcher', password: 'existing-secret' },
      });
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  test('createRuntimeConfig enables read-only mode from environment', () => {
    const config = createRuntimeConfig({ PERMISSION_READ_ONLY: 'true' });
    expect(config.readOnly).toBe(true);
  });

  test('createRuntimeConfig falls back when positive intervals are disabled', () => {
    const config = createRuntimeConfig({ CROWDSEC_LAPI_REQUEST_TIMEOUT: 'manual' });
    expect(config.lapiRequestTimeoutMs).toBe(30_000);
  });

  test('createRuntimeConfig reads file-backed dashboard auth secrets', () => {
    const config = createRuntimeConfig({
      AUTH_ENABLED: 'false',
      AUTH_SECRET_FILE: createTempSecret('auth-secret-from-file\n'),
      AUTH_TOTP_SECRET_FILE: createTempSecret('totp-secret-from-file\n'),
      AUTH_TOTP_SEED_FILE: createTempSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP\n'),
      AUTH_OIDC_CLIENT_SECRET_FILE: createTempSecret('oidc-secret-from-file\n'),
    });

    expect(config.dashboardAuth.enabled).toBe(false);
    expect(config.dashboardAuth.sessionSecret).toBe('auth-secret-from-file');
    expect(config.dashboardAuth.totpSecret).toBe('totp-secret-from-file');
    expect(config.dashboardAuth.totpSeed).toBe('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
    expect(config.dashboardAuth.oidcClientSecret).toBe('oidc-secret-from-file');
  });

  test('createRuntimeConfig keeps legacy file-backed auth secrets working', () => {
    const config = createRuntimeConfig({
      CROWDSEC_AUTH_SECRET_FILE: createTempSecret('legacy-auth-secret-from-file\n'),
      CROWDSEC_AUTH_TOTP_SECRET_FILE: createTempSecret('legacy-totp-secret-from-file\n'),
      CROWDSEC_AUTH_TOTP_SEED_FILE: createTempSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP\n'),
      CROWDSEC_AUTH_OIDC_CLIENT_SECRET_FILE: createTempSecret('legacy-oidc-secret-from-file\n'),
    });

    expect(config.dashboardAuth.sessionSecret).toBe('legacy-auth-secret-from-file');
    expect(config.dashboardAuth.totpSecret).toBe('legacy-totp-secret-from-file');
    expect(config.dashboardAuth.totpSeed).toBe('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
    expect(config.dashboardAuth.oidcClientSecret).toBe('legacy-oidc-secret-from-file');
  });

  test('createRuntimeConfig keeps legacy non-CrowdSec variable names working', () => {
    const config = createRuntimeConfig({
      CROWDSEC_TIME_FORMAT: '12h',
      CROWDSEC_AUTH_SECRET: 'legacy-auth-secret',
      CROWDSEC_AUTH_TOTP_SECRET: 'legacy-totp-secret',
      CROWDSEC_AUTH_TOTP_SEED: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      CROWDSEC_AUTH_OIDC_ISSUER_URL: 'https://legacy-idp.example.com/',
      CROWDSEC_AUTH_OIDC_CLIENT_ID: 'legacy-client',
      CROWDSEC_AUTH_OIDC_CLIENT_SECRET: 'legacy-oidc-secret',
      CROWDSEC_AUTH_OIDC_SCOPE: 'openid profile legacy',
      CROWDSEC_AUTH_OIDC_GROUPS_CLAIM: 'legacy-groups',
      CROWDSEC_AUTH_OIDC_ADMIN_GROUPS: 'legacy-admins',
      CROWDSEC_AUTH_OIDC_READ_ONLY_GROUPS: 'legacy-viewers',
      CROWDSEC_AUTH_OIDC_UNMATCHED_ROLE: 'admin',
    });

    expect(config.timeFormat).toBe('12h');
    expect(config.dashboardAuth).toMatchObject({
      sessionSecret: 'legacy-auth-secret',
      totpSecret: 'legacy-totp-secret',
      totpSeed: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      oidcIssuerUrl: 'https://legacy-idp.example.com/',
      oidcClientId: 'legacy-client',
      oidcClientSecret: 'legacy-oidc-secret',
      oidcScope: 'openid profile legacy',
      oidcGroupsClaim: 'legacy-groups',
      oidcAdminGroups: ['legacy-admins'],
      oidcReadOnlyGroups: ['legacy-viewers'],
      oidcUnmatchedRole: 'admin',
    });
  });

  test('createRuntimeConfig prefers canonical names over legacy names', () => {
    const config = createRuntimeConfig({
      TIME_FORMAT: '24h',
      CROWDSEC_TIME_FORMAT: '12h',
      AUTH_SECRET: 'auth-secret',
      CROWDSEC_AUTH_SECRET: 'legacy-auth-secret',
      AUTH_TOTP_SECRET: 'totp-secret',
      CROWDSEC_AUTH_TOTP_SECRET: 'legacy-totp-secret',
      AUTH_TOTP_SEED: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      CROWDSEC_AUTH_TOTP_SEED: 'NB2W45DFOIZA====',
      AUTH_OIDC_CLIENT_ID: 'client',
      CROWDSEC_AUTH_OIDC_CLIENT_ID: 'legacy-client',
    });

    expect(config.timeFormat).toBe('24h');
    expect(config.dashboardAuth.sessionSecret).toBe('auth-secret');
    expect(config.dashboardAuth.totpSecret).toBe('totp-secret');
    expect(config.dashboardAuth.totpSeed).toBe('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
    expect(config.dashboardAuth.oidcClientId).toBe('client');
  });

  test('createRuntimeConfig rejects invalid TOTP seeds', () => {
    expect(() => createRuntimeConfig({
      AUTH_TOTP_SEED: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PX!',
    })).toThrow(/AUTH_TOTP_SEED/);
    expect(() => createRuntimeConfig({ AUTH_TOTP_SEED: 'ABC234' })).toThrow(/AUTH_TOTP_SEED/);
  });

  test('createRuntimeConfig keeps the legacy dashboard auth flag working', () => {
    const config = createRuntimeConfig({ CROWDSEC_AUTH_ENABLED: 'true' });
    expect(config.dashboardAuth.enabled).toBe(true);
  });

  test('createRuntimeConfig prefers AUTH_ENABLED over the legacy dashboard auth flag', () => {
    const config = createRuntimeConfig({
      AUTH_ENABLED: 'false',
      CROWDSEC_AUTH_ENABLED: 'true',
    });
    expect(config.dashboardAuth.enabled).toBe(false);
  });

  test('createRuntimeConfig supports mTLS authentication', () => {
    const certPath = createTempSecret('certificate');
    const keyPath = createTempSecret('private key');
    const caCertPath = createTempSecret('ca certificate');
    const config = createRuntimeConfig({
      CROWDSEC_URL: 'https://localhost:8080',
      CROWDSEC_TLS_CERT_PATH: certPath,
      CROWDSEC_TLS_KEY_PATH: keyPath,
      CROWDSEC_TLS_CA_CERT_PATH: caCertPath,
    });

    expect(config.crowdsecAuthMode).toBe('mtls');
    expect(config.crowdsecAuth).toEqual({
      mode: 'mtls',
      certPath,
      keyPath,
      caCertPath,
    });
    expect(config.crowdsecTlsCertPath).toBe(certPath);
    expect(config.crowdsecTlsKeyPath).toBe(keyPath);
    expect(config.crowdsecTlsCaCertPath).toBe(caCertPath);
  });

  test('createRuntimeConfig reads CrowdSec password authentication from CROWDSEC_PASSWORD_FILE', () => {
    const config = createRuntimeConfig({
      CROWDSEC_USER: 'watcher',
      CROWDSEC_PASSWORD_FILE: createTempSecret('secret-from-file\n'),
    });

    expect(config.crowdsecAuth).toEqual({
      mode: 'password',
      user: 'watcher',
      password: 'secret-from-file',
    });
  });

  test('createRuntimeConfig rejects direct and file-backed CrowdSec passwords together', () => {
    expect(() => createRuntimeConfig({
      CROWDSEC_USER: 'watcher',
      CROWDSEC_PASSWORD: 'direct-secret',
      CROWDSEC_PASSWORD_FILE: '/run/secrets/crowdsec-password',
    })).toThrow(/both CROWDSEC_PASSWORD and CROWDSEC_PASSWORD_FILE are set/i);
  });

  test('createRuntimeConfig reads NOTIFICATION_SECRET_KEY_FILE', () => {
    const config = createRuntimeConfig({
      NOTIFICATION_SECRET_KEY_FILE: createTempSecret('notification-secret-from-file\n'),
    });

    expect(config.notificationSecretKey).toBe('notification-secret-from-file');
  });

  test('createRuntimeConfig rejects direct and file-backed notification secret keys together', () => {
    expect(() => createRuntimeConfig({
      NOTIFICATION_SECRET_KEY: 'direct-secret',
      NOTIFICATION_SECRET_KEY_FILE: '/run/secrets/notification-secret-key',
    })).toThrow(/both NOTIFICATION_SECRET_KEY and NOTIFICATION_SECRET_KEY_FILE are set/i);
  });

  test('createRuntimeConfig rejects mixed password and mTLS authentication', () => {
    expect(() => createRuntimeConfig({
      CROWDSEC_USER: 'watcher',
      CROWDSEC_PASSWORD: 'secret',
      CROWDSEC_TLS_CERT_PATH: '/certs/agent.pem',
      CROWDSEC_TLS_KEY_PATH: '/certs/agent-key.pem',
    })).toThrow(/choose either CROWDSEC_USER with CROWDSEC_PASSWORD or CROWDSEC_PASSWORD_FILE, or CROWDSEC_TLS_CERT_PATH\/CROWDSEC_TLS_KEY_PATH/i);
  });

  test('createRuntimeConfig rejects partial mTLS authentication', () => {
    expect(() => createRuntimeConfig({
      CROWDSEC_TLS_CERT_PATH: '/certs/agent.pem',
    })).toThrow(/CrowdSec mTLS authentication requires both CROWDSEC_TLS_CERT_PATH and CROWDSEC_TLS_KEY_PATH/i);

    expect(() => createRuntimeConfig({
      CROWDSEC_TLS_CA_CERT_PATH: '/certs/ca.pem',
    })).toThrow(/CrowdSec mTLS authentication requires both CROWDSEC_TLS_CERT_PATH and CROWDSEC_TLS_KEY_PATH/i);
  });

  test('createRuntimeConfig loads named LAPI and metrics endpoints from YAML', () => {
    const passwordSecretFile = createTempSecret('lapi-secret\n');
    const caFile = createTempSecret('test-ca');
    const configFile = createTempConfig(`
instances:
  - id: eu-prod
    name: EU Production
    icon: 🇪🇺
    lapi:
      url: https://crowdsec-eu:8080
      auth:
        type: password
        username: watcher
        password:
          file: ${passwordSecretFile}
      tls:
        caFile: ${caFile}
    metrics:
      - id: lapi
        name: EU LAPI
        url: https://crowdsec-eu:6060/metrics
        auth:
          type: bearer
          token:
            env: EU_METRICS_TOKEN
        tls:
          caFile: ${caFile}
      - id: engine
        name: EU Engine
        url: https://crowdsec-eu:6060/metrics/engine
        auth:
          type: basic
          username: metrics
          password:
            env: EU_METRICS_PASSWORD
    sync:
      requestTimeout: 45s
      alertSyncChunk: 6h
`);

    const config = createRuntimeConfig({
      CROWDSEC_INSTANCES_CONFIG_FILE: configFile,
      EU_METRICS_TOKEN: 'metrics-secret',
      EU_METRICS_PASSWORD: 'basic-metrics-secret',
      CROWDSEC_LOOKBACK_PERIOD: '24h',
    });

    expect(config.instances).toHaveLength(1);
    expect(config.instances[0]).toMatchObject({
      id: 'eu-prod',
      name: 'EU Production',
      icon: '🇪🇺',
      lapiUrl: 'https://crowdsec-eu:8080',
      lapiAuth: { mode: 'password', user: 'watcher', password: 'lapi-secret' },
      lapiTls: { caFile },
      sync: { requestTimeoutMs: 45_000, alertSyncChunkMs: 21_600_000 },
    });
    expect(config.instances[0].prometheus[0]).toMatchObject({
      id: 'lapi',
      name: 'EU LAPI',
      auth: { type: 'bearer', token: 'metrics-secret' },
      tls: { caFile },
    });
    expect(config.instances[0].prometheus[1].auth).toEqual({
      type: 'basic', username: 'metrics', password: 'basic-metrics-secret',
    });
  });

  test('rejects suffix-style instance secret settings', () => {
    const configFile = createTempConfig(`
instances:
  - id: first
    name: First
    lapi:
      url: https://first.example:8080
      auth:
        type: password
        username: watcher
        passwordEnv: FIRST_PASSWORD
`);
    expect(() => createRuntimeConfig({
      CROWDSEC_INSTANCES_CONFIG_FILE: configFile,
      FIRST_PASSWORD: 'secret',
    })).toThrow(/unknown.*passwordEnv/i);
  });

  test('multi-instance YAML rejects the former prometheus key', () => {
    const configFile = createTempConfig(`
instances:
  - id: first
    name: First
    lapi:
      url: https://first.example:8080
      auth:
        type: password
        username: watcher
        password:
          env: FIRST_PASSWORD
    prometheus: []
`);

    expect(() => createRuntimeConfig({
      CROWDSEC_INSTANCES_CONFIG_FILE: configFile,
      FIRST_PASSWORD: 'secret',
    })).toThrow(/prometheus has been renamed to instances\[0\]\.metrics/i);
  });

  test('multi-instance YAML accepts direct secrets and rejects duplicate names and legacy connection variables', () => {
    const directSecretFile = createTempConfig(`
instances:
  - id: first
    name: Production
    lapi:
      url: https://first.example:8080
      auth: { type: password, username: watcher, password: plaintext }
`);
    expect(createRuntimeConfig({ CROWDSEC_INSTANCES_CONFIG_FILE: directSecretFile }).instances[0].lapiAuth).toEqual({
      mode: 'password', user: 'watcher', password: 'plaintext',
    });

    const passwordSecretFile = createTempSecret('secret');
    const duplicateFile = createTempConfig(`
instances:
  - id: first
    name: Production
    lapi:
      url: https://first.example:8080
      auth: { type: password, username: watcher, password: { file: ${passwordSecretFile} } }
  - id: second
    name: production
    lapi:
      url: https://second.example:8080
      auth: { type: password, username: watcher, password: { file: ${passwordSecretFile} } }
`);
    expect(() => createRuntimeConfig({ CROWDSEC_INSTANCES_CONFIG_FILE: duplicateFile })).toThrow(/duplicate instance name/i);
    expect(() => createRuntimeConfig({
      CROWDSEC_INSTANCES_CONFIG_FILE: duplicateFile,
      CROWDSEC_URL: 'http://legacy:8080',
    })).toThrow(/cannot be combined with legacy connection variables/i);
  });

  test('multi-instance YAML rejects icons that contain control characters or are too long', () => {
    const passwordSecretFile = createTempSecret('secret');
    const configFile = createTempConfig(`
instances:
  - id: first
    name: Production
    icon: this-icon-is-too-long
    lapi:
      url: https://first.example:8080
      auth: { type: password, username: watcher, password: { file: ${passwordSecretFile} } }
`);
    expect(() => createRuntimeConfig({ CROWDSEC_INSTANCES_CONFIG_FILE: configFile })).toThrow(/short text or emoji icon/i);
  });

  test('createRuntimeConfig translates deprecated alert origin settings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const config = createRuntimeConfig({
        CROWDSEC_ALERT_ORIGINS: 'none, crowdsec, CAPI',
        CROWDSEC_ALERT_EXTRA_SCENARIOS: 'manual/web-ui',
      });

      expect(config.alertFilterMode).toBe('legacy');
      expect(config.alertIncludeOrigins).toEqual(['crowdsec']);
      expect(config.alertExcludeOrigins).toEqual([]);
      expect(config.alertIncludeCapi).toBe(true);
      expect(config.alertIncludeOriginEmpty).toBe(false);
      expect(config.alertExcludeOriginEmpty).toBe(false);
      expect(config.legacyAlertOrigins).toEqual(['none', 'crowdsec', 'CAPI']);
      expect(config.legacyAlertExtraScenarios).toEqual(['manual/web-ui']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/deprecated/i);
    } finally {
      warn.mockRestore();
    }
  });

  test('createRuntimeConfig prefers new alert filters over deprecated ones and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const config = createRuntimeConfig({
        CROWDSEC_ALERT_INCLUDE_ORIGINS: 'crowdsec',
        CROWDSEC_ALERT_INCLUDE_CAPI: 'true',
        CROWDSEC_ALERT_INCLUDE_ORIGIN_EMPTY: 'true',
        CROWDSEC_ALERT_EXCLUDE_ORIGIN_EMPTY: 'true',
        CROWDSEC_ALERT_ORIGINS: 'none,CAPI',
        CROWDSEC_ALERT_EXTRA_SCENARIOS: 'manual/web-ui',
      });

      expect(config.alertFilterMode).toBe('new');
      expect(config.alertIncludeOrigins).toEqual(['crowdsec']);
      expect(config.alertIncludeCapi).toBe(true);
      expect(config.alertIncludeOriginEmpty).toBe(true);
      expect(config.alertExcludeOriginEmpty).toBe(true);
      expect(config.legacyAlertOrigins).toEqual(['none', 'CAPI']);
      expect(config.legacyAlertExtraScenarios).toEqual(['manual/web-ui']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/deprecated/i);
    } finally {
      warn.mockRestore();
    }
  });

  test('createRuntimeConfig warns when removed column visibility env vars are still set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      createRuntimeConfig({
        CROWDSEC_ALWAYS_SHOW_MACHINE: 'true',
        CROWDSEC_ALWAYS_SHOW_ORIGIN: 'true',
      });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('CROWDSEC_ALWAYS_SHOW_MACHINE');
      expect(warn.mock.calls[0]?.[0]).toContain('CROWDSEC_ALWAYS_SHOW_ORIGIN');
      expect(warn.mock.calls[0]?.[0]).toMatch(/deprecated and ignored/i);
      expect(warn.mock.calls[0]?.[0]).toMatch(/Columns dialog/i);
    } finally {
      warn.mockRestore();
    }
  });
});
