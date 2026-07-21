import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createRuntimeConfig as createRuntimeConfigImpl, getIntervalName, parseBooleanEnv, parseCsvEnv, parseLookbackToMs, parseOidcScope, parseOidcUnmatchedRole, parseOptionalBooleanEnv, parseRefreshInterval, parseTimeFormat, parseTimeZone } from '../../config';
import { CONFIG_KEY_ORDER } from '../../config-file';
import { ConfigurationLoadError } from '../../config-error';
import { createMissingConfigPath, createRuntimeConfig, createTempConfig, createTempSecret, tempDirs } from './harness';

function documentedConfigPaths(yaml: string): Set<string> {
  const paths = new Set<string>();
  const stack: Array<{ indent: number; path: string }> = [];

  for (const line of yaml.split('\n')) {
    let candidate = line;
    let comment: RegExpMatchArray | null;
    while ((comment = candidate.match(/^(\s*)# ?(.*)$/))) candidate = `${comment[1]}${comment[2]}`;
    const sequenceItem = candidate.match(/^(\s*)-\s*$/);
    if (sequenceItem) {
      const indent = sequenceItem[1].length;
      while (stack.at(-1) && stack.at(-1)!.indent >= indent) stack.pop();
      stack.push({ indent, path: `${stack.at(-1)?.path || ''}[]` });
      continue;
    }
    const field = candidate.match(/^(\s*)(- )?([A-Za-z][A-Za-z0-9]*):(?:\s|$)/);
    if (!field) continue;

    const leadingIndent = field[1].length;
    while (stack.at(-1) && stack.at(-1)!.indent >= leadingIndent) stack.pop();
    let parent = stack.at(-1)?.path || '';
    let indent = leadingIndent;
    if (field[2]) {
      parent = `${parent}[]`;
      stack.push({ indent, path: parent });
      indent += 2;
    }
    const path = `${parent}${parent ? '.' : ''}${field[3]}`;
    paths.add(path);
    stack.push({ indent, path });
  }

  return paths;
}

function expectedDocumentedConfigPaths(): string[] {
  return Array.from(CONFIG_KEY_ORDER.entries()).flatMap(([parent, keys]) => (
    keys.map((key) => `${parent}${parent ? '.' : ''}${key}`)
  )).filter((path) => path !== 'crowdsec.alertFilters.legacy' && !path.startsWith('crowdsec.alertFilters.legacy.'));
}

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

  test('keeps implicit defaults commented in the initial configuration', () => {
    const generatedConfigFile = createMissingConfigPath();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      createRuntimeConfigImpl({}, { defaultConfigFile: generatedConfigFile });
      const saved = readFileSync(generatedConfigFile, 'utf8');
      const document = parseYaml(saved);
      expect(Object.keys(document)).toEqual(['instances']);
      expect(Object.keys(document.instances[0])).toEqual(['id', 'name', 'lapi']);
      expect(Object.keys(document.instances[0].lapi)).toEqual(['url']);
      expect(saved).toContain('# server:');
      expect(saved).toContain('      # auth:\n      #   type: none');
      expect(saved).toContain('    # metrics:\n    #   - id: "0"');
      expect(expectedDocumentedConfigPaths().filter((path) => !documentedConfigPaths(saved).has(path))).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  test('keeps the complete reference when setup variables configure an instance', () => {
    const generatedConfigFile = createMissingConfigPath();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      createRuntimeConfigImpl({
        CONFIG_INSTANCE_LAPI_URL: 'http://100.64.0.11:8080',
        CONFIG_INSTANCE_LAPI_AUTH_USERNAME: 'crowdsec-web-ui',
        CONFIG_INSTANCE_LAPI_AUTH_PASSWORD: 'secret',
        CONFIG_INSTANCE_METRICS_URL: 'http://100.64.0.11:6060/metrics',
      }, { defaultConfigFile: generatedConfigFile });
      const saved = readFileSync(generatedConfigFile, 'utf8');
      const document = parseYaml(saved);
      expect(document.instances[0]).toEqual({
        lapi: {
          url: 'http://100.64.0.11:8080',
          auth: {
            username: 'crowdsec-web-ui',
            password: { env: 'CONFIG_INSTANCE_LAPI_AUTH_PASSWORD' },
          },
        },
        metrics: [{ url: 'http://100.64.0.11:6060/metrics' }],
      });
      const documented = documentedConfigPaths(saved);
      expect(expectedDocumentedConfigPaths().filter((path) => !documented.has(path))).toEqual([]);
    } finally {
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
    const document = parseYaml(example);
    expect(Object.keys(document)).toEqual(['instances']);
    expect(Object.keys(document.instances[0])).toEqual(['id', 'name', 'lapi']);
    expect(Object.keys(document.instances[0].lapi)).toEqual(['url', 'auth']);
    expect(Object.keys(document.instances[0].lapi.auth)).toEqual(['username', 'password']);
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

  test('documents every non-legacy application configuration field', () => {
    const example = readFileSync(join(process.cwd(), 'config.example.yaml'), 'utf8');
    const documented = documentedConfigPaths(example);
    expect(expectedDocumentedConfigPaths().filter((path) => !documented.has(path))).toEqual([]);
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
