import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { resolveSecretEnv } from './env-secrets';

const tempDirs: string[] = [];

function createTempFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'crowdsec-web-ui-secret-test-'));
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

describe('resolveSecretEnv', () => {
  test('returns a direct environment value', () => {
    expect(resolveSecretEnv('TEST_SECRET', { TEST_SECRET: 'direct-value' })).toBe('direct-value');
  });

  test('returns undefined when neither environment variable is set', () => {
    expect(resolveSecretEnv('TEST_SECRET', {})).toBeUndefined();
  });

  test('reads a value from the _FILE environment variable', () => {
    const filePath = createTempFile('file-value');
    expect(resolveSecretEnv('TEST_SECRET', { TEST_SECRET_FILE: filePath })).toBe('file-value');
  });

  test('strips trailing CR and LF characters from file values', () => {
    const filePath = createTempFile('file-value\r\n\r\n');
    expect(resolveSecretEnv('TEST_SECRET', { TEST_SECRET_FILE: filePath })).toBe('file-value');
  });

  test('rejects direct and _FILE environment variables together', () => {
    expect(() => resolveSecretEnv('TEST_SECRET', {
      TEST_SECRET: '',
      TEST_SECRET_FILE: '/run/secrets/test-secret',
    })).toThrow('both TEST_SECRET and TEST_SECRET_FILE are set');
  });

  test('rejects an empty _FILE path', () => {
    expect(() => resolveSecretEnv('TEST_SECRET', { TEST_SECRET_FILE: '' }))
      .toThrow('TEST_SECRET_FILE is set but empty');
  });

  test('rejects an unreadable _FILE path', () => {
    expect(() => resolveSecretEnv('TEST_SECRET', {
      TEST_SECRET_FILE: '/tmp/crowdsec-web-ui-does-not-exist/secret.txt',
    })).toThrow('failed to read TEST_SECRET_FILE');
  });
});
