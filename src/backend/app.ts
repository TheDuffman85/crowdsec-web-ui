import fs from 'fs';
import path from 'path';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { serveStatic } from 'hono/bun';
import type {
  AddDecisionRequest,
  AlertDecision,
  AlertRecord,
  ConfigResponse,
  DecisionListItem,
  LapiStatus,
  SlimAlert,
  StatsAlert,
  StatsDecision,
  SyncStatus,
  UpdateCheckResponse,
} from '../../shared/contracts';
import { createRuntimeConfig, getIntervalName, parseRefreshInterval, type RuntimeConfig } from './config';
import { CrowdsecDatabase, type AlertInsertParams, type DecisionInsertParams } from './database';
import { LapiClient } from './lapi';
import { createUpdateChecker } from './update-check';
import { getAlertTarget, toSlimAlert } from './utils/alerts';
import { parseGoDuration, toDuration } from './utils/duration';

type HonoContext = any;
type HonoNext = any;
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

export function createApp(options: CreateAppOptions = {}): AppController {
  const config = options.config || createRuntimeConfig();
  const database = options.database || new CrowdsecDatabase({ dbDir: config.dbDir });
  const lapiClient = options.lapiClient || new LapiClient({
    crowdsecUrl: config.crowdsecUrl,
    user: config.crowdsecUser,
    password: config.crowdsecPassword,
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

  const app = new Hono();
  const distRoot = options.distRoot || path.resolve(process.cwd(), 'frontend/dist');
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
  Simulations: ${config.simulationsEnabled ? 'Enabled' : 'Disabled'}
  Alert Origin Allowlist: ${config.alertOrigins.length > 0 ? config.alertOrigins.join(', ') : 'Disabled'}
  Alert Scenario Allowlist: ${config.alertExtraScenarios.length > 0 ? config.alertExtraScenarios.join(', ') : 'Disabled'}
  Bootstrap Retry: ${config.bootstrapRetryEnabled ? getIntervalName(config.bootstrapRetryDelayMs) : 'Disabled'}
`);

  if (!lapiClient.hasCredentials()) {
    console.warn('WARNING: CROWDSEC_USER and CROWDSEC_PASSWORD must be set for full functionality.');
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
          const alert = applySimulationModeToAlert(JSON.parse(row.raw_data) as AlertRecord, config.simulationsEnabled);
          if (!alert) {
            return null;
          }
          const payload: StatsAlert = {
            created_at: alert.created_at,
            scenario: alert.scenario,
            source: alert.source
              ? {
                  ip: alert.source.ip,
                  value: alert.source.value,
                  cn: alert.source.cn,
                  as_name: alert.source.as_name,
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

      const ipv4Re = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
      const ipv6Re = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(\/\d{1,3})?$/;
      if (!ipv4Re.test(ip) && !ipv6Re.test(ip)) {
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

  function getAlertSyncQueries(): AlertSyncQuery[] {
    const queries: AlertSyncQuery[] = [];

    for (const origin of config.alertOrigins) {
      queries.push({ origin });
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
    const queries = getAlertSyncQueries();
    const resultSets = queries.length === 0
      ? [await lapiClient.fetchAlerts(since, until, hasActiveDecision)]
      : await Promise.all(queries.map((query) => lapiClient.fetchAlerts(since, until, hasActiveDecision, query)));

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
    const alertSource = alert.source || {};
    const target = getAlertTarget(alert);
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
      $source_ip: alertSource.ip || alertSource.value,
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
      if (decision.origin === 'CAPI') continue;

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
        value: decision.value || alertSource.ip,
        type: decision.type || 'ban',
        country: alertSource.cn,
        as: alertSource.as_name,
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
        $value: decision.value,
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
      await Bun.sleep(100);
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
              if (decision.origin === 'CAPI') continue;

              const createdAt = decision.created_at || alert.created_at;
              const stopAt = decision.duration
                ? new Date(Date.now() + parseGoDuration(decision.duration)).toISOString()
                : decision.stop_at || createdAt;

              const alertSource = alert.source || {};
              const enrichedDecision = {
                ...decision,
                created_at: createdAt,
                stop_at: stopAt,
                scenario: decision.scenario || alert.scenario || 'unknown',
                origin: decision.origin || decision.scenario || alert.scenario || 'unknown',
                alert_id: alert.id,
                value: decision.value || alertSource.ip,
                type: decision.type || 'ban',
                country: alertSource.cn,
                as: alertSource.as_name,
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
    if (!lapiClient.hasCredentials() || !config.bootstrapRetryEnabled || cache.isInitialized || bootstrapRetryTimeout) {
      return;
    }

    console.log(`Bootstrap recovery will retry in ${getIntervalName(config.bootstrapRetryDelayMs)}: ${reason}.`);
    bootstrapRetryTimeout = setTimeout(() => {
      bootstrapRetryTimeout = null;
      void ensureBootstrapReady('bootstrap retry');
    }, config.bootstrapRetryDelayMs);
  }

  async function ensureBootstrapReady(source = 'bootstrap'): Promise<boolean> {
    if (!lapiClient.hasCredentials()) {
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
    if (!lapiClient.hasCredentials()) {
      console.warn('Cache initialization skipped - credentials not configured');
      return;
    }
    startRefreshScheduler();
    void ensureBootstrapReady('startup');
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
