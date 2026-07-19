import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createLoadTestRuntimeEnv,
  ensureLoadTestUser,
  LOAD_TEST_PASSKEY_CREDENTIAL_ID,
  LOAD_TEST_PASSKEY_NAME,
  LOAD_TEST_PASSWORD,
  LOAD_TEST_USERNAME,
} from '../scripts/load-test-auth';
import { verifyPassword } from './app-auth';
import { createRuntimeConfig } from './config';
import { CrowdsecDatabase } from './database';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function createTestDatabase(): CrowdsecDatabase {
  const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-load-test-auth-'));
  tempDirs.push(dir);
  return new CrowdsecDatabase({ dbPath: path.join(dir, 'test.db') });
}

function createTestRuntimeConfig(env: NodeJS.ProcessEnv) {
  const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-load-test-config-'));
  tempDirs.push(dir);
  return createRuntimeConfig(env, { defaultConfigFile: path.join(dir, 'config.yaml') });
}

describe('load-test authentication', () => {
  test('defaults authentication to enabled and preserves OIDC environment settings', () => {
    const config = createTestRuntimeConfig(createLoadTestRuntimeEnv({
      AUTH_OIDC_ISSUER_URL: 'https://idp.example.com/application/o/crowdsec/',
      AUTH_OIDC_CLIENT_ID: 'load-test-client',
      AUTH_OIDC_CLIENT_SECRET: 'load-test-secret',
      AUTH_OIDC_SCOPE: 'openid profile email roles',
      AUTH_OIDC_GROUPS_CLAIM: 'roles',
      AUTH_OIDC_ADMIN_GROUPS: 'admins,secops',
      AUTH_OIDC_READ_ONLY_GROUPS: 'viewers',
      AUTH_OIDC_UNMATCHED_ROLE: 'read-only',
    }));

    expect(config.dashboardAuth).toMatchObject({
      enabled: true,
      oidcIssuerUrl: 'https://idp.example.com/application/o/crowdsec/',
      oidcClientId: 'load-test-client',
      oidcClientSecret: 'load-test-secret',
      oidcScope: 'openid profile email roles',
      oidcGroupsClaim: 'roles',
      oidcAdminGroups: ['admins', 'secops'],
      oidcReadOnlyGroups: ['viewers'],
      oidcUnmatchedRole: 'read-only',
    });
  });

  test('respects AUTH_ENABLED=false', () => {
    const config = createTestRuntimeConfig(createLoadTestRuntimeEnv({ AUTH_ENABLED: 'false' }));
    expect(config.dashboardAuth.enabled).toBe(false);
  });

  test('creates the default local administrator only when authentication is enabled', async () => {
    const enabledDatabase = createTestDatabase();
    expect(await ensureLoadTestUser(enabledDatabase, true)).toBe(true);
    const user = enabledDatabase.getAuthUserByUsername(LOAD_TEST_USERNAME);
    expect(user).toMatchObject({ username: 'load', role: 'admin', auth_provider: 'password' });
    expect(await verifyPassword(LOAD_TEST_PASSWORD, user?.password_hash || '')).toBe(true);
    expect(enabledDatabase.getWebAuthnCredentialByCredentialId(LOAD_TEST_PASSKEY_CREDENTIAL_ID)).toMatchObject({
      user_id: user?.id,
      name: LOAD_TEST_PASSKEY_NAME,
      sign_count: 0,
    });
    expect(enabledDatabase.countWebAuthnCredentials()).toBe(1);
    expect(await ensureLoadTestUser(enabledDatabase, true)).toBe(false);
    expect(enabledDatabase.countWebAuthnCredentials()).toBe(1);
    enabledDatabase.close();

    const disabledDatabase = createTestDatabase();
    expect(await ensureLoadTestUser(disabledDatabase, false)).toBe(false);
    expect(disabledDatabase.countAuthUsers()).toBe(0);
    disabledDatabase.close();
  });
});
