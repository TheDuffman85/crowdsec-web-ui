import { serve } from '@hono/node-server';
import path from 'node:path';
import { createApp } from '../server/app';
import { createRuntimeConfig } from '../server/config';
import { CrowdsecDatabase } from '../server/database';

const dbDir = process.env.LOADTEST_DB_DIR || process.env.DB_DIR || path.join(process.env.TMPDIR || '/tmp', 'crowdsec-web-ui-load-test');
const port = Number(process.env.LOADTEST_BACKEND_PORT || process.env.PORT || 3000);
const database = new CrowdsecDatabase({ dbDir });

const config = createRuntimeConfig({
  ...process.env,
  PORT: String(port),
  DB_DIR: dbDir,
  AUTH_ENABLED: 'false',
  CROWDSEC_REFRESH_INTERVAL: process.env.CROWDSEC_REFRESH_INTERVAL || '5m',
  CROWDSEC_LOOKBACK_PERIOD: process.env.CROWDSEC_LOOKBACK_PERIOD || '30d',
  CROWDSEC_HEARTBEAT_INTERVAL: '0',
  CROWDSEC_BOOTSTRAP_RETRY_ENABLED: 'false',
  CROWDSEC_SIMULATIONS_ENABLED: process.env.CROWDSEC_SIMULATIONS_ENABLED || 'true',
  VITE_VERSION: process.env.VITE_VERSION || 'loadtest',
  VITE_BRANCH: process.env.VITE_BRANCH || 'loadtest',
  VITE_COMMIT_HASH: process.env.VITE_COMMIT_HASH || 'loadtest',
});

const fakeLapiClient = {
  hasAuthConfig: () => true,
  hasToken: () => true,
  login: async () => true,
  updateStatus: () => {},
  getStatus: () => ({
    isConnected: true,
    lastCheck: new Date().toISOString(),
    lastError: null,
    offline_since: null,
  }),
  heartbeat: async () => {},
  sendUsageMetrics: async () => {},
  fetchAlerts: async () => [],
  getAlertById: async (alertId: string | number) => {
    const row = database.db.prepare('SELECT raw_data FROM alerts WHERE id = ?').get(String(alertId)) as { raw_data?: string } | undefined;
    return row?.raw_data ? JSON.parse(row.raw_data) : null;
  },
  addDecision: async () => ({ message: 'Decision added for load-test demo' }),
  deleteDecision: async () => ({ message: 'Decision deleted for load-test demo' }),
  deleteAlert: async () => ({ message: 'Alert deleted for load-test demo' }),
};

const updateChecker = async () => ({
  update_available: false,
  current_version: 'loadtest',
  remote_version: 'loadtest',
  tag: 'loadtest',
  release_url: '',
  checked_at: new Date().toISOString(),
});

const controller = createApp({
  config,
  database,
  lapiClient: fakeLapiClient as never,
  startBackgroundTasks: false,
  updateChecker,
  initialCacheState: {
    isInitialized: true,
    isComplete: true,
    lastUpdate: new Date().toISOString(),
  },
  notificationFetchImpl: async () => new Response('ok', { status: 200 }),
  mqttPublishImpl: async () => {},
});

function formatElapsed(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  return `${(ms / 1_000).toFixed(2)}s`;
}

function isApiRequest(pathname: string): boolean {
  const basePath = controller.config.basePath;
  const apiPrefix = basePath ? `${basePath}/api` : '/api';
  return pathname === apiPrefix || pathname.startsWith(`${apiPrefix}/`);
}

async function fetchWithApiLogging(...args: Parameters<typeof controller.fetch>): Promise<Response> {
  const [request] = args;
  const url = new URL(request.url);
  const startedAt = Date.now();

  try {
    const response = await controller.fetch(...args);
    if (isApiRequest(url.pathname)) {
      console.log(`[loadtest api] ${request.method} ${url.pathname}${url.search} -> ${response.status} ${formatElapsed(Date.now() - startedAt)}`);
    }
    return response;
  } catch (error) {
    if (isApiRequest(url.pathname)) {
      console.log(`[loadtest api] ${request.method} ${url.pathname}${url.search} -> error ${formatElapsed(Date.now() - startedAt)}`);
    }
    throw error;
  }
}

const server = serve({
  fetch: fetchWithApiLogging,
  port: controller.config.port,
});

console.log(`Load-test backend running at http://127.0.0.1:${controller.config.port}/`);
console.log(`Auth is disabled for load-test mode.`);

function shutdown() {
  controller.stopBackgroundTasks();
  server.close(() => {
    database.close();
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
