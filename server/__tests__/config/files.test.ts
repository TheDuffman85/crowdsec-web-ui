import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createRuntimeConfig as createRuntimeConfigImpl, getIntervalName, parseBooleanEnv, parseCsvEnv, parseLookbackToMs, parseOidcScope, parseOidcUnmatchedRole, parseOptionalBooleanEnv, parseRefreshInterval, parseTimeFormat, parseTimeZone } from '../../config';
import { ConfigurationLoadError } from '../../config-error';
import { createMissingConfigPath, createRuntimeConfig, createTempConfig, createTempSecret, tempDirs } from './harness';

describe('configuration files', () => {
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
      expect(document.instances[0].id).toBeUndefined();
      expect(document.instances[0].name).toBeUndefined();
      expect(document.instances[0].lapi.auth.type).toBeUndefined();
      expect(document.instances[0].metrics[0].id).toBeUndefined();
      expect(document.instances[0].metrics[0].name).toBeUndefined();
      expect(document.instances[0].metrics[0].auth.type).toBeUndefined();
      expect(document.instances[0].metrics[1].id).toBeUndefined();
      expect(document.instances[0].metrics[1].name).toBeUndefined();
      expect(document.instances[0].metrics[1].auth).toBeUndefined();
      expect(document.instances[1].id).toBe('secondary');
      expect(document.instances[1].name).toBe('Secondary');
      expect(document.instances[1].lapi.auth.type).toBe('none');
      expect(document.instances[0].lapi.auth.password).toEqual({ env: 'CONFIG_INSTANCE_LAPI_AUTH_PASSWORD' });
      expect(document.instances[0].metrics[0].auth.token).toEqual({ env: 'CONFIG_INSTANCE_METRICS_AUTH_TOKEN' });
      expect(saved).toContain('    # id: "0"');
      expect(saved).toContain('        # type: password');
      expect(saved).toContain('        # id: "0"');
      expect(warn).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(`Saved generated configuration to ${generatedConfigFile}.`);
      expect(log).toHaveBeenCalledWith('Applied CONFIG_ values while generating the application configuration.');
      expect(log).toHaveBeenCalledWith(
        '  CONFIG_INSTANCE_LAPI_AUTH_PASSWORD -> instances[0].lapi.auth.password: <unset> -> "[redacted; env: CONFIG_INSTANCE_LAPI_AUTH_PASSWORD]"',
      );
      const output = log.mock.calls.flat().join('\n');
      expect(output).not.toContain('do-not-write-this-auth-secret');
      expect(output).not.toContain('do-not-write-this-password');
      expect(output).not.toContain('do-not-write-this-token');
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  test('generates deterministic block-style YAML in documentation order', () => {
    const entries = [
      ['CONFIG_INSTANCE_METRICS_AUTH_TOKEN', 'metrics-token'],
      ['CONFIG_NOTIFICATIONS_DEBUG_PAYLOADS', 'true'],
      ['CONFIG_INSTANCE_SYNC_BOUNCER_PROPAGATION_DELAY', '20s'],
      ['CONFIG_AUTH_ENABLED', 'true'],
      ['CONFIG_INSTANCE_LAPI_AUTH_PASSWORD', 'lapi-password'],
      ['CONFIG_CROWDSEC_SYNC_REFRESH_INTERVAL', '2m'],
      ['CONFIG_INSTANCE_METRICS_REQUEST_TIMEOUT', '10s'],
      ['CONFIG_STORAGE_WAL_ENABLED', 'false'],
      ['CONFIG_INSTANCE_LAPI_AUTH_USERNAME', 'watcher'],
      ['CONFIG_UPDATES_ENABLED', 'false'],
      ['CONFIG_INSTANCE_METRICS_URL', 'https://crowdsec.example.com:6060/metrics'],
      ['CONFIG_SERVER_PORT', '4200'],
      ['CONFIG_INSTANCE_LAPI_URL', 'https://crowdsec.example.com:8080'],
      ['CONFIG_CROWDSEC_SIMULATIONS_ENABLED', 'true'],
    ] as const;
    const firstConfigFile = createMissingConfigPath();
    const secondConfigFile = createMissingConfigPath();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      createRuntimeConfigImpl({
        ...Object.fromEntries(entries),
        CONFIG_UI: '{ readOnly: true, timeFormat: 24h, timeZone: UTC }',
      }, { defaultConfigFile: firstConfigFile });
      createRuntimeConfigImpl({
        CONFIG_UI: '{ timeZone: UTC, timeFormat: 24h, readOnly: true }',
        ...Object.fromEntries([...entries].reverse()),
      }, { defaultConfigFile: secondConfigFile });
      const first = readFileSync(firstConfigFile, 'utf8');
      const second = readFileSync(secondConfigFile, 'utf8');
      expect(first).toBe(second);
      expect(first).not.toMatch(/\{[^}\n]*\}/);
      expect(first).toContain('password:\n          env: CONFIG_INSTANCE_LAPI_AUTH_PASSWORD');

      const document = parseYaml(first);
      expect(Object.keys(document)).toEqual([
        'server', 'storage', 'ui', 'updates', 'auth', 'notifications', 'crowdsec', 'instances',
      ]);
      expect(Object.keys(document.ui)).toEqual(['timeZone', 'timeFormat', 'readOnly']);
      expect(Object.keys(document.instances[0])).toEqual(['lapi', 'metrics', 'sync']);
      expect(Object.keys(document.instances[0].lapi)).toEqual(['url', 'auth']);
      expect(Object.keys(document.instances[0].lapi.auth)).toEqual(['username', 'password']);
      expect(Object.keys(document.instances[0].metrics[0])).toEqual(['url', 'requestTimeout', 'auth']);
      expect(Object.keys(document.instances[0].metrics[0].auth)).toEqual(['token']);
    } finally {
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
    expect(persisted.instances[0].lapi.auth.type).toBeUndefined();
    expect(persisted.instances[0].metrics[0].auth.type).toBeUndefined();
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

});
