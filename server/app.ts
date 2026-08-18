import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import type {
  AlertRecord,
  BulkDeleteResult,
  DashboardStatsResponse,
  FacetResponse,
  LapiStatus,
  SyncStatus,
  UpdateCheckResponse,
} from '../shared/contracts';
import { resolveMachineName } from '../shared/machine';
import { collectDistinctOrigins, normalizeOrigin } from '../shared/origin';
import {
  compileAlertSearch,
  compileDecisionSearch,
  getSearchFacetSelection,
  matchesIpSearchValue,
  removeSearchField,
  serializeSearchNode,
  type SearchNode,
  type SearchParseError,
} from '../shared/search';
import { createRuntimeConfig, getIntervalName, parseLookbackToMs, parseRefreshInterval, type RuntimeConfig } from './config';
import { getDateTimeKey, getTimeZoneOffsetMs, getZonedHourlyBucketKeys } from './utils/date-time';
import { CrowdsecDatabase, type AlertInsertParams, type DecisionInsertParams } from './database';
import {
  ALERT_RECORD_COLUMNS,
  DECISION_RECORD_COLUMNS,
  alertFromRow,
  alertMetadataFingerprint,
  decisionFromRow,
  type NormalizedAlertRow,
  type NormalizedDecisionRow,
} from './normalized-record';
import { LapiClient } from './lapi';
import { createDashboardAuth } from './app-auth';
import { createAuditLogger } from './audit-log';
import { createNotificationService } from './notifications';
import type { MqttPublishConfig } from './notifications/mqtt-client';
import { createNotificationOutboundGuard } from './notifications/outbound-guard';
import { createNotificationSecretStore } from './notifications/secret-store';
import { createUpdateChecker, type UpdateCheckOverrides, type UpdateChecker } from './update-check';
import { getServerTranslator, normalizeLanguagePreference, saveLanguagePreference } from './i18n';
import {
  addDashboardAttackLocation,
  dashboardAttackLocationData,
  type DashboardAttackLocationAccumulator,
} from './dashboard-locations';
import { createAttackLocationResolver, type AttackLocationResolver } from './attack-location-geocoder';
import { getAlertSourceValue, getAlertTargets, getAlertTargetSummary, resolveAlertHistoryAt, resolveAlertReason, resolveAlertScenario, toSlimAlert, withAlertTargetSummary } from './utils/alerts';
import { parseGoDuration, toDuration } from './utils/duration';
import { fetchCrowdsecMetrics } from './metrics';
import { DatabaseQueryWorker, QueryWorkerTimeoutError } from './query-worker-client';
import { registerApiRoutes } from './app/api-routes';
import { createQueryService } from './app/query-service';
import { createDeletionService } from './app/deletion-service';
import { createSyncService } from './app/sync-service';
import {
  DatabaseSyncWorker,
  type AlertDecisionComparison,
  type AlertDecisionComparisonResult,
  type SyncAlertMutation,
} from './sync-worker-client';
import type {
  DashboardStatsCache,
  DashboardStatsFilters,
} from './app/types';
import {
  loadMetricsSidebarVisible,
  loadPersistedConfig,
  resolveNotificationSecretKey,
  saveMetricsSidebarVisible,
  savePersistedConfig,
} from './app/preferences';
import {
  applySimulationModeToAlert,
  emptyAlertDecisionSummary,
  isAlertSimulated,
  lookbackHours,
  markDuplicateDecisions,
  normalizeAlertSimulated,
  normalizeDecisionSimulated,
  toDecisionListItem,
} from './app/simulation';
import {
  getAlertListFilters,
  getAlertListFiltersFromValues,
  getDashboardStatsFilters,
  getDecisionListFilters,
  getDecisionListFiltersFromValues,
  getFacetRequest,
  getPageRequest,
  getEffectiveRequestTimeZone,
  getEffectiveRequestTimeZoneValue,
  matchesAlertListFilters,
  matchesDecisionListFilters,
  parseRecordExtras,
  readExtraString,
  readExtraStringArray,
  isDecisionListItemExpired,
  toPaginatedResponse,
  toSearchErrorResponse,
  withoutAlertFacetFilter,
  withoutDecisionFacetFilter,
} from './app/request-parsing';
import {
  addDashboardAlert,
  addDashboardDecision,
  addDashboardDecisionCountry,
  compareDashboardDecisionRank,
  createDashboardDecisionAccumulator,
  createDashboardStatsAccumulator,
  dashboardBuckets,
  dashboardCountryList,
  dashboardWorldMapData,
  getDashboardBucketKey,
  getDashboardBucketKeys,
  matchesDashboardAlertFilters,
  matchesDashboardDecisionFilters,
  matchesDashboardSimulationFilter,
  normalizeDashboardCoordinate,
  normalizeDashboardCountryCode,
  requiresDashboardAlertIpJoin,
  selectDashboardDecisionPrimary,
  topDashboardEntries,
} from './app/dashboard-stats';
import {
  addIpCondition,
  addLike,
  alertFieldCondition,
  buildInstanceFacetLabelSql,
  compileSearchNodeSql,
  createSqlWhere,
  decisionSearchCanSplitDuplicateGroup,
  decisionFieldCondition,
  decisionMachineIdSql,
  decisionMachineLabelSql,
  escapeLike,
  freeTextSearchCondition,
  getAlertCountIndexHint,
  getDecisionPageIndexHint,
  getDateFilterBoundary,
  jsonStringArraySql,
  likeParam,
  normalizedMachineIdSql,
  parseSqlSearchDateValue,
  targetFieldCondition,
} from './app/search-sql';

type HonoContext = any;
type HonoNext = any;
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type AnyError = Error & {
  code?: string;
  response?: { data?: unknown; status: number };
  request?: unknown;
  helpLink?: string;
  helpText?: string;
};

const COMMON_FACET_FIELDS = [
  'id',
  'instance',
  'scenario',
  'country',
  'region',
  'city',
  'as',
  'ip',
  'target',
  'machine',
  'origin',
] as const;
const ALERT_FACET_FIELDS = [...COMMON_FACET_FIELDS, 'decision'] as const;
const DECISION_FACET_FIELDS = [...COMMON_FACET_FIELDS, 'alert', 'action', 'status'] as const;
const FACET_DEFAULT_LIMIT = 10;
const FACET_MAX_LIMIT = 50;
const FACET_MAX_OFFSET = 500;
const FACET_CACHE_MAX_ENTRIES = 256;

export interface CreateAppOptions {
  config?: RuntimeConfig;
  database?: CrowdsecDatabase;
  lapiClient?: LapiClient;
  lapiClients?: Map<string, LapiClient>;
  distRoot?: string;
  startBackgroundTasks?: boolean;
  updateChecker?: UpdateChecker;
  notificationFetchImpl?: FetchLike;
  metricsFetchImpl?: FetchLike;
  mqttPublishImpl?: (config: MqttPublishConfig, payload: string) => Promise<void>;
  initialCacheState?: Partial<CacheState>;
  rootRedirectPath?: string;
  queryWorker?: DatabaseQueryWorker;
  analyticsQueryWorker?: DatabaseQueryWorker;
  facetQueryWorker?: DatabaseQueryWorker;
  syncWorker?: Pick<
    DatabaseSyncWorker,
    | 'persistAlerts'
    | 'deleteAlertsMissingBetween'
    | 'deleteCachedAlerts'
    | 'deleteCachedDecisions'
    | 'beginDeferredSearchIndexUpdates'
    | 'rebuildSearchIndexes'
    | 'refreshDecisionDuplicateFlags'
    | 'cleanupOldData'
    | 'clearSyncData'
    | 'runExclusive'
    | 'close'
  > & Partial<Pick<DatabaseSyncWorker, 'compareAlertDecisions' | 'runTransaction'>>;
  attackLocationResolver?: AttackLocationResolver;
}

export interface AppController {
  app: Hono;
  fetch: Hono['fetch'];
  config: RuntimeConfig;
  database: CrowdsecDatabase;
  lapiClient: LapiClient;
  lapiClients: Map<string, LapiClient>;
  startBackgroundTasks: () => void;
  stopBackgroundTasks: () => void;
  getSyncStatus: () => SyncStatus;
  getLapiStatus: () => LapiStatus;
  getCacheLastUpdate: () => string | null;
  subscribeCacheUpdates: (listener: (updatedAt: string, instanceIds: string[]) => void) => () => void;
}

