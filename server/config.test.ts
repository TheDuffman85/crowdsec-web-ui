import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createRuntimeConfig, getIntervalName, parseBooleanEnv, parseCsvEnv, parseLookbackToMs, parseOidcUnmatchedRole, parseOptionalBooleanEnv, parseRefreshInterval, parseTimeFormat, parseTimeZone } from './config';

const tempDirs: string[] = [];

function createTempSecret(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'crowdsec-web-ui-config-test-'));
  tempDirs.push(dir);
  const filePath = join(dir, 'secret.txt');
  writeFileSync(filePath, contents, 'utf8');
  return filePath;
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
    expect(() => parseOidcUnmatchedRole('viewer')).toThrow(/CROWDSEC_AUTH_OIDC_UNMATCHED_ROLE/);
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
    expect(() => parseTimeFormat('auto')).toThrow(/CROWDSEC_TIME_FORMAT/);
  });

  test('uses the browser clock format when only TZ is configured', () => {
    const config = createRuntimeConfig({ TZ: 'Europe/Berlin' });
    expect(config.timeZone).toBe('Europe/Berlin');
    expect(config.timeFormat).toBe('browser');
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
      CROWDSEC_IDLE_REFRESH_INTERVAL: '1m',
      CROWDSEC_IDLE_THRESHOLD: '30s',
      CROWDSEC_FULL_REFRESH_INTERVAL: '5m',
      CROWDSEC_LAPI_REQUEST_TIMEOUT: '2m',
      CROWDSEC_PROMETHEUS_URL: 'http://crowdsec:6060/metrics',
      CROWDSEC_PROMETHEUS_REQUEST_TIMEOUT: '10s',
      CROWDSEC_HEARTBEAT_INTERVAL: '1m',
      CROWDSEC_ALERT_SYNC_CHUNK: '3h',
      CROWDSEC_ALERT_SYNC_MIN_CHUNK: '30m',
      CROWDSEC_BOOTSTRAP_RETRY_DELAY: '1m',
      CROWDSEC_BOOTSTRAP_RETRY_ENABLED: 'false',
      DOCKER_IMAGE_REF: 'Example/Repo',
      VITE_VERSION: '1.2.3',
      VITE_BRANCH: 'dev',
      VITE_COMMIT_HASH: 'abc123',
      DB_DIR: '/tmp/app',
      NOTIFICATION_SECRET_KEY: 'notif-secret',
      NOTIFICATION_ALLOW_PRIVATE_ADDRESSES: 'true',
      NOTIFICATION_DEBUG_PAYLOADS: 'true',
      TZ: 'Europe/Berlin',
      CROWDSEC_TIME_FORMAT: '24h',
      AUTH_ENABLED: 'true',
      CROWDSEC_AUTH_SECRET: 'auth-secret',
      CROWDSEC_AUTH_OIDC_ISSUER_URL: 'https://idp.example.com/application/o/crowdsec/',
      CROWDSEC_AUTH_OIDC_CLIENT_ID: 'crowdsec-client',
      CROWDSEC_AUTH_OIDC_CLIENT_SECRET: 'oidc-secret',
      CROWDSEC_AUTH_OIDC_SCOPE: 'openid profile email roles',
      CROWDSEC_AUTH_OIDC_GROUPS_CLAIM: 'roles',
      CROWDSEC_AUTH_OIDC_ADMIN_GROUPS: 'admins, secops',
      CROWDSEC_AUTH_OIDC_READ_ONLY_GROUPS: 'viewers',
      CROWDSEC_AUTH_OIDC_UNMATCHED_ROLE: 'read-only',
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
    expect(config.lapiRequestTimeoutMs).toBe(120_000);
    expect(config.prometheusUrl).toBe('http://crowdsec:6060/metrics');
    expect(config.prometheusRequestTimeoutMs).toBe(10_000);
    expect(config.heartbeatIntervalMs).toBe(60_000);
    expect(config.alertSyncChunkMs).toBe(10_800_000);
    expect(config.alertSyncMinChunkMs).toBe(1_800_000);
    expect(config.bootstrapRetryEnabled).toBe(false);
    expect(config.dockerImageRef).toBe('example/repo');
    expect(config.updateCheckEnabled).toBe(true);
    expect(config.dbDir).toBe('/tmp/app');
    expect(config.notificationSecretKey).toBe('notif-secret');
    expect(config.notificationAllowPrivateAddresses).toBe(true);
    expect(config.notificationDebugPayloads).toBe(true);
    expect(config.timeZone).toBe('Europe/Berlin');
    expect(config.timeFormat).toBe('24h');
    expect(config.readOnly).toBe(false);
    expect(config.dashboardAuth).toEqual({
      enabled: true,
      sessionSecret: 'auth-secret',
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
    expect(config.lapiRequestTimeoutMs).toBe(30_000);
    expect(config.prometheusUrl).toBeUndefined();
    expect(config.prometheusRequestTimeoutMs).toBe(5_000);
    expect(config.heartbeatIntervalMs).toBe(30_000);
    expect(config.alertSyncChunkMs).toBe(21_600_000);
    expect(config.alertSyncMinChunkMs).toBe(900_000);
    expect(config.readOnly).toBe(false);
    expect(config.dashboardAuth.enabled).toBeNull();
    expect(config.dashboardAuth.oidcScope).toBe('openid profile email groups');
    expect(config.dashboardAuth.oidcGroupsClaim).toBe('groups');
    expect(config.dashboardAuth.oidcUnmatchedRole).toBe('deny');
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
      CROWDSEC_AUTH_SECRET_FILE: createTempSecret('auth-secret-from-file\n'),
      CROWDSEC_AUTH_OIDC_CLIENT_SECRET_FILE: createTempSecret('oidc-secret-from-file\n'),
    });

    expect(config.dashboardAuth.enabled).toBe(false);
    expect(config.dashboardAuth.sessionSecret).toBe('auth-secret-from-file');
    expect(config.dashboardAuth.oidcClientSecret).toBe('oidc-secret-from-file');
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
    const config = createRuntimeConfig({
      CROWDSEC_URL: 'https://localhost:8080',
      CROWDSEC_TLS_CERT_PATH: '/certs/agent.pem',
      CROWDSEC_TLS_KEY_PATH: '/certs/agent-key.pem',
      CROWDSEC_TLS_CA_CERT_PATH: '/certs/ca.pem',
    });

    expect(config.crowdsecAuthMode).toBe('mtls');
    expect(config.crowdsecAuth).toEqual({
      mode: 'mtls',
      certPath: '/certs/agent.pem',
      keyPath: '/certs/agent-key.pem',
      caCertPath: '/certs/ca.pem',
    });
    expect(config.crowdsecTlsCertPath).toBe('/certs/agent.pem');
    expect(config.crowdsecTlsKeyPath).toBe('/certs/agent-key.pem');
    expect(config.crowdsecTlsCaCertPath).toBe('/certs/ca.pem');
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
