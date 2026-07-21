import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createRuntimeConfig as createRuntimeConfigImpl, getIntervalName, parseBooleanEnv, parseCsvEnv, parseLookbackToMs, parseOidcScope, parseOidcUnmatchedRole, parseOptionalBooleanEnv, parseRefreshInterval, parseTimeFormat, parseTimeZone } from '../../config';
import { ConfigurationLoadError } from '../../config-error';
import { createMissingConfigPath, createRuntimeConfig, createTempConfig, createTempSecret, tempDirs } from './harness';

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

});
