import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createRuntimeConfig as createRuntimeConfigImpl, getIntervalName, parseBooleanEnv, parseCsvEnv, parseLookbackToMs, parseOidcScope, parseOidcUnmatchedRole, parseOptionalBooleanEnv, parseRefreshInterval, parseTimeFormat, parseTimeZone } from '../../config';
import { ConfigurationLoadError } from '../../config-error';
import { createMissingConfigPath, createRuntimeConfig, createTempConfig, createTempSecret, tempDirs } from './harness';

describe('instance configuration', () => {
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
