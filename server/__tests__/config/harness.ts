import { afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeConfig as createRuntimeConfigImpl } from '../../config';

export const tempDirs: string[] = [];

export function createTempSecret(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'crowdsec-web-ui-config-test-'));
  tempDirs.push(dir);
  const filePath = join(dir, 'secret.txt');
  writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

export function createTempConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'crowdsec-web-ui-instances-test-'));
  tempDirs.push(dir);
  const filePath = join(dir, 'instances.yaml');
  writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

export function createMissingConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crowdsec-web-ui-full-config-test-'));
  tempDirs.push(dir);
  return join(dir, 'config.yaml');
}

export function createRuntimeConfig(env: NodeJS.ProcessEnv) {
  return createRuntimeConfigImpl(env, { defaultConfigFile: createMissingConfigPath() });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
