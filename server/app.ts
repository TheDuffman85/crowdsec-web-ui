import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { serveStatic } from '@hono/node-server/serve-static';
import type {
  AddDecisionRequest,
  AlertDecision,
  AlertRecord,
  BulkDeleteRequest,
  BulkDeleteResult,
  BulkDeleteFailure,
  CleanupByIpRequest,
  ConfigResponse,
  DecisionListItem,
  LapiStatus,
  SlimAlert,
  StatsAlert,
  StatsDecision,
  SyncStatus,
  UpsertNotificationChannelRequest,
  UpsertNotificationRuleRequest,
  UpdateCheckResponse,
} from '../shared/contracts';
import { normalizeMachineId, resolveMachineName } from '../shared/machine';
import { createRuntimeConfig, getIntervalName, parseRefreshInterval, type RuntimeConfig } from './config';
import { CrowdsecDatabase, type AlertInsertParams, type DecisionInsertParams } from './database';
import { LapiClient } from './lapi';
import { createNotificationService } from './notifications';
import type { MqttPublishConfig } from './notifications/mqtt-client';
import { createNotificationOutboundGuard } from './notifications/outbound-guard';
import { createNotificationSecretStore } from './notifications/secret-store';
import { createUpdateChecker } from './update-check';
import { getAlertSourceValue, getAlertTarget, resolveAlertReason, resolveAlertScenario, toSlimAlert } from './utils/alerts';
import { parseGoDuration, toDuration } from './utils/duration';

type HonoContext = any;
type HonoNext = any;
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type AnyError = Error & {
  code?: string;
  response?: { status: number };
  request?: unknown;
  helpLink?: string;
  helpText?: string;
};

export interface CreateAppOptions {
  config?: RuntimeConfig;
  database?: CrowdsecDatabase;
  lapiClient?: LapiClient;
  distRoot?: string;
  startBackgroundTasks?: boolean;
  updateChecker?: () => Promise<UpdateCheckResponse>;
  notificationFetchImpl?: FetchLike;
  mqttPublishImpl?: (config: MqttPublishConfig, payload: string) => Promise<void>;
}

export interface AppController {
  app: Hono;
  fetch: Hono['fetch'];
  config: RuntimeConfig;
  database: CrowdsecDatabase;
  lapiClient: LapiClient;
  startBackgroundTasks: () => void;
  stopBackgroundTasks: () => void;
  getSyncStatus: () => SyncStatus;
  getLapiStatus: () => LapiStatus;
}

interface PersistedConfig {
  refresh_interval_ms?: number;
}

interface CacheState {
  isInitialized: boolean;
  lastUpdate: string | null;
}

interface UpdateCache {
  lastCheck: number;
  data: UpdateCheckResponse | null;
}

interface AlertSyncQuery {
  origin?: string;
  scenario?: string;
}

interface CachedDecisionRecord {
  id: string;
  value?: string;
  raw_data: string;
}

interface CachedAlertRecord {
  id: string;
  sourceValue?: string;
  raw_data: string;
}

const NOTIFICATION_SECRET_KEY_META_KEY = 'notification_secret_key';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const UNFILTERED_ALERT_ORIGIN_TOKENS = new Set(['none']);
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
const IPV6_RE = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(\/\d{1,3})?$/;

