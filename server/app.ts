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
  DashboardGranularity,
  DashboardSimulationFilter,
  DashboardStatListItem,
  DashboardStatsBucket,
  DashboardStatsResponse,
  DashboardStatsTotals,
  DashboardWorldMapDatum,
  DecisionListItem,
  LapiStatus,
  PaginatedResponse,
  SlimAlert,
  StatsAlert,
  StatsDecision,
  SyncStatus,
  UpsertNotificationChannelRequest,
  UpsertNotificationRuleRequest,
  UpdateCheckResponse,
} from '../shared/contracts';
import { normalizeMachineId, resolveMachineName } from '../shared/machine';
import { collectDistinctOrigins, normalizeOrigin } from '../shared/origin';
import { compileAlertSearch, compileDecisionSearch, type SearchParseError } from '../shared/search';
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

interface PageRequest {
  page: number;
  pageSize: number;
}

interface AlertListFilters {
  q: string;
  ip: string;
  country: string;
  scenario: string;
  as: string;
  date: string;
  dateStart: string;
  dateEnd: string;
  target: string;
  simulation: string;
  timezoneOffsetMinutes: number;
}

interface DecisionListFilters {
  q: string;
  alertId: string;
  country: string;
  scenario: string;
  as: string;
  ip: string;
  target: string;
  dateStart: string;
  dateEnd: string;
  simulation: string;
  showDuplicates: boolean;
  timezoneOffsetMinutes: number;
}

interface DashboardStatsFilters {
  country: string;
  scenario: string;
  as: string;
  ip: string;
  target: string;
  dateStart: string;
  dateEnd: string;
  simulation: DashboardSimulationFilter;
  granularity: DashboardGranularity;
  timezoneOffsetMinutes: number;
}

interface DashboardStatsCache {
  key: string;
  alerts: DashboardAlertStatsRecord[];
  decisions: DashboardDecisionStatsRecord[];
  totals: DashboardStatsTotals;
}

interface DashboardAlertStatsRecord {
  createdAt: string;
  timestamp: number;
  country?: string;
  scenario?: string;
  asName?: string;
  ip?: string;
  target?: string;
  simulated: boolean;
}

interface DashboardDecisionStatsRecord {
  createdAt: string;
  stopAt?: string;
  timestamp: number;
  stopTimestamp: number;
  value?: string;
  simulated: boolean;
}

interface DashboardStatsAccumulator {
  alerts: number;
  liveAlerts: number;
  simulatedAlerts: number;
  countries: Map<string, { count: number; liveCount: number; simulatedCount: number }>;
  scenarios: Map<string, number>;
  asNames: Map<string, number>;
  targets: Map<string, number>;
  liveAlertBuckets: Map<string, number>;
  simulatedAlertBuckets: Map<string, number>;
}