const RECONCILE_WINDOW_STATE_META_KEY = 'alert_reconcile_window_state';

interface CacheState {
  isInitialized: boolean;
  isComplete: boolean;
  lastUpdate: string | null;
}

interface UpdateCache {
  lastCheck: number;
  data: UpdateCheckResponse | null;
}

interface SyncHistorySummary {
  historicalAlerts: number;
  historicalDecisions: number;
  historicalErrors: string[];
  errors: string[];
  state: 'complete' | 'partial' | 'failed';
  cachedAlerts: number;
  cachedDecisions: number;
  changed: boolean;
  syncedThrough: string;
}

interface InstanceSyncRuntime {
  instanceId: string;
  instanceName: string;
  client: LapiClient;
  status: SyncStatus;
  lookbackMs: number;
  chunkSizeMs: number;
  minChunkSizeMs: number;
  requestTimeoutMs: number;
}

interface ReconcileWindowState {
  version: 1;
  configFingerprint: string;
  headLastSuccess: number;
  windows: Record<string, number>;
}

const API_BODY_LIMIT_BYTES = 1024 * 1024;
const delay = (ms: number): Promise<void> => new Promise((resolve) => {
  if (ms === 0) setImmediate(resolve);
  else setTimeout(resolve, ms);
});
const DASHBOARD_LOOP_YIELD_INTERVAL = 250;
const DASHBOARD_INDEX_BATCH_SIZE = 250;
// Keep worker-message overhead reasonable while bounding each transaction so
// interactive writes do not sit behind a long cache batch in the shared queue.
const SYNC_WRITE_BATCH_SIZE = 100;
const SYNC_WRITE_DECISION_BATCH_SIZE = 500;
const SYNC_DEFER_SEARCH_INDEX_DECISION_THRESHOLD = 10_000;
const LEGACY_UNFILTERED_ALERT_ORIGIN_TOKENS = new Set(['none']);
const CAPI_ALERT_ORIGIN = 'CAPI';
const LISTS_ALERT_ORIGIN = 'lists';
const COMMUNITY_BLOCKLIST_SOURCE_SCOPE = 'crowdsecurity/community-blocklist';
const LIST_SOURCE_SCOPE_PREFIX = 'lists:';
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
const IPV6_RE = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(\/\d{1,3})?$/;

function usesSingleScopeAlertQuery(origin: string | undefined): boolean {
  return origin === CAPI_ALERT_ORIGIN || origin === LISTS_ALERT_ORIGIN;
}

function getAlertFallbackOrigins(alert: Pick<AlertRecord, 'decisions' | 'source'>): string[] {
  const decisionOrigins = collectDistinctOrigins(alert.decisions);
  if (decisionOrigins.length > 0) return decisionOrigins;

  const sourceScope = typeof alert.source?.scope === 'string' ? alert.source.scope.trim() : '';
  if (sourceScope === COMMUNITY_BLOCKLIST_SOURCE_SCOPE) {
    return [CAPI_ALERT_ORIGIN];
  }
  if (sourceScope.startsWith(LIST_SOURCE_SCOPE_PREFIX)) {
    return [LISTS_ALERT_ORIGIN];
  }

  return [];
}

function countAlertDecisions(alerts: AlertRecord[]): number {
  return alerts.reduce((total, alert) => total + (Array.isArray(alert.decisions) ? alert.decisions.length : 0), 0);
}

function formatElapsedTime(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  return `${(ms / 1_000).toFixed(2)}s`;
}

function getPublicRequestOrigin(context: HonoContext): string {
  const forwardedHost = context.req.header('x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwardedHost || context.req.header('host');
  const forwardedProto = context.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const url = new URL(context.req.url);
  const protocol = forwardedProto || url.protocol.replace(/:$/, '');
  return host ? `${protocol}://${host}` : url.origin;
}

function isRequestOriginAllowed(context: HonoContext): boolean {
  if (context.req.header('sec-fetch-site') === 'cross-site') return false;
  const origin = context.req.header('origin');
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(getPublicRequestOrigin(context)).origin;
  } catch {
    return false;
  }
}

function readUpdateCheckOverrides(query: Record<string, string | string[]>): UpdateCheckOverrides {
  return {
    branch: readSingleQueryValue(query.branch),
    commitHash: readSingleQueryValue(query.commit_hash),
    version: readSingleQueryValue(query.version),
  };
}

function readSingleQueryValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export function createApp(options: CreateAppOptions = {}): AppController {
  const config = options.config || createRuntimeConfig();
  const database = options.database || new CrowdsecDatabase({
    dbDir: config.dbDir,
    walEnabled: config.sqliteWalEnabled,
  });
  if (config.instances.length > 1 && database.getMeta('multi_instance_cache_schema_ready')?.value !== 'true') {
    const pendingDeletions = database.getPendingAlertDeletions();
    if (pendingDeletions.length > 0) {
      throw new Error(`Cannot enable multi-instance mode while ${pendingDeletions.length} durable alert deletion job(s) remain unresolved.`);
    }
    database.clearSyncData();
    database.setMeta(RECONCILE_WINDOW_STATE_META_KEY, '[]');
    database.setMeta('multi_instance_cache_schema_ready', 'true');
  }
  const primaryInstance = config.instances[0];
  database.setMeta('multi_instance_primary_id', primaryInstance.id);
  for (const instance of config.instances) {
    const key = `crowdsec_instance_url:${instance.id}`;
    const previousUrl = database.getMeta(key)?.value;
    if (previousUrl && previousUrl !== instance.lapiUrl) {
      console.warn(`CrowdSec instance "${instance.id}" changed URL from ${previousUrl} to ${instance.lapiUrl}. Verify that the immutable ID still represents the same LAPI.`);
    }
    database.setMeta(key, instance.lapiUrl);
  }
  const configuredLapiClients = options.lapiClients || new Map<string, LapiClient>();
  if (options.lapiClient) configuredLapiClients.set(primaryInstance.id, options.lapiClient);
  for (const instance of config.instances) {
    if (configuredLapiClients.has(instance.id)) continue;
    configuredLapiClients.set(instance.id, new LapiClient({
      crowdsecUrl: instance.lapiUrl,
      auth: instance.lapiAuth,
      tls: instance.lapiTls,
      simulationsEnabled: config.simulationsEnabled,
      lookbackPeriod: instance.sync.lookbackPeriod || config.lookbackPeriod,
      requestTimeoutMs: instance.sync.requestTimeoutMs || config.lapiRequestTimeoutMs,
      version: config.version,
    }));
  }
  const lapiClients = configuredLapiClients;
  const lapiClient = lapiClients.get(primaryInstance.id) || new LapiClient({
    crowdsecUrl: primaryInstance.lapiUrl,
    auth: primaryInstance.lapiAuth,
    tls: primaryInstance.lapiTls,
    simulationsEnabled: config.simulationsEnabled,
    lookbackPeriod: config.lookbackPeriod,
    requestTimeoutMs: config.lapiRequestTimeoutMs,
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
  const queryWorker = options.queryWorker || new DatabaseQueryWorker({ dbPath: database.dbPath });
  const analyticsQueryWorker = options.analyticsQueryWorker
    || (options.queryWorker ? queryWorker : new DatabaseQueryWorker({
      dbPath: database.dbPath,
      timeoutMs: 60_000,
      queueTimeoutMs: 30_000,
      maxWorkers: 1,
    }));
  const facetQueryWorker = options.facetQueryWorker || new DatabaseQueryWorker({
    dbPath: database.dbPath,
    timeoutMs: 5_000,
    maxWorkers: 1,
  });
  const syncWorker = options.syncWorker || new DatabaseSyncWorker({
    dbPath: database.dbPath,
    walEnabled: config.sqliteWalEnabled,
  });
  const attackLocationResolver = options.attackLocationResolver || createAttackLocationResolver({
    dumpDirectory: config.geonamesDumpDir,
  });
  const notificationService = createNotificationService({
    database,
    queryWorker,
    writeDatabase: (operation) => syncWorker.runExclusive(operation),
    fetchImpl: options.notificationFetchImpl,
    mqttPublishImpl: options.mqttPublishImpl,
    updateChecker: checkForUpdates,
    getLapiStatus: () => lapiClient.getStatus(),
    ...(config.instances.length > 1 ? {
      getLapiStatuses: () => config.instances.map((instance) => ({
        instanceId: instance.id,
        instanceName: instance.name,
        status: lapiClients.get(instance.id)!.getStatus(),
      })),
    } : {}),
    outboundGuard: notificationOutboundGuard,
    secretStore: notificationSecretStore,
    debugPayloads: config.notificationDebugPayloads,
    timeZone: config.timeZone,
    timeFormat: config.timeFormat,
    instanceAware: config.instances.length > 1,
    instances: config.instances.map((instance) => ({ id: instance.id, name: instance.name })),
  });
  const dashboardAuth = createDashboardAuth({
    config: config.dashboardAuth,
    database,
    basePath: config.basePath,
    instanceReadOnly: config.readOnly,
    writeDatabase: (operation) => syncWorker.runExclusive(operation),
  });
  const auditLog = createAuditLogger({
    enabled: config.auditEnabled,
    logFile: config.auditLogFile,
    getActor: (context) => dashboardAuth.getSession(context),
  });

  const app = new Hono();
  const distRoot = options.distRoot || path.resolve(process.cwd(), 'dist/client');
  const staticFiles = [
    '/logo.svg',
    '/logo-sidebar.png',
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
    state: 'idle',
    errors: [],
  };
  const instanceSyncStatuses = new Map(config.instances.map((instance) => [instance.id, instance.id === primaryInstance.id
    ? syncStatus
    : ({ isSyncing: false, progress: 0, message: '', startedAt: null, completedAt: null, state: 'idle', errors: [] } satisfies SyncStatus)]));

  function aggregateLapiStatus(): 'healthy' | 'partial' | 'offline' {
    const connected = config.instances.filter((instance) => lapiClients.get(instance.id)?.getStatus().isConnected).length;
    if (connected === config.instances.length) return 'healthy';
    return connected > 0 ? 'partial' : 'offline';
  }

  function instanceName(instanceId: string): string {
    return config.instances.find((instance) => instance.id === instanceId)?.name || instanceId;
  }

  function withInstanceName<T extends { instance_id?: string; instance_name?: string }>(record: T): T {
    const instanceId = record.instance_id || primaryInstance.id;
    return { ...record, instance_id: instanceId, instance_name: instanceName(instanceId) };
  }

  const cache: CacheState = {
    isInitialized: options.initialCacheState?.isInitialized ?? false,
    isComplete: options.initialCacheState?.isComplete ?? false,
    lastUpdate: options.initialCacheState?.lastUpdate ?? null,
  };
  const instanceLastUpdates = new Map(config.instances.map((instance) => [
    instance.id,
    instance.id === primaryInstance.id ? cache.lastUpdate : null,
  ]));
  // Keep the LAPI cursor separate from the timestamp exposed to clients. The
  // cursor marks the authoritative end of the fetched window, while this value
  // only advances after all post-import maintenance is complete and the new
  // data is safe for every API consumer to read.
  let cacheRefreshCompletedAt = options.initialCacheState?.lastUpdate ?? null;
  const cacheUpdateListeners = new Set<(updatedAt: string, instanceIds: string[]) => void>();
  const facetResponseCache = new Map<string, FacetResponse>();
  let facetCacheVersion = 0;

  function publishCacheUpdate(updatedAt: string, instanceIds = [primaryInstance.id]): void {
    for (const listener of cacheUpdateListeners) {
      try {
        listener(updatedAt, instanceIds);
      } catch (error) {
        console.error('Cache update listener failed:', error);
      }
    }
  }
  const dashboardStatsCaches = new Map<string, DashboardStatsCache>();
  let dashboardStatsCacheVersion = 0;
  let dashboardStatsResponseVersion = 0;
  const dashboardStatsScopeVersions = new Map<string, number>([
    ['all', 0],
    ...config.instances.map((instance) => [instance.id, 0] as const),
  ]);
  const dashboardStatsReadyPublishedKeys = new Set<string>();
  const dashboardStatsResponseCache = new Map<string, DashboardStatsResponse>();
  const dashboardStatsResponseValidUntil = new Map<string, number>();
  const staleDashboardStatsResponseCache = new Map<string, DashboardStatsResponse>();
  const dashboardStatsIndexPromises = new Map<string, Promise<DashboardStatsCache>>();
  const dashboardStatsResponsePromises = new Map<string, Promise<DashboardStatsResponse>>();
  let lastDashboardStatsFilters: DashboardStatsFilters | null = null;
  let lastDashboardStatsRequestedAt = 0;
  let activePublishedRevisionReaders = 0;
  let queuedPublishedRevisionWriters = 0;
  let publishedRevisionWriterTail = Promise.resolve();
  let publishedRevisionReadersDrained: Promise<void> | null = null;
  let resolvePublishedRevisionReadersDrained: (() => void) | null = null;
  let publishedRevisionReadersAllowed: Promise<void> | null = null;
  let resolvePublishedRevisionReadersAllowed: (() => void) | null = null;
  const onDemandRefreshPreparedContextKey = 'onDemandRefreshPrepared';

  async function acquirePublishedRevisionRead(): Promise<() => void> {
    while (queuedPublishedRevisionWriters > 0) {
      if (!publishedRevisionReadersAllowed) {
        publishedRevisionReadersAllowed = new Promise<void>((resolve) => {
          resolvePublishedRevisionReadersAllowed = resolve;
        });
      }
      await publishedRevisionReadersAllowed;
    }

    activePublishedRevisionReaders += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activePublishedRevisionReaders -= 1;
      if (activePublishedRevisionReaders === 0) {
        resolvePublishedRevisionReadersDrained?.();
        resolvePublishedRevisionReadersDrained = null;
        publishedRevisionReadersDrained = null;
      }
    };
  }

  async function acquirePublishedRevisionWrite(): Promise<() => void> {
    queuedPublishedRevisionWriters += 1;
    let releaseWriterTurn!: () => void;
    const writerTurn = new Promise<void>((resolve) => {
      releaseWriterTurn = resolve;
    });
    const previousWriter = publishedRevisionWriterTail;
    publishedRevisionWriterTail = previousWriter.then(() => writerTurn);
    await previousWriter;

    if (activePublishedRevisionReaders > 0) {
      publishedRevisionReadersDrained = new Promise<void>((resolve) => {
        resolvePublishedRevisionReadersDrained = resolve;
      });
      await publishedRevisionReadersDrained;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      queuedPublishedRevisionWriters -= 1;
      releaseWriterTurn();
      if (queuedPublishedRevisionWriters === 0) {
        resolvePublishedRevisionReadersAllowed?.();
        resolvePublishedRevisionReadersAllowed = null;
        publishedRevisionReadersAllowed = null;
      }
    };
  }

  const persistedConfig = loadPersistedConfig(database);
  let refreshIntervalMs = persistedConfig.refresh_interval_ms ?? config.refreshIntervalMs;
  let manualRefreshEnabled = persistedConfig.manual_refresh_enabled ?? config.manualRefreshEnabled;
  // The config endpoint stays available while a fresh cache builds its large
  // SQLite indexes. Keep this tiny preference in memory so startup polling
  // never contends with the index writer (notably when WAL is disabled).
  let metricsSidebarVisible = loadMetricsSidebarVisible(database);
  const reconcileConfigFingerprint = crypto.createHash('sha256').update(JSON.stringify({
    lookbackMs: config.lookbackMs,
    reconcileWindowMs: config.reconcileWindowMs,
    alertFilterMode: config.alertFilterMode,
    alertIncludeOrigins: config.alertIncludeOrigins,
    alertExcludeOrigins: config.alertExcludeOrigins,
    alertIncludeCapi: config.alertIncludeCapi,
    alertIncludeOriginEmpty: config.alertIncludeOriginEmpty,
    alertExcludeOriginEmpty: config.alertExcludeOriginEmpty,
    legacyAlertOrigins: config.legacyAlertOrigins,
    legacyAlertExtraScenarios: config.legacyAlertExtraScenarios,
    simulationsEnabled: config.simulationsEnabled,
  })).digest('hex');
  let reconcileWindowState = loadReconcileWindowState();
  let initializationPromise: Promise<SyncHistorySummary | null> | null = null;
  const initialHistorySyncs = new Set(config.instances.map((instance) => instance.id));
  let lastRequestTime = Date.now();
  let schedulerTimeout: ReturnType<typeof setTimeout> | null = null;
  let nextRefreshAt: string | null = null;
  let isSchedulerRunning = false;
  let heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  let isHeartbeatSchedulerRunning = false;
  let heartbeatPromise: Promise<void> | null = null;
  let heartbeatFailureLogged = false;
  let bootstrapRetryTimeout: ReturnType<typeof setTimeout> | null = null;
  let bootstrapPromise: Promise<boolean> | null = null;
  let bootstrapSource: string | null = null;
  let bootstrapWaitLogged = false;
  let cacheRefreshPromise: Promise<void> | null = null;
  let pendingAlertDeletionTimeout: ReturnType<typeof setTimeout> | null = null;
  let pendingAlertDeletionPromise: Promise<void> | null = null;
  let pendingAlertDeletionRerunRequested = false;
  let pendingAlertDeletionStopped = false;
  const instanceRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const instanceRefreshPromises = new Map<string, Promise<void>>();
  const historicalInstanceSyncPending = new Set<string>();
  const instanceNetworkWaiters: Array<() => void> = [];
  let activeInstanceNetworkSyncs = 0;
  const maxConcurrentInstanceNetworkSyncs = 2;

  function aggregateHistoricalSyncStatus(): SyncStatus {
    if (config.instances.length === 1) return { ...syncStatus };

    const instances = config.instances.map((instance) => {
      const status = instanceSyncStatuses.get(instance.id) || syncStatus;
      const waiting = historicalInstanceSyncPending.has(instance.id) && !status.isSyncing;
      const primaryCacheReady = instance.id === primaryInstance.id
        && !historicalInstanceSyncPending.has(instance.id)
        && !status.isSyncing
        && cache.isInitialized
        && status.state === 'idle';
      return {
        instance_id: instance.id,
        instance_name: instance.name,
        icon: instance.icon,
        isSyncing: status.isSyncing,
        progress: waiting ? 0 : primaryCacheReady ? 100 : status.progress,
        message: waiting ? '' : status.message,
        startedAt: waiting ? null : status.startedAt,
        completedAt: waiting ? null : primaryCacheReady ? cache.lastUpdate : status.completedAt,
        state: waiting ? 'idle' as const : primaryCacheReady ? 'complete' as const : status.state,
        errors: [...(status.errors || [])],
      };
    });
    const isSyncing = syncStatus.isSyncing || historicalInstanceSyncPending.size > 0;
    const errors = instances.flatMap((instance) => (instance.errors || []).map(
      (error) => `${instance.instance_name}: ${error}`,
    ));
    const settledStates = instances.map((instance) => instance.state);
    const completedAtValues = instances
      .map((instance) => instance.completedAt)
      .filter((value): value is string => Boolean(value));
    const startedAtValues = instances
      .map((instance) => instance.startedAt)
      .filter((value): value is string => Boolean(value));
    const state = isSyncing
      ? 'syncing'
      : settledStates.every((candidate) => candidate === 'complete')
        ? 'complete'
        : settledStates.every((candidate) => candidate === 'failed')
          ? 'failed'
          : settledStates.some((candidate) => candidate === 'failed' || candidate === 'partial')
            ? 'partial'
            : syncStatus.state;

    return {
      isSyncing,
      progress: Math.round(instances.reduce((total, instance) => total + instance.progress, 0) / instances.length),
      message: isSyncing ? '' : syncStatus.message,
      startedAt: startedAtValues.sort()[0] || null,
      completedAt: isSyncing ? null : completedAtValues.sort().at(-1) || null,
      state,
      errors,
      instances,
    };
  }

  async function withInstanceNetworkSlot<T>(operation: () => Promise<T>): Promise<T> {
    if (activeInstanceNetworkSyncs >= maxConcurrentInstanceNetworkSyncs) {
      await new Promise<void>((resolve) => instanceNetworkWaiters.push(resolve));
    }
    activeInstanceNetworkSyncs += 1;
    try {
      return await operation();
    } finally {
      activeInstanceNetworkSyncs -= 1;
      instanceNetworkWaiters.shift()?.();
    }
  }

  function getInstanceSyncRuntime(instanceId: string): InstanceSyncRuntime {
    const instance = config.instances.find((candidate) => candidate.id === instanceId);
    const client = lapiClients.get(instanceId);
    const status = instanceSyncStatuses.get(instanceId);
    if (!instance || !client || !status) throw new Error(`Unknown CrowdSec instance ${instanceId}`);
    return {
      instanceId,
      instanceName: instance.name,
      client,
      status,
      lookbackMs: instance.sync.lookbackPeriod
        ? parseLookbackToMs(instance.sync.lookbackPeriod)
        : config.lookbackMs,
      chunkSizeMs: instance.sync.alertSyncChunkMs ?? config.alertSyncChunkMs,
      minChunkSizeMs: instance.sync.alertSyncMinChunkMs ?? config.alertSyncMinChunkMs,
      requestTimeoutMs: instance.sync.requestTimeoutMs ?? config.lapiRequestTimeoutMs,
    };
  }

  function emptyReconcileWindowState(): ReconcileWindowState {
    return {
      version: 1,
      configFingerprint: reconcileConfigFingerprint,
      headLastSuccess: 0,
      windows: {},
    };
  }

  function loadReconcileWindowState(): ReconcileWindowState {
    try {
      const value = database.getMeta(RECONCILE_WINDOW_STATE_META_KEY)?.value;
      if (!value) return emptyReconcileWindowState();
      const parsed = JSON.parse(value) as Partial<ReconcileWindowState>;
      if (
        parsed.version !== 1
        || parsed.configFingerprint !== reconcileConfigFingerprint
        || typeof parsed.headLastSuccess !== 'number'
        || !parsed.windows
        || typeof parsed.windows !== 'object'
      ) {
        return emptyReconcileWindowState();
      }
      return parsed as ReconcileWindowState;
    } catch {
      return emptyReconcileWindowState();
    }
  }

  function saveReconcileWindowState(): void {
    database.setMeta(RECONCILE_WINDOW_STATE_META_KEY, JSON.stringify(reconcileWindowState));
  }

  function resetReconcileWindowState(): void {
    reconcileWindowState = emptyReconcileWindowState();
    saveReconcileWindowState();
  }

  console.log(`Cache Configuration:
  Lookback Period: ${config.lookbackPeriod} (${config.lookbackMs}ms)
  Refresh Interval: ${getIntervalName(refreshIntervalMs)} (${persistedConfig.refresh_interval_ms !== undefined ? 'from saved config' : 'from startup configuration'})
  Manual Refresh: ${manualRefreshEnabled ? 'Enabled' : 'Disabled'} (${persistedConfig.manual_refresh_enabled !== undefined ? 'from saved config' : 'from startup configuration'})
  LAPI Request Timeout: ${getIntervalName(config.lapiRequestTimeoutMs)}
  Alert Sync Chunk: ${getIntervalName(config.alertSyncChunkMs)}
  Alert Sync Min Chunk: ${getIntervalName(config.alertSyncMinChunkMs)}
  Reconcile Window: ${getIntervalName(config.reconcileWindowMs)}
  Recent Reconcile: ${getIntervalName(config.reconcileRecentIntervalMs)} for ${getIntervalName(config.reconcileRecentAgeMs)}
  Active Reconcile: ${getIntervalName(config.reconcileActiveIntervalMs)}
  Older Reconcile: ${getIntervalName(config.reconcileOldIntervalMs)}
  Reconcile Windows Per Refresh: ${config.reconcileWindowsPerRefresh}
  Machine Heartbeat: ${config.heartbeatIntervalMs > 0 ? getIntervalName(config.heartbeatIntervalMs) : 'Disabled'}
  Deletion Queue Maximum Age: ${config.deletionQueueMaxAgeMs > 0 ? getIntervalName(config.deletionQueueMaxAgeMs) : 'Disabled'}
  Prometheus Metrics: ${config.prometheusUrl ? `Enabled (${config.prometheusUrl})` : 'Disabled'}
  Auth Mode: ${config.crowdsecAuthMode}
  Simulations: ${config.simulationsEnabled ? 'Enabled' : 'Disabled'}
  Alert Filter Mode: ${config.alertFilterMode}
  Alert Include Origins: ${config.alertIncludeOrigins.length > 0 ? config.alertIncludeOrigins.join(', ') : 'Disabled'}
  Alert Exclude Origins: ${config.alertExcludeOrigins.length > 0 ? config.alertExcludeOrigins.join(', ') : 'Disabled'}
  Alert Include CAPI: ${config.alertIncludeCapi ? 'Enabled' : 'Disabled'}
  Alert Include Origin Empty: ${config.alertIncludeOriginEmpty ? 'Enabled' : 'Disabled'}
  Alert Exclude Origin Empty: ${config.alertExcludeOriginEmpty ? 'Enabled' : 'Disabled'}
  Bootstrap Retry: ${config.bootstrapRetryEnabled ? getIntervalName(config.bootstrapRetryDelayMs) : 'Disabled'}
  Notification Secret Storage: Encrypted (${config.notificationSecretKey ? 'configured key' : 'auto-generated key'})
  Notification Private Destinations: ${config.notificationAllowPrivateAddresses ? 'Allowed' : 'Blocked'}
  Time Zone: ${config.timeZone || 'Browser local'}
  Time Format: ${config.timeFormat}
  Dashboard Auth: ${dashboardAuth.enabled ? 'Enabled' : 'Disabled'}
  Dashboard OIDC: ${dashboardAuth.oidcEnabled ? 'Enabled' : 'Disabled'}
  Read-only Mode: ${config.readOnly ? 'Enabled' : 'Disabled'}
  Audit Log: ${config.auditEnabled ? `Enabled${config.auditLogFile ? ` (file: ${config.auditLogFile})` : ''}` : 'Disabled'}
`);

  if (!lapiClient.hasAuthConfig()) {
    console.warn(
      'WARNING: CrowdSec LAPI authentication is not configured. Configure instances[].lapi.auth in the application YAML (recommended), or use the legacy CrowdSec authentication environment variables.',
    );
  }

  const queryServiceState = {
    facetResponseCache,
    get facetCacheVersion() { return facetCacheVersion; },
    set facetCacheVersion(value: number) { facetCacheVersion = value; },
    dashboardStatsCaches,
    get dashboardStatsCacheVersion() { return dashboardStatsCacheVersion; },
    set dashboardStatsCacheVersion(value: number) { dashboardStatsCacheVersion = value; },
    get dashboardStatsResponseVersion() { return dashboardStatsResponseVersion; },
    set dashboardStatsResponseVersion(value: number) { dashboardStatsResponseVersion = value; },
    dashboardStatsScopeVersions,
    dashboardStatsReadyPublishedKeys,
    dashboardStatsResponseCache,
    dashboardStatsResponseValidUntil,
    staleDashboardStatsResponseCache,
    dashboardStatsIndexPromises,
    dashboardStatsResponsePromises,
    get cacheRefreshCompletedAt() { return cacheRefreshCompletedAt; },
    get lastDashboardStatsFilters() { return lastDashboardStatsFilters; },
    get lastDashboardStatsRequestedAt() { return lastDashboardStatsRequestedAt; },
    get refreshIntervalMs() { return refreshIntervalMs; },
  };
  const {
    hydrateAlertWithDecisions,
    hydrateAlertsBatch,
    queryPaginatedAlerts,
    queryPaginatedDecisions,
    queryAlertFacet,
    queryDecisionFacet,
    enrichAlertLocations,
    enrichAlertRecordLocations,
    enrichDecisionLocations,
    getAlertCoordinatesByIds,
    buildDashboardStats,
    getDashboardStatsIndex,
    createEmptyDashboardStatsResponse,
    noteDashboardStatsRequest,
    isDashboardStatsBuildInProgress,
    warmDashboardStatsCache,
    prepareDashboardStatsAfterRefresh,
    prepareDashboardStatsAfterRefreshInBackground,
    invalidateFacetResponses,
    invalidateDashboardStatsCache,
    getStaleDashboardStatsResponseCacheKey,
    normalizeAlertDetail,
  } = createQueryService({
    state: queryServiceState,
    ALERT_RECORD_COLUMNS,
    DECISION_RECORD_COLUMNS,
    FACET_CACHE_MAX_ENTRIES,
    analyticsQueryWorker,
    attackLocationResolver,
    addDashboardAttackLocation,
    addDashboardAlert,
    addDashboardDecision,
    addDashboardDecisionCountry,
    addIpCondition,
    addLike,
    applySimulationModeToAlert,
    alertFieldCondition,
    alertFromRow,
    buildInstanceFacetLabelSql,
    compareDashboardDecisionRank,
    compileAlertSearch,
    compileDecisionSearch,
    compileSearchNodeSql,
    config,
    createDashboardDecisionAccumulator,
    createDashboardStatsAccumulator,
    createSqlWhere,
    decisionSearchCanSplitDuplicateGroup,
    dashboardBuckets,
    dashboardCountryList,
    dashboardWorldMapData,
    database,
    decisionFieldCondition,
    decisionMachineIdSql,
    decisionMachineLabelSql,
    decisionFromRow,
    emptyAlertDecisionSummary,
    escapeLike,
    facetQueryWorker,
    freeTextSearchCondition,
    getAlertCountIndexHint,
    getAlertListFiltersFromValues,
    getAlertSourceValue,
    getAlertTargetSummary,
    getDashboardBucketKey,
    getDashboardBucketKeys,
    getDecisionListFiltersFromValues,
    getDecisionPageIndexHint,
    getEffectiveRequestTimeZoneValue,
    getDateFilterBoundary,
    getSearchFacetSelection,
    getTimeZoneOffsetMs,
    jsonStringArraySql,
    instanceName,
    isAlertSimulated,
    isDecisionListItemExpired,
    likeParam,
    lookbackHours,
    markDuplicateDecisions,
    matchesAlertListFilters,
    matchesDashboardAlertFilters,
    matchesDashboardDecisionFilters,
    matchesDashboardSimulationFilter,
    matchesDecisionListFilters,
    normalizeAlertSimulated,
    normalizedMachineIdSql,
    normalizeDashboardCoordinate,
    normalizeDashboardCountryCode,
    normalizeDecisionSimulated,
    normalizeOrigin,
    parseRecordExtras,
    parseSqlSearchDateValue,
    primaryInstance,
    publishCacheUpdate,
    queryWorker,
    readExtraString,
    readExtraStringArray,
    removeSearchField,
    resolveAlertReason,
    resolveAlertScenario,
    requiresDashboardAlertIpJoin,
    resolveMachineName,
    selectDashboardDecisionPrimary,
    serializeSearchNode,
    targetFieldCondition,
    toDecisionListItem,
    toPaginatedResponse,
    toSlimAlert,
    topDashboardEntries,
    withAlertTargetSummary,
    withInstanceName,
    withoutAlertFacetFilter,
    withoutDecisionFacetFilter,
    delay,
    formatElapsedTime,
    dashboardAttackLocationData,
    DASHBOARD_INDEX_BATCH_SIZE,
    DASHBOARD_LOOP_YIELD_INTERVAL,
    FACET_MAX_LIMIT,
  });

  let syncService: any;

  const deletionServiceState = {
    get pendingAlertDeletionTimeout() { return pendingAlertDeletionTimeout; },
    set pendingAlertDeletionTimeout(value: ReturnType<typeof setTimeout> | null) { pendingAlertDeletionTimeout = value; },
    get pendingAlertDeletionPromise() { return pendingAlertDeletionPromise; },
    set pendingAlertDeletionPromise(value: Promise<void> | null) { pendingAlertDeletionPromise = value; },
    get pendingAlertDeletionRerunRequested() { return pendingAlertDeletionRerunRequested; },
    set pendingAlertDeletionRerunRequested(value: boolean) { pendingAlertDeletionRerunRequested = value; },
    get pendingAlertDeletionStopped() { return pendingAlertDeletionStopped; },
    set pendingAlertDeletionStopped(value: boolean) { pendingAlertDeletionStopped = value; },
  };
  const {
    normalizeDeleteIds,
    validateInstanceEntityRefs,
    groupInstanceEntityRefs,
    normalizeNotificationIds,
    isValidIpOrRange,
    isPermissionError,
    getLapiErrorMessage,
    toFailure,
    deleteAlertFromLapi,
    deleteDecisionFromLapi,
    createDeleteResult,
    clearPendingAlertDeletionTimeout,
    processPendingAlertDeletions,
    deleteAlertsByIds,
    deleteDecisionsByIdsInChunks,
    deleteEntriesByIp,
    handleApiError,
  } = createDeletionService({
    state: deletionServiceState,
    IPV4_RE,
    IPV6_RE,
    config,
    createSqlWhere,
    database,
    getAlertSourceValue,
    getIntervalName,
    invalidateDashboardStatsCache,
    lapiClient,
    normalizeAlertDetail,
    queryWorker,
    runNotificationEvaluation: (...args: any[]) => syncService.runNotificationEvaluation(...args),
    syncWorker,
    updateCacheDelta: (...args: any[]) => syncService.updateCacheDelta(...args),
  });

  const syncServiceState = {
    get reconcileWindowState() { return reconcileWindowState; },
    set reconcileWindowState(value: ReconcileWindowState) { reconcileWindowState = value; },
    get initializationPromise() { return initializationPromise; },
    set initializationPromise(value: Promise<SyncHistorySummary | null> | null) { initializationPromise = value; },
    get cacheRefreshCompletedAt() { return cacheRefreshCompletedAt; },
    set cacheRefreshCompletedAt(value: string | null) { cacheRefreshCompletedAt = value; },
    get cacheRefreshPromise() { return cacheRefreshPromise; },
    set cacheRefreshPromise(value: Promise<void> | null) { cacheRefreshPromise = value; },
    get bootstrapRetryTimeout() { return bootstrapRetryTimeout; },
    set bootstrapRetryTimeout(value: ReturnType<typeof setTimeout> | null) { bootstrapRetryTimeout = value; },
    get bootstrapPromise() { return bootstrapPromise; },
    set bootstrapPromise(value: Promise<boolean> | null) { bootstrapPromise = value; },
    get bootstrapSource() { return bootstrapSource; },
    set bootstrapSource(value: string | null) { bootstrapSource = value; },
    get bootstrapWaitLogged() { return bootstrapWaitLogged; },
    set bootstrapWaitLogged(value: boolean) { bootstrapWaitLogged = value; },
    get lastRequestTime() { return lastRequestTime; },
    set lastRequestTime(value: number) { lastRequestTime = value; },
    get schedulerTimeout() { return schedulerTimeout; },
    set schedulerTimeout(value: ReturnType<typeof setTimeout> | null) { schedulerTimeout = value; },
    get nextRefreshAt() { return nextRefreshAt; },
    set nextRefreshAt(value: string | null) { nextRefreshAt = value; },
    get isSchedulerRunning() { return isSchedulerRunning; },
    set isSchedulerRunning(value: boolean) { isSchedulerRunning = value; },
    get heartbeatTimeout() { return heartbeatTimeout; },
    set heartbeatTimeout(value: ReturnType<typeof setTimeout> | null) { heartbeatTimeout = value; },
    get isHeartbeatSchedulerRunning() { return isHeartbeatSchedulerRunning; },
    set isHeartbeatSchedulerRunning(value: boolean) { isHeartbeatSchedulerRunning = value; },
    get heartbeatPromise() { return heartbeatPromise; },
    set heartbeatPromise(value: Promise<void> | null) { heartbeatPromise = value; },
    get heartbeatFailureLogged() { return heartbeatFailureLogged; },
    set heartbeatFailureLogged(value: boolean) { heartbeatFailureLogged = value; },
    get activeInstanceNetworkSyncs() { return activeInstanceNetworkSyncs; },
    set activeInstanceNetworkSyncs(value: number) { activeInstanceNetworkSyncs = value; },
    get refreshIntervalMs() { return refreshIntervalMs; },
    set refreshIntervalMs(value: number) { refreshIntervalMs = value; },
  };
  syncService = createSyncService({
    state: syncServiceState,
    CAPI_ALERT_ORIGIN,
    COMMUNITY_BLOCKLIST_SOURCE_SCOPE,
    ALERT_RECORD_COLUMNS,
    LEGACY_UNFILTERED_ALERT_ORIGIN_TOKENS,
    LISTS_ALERT_ORIGIN,
    LIST_SOURCE_SCOPE_PREFIX,
    SYNC_DEFER_SEARCH_INDEX_DECISION_THRESHOLD,
    SYNC_WRITE_BATCH_SIZE,
    SYNC_WRITE_DECISION_BATCH_SIZE,
    acquirePublishedRevisionWrite,
    alertFromRow,
    alertMetadataFingerprint,
    cache,
    collectDistinctOrigins,
    config,
    database,
    delay,
    countAlertDecisions,
    dashboardAuth,
    enrichAlertRecordLocations,
    formatElapsedTime,
    getAlertFallbackOrigins,
    getAlertSourceValue,
    getAlertTargets,
    getAlertTargetSummary,
    getDateTimeKey,
    getInstanceSyncRuntime,
    getDashboardStatsIndex,
    getIntervalName,
    getLapiErrorMessage,
    getServerTranslator,
    getTimeZoneOffsetMs,
    getZonedHourlyBucketKeys,
    historicalInstanceSyncPending,
    hydrateAlertWithDecisions,
    initialHistorySyncs,
    instanceLastUpdates,
    instanceNetworkWaiters,
    instanceSyncStatuses,
    invalidateDashboardStatsCache,
    invalidateFacetResponses,
    isAlertSimulated,
    lapiClient,
    lapiClients,
    maxConcurrentInstanceNetworkSyncs,
    normalizeAlertDetail,
    normalizeAlertSimulated,
    normalizeDecisionSimulated,
    normalizeOrigin,
    notificationService,
    onDemandRefreshPreparedContextKey,
    parseGoDuration,
    prepareDashboardStatsAfterRefresh,
    prepareDashboardStatsAfterRefreshInBackground,
    primaryInstance,
    processPendingAlertDeletions,
    publishCacheUpdate,
    queryWorker,
    reconcileConfigFingerprint,
    resetReconcileWindowState,
    resolveAlertHistoryAt,
    resolveAlertReason,
    resolveAlertScenario,
    resolveMachineName,
    saveReconcileWindowState,
    syncStatus,
    syncWorker,
    toDuration,
    usesSingleScopeAlertQuery,
    withInstanceName,
    withInstanceNetworkSlot,
  });
  const {
    runNotificationEvaluation,
    syncHistory,
    syncAlertWindow,
    updateCacheDelta,
    refreshLatestWindow,
    refreshFullHistory,
    runConsistentDatabaseRefresh,
    updateCache,
    prepareReadCache,
    prepareOnDemandRefresh,
    ensureBootstrapReady,
    startRefreshScheduler,
    stopRefreshScheduler,
    startHeartbeatScheduler,
    stopHeartbeatScheduler,
    activityTrackerMiddleware,
    ensureAuth,
  } = syncService;

  app.use('*', compress());
  app.use('*', async (context, next) => {
    const cspNonce = crypto.randomBytes(16).toString('base64');
    (context as HonoContext).set('cspNonce', cspNonce);
    await next();
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('X-Frame-Options', 'DENY');
    context.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    context.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    context.header(
      'Content-Security-Policy',
      `default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self' 'nonce-${cspNonce}'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:`,
    );
    const pathname = new URL(context.req.url).pathname;
    const apiPrefix = `${config.basePath}/api/`;
    if (pathname.startsWith(apiPrefix) || pathname === `${config.basePath}/api`) {
      context.header('Cache-Control', 'private, no-store');
      context.header('Pragma', 'no-cache');
      context.header('Expires', '0');
    }
  });

  app.use(`${config.basePath}/api/*`, bodyLimit({
    maxSize: API_BODY_LIMIT_BYTES,
    onError: (context) => context.json({ error: 'Request body is too large' }, 413),
  }));
  app.use(`${config.basePath}/api/*`, async (context, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(context.req.method) && !isRequestOriginAllowed(context)) {
      return context.json({ error: 'Cross-origin request rejected' }, 403);
    }
    await next();
  });
  app.use('*', activityTrackerMiddleware);

  const healthHandler = (context: HonoContext) => context.json({ status: 'ok' });
  app.get('/api/health', healthHandler);
  if (config.basePath) {
    app.get(`${config.basePath}/api/health`, healthHandler);
  }
  dashboardAuth.registerRoutes(app);

  const ensureCanManageEnforcement = (context: HonoContext) => {
    if (dashboardAuth.getPermissions(context).can_manage_enforcement) return null;
    return context.json({ error: 'Read-only mode is enabled', code: 'READ_ONLY' }, 403);
  };

  const ensureCanManageSettings = (context: HonoContext) => {
    if (dashboardAuth.getPermissions(context).can_manage_settings) return null;
    return context.json({ error: 'Read-only mode is enabled', code: 'READ_ONLY' }, 403);
  };

  const ensurePublishedRevisionRead = async (context: HonoContext, next: HonoNext) => {
    if (refreshIntervalMs === 0) {
      await updateCache({ skipIfBusy: true });
      context.set(onDemandRefreshPreparedContextKey, true);
    }
    const releaseRevision = await acquirePublishedRevisionRead();
    try {
      await next();
    } finally {
      releaseRevision();
    }
  };

  const apiRouteState = {
    get refreshIntervalMs() { return refreshIntervalMs; },
    set refreshIntervalMs(value: number) { refreshIntervalMs = value; },
    get manualRefreshEnabled() { return manualRefreshEnabled; },
    set manualRefreshEnabled(value: boolean) { manualRefreshEnabled = value; },
    get metricsSidebarVisible() { return metricsSidebarVisible; },
    set metricsSidebarVisible(value: boolean) { metricsSidebarVisible = value; },
    get cacheRefreshCompletedAt() { return cacheRefreshCompletedAt; },
    set cacheRefreshCompletedAt(value: string | null) { cacheRefreshCompletedAt = value; },
    cache,
    initialHistorySyncs,
    instanceLastUpdates,
    staleDashboardStatsResponseCache,
    get lastDashboardStatsFilters() { return lastDashboardStatsFilters; },
    set lastDashboardStatsFilters(value: DashboardStatsFilters | null) { lastDashboardStatsFilters = value; },
    get lastDashboardStatsRequestedAt() { return lastDashboardStatsRequestedAt; },
    set lastDashboardStatsRequestedAt(value: number) { lastDashboardStatsRequestedAt = value; },
    historicalInstanceSyncPending,
    get nextRefreshAt() { return nextRefreshAt; },
    get cacheRefreshPromise() { return cacheRefreshPromise; },
    get initializationPromise() { return initializationPromise; },
    get bootstrapPromise() { return bootstrapPromise; },
  };
  registerApiRoutes({
    app,
    state: apiRouteState,
    ALERT_FACET_FIELDS,
    DECISION_FACET_FIELDS,
    analyticsQueryWorker,
    attackLocationResolver,
    aggregateHistoricalSyncStatus,
    aggregateLapiStatus,
    applySimulationModeToAlert,
    auditLog,
    buildDashboardStats,
    checkForUpdates,
    compileAlertSearch,
    compileDecisionSearch,
    config,
    createDeleteResult,
    createEmptyDashboardStatsResponse,
    createSqlWhere,
    dashboardAuth,
    database,
    deleteAlertFromLapi,
    deleteAlertsByIds,
    deleteDecisionFromLapi,
    deleteDecisionsByIdsInChunks,
    deleteEntriesByIp,
    deleteEntriesByIpOnInstance,
    enrichAlertLocations,
    enrichAlertRecordLocations,
    enrichDecisionLocations,
    ensureAuth,
    ensureBootstrapReady,
    ensureCanManageEnforcement,
    ensureCanManageSettings,
    ensurePublishedRevisionRead,
    fetchCrowdsecMetrics,
    getAlertCoordinatesByIds,
    getAlertListFilters,
    getDashboardStatsFilters,
    getDecisionListFilters,
    getEffectiveRequestTimeZone,
    getFacetRequest,
    getInstanceSyncRuntime,
    getIntervalName,
    getLapiErrorMessage,
    getPageRequest,
    getStaleDashboardStatsResponseCacheKey,
    handleApiError,
    hydrateAlertsBatch,
    hydrateAlertWithDecisions,
    groupInstanceEntityRefs,
    invalidateDashboardStatsCache,
    instanceSyncStatuses,
    isDashboardStatsBuildInProgress,
    isPermissionError,
    isValidIpOrRange,
    lapiClient,
    lapiClients,
    lookbackHours,
    markDuplicateDecisions,
    normalizeAlertDetail,
    normalizeDeleteIds,
    normalizeLanguagePreference,
    normalizeNotificationIds,
    notificationService,
    options,
    prepareOnDemandRefresh,
    prepareReadCache,
    parseRefreshInterval,
    primaryInstance,
    queryAlertFacet,
    queryDecisionFacet,
    queryPaginatedAlerts,
    queryPaginatedDecisions,
    QueryWorkerTimeoutError,
    readUpdateCheckOverrides,
    resetReconcileWindowState,
    refreshFullHistory,
    refreshLatestWindow,
    resolveOperationInstances,
    runConsistentDatabaseRefresh,
    runNotificationEvaluation,
    saveLanguagePreference,
    saveMetricsSidebarVisible,
    savePersistedConfig,
    startRefreshScheduler,
    syncStatus,
    syncInstanceDelta,
    syncWorker,
    toDecisionListItem,
    toFailure,
    toPaginatedResponse,
    toSearchErrorResponse,
    toSlimAlert,
    updateCache,
    updateCacheDelta,
    validateInstanceEntityRefs,
    noteDashboardStatsRequest,
    warmDashboardStatsCache,
    withAlertTargetSummary,
    withInstanceName,
    decisionFromRow,
  });

  app.use(`${config.basePath}/assets/*`, async (context, next) => {
    context.header('Cache-Control', 'public, max-age=31536000, immutable');
    await next();
  });

  app.use(
    `${config.basePath}/assets/*`,
    serveStatic({
      root: distRoot,
      rewriteRequestPath: (requestPath) => (config.basePath ? requestPath.replace(config.basePath, '') : requestPath),
    }),
  );

  app.get(`${config.basePath}/assets/*`, (context) => {
    context.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    context.header('Pragma', 'no-cache');
    return context.text('Not Found', 404);
  });

  app.use(`${config.basePath}/world-50m.json`, async (context, next) => {
    context.header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    await next();
  });

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
      const requestPath = new URL(context.req.url).pathname;
      const rootPath = config.basePath ? `${config.basePath}/` : '/';
      if (options.rootRedirectPath && requestPath === rootPath) {
        const redirectPath = `${config.basePath}${options.rootRedirectPath.startsWith('/') ? options.rootRedirectPath : `/${options.rootRedirectPath}`}`;
        return context.redirect(redirectPath);
      }

      const indexPath = path.join(distRoot, 'index.html');
      let html = fs.readFileSync(indexPath, 'utf-8');
      const safePath = config.basePath.replace(/[^a-zA-Z0-9/_-]/g, '');
      const cspNonce = String((context as HonoContext).get('cspNonce') || '');
      const configScript = `<script nonce="${cspNonce}">window.__BASE_PATH__="${safePath}";</script>`;
      html = html.replace('</head>', `${configScript}\n</head>`);

      if (config.basePath) {
        html = html.replace(/href="\.\//g, `href="${config.basePath}/`);
        html = html.replace(/src="\.\//g, `src="${config.basePath}/`);
      }

      context.header('Cache-Control', 'no-store, no-cache, must-revalidate');
      context.header('Pragma', 'no-cache');
      context.header('Expires', '0');
      return context.html(html);
    } catch {
      return context.text('Not Found', 404);
    }
  });

  if (config.basePath) {
    app.get('/', (context) => context.redirect(`${config.basePath}/`));
  }

  async function syncInstanceDelta(instanceId: string): Promise<void> {
    if (instanceRefreshPromises.has(instanceId)) return instanceRefreshPromises.get(instanceId)!;
    const instance = config.instances.find((candidate) => candidate.id === instanceId);
    if (!instance) return;
    const runtime = getInstanceSyncRuntime(instanceId);
    const promise = withInstanceNetworkSlot(async () => {
      const { client, status } = runtime;
      status.isSyncing = true;
      status.state = 'syncing';
      status.progress = 5;
      status.startedAt = new Date().toISOString();
      status.completedAt = null;
      status.errors = [];
      status.message = `Syncing ${instance.name}`;
      try {
        const refreshMs = instance.sync.refreshIntervalMs ?? refreshIntervalMs;
        if (!client.hasToken() && !await client.login(`instance ${instance.name}`)) {
          throw new Error(client.getStatus().lastError || 'Authentication failed');
        }
        const now = Date.now();
        const previousUpdate = instanceLastUpdates.get(instanceId);
        const previousUpdateMs = previousUpdate ? Date.parse(previousUpdate) : Number.NaN;
        const overlapMs = Math.max(refreshMs, 60_000) + 60_000;
        const start = Number.isFinite(previousUpdateMs)
          ? Math.max(now - runtime.lookbackMs, previousUpdateMs - 10_000)
          : Math.max(now - runtime.lookbackMs, now - overlapMs);
        const committedRefresh = await runConsistentDatabaseRefresh(async () => {
          const summary = await syncAlertWindow(start, now, now, (window: string, alerts: number, decisions: number) => {
            status.progress = 60;
            status.message = getServerTranslator(database)('components.syncOverlay.statusProcessingWindow', {
              window,
              alerts,
              decisions,
            });
          }, runtime);
          if (summary.errors.length > 0) {
            throw summary.lastError || new Error(summary.errors.join('; '));
          }
          await syncWorker.refreshDecisionDuplicateFlags(new Date().toISOString());
          return summary;
        });
        let publishedRevision: string | null = null;
        try {
          const summary = committedRefresh.result;
          client.updateStatus(true);
          status.state = 'complete';
          status.progress = 100;
          status.message = `${instance.name} sync complete`;
          status.errors = [];
          instanceLastUpdates.set(instanceId, new Date(now).toISOString());
          prepareDashboardStatsAfterRefreshInBackground(
            summary.changed,
            instanceId,
            `${instance.name} update`,
            summary.changed
              ? undefined
              : () => {
                  const revision = new Date().toISOString();
                  cacheRefreshCompletedAt = revision;
                  publishCacheUpdate(revision, [instanceId]);
                },
          );
          if (summary.changed) {
            const revision = new Date().toISOString();
            cacheRefreshCompletedAt = revision;
            publishedRevision = revision;
          }
          console.log(`[${instance.name}] Delta update complete: ${summary.alerts} alerts and ${summary.decisions} decisions synced.`);
        } finally {
          committedRefresh.releasePublishedRevision();
        }
        if (publishedRevision) publishCacheUpdate(publishedRevision, [instanceId]);
      } catch (error: any) {
        client.updateStatus(false, error);
        status.state = 'failed';
        status.progress = 0;
        status.message = `${instance.name} sync failed`;
        status.errors = [error?.message || String(error)];
      } finally {
        status.isSyncing = false;
        status.completedAt = new Date().toISOString();
      }
    }).finally(() => instanceRefreshPromises.delete(instanceId));
    instanceRefreshPromises.set(instanceId, promise);
    return promise;
  }

  function resolveOperationInstances(scope: 'all' | 'instance' | undefined, instanceId: string | undefined) {
    if (!scope) return [primaryInstance];
    if (scope === 'all') return config.instances;
    const instance = config.instances.find((candidate) => candidate.id === instanceId);
    return instance ? [instance] : { error: 'A valid instance_id is required when scope is instance' };
  }

  async function deleteEntriesByIpOnInstance(instanceId: string, ip: string): Promise<BulkDeleteResult> {
    const instance = config.instances.find((candidate) => candidate.id === instanceId);
    const client = lapiClients.get(instanceId);
    if (!instance || !client) throw new Error(`Unknown CrowdSec instance ${instanceId}`);
    if (!client.hasToken() && !await client.login(`cleanup ${instance.name}`)) {
      throw new Error(client.getStatus().lastError || 'Authentication failed');
    }
    const alerts = (await client.fetchAlerts(instance.sync.lookbackPeriod || config.lookbackPeriod)) as AlertRecord[];
    const matching = alerts.filter((alert) => getAlertSourceValue(alert.source) === ip);
    const result: BulkDeleteResult = {
      requested_alerts: matching.length,
      requested_decisions: matching.reduce((count, alert) => count + (alert.decisions?.length || 0), 0),
      deleted_alerts: 0,
      deleted_decisions: 0,
      failed: [],
      ip,
    };
    for (const alert of matching) {
      for (const decision of alert.decisions || []) {
        try {
          await client.deleteDecision(String(decision.id));
          result.deleted_decisions += 1;
        } catch (error: any) {
          result.failed.push({ kind: 'decision', id: String(decision.id), error: error?.message || String(error) });
        }
      }
      try {
        await client.deleteAlert(String(alert.id));
        result.deleted_alerts += 1;
      } catch (error: any) {
        result.failed.push({ kind: 'alert', id: String(alert.id), error: error?.message || String(error) });
      }
    }
    await syncInstanceDelta(instanceId);
    return result;
  }

  function scheduleInstanceRefresh(instanceId: string): void {
    const instance = config.instances.find((candidate) => candidate.id === instanceId);
    if (!instance) return;
    const interval = instance.sync.refreshIntervalMs ?? refreshIntervalMs;
    if (interval <= 0) return;
    const delayMs = interval;
    const timer = setTimeout(() => {
      void syncInstanceDelta(instanceId).finally(() => scheduleInstanceRefresh(instanceId));
    }, delayMs);
    timer.unref();
    instanceRefreshTimers.set(instanceId, timer);
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
    lapiClients,
    startBackgroundTasks,
    stopBackgroundTasks: () => {
      pendingAlertDeletionStopped = true;
      stopRefreshScheduler();
      stopHeartbeatScheduler();
      clearPendingAlertDeletionTimeout();
      for (const timer of instanceRefreshTimers.values()) clearTimeout(timer);
      instanceRefreshTimers.clear();
      historicalInstanceSyncPending.clear();
      queryWorker.close();
      if (analyticsQueryWorker !== queryWorker) analyticsQueryWorker.close();
      facetQueryWorker.close();
      syncWorker.close();
      cacheUpdateListeners.clear();
    },
    getSyncStatus: () => aggregateHistoricalSyncStatus(),
    getLapiStatus: () => lapiClient.getStatus(),
    getCacheLastUpdate: () => cacheRefreshCompletedAt,
    subscribeCacheUpdates: (listener) => {
      cacheUpdateListeners.add(listener);
      return () => cacheUpdateListeners.delete(listener);
    },
  };

  function startBackgroundTasks(): void {
    if (!lapiClient.hasAuthConfig()) {
      console.warn('Cache initialization skipped - CrowdSec LAPI authentication not configured');
      return;
    }
    startHeartbeatScheduler();
    startRefreshScheduler();
    if (config.instances.length > 1 && !cache.isInitialized) {
      for (const instance of config.instances) historicalInstanceSyncPending.add(instance.id);
    }
    void ensureBootstrapReady('startup').then(() => {
      for (const instance of config.instances.slice(1)) scheduleInstanceRefresh(instance.id);
    });
  }

}
