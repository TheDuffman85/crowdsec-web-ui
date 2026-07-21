import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createRuntimeConfig as createRuntimeConfigImpl, getIntervalName, parseBooleanEnv, parseCsvEnv, parseLookbackToMs, parseOidcScope, parseOidcUnmatchedRole, parseOptionalBooleanEnv, parseRefreshInterval, parseTimeFormat, parseTimeZone } from '../../config';
import { ConfigurationLoadError } from '../../config-error';
import { createMissingConfigPath, createRuntimeConfig, createTempConfig, createTempSecret, tempDirs } from './harness';

describe('configuration overrides', () => {
  test('applies CONFIG_ values without modifying an existing YAML', () => {
    const generatedConfigFile = createMissingConfigPath();
    createRuntimeConfigImpl({ CONFIG_SERVER_PORT: '4100' }, { defaultConfigFile: generatedConfigFile });
    const original = readFileSync(generatedConfigFile, 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const config = createRuntimeConfigImpl({
        CONFIG_SERVER_PORT: '4200',
        CONFIG_CROWDSEC_SYNC_REFRESH_INTERVAL: '5m',
      }, { defaultConfigFile: generatedConfigFile });
      expect(config.port).toBe(4200);
      expect(config.refreshIntervalMs).toBe(300_000);
      expect(readFileSync(generatedConfigFile, 'utf8')).toBe(original);
      expect(log).toHaveBeenCalledWith(`Applied CONFIG_ overrides to application configuration from ${generatedConfigFile}.`);
      expect(log).toHaveBeenCalledWith('  CONFIG_SERVER_PORT -> server.port: 4100 -> 4200');
      expect(log).toHaveBeenCalledWith('  CONFIG_CROWDSEC_SYNC_REFRESH_INTERVAL -> crowdsec.sync.refreshInterval: <unset> -> "5m"');
    } finally {
      log.mockRestore();
    }
  });

  test('persists CONFIG_ values to an existing YAML when explicitly enabled', () => {
    const generatedConfigFile = createMissingConfigPath();
    createRuntimeConfigImpl({ CONFIG_SERVER_PORT: '4100' }, { defaultConfigFile: generatedConfigFile });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const config = createRuntimeConfigImpl({
        CONFIG_PERSIST_OVERRIDES: 'true',
        CONFIG_SERVER_PORT: '4200',
        CONFIG_CROWDSEC_SYNC_REFRESH_INTERVAL: '5m',
      }, { defaultConfigFile: generatedConfigFile });
      expect(config.port).toBe(4200);
      expect(config.refreshIntervalMs).toBe(300_000);
      const persisted = parseYaml(readFileSync(generatedConfigFile, 'utf8'));
      expect(persisted.server.port).toBe(4200);
      expect(persisted.crowdsec.sync.refreshInterval).toBe('5m');
      expect(log).toHaveBeenCalledWith(
        `Applied CONFIG_ overrides and persisted application configuration to ${generatedConfigFile}.`,
      );
    } finally {
      log.mockRestore();
    }
  });

  test('does not treat the disabled persistence setting as a CONFIG_ override', () => {
    const generatedConfigFile = createMissingConfigPath();
    createRuntimeConfigImpl({ CONFIG_SERVER_PORT: '4100' }, { defaultConfigFile: generatedConfigFile });
    const original = readFileSync(generatedConfigFile, 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const config = createRuntimeConfigImpl({
        CONFIG_PERSIST_OVERRIDES: 'false',
      }, { defaultConfigFile: generatedConfigFile });
      expect(config.port).toBe(4100);
      expect(readFileSync(generatedConfigFile, 'utf8')).toBe(original);
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining('Applied CONFIG_ overrides'));
    } finally {
      log.mockRestore();
    }
  });

  test('logs secret override sources without exposing their values', () => {
    const configFile = createTempConfig(`
server:
  port: 3100
auth:
  sessionSecret: old-secret
instances:
  - id: default
    name: CrowdSec
    lapi:
      url: http://crowdsec:8080
      auth: { type: none }
`);
    const notificationSecretFile = createTempSecret('notification-secret-from-file');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      createRuntimeConfigImpl({
        CONFIG_FILE: configFile,
        CONFIG_AUTH_SESSION_SECRET: 'new-session-secret',
        CONFIG_NOTIFICATIONS_SECRET_KEY_FILE: notificationSecretFile,
        CONFIG_INSTANCE_LAPI_AUTH_USERNAME: 'watcher',
        CONFIG_INSTANCE_LAPI_AUTH_PASSWORD: 'new-lapi-password',
      });

      expect(log).toHaveBeenCalledWith(
        '  CONFIG_AUTH_SESSION_SECRET -> auth.sessionSecret: "[redacted]" -> "[redacted; env: CONFIG_AUTH_SESSION_SECRET]"',
      );
      expect(log).toHaveBeenCalledWith(
        `  CONFIG_NOTIFICATIONS_SECRET_KEY_FILE -> notifications.secretKey: <unset> -> "[redacted; file: ${notificationSecretFile}]"`,
      );
      expect(log).toHaveBeenCalledWith(
        '  CONFIG_INSTANCE_LAPI_AUTH_PASSWORD -> instances[0].lapi.auth.password: <unset> -> "[redacted; env: CONFIG_INSTANCE_LAPI_AUTH_PASSWORD]"',
      );
      const output = log.mock.calls.flat().join('\n');
      expect(output).not.toContain('old-secret');
      expect(output).not.toContain('new-session-secret');
      expect(output).not.toContain('notification-secret-from-file');
      expect(output).not.toContain('new-lapi-password');
    } finally {
      log.mockRestore();
    }
  });

  test('redacts secrets inside section overrides with nested arrays', () => {
    const configFile = createTempConfig(`
server:
  port: 3100
auth:
  enabled: false
  sessionSecret: old-section-secret
  oidc:
    adminGroups: [operators]
instances:
  - id: default
    name: CrowdSec
    lapi:
      url: http://crowdsec:8080
      auth: { type: none }
`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const config = createRuntimeConfigImpl({
        CONFIG_FILE: configFile,
        CONFIG_AUTH: '{ enabled: false, sessionSecret: new-section-secret, oidc: { adminGroups: [admins, secops] } }',
      });

      expect(config.dashboardAuth.oidcAdminGroups).toEqual(['admins', 'secops']);
      const output = log.mock.calls.flat().join('\n');
      expect(output).toContain('CONFIG_AUTH -> auth:');
      expect(output).toContain('[redacted]');
      expect(output).toContain('admins');
      expect(output).toContain('secops');
      expect(output).not.toContain('old-section-secret');
      expect(output).not.toContain('new-section-secret');
    } finally {
      log.mockRestore();
    }
  });

  test('applies CONFIG_ values without modifying the file selected by CONFIG_FILE', () => {
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
    const original = readFileSync(configFile, 'utf8');
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
      expect(readFileSync(configFile, 'utf8')).toBe(original);

      const withoutAuth = createRuntimeConfigImpl({
        CONFIG_FILE: configFile,
        CONFIG_INSTANCE_LAPI_AUTH_TYPE: 'none',
        CONFIG_INSTANCE_METRICS_URL: 'http://crowdsec:6060/metrics',
      });
      expect(withoutAuth.instances[0].lapiAuth).toEqual({ mode: 'none' });
      expect(readFileSync(configFile, 'utf8')).toBe(original);
    } finally {
      log.mockRestore();
    }
  });

  test('persists overrides to CONFIG_FILE without writing plaintext secrets', () => {
    const configFile = createTempConfig(`
# This comment should survive environment merges.
server:
  port: 3100
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
        CONFIG_PERSIST_OVERRIDES: 'yes',
        CONFIG_SERVER_PORT: '3200',
        CONFIG_INSTANCE_LAPI_AUTH_USERNAME: 'watcher',
        CONFIG_INSTANCE_LAPI_AUTH_PASSWORD: 'do-not-persist-this-secret',
        CONFIG_INSTANCE_METRICS_URL: 'http://crowdsec:6060/metrics',
      });
      expect(config.port).toBe(3200);
      expect(config.instances[0].lapiAuth).toEqual({
        mode: 'password', user: 'watcher', password: 'do-not-persist-this-secret',
      });

      const persistedYaml = readFileSync(configFile, 'utf8');
      const persisted = parseYaml(persistedYaml);
      expect(persisted.server.port).toBe(3200);
      expect(persisted.instances[0].lapi.auth.password).toEqual({
        env: 'CONFIG_INSTANCE_LAPI_AUTH_PASSWORD',
      });
      expect(persistedYaml).toContain('# This comment should survive environment merges.');
      expect(persistedYaml).not.toContain('do-not-persist-this-secret');
      expect(persistedYaml).not.toContain('metrics: [');
    } finally {
      log.mockRestore();
    }
  });

  test('rejects an invalid CONFIG_PERSIST_OVERRIDES value', () => {
    const configFile = createTempConfig(`
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
      CONFIG_PERSIST_OVERRIDES: 'sometimes',
      CONFIG_SERVER_PORT: '3200',
    })).toThrow(/CONFIG_PERSIST_OVERRIDES must be a boolean/i);
    expect(readFileSync(configFile, 'utf8')).toBe(original);
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

  test('reports the config file and overrides when merged configuration is invalid', () => {
    const configFile = createTempConfig(`
instances:
  - id: default
    name: CrowdSec
    lapi:
      url: http://crowdsec:8080
      auth: { type: none }
`);

    let failure: unknown;
    try {
      createRuntimeConfigImpl({
        CONFIG_FILE: configFile,
        CONFIG_INSTANCE_LAPI_URL: '',
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ConfigurationLoadError);
    expect(failure).toMatchObject({
      message: 'instances[0].lapi.url must be a non-empty string.',
      configFile,
      overrideNames: ['CONFIG_INSTANCE_LAPI_URL'],
    });
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

  test('explains skipped instance indexes and reports only the overrides after the gap', () => {
    const configFile = createTempConfig(`
instances:
  - id: default
    name: CrowdSec
    lapi:
      url: http://crowdsec:8080
      auth: { type: none }
`);

    let failure: unknown;
    try {
      createRuntimeConfigImpl({
        CONFIG_FILE: configFile,
        CONFIG_INSTANCE_LAPI_URL: 'http://primary:8080',
        CONFIG_INSTANCES_2_ICON: 'shield',
        CONFIG_INSTANCES_2_LAPI_URL: 'http://third:8080',
        CONFIG_INSTANCES_2_LAPI_AUTH_USERNAME: 'watcher',
        CONFIG_INSTANCES_2_LAPI_AUTH_PASSWORD: 'secret',
        CONFIG_INSTANCES_2_METRICS_URL: 'http://third:6060/metrics',
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ConfigurationLoadError);
    expect(failure).toMatchObject({
      message: expect.stringMatching(
        /instance index 1 is missing before configured index 2.*zero-based and contiguous.*rename CONFIG_INSTANCES_2_\* to CONFIG_INSTANCES_1_\*/i,
      ),
      overrideNames: [
        'CONFIG_INSTANCES_2_ICON',
        'CONFIG_INSTANCES_2_LAPI_AUTH_PASSWORD',
        'CONFIG_INSTANCES_2_LAPI_AUTH_USERNAME',
        'CONFIG_INSTANCES_2_LAPI_URL',
        'CONFIG_INSTANCES_2_METRICS_URL',
      ],
    });
  });

  test('explains skipped metrics indexes', () => {
    const generatedConfigFile = createMissingConfigPath();
    expect(() => createRuntimeConfigImpl({
      CONFIG_INSTANCE_LAPI_URL: 'http://crowdsec:8080',
      CONFIG_INSTANCE_METRICS_URL: 'http://crowdsec:6060/metrics',
      CONFIG_INSTANCE_METRICS_2_URL: 'http://crowdsec:6062/metrics',
    }, { defaultConfigFile: generatedConfigFile })).toThrow(
      /metrics index 1 is missing for instance 0 before configured index 2.*zero-based and contiguous.*METRICS_1_\*/i,
    );
    expect(existsSync(generatedConfigFile)).toBe(false);
  });

  test('explains gaps in indexed CONFIG_ scalar arrays', () => {
    const generatedConfigFile = createMissingConfigPath();
    expect(() => createRuntimeConfigImpl({
      CONFIG_AUTH_OIDC_ADMIN_GROUPS_1: 'secops',
    }, { defaultConfigFile: generatedConfigFile })).toThrow(
      /index 0 is missing for auth\.oidc\.adminGroups.*zero-based and contiguous.*CONFIG_AUTH_OIDC_ADMIN_GROUPS_0/i,
    );
    expect(existsSync(generatedConfigFile)).toBe(false);
  });

});
