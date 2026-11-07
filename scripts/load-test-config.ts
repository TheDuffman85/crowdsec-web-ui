import path from 'node:path';
import { createRuntimeConfig, type RuntimeConfig } from '../server/config';
import { createLoadTestRuntimeEnv } from './load-test-auth';

/** Instance IDs of the multi-instance profiles; the server replaces the configured instance with these. */
export const LOAD_TEST_MULTI_INSTANCE_IDS = ['primary', 'secondary', 'edge'] as const;

/**
 * The runtime configuration the load-test server runs with. The seed resolves
 * it too, so seeded data uses the same instance IDs as the server, including
 * IDs from a `config.yaml` that an earlier run generated in the database directory.
 */
export function createLoadTestRuntimeConfig(env: NodeJS.ProcessEnv, dbDir: string, overrides: NodeJS.ProcessEnv = {}): RuntimeConfig {
  return createRuntimeConfig({
    ...createLoadTestRuntimeEnv(env),
    CONFIG_STORAGE_DATA_DIR: dbDir,
    CONFIG_CROWDSEC_SYNC_REFRESH_INTERVAL: env.CONFIG_CROWDSEC_SYNC_REFRESH_INTERVAL || '1m',
    CONFIG_CROWDSEC_SYNC_LOOKBACK: env.CONFIG_CROWDSEC_SYNC_LOOKBACK || '30d',
    CONFIG_CROWDSEC_SYNC_HEARTBEAT_INTERVAL: '0',
    CONFIG_CROWDSEC_SYNC_BOOTSTRAP_RETRY_ENABLED: 'false',
    CONFIG_CROWDSEC_SIMULATIONS_ENABLED: env.CONFIG_CROWDSEC_SIMULATIONS_ENABLED || 'true',
    CROWDSEC_WEB_UI_MODE: 'load-test',
    ...overrides,
  }, { defaultConfigFile: path.join(dbDir, 'config.yaml') });
}
