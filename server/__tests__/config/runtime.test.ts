import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createRuntimeConfig as createRuntimeConfigImpl, getIntervalName, parseBooleanEnv, parseCsvEnv, parseLookbackToMs, parseOidcScope, parseOidcUnmatchedRole, parseOptionalBooleanEnv, parseRefreshInterval, parseTimeFormat, parseTimeZone } from '../../config';
import { ConfigurationLoadError } from '../../config-error';
import { createMissingConfigPath, createRuntimeConfig, createTempConfig, createTempSecret, tempDirs } from './harness';

describe('runtime configuration', () => {
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

});
