import { serve } from '@hono/node-server';
import path from 'node:path';
import { createApp } from '../server/app';
import { createRuntimeConfig } from '../server/config';
import { CrowdsecDatabase } from '../server/database';

const dbDir = process.env.DB_DIR || path.join(process.env.TMPDIR || '/tmp', 'crowdsec-web-ui-screenshots');
const configFile = path.join(dbDir, 'screenshot-config.yaml');
const port = Number(process.env.CROWDSEC_SCREENSHOT_BACKEND_PORT || process.env.PORT || 3001);
const database = new CrowdsecDatabase({ dbDir });
const demoPrometheusMetrics = `
# HELP cs_lapi_bouncer_requests_total number of calls
# TYPE cs_lapi_bouncer_requests_total counter
cs_lapi_bouncer_requests_total{bouncer="edge-firewall",route="/v1/decisions",method="GET"} 1842
cs_lapi_bouncer_requests_total{bouncer="edge-firewall",route="/v1/decisions/stream",method="GET"} 428
cs_lapi_bouncer_requests_total{bouncer="nginx-bouncer",route="/v1/decisions",method="GET"} 936
cs_lapi_decisions_ok_total{bouncer="edge-firewall"} 721
cs_lapi_decisions_ko_total{bouncer="edge-firewall"} 38
cs_lapi_decisions_ok_total{bouncer="nginx-bouncer"} 318
cs_lapi_decisions_ko_total{bouncer="nginx-bouncer"} 14
cs_lapi_machine_requests_total{machine="edge-gateway-01",route="/v1/alerts",method="GET"} 312
cs_lapi_machine_requests_total{machine="edge-gateway-01",route="/v1/watchers/login",method="POST"} 18
cs_lapi_machine_requests_total{machine="proxy-01",route="/v1/alerts",method="GET"} 244
cs_lapi_machine_requests_total{machine="appsec-01",route="/v1/alerts",method="GET"} 126
cs_appsec_reqs_total{source="0.0.0.0:7422",appsec_engine="public-web"} 4821
cs_appsec_block_total{source="0.0.0.0:7422",appsec_engine="public-web"} 143
cs_filesource_hits_total{source="/var/log/auth.log"} 12844
cs_filesource_hits_total{source="/var/log/nginx/access.log"} 9142
cs_parser_hits_total{source="/var/log/auth.log",type="syslog"} 12780
cs_parser_hits_ok_total{source="/var/log/auth.log",type="syslog",acquis_type="file"} 12631
cs_parser_hits_ko_total{source="/var/log/auth.log",type="syslog",acquis_type="file"} 149
cs_parser_hits_total{source="/var/log/nginx/access.log",type="nginx"} 9087
cs_parser_hits_ok_total{source="/var/log/nginx/access.log",type="nginx",acquis_type="file"} 8998
cs_parser_hits_ko_total{source="/var/log/nginx/access.log",type="nginx",acquis_type="file"} 89
cs_bucket_poured_total{name="crowdsecurity/ssh-bf",source="/var/log/auth.log",type="syslog"} 612
cs_bucket_poured_total{name="crowdsecurity/http-probing",source="/var/log/nginx/access.log",type="nginx"} 418
cs_node_wl_hits_ok_total{name="crowdsecurity/whitelists",source="/var/log/auth.log",type="syslog",reason="private",stage="s02-enrich",acquis_type="file"} 74
cs_node_wl_hits_total{name="crowdsecurity/whitelists",source="/var/log/auth.log",type="syslog",reason="private",stage="s02-enrich",acquis_type="file"} 226
cs_node_hits_total{name="crowdsecurity/sshd-logs",source="/var/log/auth.log",type="syslog",stage="s01-parse",acquis_type="file"} 12780
cs_node_hits_ok_total{name="crowdsecurity/sshd-logs",source="/var/log/auth.log",type="syslog",stage="s01-parse",acquis_type="file"} 12631
cs_node_hits_ko_total{name="crowdsecurity/sshd-logs",source="/var/log/auth.log",type="syslog",stage="s01-parse",acquis_type="file"} 149
cs_node_hits_total{name="crowdsecurity/nginx-logs",source="/var/log/nginx/access.log",type="nginx",stage="s01-parse",acquis_type="file"} 9087
cs_node_hits_ok_total{name="crowdsecurity/nginx-logs",source="/var/log/nginx/access.log",type="nginx",stage="s01-parse",acquis_type="file"} 8998
cs_node_hits_ko_total{name="crowdsecurity/nginx-logs",source="/var/log/nginx/access.log",type="nginx",stage="s01-parse",acquis_type="file"} 89
cs_parsing_time_seconds_count{source="/var/log/auth.log",type="syslog"} 12780
cs_parsing_time_seconds_sum{source="/var/log/auth.log",type="syslog"} 24.921
cs_parsing_time_seconds_count{source="/var/log/nginx/access.log",type="nginx"} 9087
cs_parsing_time_seconds_sum{source="/var/log/nginx/access.log",type="nginx"} 13.812
`;

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
  CROWDSEC_PROMETHEUS_URL: process.env.CROWDSEC_PROMETHEUS_URL || 'http://screenshot-demo.local/metrics',
  VITE_VERSION: process.env.VITE_VERSION || '2026.06.05',
  VITE_BRANCH: process.env.VITE_BRANCH || 'main',
  VITE_COMMIT_HASH: process.env.VITE_COMMIT_HASH || 'screenshot',
}, { defaultConfigFile: configFile });

const primaryInstance = config.instances[0];
config.instances = [
  {
    ...primaryInstance,
    id: 'primary',
    name: 'Primary',
    icon: '🏢',
    lapiUrl: 'http://primary.screenshot-demo.local:8080',
  },
  {
    ...primaryInstance,
    id: 'branch',
    name: 'Branch Office',
    icon: '🏪',
    lapiUrl: 'http://branch.screenshot-demo.local:8080',
    prometheus: [],
  },
  {
    ...primaryInstance,
    id: 'edge',
    name: 'Edge',
    icon: '🛰️',
    lapiUrl: 'http://edge.screenshot-demo.local:8080',
    prometheus: [],
  },
];

function createFakeLapiClient(instanceId: string) {
  return {
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
    fetchAlerts: async () => database.getAllAlerts()
      .map((row) => JSON.parse(row.raw_data) as { instance_id?: string })
      .filter((alert) => alert.instance_id === instanceId),
    getAlertById: async (alertId: string | number) => {
      const alert = database
        .getAllAlerts()
        .map((row) => JSON.parse(row.raw_data) as { id: string | number; instance_id?: string })
        .find((item) => item.instance_id === instanceId && String(item.id) === String(alertId));
      return alert || null;
    },
    addDecision: async () => ({ message: 'Decision added for screenshot demo' }),
    deleteDecision: async () => ({ message: 'Decision deleted for screenshot demo' }),
    deleteAlert: async () => ({ message: 'Alert deleted for screenshot demo' }),
  };
};

const fakeLapiClients = new Map(config.instances.map((instance) => [
  instance.id,
  createFakeLapiClient(instance.id),
]));

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
  lapiClients: fakeLapiClients as never,
  initialCacheState: {
    isInitialized: true,
    isComplete: true,
    lastUpdate: new Date().toISOString(),
  },
  startBackgroundTasks: false,
  updateChecker,
  metricsFetchImpl: async () => new Response(demoPrometheusMetrics, {
    headers: { 'content-type': 'text/plain; version=0.0.4' },
  }),
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
