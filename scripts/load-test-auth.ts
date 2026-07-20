import { hashPassword } from '../server/app-auth';
import type { CrowdsecDatabase } from '../server/database';

export const LOAD_TEST_USERNAME = 'load';
export const LOAD_TEST_PASSWORD = 'test';
export const LOAD_TEST_PASSKEY_CREDENTIAL_ID = Buffer.from('crowdsec-web-ui-load-test-passkey').toString('base64url');
export const LOAD_TEST_PASSKEY_NAME = 'Load-test dummy passkey';

export function createLoadTestRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    CONFIG_AUTH_ENABLED: env.CONFIG_AUTH_ENABLED ?? 'true',
  };
}

export async function ensureLoadTestUser(database: CrowdsecDatabase, authEnabled: boolean): Promise<boolean> {
  if (!authEnabled) return false;

  let user = database.getAuthUserByUsername(LOAD_TEST_USERNAME);
  const created = !user;
  if (!user) {
    const userId = database.createAuthUser({
      username: LOAD_TEST_USERNAME,
      passwordHash: await hashPassword(LOAD_TEST_PASSWORD),
      role: 'admin',
      authProvider: 'password',
    });
    user = database.getAuthUserById(userId);
  }

  if (user && !database.getWebAuthnCredentialByCredentialId(LOAD_TEST_PASSKEY_CREDENTIAL_ID)) {
    database.createWebAuthnCredential({
      userId: user.id,
      credentialId: LOAD_TEST_PASSKEY_CREDENTIAL_ID,
      // This credential exists only to expose and exercise the passkey login UI
      // under load. It intentionally cannot produce a valid authentication.
      publicKey: Buffer.from('load-test-dummy-public-key').toString('base64url'),
      signCount: 0,
      transports: JSON.stringify(['internal', 'hybrid', 'usb', 'nfc', 'ble']),
      name: LOAD_TEST_PASSKEY_NAME,
    });
  }

  return created;
}
