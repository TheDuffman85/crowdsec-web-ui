import { hashPassword } from '../server/app-auth';
import type { CrowdsecDatabase } from '../server/database';

export const LOAD_TEST_USERNAME = 'load';
export const LOAD_TEST_PASSWORD = 'test';

export function createLoadTestRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    AUTH_ENABLED: env.AUTH_ENABLED ?? 'true',
  };
}

export async function ensureLoadTestUser(database: CrowdsecDatabase, authEnabled: boolean): Promise<boolean> {
  if (!authEnabled || database.getAuthUserByUsername(LOAD_TEST_USERNAME)) {
    return false;
  }

  database.createAuthUser({
    username: LOAD_TEST_USERNAME,
    passwordHash: await hashPassword(LOAD_TEST_PASSWORD),
    role: 'admin',
    authProvider: 'password',
  });
  return true;
}
