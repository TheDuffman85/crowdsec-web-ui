import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createRuntimeConfig as createRuntimeConfigImpl, getIntervalName, parseBooleanEnv, parseCsvEnv, parseLookbackToMs, parseOidcScope, parseOidcUnmatchedRole, parseOptionalBooleanEnv, parseRefreshInterval, parseTimeFormat, parseTimeZone } from '../../config';
import { ConfigurationLoadError } from '../../config-error';
import { createMissingConfigPath, createRuntimeConfig, createTempConfig, createTempSecret, tempDirs } from './harness';

describe('configuration defaults and schema', () => {
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

});
