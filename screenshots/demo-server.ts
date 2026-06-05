import { serve } from '@hono/node-server';
import path from 'node:path';
import { createApp } from '../server/app';
import { createRuntimeConfig } from '../server/config';
import { CrowdsecDatabase } from '../server/database';

const dbDir = process.env.DB_DIR || path.join(process.env.TMPDIR || '/tmp', 'crowdsec-web-ui-screenshots');
const port = Number(process.env.CROWDSEC_SCREENSHOT_BACKEND_PORT || process.env.PORT || 3001);
const database = new CrowdsecDatabase({ dbDir });

const config = createRuntimeConfig({
  ...process.env,
  PORT: String(port),
  CROWDSEC_USER: 'screenshot-machine',
  CROWDSEC_PASSWORD: 'screenshot-password',
  CROWDSEC_REFRESH_INTERVAL: process.env.CROWDSEC_REFRESH_INTERVAL || '5m',
  CROWDSEC_LOOKBACK_PERIOD: process.env.CROWDSEC_LOOKBACK_PERIOD || '6h',
  CROWDSEC_HEARTBEAT_INTERVAL: '0',
  CROWDSEC_BOOTSTRAP_RETRY_ENABLED: 'false',
  CROWDSEC_SIMULATIONS_ENABLED: 'true',
  VITE_VERSION: process.env.VITE_VERSION || '2026.06.05',
  VITE_BRANCH: process.env.VITE_BRANCH || 'main',
  VITE_COMMIT_HASH: process.env.VITE_COMMIT_HASH || 'screenshot',
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
  fetchAlerts: async () => database.getAllAlerts().map((row) => JSON.parse(row.raw_data)),
  getAlertById: async (alertId: string | number) => {
    const alert = database
      .getAllAlerts()
      .map((row) => JSON.parse(row.raw_data) as { id: string | number })
      .find((item) => String(item.id) === String(alertId));
    return alert || null;
  },
  addDecision: async () => ({ message: 'Decision added for screenshot demo' }),
  deleteDecision: async () => ({ message: 'Decision deleted for screenshot demo' }),
  deleteAlert: async () => ({ message: 'Alert deleted for screenshot demo' }),
};

const updateChecker = async () => ({
  update_available: true,
  current_version: '2026.06.05',
  remote_version: '2026.06.06',
  tag: 'latest',
  release_url: 'https://github.com/TheDuffman85/crowdsec-web-ui/releases/tag/v2026.06.06',
  checked_at: new Date().toISOString(),
});

const controller = createApp({
  config,
  database,
  lapiClient: fakeLapiClient as never,
  startBackgroundTasks: false,
  updateChecker,
  notificationFetchImpl: async () => new Response('ok', { status: 200 }),
  mqttPublishImpl: async () => {},
});

const server = serve({
  fetch: controller.fetch,
  port: controller.config.port,
});

console.log(`Screenshot demo backend running at http://127.0.0.1:${controller.config.port}/`);

function shutdown() {
  controller.stopBackgroundTasks();
  server.close(() => {
    database.close();
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