interface DashboardDecisionAccumulator {
  decisions: number;
  simulatedDecisions: number;
  liveDecisionBuckets: Map<string, number>;
  simulatedDecisionBuckets: Map<string, number>;
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
  let dashboardStatsCache: DashboardStatsCache | null = null;

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
      const alerts = hydrateAlertsBatch(database.getAlertsSince(since))
        .map((alert) => applySimulationModeToAlert(alert, config.simulationsEnabled))
        .filter((alert): alert is AlertRecord => alert !== null)
        .map((alert) => toSlimAlert(alert))
        .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());

      const pageRequest = getPageRequest(context);
      if (pageRequest) {
        const filters = getAlertListFilters(context);
        const machineFeaturesEnabled = isMachineFeatureEnabled();
        const originFeaturesEnabled = isOriginFeatureEnabled();
        const compiledSearch = compileAlertSearch(filters.q, {
          machineEnabled: machineFeaturesEnabled,
          originEnabled: originFeaturesEnabled,
        });
        if (!compiledSearch.ok) {
          return context.json(toSearchErrorResponse(compiledSearch.error), 400);
        }
        const filteredAlerts = alerts.filter((alert) =>
          matchesAlertListFilters(alert, filters, machineFeaturesEnabled) &&
          compiledSearch.predicate(alert),
        );
        return context.json(toPaginatedResponse(
          filteredAlerts,
          pageRequest,
          alerts.length,
          filteredAlerts.map((alert) => alert.id),
        ));
      }

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
      dashboardStatsCache = null;
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

      let decisions = rows.map((row) => {
        const decision = JSON.parse(row.raw_data) as AlertDecision & Record<string, unknown>;
        if (decision.alert_id === undefined && row.alert_id !== undefined && row.alert_id !== null) {
          decision.alert_id = row.alert_id;
        }
        return toDecisionListItem(decision, includeExpired);
      });
      if (!config.simulationsEnabled) {
        decisions = decisions.filter((decision) => !decision.simulated);
      }
      decisions = markDuplicateDecisions(decisions);
      decisions.sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());

      const pageRequest = getPageRequest(context);
      if (pageRequest) {
        const filters = getDecisionListFilters(context);
        const machineFeaturesEnabled = isMachineFeatureEnabled();
        const originFeaturesEnabled = isOriginFeatureEnabled();
        const compiledSearch = compileDecisionSearch(filters.q, {
          machineEnabled: machineFeaturesEnabled,
          originEnabled: originFeaturesEnabled,
        });
        if (!compiledSearch.ok) {
          return context.json(toSearchErrorResponse(compiledSearch.error), 400);
        }
        const filteredDecisions = decisions.filter((decision) =>
          matchesDecisionListFilters(decision, filters, machineFeaturesEnabled) &&
          compiledSearch.predicate(decision),
        );
        return context.json(toPaginatedResponse(
          filteredDecisions,
          pageRequest,
          decisions.length,
          filteredDecisions
            .filter((decision) => !isDecisionListItemExpired(decision))
            .map((decision) => decision.id),
        ));
      }

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
      origin_features_enabled: isOriginFeatureEnabled(),
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
      dashboardStatsCache = null;
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
      const alerts = hydrateAlertsBatch(database.getAlertsSince(since))
        .map((hydratedAlert) => {
          const alert = applySimulationModeToAlert(
            hydratedAlert,
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

  app.get(`${config.basePath}/api/dashboard/stats`, ensureAuth, async (context) => {
    try {
      if (refreshIntervalMs === 0) {
        await updateCache();
      }

      if (!cache.isInitialized) {
        await ensureBootstrapReady('dashboard stats request');
      }

      return context.json(buildDashboardStats(getDashboardStatsFilters(context)));
    } catch (error: any) {
      console.error('Error serving dashboard statistics from database:', error.message);
      return context.json({ error: 'Failed to retrieve dashboard statistics' }, 500);
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
      dashboardStatsCache = null;
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

    const currentDecisionIds: string[] = [];
    for (const decision of normalizedDecisions) {
      currentDecisionIds.push(String(decision.id));
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

    database.deleteDecisionsByAlertIdExcept(alert.id, currentDecisionIds);
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
            processAlertForDatabase(alert);
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
      dashboardStatsCache = null;
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
      dashboardStatsCache = null;
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
      dashboardStatsCache = null;
    }

    const decisionIdsToDelete = Array.from(deletedDecisionIds).filter((id) => !alertDecisionIds.has(id));
    if (decisionIdsToDelete.length > 0) {
      const removeDecisions = database.transaction<string[]>((decisionIds) => {
        for (const id of decisionIds) {
          database.deleteDecision(id);
        }
      });
      removeDecisions(decisionIdsToDelete);
      dashboardStatsCache = null;
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

  function hydrateAlertWithDecisionsBatch(alert: AlertRecord, stopAtMap: Map<string, string>): AlertRecord {
    const clone: AlertRecord = { ...alert };
    const decisions = Array.isArray(clone.decisions) ? clone.decisions : [];

    clone.decisions = decisions.map((decision) => {
      const cachedStopAt = stopAtMap.get(String(decision.id));
      const now = new Date();
      const stopAt = cachedStopAt
        ? new Date(cachedStopAt)
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

  function hydrateAlertsBatch(rows: Array<{ raw_data: string }>): AlertRecord[] {
    const parsedAlerts = rows.map((row) => JSON.parse(row.raw_data) as AlertRecord);
    const decisionIds = parsedAlerts.flatMap((alert) =>
      (Array.isArray(alert.decisions) ? alert.decisions : []).map((decision) => String(decision.id)),
    );
    const stopAtMap = database.getDecisionStopAtBatch(decisionIds);
    return parsedAlerts.map((alert) => hydrateAlertWithDecisionsBatch(alert, stopAtMap));
  }

  function getDashboardStatsIndex(): DashboardStatsCache {
    const cacheKey = `${cache.lastUpdate || 'uninitialized'}:${config.lookbackMs}:${config.simulationsEnabled ? 'sim' : 'live'}`;
    if (dashboardStatsCache?.key === cacheKey) {
      return dashboardStatsCache;
    }

    const since = new Date(Date.now() - config.lookbackMs).toISOString();
    const nowIso = new Date().toISOString();
    const nowTimestamp = Date.now();

    const alerts = hydrateAlertsBatch(database.getAlertsSince(since))
      .map((hydratedAlert) => applySimulationModeToAlert(hydratedAlert, config.simulationsEnabled))
      .filter((alert): alert is AlertRecord => alert !== null)
      .flatMap((alert): DashboardAlertStatsRecord[] => {
        const timestamp = Date.parse(alert.created_at);
        if (!Number.isFinite(timestamp)) {
          return [];
        }

        return [{
          createdAt: alert.created_at,
          timestamp,
          country: alert.source?.cn,
          scenario: resolveAlertScenario(alert),
          asName: alert.source?.as_name,
          ip: alert.source?.ip,
          target: alert.target,
          simulated: isAlertSimulated(alert),
        }];
      });

    const decisions = database
      .getDecisionsSince(since, nowIso)
      .flatMap((row): DashboardDecisionStatsRecord[] => {
        try {
          const decision = JSON.parse(row.raw_data) as Record<string, unknown>;
          const createdAt = String(decision.created_at || row.created_at || '');
          const timestamp = Date.parse(createdAt);
          if (!Number.isFinite(timestamp)) {
            return [];
          }

          const stopAt = typeof decision.stop_at === 'string' ? decision.stop_at : undefined;
          const stopTimestamp = stopAt ? Date.parse(stopAt) : Number.NaN;
          return [{
            createdAt,
            stopAt,
            timestamp,
            stopTimestamp: Number.isFinite(stopTimestamp) ? stopTimestamp : 0,
            value: typeof decision.value === 'string' ? decision.value : undefined,
            simulated: normalizeDecisionSimulated(decision as AlertDecision & Record<string, unknown>),
          }];
        } catch {
          return [];
        }
      })
      .filter((decision) => config.simulationsEnabled || !decision.simulated);

    const totals: DashboardStatsTotals = {
      alerts: alerts.length,
      decisions: decisions.filter((decision) => !decision.simulated && decision.stopTimestamp > nowTimestamp).length,
      simulatedAlerts: alerts.filter((alert) => alert.simulated).length,
      simulatedDecisions: decisions.filter((decision) => decision.simulated && decision.stopTimestamp > nowTimestamp).length,
    };

    dashboardStatsCache = { key: cacheKey, alerts, decisions, totals };
    return dashboardStatsCache;
  }

  function buildDashboardStats(filters: DashboardStatsFilters): DashboardStatsResponse {
    const statsIndex = getDashboardStatsIndex();
    const nowTimestamp = Date.now();
    const lookbackDays = Math.max(1, Math.round(lookbackHours(config.lookbackPeriod) / 24));

    const filteredAlertAccumulator = createDashboardStatsAccumulator();
    const chartAlertAccumulator = createDashboardStatsAccumulator();
    const sliderAlertAccumulator = createDashboardStatsAccumulator();
    const filteredAlertIps = new Set<string>();
    const sliderAlertIps = new Set<string>();

    for (const alert of statsIndex.alerts) {
      if (!matchesDashboardSimulationFilter(alert.simulated, filters.simulation)) {
        continue;
      }

      if (matchesDashboardAlertFilters(alert, filters, false)) {
        addDashboardAlert(sliderAlertAccumulator, alert, filters);
        if (alert.ip) {
          sliderAlertIps.add(alert.ip);
        }
      }

      if (matchesDashboardAlertFilters(alert, filters, true)) {
        addDashboardAlert(filteredAlertAccumulator, alert, filters);
        addDashboardAlert(chartAlertAccumulator, alert, filters);
        if (alert.ip) {
          filteredAlertIps.add(alert.ip);
        }
      }
    }

    const filteredDecisionAccumulator = createDashboardDecisionAccumulator();
    const chartDecisionAccumulator = createDashboardDecisionAccumulator();
    const sliderDecisionAccumulator = createDashboardDecisionAccumulator();

    for (const decision of statsIndex.decisions) {
      if (!matchesDashboardSimulationFilter(decision.simulated, filters.simulation)) {
        continue;
      }

      if (matchesDashboardDecisionFilters(decision, filters, sliderAlertIps, false)) {
        addDashboardDecision(sliderDecisionAccumulator, decision, filters);
      }

      if (matchesDashboardDecisionFilters(decision, filters, filteredAlertIps, true)) {
        addDashboardDecision(chartDecisionAccumulator, decision, filters);
        if (decision.stopTimestamp > nowTimestamp) {
          if (decision.simulated) {
            filteredDecisionAccumulator.simulatedDecisions += 1;
          } else {
            filteredDecisionAccumulator.decisions += 1;
          }
        }
      }
    }

    return {
      totals: statsIndex.totals,
      filteredTotals: {
        alerts: filteredAlertAccumulator.alerts,
        decisions: filteredDecisionAccumulator.decisions,
        simulatedAlerts: filteredAlertAccumulator.simulatedAlerts,
        simulatedDecisions: filteredDecisionAccumulator.simulatedDecisions,
      },
      globalTotal: statsIndex.alerts.filter((alert) => matchesDashboardSimulationFilter(alert.simulated, filters.simulation)).length,
      topTargets: topDashboardEntries(filteredAlertAccumulator.targets),
      topCountries: dashboardCountryList(filteredAlertAccumulator.countries, 10),
      allCountries: dashboardWorldMapData(filteredAlertAccumulator.countries),
      topScenarios: topDashboardEntries(filteredAlertAccumulator.scenarios),
      topAS: topDashboardEntries(filteredAlertAccumulator.asNames),
      series: {
        alertsHistory: dashboardBuckets(chartAlertAccumulator.liveAlertBuckets, filters, lookbackDays),
        simulatedAlertsHistory: dashboardBuckets(chartAlertAccumulator.simulatedAlertBuckets, filters, lookbackDays),
        decisionsHistory: dashboardBuckets(chartDecisionAccumulator.liveDecisionBuckets, filters, lookbackDays),
        simulatedDecisionsHistory: dashboardBuckets(chartDecisionAccumulator.simulatedDecisionBuckets, filters, lookbackDays),
        unfilteredAlertsHistory: dashboardBuckets(sliderAlertAccumulator.liveAlertBuckets, filters, lookbackDays, true),
        unfilteredSimulatedAlertsHistory: dashboardBuckets(sliderAlertAccumulator.simulatedAlertBuckets, filters, lookbackDays, true),
        unfilteredDecisionsHistory: dashboardBuckets(sliderDecisionAccumulator.liveDecisionBuckets, filters, lookbackDays, true),
        unfilteredSimulatedDecisionsHistory: dashboardBuckets(sliderDecisionAccumulator.simulatedDecisionBuckets, filters, lookbackDays, true),
      },
    };
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

  function isOriginFeatureEnabled(): boolean {
    if (config.alwaysShowOrigin) {
      return true;
    }

    const since = new Date(Date.now() - config.lookbackMs).toISOString();
    const now = new Date().toISOString();
    const origins = new Set<string>();

    for (const row of database.getDecisionsSince(since, now)) {
      try {
        const decision = JSON.parse(row.raw_data) as AlertDecision;
        const origin = normalizeOrigin(decision.origin);
        if (!origin) continue;

        origins.add(origin);
        if (origins.size > 1) {
          return true;
        }
      } catch (error) {
        console.error('Failed to parse cached decision while evaluating origin visibility:', error);
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

function getPageRequest(context: HonoContext): PageRequest | null {
  if (!context.req.query('page')) {
    return null;
  }

  const page = Math.max(1, Number.parseInt(context.req.query('page') || '1', 10) || 1);
  const pageSize = Math.min(200, Math.max(10, Number.parseInt(context.req.query('page_size') || '50', 10) || 50));
  return { page, pageSize };
}

function toPaginatedResponse<T>(
  items: T[],
  pageRequest: PageRequest,
  unfilteredTotal: number,
  selectableIds: Array<string | number>,
): PaginatedResponse<T> {
  const offset = (pageRequest.page - 1) * pageRequest.pageSize;
  return {
    data: items.slice(offset, offset + pageRequest.pageSize),
    pagination: {
      page: pageRequest.page,
      page_size: pageRequest.pageSize,
      total: items.length,
      total_pages: Math.ceil(items.length / pageRequest.pageSize),
      unfiltered_total: unfilteredTotal,
    },
    selectable_ids: selectableIds,
  };
}

function getAlertListFilters(context: HonoContext): AlertListFilters {
  return {
    q: context.req.query('q') || '',
    ip: lowerQuery(context, 'ip'),
    country: lowerQuery(context, 'country'),
    scenario: lowerQuery(context, 'scenario'),
    as: lowerQuery(context, 'as'),
    date: context.req.query('date') || '',
    dateStart: context.req.query('dateStart') || '',
    dateEnd: context.req.query('dateEnd') || '',
    target: lowerQuery(context, 'target'),
    simulation: context.req.query('simulation') || 'all',
    timezoneOffsetMinutes: parseTimezoneOffset(context),
  };
}

function getDecisionListFilters(context: HonoContext): DecisionListFilters {
  const alertId = context.req.query('alert_id') || '';
  return {
    q: context.req.query('q') || '',
    alertId,
    country: context.req.query('country') || '',
    scenario: context.req.query('scenario') || '',
    as: context.req.query('as') || '',
    ip: context.req.query('ip') || '',
    target: lowerQuery(context, 'target'),
    dateStart: context.req.query('dateStart') || '',
    dateEnd: context.req.query('dateEnd') || '',
    simulation: context.req.query('simulation') || 'all',
    showDuplicates: context.req.query('hide_duplicates') === 'false' || Boolean(alertId),
    timezoneOffsetMinutes: parseTimezoneOffset(context),
  };
}

function getDashboardStatsFilters(context: HonoContext): DashboardStatsFilters {
  return {
    country: context.req.query('country') || '',
    scenario: context.req.query('scenario') || '',
    as: context.req.query('as') || '',
    ip: context.req.query('ip') || '',
    target: context.req.query('target') || '',
    dateStart: context.req.query('dateStart') || '',
    dateEnd: context.req.query('dateEnd') || '',
    simulation: parseDashboardSimulationFilter(context.req.query('simulation')),
    granularity: context.req.query('granularity') === 'hour' ? 'hour' : 'day',
    timezoneOffsetMinutes: parseTimezoneOffset(context),
  };
}

function parseDashboardSimulationFilter(value: string | undefined): DashboardSimulationFilter {
  if (value === 'live' || value === 'simulated') {
    return value;
  }

  return 'all';
}

function createDashboardStatsAccumulator(): DashboardStatsAccumulator {
  return {
    alerts: 0,
    liveAlerts: 0,
    simulatedAlerts: 0,
    countries: new Map(),
    scenarios: new Map(),
    asNames: new Map(),
    targets: new Map(),
    liveAlertBuckets: new Map(),
    simulatedAlertBuckets: new Map(),
  };
}

function createDashboardDecisionAccumulator(): DashboardDecisionAccumulator {
  return {
    decisions: 0,
    simulatedDecisions: 0,
    liveDecisionBuckets: new Map(),
    simulatedDecisionBuckets: new Map(),
  };
}

function matchesDashboardSimulationFilter(isSimulated: boolean, filter: DashboardSimulationFilter): boolean {
  return matchesSimulationFilter(isSimulated, filter);
}

function matchesDashboardAlertFilters(
  alert: DashboardAlertStatsRecord,
  filters: DashboardStatsFilters,
  includeDateRange: boolean,
): boolean {
  if (filters.country && alert.country !== filters.country) return false;
  if (filters.scenario && alert.scenario !== filters.scenario) return false;
  if (filters.as && alert.asName !== filters.as) return false;
  if (filters.ip && alert.ip !== filters.ip) return false;
  if (filters.target && alert.target !== filters.target) return false;

  if (includeDateRange && !matchesDashboardDateRange(alert.createdAt, filters)) {
    return false;
  }

  return true;
}

function matchesDashboardDecisionFilters(
  decision: DashboardDecisionStatsRecord,
  filters: DashboardStatsFilters,
  alertIps: Set<string>,
  includeDateRange: boolean,
): boolean {
  if (filters.ip && decision.value !== filters.ip) return false;

  if (requiresDashboardAlertIpJoin(filters) && (!decision.value || !alertIps.has(decision.value))) {
    return false;
  }

  if (includeDateRange && !matchesDashboardDateRange(decision.createdAt, filters)) {
    return false;
  }

  return true;
}

function requiresDashboardAlertIpJoin(filters: DashboardStatsFilters): boolean {
  return Boolean(filters.country || filters.scenario || filters.as || filters.target);
}

function matchesDashboardDateRange(isoString: string, filters: DashboardStatsFilters): boolean {
  if (!filters.dateStart && !filters.dateEnd) {
    return true;
  }

  const itemKey = getDateFilterKey(
    isoString,
    filters.granularity === 'hour' || filters.dateStart.includes('T') || filters.dateEnd.includes('T'),
    filters.timezoneOffsetMinutes,
  );

  if (filters.dateStart && itemKey < filters.dateStart) return false;
  if (filters.dateEnd && itemKey > filters.dateEnd) return false;
  return true;
}

function addDashboardAlert(accumulator: DashboardStatsAccumulator, alert: DashboardAlertStatsRecord, filters: DashboardStatsFilters): void {
  accumulator.alerts += 1;

  const bucketMap = alert.simulated ? accumulator.simulatedAlertBuckets : accumulator.liveAlertBuckets;
  incrementCount(bucketMap, getDashboardBucketKey(alert.createdAt, filters));

  if (alert.simulated) {
    accumulator.simulatedAlerts += 1;
  } else {
    accumulator.liveAlerts += 1;
  }

  if (alert.country && alert.country !== 'Unknown') {
    const current = accumulator.countries.get(alert.country) || { count: 0, liveCount: 0, simulatedCount: 0 };
    current.count += 1;
    if (alert.simulated) {
      current.simulatedCount += 1;
    } else {
      current.liveCount += 1;
    }
    accumulator.countries.set(alert.country, current);
  }

  if (alert.scenario) {
    incrementCount(accumulator.scenarios, alert.scenario);
  }

  if (alert.asName && alert.asName !== 'Unknown') {
    incrementCount(accumulator.asNames, alert.asName);
  }

  if (alert.target && alert.target !== 'Unknown' && alert.target !== 'N/A') {
    incrementCount(accumulator.targets, alert.target);
  }
}

function addDashboardDecision(accumulator: DashboardDecisionAccumulator, decision: DashboardDecisionStatsRecord, filters: DashboardStatsFilters): void {
  const bucketMap = decision.simulated ? accumulator.simulatedDecisionBuckets : accumulator.liveDecisionBuckets;
  incrementCount(bucketMap, getDashboardBucketKey(decision.createdAt, filters));
}

function incrementCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) || 0) + 1);
}

function topDashboardEntries(map: Map<string, number>, limit = 10): DashboardStatListItem[] {
  return Array.from(map.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

function dashboardCountryList(
  countries: DashboardStatsAccumulator['countries'],
  limit: number,
): DashboardStatListItem[] {
  return Array.from(countries.entries())
    .sort((left, right) => right[1].count - left[1].count)
    .slice(0, limit)
    .map(([code, summary]) => ({
      label: getCountryName(code) || code,
      value: code,
      count: summary.count,
      countryCode: code,
    }));
}

function dashboardWorldMapData(countries: DashboardStatsAccumulator['countries']): DashboardWorldMapDatum[] {
  return Array.from(countries.entries())
    .map(([code, summary]) => ({
      label: getCountryName(code) || code,
      count: summary.count,
      countryCode: code,
      simulatedCount: summary.simulatedCount,
      liveCount: summary.liveCount,
    }));
}

function dashboardBuckets(
  counts: Map<string, number>,
  filters: DashboardStatsFilters,
  lookbackDays: number,
  ignoreDateRange = false,
): DashboardStatsBucket[] {
  const bucketKeys = getDashboardBucketKeys(filters, lookbackDays, ignoreDateRange);
  return bucketKeys.map((date) => ({
    date,
    count: counts.get(date) || 0,
    fullDate: getDashboardBucketFullDate(date, filters.timezoneOffsetMinutes),
  }));
}

function getDashboardBucketKeys(
  filters: DashboardStatsFilters,
  lookbackDays: number,
  ignoreDateRange: boolean,
): string[] {
  const keys: string[] = [];
  const useExplicitRange = !ignoreDateRange && Boolean(filters.dateStart && filters.dateEnd);

  if (useExplicitRange) {
    let cursor = parseDashboardBucketKey(filters.dateStart, filters.timezoneOffsetMinutes);
    const end = parseDashboardBucketKey(filters.dateEnd, filters.timezoneOffsetMinutes);
    while (cursor <= end) {
      keys.push(formatDashboardBucketKey(cursor, filters));
      cursor = addDashboardBucketInterval(cursor, filters.granularity);
    }
    return keys;
  }

  const clientNow = new Date(Date.now() - filters.timezoneOffsetMinutes * 60_000);
  const end = new Date(Date.UTC(
    clientNow.getUTCFullYear(),
    clientNow.getUTCMonth(),
    clientNow.getUTCDate(),
    filters.granularity === 'hour' ? clientNow.getUTCHours() : 0,
    0,
    0,
    0,
  ));
  let cursor = new Date(Date.UTC(
    clientNow.getUTCFullYear(),
    clientNow.getUTCMonth(),
    clientNow.getUTCDate() - (lookbackDays - 1),
    0,
    0,
    0,
    0,
  ));

  while (cursor <= end) {
    keys.push(formatDashboardClientBucketKey(cursor, filters.granularity));
    cursor = addDashboardBucketInterval(cursor, filters.granularity);
  }

  return keys;
}

function getDashboardBucketKey(isoString: string, filters: DashboardStatsFilters): string {
  return getDateFilterKey(isoString, filters.granularity === 'hour', filters.timezoneOffsetMinutes);
}

function parseDashboardBucketKey(key: string, timezoneOffsetMinutes: number): Date {
  const [datePart, timePart] = key.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const hour = timePart === undefined ? 0 : Number(timePart);
  return new Date(Date.UTC(year, month - 1, day, hour, 0, 0, 0) + timezoneOffsetMinutes * 60_000);
}

function formatDashboardClientBucketKey(date: Date, granularity: DashboardGranularity): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  if (granularity === 'hour') {
    return `${year}-${month}-${day}T${String(date.getUTCHours()).padStart(2, '0')}`;
  }
  return `${year}-${month}-${day}`;
}

function formatDashboardBucketKey(date: Date, filters: DashboardStatsFilters): string {
  return getDateFilterKey(date.toISOString(), filters.granularity === 'hour', filters.timezoneOffsetMinutes);
}

function addDashboardBucketInterval(date: Date, granularity: DashboardGranularity): Date {
  const next = new Date(date);
  if (granularity === 'hour') {
    next.setUTCHours(next.getUTCHours() + 1);
  } else {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

function getDashboardBucketFullDate(key: string, timezoneOffsetMinutes: number): string {
  return parseDashboardBucketKey(key, timezoneOffsetMinutes).toISOString();
}
function lowerQuery(context: HonoContext, key: string): string {
  return (context.req.query(key) || '').toLowerCase();
}

function toSearchErrorResponse(error: SearchParseError): { error: string; details: SearchParseError } {
  return {
    error: error.message,
    details: error,
  };
}

function parseTimezoneOffset(context: HonoContext): number {
  const value = Number.parseInt(context.req.query('tz_offset') || '0', 10);
  return Number.isFinite(value) ? value : 0;
}

function matchesAlertListFilters(alert: SlimAlert, filters: AlertListFilters, machineFeaturesEnabled: boolean): boolean {
  if (!matchesSimulationFilter(alert.simulated === true, filters.simulation)) return false;

  const scenario = (alert.scenario || '').toLowerCase();
  const sourceValue = (getAlertSourceValue(alert.source) || '').toLowerCase();
  const cn = (alert.source?.cn || '').toLowerCase();
  const asName = (alert.source?.as_name || '').toLowerCase();
  const target = (alert.target || '').toLowerCase();

  if (filters.ip && !sourceValue.includes(filters.ip)) return false;
  if (filters.country && !cn.includes(filters.country)) return false;
  if (filters.scenario && !scenario.includes(filters.scenario)) return false;
  if (filters.as && !asName.includes(filters.as)) return false;
  if (filters.target && !target.includes(filters.target)) return false;
  if (filters.date && !(alert.created_at && alert.created_at.startsWith(filters.date))) return false;

  if (filters.dateStart || filters.dateEnd) {
    const itemKey = getDateFilterKey(
      alert.created_at,
      filters.dateStart.includes('T') || filters.dateEnd.includes('T'),
      filters.timezoneOffsetMinutes,
    );
    if (filters.dateStart && itemKey < filters.dateStart) return false;
    if (filters.dateEnd && itemKey > filters.dateEnd) return false;
  }

  return true;
}

function matchesDecisionListFilters(decision: DecisionListItem, filters: DecisionListFilters, _machineFeaturesEnabled: boolean): boolean {
  if (!filters.showDuplicates && decision.is_duplicate) return false;
  if (filters.alertId && String(decision.detail.alert_id) !== filters.alertId) return false;
  if (!matchesSimulationFilter(decision.simulated === true, filters.simulation)) return false;
  if (filters.country && decision.detail.country !== filters.country) return false;
  if (filters.scenario && decision.detail.reason !== filters.scenario) return false;
  if (filters.as && decision.detail.as !== filters.as) return false;
  if (filters.ip && decision.value !== filters.ip) return false;

  if (filters.target) {
    const value = (decision.value || '').toLowerCase();
    const target = (decision.detail.target || '').toLowerCase();
    if (!value.includes(filters.target) && !target.includes(filters.target)) return false;
  }

  if (filters.dateStart || filters.dateEnd) {
    if (!decision.created_at) return false;
    const itemKey = getDateFilterKey(
      decision.created_at,
      filters.dateStart.includes('T') || filters.dateEnd.includes('T'),
      filters.timezoneOffsetMinutes,
    );
    if (filters.dateStart && itemKey < filters.dateStart) return false;
    if (filters.dateEnd && itemKey > filters.dateEnd) return false;
  }

  return true;
}

function matchesSimulationFilter(isSimulated: boolean, filter: string): boolean {
  if (filter === 'simulated') return isSimulated;
  if (filter === 'live') return !isSimulated;
  return true;
}

function isDecisionListItemExpired(decision: DecisionListItem): boolean {
  const decisionDuration = decision.detail.duration ?? '';
  return Boolean(decision.expired || decisionDuration.startsWith('-'));
}

function getDateFilterKey(isoString: string, includeHour: boolean, timezoneOffsetMinutes: number): string {
  const source = new Date(isoString);
  const localDate = new Date(source.getTime() - timezoneOffsetMinutes * 60_000);
  const year = localDate.getUTCFullYear();
  const month = String(localDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(localDate.getUTCDate()).padStart(2, '0');

  if (includeHour) {
    const hour = String(localDate.getUTCHours()).padStart(2, '0');
    return `${year}-${month}-${day}T${hour}`;
  }

  return `${year}-${month}-${day}`;
}

function getCountryName(code?: string | null): string | null {
  if (!code) return null;
  try {
    const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(code.toUpperCase()) || code;
  } catch {
    return code;
  }
}