export function createApp(options: CreateAppOptions = {}): AppController {
  const config = options.config || createRuntimeConfig();
  const database = options.database || new CrowdsecDatabase({ dbDir: config.dbDir });
  const lapiClient = options.lapiClient || new LapiClient({
    crowdsecUrl: config.crowdsecUrl,
    auth: config.crowdsecAuth,
    simulationsEnabled: config.simulationsEnabled,
    lookbackPeriod: config.lookbackPeriod,
    version: config.version,
  });
  const checkForUpdates = options.updateChecker || createUpdateChecker({
    dockerImageRef: config.dockerImageRef,
    branch: config.branch,
    commitHash: config.commitHash,
    version: config.version,
    enabled: config.updateCheckEnabled,
  });
  const notificationSecretKey = resolveNotificationSecretKey(database, config.notificationSecretKey);
  const notificationSecretStore = createNotificationSecretStore(notificationSecretKey);
  const notificationOutboundGuard = createNotificationOutboundGuard({
    allowPrivateAddresses: config.notificationAllowPrivateAddresses,
  });
  const notificationService = createNotificationService({
    database,
    fetchImpl: options.notificationFetchImpl,
    mqttPublishImpl: options.mqttPublishImpl,
    updateChecker: checkForUpdates,
    outboundGuard: notificationOutboundGuard,
    secretStore: notificationSecretStore,
  });

  const app = new Hono();
  const distRoot = options.distRoot || path.resolve(process.cwd(), 'dist/client');
  const staticFiles = [
    '/logo.svg',
    '/favicon.ico',
    '/robots.txt',
    '/world-50m.json',
    '/favicon-96x96.png',
    '/apple-touch-icon.png',
    '/android-chrome-192x192.png',
    '/android-chrome-512x512.png',
  ];

  const syncStatus: SyncStatus = {
    isSyncing: false,
    progress: 0,
    message: '',
    startedAt: null,
    completedAt: null,
  };

  const cache: CacheState = {
    isInitialized: false,
    lastUpdate: null,
  };

  const persistedConfig = loadPersistedConfig(database);
  let refreshIntervalMs = persistedConfig.refresh_interval_ms ?? config.refreshIntervalMs;
  let initializationPromise: Promise<boolean> | null = null;
  let isFirstSync = true;
  let lastRequestTime = Date.now();
  let lastFullRefreshTime = Date.now();
  let schedulerTimeout: ReturnType<typeof setTimeout> | null = null;
  let isSchedulerRunning = false;
  let bootstrapRetryTimeout: ReturnType<typeof setTimeout> | null = null;
  let bootstrapPromise: Promise<boolean> | null = null;
  let bootstrapWaitLogged = false;

  console.log(`Cache Configuration:
  Lookback Period: ${config.lookbackPeriod} (${config.lookbackMs}ms)
  Refresh Interval: ${getIntervalName(refreshIntervalMs)} (${persistedConfig.refresh_interval_ms !== undefined ? 'from saved config' : 'from env'})
  Auth Mode: ${config.crowdsecAuthMode}
  Simulations: ${config.simulationsEnabled ? 'Enabled' : 'Disabled'}
  Always Show Machine: ${config.alwaysShowMachine ? 'Enabled' : 'Disabled'}
  Alert Origin Allowlist: ${config.alertOrigins.length > 0 ? config.alertOrigins.join(', ') : 'Disabled'}
  Alert Scenario Allowlist: ${config.alertExtraScenarios.length > 0 ? config.alertExtraScenarios.join(', ') : 'Disabled'}
  Bootstrap Retry: ${config.bootstrapRetryEnabled ? getIntervalName(config.bootstrapRetryDelayMs) : 'Disabled'}
  Notification Secret Storage: Encrypted (${config.notificationSecretKey ? 'configured key' : 'auto-generated key'})
  Notification Private Destinations: ${config.notificationAllowPrivateAddresses ? 'Allowed' : 'Blocked'}
`);

  if (!lapiClient.hasAuthConfig()) {
    console.warn(
      'WARNING: CrowdSec LAPI authentication is not configured. Set CROWDSEC_USER/CROWDSEC_PASSWORD or CROWDSEC_TLS_CERT_PATH/CROWDSEC_TLS_KEY_PATH for full functionality.',
    );
  }

  app.use('*', compress());
  app.use('*', async (context, next) => {
    await next();
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('X-Frame-Options', 'DENY');
    context.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    context.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  });

  app.use('*', activityTrackerMiddleware);

  const healthHandler = (context: HonoContext) => context.json({ status: 'ok' });
  app.get('/api/health', healthHandler);
  if (config.basePath) {
    app.get(`${config.basePath}/api/health`, healthHandler);
  }

  app.get(`${config.basePath}/api/alerts`, ensureAuth, async (context) => {
    try {
      if (refreshIntervalMs === 0) {
        await updateCache();
      }

      if (!cache.isInitialized) {
        await ensureBootstrapReady('alerts request');
      }

      const since = new Date(Date.now() - config.lookbackMs).toISOString();
      const alerts = database
        .getAlertsSince(since)
        .map((row) => applySimulationModeToAlert(hydrateAlertWithDecisions(JSON.parse(row.raw_data) as AlertRecord), config.simulationsEnabled))
        .filter((alert): alert is AlertRecord => alert !== null)
        .map((alert) => toSlimAlert(alert))
        .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());

      return context.json(alerts);
    } catch (error: any) {
      console.error('Error serving alerts from database:', error.message);
      return context.json({ error: 'Failed to retrieve alerts' }, 500);
    }
  });

  app.post(`${config.basePath}/api/alerts/bulk-delete`, ensureAuth, async (context) => {
    const doRequest = async () => {
      const body = await context.req.json<BulkDeleteRequest>();
      if (!Array.isArray(body.ids) || body.ids.length === 0) {
        return context.json({ error: 'At least one alert ID is required' }, 400);
      }
      const ids = normalizeDeleteIds(body.ids);
      if (ids.length !== body.ids.length) {
        return context.json({ error: 'Alert IDs must be numeric' }, 400);
      }

      const result = await deleteAlertsByIds(ids);
      return context.json(result);
    };

    try {
      return await doRequest();
    } catch (error) {
      return handleApiError(error as AnyError, context, 'bulk deleting alerts', doRequest);
    }
  });

  app.get(`${config.basePath}/api/alerts/:id`, ensureAuth, async (context) => {
    const alertId = String(context.req.param('id'));
    if (!/^\d+$/.test(alertId)) {
      return context.json({ error: 'Invalid alert ID' }, 400);
    }

    const doRequest = async () => {
      const alertData = await lapiClient.getAlertById(alertId);
      const normalizedAlert = normalizeAlertDetail(alertData, alertId);
      if (!normalizedAlert) {
        return context.json({ error: 'Alert not found' }, 404);
      }

      const payload = applySimulationModeToAlert(hydrateAlertWithDecisions(normalizedAlert), config.simulationsEnabled);
      if (!payload) {
        return context.json({ error: 'Alert not found' }, 404);
      }
      return context.json(payload);
    };

    try {
      return await doRequest();
    } catch (error) {
      return handleApiError(error as AnyError, context, 'fetching alert details', doRequest);
    }
  });

  app.delete(`${config.basePath}/api/alerts/:id`, ensureAuth, async (context) => {
    const alertId = String(context.req.param('id'));
    if (!/^\d+$/.test(alertId)) {
      return context.json({ error: 'Invalid alert ID' }, 400);
    }

    const doRequest = async () => {
      const result = await lapiClient.deleteAlert(alertId);
      database.deleteAlert(alertId);
      database.deleteDecisionsByAlertId(alertId);
      return context.json((result as object) || { message: 'Deleted' });
    };

    try {
      return await doRequest();
    } catch (error) {
      return handleApiError(error as AnyError, context, 'deleting alert', doRequest);
    }
  });

  app.get(`${config.basePath}/api/decisions`, ensureAuth, async (context) => {
    try {
      if (refreshIntervalMs === 0) {
        await updateCache();
      }

      if (!cache.isInitialized) {
        await ensureBootstrapReady('decisions request');
      }

      const includeExpired = context.req.query('include_expired') === 'true';
      const now = new Date().toISOString();
      const since = new Date(Date.now() - config.lookbackMs).toISOString();
      const rows = includeExpired
        ? database.getDecisionsSince(since, now)
        : database.getActiveDecisions(now);

      let decisions = rows.map((row) => toDecisionListItem(JSON.parse(row.raw_data) as AlertDecision & Record<string, unknown>, includeExpired));
      if (!config.simulationsEnabled) {
        decisions = decisions.filter((decision) => !decision.simulated);
      }
      decisions = markDuplicateDecisions(decisions);
      decisions.sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());

      return context.json(decisions);
    } catch (error: any) {
      console.error('Error serving decisions from database:', error.message);
      return context.json({ error: 'Failed to retrieve decisions' }, 500);
    }
  });

  app.get(`${config.basePath}/api/config`, ensureAuth, (context) => {
    const hours = lookbackHours(config.lookbackPeriod);
    const payload: ConfigResponse = {
      lookback_period: config.lookbackPeriod,
      lookback_hours: hours,
      lookback_days: Math.max(1, Math.round(hours / 24)),
      refresh_interval: refreshIntervalMs,
      current_interval_name: getIntervalName(refreshIntervalMs),
      lapi_status: lapiClient.getStatus(),
      sync_status: syncStatus,
      simulations_enabled: config.simulationsEnabled,
      machine_features_enabled: isMachineFeatureEnabled(),
    };

    return context.json(payload);
  });

  app.put(`${config.basePath}/api/config/refresh-interval`, ensureAuth, async (context) => {
    try {
      const body = await context.req.json<{ interval?: string }>();
      const interval = body.interval;

      if (!interval) {
        return context.json({ error: 'interval is required' }, 400);
      }

      const validIntervals = ['manual', '0', '5s', '30s', '1m', '5m'];
      if (!validIntervals.includes(interval)) {
        return context.json({ error: `Invalid interval. Must be one of: ${validIntervals.join(', ')}` }, 400);
      }

      const nextInterval = parseRefreshInterval(interval);
      const previous = getIntervalName(refreshIntervalMs);
      refreshIntervalMs = nextInterval;
      savePersistedConfig(database, { refresh_interval_ms: nextInterval });
      startRefreshScheduler();
      console.log(`Refresh interval changed: ${previous} -> ${interval} (${nextInterval}ms)`);

      return context.json({
        success: true,
        old_interval: previous,
        new_interval: interval,
        new_interval_ms: nextInterval,
        message: `Refresh interval updated to ${interval}`,
      });
    } catch (error: any) {
      console.error('Error updating refresh interval:', error.message);
      return context.json({ error: 'Failed to update refresh interval' }, 500);
    }
  });

  app.get(`${config.basePath}/api/notifications`, ensureAuth, (context) => {
    const limit = Number.parseInt(context.req.query('limit') || '100', 10);
    return context.json(notificationService.listNotifications(Number.isFinite(limit) ? limit : 100));
  });

  app.post(`${config.basePath}/api/notifications/read-all`, ensureAuth, () =>
    Response.json({ updated: notificationService.markAllNotificationsRead() }),
  );

  app.post(`${config.basePath}/api/cleanup/by-ip`, ensureAuth, async (context) => {
    const doRequest = async () => {
      const body = await context.req.json<CleanupByIpRequest>();
      const ip = String(body.ip || '').trim();
      if (!isValidIpOrRange(ip)) {
        return context.json({ error: 'Invalid IP address format' }, 400);
      }

      const result = await deleteEntriesByIp(ip);
      return context.json(result);
    };

    try {
      return await doRequest();
    } catch (error) {
      return handleApiError(error as AnyError, context, 'deleting entries by IP', doRequest);
    }
  });

  app.post(`${config.basePath}/api/notifications/:id/read`, ensureAuth, (context) => {
    const id = String(context.req.param('id'));
    const updated = notificationService.markNotificationRead(id);
    if (!updated) {
      return context.json({ error: 'Notification not found' }, 404);
    }
    return context.json({ success: true });
  });

  app.get(`${config.basePath}/api/notifications/settings`, ensureAuth, () => Response.json(notificationService.listSettings()));

  app.post(`${config.basePath}/api/notification-channels`, ensureAuth, async (context) => {
    try {
      const body = await context.req.json<UpsertNotificationChannelRequest>();
      return context.json(notificationService.createChannel(body), 201);
    } catch (error: any) {
      return context.json({ error: error.message || 'Failed to create notification channel' }, 400);
    }
  });

  app.put(`${config.basePath}/api/notification-channels/:id`, ensureAuth, async (context) => {
    try {
      const id = String(context.req.param('id'));
      const body = await context.req.json<UpsertNotificationChannelRequest>();
      return context.json(notificationService.updateChannel(id, body));
    } catch (error: any) {
      const status = error.message === 'Notification channel not found' ? 404 : 400;
      return context.json({ error: error.message || 'Failed to update notification channel' }, status);
    }
  });

  app.delete(`${config.basePath}/api/notification-channels/:id`, ensureAuth, (context) => {
    const id = String(context.req.param('id'));
    notificationService.deleteChannel(id);
    return context.json({ success: true });
  });

  app.post(`${config.basePath}/api/notification-channels/:id/test`, ensureAuth, async (context) => {
    try {
      const id = String(context.req.param('id'));
      await notificationService.testChannel(id);
      return context.json({ success: true });
    } catch (error: any) {
      const status = error.message === 'Notification channel not found' ? 404 : 400;
      return context.json({ error: error.message || 'Failed to send test notification' }, status);
    }
  });

  app.post(`${config.basePath}/api/notification-rules`, ensureAuth, async (context) => {
    try {
      const body = await context.req.json<UpsertNotificationRuleRequest>();
      return context.json(notificationService.createRule(body), 201);
    } catch (error: any) {
      return context.json({ error: error.message || 'Failed to create notification rule' }, 400);
    }
  });

  app.put(`${config.basePath}/api/notification-rules/:id`, ensureAuth, async (context) => {
    try {
      const id = String(context.req.param('id'));
      const body = await context.req.json<UpsertNotificationRuleRequest>();
      return context.json(notificationService.updateRule(id, body));
    } catch (error: any) {
      const status = error.message === 'Notification rule not found' ? 404 : 400;
      return context.json({ error: error.message || 'Failed to update notification rule' }, status);
    }
  });

  app.delete(`${config.basePath}/api/notification-rules/:id`, ensureAuth, (context) => {
    const id = String(context.req.param('id'));
    notificationService.deleteRule(id);
    return context.json({ success: true });
  });

  app.post(`${config.basePath}/api/cache/clear`, ensureAuth, async (context) => {
    try {
      console.log('Manual cache clear requested');
      database.clearSyncData();
      cache.isInitialized = false;
      cache.lastUpdate = null;
      isFirstSync = true;
      await ensureBootstrapReady('manual cache clear');

      return context.json({
        success: true,
        message: 'Cache cleared and re-synced',
        alert_count: database.countAlerts(),
      });
    } catch (error: any) {
      console.error('Error clearing cache:', error.message);
      return context.json({ error: 'Failed to clear cache' }, 500);
    }
  });

  app.get(`${config.basePath}/api/stats/alerts`, ensureAuth, async (context) => {
    try {
      if (refreshIntervalMs === 0) {
        await updateCache();
      }

      if (!cache.isInitialized) {
        await ensureBootstrapReady('stats alerts request');
      }

      const since = new Date(Date.now() - config.lookbackMs).toISOString();
      const alerts = database
        .getAlertsSince(since)
        .map((row) => {
          const alert = applySimulationModeToAlert(
            hydrateAlertWithDecisions(JSON.parse(row.raw_data) as AlertRecord),
            config.simulationsEnabled,
          );
          if (!alert) {
            return null;
          }
          const payload: StatsAlert = {
            created_at: alert.created_at,
            kind: typeof alert.kind === 'string' ? alert.kind : undefined,
            scenario: resolveAlertScenario(alert),
            source: alert.source
              ? {
                  ip: alert.source.ip,
                  value: alert.source.value,
                  range: alert.source.range,
                  cn: alert.source.cn,
                  as_name: alert.source.as_name,
                  scope: alert.source.scope,
                }
              : null,
            target: alert.target,
            simulated: isAlertSimulated(alert),
          };
          return payload;
        })
        .filter((alert): alert is StatsAlert => alert !== null)
        .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());

      return context.json(alerts);
    } catch (error: any) {
      console.error('Error serving stats alerts from database:', error.message);
      return context.json({ error: 'Failed to retrieve alert statistics' }, 500);
    }
  });

  app.get(`${config.basePath}/api/stats/decisions`, ensureAuth, async (context) => {
    try {
      if (refreshIntervalMs === 0) {
        await updateCache();
      }

      if (!cache.isInitialized) {
        await ensureBootstrapReady('stats decisions request');
      }

      const since = new Date(Date.now() - config.lookbackMs).toISOString();
      const now = new Date().toISOString();
      const decisions = database
        .getDecisionsSince(since, now)
        .map((row) => {
          const decision = JSON.parse(row.raw_data) as Record<string, unknown>;
          const payload: StatsDecision = {
            id: decision.id as string | number,
            created_at: String(decision.created_at || ''),
            scenario: typeof decision.scenario === 'string' ? decision.scenario : undefined,
            value: typeof decision.value === 'string' ? decision.value : undefined,
            stop_at: typeof decision.stop_at === 'string' ? decision.stop_at : undefined,
            target: typeof decision.target === 'string' ? decision.target : undefined,
            simulated: normalizeDecisionSimulated(decision),
          };
          return payload;
        })
        .filter((decision) => config.simulationsEnabled || !decision.simulated)
        .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());

      return context.json(decisions);
    } catch (error: any) {
      console.error('Error serving stats decisions from database:', error.message);
      return context.json({ error: 'Failed to retrieve decision statistics' }, 500);
    }
  });

  app.post(`${config.basePath}/api/decisions`, ensureAuth, async (context) => {
    const doRequest = async () => {
      const body = await context.req.json<AddDecisionRequest>();
      const ip = body.ip;
      const duration = body.duration || '4h';
      const reason = body.reason || 'manual';
      const type = body.type || 'ban';

      if (!ip) {
        return context.json({ error: 'IP address is required' }, 400);
      }

      if (!isValidIpOrRange(ip)) {
        return context.json({ error: 'Invalid IP address format' }, 400);
      }

      const validTypes = ['ban', 'captcha'];
      if (!validTypes.includes(type)) {
        return context.json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` }, 400);
      }

      if (!/^\d+[smhd]$/.test(duration)) {
        return context.json({ error: 'Invalid duration format. Use e.g. "4h", "30m", "1d"' }, 400);
      }

      const result = await lapiClient.addDecision(ip, type, duration, reason.slice(0, 256));
      console.log('Refreshing cache after adding decision...');
      await updateCacheDelta();
      return context.json({ message: 'Decision added (via Alert)', result });
    };

    try {
      return await doRequest();
    } catch (error) {
      return handleApiError(error as AnyError, context, 'adding decision', doRequest);
    }
  });

  app.post(`${config.basePath}/api/decisions/bulk-delete`, ensureAuth, async (context) => {
    const doRequest = async () => {
      const body = await context.req.json<BulkDeleteRequest>();
      if (!Array.isArray(body.ids) || body.ids.length === 0) {
        return context.json({ error: 'At least one decision ID is required' }, 400);
      }
      const ids = normalizeDeleteIds(body.ids);
      if (ids.length !== body.ids.length) {
        return context.json({ error: 'Decision IDs must be numeric' }, 400);
      }

      const result = await deleteDecisionsByIds(ids);
      return context.json(result);
    };

    try {
      return await doRequest();
    } catch (error) {
      return handleApiError(error as AnyError, context, 'bulk deleting decisions', doRequest);
    }
  });

  app.delete(`${config.basePath}/api/decisions/:id`, ensureAuth, async (context) => {
    const decisionId = String(context.req.param('id'));
    if (!/^\d+$/.test(decisionId)) {
      return context.json({ error: 'Invalid decision ID' }, 400);
    }

    const doRequest = async () => {
      const result = await lapiClient.deleteDecision(decisionId);
      console.log(`Removing decision ${decisionId} from local cache...`);
      database.deleteDecision(decisionId);
      return context.json((result as object) || { message: 'Deleted' });
    };

    try {
      return await doRequest();
    } catch (error) {
      return handleApiError(error as AnyError, context, 'deleting decision', doRequest);
    }
  });

  app.get(`${config.basePath}/api/update-check`, ensureAuth, async (context) => {
    try {
      const status = await checkForUpdates();
      context.header('Cache-Control', 'no-store, no-cache, must-revalidate');
      context.header('Pragma', 'no-cache');
      return context.json(status);
    } catch (error: any) {
      console.error('Error checking for updates:', error.message);
      context.header('Cache-Control', 'no-store, no-cache, must-revalidate');
      context.header('Pragma', 'no-cache');
      return context.json({ error: 'Update check failed' }, 500);
    }
  });

  app.use(
    `${config.basePath}/assets/*`,
    serveStatic({
      root: distRoot,
      rewriteRequestPath: (requestPath) => (config.basePath ? requestPath.replace(config.basePath, '') : requestPath),
    }),
  );

  staticFiles.forEach((file) => {
    app.use(
      `${config.basePath}${file}`,
      serveStatic({
        root: distRoot,
        rewriteRequestPath: (requestPath) => (config.basePath ? requestPath.replace(config.basePath, '') : requestPath),
      }),
    );
  });

  app.get(`${config.basePath}/site.webmanifest`, (context) =>
    context.json({
      name: 'CrowdSec Web UI',
      short_name: 'CrowdSec',
      icons: [
        { src: `${config.basePath}/android-chrome-192x192.png`, sizes: '192x192', type: 'image/png' },
        { src: `${config.basePath}/android-chrome-512x512.png`, sizes: '512x512', type: 'image/png' },
      ],
      theme_color: '#ffffff',
      background_color: '#ffffff',
      display: 'standalone',
      start_url: config.basePath || '/',
    }),
  );

  app.get(`${config.basePath}/*`, (context) => {
    try {
      const indexPath = path.join(distRoot, 'index.html');
      let html = fs.readFileSync(indexPath, 'utf-8');
      const safePath = config.basePath.replace(/[^a-zA-Z0-9/_-]/g, '');
      const configScript = `<script>window.__BASE_PATH__="${safePath}";</script>`;
      html = html.replace('</head>', `${configScript}\n</head>`);

      if (config.basePath) {
        html = html.replace(/href="\.\//g, `href="${config.basePath}/`);
        html = html.replace(/src="\.\//g, `src="${config.basePath}/`);
      }

      return context.html(html);
    } catch {
      return context.text('Not Found', 404);
    }
  });

  if (config.basePath) {
    app.get('/', (context) => context.redirect(`${config.basePath}/`));
  }

  function updateSyncStatus(updates: Partial<SyncStatus>): void {
    Object.assign(syncStatus, updates);
  }

  async function runNotificationEvaluation(source: string): Promise<void> {
    try {
      await notificationService.evaluateRules();
    } catch (error: any) {
      console.error(`Notification evaluation failed during ${source}:`, error.message);
    }
  }

  function getAlertSyncQueries(): AlertSyncQuery[] {
    const queries: AlertSyncQuery[] = [];
    let includeUnfiltered = false;

    for (const origin of config.alertOrigins) {
      if (UNFILTERED_ALERT_ORIGIN_TOKENS.has(origin.trim().toLowerCase())) {
        includeUnfiltered = true;
        continue;
      }
      queries.push({ origin });
    }

    if (includeUnfiltered) {
      queries.push({});
    }

    for (const scenario of config.alertExtraScenarios) {
      queries.push({ scenario });
    }

    return queries;
  }

  async function fetchAlertsForSync(
    since: string | null = null,
    until: string | null = null,
    hasActiveDecision = false,
  ): Promise<AlertRecord[]> {
    const configuredQueries = getAlertSyncQueries();
    const queries = configuredQueries.length === 0 ? [{}] : configuredQueries;
    const resultSets = await Promise.all(queries.map((query) => lapiClient.fetchAlerts(since, until, hasActiveDecision, query)));

    const merged = new Map<string, AlertRecord>();
    for (const resultSet of resultSets) {
      for (const alert of resultSet) {
        const typedAlert = alert as AlertRecord;
        if (!typedAlert?.id) continue;
        merged.set(String(typedAlert.id), typedAlert);
      }
    }

    return Array.from(merged.values());
  }

  function processAlertForDatabase(alert: AlertRecord): void {
    if (!alert || !alert.id) return;
    const decisions = alert.decisions || [];
    const alertSource = alert.source || null;
    const sourceValue = getAlertSourceValue(alertSource);
    const target = getAlertTarget(alert);
    const machine = resolveMachineName(alert);
    const normalizedDecisions = decisions.map((decision) => ({
      ...decision,
      simulated: normalizeDecisionSimulated(decision, alert),
    }));
    const enrichedAlert: AlertRecord = {
      ...alert,
      decisions: normalizedDecisions,
      target,
      simulated: isAlertSimulated({
        ...alert,
        decisions: normalizedDecisions,
      }),
    };

    const alertData: AlertInsertParams = {
      $id: alert.id,
      $uuid: alert.uuid || String(alert.id),
      $created_at: alert.created_at,
      $scenario: alert.scenario,
      $source_ip: sourceValue,
      $message: alert.message || '',
      $raw_data: JSON.stringify(enrichedAlert),
    };

    try {
      database.insertAlert(alertData);
    } catch (error: any) {
      if (!String(error.message).includes('UNIQUE constraint')) {
        console.error(`Failed to insert alert ${alert.id}:`, error.message);
      }
    }

    for (const decision of normalizedDecisions) {
      const createdAt = decision.created_at || alert.created_at;
      const stopAt = decision.duration
        ? new Date(Date.now() + parseGoDuration(decision.duration)).toISOString()
        : decision.stop_at || createdAt;

      const enrichedDecision = {
        ...decision,
        created_at: createdAt,
        stop_at: stopAt,
        scenario: decision.scenario || alert.scenario || 'unknown',
        origin: decision.origin || decision.scenario || alert.scenario || 'unknown',
        alert_id: alert.id,
        value: decision.value || sourceValue,
        type: decision.type || 'ban',
        country: alertSource?.cn,
        as: alertSource?.as_name,
        machine,
        target,
        simulated: decision.simulated === true,
        is_duplicate: false,
      };

      const decisionData: DecisionInsertParams = {
        $id: String(decision.id),
        $uuid: String(decision.id),
        $alert_id: alert.id,
        $created_at: createdAt,
        $stop_at: stopAt,
        $value: enrichedDecision.value,
        $type: decision.type,
        $origin: enrichedDecision.origin,
        $scenario: enrichedDecision.scenario,
        $raw_data: JSON.stringify(enrichedDecision),
      };

      try {
        database.insertDecision(decisionData);
      } catch (error: any) {
        console.error(`Failed to insert decision ${decision.id}:`, error.message);
      }
    }
  }

  async function syncHistory(): Promise<number> {
    const showOverlay = isFirstSync;
    isFirstSync = false;
    console.log('Starting historical data sync...');

    updateSyncStatus({
      isSyncing: showOverlay,
      progress: 0,
      message: 'Starting historical data sync...',
      startedAt: new Date().toISOString(),
      completedAt: null,
    });

    const now = Date.now();
    const lookbackStart = now - config.lookbackMs;
    const chunkSizeMs = 6 * 60 * 60 * 1_000;
    const totalDuration = now - lookbackStart;
    let currentStart = lookbackStart;
    let totalAlerts = 0;

    while (currentStart < now) {
      const currentEnd = Math.min(currentStart + chunkSizeMs, now);
      const progress = Math.round(((currentEnd - lookbackStart) / totalDuration) * 100);
      const sinceDuration = toDuration(currentStart);
      const untilDuration = toDuration(currentEnd);
      const progressMessage = `Syncing: ${sinceDuration} -> ${untilDuration} ago (${totalAlerts} alerts)`;

      updateSyncStatus({
        progress: Math.min(progress, 90),
        message: `Syncing: ${sinceDuration} -> ${untilDuration} ago (${totalAlerts} alerts)`,
      });
      console.log(progressMessage);

      try {
        const alerts = await fetchAlertsForSync(sinceDuration, untilDuration);
        if (alerts.length > 0) {
          const insertTransaction = database.transaction<AlertRecord[]>((items) => {
            for (const alert of items) {
              processAlertForDatabase(alert);
            }
          });
          insertTransaction(alerts);
          totalAlerts += alerts.length;
          console.log(`  -> Imported ${alerts.length} alerts.`);
        }
      } catch (error: any) {
        console.error('Failed to sync chunk:', error.message);
      }

      currentStart = currentEnd;
      await delay(100);
    }

    updateSyncStatus({ progress: 95, message: 'Syncing active decisions...' });
    try {
      const activeDecisionAlerts = await fetchAlertsForSync(null, null, true);
      if (activeDecisionAlerts.length > 0) {
        const refreshTransaction = database.transaction<AlertRecord[]>((alerts) => {
          for (const alert of alerts) {
            processAlertForDatabase(alert);
          }
        });
        refreshTransaction(activeDecisionAlerts);
        console.log(`  -> Synced ${activeDecisionAlerts.length} alerts with active decisions.`);
      }
    } catch (error: any) {
      console.error('Failed to sync active decisions:', error.message);
    }

    updateSyncStatus({
      isSyncing: false,
      progress: 100,
      message: `Sync complete. ${totalAlerts} alerts imported.`,
      completedAt: new Date().toISOString(),
    });
    console.log(`Historical sync complete. Total imported: ${totalAlerts}`);

    return totalAlerts;
  }

  async function initializeCache(): Promise<boolean> {
    if (initializationPromise) {
      console.log('Cache initialization already in progress, waiting...');
      return initializationPromise;
    }

    initializationPromise = (async () => {
      try {
        console.log('Initializing cache with chunked data load...');
        await syncHistory();
        cache.lastUpdate = new Date().toISOString();
        cache.isInitialized = true;
        lapiClient.updateStatus(true);
        await runNotificationEvaluation('cache initialization');
        console.log(`Cache initialized successfully:
  Alerts: ${database.countAlerts()}
  Refresh Interval: ${getIntervalName(refreshIntervalMs)}
`);
        return true;
      } catch (error: any) {
        cache.isInitialized = false;
        lapiClient.updateStatus(false, error);
        console.error('Failed to initialize cache:', error.message);
        updateSyncStatus({
          isSyncing: false,
          progress: 0,
          message: `Sync failed: ${error.message}`,
          completedAt: new Date().toISOString(),
        });
        return false;
      } finally {
        initializationPromise = null;
      }
    })();

    return initializationPromise;
  }

  async function updateCacheDelta(): Promise<void> {
    if (!cache.isInitialized || !cache.lastUpdate) {
      console.log('Cache not initialized, performing full load...');
      await ensureBootstrapReady('delta update full load');
      return;
    }

    try {
      const diffSeconds = Math.ceil((Date.now() - new Date(cache.lastUpdate).getTime()) / 1_000) + 10;
      const sinceDuration = `${diffSeconds}s`;
      console.log(`Fetching delta updates (since: ${sinceDuration})...`);
      const [newAlerts, activeDecisionAlerts] = await Promise.all([
        fetchAlertsForSync(sinceDuration, null),
        fetchAlertsForSync(null, null, true),
      ]);

      if (newAlerts.length > 0) {
        const insertTransaction = database.transaction<AlertRecord[]>((alerts) => {
          for (const alert of alerts) {
            processAlertForDatabase(alert);
          }
        });
        insertTransaction(newAlerts);
        console.log(`Delta update: ${newAlerts.length} new alerts`);
      }

      if (activeDecisionAlerts.length > 0) {
        const refreshTransaction = database.transaction<AlertRecord[]>((alerts) => {
          for (const alert of alerts) {
            for (const decision of alert.decisions || []) {
              const createdAt = decision.created_at || alert.created_at;
              const stopAt = decision.duration
                ? new Date(Date.now() + parseGoDuration(decision.duration)).toISOString()
                : decision.stop_at || createdAt;

              const alertSource = alert.source || null;
              const sourceValue = getAlertSourceValue(alertSource);
              const machine = resolveMachineName(alert);
              const enrichedDecision = {
                ...decision,
                created_at: createdAt,
                stop_at: stopAt,
                scenario: decision.scenario || alert.scenario || 'unknown',
                origin: decision.origin || decision.scenario || alert.scenario || 'unknown',
                alert_id: alert.id,
                value: decision.value || sourceValue,
                type: decision.type || 'ban',
                country: alertSource?.cn,
                as: alertSource?.as_name,
                machine,
                target: getAlertTarget(alert),
                simulated: normalizeDecisionSimulated(decision, alert),
              };

              database.updateDecision({
                $id: String(decision.id),
                $stop_at: stopAt,
                $raw_data: JSON.stringify(enrichedDecision),
              });
            }
          }
        });
        refreshTransaction(activeDecisionAlerts);
      }

      cache.lastUpdate = new Date().toISOString();
      lapiClient.updateStatus(true);
      console.log(`Delta update complete: ${newAlerts.length} alerts, ${activeDecisionAlerts.length} active decision alerts refreshed`);
    } catch (error: any) {
      console.error('Failed to update cache delta:', error.message);
      lapiClient.updateStatus(false, error);
    }
  }

  function cleanupOldData(): void {
    const cutoff = new Date(Date.now() - config.lookbackMs).toISOString();
    try {
      const removedAlerts = database.deleteOldAlerts(cutoff);
      const removedDecisions = database.deleteOldDecisions(cutoff);
      console.log(`Cleanup: Removed ${removedAlerts} old alerts, ${removedDecisions} old decisions`);
    } catch (error: any) {
      console.error('Cleanup failed:', error.message);
    }
  }

  async function updateCache(): Promise<void> {
    await updateCacheDelta();
    cleanupOldData();
    await runNotificationEvaluation('cache update');
  }

  function clearBootstrapRetryTimeout(): void {
    if (bootstrapRetryTimeout) {
      clearTimeout(bootstrapRetryTimeout);
      bootstrapRetryTimeout = null;
    }
  }

  function finalizeBootstrapRecovery(): void {
    clearBootstrapRetryTimeout();
    bootstrapWaitLogged = false;
    if (refreshIntervalMs > 0 && !isSchedulerRunning) {
      console.log('Bootstrap recovery completed. Starting background refresh scheduler.');
      startRefreshScheduler();
    }
  }

  function scheduleBootstrapRetry(reason = 'retry requested'): void {
    if (!lapiClient.hasAuthConfig() || !config.bootstrapRetryEnabled || cache.isInitialized || bootstrapRetryTimeout) {
      return;
    }

    console.log(`Bootstrap recovery will retry in ${getIntervalName(config.bootstrapRetryDelayMs)}: ${reason}.`);
    bootstrapRetryTimeout = setTimeout(() => {
      bootstrapRetryTimeout = null;
      void ensureBootstrapReady('bootstrap retry');
    }, config.bootstrapRetryDelayMs);
  }

  async function ensureBootstrapReady(source = 'bootstrap'): Promise<boolean> {
    if (!lapiClient.hasAuthConfig()) {
      return false;
    }

    if (cache.isInitialized) {
      finalizeBootstrapRecovery();
      return true;
    }

    if (bootstrapPromise) {
      console.log(`Bootstrap recovery already in progress, waiting (${source})...`);
      return bootstrapPromise;
    }

    bootstrapPromise = (async () => {
      console.log(`Starting bootstrap recovery (${source})...`);
      if (!lapiClient.hasToken()) {
        const loginSuccess = await lapiClient.login(`bootstrap: ${source}`);
        if (!loginSuccess) {
          scheduleBootstrapRetry(`authentication failed during ${source}`);
          return false;
        }
      }

      const initialized = await initializeCache();
      if (initialized) {
        finalizeBootstrapRecovery();
        console.log(`Bootstrap recovery completed successfully (${source}).`);
        return true;
      }

      console.error(`Bootstrap recovery could not initialize the cache (${source}).`);
      scheduleBootstrapRetry(`cache initialization failed during ${source}`);
      return false;
    })();

    try {
      return await bootstrapPromise;
    } finally {
      bootstrapPromise = null;
    }
  }

  async function runSchedulerLoop(): Promise<void> {
    if (!isSchedulerRunning) return;

    const now = Date.now();
    const isIdle = now - lastRequestTime > config.idleThresholdMs;
    const doFullRefresh =
      !isIdle &&
      config.fullRefreshIntervalMs > 0 &&
      now - lastFullRefreshTime > config.fullRefreshIntervalMs;

    try {
      if (!cache.isInitialized) {
        if (!bootstrapWaitLogged) {
          bootstrapWaitLogged = true;
          console.log('Background refresh is waiting for bootstrap recovery to complete.');
        }
        scheduleBootstrapRetry('scheduler waiting for bootstrap');
      } else if (doFullRefresh) {
        console.log(`Triggering FULL refresh (last full: ${Math.round((now - lastFullRefreshTime) / 1000)}s ago)...`);
        await initializeCache();
        if (cache.isInitialized) {
          finalizeBootstrapRecovery();
          console.log('Full refresh completed.');
        }
        lastFullRefreshTime = Date.now();
      } else {
        console.log(`Background refresh triggered (${isIdle ? 'IDLE' : 'ACTIVE'})...`);
        await updateCache();
      }
    } catch (error) {
      console.error('Scheduler update failed:', error);
    }

    if (!isSchedulerRunning) return;

    const currentIdle = Date.now() - lastRequestTime > config.idleThresholdMs;
    let nextInterval = refreshIntervalMs;

    if (nextInterval > 0 && currentIdle && nextInterval < config.idleRefreshIntervalMs) {
      nextInterval = config.idleRefreshIntervalMs;
      console.log(`Idle mode active. Next refresh in ${getIntervalName(nextInterval)}.`);
    }

    if (nextInterval <= 0) {
      console.log('Scheduler in manual mode. Stopping loop.');
      isSchedulerRunning = false;
      return;
    }

    schedulerTimeout = setTimeout(() => {
      void runSchedulerLoop();
    }, nextInterval);
  }

  function startRefreshScheduler(): void {
    stopRefreshScheduler(false);
    if (refreshIntervalMs <= 0) {
      console.log('Manual refresh mode - cache will update on each request');
      return;
    }

    console.log(`Starting smart scheduler (active: ${getIntervalName(refreshIntervalMs)}, idle: ${getIntervalName(config.idleRefreshIntervalMs)})...`);
    isSchedulerRunning = true;
    schedulerTimeout = setTimeout(() => {
      void runSchedulerLoop();
    }, refreshIntervalMs);
  }

  function stopRefreshScheduler(logStop = true): void {
    if (logStop && (isSchedulerRunning || schedulerTimeout || bootstrapRetryTimeout)) {
      console.log('Stopping refresh scheduler...');
    }
    isSchedulerRunning = false;
    if (schedulerTimeout) {
      clearTimeout(schedulerTimeout);
      schedulerTimeout = null;
    }
    if (bootstrapRetryTimeout) {
      clearTimeout(bootstrapRetryTimeout);
      bootstrapRetryTimeout = null;
    }
  }

  async function activityTrackerMiddleware(context: HonoContext, next: HonoNext): Promise<void> {
    const now = Date.now();
    const wasIdle = now - lastRequestTime > config.idleThresholdMs;
    lastRequestTime = now;

    if (wasIdle && isSchedulerRunning) {
      console.log('System waking up from idle mode. Triggering immediate refresh...');
      if (schedulerTimeout) {
        clearTimeout(schedulerTimeout);
      }
      void runSchedulerLoop();
    }

    await next();
  }

  async function ensureAuth(context: HonoContext, next: HonoNext): Promise<Response | void> {
    if (!lapiClient.hasToken()) {
      const success = await lapiClient.login('request authentication');
      if (!success) {
        return context.json({ error: 'Failed to authenticate with CrowdSec LAPI' }, 502);
      }

      if (!cache.isInitialized) {
        void ensureBootstrapReady('post-auth recovery');
      }
    }

    await next();
  }

  function normalizeDeleteIds(ids: Array<string | number> | undefined): string[] {
    if (!Array.isArray(ids)) {
      return [];
    }

    return Array.from(
      new Set(
        ids
          .map((id) => String(id).trim())
          .filter((id) => /^\d+$/.test(id)),
      ),
    );
  }

  function isValidIpOrRange(value: string): boolean {
    return IPV4_RE.test(value) || IPV6_RE.test(value);
  }

  function isPermissionError(error: AnyError): boolean {
    return error.response?.status === 403;
  }

  function toFailure(kind: 'alert' | 'decision', id: string, error: AnyError): BulkDeleteFailure {
    return {
      kind,
      id,
      error: error.message || 'Delete failed',
    };
  }

  function getCachedAlertsForDeletion(): CachedAlertRecord[] {
    const since = new Date(Date.now() - config.lookbackMs).toISOString();
    return database.getAlertsSince(since).flatMap((row) => {
      try {
        const alert = JSON.parse(row.raw_data) as AlertRecord;
        if (!alert?.id) {
          return [];
        }

        return [{
          id: String(alert.id),
          sourceValue: getAlertSourceValue(alert.source),
          raw_data: row.raw_data,
        }];
      } catch {
        return [];
      }
    });
  }

  function getCachedDecisionsForDeletion(): CachedDecisionRecord[] {
    const since = new Date(Date.now() - config.lookbackMs).toISOString();
    const now = new Date().toISOString();
    return database.getDecisionsSince(since, now).flatMap((row) => {
      try {
        const decision = JSON.parse(row.raw_data) as { id?: string | number; value?: string };
        if (decision.id === undefined || decision.id === null) {
          return [];
        }

        return [{
          id: String(decision.id),
          value: typeof decision.value === 'string' ? decision.value : undefined,
          raw_data: row.raw_data,
        }];
      } catch {
        return [];
      }
    });
  }

  function createDeleteResult(overrides: Partial<BulkDeleteResult> = {}): BulkDeleteResult {
    return {
      requested_alerts: 0,
      requested_decisions: 0,
      deleted_alerts: 0,
      deleted_decisions: 0,
      failed: [],
      ...overrides,
    };
  }

  async function deleteAlertsByIds(ids: string[]): Promise<BulkDeleteResult> {
    const result = createDeleteResult({ requested_alerts: ids.length });
    const deletedAlertIds: string[] = [];
    const deletedDecisionIds = new Set<string>();
    const alertMap = new Map(getCachedAlertsForDeletion().map((alert) => [alert.id, alert]));

    for (const id of ids) {
      try {
        await lapiClient.deleteAlert(id);
        deletedAlertIds.push(id);

        const alert = alertMap.get(id);
        if (alert) {
          try {
            const parsedAlert = JSON.parse(alert.raw_data) as AlertRecord;
            for (const decision of parsedAlert.decisions || []) {
              if (decision?.id !== undefined && decision?.id !== null) {
                deletedDecisionIds.add(String(decision.id));
              }
            }
          } catch {
            // Ignore cache parse issues and still remove the alert row itself.
          }
        }
      } catch (error) {
        const typedError = error as AnyError;
        if (isPermissionError(typedError)) {
          throw typedError;
        }
        result.failed.push(toFailure('alert', id, typedError));
      }
    }

    if (deletedAlertIds.length > 0) {
      const removeAlerts = database.transaction<string[]>((alertIds) => {
        for (const id of alertIds) {
          database.deleteAlert(id);
          database.deleteDecisionsByAlertId(id);
        }
      });
      removeAlerts(deletedAlertIds);
    }

    result.deleted_alerts = deletedAlertIds.length;
    result.deleted_decisions = deletedDecisionIds.size;
    return result;
  }

  async function deleteDecisionsByIds(ids: string[]): Promise<BulkDeleteResult> {
    const result = createDeleteResult({ requested_decisions: ids.length });
    const deletedDecisionIds: string[] = [];

    for (const id of ids) {
      try {
        await lapiClient.deleteDecision(id);
        deletedDecisionIds.push(id);
      } catch (error) {
        const typedError = error as AnyError;
        if (isPermissionError(typedError)) {
          throw typedError;
        }
        result.failed.push(toFailure('decision', id, typedError));
      }
    }

    if (deletedDecisionIds.length > 0) {
      const removeDecisions = database.transaction<string[]>((decisionIds) => {
        for (const id of decisionIds) {
          database.deleteDecision(id);
        }
      });
      removeDecisions(deletedDecisionIds);
    }

    result.deleted_decisions = deletedDecisionIds.length;
    return result;
  }

  async function deleteEntriesByIp(ip: string): Promise<BulkDeleteResult> {
    const alerts = getCachedAlertsForDeletion().filter((alert) => alert.sourceValue === ip);
    const decisions = getCachedDecisionsForDeletion().filter((decision) => decision.value === ip);
    const result = createDeleteResult({
      requested_alerts: alerts.length,
      requested_decisions: decisions.length,
      ip,
    });
    const deletedAlertIds: string[] = [];
    const alertDecisionIds = new Set<string>();
    const deletedDecisionIds = new Set<string>();

    for (const alert of alerts) {
      try {
        await lapiClient.deleteAlert(alert.id);
        deletedAlertIds.push(alert.id);

        try {
          const parsedAlert = JSON.parse(alert.raw_data) as AlertRecord;
          for (const decision of parsedAlert.decisions || []) {
            if (decision?.id !== undefined && decision?.id !== null) {
              const decisionId = String(decision.id);
              alertDecisionIds.add(decisionId);
              deletedDecisionIds.add(decisionId);
            }
          }
        } catch {
          // Keep going even if cache payload is malformed.
        }
      } catch (error) {
        const typedError = error as AnyError;
        if (isPermissionError(typedError)) {
          throw typedError;
        }
        result.failed.push(toFailure('alert', alert.id, typedError));
      }
    }

    for (const decision of decisions) {
      if (deletedDecisionIds.has(decision.id)) {
        continue;
      }

      try {
        await lapiClient.deleteDecision(decision.id);
        deletedDecisionIds.add(decision.id);
      } catch (error) {
        const typedError = error as AnyError;
        if (isPermissionError(typedError)) {
          throw typedError;
        }
        result.failed.push(toFailure('decision', decision.id, typedError));
      }
    }

    if (deletedAlertIds.length > 0) {
      const removeAlerts = database.transaction<string[]>((alertIds) => {
        for (const id of alertIds) {
          database.deleteAlert(id);
          database.deleteDecisionsByAlertId(id);
        }
      });
      removeAlerts(deletedAlertIds);
    }

    const decisionIdsToDelete = Array.from(deletedDecisionIds).filter((id) => !alertDecisionIds.has(id));
    if (decisionIdsToDelete.length > 0) {
      const removeDecisions = database.transaction<string[]>((decisionIds) => {
        for (const id of decisionIds) {
          database.deleteDecision(id);
        }
      });
      removeDecisions(decisionIdsToDelete);
    }

    result.deleted_alerts = deletedAlertIds.length;
    result.deleted_decisions = deletedDecisionIds.size;
    return result;
  }

  async function handleApiError(
    error: AnyError,
    context: HonoContext,
    action: string,
    replayCallback: (() => Promise<Response>) | null,
  ): Promise<Response> {
    if (error.response?.status === 401) {
      console.log(`Received 401 during ${action}, attempting re-login...`);
      const success = await lapiClient.login(`401 recovery: ${action}`);
      if (success && replayCallback) {
        try {
          return await replayCallback();
        } catch (retryError) {
          console.error(`Retry failed for ${action}: ${(retryError as AnyError).message}`);
          error = retryError as AnyError;
        }
      }
    }

    if (error.response) {
      console.error(`Error ${action}: ${error.response.status}`);
      return context.json({ error: `Request failed with status ${error.response.status}` }, error.response.status);
    }
    if (error.request) {
      console.error(`Error ${action}: No response received`);
      return context.json({ error: 'Bad Gateway: No response from CrowdSec LAPI' }, 502);
    }
    console.error(`Error ${action}: ${error.message}`);
    return context.json({ error: 'Internal server error' }, 500);
  }

  function hydrateAlertWithDecisions(alert: AlertRecord): AlertRecord {
    const clone: AlertRecord = { ...alert };
    const decisions = Array.isArray(clone.decisions) ? clone.decisions : [];

    clone.decisions = decisions.map((decision) => {
      const databaseDecision = database.getDecisionById(decision.id);
      const now = new Date();
      const stopAt = databaseDecision?.stop_at
        ? new Date(databaseDecision.stop_at)
        : decision.stop_at
          ? new Date(decision.stop_at)
          : null;
      const isExpired = !stopAt || stopAt < now;

      let duration = decision.duration;
      if (stopAt && !isExpired) {
        const remainingMs = stopAt.getTime() - now.getTime();
        const hours = Math.floor(remainingMs / 3_600_000);
        const minutes = Math.floor((remainingMs % 3_600_000) / 60_000);
        const seconds = Math.floor((remainingMs % 60_000) / 1_000);
        duration = `${hours > 0 ? `${hours}h` : ''}${minutes > 0 || hours > 0 ? `${minutes}m` : ''}${seconds}s`;
      } else if (isExpired) {
        duration = '0s';
      }

      return {
        ...decision,
        stop_at: stopAt ? stopAt.toISOString() : decision.stop_at,
        duration,
        expired: isExpired,
        simulated: normalizeDecisionSimulated(decision, clone),
      };
    });

    clone.reason = resolveAlertReason(clone);
    clone.scenario = resolveAlertScenario(clone);
    clone.simulated = isAlertSimulated(clone);

    return clone;
  }

  function normalizeAlertDetail(input: unknown, alertId: string): AlertRecord | null {
    if (Array.isArray(input)) {
      const matchingAlert = input.find((candidate) => String((candidate as AlertRecord | undefined)?.id) === alertId);
      const alert = matchingAlert ?? input[0];
      return alert ? (alert as AlertRecord) : null;
    }

    if (input && typeof input === 'object') {
      return input as AlertRecord;
    }

    return null;
  }

  if (options.startBackgroundTasks) {
    startBackgroundTasks();
  }

  return {
    app,
    fetch: app.fetch,
    config,
    database,
    lapiClient,
    startBackgroundTasks,
    stopBackgroundTasks: () => stopRefreshScheduler(),
    getSyncStatus: () => ({ ...syncStatus }),
    getLapiStatus: () => lapiClient.getStatus(),
  };

  function startBackgroundTasks(): void {
    if (!lapiClient.hasAuthConfig()) {
      console.warn('Cache initialization skipped - CrowdSec LAPI authentication not configured');
      return;
    }
    startRefreshScheduler();
    void ensureBootstrapReady('startup');
  }

  function isMachineFeatureEnabled(): boolean {
    if (config.alwaysShowMachine) {
      return true;
    }

    const since = new Date(Date.now() - config.lookbackMs).toISOString();
    const machineIds = new Set<string>();

    for (const row of database.getAlertsSince(since)) {
      try {
        const alert = JSON.parse(row.raw_data) as AlertRecord;
        const machineId = normalizeMachineId(alert.machine_id);
        if (!machineId) continue;

        machineIds.add(machineId);
        if (machineIds.size > 1) {
          return true;
        }
      } catch (error) {
        console.error('Failed to parse cached alert while evaluating machine visibility:', error);
      }
    }

    return false;
  }
}

function loadPersistedConfig(database: CrowdsecDatabase): PersistedConfig {
  try {
    const row = database.getMeta('refresh_interval_ms');
    if (row?.value !== undefined) {
      const config = { refresh_interval_ms: Number.parseInt(row.value, 10) };
      console.log('Loaded persisted config from database:', config);
      return config;
    }
  } catch (error) {
    console.error('Error loading config from database:', error);
  }

  return {};
}

function savePersistedConfig(database: CrowdsecDatabase, config: PersistedConfig): void {
  try {
    if (config.refresh_interval_ms !== undefined) {
      database.setMeta('refresh_interval_ms', String(config.refresh_interval_ms));
    }
    console.log('Saved config to database:', config);
  } catch (error) {
    console.error('Error saving config to database:', error);
  }
}

function resolveNotificationSecretKey(database: CrowdsecDatabase, configuredKey?: string): string {
  const trimmedConfiguredKey = configuredKey?.trim();
  if (trimmedConfiguredKey) {
    return trimmedConfiguredKey;
  }

  const persisted = database.getMeta(NOTIFICATION_SECRET_KEY_META_KEY)?.value?.trim();
  if (persisted) {
    return persisted;
  }

  const generated = crypto.randomBytes(32).toString('base64url');
  database.setMeta(NOTIFICATION_SECRET_KEY_META_KEY, generated);
  console.log('Generated a notification encryption key and stored it in application metadata.');
  return generated;
}

function lookbackHours(duration: string): number {
  const match = duration.match(/^(\d+)([hmd])$/);
  if (!match) return 168;
  const value = Number.parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 'h') return value;
  if (unit === 'd') return value * 24;
  return value / 60;
}

function parseSimulationBoolean(value: unknown): boolean | null {
  if (value === true || value === false) {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return null;
}

function hasSimulationMarker(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.startsWith('(simul)') || normalized.includes('simulated');
}

function normalizeAlertSimulated(alert: Pick<AlertRecord, 'simulated'> | null | undefined): boolean {
  const explicit = parseSimulationBoolean(alert?.simulated);
  if (explicit !== null) {
    return explicit;
  }

  return false;
}

function normalizeDecisionSimulated(
  decision: Pick<AlertDecision, 'simulated'> | (AlertDecision & Record<string, unknown>),
  alert?: Pick<AlertRecord, 'simulated'> | null,
): boolean {
  const explicit = parseSimulationBoolean(decision.simulated);
  if (explicit !== null) {
    return explicit;
  }

  if (
    hasSimulationMarker((decision as Record<string, unknown>).type) ||
    hasSimulationMarker((decision as Record<string, unknown>).action) ||
    hasSimulationMarker((decision as Record<string, unknown>).decisions)
  ) {
    return true;
  }

  return normalizeAlertSimulated(alert);
}

function isAlertSimulated(alert: AlertRecord): boolean {
  if (normalizeAlertSimulated(alert)) {
    return true;
  }

  return Array.isArray(alert.decisions) &&
    alert.decisions.length > 0 &&
    alert.decisions.every((decision) => normalizeDecisionSimulated(decision, alert));
}

function applySimulationModeToAlert(alert: AlertRecord, simulationsEnabled: boolean): AlertRecord | null {
  const alertWithSimulation: AlertRecord = {
    ...alert,
    decisions: Array.isArray(alert.decisions)
      ? alert.decisions.map((decision) => ({
          ...decision,
          simulated: normalizeDecisionSimulated(decision, alert),
        }))
      : [],
    simulated: isAlertSimulated(alert),
  };

  if (!simulationsEnabled && alertWithSimulation.simulated) {
    return null;
  }

  if (!simulationsEnabled) {
    alertWithSimulation.decisions = (alertWithSimulation.decisions || []).filter((decision) => !decision.simulated);
  }

  return alertWithSimulation;
}

function toDecisionListItem(
  decision: AlertDecision & Record<string, unknown>,
  includeExpired: boolean,
): DecisionListItem {
  const expired = includeExpired
    ? Boolean(decision.stop_at && new Date(String(decision.stop_at)) < new Date())
    : false;

  return {
    id: decision.id,
    created_at: String(decision.created_at || ''),
    machine: typeof decision.machine === 'string' ? decision.machine : undefined,
    scenario: typeof decision.scenario === 'string' ? decision.scenario : undefined,
    value: typeof decision.value === 'string' ? decision.value : undefined,
    expired,
    is_duplicate: decision.is_duplicate === true,
    simulated: normalizeDecisionSimulated(decision),
    detail: {
      origin: typeof decision.origin === 'string' ? decision.origin : 'manual',
      type: typeof decision.type === 'string' ? decision.type : undefined,
      reason: typeof decision.scenario === 'string' ? decision.scenario : undefined,
      action: typeof decision.type === 'string' ? decision.type : undefined,
      country: typeof decision.country === 'string' ? decision.country : 'Unknown',
      as: typeof decision.as === 'string' ? decision.as : 'Unknown',
      events_count: typeof decision.events_count === 'number' ? decision.events_count : 0,
      duration: typeof decision.duration === 'string' ? decision.duration : 'N/A',
      expiration: typeof decision.stop_at === 'string' ? decision.stop_at : undefined,
      alert_id: decision.alert_id as string | number | undefined,
      target: typeof decision.target === 'string' ? decision.target : null,
      simulated: normalizeDecisionSimulated(decision),
    },
  };
}

function markDuplicateDecisions(decisions: DecisionListItem[]): DecisionListItem[] {
  const primaryMap = new Map<string | undefined, number>();

  for (const decision of decisions) {
    if (decision.expired) continue;
    const key = `${decision.value ?? ''}|${decision.simulated === true ? 'simulated' : 'live'}`;
    const numericId = getNumericDecisionId(decision.id);
    const current = primaryMap.get(key);
    if (current === undefined || numericId < current) {
      primaryMap.set(key, numericId);
    }
  }

  return decisions.map((decision) => {
    if (decision.expired) {
      return { ...decision, is_duplicate: false };
    }

    const primaryId = primaryMap.get(`${decision.value ?? ''}|${decision.simulated === true ? 'simulated' : 'live'}`);
    return {
      ...decision,
      is_duplicate: getNumericDecisionId(decision.id) !== primaryId,
    };
  });
}

function getNumericDecisionId(id: string | number): number {
  const value = String(id);
  if (value.startsWith('dup_')) {
    return Number.POSITIVE_INFINITY;
  }
  const numeric = Number.parseInt(value, 10);
  return Number.isNaN(numeric) ? Number.POSITIVE_INFINITY : numeric;
}
