import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import type {
  AddDecisionRequest,
  AlertDecision,
  AlertDecisionSummary,
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
  CrowdsecMetricsResponse,
  DecisionListItem,
  FacetField,
  FacetResponse,
  InstanceEntityRef,
  LapiStatus,
  PaginatedResponse,
  SlimAlert,
  StatsAlert,
  StatsDecision,
  SyncStatus,
  UpdateManualRefreshSettingRequest,
  UpdateMetricsSidebarPreferenceRequest,
  UpsertNotificationChannelRequest,
  UpsertNotificationRuleRequest,
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
import { getAlertSourceValue, getAlertTarget, resolveAlertHistoryAt, resolveAlertReason, resolveAlertScenario, toSlimAlert } from './utils/alerts';
import { parseGoDuration, toDuration } from './utils/duration';
import { fetchCrowdsecMetrics } from './metrics';
import { DatabaseQueryWorker, QueryWorkerTimeoutError } from './query-worker-client';
import { DatabaseSyncWorker, type SyncAlertMutation } from './sync-worker-client';

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
  >;
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

interface PersistedConfig {
  refresh_interval_ms?: number;
  manual_refresh_enabled?: boolean;
}

const METRICS_SIDEBAR_VISIBLE_META_KEY = 'metrics_sidebar_visible';
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

interface AlertSyncQuery {
  origin?: string;
  scenario?: string;
  includeCapi?: boolean;
  singleScopeOnly?: boolean;
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

interface WindowSyncSummary {
  alerts: number;
  decisions: number;
  errors: string[];
  successfulWindows: number;
  changed: boolean;
  lastError?: Error;
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

interface ReconcileWindow {
  key: string;
  start: number;
  end: number;
  active: boolean;
  intervalMs: number;
  lastSuccess: number;
  head?: boolean;
}

interface ReconcilePlan {
  windows: ReconcileWindow[];
  currentKeys: Set<string>;
}

interface CachedDecisionRecord {
  id: string;
  value?: string;
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

interface FacetRequest {
  field: FacetField;
  search: string;
  offset: number;
  limit: number;
}

interface AlertListFilters {
  instanceId: string;
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
  timeZone: string | null;
}

interface DecisionListFilters {
  instanceId: string;
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
  timeZone: string | null;
}

interface DashboardStatsFilters {
  instanceId: string;
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
  timeZone: string | null;
}

interface DashboardStatsCache {
  key: string;
  scope: string;
  alerts: DashboardAlertStatsRecord[];
  decisions: DashboardDecisionStatsRecord[];
  totals: DashboardStatsTotals;
}

interface DashboardAlertStatsRecord {
  instanceId: string;
  createdAt: string;
  timestamp: number;
  country?: string;
  scenario?: string;
  asName?: string;
  ip?: string;
  latitude?: number;
  longitude?: number;
  target?: string;
  simulated: boolean;
}

interface DashboardDecisionStatsRecord {
  instanceId: string;
  createdAt: string;
  stopAt?: string;
  timestamp: number;
  stopTimestamp: number;
  value?: string;
  country?: string;
  simulated: boolean;
}

interface DashboardStatsAccumulator {
  alerts: number;
  liveAlerts: number;
  simulatedAlerts: number;
  countries: Map<string, { count: number; liveCount: number; simulatedCount: number }>;
  attackLocations: DashboardAttackLocationAccumulator;
  scenarios: Map<string, number>;
  asNames: Map<string, number>;
  targets: Map<string, number>;
  liveAlertBuckets: Map<string, number>;
  simulatedAlertBuckets: Map<string, number>;
}

interface DashboardDecisionAccumulator {
  decisions: number;
  simulatedDecisions: number;
  countries: Map<string, {
    liveDecisionCount: number;
    simulatedDecisionCount: number;
    activeLiveDecisionCount: number;
    activeSimulatedDecisionCount: number;
  }>;
  liveDecisionBuckets: Map<string, number>;
  simulatedDecisionBuckets: Map<string, number>;
  activeLiveDecisionBuckets: Map<string, number>;
  activeSimulatedDecisionBuckets: Map<string, number>;
}
const NOTIFICATION_SECRET_KEY_META_KEY = 'notification_secret_key';
const API_BODY_LIMIT_BYTES = 1024 * 1024;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const DASHBOARD_LOOP_YIELD_INTERVAL = 5_000;
const DASHBOARD_INDEX_BATCH_SIZE = 5_000;
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
  const dashboardStatsScopeVersions = new Map<string, number>([
    ['all', 0],
    ...config.instances.map((instance) => [instance.id, 0] as const),
  ]);
  const dashboardStatsReadyPublishedKeys = new Set<string>();
  const dashboardStatsResponseCache = new Map<string, DashboardStatsResponse>();
  const staleDashboardStatsResponseCache = new Map<string, DashboardStatsResponse>();
  const dashboardStatsIndexPromises = new Map<string, Promise<DashboardStatsCache>>();
  const dashboardStatsResponsePromises = new Map<string, Promise<DashboardStatsResponse>>();
  let lastDashboardStatsFilters: DashboardStatsFilters | null = null;

  const persistedConfig = loadPersistedConfig(database);
  let refreshIntervalMs = persistedConfig.refresh_interval_ms ?? config.refreshIntervalMs;
  let manualRefreshEnabled = persistedConfig.manual_refresh_enabled ?? config.manualRefreshEnabled;
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
`);

  if (!lapiClient.hasAuthConfig()) {
    console.warn(
      'WARNING: CrowdSec LAPI authentication is not configured. Configure instances[].lapi.auth in the application YAML (recommended), or use the legacy CrowdSec authentication environment variables.',
    );
  }

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

  app.get(`${config.basePath}/api/alerts`, ensureAuth, async (context) => {
    try {
      if (refreshIntervalMs === 0) {
        await updateCache({ skipIfBusy: true });
      }

      await prepareReadCache('alerts request');

      const pageRequest = getPageRequest(context);
      if (pageRequest) {
        const filters = getAlertListFilters(context, config.timeZone);
        const compiledSearch = compileAlertSearch(filters.q, {
          machineEnabled: true,
          originEnabled: true,
        }, {
          timezoneOffsetMinutes: filters.timezoneOffsetMinutes,
          timeZone: filters.timeZone,
        });
        if (!compiledSearch.ok) {
          return context.json(toSearchErrorResponse(compiledSearch.error), 400);
        }
        return context.json(await queryPaginatedAlerts(
          pageRequest,
          filters,
          compiledSearch.ast,
          context.req.query('include_decisions') !== 'false',
        ));
      }

      const since = new Date(Date.now() - config.lookbackMs).toISOString();
      const alerts = hydrateAlertsBatch(database.getAlertsSince(since))
        .map((alert) => applySimulationModeToAlert(alert, config.simulationsEnabled))
        .filter((alert): alert is AlertRecord => alert !== null)
        .map((alert) => toSlimAlert(alert))
        .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());

      return context.json(await enrichAlertLocations(alerts));
    } catch (error: any) {
      if (error instanceof QueryWorkerTimeoutError) {
        console.warn('Timed out serving alerts from database:', error.message);
        return context.json({ error: 'Alert query timed out' }, 504);
      }
      console.error('Error serving alerts from database:', error.message);
      return context.json({ error: 'Failed to retrieve alerts' }, 500);
    }
  });

  app.get(`${config.basePath}/api/alerts/facets`, ensureAuth, async (context) => {
    const request = getFacetRequest(context, ALERT_FACET_FIELDS);
    if ('error' in request) {
      return context.json({ error: request.error }, 400);
    }

    try {
      if (refreshIntervalMs === 0) {
        await updateCache({ skipIfBusy: true });
      }
      await prepareReadCache('alert facets request');

      const filters = getAlertListFilters(context, config.timeZone);
      const compiledSearch = compileAlertSearch(filters.q, {
        machineEnabled: true,
        originEnabled: true,
      }, {
        timezoneOffsetMinutes: filters.timezoneOffsetMinutes,
        timeZone: filters.timeZone,
      });
      if (!compiledSearch.ok) {
        return context.json(toSearchErrorResponse(compiledSearch.error), 400);
      }

      return context.json(await queryAlertFacet(request, filters, compiledSearch.ast));
    } catch (error: any) {
      if (error instanceof QueryWorkerTimeoutError) {
        return context.json({ error: 'Facet query timed out' }, 504);
      }
      console.error('Error serving alert facets from database:', error.message);
      return context.json({ error: 'Failed to retrieve alert facets' }, 500);
    }
  });

  app.post(`${config.basePath}/api/alerts/bulk-delete`, ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageEnforcement(context);
    if (readOnlyResponse) return readOnlyResponse;

    const doRequest = async () => {
      const body = await context.req.json<BulkDeleteRequest>();
      if (Array.isArray(body.refs) && body.refs.length > 0) {
        const validated = validateInstanceEntityRefs(body.refs);
        if ('error' in validated) return context.json({ error: validated.error }, 400);
        const result = createDeleteResult({ requested_alerts: validated.length });
        const groups = groupInstanceEntityRefs(validated);
        await Promise.all(Array.from(groups, async ([instanceId, ids]) => {
          const client = lapiClients.get(instanceId)!;
          for (const id of ids) {
            try {
              await client.deleteAlert(id);
              await syncWorker.runExclusive(() => database.deleteAlertByInstanceId(instanceId, id));
              result.deleted_alerts += 1;
            } catch (error) {
              result.failed.push(toFailure('alert', `${instanceId}:${id}`, error as AnyError));
            }
          }
        }));
        invalidateDashboardStatsCache();
        return context.json(result);
      }
      if (!Array.isArray(body.ids) || body.ids.length === 0) {
        return context.json({ error: 'At least one alert ID is required' }, 400);
      }
      if (config.instances.length > 1) {
        return context.json({ error: 'Structured instance refs are required when multiple CrowdSec instances are configured' }, 400);
      }
      const ids = normalizeDeleteIds(body.ids);
      if (ids.length !== body.ids.length) {
        return context.json({ error: 'Alert IDs must be numeric' }, 400);
      }

      const result = await deleteAlertsByIds(ids);
      if (result.deleted_decisions > 0) {
        void runNotificationEvaluation('bulk alert delete');
      }
      return context.json(result);
    };

    try {
      return await doRequest();
    } catch (error) {
      return handleApiError(error as AnyError, context, 'bulk deleting alerts', doRequest);
    }
  });

  app.get(`${config.basePath}/api/alerts/:id`, ensureAuth, async (context) => {
    if (config.instances.length > 1) return context.json({ error: 'instance_id is required when multiple CrowdSec instances are configured' }, 400);
    const alertId = String(context.req.param('id'));
    if (!/^\d+$/.test(alertId)) {
      return context.json({ error: 'Invalid alert ID' }, 400);
    }

    const doRequest = async () => {
      if (context.req.query('include_decisions') === 'false') {
        const snapshot = database.getAlertDecisionSnapshot(alertId);
        let alert = snapshot ? normalizeAlertDetail(JSON.parse(snapshot.raw_data), alertId) : null;
        if (!alert) {
          alert = normalizeAlertDetail(await lapiClient.getAlertById(alertId), alertId);
        }
        if (!alert) {
          return context.json({ error: 'Alert not found' }, 404);
        }
        const payload = applySimulationModeToAlert({ ...alert, decisions: [] }, config.simulationsEnabled);
        return payload ? context.json(payload) : context.json({ error: 'Alert not found' }, 404);
      }

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
    if (config.instances.length > 1) return context.json({ error: 'instance_id is required when multiple CrowdSec instances are configured' }, 400);
    const readOnlyResponse = ensureCanManageEnforcement(context);
    if (readOnlyResponse) return readOnlyResponse;

    const alertId = String(context.req.param('id'));
    if (!/^\d+$/.test(alertId)) {
      return context.json({ error: 'Invalid alert ID' }, 400);
    }

    const doRequest = async () => {
      const result = await deleteAlertsByIds([alertId]);
      if (result.deleted_decisions > 0) {
        void runNotificationEvaluation('alert decision delete');
      }
      return context.json(result);
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
        await updateCache({ skipIfBusy: true });
      }

      await prepareReadCache('decisions request');

      const pageRequest = getPageRequest(context);
      const includeExpired = context.req.query('include_expired') === 'true';
      if (pageRequest) {
        const filters = getDecisionListFilters(context, config.timeZone);
        const compiledSearch = compileDecisionSearch(filters.q, {
          machineEnabled: true,
          originEnabled: true,
        }, {
          timezoneOffsetMinutes: filters.timezoneOffsetMinutes,
          timeZone: filters.timeZone,
        });
        if (!compiledSearch.ok) {
          return context.json(toSearchErrorResponse(compiledSearch.error), 400);
        }
        return context.json(await queryPaginatedDecisions(pageRequest, filters, compiledSearch.ast, includeExpired));
      }

      const now = new Date().toISOString();
      const since = new Date(Date.now() - config.lookbackMs).toISOString();
      const rows = includeExpired
        ? database.getDecisionsSince(since, now)
        : database.getActiveDecisions(now);

      const alertCoordinates = await getAlertCoordinatesByIds(rows.map((row) => row.alert_id));

      let decisions = rows.map((row) => toDecisionListItem(decisionFromRow(row), includeExpired));
      if (!config.simulationsEnabled) {
        decisions = decisions.filter((decision) => !decision.simulated);
      }
      decisions = markDuplicateDecisions(decisions);
      decisions.sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());
      decisions = await enrichDecisionLocations(decisions, alertCoordinates);

      return context.json(decisions);
    } catch (error: any) {
      if (error instanceof QueryWorkerTimeoutError) {
        console.warn('Timed out serving decisions from database:', error.message);
        return context.json({ error: 'Decision query timed out' }, 504);
      }
      console.error('Error serving decisions from database:', error.message);
      return context.json({ error: 'Failed to retrieve decisions' }, 500);
    }
  });

  app.get(`${config.basePath}/api/decisions/facets`, ensureAuth, async (context) => {
    const request = getFacetRequest(context, DECISION_FACET_FIELDS);
    if ('error' in request) {
      return context.json({ error: request.error }, 400);
    }

    try {
      if (refreshIntervalMs === 0) {
        await updateCache({ skipIfBusy: true });
      }
      await prepareReadCache('decision facets request');

      const filters = getDecisionListFilters(context, config.timeZone);
      const compiledSearch = compileDecisionSearch(filters.q, {
        machineEnabled: true,
        originEnabled: true,
      }, {
        timezoneOffsetMinutes: filters.timezoneOffsetMinutes,
        timeZone: filters.timeZone,
      });
      if (!compiledSearch.ok) {
        return context.json(toSearchErrorResponse(compiledSearch.error), 400);
      }

      return context.json(await queryDecisionFacet(
        request,
        filters,
        compiledSearch.ast,
        context.req.query('include_expired') === 'true',
      ));
    } catch (error: any) {
      if (error instanceof QueryWorkerTimeoutError) {
        return context.json({ error: 'Facet query timed out' }, 504);
      }
      console.error('Error serving decision facets from database:', error.message);
      return context.json({ error: 'Failed to retrieve decision facets' }, 500);
    }
  });

  app.get(`${config.basePath}/api/instances/:instanceId/alerts/:id`, ensureAuth, async (context) => {
    const instanceId = String(context.req.param('instanceId'));
    const instance = config.instances.find((candidate) => candidate.id === instanceId);
    if (!instance) return context.json({ error: 'Unknown CrowdSec instance' }, 404);
    try {
      const alert = normalizeAlertDetail(await lapiClients.get(instanceId)!.getAlertById(context.req.param('id')), context.req.param('id'));
      return alert ? context.json(withInstanceName({ ...alert, instance_id: instanceId })) : context.json({ error: 'Alert not found' }, 404);
    } catch (error: any) {
      return context.json({ error: error?.message || 'Failed to retrieve alert' }, error?.status === 404 ? 404 : 502);
    }
  });

  app.delete(`${config.basePath}/api/instances/:instanceId/alerts/:id`, ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageEnforcement(context);
    if (readOnlyResponse) return readOnlyResponse;
    const instanceId = String(context.req.param('instanceId'));
    const instance = config.instances.find((candidate) => candidate.id === instanceId);
    if (!instance) return context.json({ error: 'Unknown CrowdSec instance' }, 404);
    try {
      await lapiClients.get(instanceId)!.deleteAlert(context.req.param('id'));
      await syncWorker.runExclusive(() => database.deleteAlertByInstanceId(instanceId, context.req.param('id')));
      invalidateDashboardStatsCache();
      return context.json({
        requested_alerts: 1,
        requested_decisions: 0,
        deleted_alerts: 1,
        deleted_decisions: 0,
        failed: [],
      } satisfies BulkDeleteResult);
    } catch (error: any) {
      return context.json({ error: error?.message || 'Failed to delete alert' }, 502);
    }
  });

  app.delete(`${config.basePath}/api/instances/:instanceId/decisions/:id`, ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageEnforcement(context);
    if (readOnlyResponse) return readOnlyResponse;
    const instanceId = String(context.req.param('instanceId'));
    const instance = config.instances.find((candidate) => candidate.id === instanceId);
    if (!instance) return context.json({ error: 'Unknown CrowdSec instance' }, 404);
    try {
      await lapiClients.get(instanceId)!.deleteDecision(context.req.param('id'));
      await syncWorker.runExclusive(() => database.deleteDecisionByInstanceId(instanceId, context.req.param('id')));
      invalidateDashboardStatsCache();
      return context.json({ message: 'Deleted' });
    } catch (error: any) {
      return context.json({ error: error?.message || 'Failed to delete decision' }, 502);
    }
  });

  app.get(`${config.basePath}/api/config`, ensureAuth, (context) => {
    const hours = lookbackHours(config.lookbackPeriod);
    const payload: ConfigResponse = {
      lookback_period: config.lookbackPeriod,
      lookback_hours: hours,
      lookback_days: Math.max(1, Math.round(hours / 24)),
      refresh_interval: refreshIntervalMs,
      manual_refresh_enabled: manualRefreshEnabled,
      current_interval_name: getIntervalName(refreshIntervalMs),
      lapi_status: lapiClient.getStatus(),
      instances: config.instances.map((instance) => ({
        id: instance.id,
        name: instance.name,
        icon: instance.icon,
        lapi_status: lapiClients.get(instance.id)!.getStatus(),
        sync_status: { ...(instanceSyncStatuses.get(instance.id) || syncStatus) },
        prometheus: instance.prometheus.map((endpoint) => ({ id: endpoint.id, name: endpoint.name })),
        sync_overrides: { ...instance.sync },
      })),
      aggregate_lapi_status: aggregateLapiStatus(),
      sync_status: aggregateHistoricalSyncStatus(),
      cache_last_update: cacheRefreshCompletedAt,
      next_refresh_at: nextRefreshAt,
      simulations_enabled: config.simulationsEnabled,
      machine_features_enabled: true,
      origin_features_enabled: true,
      time_zone: config.timeZone,
      time_format: config.timeFormat,
      metrics_enabled: config.instances.some((instance) => instance.prometheus.length > 0),
      metrics_sidebar_visible: loadMetricsSidebarVisible(database),
      ...(config.deploymentMode === 'load-test' ? { deployment_mode: config.deploymentMode } : {}),
      ...(config.loadTestProfile ? { load_test_profile: config.loadTestProfile } : {}),
      permissions: dashboardAuth.getPermissions(context),
    };

    return context.json(payload);
  });

  app.get(`${config.basePath}/api/instances`, ensureAuth, (context) => context.json({
    data: config.instances.map((instance) => ({
      id: instance.id,
      name: instance.name,
      icon: instance.icon,
      lapi_status: lapiClients.get(instance.id)!.getStatus(),
      sync_status: { ...(instanceSyncStatuses.get(instance.id) || syncStatus) },
      prometheus: instance.prometheus.map((endpoint) => ({ id: endpoint.id, name: endpoint.name })),
      sync_overrides: { ...instance.sync },
    })),
    aggregate_status: aggregateLapiStatus(),
  }));

  app.get(`${config.basePath}/api/metrics/crowdsec`, ensureAuth, async (context) => {
    const endpoint = primaryInstance.prometheus[0];
    if (!endpoint) {
      return context.json({ error: 'CrowdSec Prometheus metrics are not enabled' }, 404);
    }

    try {
      const payload: CrowdsecMetricsResponse = await fetchCrowdsecMetrics({
        url: endpoint.url,
        timeoutMs: endpoint.requestTimeoutMs || config.prometheusRequestTimeoutMs,
        auth: endpoint.auth,
        tls: endpoint.tls,
        fetchImpl: options.metricsFetchImpl,
      });

      return context.json(payload);
    } catch (error: any) {
      const message = error?.message || 'Failed to read CrowdSec Prometheus metrics';
      console.error('Error fetching CrowdSec Prometheus metrics:', message);
      return context.json({ error: message }, 502);
    }
  });

  app.get(`${config.basePath}/api/instances/:instanceId/metrics/:endpointId`, ensureAuth, async (context) => {
    const instance = config.instances.find((candidate) => candidate.id === context.req.param('instanceId'));
    const endpoint = instance?.prometheus.find((candidate) => candidate.id === context.req.param('endpointId'));
    if (!instance || !endpoint) return context.json({ error: 'Unknown CrowdSec instance or Prometheus endpoint' }, 404);
    try {
      return context.json(await fetchCrowdsecMetrics({
        url: endpoint.url,
        timeoutMs: endpoint.requestTimeoutMs || config.prometheusRequestTimeoutMs,
        auth: endpoint.auth,
        tls: endpoint.tls,
        fetchImpl: options.metricsFetchImpl,
      }));
    } catch (error: any) {
      return context.json({ error: error?.message || 'Failed to read CrowdSec Prometheus metrics' }, 502);
    }
  });

  app.put(`${config.basePath}/api/config/metrics-sidebar`, ensureAuth, async (context) => {
    try {
      const body = await context.req.json<UpdateMetricsSidebarPreferenceRequest>();
      if (typeof body.visible !== 'boolean') {
        return context.json({ error: 'visible must be a boolean' }, 400);
      }

      await syncWorker.runExclusive(() => saveMetricsSidebarVisible(database, body.visible));

      return context.json({
        success: true,
        metrics_sidebar_visible: body.visible,
      });
    } catch (error: any) {
      console.error('Error updating metrics sidebar preference:', error.message);
      return context.json({ error: 'Failed to update metrics sidebar preference' }, 500);
    }
  });

  app.put(`${config.basePath}/api/config/refresh-interval`, ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageSettings(context);
    if (readOnlyResponse) return readOnlyResponse;

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
      await syncWorker.runExclusive(() => savePersistedConfig(database, { refresh_interval_ms: nextInterval }));
      startRefreshScheduler();
      console.log(`Refresh interval changed: ${previous} -> ${interval} (${nextInterval}ms)`);

      return context.json({
        success: true,
        old_interval: previous,
        new_interval: interval,
        new_interval_ms: nextInterval,
        next_refresh_at: nextRefreshAt,
        message: `Refresh interval updated to ${interval}`,
      });
    } catch (error: any) {
      console.error('Error updating refresh interval:', error.message);
      return context.json({ error: 'Failed to update refresh interval' }, 500);
    }
  });

  app.put(`${config.basePath}/api/config/manual-refresh`, ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageSettings(context);
    if (readOnlyResponse) return readOnlyResponse;

    try {
      const body = await context.req.json<UpdateManualRefreshSettingRequest>();
      if (typeof body.enabled !== 'boolean') {
        return context.json({ error: 'enabled must be a boolean' }, 400);
      }

      manualRefreshEnabled = body.enabled;
      await syncWorker.runExclusive(() => savePersistedConfig(database, {
        manual_refresh_enabled: manualRefreshEnabled,
      }));
      console.log(`Manual refresh ${manualRefreshEnabled ? 'enabled' : 'disabled'}`);

      return context.json({
        success: true,
        manual_refresh_enabled: manualRefreshEnabled,
      });
    } catch (error: any) {
      console.error('Error updating manual refresh setting:', error.message);
      return context.json({ error: 'Failed to update manual refresh setting' }, 500);
    }
  });

  app.post(`${config.basePath}/api/cache/refresh`, ensureAuth, async (context) => {
    if (!manualRefreshEnabled) {
      return context.json({
        error: 'Manual refresh is disabled',
        code: 'MANUAL_REFRESH_DISABLED',
      }, 403);
    }

    let body: { mode?: string };
    try {
      body = await context.req.json<{ mode?: string }>();
    } catch {
      return context.json({ error: 'A JSON request body is required' }, 400);
    }

    if (body.mode !== 'delta' && body.mode !== 'latest' && body.mode !== 'full') {
      return context.json({ error: 'mode must be one of: delta, latest, full' }, 400);
    }
    if (cacheRefreshPromise || initializationPromise || bootstrapPromise) {
      return context.json({ error: 'A cache refresh is already in progress', code: 'REFRESH_IN_PROGRESS' }, 409);
    }

    try {
      if (body.mode === 'delta') {
        await updateCache({ throwOnError: true, reconcile: false });
      } else if (body.mode === 'latest') {
        await refreshLatestWindow();
      } else {
        await refreshFullHistory();
      }
      return context.json({ success: true, mode: body.mode, completed_at: cacheRefreshCompletedAt });
    } catch (error: any) {
      const message = error?.message || 'Cache refresh failed';
      console.error(`Manual ${body.mode} refresh failed:`, message);
      return context.json({ error: message }, 502);
    }
  });

  app.put(`${config.basePath}/api/config/language`, ensureAuth, async (context) => {
    try {
      const body = await context.req.json<{ language?: string }>();
      const language = body.language;
      const normalizedLanguage = normalizeLanguagePreference(language);
      if (language !== normalizedLanguage && normalizedLanguage === 'browser') {
        return context.json({ error: 'Invalid language preference' }, 400);
      }

      await syncWorker.runExclusive(() => saveLanguagePreference(database, normalizedLanguage));
      return context.json({
        success: true,
        language: normalizedLanguage,
      });
    } catch (error: any) {
      console.error('Error updating language preference:', error.message);
      return context.json({ error: 'Failed to update language preference' }, 500);
    }
  });

  app.get(`${config.basePath}/api/notifications`, ensureAuth, (context) => {
    const pageRequest = getPageRequest(context) || { page: 1, pageSize: 50 };
    return context.json(notificationService.listNotifications(pageRequest.page, pageRequest.pageSize));
  });

  app.post(`${config.basePath}/api/cleanup/by-ip`, ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageEnforcement(context);
    if (readOnlyResponse) return readOnlyResponse;

    const doRequest = async () => {
      const body = await context.req.json<CleanupByIpRequest>();
      const ip = String(body.ip || '').trim();
      if (!isValidIpOrRange(ip)) {
        return context.json({ error: 'Invalid IP address format' }, 400);
      }

      const targets = resolveOperationInstances(body.scope, body.instance_id);
      if ('error' in targets) return context.json({ error: targets.error }, 400);
      const results = await Promise.all(targets.map(async (instance) => {
        try {
          const result = instance.id === primaryInstance.id && body.scope === undefined
            ? await deleteEntriesByIp(ip)
            : await deleteEntriesByIpOnInstance(instance.id, ip);
          return {
            instance_id: instance.id,
            instance_name: instance.name,
            success: result.failed.length === 0,
            ...(result.failed.length > 0 ? { error: `${result.failed.length} item(s) failed` } : {}),
            result,
          };
        } catch (error: any) {
          return { instance_id: instance.id, instance_name: instance.name, success: false, error: error?.message || String(error) };
        }
      }));
      const succeeded = results.filter((result) => result.success).length;
      const payload = { results, succeeded, failed: results.length - succeeded };
      if (succeeded > 0) void runNotificationEvaluation('cleanup by ip');
      if (results.length === 1 && body.scope === undefined && results[0].success && 'result' in results[0]) {
        return context.json(results[0].result);
      }
      return context.json(payload, succeeded === results.length ? 200 : succeeded > 0 ? 207 : 502);
    };

    try {
      return await doRequest();
    } catch (error) {
      return handleApiError(error as AnyError, context, 'deleting entries by IP', doRequest);
    }
  });

  app.post(`${config.basePath}/api/notifications/:id/read`, ensureAuth, async (context) => {
    const id = String(context.req.param('id'));
    const updated = await notificationService.markNotificationRead(id);
    if (!updated) {
      return context.json({ error: 'Notification not found' }, 404);
    }
    return context.json({ success: true });
  });

  app.post(`${config.basePath}/api/notifications/bulk-read`, ensureAuth, async (context) => {
    const body = await context.req.json<BulkDeleteRequest>();
    const ids = normalizeNotificationIds(body.ids);
    if (ids.length === 0) {
      return context.json({ error: 'At least one notification ID is required' }, 400);
    }

    return context.json({ updated: await notificationService.markNotificationsRead(ids) });
  });

  app.post(`${config.basePath}/api/notifications/bulk-delete`, ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageSettings(context);
    if (readOnlyResponse) return readOnlyResponse;

    const body = await context.req.json<BulkDeleteRequest>();
    const ids = normalizeNotificationIds(body.ids);
    if (ids.length === 0) {
      return context.json({ error: 'At least one notification ID is required' }, 400);
    }

    return context.json({ deleted: await notificationService.deleteNotifications(ids) });
  });

  app.post(`${config.basePath}/api/notifications/delete-read`, ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageSettings(context);
    if (readOnlyResponse) return readOnlyResponse;

    return Response.json({ deleted: await notificationService.deleteReadNotifications() });
  });

  app.delete(`${config.basePath}/api/notifications/:id`, ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageSettings(context);
    if (readOnlyResponse) return readOnlyResponse;

    const id = String(context.req.param('id'));
    if (!await notificationService.deleteNotification(id)) {
      return context.json({ error: 'Notification not found' }, 404);
    }

    return context.json({ success: true });
  });

  app.get(`${config.basePath}/api/notifications/settings`, ensureAuth, () => Response.json(notificationService.listSettings()));

  app.post(`${config.basePath}/api/notification-channels`, ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageSettings(context);
    if (readOnlyResponse) return readOnlyResponse;

    try {
      const body = await context.req.json<UpsertNotificationChannelRequest>();
      return context.json(await notificationService.createChannel(body), 201);
    } catch (error: any) {
      return context.json({ error: error.message || 'Failed to create notification channel' }, 400);
    }
  });

  app.put(`${config.basePath}/api/notification-channels/:id`, ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageSettings(context);
    if (readOnlyResponse) return readOnlyResponse;

    try {
      const id = String(context.req.param('id'));
      const body = await context.req.json<UpsertNotificationChannelRequest>();
      return context.json(await notificationService.updateChannel(id, body));
    } catch (error: any) {
      const status = error.message === 'Notification channel not found' ? 404 : 400;
      return context.json({ error: error.message || 'Failed to update notification channel' }, status);
    }
  });

  app.delete(`${config.basePath}/api/notification-channels/:id`, ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageSettings(context);
    if (readOnlyResponse) return readOnlyResponse;

    const id = String(context.req.param('id'));
    await notificationService.deleteChannel(id);
    return context.json({ success: true });
  });

  app.post(`${config.basePath}/api/notification-channels/:id/test`, ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageSettings(context);
    if (readOnlyResponse) return readOnlyResponse;

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
    const readOnlyResponse = ensureCanManageSettings(context);
    if (readOnlyResponse) return readOnlyResponse;

    try {
      const body = await context.req.json<UpsertNotificationRuleRequest>();
      return context.json(await notificationService.createRule(body), 201);
    } catch (error: any) {
      return context.json({ error: error.message || 'Failed to create notification rule' }, 400);
    }
  });

  app.put(`${config.basePath}/api/notification-rules/:id`, ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageSettings(context);
    if (readOnlyResponse) return readOnlyResponse;

    try {
      const id = String(context.req.param('id'));
      const body = await context.req.json<UpsertNotificationRuleRequest>();
      return context.json(await notificationService.updateRule(id, body));
    } catch (error: any) {
      const status = error.message === 'Notification rule not found' ? 404 : 400;
      return context.json({ error: error.message || 'Failed to update notification rule' }, status);
    }
  });

  app.delete(`${config.basePath}/api/notification-rules/:id`, ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageSettings(context);
    if (readOnlyResponse) return readOnlyResponse;

    const id = String(context.req.param('id'));
    await notificationService.deleteRule(id);
    return context.json({ success: true });
  });

  app.post(`${config.basePath}/api/cache/clear`, ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageEnforcement(context);
    if (readOnlyResponse) return readOnlyResponse;

    try {
      console.log('Manual cache clear requested');
      await syncWorker.clearSyncData();
      resetReconcileWindowState();
      cache.isInitialized = false;
      cache.isComplete = false;
      cache.lastUpdate = null;
      for (const instance of config.instances) {
        initialHistorySyncs.add(instance.id);
        instanceLastUpdates.set(instance.id, null);
      }
      cacheRefreshCompletedAt = null;
      staleDashboardStatsResponseCache.clear();
      invalidateDashboardStatsCache();
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
        await updateCache({ skipIfBusy: true });
      }

      await prepareReadCache('stats alerts request');

      const where = createSqlWhere();
      where.add('created_at >= ?', new Date(Date.now() - config.lookbackMs).toISOString());
      if (!config.simulationsEnabled) {
        where.add('simulated = 0');
      }
      const alerts = (await queryWorker.all<{
        created_at: string;
        scenario?: string | null;
        source_ip?: string | null;
        country?: string | null;
        as_name?: string | null;
        target?: string | null;
        simulated?: number | null;
      }>(`
        SELECT created_at, scenario, source_ip, country, as_name, target, simulated
        FROM alerts
        ${where.toSql()}
        ORDER BY created_at DESC, id DESC
      `, where.params)).map((row): StatsAlert => ({
        created_at: row.created_at,
        scenario: row.scenario || undefined,
        source: row.source_ip || row.country || row.as_name
          ? {
              ip: row.source_ip && !row.source_ip.includes('/') ? row.source_ip : undefined,
              value: row.source_ip || undefined,
              range: row.source_ip && row.source_ip.includes('/') ? row.source_ip : undefined,
              cn: row.country || undefined,
              as_name: row.as_name || undefined,
            }
          : null,
        target: row.target || undefined,
        simulated: row.simulated === 1,
      }));

      return context.json(alerts);
    } catch (error: any) {
      if (error instanceof QueryWorkerTimeoutError) {
        console.warn('Timed out serving stats alerts from database:', error.message);
        return context.json({ error: 'Alert statistics query timed out' }, 504);
      }
      console.error('Error serving stats alerts from database:', error.message);
      return context.json({ error: 'Failed to retrieve alert statistics' }, 500);
    }
  });

  app.get(`${config.basePath}/api/stats/decisions`, ensureAuth, async (context) => {
    try {
      if (refreshIntervalMs === 0) {
        await updateCache({ skipIfBusy: true });
      }

      await prepareReadCache('stats decisions request');

      const now = new Date().toISOString();
      const where = createSqlWhere();
      where.add('(created_at >= ? OR stop_at > ?)', new Date(Date.now() - config.lookbackMs).toISOString(), now);
      if (!config.simulationsEnabled) {
        where.add('simulated = 0');
      }
      const decisions = (await queryWorker.all<{
        id: string | number;
        created_at: string;
        scenario?: string | null;
        value?: string | null;
        stop_at?: string | null;
        target?: string | null;
        simulated?: number | null;
      }>(`
        SELECT id, created_at, scenario, value, stop_at, target, simulated
        FROM decisions
        ${where.toSql()}
        ORDER BY created_at DESC, id DESC
      `, where.params)).map((row): StatsDecision => ({
        id: row.id,
        created_at: row.created_at,
        scenario: row.scenario || undefined,
        value: row.value || undefined,
        stop_at: row.stop_at || undefined,
        target: row.target || undefined,
        simulated: row.simulated === 1,
      }));

      return context.json(decisions);
    } catch (error: any) {
      if (error instanceof QueryWorkerTimeoutError) {
        console.warn('Timed out serving stats decisions from database:', error.message);
        return context.json({ error: 'Decision statistics query timed out' }, 504);
      }
      console.error('Error serving stats decisions from database:', error.message);
      return context.json({ error: 'Failed to retrieve decision statistics' }, 500);
    }
  });

  app.get(`${config.basePath}/api/dashboard/stats`, ensureAuth, async (context) => {
    try {
      if (refreshIntervalMs === 0) {
        await updateCache({ skipIfBusy: true });
      }

      await prepareReadCache('dashboard stats request');
      const filters = getDashboardStatsFilters(context, config.timeZone);
      lastDashboardStatsFilters = { ...filters };
      const initialScopePending = filters.instanceId === 'all'
        ? historicalInstanceSyncPending.size > 0
        : historicalInstanceSyncPending.has(filters.instanceId);
      if (initialScopePending) {
        return context.json(createEmptyDashboardStatsResponse({ pending: true }));
      }
      if (isDashboardStatsBuildInProgress(filters)) {
        warmDashboardStatsCache(filters);
        const staleResponse = staleDashboardStatsResponseCache.get(getStaleDashboardStatsResponseCacheKey(filters));
        if (staleResponse) {
          return context.json({
            ...staleResponse,
            pending: true,
            retryAfterMs: 1_500,
          });
        }
        return context.json(createEmptyDashboardStatsResponse({ pending: true }));
      }

      return context.json(await buildDashboardStats(filters));
    } catch (error: any) {
      if (error instanceof QueryWorkerTimeoutError) {
        console.warn('Timed out serving dashboard statistics from database:', error.message);
        return context.json({ error: 'Dashboard statistics query timed out' }, 504);
      }
      console.error('Error serving dashboard statistics from database:', error.message);
      return context.json({ error: 'Failed to retrieve dashboard statistics' }, 500);
    }
  });

  app.post(`${config.basePath}/api/decisions`, ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageEnforcement(context);
    if (readOnlyResponse) return readOnlyResponse;

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

      const targets = resolveOperationInstances(body.scope, body.instance_id);
      if ('error' in targets) return context.json({ error: targets.error }, 400);
      const results = await Promise.all(targets.map(async (instance) => {
        const client = lapiClients.get(instance.id)!;
        try {
          const result = await client.addDecision(ip, type, duration, reason.slice(0, 256));
          if (instance.id === primaryInstance.id) await updateCacheDelta();
          else await syncInstanceDelta(instance.id);
          return { instance_id: instance.id, instance_name: instance.name, success: true, result };
        } catch (error: any) {
          return { instance_id: instance.id, instance_name: instance.name, success: false, error: error?.message || String(error) };
        }
      }));
      const succeeded = results.filter((result) => result.success).length;
      const payload = { results, succeeded, failed: results.length - succeeded };
      for (const result of results) {
        if (result.success) console.log(`[decisions] Added ${type} decision for ${ip} (${duration}). Instance: ${result.instance_name}.`);
      }
      if (succeeded > 0) void runNotificationEvaluation('manual decision add');
      if (results.length === 1 && body.scope === undefined && results[0].success) {
        return context.json({ message: 'Decision added (via Alert)', result: results[0].result });
      }
      return context.json(payload, succeeded === results.length ? 200 : succeeded > 0 ? 207 : 502);
    };

    try {
      return await doRequest();
    } catch (error) {
      return handleApiError(error as AnyError, context, 'adding decision', doRequest);
    }
  });

  app.post(`${config.basePath}/api/decisions/bulk-delete`, ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageEnforcement(context);
    if (readOnlyResponse) return readOnlyResponse;

    const doRequest = async () => {
      const body = await context.req.json<BulkDeleteRequest>();
      if (Array.isArray(body.refs) && body.refs.length > 0) {
        const validated = validateInstanceEntityRefs(body.refs);
        if ('error' in validated) return context.json({ error: validated.error }, 400);
        const result = createDeleteResult({ requested_decisions: validated.length });
        const groups = groupInstanceEntityRefs(validated);
        await Promise.all(Array.from(groups, async ([instanceId, ids]) => {
          const client = lapiClients.get(instanceId)!;
          for (const id of ids) {
            try {
              await client.deleteDecision(id);
              await syncWorker.runExclusive(() => database.deleteDecisionByInstanceId(instanceId, id));
              result.deleted_decisions += 1;
            } catch (error) {
              result.failed.push(toFailure('decision', `${instanceId}:${id}`, error as AnyError));
            }
          }
        }));
        await syncWorker.runExclusive(() => database.refreshDecisionDuplicateFlags(new Date().toISOString()));
        invalidateDashboardStatsCache();
        if (result.deleted_decisions > 0) void runNotificationEvaluation('bulk decision delete');
        return context.json(result);
      }
      if (!Array.isArray(body.ids) || body.ids.length === 0) {
        return context.json({ error: 'At least one decision ID is required' }, 400);
      }
      if (config.instances.length > 1) {
        return context.json({ error: 'Structured instance refs are required when multiple CrowdSec instances are configured' }, 400);
      }
      const ids = normalizeDeleteIds(body.ids);
      if (ids.length !== body.ids.length) {
        return context.json({ error: 'Decision IDs must be numeric' }, 400);
      }

      const result = await deleteDecisionsByIdsInChunks(ids);
      if (result.deleted_decisions > 0) {
        void runNotificationEvaluation('bulk decision delete');
      }
      return context.json(result);
    };

    try {
      return await doRequest();
    } catch (error) {
      return handleApiError(error as AnyError, context, 'bulk deleting decisions', doRequest);
    }
  });

  app.delete(`${config.basePath}/api/decisions/:id`, ensureAuth, async (context) => {
    if (config.instances.length > 1) return context.json({ error: 'instance_id is required when multiple CrowdSec instances are configured' }, 400);
    const readOnlyResponse = ensureCanManageEnforcement(context);
    if (readOnlyResponse) return readOnlyResponse;

    const decisionId = String(context.req.param('id'));
    if (!/^\d+$/.test(decisionId)) {
      return context.json({ error: 'Invalid decision ID' }, 400);
    }

    const doRequest = async () => {
      const result = await deleteDecisionFromLapi(decisionId);
      console.log(`Removing decision ${decisionId} from local cache...`);
      await syncWorker.runExclusive(() => {
        database.deleteDecision(decisionId);
        database.refreshDecisionDuplicateFlags(new Date().toISOString());
      });
      invalidateDashboardStatsCache();
      void runNotificationEvaluation('decision delete');
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
      const status = await checkForUpdates(readUpdateCheckOverrides(context.req.query()));
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

  function getLegacyAlertSyncQueries(): AlertSyncQuery[] {
    const queries: AlertSyncQuery[] = [];
    let includeUnfiltered = false;

    for (const origin of config.legacyAlertOrigins) {
      if (LEGACY_UNFILTERED_ALERT_ORIGIN_TOKENS.has(origin.trim().toLowerCase())) {
        includeUnfiltered = true;
        continue;
      }
      queries.push({
        origin,
        includeCapi: origin.trim().toUpperCase() === CAPI_ALERT_ORIGIN,
        singleScopeOnly: usesSingleScopeAlertQuery(origin),
      });
    }

    if (includeUnfiltered) {
      queries.push({ includeCapi: false });
    }

    for (const scenario of config.legacyAlertExtraScenarios) {
      queries.push({ scenario, includeCapi: false });
    }

    return queries;
  }

  function getNewAlertSyncQueries(): AlertSyncQuery[] {
    const queries: AlertSyncQuery[] = [];
    const includedOrigins = new Set(config.alertIncludeOrigins);
    const needsUnfilteredNonCapiLane = config.alertIncludeOriginEmpty || config.alertIncludeOrigins.length === 0;

    if (needsUnfilteredNonCapiLane) {
      queries.push({ includeCapi: false });
    }

    if (config.alertIncludeCapi) {
      includedOrigins.add(CAPI_ALERT_ORIGIN);
    }

    for (const origin of includedOrigins) {
      if (origin === CAPI_ALERT_ORIGIN && config.alertExcludeOrigins.includes(CAPI_ALERT_ORIGIN)) {
        continue;
      }

      queries.push({
        origin,
        includeCapi: origin === CAPI_ALERT_ORIGIN,
        singleScopeOnly: usesSingleScopeAlertQuery(origin),
      });
    }

    return queries;
  }

  function getAlertSyncQueries(): AlertSyncQuery[] {
    if (config.alertFilterMode === 'legacy') {
      return getLegacyAlertSyncQueries();
    }
    if (config.alertFilterMode === 'new') {
      return getNewAlertSyncQueries();
    }
    return [];
  }

  function hasExplicitNewAlertIncludes(): boolean {
    return config.alertIncludeOrigins.length > 0 || config.alertIncludeOriginEmpty;
  }

  function getEffectiveIncludedOrigins(): Set<string> {
    const includedOrigins = new Set(config.alertIncludeOrigins);
    if (config.alertIncludeCapi) {
      includedOrigins.add(CAPI_ALERT_ORIGIN);
    }
    return includedOrigins;
  }

  function shouldIncludeAlertByOrigin(alert: AlertRecord): boolean {
    if (config.alertFilterMode !== 'new' || !hasExplicitNewAlertIncludes()) {
      return true;
    }

    const effectiveOrigins = getAlertFallbackOrigins(alert);
    if (effectiveOrigins.length === 0) {
      return config.alertIncludeOriginEmpty;
    }

    const includedOrigins = getEffectiveIncludedOrigins();
    return effectiveOrigins.some((origin) => includedOrigins.has(origin));
  }

  function shouldExcludeAlertByOrigin(alert: AlertRecord): boolean {
    const effectiveOrigins = getAlertFallbackOrigins(alert);
    if (effectiveOrigins.length === 0) {
      return config.alertExcludeOriginEmpty;
    }

    if (config.alertExcludeOrigins.length === 0) return false;
    return effectiveOrigins.some((origin) => config.alertExcludeOrigins.includes(origin));
  }

  function hasLegacyUnfilteredNonCapiLane(): boolean {
    return config.legacyAlertOrigins.some((origin) =>
      LEGACY_UNFILTERED_ALERT_ORIGIN_TOKENS.has(origin.trim().toLowerCase()),
    );
  }

  function hasLegacyDefaultNonCapiLane(): boolean {
    return config.legacyAlertOrigins.length === 0 && config.legacyAlertExtraScenarios.length === 0;
  }

  function isLegacyCapiIncluded(): boolean {
    return config.legacyAlertOrigins.some((origin) => origin.trim().toUpperCase() === CAPI_ALERT_ORIGIN);
  }

  function matchesLegacyExtraScenario(alert: AlertRecord): boolean {
    if (!alert.scenario || config.legacyAlertExtraScenarios.length === 0) {
      return false;
    }
    return config.legacyAlertExtraScenarios.includes(alert.scenario);
  }

  function isNonCapiOrigin(origin: string): boolean {
    return origin !== CAPI_ALERT_ORIGIN;
  }

  function isCachedAlertAllowedByCurrentFilter(alert: AlertRecord): boolean {
    const effectiveOrigins = getAlertFallbackOrigins(alert);

    if (config.alertFilterMode === 'new') {
      if (shouldExcludeAlertByOrigin(alert)) {
        return false;
      }

      if (hasExplicitNewAlertIncludes()) {
        return shouldIncludeAlertByOrigin(alert);
      }

      if (effectiveOrigins.length === 0) {
        return !config.alertExcludeOriginEmpty;
      }

      return effectiveOrigins.some(isNonCapiOrigin) || config.alertIncludeCapi;
    }

    if (config.alertFilterMode === 'legacy') {
      const legacyIncludesCapi = isLegacyCapiIncluded();
      const hasUnfilteredNonCapiLane = hasLegacyUnfilteredNonCapiLane() || hasLegacyDefaultNonCapiLane();
      const matchesExtraScenario = matchesLegacyExtraScenario(alert);

      if (effectiveOrigins.length === 0) {
        return hasUnfilteredNonCapiLane || matchesExtraScenario;
      }

      const hasCapiOrigin = effectiveOrigins.includes(CAPI_ALERT_ORIGIN);
      const hasAllowedExplicitOrigin = effectiveOrigins.some((origin) =>
        origin === CAPI_ALERT_ORIGIN
          ? legacyIncludesCapi
          : config.legacyAlertOrigins.includes(origin),
      );
      const hasAllowedUnfilteredOrigin = effectiveOrigins.some(isNonCapiOrigin) && (hasUnfilteredNonCapiLane || matchesExtraScenario);

      return hasAllowedExplicitOrigin || hasAllowedUnfilteredOrigin || (!hasCapiOrigin && matchesExtraScenario);
    }

    if (effectiveOrigins.length === 0) {
      return true;
    }

    return effectiveOrigins.some(isNonCapiOrigin);
  }

  function isDecisionOriginAllowedByCurrentFilter(origin: string | undefined): boolean {
    if (!origin) {
      if (config.alertFilterMode === 'new') {
        return hasExplicitNewAlertIncludes()
          ? config.alertIncludeOriginEmpty && !config.alertExcludeOriginEmpty
          : !config.alertExcludeOriginEmpty;
      }
      if (config.alertFilterMode === 'legacy') {
        return hasLegacyUnfilteredNonCapiLane() || hasLegacyDefaultNonCapiLane();
      }
      return true;
    }

    if (config.alertFilterMode === 'new') {
      if (config.alertExcludeOrigins.includes(origin)) {
        return false;
      }
      if (hasExplicitNewAlertIncludes()) {
        return getEffectiveIncludedOrigins().has(origin);
      }
      return origin !== CAPI_ALERT_ORIGIN || config.alertIncludeCapi;
    }

    if (config.alertFilterMode === 'legacy') {
      if (origin === CAPI_ALERT_ORIGIN) {
        return isLegacyCapiIncluded();
      }
      return hasLegacyUnfilteredNonCapiLane() || hasLegacyDefaultNonCapiLane() || config.legacyAlertOrigins.includes(origin);
    }

    return origin !== CAPI_ALERT_ORIGIN;
  }

  async function pruneCachedEntriesForCurrentAlertFilters(instanceId = primaryInstance.id): Promise<{ alerts: number; decisions: number }> {
    const cachedAlerts = await queryWorker.all<NormalizedAlertRow & { origins?: string | null }>(
      `SELECT ${ALERT_RECORD_COLUMNS}, origins FROM alerts WHERE instance_id = ?`,
      [instanceId],
    );
    const allAlertIds = new Set<string>();
    const staleAlertIds: string[] = [];
    const staleAlertIdSet = new Set<string>();

    for (let index = 0; index < cachedAlerts.length; index += 1) {
      if (index > 0 && index % SYNC_WRITE_BATCH_SIZE === 0) {
        await delay(0);
      }
      const row = cachedAlerts[index];
      try {
        const alert = alertFromRow(row);
        if (!alert?.id) {
          continue;
        }

        const alertId = String(alert.id);
        const internalAlertId = String(row.internal_id ?? alert.id);
        allAlertIds.add(internalAlertId);
        const storedOrigins = String(row.origins || '')
          .split('\n')
          .map((origin) => origin.trim())
          .filter(Boolean);
        const alertForFilter = storedOrigins.length > 0 && collectDistinctOrigins(alert.decisions).length === 0
          ? {
              ...alert,
              decisions: storedOrigins.map((origin, originIndex) => ({ id: `cached-origin-${originIndex}`, origin })),
            }
          : alert;
        if (!isCachedAlertAllowedByCurrentFilter(alertForFilter)) {
          staleAlertIds.push(internalAlertId);
          staleAlertIdSet.add(internalAlertId);
        }
      } catch {
        // Keep malformed cache rows; normal sync reconciliation can replace them.
      }
    }

    const remainingAlertIds = new Set([...allAlertIds].filter((id) => !staleAlertIdSet.has(id)));
    const prunedAlerts = await syncWorker.deleteCachedAlerts(staleAlertIds);
    const staleDecisionIds: string[] = [];
    const cachedDecisions = await queryWorker.all<{
      id: string | number;
      alert_id?: string | number | null;
      origin?: string | null;
    }>('SELECT id, alert_id, origin FROM decisions WHERE instance_id = ?', [instanceId]);

    for (let index = 0; index < cachedDecisions.length; index += 1) {
      if (index > 0 && index % SYNC_WRITE_BATCH_SIZE === 0) {
        await delay(0);
      }
      const row = cachedDecisions[index];
      if (row.alert_id !== undefined && row.alert_id !== null && remainingAlertIds.has(String(row.alert_id))) {
        continue;
      }
      const origin = normalizeOrigin(row.origin);
      if (!isDecisionOriginAllowedByCurrentFilter(origin)) {
        staleDecisionIds.push(String(row.id));
      }
    }

    const orphanDecisions = await syncWorker.deleteCachedDecisions(staleDecisionIds);
    const pruned = {
      alerts: prunedAlerts.alerts,
      decisions: prunedAlerts.decisions + orphanDecisions,
    };

    if (pruned.alerts > 0 || pruned.decisions > 0) {
      console.log(`Alert filter cleanup: removed ${pruned.alerts} stale cached alerts and ${pruned.decisions} stale cached decisions.`);
    }

    return pruned;
  }

  async function fetchAlertsForSync(
    startMs: number,
    endMs: number,
    options: { requireComplete?: boolean } = {},
    runtime = getInstanceSyncRuntime(primaryInstance.id),
  ): Promise<AlertRecord[]> {
    const configuredQueries = getAlertSyncQueries();
    if (configuredQueries.length === 0 && config.alertFilterMode === 'new' && hasExplicitNewAlertIncludes()) {
      return [];
    }

    const queries = configuredQueries.length === 0 ? [{ includeCapi: false }] : configuredQueries;
    const merged = new Map<string, AlertRecord>();
    for (const query of queries) {
      // Recalculate relative boundaries for every scope query. Scope queries
      // run sequentially, so reusing the first query's durations could move a
      // later response outside the authoritative local window.
      const requestNow = Date.now();
      const paddingMs = runtime.requestTimeoutMs;
      const since = formatQueryDuration(requestNow - startMs + paddingMs, 'up');
      const until = formatQueryDuration(requestNow - endMs - paddingMs, 'down');
      const resultSet = await runtime.client.fetchAlerts(since, until, {
        ...query,
        requireAllScopes: options.requireComplete,
        relativeWindow: { startMs, endMs, paddingMs },
      });
      for (const alert of resultSet) {
        const typedAlert = alert as AlertRecord;
        if (!typedAlert?.id) continue;
        merged.set(String(typedAlert.id), typedAlert);
      }
    }

    return Array.from(merged.values())
      .filter((alert) => shouldIncludeAlertByOrigin(alert))
      .filter((alert) => !shouldExcludeAlertByOrigin(alert));
  }

  function buildAlertMutation(
    alert: AlertRecord,
    reconcileDecisions = true,
    decisionIdsToPersist: Set<string> | null = null,
    updateAlertRawDataOnly = false,
    observedAt = new Date().toISOString(),
    instanceId = primaryInstance.id,
  ): SyncAlertMutation | null {
    if (!alert || !alert.id) return null;
    const decisions = alert.decisions || [];
    const alertSource = alert.source || null;
    const sourceValue = getAlertSourceValue(alertSource);
    const target = getAlertTarget(alert);
    const machine = resolveMachineName(alert);
    const simulated = isAlertSimulated(alert);
    const enrichedAlert: AlertRecord = {
      ...alert,
      target,
      simulated,
    };
    const alertHistoryAt = resolveAlertHistoryAt(alert);
    const alertData: AlertInsertParams = {
      $id: alert.id,
      $instance_id: instanceId,
      $uuid: alert.uuid || String(alert.id),
      $created_at: alertHistoryAt,
      $scenario: alert.scenario,
      $source_ip: sourceValue,
      $message: alert.message || '',
      $record: enrichedAlert,
    };

    const currentDecisionIds: string[] = [];
    const decisionData: DecisionInsertParams[] = [];
    for (const decision of decisions) {
      const decisionId = String(decision.id);
      if (reconcileDecisions) currentDecisionIds.push(decisionId);
      if (decisionIdsToPersist && !decisionIdsToPersist.has(decisionId)) {
        continue;
      }
      const decisionSimulated = normalizeDecisionSimulated(decision, alert);
      const createdAt = decision.created_at || alertHistoryAt;
      const stopAt = resolveDecisionStopAt(decision, createdAt, observedAt);

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
        region: alertSource?.region,
        city: alertSource?.city,
        as: alertSource?.as_name,
        machine,
        target,
        simulated: decisionSimulated,
        is_duplicate: false,
      };

      decisionData.push({
        $id: decisionId,
        $instance_id: instanceId,
        $uuid: decisionId,
        $alert_id: alert.id,
        $created_at: createdAt,
        $stop_at: stopAt,
        $value: enrichedDecision.value,
        $type: decision.type,
        $origin: enrichedDecision.origin,
        $scenario: enrichedDecision.scenario,
        $record: enrichedDecision,
      });
    }

    return {
      instanceId,
      alert: alertData,
      decisions: decisionData,
      keepDecisionIds: reconcileDecisions ? currentDecisionIds : [],
      reconcileDecisions,
      ...(updateAlertRawDataOnly ? { updateAlertRawDataOnly: true } : {}),
    };
  }

  function* splitAlertMutation(mutation: SyncAlertMutation): Generator<SyncAlertMutation> {
    if (!mutation.alert || mutation.decisions.length <= SYNC_WRITE_DECISION_BATCH_SIZE) {
      yield mutation;
      return;
    }

    for (let offset = 0; offset < mutation.decisions.length; offset += SYNC_WRITE_DECISION_BATCH_SIZE) {
      const end = Math.min(offset + SYNC_WRITE_DECISION_BATCH_SIZE, mutation.decisions.length);
      const isFirst = offset === 0;
      const isFinal = end === mutation.decisions.length;
      yield {
        instanceId: mutation.instanceId,
        ...(isFirst ? { alert: mutation.alert } : { alertId: mutation.alert.$id }),
        ...(isFirst && mutation.updateAlertRawDataOnly ? { updateAlertRawDataOnly: true } : {}),
        decisions: mutation.decisions.slice(offset, end),
        keepDecisionIds: isFinal && mutation.reconcileDecisions !== false ? mutation.keepDecisionIds : [],
        reconcileDecisions: isFinal ? mutation.reconcileDecisions : false,
      };
    }
  }

  function* createSyncWriteBatches(
    alerts: AlertRecord[],
    decisionIdsToPersistByAlertId: Map<string, Set<string>> | null = null,
    rawDataOnlyAlertIds: Set<string> | null = null,
    skipDecisionReconciliationAlertIds: Set<string> | null = null,
    observedAt = new Date().toISOString(),
    instanceId = primaryInstance.id,
    freshBulkImport = false,
  ): Generator<SyncAlertMutation[]> {
    // LAPI serializes duration-only decisions as time remaining at response
    // time. Use one observation point for the whole response so processing
    // order cannot introduce artificial expiry differences between duplicate
    // decisions that actually expire together.
    let batch: SyncAlertMutation[] = [];
    let alertCount = 0;
    let decisionCount = 0;

    const resetBatch = () => {
      batch = [];
      alertCount = 0;
      decisionCount = 0;
    };

    for (const alert of alerts) {
      const mutation = buildAlertMutation(
        alert,
        !freshBulkImport && !skipDecisionReconciliationAlertIds?.has(String(alert.id)),
        decisionIdsToPersistByAlertId?.get(String(alert.id)) || null,
        rawDataOnlyAlertIds?.has(String(alert.id)) === true,
        observedAt,
        instanceId,
      );
      if (!mutation) continue;

      for (const fragment of splitAlertMutation(mutation)) {
        const fragmentAlertCount = fragment.alert ? 1 : 0;
        const fragmentDecisionCount = fragment.decisions.length;
        if (
          batch.length > 0
          && (
            alertCount + fragmentAlertCount > SYNC_WRITE_BATCH_SIZE
            || decisionCount + fragmentDecisionCount > SYNC_WRITE_DECISION_BATCH_SIZE
          )
        ) {
          yield batch;
          resetBatch();
        }

        batch.push(fragment);
        alertCount += fragmentAlertCount;
        decisionCount += fragmentDecisionCount;
        if (
          alertCount >= SYNC_WRITE_BATCH_SIZE
          || decisionCount >= SYNC_WRITE_DECISION_BATCH_SIZE
        ) {
          yield batch;
          resetBatch();
        }
      }
    }

    if (batch.length > 0) yield batch;
  }

  function resolveDecisionStopAt(decision: AlertDecision, createdAt: string, observedAt: string): string {
    if (decision.stop_at) {
      return decision.stop_at;
    }
    if (decision.duration) {
      const observedAtMs = Date.parse(observedAt);
      if (Number.isFinite(observedAtMs)) {
        return new Date(observedAtMs + parseGoDuration(decision.duration)).toISOString();
      }
    }
    return createdAt;
  }

  async function reconcileSyncedAlertWindow(
    alerts: AlertRecord[],
    start: string,
    end: string,
    runtime = getInstanceSyncRuntime(primaryInstance.id),
    freshBulkImport = false,
  ): Promise<{ alerts: number; decisions: number; changed: boolean }> {
    const keepIds = alerts.map((alert) => alert.id);
    let changed = await persistChangedAlerts(alerts, runtime.instanceId, freshBulkImport);
    if (freshBulkImport) {
      return { alerts: 0, decisions: 0, changed };
    }
    const pruned = await syncWorker.deleteAlertsMissingBetween(start, end, keepIds, runtime.instanceId);
    return {
      ...pruned,
      changed: changed || pruned.alerts > 0 || pruned.decisions > 0,
    };
  }

  async function persistChangedAlerts(
    alerts: AlertRecord[],
    instanceId = primaryInstance.id,
    freshBulkImport = false,
  ): Promise<boolean> {
    alerts = await enrichAlertRecordLocations(alerts);
    if (freshBulkImport) {
      let changed = false;
      for (const mutations of createSyncWriteBatches(alerts, null, null, null, new Date().toISOString(), instanceId, true)) {
        const result = await syncWorker.persistAlerts(mutations);
        changed = result.changed || changed;
      }
      return changed;
    }

    const alertsToPersist: AlertRecord[] = [];
    const decisionIdsToPersistByAlertId = new Map<string, Set<string>>();
    const rawDataOnlyAlertIds = new Set<string>();
    const skipDecisionReconciliationAlertIds = new Set<string>();
    const removedDecisionIds = new Set<string>();
    const affectedDecisionIds = new Set<string>();
    const observedAt = new Date().toISOString();
    let decisionMutationCount = 0;
    for (const alert of alerts) {
      const decisions = Array.isArray(alert.decisions) ? alert.decisions : [];
      const alertId = String(alert.id);
      const delta = getAlertSyncDelta(alert, decisions, observedAt, instanceId);
      if (delta) {
        alertsToPersist.push(alert);
        if (delta.decisionIdsToPersist) {
          decisionIdsToPersistByAlertId.set(alertId, delta.decisionIdsToPersist);
          decisionMutationCount += delta.decisionIdsToPersist.size;
          for (const id of delta.decisionIdsToPersist) affectedDecisionIds.add(id);
        } else {
          decisionMutationCount += decisions.length;
          for (const decision of decisions) affectedDecisionIds.add(String(decision.id));
        }
        if (delta.reconcileDecisions === false) {
          skipDecisionReconciliationAlertIds.add(alertId);
        }
        if (delta.updateAlertRawDataOnly) {
          rawDataOnlyAlertIds.add(alertId);
        }
        for (const id of delta.removedIds) {
          removedDecisionIds.add(id);
          affectedDecisionIds.add(id);
        }
      }
    }

    const deferSearchIndexes = decisionMutationCount >= SYNC_DEFER_SEARCH_INDEX_DECISION_THRESHOLD;
    if (deferSearchIndexes) {
      await syncWorker.beginDeferredSearchIndexUpdates(false, false);
    }

    let changed = false;
    try {
      for (const mutations of createSyncWriteBatches(
        alertsToPersist,
        decisionIdsToPersistByAlertId,
        rawDataOnlyAlertIds,
        skipDecisionReconciliationAlertIds,
        observedAt,
        instanceId,
      )) {
        const result = await syncWorker.persistAlerts(mutations);
        changed = result.changed || changed;
      }
      const removedIds = Array.from(removedDecisionIds);
      for (let offset = 0; offset < removedIds.length; offset += SYNC_WRITE_DECISION_BATCH_SIZE) {
        const chunk = removedIds.slice(offset, offset + SYNC_WRITE_DECISION_BATCH_SIZE);
        changed = (await syncWorker.deleteCachedDecisions(chunk)) > 0 || changed;
      }
      return changed;
    } finally {
      if (deferSearchIndexes) {
        await syncWorker.rebuildSearchIndexes({
          alertIds: alertsToPersist.map((alert) => String(alert.id)),
          decisionIds: Array.from(affectedDecisionIds),
        });
      }
    }
  }

  function getAlertSyncDelta(alert: AlertRecord, decisions: AlertDecision[], observedAt: string, instanceId = primaryInstance.id): {
    decisionIdsToPersist: Set<string> | null;
    removedIds: Set<string>;
    reconcileDecisions: boolean;
    updateAlertRawDataOnly: boolean;
  } | null {
    // Most CrowdSec decision changes are membership changes. Expiration is the
    // exception: LAPI retains the ID on its historical alert and changes the
    // remaining duration to zero/negative. Track only those rare candidates so
    // unchanged large blocklist alerts retain the allocation-light ID path.
    const allDecisionIds = new Set<string>();
    const inactiveDecisionIds: string[] = [];
    for (const decision of decisions) {
      const id = String(decision.id);
      allDecisionIds.add(id);
      if (isIncomingDecisionInactive(decision)) inactiveDecisionIds.push(id);
    }
    const snapshot = database.getAlertDecisionSnapshot(alert.id, instanceId);
    if (!snapshot) {
      return { decisionIdsToPersist: null, removedIds: new Set(), reconcileDecisions: true, updateAlertRawDataOnly: false };
    }

    const { decisions: _incomingDecisions, ...incomingAlertMetadata } = alert;
    const incomingMetadata = {
      ...incomingAlertMetadata,
      target: getAlertTarget(alert),
      simulated: isAlertSimulated(alert),
    } as AlertRecord;
    if (snapshot.metadata_hash !== alertMetadataFingerprint(incomingMetadata)) {
      // Alert metadata is copied into decision indexes, so let the guarded
      // upserts inspect every decision only when that metadata changed.
      return { decisionIdsToPersist: null, removedIds: new Set(), reconcileDecisions: true, updateAlertRawDataOnly: false };
    }

    const cachedIds = new Set(database.getDecisionIdsByAlertId(alert.id, instanceId));
    if (snapshot.decision_count !== cachedIds.size) {
      return { decisionIdsToPersist: null, removedIds: new Set(), reconcileDecisions: true, updateAlertRawDataOnly: false };
    }
    const addedIds = new Set<string>();
    for (const id of allDecisionIds) {
      if (!cachedIds.delete(id)) addedIds.add(id);
    }

    if (inactiveDecisionIds.length > 0) {
      const observedAtMs = Date.parse(observedAt);
      const cachedStopAtById = database.getDecisionStopAtBatch(inactiveDecisionIds, instanceId);
      for (const id of inactiveDecisionIds) {
        const cachedStopAt = cachedStopAtById.get(id);
        if (cachedStopAt && Date.parse(cachedStopAt) > observedAtMs) addedIds.add(id);
      }
    }

    if (addedIds.size === 0 && cachedIds.size === 0) return null;
    const origins = collectDistinctOrigins(decisions).join(' ').trim() || null;
    const simulated = isAlertSimulated(alert) ? 1 : 0;
    return {
      decisionIdsToPersist: addedIds,
      removedIds: cachedIds,
      reconcileDecisions: false,
      updateAlertRawDataOnly: snapshot.origins === origins && snapshot.simulated === simulated,
    };
  }

  function isIncomingDecisionInactive(decision: AlertDecision): boolean {
    const duration = decision.duration?.trim();
    return duration === '0s' || duration?.startsWith('-') === true;
  }

  function isTimeoutError(error: unknown): boolean {
    const candidate = error as { code?: string; message?: string } | null | undefined;
    return candidate?.code === 'ETIMEDOUT' || /timeout/i.test(candidate?.message || '');
  }

  function combineWindowSummaries(left: WindowSyncSummary, right: WindowSyncSummary): WindowSyncSummary {
    return {
      alerts: left.alerts + right.alerts,
      decisions: left.decisions + right.decisions,
      errors: [...left.errors, ...right.errors],
      successfulWindows: left.successfulWindows + right.successfulWindows,
      changed: left.changed || right.changed,
      lastError: right.lastError || left.lastError,
    };
  }

  function formatSyncWindow(startMs: number, endMs: number, nowMs: number): string {
    return `${toDuration(startMs, nowMs)} -> ${toDuration(endMs, nowMs)} ago`;
  }

  function formatQueryDuration(milliseconds: number, round: 'up' | 'down'): string {
    const seconds = round === 'up'
      ? Math.ceil(Math.max(0, milliseconds) / 1_000)
      : Math.floor(Math.max(0, milliseconds) / 1_000);
    const hours = Math.floor(seconds / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    return `${hours}h${minutes}m${seconds % 60}s`;
  }

  function isAlertInsideWindow(alert: AlertRecord, startMs: number, endMs: number): boolean {
    const historyAt = Date.parse(resolveAlertHistoryAt(alert));
    return Number.isFinite(historyAt) && historyAt >= startMs && historyAt < endMs;
  }

  function canSplitWindow(startMs: number, endMs: number, runtime: InstanceSyncRuntime): boolean {
    return endMs - startMs > runtime.minChunkSizeMs;
  }

  function splitWindow(startMs: number, endMs: number): [number, number, number] {
    const midpoint = Math.floor((startMs + endMs) / 2);
    return [startMs, midpoint, endMs];
  }

  async function syncAlertWindow(
    startMs: number,
    endMs: number,
    nowMs: number,
    onFetched?: (windowLabel: string, alerts: number, decisions: number) => void,
    runtime = getInstanceSyncRuntime(primaryInstance.id),
    freshBulkImport = false,
  ): Promise<WindowSyncSummary> {
    const windowLabel = formatSyncWindow(startMs, endMs, nowMs);

    try {
      // LAPI accepts relative, whole-second boundaries. Pad both sides by the
      // request timeout so transport delay and duration rounding can only make
      // the response a superset, then constrain it to the exact SQLite window.
      const fetchedAlerts = await fetchAlertsForSync(startMs, endMs, { requireComplete: true }, runtime);
      const alerts = fetchedAlerts.filter((alert) => isAlertInsideWindow(alert, startMs, endMs));
      const decisionCount = countAlertDecisions(alerts);
      onFetched?.(windowLabel, alerts.length, decisionCount);
      const pruned = await reconcileSyncedAlertWindow(
        alerts,
        new Date(startMs).toISOString(),
        new Date(endMs).toISOString(),
        runtime,
        freshBulkImport,
      );
      if (alerts.length > 0) {
        console.log(`  -> Fetched ${alerts.length} alerts and ${decisionCount} decisions.`);
      }
      if (pruned.alerts > 0 || pruned.decisions > 0) {
        console.log(`  -> Pruned ${pruned.alerts} stale alerts and ${pruned.decisions} stale decisions.`);
      }

      return {
        alerts: alerts.length,
        decisions: decisionCount,
        errors: [],
        successfulWindows: 1,
        changed: pruned.changed,
      };
    } catch (error: any) {
      if (isTimeoutError(error) && canSplitWindow(startMs, endMs, runtime)) {
        const [, midpoint] = splitWindow(startMs, endMs);
        console.warn(`Alert sync window timed out (${windowLabel}); splitting into smaller windows.`);
        const first = await syncAlertWindow(startMs, midpoint, nowMs, onFetched, runtime, freshBulkImport);
        const second = await syncAlertWindow(midpoint, endMs, nowMs, onFetched, runtime, freshBulkImport);
        return combineWindowSummaries(first, second);
      }

      const errorMessage = `Alerts ${windowLabel}: ${error.message}`;
      const lastError = error instanceof Error ? error : new Error(String(error));
      console.error('Failed to sync chunk:', error.message);
      return {
        alerts: 0,
        decisions: 0,
        errors: [errorMessage],
        successfulWindows: 0,
        changed: false,
        lastError,
      };
    }
  }

  function reconcileWindowKey(start: number, end: number): string {
    return `${start}:${end}`;
  }

  function createClosedReconcileWindows(now: number): Array<{ key: string; start: number; end: number }> {
    const windowMs = config.reconcileWindowMs;
    const lookbackStart = now - config.lookbackMs;
    const firstWindowStart = Math.floor(lookbackStart / windowMs) * windowMs;
    const openWindowStart = Math.floor(now / windowMs) * windowMs;
    const windows: Array<{ key: string; start: number; end: number }> = [];
    for (let fixedStart = firstWindowStart; fixedStart < openWindowStart; fixedStart += windowMs) {
      const end = fixedStart + windowMs;
      windows.push({
        key: reconcileWindowKey(fixedStart, end),
        start: Math.max(fixedStart, lookbackStart),
        end,
      });
    }
    return windows;
  }

  async function getActiveReconcileWindowKeys(now: number): Promise<Set<string>> {
    const since = new Date(now - config.lookbackMs).toISOString();
    const rows = await queryWorker.all<{ created_at: string }>(`
      SELECT DISTINCT alerts.created_at
      FROM decisions AS active INDEXED BY idx_decisions_stop_alert_id
      JOIN alerts ON alerts.id = active.alert_id
      WHERE active.stop_at > ?
        AND alerts.created_at >= ?
    `, [new Date(now).toISOString(), since]);
    const keys = new Set<string>();
    for (const row of rows) {
      const createdAt = Date.parse(row.created_at);
      if (!Number.isFinite(createdAt)) continue;
      const start = Math.floor(createdAt / config.reconcileWindowMs) * config.reconcileWindowMs;
      keys.add(reconcileWindowKey(start, start + config.reconcileWindowMs));
    }
    return keys;
  }

  function seedReconcileWindowState(now: number): void {
    const windows = Object.fromEntries(createClosedReconcileWindows(now).map((window) => [window.key, now]));
    reconcileWindowState = {
      version: 1,
      configFingerprint: reconcileConfigFingerprint,
      headLastSuccess: now,
      windows,
    };
    saveReconcileWindowState();
  }

  async function planDueReconcileWindows(now: number): Promise<ReconcilePlan> {
    const closedWindows = createClosedReconcileWindows(now);
    const currentKeys = new Set(closedWindows.map((window) => window.key));
    const activeKeys = await getActiveReconcileWindowKeys(now);
    const currentWindowStart = Math.floor(now / config.reconcileWindowMs) * config.reconcileWindowMs;
    const headStart = Math.max(now - config.lookbackMs, currentWindowStart);
    const headKey = 'head';
    const headActive = Array.from(activeKeys).some((key) => {
      const start = Number(key.split(':', 1)[0]);
      return Number.isFinite(start) && start + config.reconcileWindowMs > headStart;
    });
    const candidates: ReconcileWindow[] = closedWindows.map((window) => {
      const active = activeKeys.has(window.key);
      const age = Math.max(0, now - window.end);
      const intervalMs = active
        ? config.reconcileActiveIntervalMs
        : age <= config.reconcileRecentAgeMs
          ? config.reconcileRecentIntervalMs
          : config.reconcileOldIntervalMs;
      return {
        ...window,
        active,
        intervalMs,
        lastSuccess: reconcileWindowState.windows[window.key] || 0,
      };
    });
    candidates.push({
      key: headKey,
      start: headStart,
      end: now,
      active: headActive,
      intervalMs: headActive ? config.reconcileActiveIntervalMs : config.reconcileRecentIntervalMs,
      lastSuccess: reconcileWindowState.headLastSuccess,
      head: true,
    });

    const dueByPriority = candidates
      .filter((window) => now - window.lastSuccess >= window.intervalMs)
      .sort((left, right) => {
        const leftOverdue = left.lastSuccess === 0 ? Number.POSITIVE_INFINITY : (now - left.lastSuccess) / left.intervalMs;
        const rightOverdue = right.lastSuccess === 0 ? Number.POSITIVE_INFINITY : (now - right.lastSuccess) / right.intervalMs;
        if (leftOverdue !== rightOverdue) return rightOverdue - leftOverdue;
        if (left.active !== right.active) return left.active ? -1 : 1;
        return right.end - left.end;
      });

    const dueByAge = [...dueByPriority].sort((left, right) => {
      if (left.lastSuccess !== right.lastSuccess) return left.lastSuccess - right.lastSuccess;
      return left.end - right.end;
    });
    const selected: ReconcileWindow[] = [];
    const selectedKeys = new Set<string>();
    const addWindow = (window: ReconcileWindow | undefined) => {
      if (!window || selectedKeys.has(window.key)) return;
      selected.push(window);
      selectedKeys.add(window.key);
    };

    if (config.reconcileWindowsPerRefresh === 1) {
      // With a single slot, oldest-success-first is the only starvation-free
      // policy. Active/recent cadence still makes those windows due sooner.
      addWindow(dueByAge[0]);
    } else {
      // Reserve one slot for the least recently successful due window. Fill
      // the remaining budget by normalized overdue priority so active and
      // recent windows retain their lower latency without starving old data.
      for (const window of dueByPriority.slice(0, config.reconcileWindowsPerRefresh - 1)) {
        addWindow(window);
      }
      addWindow(dueByAge.find((window) => !selectedKeys.has(window.key)));
      for (const window of dueByPriority) {
        if (selected.length >= config.reconcileWindowsPerRefresh) break;
        addWindow(window);
      }
    }

    return { windows: selected, currentKeys };
  }

  function recordReconcileWindowSuccess(window: ReconcileWindow, now: number): void {
    if (window.head) reconcileWindowState.headLastSuccess = now;
    else reconcileWindowState.windows[window.key] = now;
  }

  function finishReconcilePlan(plan: ReconcilePlan): void {
    reconcileWindowState.windows = Object.fromEntries(
      Object.entries(reconcileWindowState.windows).filter(([key]) => plan.currentKeys.has(key)),
    );
    if (plan.windows.length > 0) saveReconcileWindowState();
  }

  async function runPlannedReconcileWindows(
    plan: ReconcilePlan,
    now: number,
    excludedKeys: Set<string> = new Set(),
  ): Promise<WindowSyncSummary> {

    let summary: WindowSyncSummary = {
      alerts: 0,
      decisions: 0,
      errors: [],
      successfulWindows: 0,
      changed: false,
    };
    for (const window of plan.windows) {
      if (excludedKeys.has(window.key)) continue;
      console.log(`Reconciling ${window.active ? 'active ' : ''}alert window ${formatSyncWindow(window.start, window.end, now)}...`);
      const result = await syncAlertWindow(window.start, window.end, now);
      summary = combineWindowSummaries(summary, result);
      if (result.errors.length === 0) {
        recordReconcileWindowSuccess(window, now);
      }
      await delay(0);
    }
    return summary;
  }

  async function syncHistory(
    forceOverlay = false,
    runtime = getInstanceSyncRuntime(primaryInstance.id),
    freshBulkImport = false,
  ): Promise<SyncHistorySummary> {
    const showOverlay = forceOverlay || initialHistorySyncs.delete(runtime.instanceId);
    const t = getServerTranslator(database);
    console.log(`[${runtime.instanceName}] Starting historical data sync...`);

    Object.assign(runtime.status, {
      isSyncing: showOverlay,
      progress: 0,
      message: t('components.syncOverlay.statusStarting'),
      startedAt: new Date().toISOString(),
      completedAt: null,
      state: 'syncing',
      errors: [],
    });

    const now = Date.now();
    const lookbackStart = now - runtime.lookbackMs;
    const chunkSizeMs = runtime.chunkSizeMs;
    const totalDuration = now - lookbackStart;
    let currentStart = lookbackStart;
    let totalAlerts = 0;
    let totalDecisions = 0;
    let successfulWindows = 0;
    const historicalErrors: string[] = [];
    let changed = false;

    if (!runtime.client.hasToken() && !await runtime.client.login(`historical sync: ${runtime.instanceName}`)) {
      throw new Error(runtime.client.getStatus().lastError || `Authentication failed for ${runtime.instanceName}`);
    }

    const filterPruned = await pruneCachedEntriesForCurrentAlertFilters(runtime.instanceId);
    changed = filterPruned.alerts > 0 || filterPruned.decisions > 0;
    if (filterPruned.alerts > 0 || filterPruned.decisions > 0) {
      Object.assign(runtime.status, {
        message: t('components.syncOverlay.statusRemovedStale', {
          alerts: filterPruned.alerts,
          decisions: filterPruned.decisions,
        }),
      });
    }

    while (currentStart < now) {
      const currentEnd = Math.min(currentStart + chunkSizeMs, now);
      const progress = Math.round(((currentEnd - lookbackStart) / totalDuration) * 100);
      const windowLabel = formatSyncWindow(currentStart, currentEnd, now);
      const progressMessage = t('components.syncOverlay.statusFetchingWindow', {
        window: windowLabel,
        alerts: totalAlerts,
        decisions: totalDecisions,
      });
      const progressLogMessage = `Syncing: ${windowLabel} (${totalAlerts} alerts, ${totalDecisions} decisions)`;

      Object.assign(runtime.status, {
        progress: Math.min(progress, 90),
        message: progressMessage,
      });
      console.log(`[${runtime.instanceName}] ${progressLogMessage}`);

      const result = await syncAlertWindow(currentStart, currentEnd, now, (processedWindow, alerts, decisions) => {
        Object.assign(runtime.status, {
          progress: Math.min(progress, 90),
          message: t('components.syncOverlay.statusProcessingWindow', {
            window: processedWindow,
            alerts,
            decisions,
          }),
        });
      }, runtime, freshBulkImport);
      totalAlerts += result.alerts;
      totalDecisions += result.decisions;
      successfulWindows += result.successfulWindows;
      historicalErrors.push(...result.errors);
      changed = result.changed || changed;

      currentStart = currentEnd;
      await delay(100);
    }

    const cachedAlerts = database.countAlerts(runtime.instanceId);
    const cachedDecisions = database.countDecisions(runtime.instanceId);
    const errors = [...historicalErrors];
    const state = errors.length === 0
      ? 'complete'
      : successfulWindows > 0
        ? 'partial'
        : 'failed';
    const message = state === 'complete'
      ? t('server.sync.complete', { alerts: cachedAlerts, decisions: cachedDecisions })
      : state === 'partial'
        ? t('server.sync.partial', { alerts: cachedAlerts, decisions: cachedDecisions, failures: errors.length })
        : t('server.sync.failed', { reason: errors[0] || t('server.sync.failedNoWindows') });
    const logMessage = state === 'complete'
      ? `Sync complete. ${cachedAlerts} alerts and ${cachedDecisions} decisions cached.`
      : state === 'partial'
        ? `Sync partially complete. ${cachedAlerts} alerts and ${cachedDecisions} decisions cached; ${errors.length} window${errors.length === 1 ? '' : 's'} failed.`
        : `Sync failed: ${errors[0] || 'no alert windows could be synced'}`;
    console.log(`[${runtime.instanceName}] ${logMessage}`);

    Object.assign(runtime.status, {
      // Keep the initial overlay open until initializeCache has finalized all
      // read-visible indexes and dashboard cache state.
      isSyncing: showOverlay,
      progress: state === 'failed' ? 0 : showOverlay ? 95 : 100,
      message,
      completedAt: showOverlay ? null : new Date().toISOString(),
      state,
      errors,
    });

    return {
      historicalAlerts: totalAlerts,
      historicalDecisions: totalDecisions,
      historicalErrors,
      state,
      errors,
      cachedAlerts,
      cachedDecisions,
      changed,
      syncedThrough: new Date(now).toISOString(),
    };
  }

  async function initializeSingleInstanceCache(options: { showOverlay?: boolean } = {}): Promise<SyncHistorySummary | null> {
    if (initializationPromise) {
      console.log('Cache initialization already in progress, waiting...');
      return initializationPromise;
    }

    initializationPromise = (async () => {
      const t = getServerTranslator(database);
      const deferIndexUpdates = !cache.isInitialized;
      const freshBulkImport = deferIndexUpdates
        && database.countAlerts() === 0
        && database.countDecisions() === 0;
      let deferredIndexesRebuilt = false;
      if (deferIndexUpdates) {
        // A populated startup cache still benefits substantially from deferring
        // FTS writes, but it must retain the alert_id indexes used to reconcile
        // stale decisions. A brand-new cache can defer every secondary index.
        await syncWorker.beginDeferredSearchIndexUpdates(freshBulkImport);
      }
      try {
        console.log('Initializing cache with chunked data load...');
        const syncSummary = await syncHistory(
          options.showOverlay,
          getInstanceSyncRuntime(primaryInstance.id),
          freshBulkImport,
        );
        if (syncStatus.isSyncing && syncSummary.state !== 'failed') {
          updateSyncStatus({
            progress: 96,
            message: t('components.syncOverlay.statusFinalizingDecisions'),
          });
        }
        let duplicateFlagsRefreshed = false;
        if (deferIndexUpdates && freshBulkImport) {
          const duplicateRefreshStartedAt = Date.now();
          await syncWorker.refreshDecisionDuplicateFlags(new Date().toISOString());
          duplicateFlagsRefreshed = true;
          console.log(`Decision duplicate index refreshed in ${formatElapsedTime(Date.now() - duplicateRefreshStartedAt)}.`);
        }
        if (deferIndexUpdates) {
          console.log('Building secondary and search indexes after initial cache load...');
          if (syncStatus.isSyncing) {
            updateSyncStatus({
              progress: 98,
              message: t('components.syncOverlay.statusBuildingIndexes'),
            });
          }
          const indexStartedAt = Date.now();
          await syncWorker.rebuildSearchIndexes();
          deferredIndexesRebuilt = true;
          console.log(`Secondary and search indexes built in ${formatElapsedTime(Date.now() - indexStartedAt)}.`);
        }
        if (!duplicateFlagsRefreshed) {
          const duplicateRefreshStartedAt = Date.now();
          await syncWorker.refreshDecisionDuplicateFlags(new Date().toISOString());
          console.log(`Decision duplicate index refreshed in ${formatElapsedTime(Date.now() - duplicateRefreshStartedAt)}.`);
        }
        if (syncSummary.changed) {
          invalidateDashboardStatsCache();
        }
        cache.lastUpdate = syncSummary.syncedThrough;
        instanceLastUpdates.set(primaryInstance.id, syncSummary.syncedThrough);
        cache.isInitialized = syncSummary.state !== 'failed';
        cache.isComplete = syncSummary.state === 'complete';
        if (syncSummary.state === 'complete') {
          seedReconcileWindowState(Date.parse(syncSummary.syncedThrough));
        }
        lapiClient.updateStatus(syncSummary.state === 'complete', syncSummary.errors[0] ? { message: syncSummary.errors[0] } : null);
        if (syncStatus.isSyncing && cache.isInitialized) {
          updateSyncStatus({
            progress: 99,
            message: t('components.syncOverlay.statusPreparingDashboard'),
          });
          try {
            await getDashboardStatsIndex(config.instances.length > 1 ? primaryInstance.id : 'all');
          } catch (error: any) {
            console.error('Failed to prepare dashboard data before completing initial sync:', error.message);
          }
        }
        const completedAt = new Date().toISOString();
        updateSyncStatus({
          isSyncing: false,
          progress: syncSummary.state === 'failed' ? 0 : 100,
          message: syncSummary.state === 'complete'
            ? t('server.sync.complete', { alerts: syncSummary.cachedAlerts, decisions: syncSummary.cachedDecisions })
            : syncSummary.state === 'partial'
              ? t('server.sync.partial', {
                  alerts: syncSummary.cachedAlerts,
                  decisions: syncSummary.cachedDecisions,
                  failures: syncSummary.errors.length,
                })
              : t('server.sync.failed', {
                  reason: syncSummary.errors[0] || t('server.sync.failedNoWindows'),
                }),
          completedAt,
        });
        await runNotificationEvaluation('cache initialization');
        cacheRefreshCompletedAt = new Date().toISOString();
        publishCacheUpdate(cacheRefreshCompletedAt);
        const errorSummary = syncSummary.errors.length > 0
          ? `  Errors: ${syncSummary.errors.length} window${syncSummary.errors.length === 1 ? '' : 's'} failed
`
          : '';
        const cacheSummary = `Cache ${syncSummary.state === 'complete' ? 'initialized successfully' : 'initialized partially'}:
  Historical: ${syncSummary.historicalAlerts} alerts and ${syncSummary.historicalDecisions} decisions fetched
  Cache: ${syncSummary.cachedAlerts} alerts and ${syncSummary.cachedDecisions} decisions
${errorSummary}  Status: ${syncSummary.state}
  Refresh Interval: ${getIntervalName(refreshIntervalMs)}
`;
        if (syncSummary.state === 'complete') {
          console.log(cacheSummary);
        } else {
          console.warn(cacheSummary);
        }
        return syncSummary;
      } catch (error: any) {
        cache.isInitialized = false;
        cache.isComplete = false;
        lapiClient.updateStatus(false, error);
        console.error('Failed to initialize cache:', error.message);
        updateSyncStatus({
          isSyncing: false,
          progress: 0,
          message: `Sync failed: ${error.message}`,
          completedAt: new Date().toISOString(),
          state: 'failed',
          errors: [error.message],
        });
        return null;
      } finally {
        if (deferIndexUpdates && !deferredIndexesRebuilt) {
          try {
            await syncWorker.rebuildSearchIndexes();
          } catch (error: any) {
            console.error('Failed to rebuild deferred indexes:', error.message);
          }
        }
        initializationPromise = null;
      }
    })();

    return initializationPromise;
  }

  async function initializeMultiInstanceCache(options: { showOverlay?: boolean } = {}): Promise<SyncHistorySummary | null> {
    if (initializationPromise) {
      console.log('Multi-instance cache initialization already in progress, waiting...');
      return initializationPromise;
    }

    initializationPromise = (async () => {
      const startedAt = Date.now();
      const t = getServerTranslator(database);
      const freshBulkImport = database.countAlerts() === 0 && database.countDecisions() === 0;
      let deferredIndexes = false;
      let indexesRebuilt = false;
      const runtimes = config.instances.map((instance) => getInstanceSyncRuntime(instance.id));
      for (const runtime of runtimes) historicalInstanceSyncPending.add(runtime.instanceId);

      try {
        // Keep the read/paging indexes available, but avoid row-by-row FTS
        // maintenance while multiple chunked imports share the writer.
        await syncWorker.beginDeferredSearchIndexUpdates(false, false);
        deferredIndexes = true;

        const summaries = await Promise.all(runtimes.map((runtime) => withInstanceNetworkSlot(async () => {
          try {
            return await syncHistory(options.showOverlay ?? true, runtime, freshBulkImport);
          } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            runtime.client.updateStatus(false, failure);
            Object.assign(runtime.status, {
              isSyncing: true,
              progress: 0,
              message: `${runtime.instanceName} sync failed: ${failure.message}`,
              completedAt: null,
              state: 'failed',
              errors: [failure.message],
            });
            console.error(`[${runtime.instanceName}] Historical sync failed: ${failure.message}`);
            return {
              historicalAlerts: 0,
              historicalDecisions: 0,
              historicalErrors: [failure.message],
              errors: [failure.message],
              state: 'failed' as const,
              cachedAlerts: database.countAlerts(runtime.instanceId),
              cachedDecisions: database.countDecisions(runtime.instanceId),
              changed: false,
              syncedThrough: new Date().toISOString(),
            };
          }
        })));

        for (const runtime of runtimes) {
          if (runtime.status.state === 'failed') continue;
          runtime.status.progress = 96;
          runtime.status.message = t('components.syncOverlay.statusFinalizingDecisions');
        }
        await syncWorker.rebuildSearchIndexes();
        indexesRebuilt = true;
        await syncWorker.refreshDecisionDuplicateFlags(new Date().toISOString());

        invalidateDashboardStatsCache();
        const anyUsable = summaries.some((summary) => summary.state !== 'failed');
        cache.isInitialized = anyUsable;
        cache.isComplete = summaries.every((summary) => summary.state === 'complete');
        const successfulThrough = summaries
          .filter((summary) => summary.state !== 'failed')
          .map((summary) => summary.syncedThrough)
          .sort();
        cache.lastUpdate = successfulThrough[0] || null;
        for (let index = 0; index < runtimes.length; index += 1) {
          const runtime = runtimes[index];
          const summary = summaries[index];
          if (summary.state !== 'failed') instanceLastUpdates.set(runtime.instanceId, summary.syncedThrough);
          runtime.client.updateStatus(summary.state === 'complete', summary.errors[0] ? { message: summary.errors[0] } : null);
          if (summary.state !== 'failed') {
            runtime.status.progress = 99;
            runtime.status.message = t('components.syncOverlay.statusPreparingDashboard');
          }
        }
        if (cache.isInitialized) {
          try {
            await getDashboardStatsIndex('all');
          } catch (error: any) {
            console.error('Failed to prepare Combined dashboard data before completing initial sync:', error.message);
          }
        }

        const completedAt = new Date().toISOString();
        const allErrors: string[] = [];
        for (let index = 0; index < runtimes.length; index += 1) {
          const runtime = runtimes[index];
          const summary = summaries[index];
          const errors = summary.errors.map((error) => `${runtime.instanceName}: ${error}`);
          allErrors.push(...errors);
          Object.assign(runtime.status, {
            isSyncing: false,
            progress: summary.state === 'failed' ? 0 : 100,
            message: summary.state === 'complete'
              ? t('server.sync.complete', { alerts: summary.cachedAlerts, decisions: summary.cachedDecisions })
              : summary.state === 'partial'
                ? t('server.sync.partial', {
                    alerts: summary.cachedAlerts,
                    decisions: summary.cachedDecisions,
                    failures: summary.errors.length,
                  })
                : t('server.sync.failed', { reason: summary.errors[0] || t('server.sync.failedNoWindows') }),
            completedAt,
            state: summary.state,
            errors: summary.errors,
          });
          historicalInstanceSyncPending.delete(runtime.instanceId);
        }
        if (summaries[0]?.state === 'complete') {
          seedReconcileWindowState(Date.parse(summaries[0].syncedThrough));
        }
        await runNotificationEvaluation('multi-instance cache initialization');
        cacheRefreshCompletedAt = completedAt;
        publishCacheUpdate(completedAt, runtimes.map((runtime) => runtime.instanceId));

        const state = summaries.every((summary) => summary.state === 'complete')
          ? 'complete'
          : summaries.every((summary) => summary.state === 'failed')
            ? 'failed'
            : 'partial';
        const result: SyncHistorySummary = {
          historicalAlerts: summaries.reduce((total, summary) => total + summary.historicalAlerts, 0),
          historicalDecisions: summaries.reduce((total, summary) => total + summary.historicalDecisions, 0),
          historicalErrors: allErrors,
          errors: allErrors,
          state,
          cachedAlerts: database.countAlerts(),
          cachedDecisions: database.countDecisions(),
          changed: summaries.some((summary) => summary.changed),
          syncedThrough: cache.lastUpdate || completedAt,
        };
        console.log(`All instance histories finalized in ${formatElapsedTime(Date.now() - startedAt)}.`);
        return result;
      } catch (error: any) {
        cache.isInitialized = false;
        cache.isComplete = false;
        const completedAt = new Date().toISOString();
        for (const runtime of runtimes) {
          const historyFailed = runtime.status.state === 'failed';
          Object.assign(runtime.status, {
            isSyncing: false,
            progress: historyFailed ? 0 : 100,
            completedAt,
            state: historyFailed ? 'failed' : 'partial',
            errors: [...(runtime.status.errors || []), error.message],
            message: `${runtime.instanceName} sync finalization failed: ${error.message}`,
          });
          runtime.client.updateStatus(false, error);
          historicalInstanceSyncPending.delete(runtime.instanceId);
        }
        console.error('Failed to initialize multi-instance cache:', error.message);
        return null;
      } finally {
        if (deferredIndexes && !indexesRebuilt) {
          try {
            await syncWorker.rebuildSearchIndexes();
          } catch (error: any) {
            console.error('Failed to restore search indexes after multi-instance initialization:', error.message);
          }
        }
        initializationPromise = null;
      }
    })();

    return initializationPromise;
  }

  function initializeCache(options: { showOverlay?: boolean } = {}): Promise<SyncHistorySummary | null> {
    return config.instances.length > 1
      ? initializeMultiInstanceCache(options)
      : initializeSingleInstanceCache(options);
  }

  async function updateCacheDelta(options: { throwOnError?: boolean; reconcile?: boolean } = {}): Promise<void> {
    if (!cache.isInitialized || !cache.lastUpdate) {
      console.log('Cache not initialized, performing full load...');
      const ready = await ensureBootstrapReady('delta update full load');
      if (!ready && options.throwOnError) throw new Error('The cache could not be initialized');
      return;
    }

    try {
      const deltaStartedAt = Date.now();
      const diffSeconds = Math.ceil((deltaStartedAt - new Date(cache.lastUpdate).getTime()) / 1_000) + 10;
      const normalDeltaStart = deltaStartedAt - diffSeconds * 1_000;
      const reconcilePlan = options.reconcile === false ? null : await planDueReconcileWindows(deltaStartedAt);
      const headWindow = reconcilePlan?.windows.find((window) => window.head);
      const deltaStart = Math.min(normalDeltaStart, headWindow?.start ?? normalDeltaStart);
      console.log(`Fetching delta updates (${formatSyncWindow(deltaStart, deltaStartedAt, deltaStartedAt)})...`);
      const deltaSummary = await syncAlertWindow(deltaStart, deltaStartedAt, deltaStartedAt);
      if (deltaSummary.errors.length > 0) {
        throw deltaSummary.lastError || new Error(`Delta update incomplete: ${deltaSummary.errors.join('; ')}`);
      }
      if (headWindow) {
        // The expanded delta already authoritatively reconciled the moving
        // head, avoiding a second set of LAPI scope requests for that window.
        recordReconcileWindowSuccess(headWindow, deltaStartedAt);
      }

      const excludedKeys = headWindow ? new Set([headWindow.key]) : new Set<string>();
      const reconcileSummary: WindowSyncSummary = reconcilePlan
        ? await runPlannedReconcileWindows(reconcilePlan, deltaStartedAt, excludedKeys)
        : { alerts: 0, decisions: 0, errors: [], successfulWindows: 0, changed: false };
      if (reconcilePlan) finishReconcilePlan(reconcilePlan);
      const duplicateRefreshStartedAt = Date.now();
      await syncWorker.refreshDecisionDuplicateFlags(new Date().toISOString());
      console.log(`Decision duplicate index refreshed in ${formatElapsedTime(Date.now() - duplicateRefreshStartedAt)}.`);
      // Rebuild before announcing completion so the refresh does not transfer
      // its most expensive database scan to the first dashboard request. This
      // also refreshes time-dependent active totals when no SQLite rows changed.
      invalidateDashboardStatsCache();
      const dashboardRefreshStartedAt = Date.now();
      try {
        if (await prepareDashboardStatsAfterRefresh()) {
          console.log(`Dashboard statistics prepared in ${formatElapsedTime(Date.now() - dashboardRefreshStartedAt)}.`);
        }
      } catch (error: any) {
        // Dashboard requests retain their normal lazy-build fallback if cache
        // preparation fails; a reporting-cache failure must not lose a valid
        // LAPI delta or prevent the next refresh from running.
        console.error('Failed to prepare dashboard statistics after delta update:', error.message);
      }
      // Advance only through the exact authoritative delta end. Work performed
      // after this timestamp is intentionally picked up by the next overlap.
      cache.lastUpdate = new Date(deltaStartedAt).toISOString();
      instanceLastUpdates.set(primaryInstance.id, cache.lastUpdate);
      const reconcileError = reconcileSummary.lastError || (reconcileSummary.errors[0] ? new Error(reconcileSummary.errors[0]) : null);
      lapiClient.updateStatus(reconcileSummary.errors.length === 0, reconcileError);
      const completedReconcileWindows = reconcileSummary.successfulWindows + (headWindow ? 1 : 0);
      console.log(
        `Delta update complete: ${deltaSummary.alerts} alerts and ${deltaSummary.decisions} decisions synced; ${completedReconcileWindows} reconciliation window${completedReconcileWindows === 1 ? '' : 's'} completed`,
      );
      cacheRefreshCompletedAt = new Date().toISOString();
      publishCacheUpdate(cacheRefreshCompletedAt);
    } catch (error: any) {
      console.error('Failed to update cache delta:', error.message);
      lapiClient.updateStatus(false, error);
      if (options.throwOnError) throw error;
    }
  }

  async function refreshLatestWindow(): Promise<void> {
    return runCacheRefresh(async () => {
      if (!cache.isInitialized) {
        throw new Error('The cache must be initialized before refreshing the latest window');
      }

      const now = Date.now();
      const currentWindowStart = Math.floor(now / config.reconcileWindowMs) * config.reconcileWindowMs;
      const start = Math.max(now - config.lookbackMs, currentWindowStart);
      console.log(`Manual latest-window refresh (${formatSyncWindow(start, now, now)})...`);
      const summary = await syncAlertWindow(start, now, now);
      if (summary.errors.length > 0) {
        const error = summary.lastError || new Error(`Latest-window refresh incomplete: ${summary.errors.join('; ')}`);
        lapiClient.updateStatus(false, error);
        throw error;
      }

      reconcileWindowState.headLastSuccess = now;
      saveReconcileWindowState();
      await syncWorker.refreshDecisionDuplicateFlags(new Date().toISOString());
      invalidateDashboardStatsCache();
      try {
        await prepareDashboardStatsAfterRefresh();
      } catch (error: any) {
        console.error('Failed to prepare dashboard statistics after latest-window refresh:', error.message);
      }
      cache.lastUpdate = new Date(now).toISOString();
      instanceLastUpdates.set(primaryInstance.id, cache.lastUpdate);
      lapiClient.updateStatus(true, null);
      await cleanupOldData();
      await runNotificationEvaluation('manual latest-window refresh');
      cacheRefreshCompletedAt = new Date().toISOString();
      publishCacheUpdate(cacheRefreshCompletedAt);
      console.log(`Latest-window refresh complete: ${summary.alerts} alerts and ${summary.decisions} decisions synced.`);
    });
  }

  async function refreshFullHistory(): Promise<void> {
    return runCacheRefresh(async () => {
      const summary = await initializeCache({ showOverlay: true });
      if (!summary || summary.state === 'failed') {
        throw new Error(summary?.errors[0] || 'Full historical refresh failed');
      }
      await cleanupOldData();
    });
  }

  async function cleanupOldData(): Promise<void> {
    const cutoff = new Date(Date.now() - config.lookbackMs).toISOString();
    try {
      const removed = await syncWorker.cleanupOldData(cutoff);
      console.log(`Cleanup: Removed ${removed.alerts} old alerts, ${removed.decisions} old decisions`);
    } catch (error: any) {
      console.error('Cleanup failed:', error.message);
    }
  }

  function runCacheRefresh(operation: () => Promise<void>, skipIfBusy = false): Promise<void> {
    if (cacheRefreshPromise) return skipIfBusy ? Promise.resolve() : cacheRefreshPromise;

    cacheRefreshPromise = operation().finally(() => {
      cacheRefreshPromise = null;
    });
    return cacheRefreshPromise;
  }

  async function updateCache(options: { throwOnError?: boolean; reconcile?: boolean; skipIfBusy?: boolean } = {}): Promise<void> {
    return runCacheRefresh(async () => {
      await updateCacheDelta(options);
      await cleanupOldData();
      await runNotificationEvaluation('cache update');
    }, options.skipIfBusy);
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

  function scheduleBootstrapRetry(reason = 'retry requested', options: { allowInitialized?: boolean } = {}): void {
    if (
      !lapiClient.hasAuthConfig() ||
      !config.bootstrapRetryEnabled ||
      (!options.allowInitialized && cache.isInitialized) ||
      bootstrapRetryTimeout
    ) {
      return;
    }

    console.log(`Next bootstrap attempt scheduled in ${getIntervalName(config.bootstrapRetryDelayMs)}: ${reason}.`);
    bootstrapRetryTimeout = setTimeout(() => {
      bootstrapRetryTimeout = null;
      void ensureBootstrapReady('bootstrap retry');
    }, config.bootstrapRetryDelayMs);
  }

  async function prepareReadCache(source: string): Promise<void> {
    if (cache.isInitialized) {
      return;
    }

    if (bootstrapPromise && isBackgroundBootstrapSource(bootstrapSource)) {
      return;
    }

    await ensureBootstrapReady(source);
  }

  function isBackgroundBootstrapSource(source: string | null): boolean {
    return source === 'startup' || source === 'bootstrap retry';
  }

  async function ensureBootstrapReady(source = 'bootstrap'): Promise<boolean> {
    if (!lapiClient.hasAuthConfig()) {
      return false;
    }

    const shouldRetryIncompleteCache = cache.isInitialized && !cache.isComplete && source.includes('retry');
    if (cache.isInitialized && !shouldRetryIncompleteCache) {
      if (!cache.isComplete) {
        scheduleBootstrapRetry(`cache is partially initialized during ${source}`, { allowInitialized: true });
      }
      finalizeBootstrapRecovery();
      return true;
    }

    if (bootstrapPromise) {
      console.log(`Bootstrap recovery already in progress; joining it (${source})...`);
      return bootstrapPromise;
    }

    // A manually or request-triggered recovery supersedes any older retry that
    // was scheduled while the cache was unavailable.
    clearBootstrapRetryTimeout();
    bootstrapSource = source;
    bootstrapPromise = (async () => {
      console.log(`Starting bootstrap recovery (${source})...`);
      if (!lapiClient.hasToken()) {
        const loginSuccess = await lapiClient.login(`bootstrap: ${source}`);
        if (!loginSuccess) {
          scheduleBootstrapRetry(`authentication failed during ${source}`);
          return false;
        }
      }

      // Pending deletions are durable tombstones. Process their current phase
      // before history sync so a restart cannot reintroduce a user-deleted
      // alert while its delayed LAPI deletion is still outstanding.
      await processPendingAlertDeletions(`before historical sync: ${source}`);

      const syncSummary = await initializeCache();
      if (syncSummary?.state === 'complete') {
        finalizeBootstrapRecovery();
        console.log(`Bootstrap recovery completed successfully (${source}).`);
        return true;
      }

      if (syncSummary?.state === 'partial') {
        finalizeBootstrapRecovery();
        console.warn(`Bootstrap recovery completed partially (${source}); retrying incomplete windows in the background.`);
        scheduleBootstrapRetry(`partial cache initialization during ${source}`, { allowInitialized: true });
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
      bootstrapSource = null;
    }
  }

  async function runSchedulerLoop(): Promise<void> {
    if (!isSchedulerRunning) return;
    schedulerTimeout = null;
    nextRefreshAt = null;

    const now = Date.now();
    const isIdle = now - lastRequestTime > config.idleThresholdMs;

    try {
      if (bootstrapPromise || initializationPromise) {
        if (!bootstrapWaitLogged) {
          bootstrapWaitLogged = true;
          console.log('Background refresh paused until bootstrap recovery completes.');
        }
      } else if (historicalInstanceSyncPending.size > 0) {
        if (!bootstrapWaitLogged) {
          bootstrapWaitLogged = true;
          console.log('Background refresh paused until all instance history is synchronized.');
        }
      } else if (!cache.isInitialized) {
        if (!bootstrapWaitLogged) {
          bootstrapWaitLogged = true;
          console.log('Background refresh paused because the cache is not initialized.');
        }
        scheduleBootstrapRetry('cache is not initialized');
      } else {
        if (cacheRefreshPromise) {
          console.log('Background refresh skipped because another refresh is already in progress.');
        } else {
          console.log(`Background refresh triggered (${isIdle ? 'IDLE' : 'ACTIVE'})...`);
          await updateCache({ skipIfBusy: true });
        }
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
    nextRefreshAt = new Date(Date.now() + nextInterval).toISOString();
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
    nextRefreshAt = new Date(Date.now() + refreshIntervalMs).toISOString();
  }

  function stopRefreshScheduler(logStop = true): void {
    if (logStop && (isSchedulerRunning || schedulerTimeout || bootstrapRetryTimeout)) {
      console.log('Stopping refresh scheduler...');
    }
    isSchedulerRunning = false;
    nextRefreshAt = null;
    if (schedulerTimeout) {
      clearTimeout(schedulerTimeout);
      schedulerTimeout = null;
    }
    if (bootstrapRetryTimeout) {
      clearTimeout(bootstrapRetryTimeout);
      bootstrapRetryTimeout = null;
    }
  }

  async function sendMachineHeartbeat(): Promise<void> {
    if (!lapiClient.hasAuthConfig()) {
      return;
    }

    if (heartbeatPromise) {
      return heartbeatPromise;
    }

    heartbeatPromise = (async () => {
      try {
        await lapiClient.heartbeat();
        await lapiClient.sendUsageMetrics();
        if (heartbeatFailureLogged) {
          console.log('CrowdSec machine heartbeat restored.');
        }
        heartbeatFailureLogged = false;
      } catch (error: any) {
        const message = error?.message || 'Unknown error';
        if (!heartbeatFailureLogged) {
          console.warn(`CrowdSec machine heartbeat or metrics update failed: ${message}`);
        }
        heartbeatFailureLogged = true;
      } finally {
        heartbeatPromise = null;
      }
    })();

    return heartbeatPromise;
  }

  async function runHeartbeatLoop(): Promise<void> {
    if (!isHeartbeatSchedulerRunning) return;

    await sendMachineHeartbeat();

    if (!isHeartbeatSchedulerRunning || config.heartbeatIntervalMs <= 0) return;

    heartbeatTimeout = setTimeout(() => {
      void runHeartbeatLoop();
    }, config.heartbeatIntervalMs);
  }

  function startHeartbeatScheduler(): void {
    stopHeartbeatScheduler(false);
    if (config.heartbeatIntervalMs <= 0) {
      console.log('CrowdSec machine heartbeat disabled.');
      return;
    }

    console.log(`Starting CrowdSec machine heartbeat (${getIntervalName(config.heartbeatIntervalMs)})...`);
    isHeartbeatSchedulerRunning = true;
    heartbeatTimeout = setTimeout(() => {
      void runHeartbeatLoop();
    }, 0);
  }

  function stopHeartbeatScheduler(logStop = true): void {
    if (logStop && (isHeartbeatSchedulerRunning || heartbeatTimeout)) {
      console.log('Stopping CrowdSec machine heartbeat...');
    }
    isHeartbeatSchedulerRunning = false;
    if (heartbeatTimeout) {
      clearTimeout(heartbeatTimeout);
      heartbeatTimeout = null;
    }
  }

  async function activityTrackerMiddleware(context: HonoContext, next: HonoNext): Promise<void> {
    const pathname = new URL(context.req.url).pathname;
    if (pathname === '/api/health' || pathname === `${config.basePath}/api/health`) {
      await next();
      return;
    }

    const now = Date.now();
    const wasIdle = now - lastRequestTime > config.idleThresholdMs;
    lastRequestTime = now;

    if (wasIdle && isSchedulerRunning) {
      console.log('System waking up from idle mode. Triggering immediate refresh...');
      if (schedulerTimeout) {
        clearTimeout(schedulerTimeout);
        schedulerTimeout = null;
      }
      nextRefreshAt = null;
      void runSchedulerLoop();
    }

    await next();
  }

  async function ensureAuth(context: HonoContext, next: HonoNext): Promise<Response | void> {
    let authorized = false;
    const authResponse = await dashboardAuth.ensureAuth(context, async () => {
      authorized = true;
    });
    if (authResponse) return authResponse;
    if (!authorized) return undefined;

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

  function validateInstanceEntityRefs(refs: InstanceEntityRef[]): InstanceEntityRef[] | { error: string } {
    const unique = new Map<string, InstanceEntityRef>();
    for (const candidate of refs) {
      const instanceId = String(candidate?.instance_id || '').trim();
      const id = String(candidate?.id || '').trim();
      if (!config.instances.some((instance) => instance.id === instanceId)) {
        return { error: `Unknown CrowdSec instance: ${instanceId || '(missing)'}` };
      }
      if (!/^\d+$/.test(id)) {
        return { error: 'Entity IDs must be numeric' };
      }
      unique.set(`${instanceId}\u0000${id}`, { instance_id: instanceId, id });
    }
    return Array.from(unique.values());
  }

  function groupInstanceEntityRefs(refs: InstanceEntityRef[]): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const ref of refs) {
      const ids = groups.get(ref.instance_id) || [];
      ids.push(String(ref.id));
      groups.set(ref.instance_id, ids);
    }
    return groups;
  }

  function normalizeNotificationIds(ids: Array<string | number> | undefined): string[] {
    if (!Array.isArray(ids)) {
      return [];
    }

    return Array.from(
      new Set(
        ids
          .map((id) => String(id).trim())
          .filter((id) => id.length > 0),
      ),
    );
  }

  function isValidIpOrRange(value: string): boolean {
    return IPV4_RE.test(value) || IPV6_RE.test(value);
  }

  function isPermissionError(error: AnyError): boolean {
    return error.response?.status === 403;
  }

  function isAlreadyGoneError(error: AnyError): boolean {
    return error.response?.status === 404 || error.response?.status === 410;
  }

  function toFailure(kind: 'alert' | 'decision', id: string, error: AnyError): BulkDeleteFailure {
    return {
      kind,
      id,
      error: error.message || 'Delete failed',
    };
  }

  async function deleteAlertFromLapi(id: string): Promise<unknown> {
    try {
      return await lapiClient.deleteAlert(id);
    } catch (error) {
      const typedError = error as AnyError;
      if (isAlreadyGoneError(typedError)) {
        console.log(`Alert ${id} is already missing in LAPI; removing local cache entry.`);
        return { message: 'Deleted' };
      }
      throw typedError;
    }
  }

  async function deleteDecisionFromLapi(id: string): Promise<unknown> {
    try {
      return await lapiClient.deleteDecision(id);
    } catch (error) {
      const typedError = error as AnyError;
      if (isAlreadyGoneError(typedError)) {
        console.log(`Decision ${id} is already missing in LAPI; removing local cache entry.`);
        return { message: 'Deleted' };
      }
      throw typedError;
    }
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
    return database.getDecisionsSince(since, now).map((row) => ({
      id: String(row.id),
      value: typeof row.value === 'string' ? row.value : undefined,
    }));
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

  function getLinkedDecisionIds(alert: CachedAlertRecord): string[] {
    return getDecisionIdsForAlertIds([alert.id]);
  }

  async function getAlertForDeletion(id: string): Promise<CachedAlertRecord | null> {
    const snapshot = database.getAlertDecisionSnapshot(id);
    if (!snapshot) {
      try {
        const alert = await lapiClient.getAlertById(id) as AlertRecord;
        return {
          id,
          sourceValue: getAlertSourceValue(alert.source),
          raw_data: JSON.stringify(alert),
        };
      } catch (error) {
        if (isAlreadyGoneError(error as AnyError)) return null;
        throw error;
      }
    }

    try {
      const alert = JSON.parse(snapshot.raw_data) as AlertRecord;
      return {
        id,
        sourceValue: getAlertSourceValue(alert.source),
        raw_data: snapshot.raw_data,
      };
    } catch {
      return { id, raw_data: snapshot.raw_data };
    }
  }

  function parsePendingDecisionIds(value: string): string[] {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed)
        ? parsed.map(String).filter((id) => /^\d+$/.test(id))
        : [];
    } catch {
      return [];
    }
  }

  function clearPendingAlertDeletionTimeout(): void {
    if (!pendingAlertDeletionTimeout) return;
    clearTimeout(pendingAlertDeletionTimeout);
    pendingAlertDeletionTimeout = null;
  }

  function processPendingAlertDeletionsInBackground(source: string): void {
    void processPendingAlertDeletions(source).catch((error) => {
      console.error(`Pending alert deletion processor failed (${source}): ${(error as Error).message}`);
    });
  }

  function getPendingAlertDeletionNextRunAt(
    rows: ReturnType<CrowdsecDatabase['getPendingAlertDeletions']>,
    now: number,
  ): number | null {
    if (rows.length === 0) return null;
    const retryDelayMs = 30_000;
    return Math.min(...rows.map((row) => {
      const lastAttempt = row.last_attempt_at ? Date.parse(row.last_attempt_at) : 0;
      const retryAt = row.last_error && lastAttempt > 0 ? lastAttempt + retryDelayMs : 0;
      if (!row.decisions_deleted_at) return retryAt || now;
      const deleteAt = row.delete_after ? Date.parse(row.delete_after) : now;
      return Math.max(deleteAt, retryAt);
    }));
  }

  function logPendingAlertDeletionQueue(
    rows: ReturnType<CrowdsecDatabase['getPendingAlertDeletions']>,
    context: string,
    nextRunAt: number | null = getPendingAlertDeletionNextRunAt(rows, Date.now()),
  ): void {
    if (rows.length === 0) {
      console.log('[deletion-queue] Queue is empty.');
      return;
    }

    const failed = rows.filter((row) => Boolean(row.last_error)).length;
    const nextRun = nextRunAt === null ? 'none' : new Date(nextRunAt).toISOString();
    console.log(
      `[deletion-queue] ${context}: ${rows.length} pending, ${failed} failed; next run ${nextRun}.`,
    );
  }

  function schedulePendingAlertDeletionProcessing(): void {
    clearPendingAlertDeletionTimeout();
    if (pendingAlertDeletionStopped) return;
    const rows = database.getPendingAlertDeletions();
    if (rows.length === 0) {
      logPendingAlertDeletionQueue(rows, 'scheduler');
      return;
    }

    const now = Date.now();
    const nextAt = getPendingAlertDeletionNextRunAt(rows, now) ?? now;
    logPendingAlertDeletionQueue(rows, 'scheduler', nextAt);
    pendingAlertDeletionTimeout = setTimeout(() => {
      pendingAlertDeletionTimeout = null;
      processPendingAlertDeletionsInBackground('scheduled retry');
    }, Math.max(0, nextAt - now));
    pendingAlertDeletionTimeout.unref?.();
  }

  async function processPendingAlertDeletions(source: string): Promise<void> {
    if (pendingAlertDeletionStopped) return;
    if (pendingAlertDeletionPromise) {
      pendingAlertDeletionRerunRequested = true;
      return pendingAlertDeletionPromise;
    }

    clearPendingAlertDeletionTimeout();
    pendingAlertDeletionPromise = (async () => {
      const rows = database.getPendingAlertDeletions();
      if (rows.length > 0) {
        logPendingAlertDeletionQueue(rows, `processing (${source})`);
      }

      for (const row of rows) {
        let decisionsDeletedAt = row.decisions_deleted_at;
        let deleteAfter = row.delete_after;

        if (!decisionsDeletedAt) {
          try {
            const decisionIds = parsePendingDecisionIds(row.decision_ids_json);
            for (const decisionId of decisionIds) {
              await deleteDecisionFromLapi(decisionId);
            }
            const deletedAt = new Date().toISOString();
            const delayMs = decisionIds.length > 0 ? config.bouncerPropagationDelayMs : 0;
            const dueAt = new Date(Date.now() + delayMs).toISOString();
            await syncWorker.runExclusive(() => {
              database.markAlertDeletionDecisionsExpired(row.alert_id, deletedAt, dueAt);
            });
            decisionsDeletedAt = deletedAt;
            deleteAfter = dueAt;
          } catch (error) {
            const typedError = error as AnyError;
            if (typedError.response?.status === 401 && await lapiClient.login('pending alert decision deletion')) {
              pendingAlertDeletionRerunRequested = true;
            }
            const attemptedAt = new Date().toISOString();
            await syncWorker.runExclusive(() => {
              database.recordAlertDeletionFailure(row.alert_id, attemptedAt, typedError.message || 'Decision deletion failed');
            });
            console.error(`[deletion-queue] Alert ${row.alert_id} decision deletion failed and remains queued: ${typedError.message}`);
            continue;
          }
        }

        if (!decisionsDeletedAt || (deleteAfter && Date.parse(deleteAfter) > Date.now())) {
          continue;
        }

        try {
          await deleteAlertFromLapi(row.alert_id);
          const completedAt = new Date().toISOString();
          await syncWorker.runExclusive(() => {
            database.completeAlertDeletion(row.alert_id, completedAt);
          });
          const decisionCount = parsePendingDecisionIds(row.decision_ids_json).length;
          console.log(`[deletion-queue] Deleted alert ${row.alert_id} and ${decisionCount} linked decision(s).`);
        } catch (error) {
          const typedError = error as AnyError;
          if (typedError.response?.status === 401 && await lapiClient.login('pending alert deletion')) {
            pendingAlertDeletionRerunRequested = true;
          }
          const attemptedAt = new Date().toISOString();
          await syncWorker.runExclusive(() => {
            database.recordAlertDeletionFailure(row.alert_id, attemptedAt, typedError.message || 'Alert deletion failed');
          });
          console.error(`[deletion-queue] Alert ${row.alert_id} deletion failed and remains queued: ${typedError.message}`);
        }
      }

      const tombstoneRetentionMs = Math.max(config.lookbackMs, config.lapiRequestTimeoutMs * 2, 60_000);
      const completedBefore = new Date(Date.now() - tombstoneRetentionMs).toISOString();
      const purged = await syncWorker.runExclusive(() => database.purgeCompletedAlertDeletions(completedBefore));
      if (purged > 0) {
        console.log(`[deletion-queue] Purged ${purged} completed deletion tombstone(s).`);
      }
    })();

    try {
      await pendingAlertDeletionPromise;
    } finally {
      pendingAlertDeletionPromise = null;
      if (pendingAlertDeletionStopped) {
        pendingAlertDeletionRerunRequested = false;
      } else if (pendingAlertDeletionRerunRequested) {
        pendingAlertDeletionRerunRequested = false;
        processPendingAlertDeletionsInBackground('queued while processor was active');
      } else {
        schedulePendingAlertDeletionProcessing();
      }
    }
  }

  async function queueAlertsForDeletion(linkedDecisionIdsByAlert: Map<string, string[]>): Promise<void> {
    const requestedAt = new Date().toISOString();
    await syncWorker.runExclusive(() => {
      const queue = database.transaction<Map<string, string[]>>((entries) => {
        for (const [alertId, decisionIds] of entries) {
          database.queueAlertDeletion(alertId, decisionIds, requestedAt);
          database.deleteDecisionsByAlertId(alertId);
          database.deleteAlert(alertId);
        }
      });
      try {
        queue(linkedDecisionIdsByAlert);
        database.refreshDecisionDuplicateFlags(new Date().toISOString());
      } finally {
        database.refreshAlertDeletionTombstones();
      }
    });
    const decisionCount = new Set(Array.from(linkedDecisionIdsByAlert.values()).flat()).size;
    console.log(
      `[deletion-queue] Queued ${linkedDecisionIdsByAlert.size} alert deletion(s) and ${decisionCount} decision deletion(s).`,
    );
    invalidateDashboardStatsCache();
    processPendingAlertDeletionsInBackground('new deletion request');
  }

  async function deleteAlertsByIds(ids: string[]): Promise<BulkDeleteResult> {
    const result = createDeleteResult({ requested_alerts: ids.length });
    const linkedDecisionIdsByAlert = new Map<string, string[]>();
    const decisionIdsToDelete = new Set<string>();

    for (const id of ids) {
      const alert = await getAlertForDeletion(id);
      const linkedDecisionIds = alert ? getLinkedDecisionIds(alert) : [];
      linkedDecisionIdsByAlert.set(id, linkedDecisionIds);
      for (const decisionId of linkedDecisionIds) decisionIdsToDelete.add(decisionId);
    }

    result.requested_decisions = decisionIdsToDelete.size;
    await queueAlertsForDeletion(linkedDecisionIdsByAlert);
    result.deleted_alerts = linkedDecisionIdsByAlert.size;
    result.deleted_decisions = decisionIdsToDelete.size;
    return result;
  }

  function getDecisionIdsForAlertIds(alertIds: string[]): string[] {
    const ids: string[] = [];
    const chunkSize = 900;
    for (let offset = 0; offset < alertIds.length; offset += chunkSize) {
      const chunk = alertIds.slice(offset, offset + chunkSize);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => '?').join(',');
      const rows = database.db.prepare(`SELECT id FROM decisions WHERE alert_id IN (${placeholders})`).all(...chunk) as Array<{ id: string | number }>;
      ids.push(...rows.map((row) => String(row.id)));
    }
    return ids;
  }

  async function deleteDecisionsByIds(ids: string[]): Promise<BulkDeleteResult> {
    const result = createDeleteResult({ requested_decisions: ids.length });
    const deletedDecisionIds: string[] = [];

    for (const id of ids) {
      try {
        await deleteDecisionFromLapi(id);
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
      await syncWorker.runExclusive(() => {
        const removeDecisions = database.transaction<string[]>((decisionIds) => {
          for (const id of decisionIds) {
            database.deleteDecision(id);
          }
        });
        removeDecisions(deletedDecisionIds);
        database.refreshDecisionDuplicateFlags(new Date().toISOString());
      });
      invalidateDashboardStatsCache();
    }

    result.deleted_decisions = deletedDecisionIds.length;
    return result;
  }

  async function deleteDecisionsByIdsInChunks(ids: string[]): Promise<BulkDeleteResult> {
    const aggregate = createDeleteResult({ requested_decisions: ids.length });
    const chunkSize = 100;
    for (let offset = 0; offset < ids.length; offset += chunkSize) {
      const result = await deleteDecisionsByIds(ids.slice(offset, offset + chunkSize));
      aggregate.deleted_decisions += result.deleted_decisions;
      aggregate.failed.push(...result.failed);
    }
    return aggregate;
  }

  async function deleteEntriesByIp(ip: string): Promise<BulkDeleteResult> {
    const alerts = getCachedAlertsForDeletion().filter((alert) => alert.sourceValue === ip);
    const decisions = getCachedDecisionsForDeletion().filter((decision) => decision.value === ip);
    const linkedDecisionIdsByAlert = new Map<string, string[]>();
    const linkedDecisionIds = new Set<string>();

    for (const alert of alerts) {
      const ids = getLinkedDecisionIds(alert);
      linkedDecisionIdsByAlert.set(alert.id, ids);
      for (const decisionId of ids) linkedDecisionIds.add(decisionId);
    }

    const standaloneDecisionIds = decisions
      .map((decision) => decision.id)
      .filter((decisionId) => !linkedDecisionIds.has(decisionId));
    const requestedDecisionIds = new Set([...linkedDecisionIds, ...standaloneDecisionIds]);
    const result = createDeleteResult({
      requested_alerts: alerts.length,
      requested_decisions: requestedDecisionIds.size,
      ip,
    });

    if (linkedDecisionIdsByAlert.size > 0) {
      await queueAlertsForDeletion(linkedDecisionIdsByAlert);
    }

    const deletedStandaloneDecisionIds: string[] = [];
    for (const decisionId of standaloneDecisionIds) {
      try {
        await deleteDecisionFromLapi(decisionId);
        deletedStandaloneDecisionIds.push(decisionId);
      } catch (error) {
        const typedError = error as AnyError;
        if (isPermissionError(typedError)) throw typedError;
        result.failed.push(toFailure('decision', decisionId, typedError));
      }
    }

    if (deletedStandaloneDecisionIds.length > 0) {
      await syncWorker.runExclusive(() => {
        const removeDecisions = database.transaction<string[]>((decisionIds) => {
          for (const decisionId of decisionIds) database.deleteDecision(decisionId);
        });
        removeDecisions(deletedStandaloneDecisionIds);
        database.refreshDecisionDuplicateFlags(new Date().toISOString());
      });
      invalidateDashboardStatsCache();
    }

    result.deleted_alerts = linkedDecisionIdsByAlert.size;
    result.deleted_decisions = linkedDecisionIds.size + deletedStandaloneDecisionIds.length;
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

    clone.decisions = decisions.map((decisionReference) => {
      const databaseDecision = database.getDecisionById(decisionReference.id);
      return hydrateDecisionForAlert(databaseDecision ? decisionFromRow(databaseDecision) : decisionReference, clone);
    });

    clone.reason = resolveAlertReason(clone);
    clone.scenario = resolveAlertScenario(clone);
    clone.simulated = isAlertSimulated(clone);

    return clone;
  }

  function hydrateAlertWithDecisionsBatch(
    alert: AlertRecord,
    decisionRows: NormalizedDecisionRow[],
  ): AlertRecord {
    const clone: AlertRecord = { ...alert };
    const normalizedDecisions = decisionRows.length > 0
      ? decisionRows.map(decisionFromRow)
      : Array.isArray(clone.decisions) ? clone.decisions : [];
    clone.decisions = normalizedDecisions.map((decision) => hydrateDecisionForAlert(decision, clone));

    clone.reason = resolveAlertReason(clone);
    clone.scenario = resolveAlertScenario(clone);
    clone.simulated = isAlertSimulated(clone);

    return clone;
  }

  function hydrateAlertsBatch(rows: Array<{ raw_data: string }>): AlertRecord[] {
    return hydrateAlertRecordsBatch(rows.map((row) => JSON.parse(row.raw_data) as AlertRecord));
  }

  function hydrateAlertRecordsBatch(parsedAlerts: AlertRecord[]): AlertRecord[] {
    const decisionsByAlertId = database.getDecisionDataByAlertIds(parsedAlerts.map((alert) => alert.id));
    return parsedAlerts.map((alert) => hydrateAlertWithDecisionsBatch(
      alert,
      decisionsByAlertId.get(String(alert.id)) || [],
    ));
  }

  function hydrateDecisionForAlert(
    decision: AlertDecision & Record<string, unknown>,
    alert: AlertRecord,
  ): AlertDecision {
    const now = new Date();
    const stopAt = decision.stop_at ? new Date(decision.stop_at) : null;
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
      simulated: normalizeDecisionSimulated(decision, alert),
    };
  }

  async function queryPaginatedAlerts(
    pageRequest: PageRequest,
    filters: AlertListFilters,
    searchAst: SearchNode | null,
    includeDecisions: boolean,
  ): Promise<PaginatedResponse<SlimAlert>> {
    const since = new Date(Date.now() - config.lookbackMs).toISOString();
    const baseWhere = createSqlWhere();
    baseWhere.add('created_at >= ?', since);
    if (filters.instanceId !== 'all') {
      baseWhere.add('instance_id = ?', filters.instanceId);
    } else {
      baseWhere.add(`instance_id IN (${config.instances.map(() => '?').join(',')})`, ...config.instances.map((instance) => instance.id));
    }
    if (!config.simulationsEnabled) {
      baseWhere.add('simulated = 0');
    }

    const filteredWhere = baseWhere.clone();
    addAlertSqlFilters(filteredWhere, filters);
    const searchWhere = compileAlertSearchSql(searchAst, filters);
    if (searchWhere) {
      filteredWhere.add(searchWhere.sql, ...searchWhere.params);
    }

    const offset = (pageRequest.page - 1) * pageRequest.pageSize;
    const [unfilteredTotal, total, rows] = await Promise.all([
      queryCount('alerts', baseWhere),
      queryCount('alerts', filteredWhere),
      queryWorker.all<NormalizedAlertRow>(`
        SELECT ${ALERT_RECORD_COLUMNS}
        FROM alerts
        ${filteredWhere.toSql()}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
      `, [...filteredWhere.params, pageRequest.pageSize, offset]),
    ]);

    const data = includeDecisions
      ? await buildFullSlimAlertList(rows)
      : await buildSlimAlertList(rows);

    return {
      data,
      pagination: {
        page: pageRequest.page,
        page_size: pageRequest.pageSize,
        total,
        total_pages: Math.ceil(total / pageRequest.pageSize),
        unfiltered_total: unfilteredTotal,
      },
      selectable_ids: data.map((alert) => alert.id),
      ...(config.instances.length > 1 ? {
        selectable_refs: data.map((alert) => ({ instance_id: alert.instance_id || primaryInstance.id, id: alert.id })),
      } : {}),
    };
  }

  async function buildFullSlimAlertList(rows: NormalizedAlertRow[]): Promise<SlimAlert[]> {
    const internalIds = rows.map((row) => row.internal_id).filter((id): id is string | number => id !== undefined);
    const decisionsByInternalId = new Map<string, NormalizedDecisionRow[]>();
    for (let offset = 0; offset < internalIds.length; offset += 900) {
      const chunk = internalIds.slice(offset, offset + 900);
      const placeholders = chunk.map(() => '?').join(',');
      const decisionRows = await queryWorker.all<NormalizedDecisionRow & { internal_alert_id: string | number }>(`
        SELECT ${DECISION_RECORD_COLUMNS}, alert_id AS internal_alert_id
        FROM decisions
        WHERE alert_id IN (${placeholders})
        ORDER BY created_at DESC, id DESC
      `, chunk);
      for (const decision of decisionRows) {
        const key = String(decision.internal_alert_id);
        const list = decisionsByInternalId.get(key) || [];
        list.push(decision);
        decisionsByInternalId.set(key, list);
      }
    }
    return enrichAlertLocations(rows.map((row) => hydrateAlertWithDecisionsBatch(
      alertFromRow(row),
      decisionsByInternalId.get(String(row.internal_id)) || [],
    ))
      .map(withInstanceName)
      .map((alert) => applySimulationModeToAlert(alert, config.simulationsEnabled))
      .filter((alert): alert is AlertRecord => alert !== null)
      .map(toSlimAlert));
  }

  async function buildSlimAlertList(rows: NormalizedAlertRow[]): Promise<SlimAlert[]> {
    const internalIds = rows.map((row) => row.internal_id).filter((id): id is string | number => id !== undefined);
    const decisionSummaries = await queryAlertDecisionSummaries(internalIds);
    return enrichAlertLocations(rows.map(alertFromRow)
      .map(withInstanceName)
      .map((alert) => applySimulationModeToAlert(alert, config.simulationsEnabled))
      .filter((alert): alert is AlertRecord => alert !== null)
      .map((alert, index) => ({
        ...toSlimAlert(alert),
        decisions: [],
        decision_summary: decisionSummaries.get(String(rows[index]?.internal_id)) || emptyAlertDecisionSummary(),
      })));
  }

  async function queryAlertDecisionSummaries(alertIds: Array<string | number>): Promise<Map<string, AlertDecisionSummary>> {
    const summaries = new Map<string, AlertDecisionSummary>();
    if (alertIds.length === 0) return summaries;

    const now = new Date().toISOString();
    const filterByAlertIds = alertIds.length <= 900;
    const placeholders = filterByAlertIds ? alertIds.map(() => '?').join(', ') : '';
    const rows = await queryWorker.all<{
      alert_id: string | number;
      origin?: string | null;
      simulated?: number | boolean | null;
      active_count: number;
      expired_count: number;
    }>(`
      SELECT alert_id, origin, simulated,
        SUM(CASE WHEN stop_at > ? THEN 1 ELSE 0 END) AS active_count,
        SUM(CASE WHEN stop_at <= ? THEN 1 ELSE 0 END) AS expired_count
      FROM decisions INDEXED BY idx_decisions_alert_summary
      ${filterByAlertIds ? `WHERE alert_id IN (${placeholders})` : ''}
      GROUP BY alert_id, origin, simulated
    `, filterByAlertIds ? [now, now, ...alertIds] : [now, now]);

    const originsByAlertId = new Map<string, Set<string>>();
    for (const row of rows) {
      const simulated = row.simulated === true || row.simulated === 1;
      if (!config.simulationsEnabled && simulated) continue;

      const alertId = String(row.alert_id);
      const summary = summaries.get(alertId) || emptyAlertDecisionSummary();
      const activeCount = Number(row.active_count) || 0;
      const expiredCount = Number(row.expired_count) || 0;
      summary.active_count += activeCount;
      summary.expired_count += expiredCount;
      if (simulated) {
        summary.simulated_active_count += activeCount;
        summary.simulated_expired_count += expiredCount;
      }
      summaries.set(alertId, summary);

      const origin = normalizeOrigin(row.origin);
      if (origin) {
        const origins = originsByAlertId.get(alertId) || new Set<string>();
        origins.add(origin);
        originsByAlertId.set(alertId, origins);
      }
    }

    for (const [alertId, origins] of originsByAlertId) {
      const summary = summaries.get(alertId);
      if (summary) summary.origins = [...origins].sort((left, right) => left.localeCompare(right));
    }
    return summaries;
  }

  async function queryPaginatedDecisions(
    pageRequest: PageRequest,
    filters: DecisionListFilters,
    searchAst: SearchNode | null,
    includeExpired: boolean,
  ): Promise<PaginatedResponse<DecisionListItem>> {
    const since = new Date(Date.now() - config.lookbackMs).toISOString();
    const now = new Date().toISOString();
    const duplicateSql = '(decisions.is_duplicate = 1)';
    const baseWhere = createSqlWhere();
    if (filters.instanceId !== 'all') {
      baseWhere.add('instance_id = ?', filters.instanceId);
    } else {
      baseWhere.add(`instance_id IN (${config.instances.map(() => '?').join(',')})`, ...config.instances.map((instance) => instance.id));
    }
    if (includeExpired) {
      baseWhere.add('(created_at >= ? OR stop_at > ?)', since, now);
    } else {
      baseWhere.add('stop_at > ?', now);
    }
    if (!config.simulationsEnabled) {
      baseWhere.add('simulated = 0');
    }

    const filteredWhere = baseWhere.clone();
    addDecisionSqlFilters(filteredWhere, filters, true);
    const searchWhere = compileDecisionSearchSql(searchAst, filters, now);
    if (searchWhere) {
      filteredWhere.add(searchWhere.sql, ...searchWhere.params);
    }

    const offset = (pageRequest.page - 1) * pageRequest.pageSize;
    const decisionsTable = `decisions ${getDecisionPageIndexHint(filters, searchAst)}`.trim();
    const [unfilteredTotal, total, rows] = await Promise.all([
      queryCount('decisions', baseWhere),
      queryCount('decisions', filteredWhere),
      queryWorker.all<NormalizedDecisionRow & {
        is_duplicate?: number;
        latitude?: number | null;
        longitude?: number | null;
      }>(`
        SELECT ${DECISION_RECORD_COLUMNS}, ${duplicateSql} AS is_duplicate,
          (SELECT latitude FROM alerts WHERE alerts.id = decisions.alert_id) AS latitude,
          (SELECT longitude FROM alerts WHERE alerts.id = decisions.alert_id) AS longitude
        FROM ${decisionsTable}
        ${filteredWhere.toSql()}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
      `, [...filteredWhere.params, pageRequest.pageSize, offset]),
    ]);

    const alertCoordinates = new Map<string, { latitude: number; longitude: number }>();
    const decisions = rows.map((row) => {
      const decision = decisionFromRow(row);
      decision.instance_name = instanceName(String(decision.instance_id || primaryInstance.id));
      const latitude = normalizeDashboardCoordinate(row.latitude, -90, 90);
      const longitude = normalizeDashboardCoordinate(row.longitude, -180, 180);
      if (row.alert_id !== undefined && row.alert_id !== null && latitude !== undefined && longitude !== undefined) {
        alertCoordinates.set(String(row.alert_id), { latitude, longitude });
      }
      decision.is_duplicate = row.is_duplicate === 1;
      return toDecisionListItem(decision, includeExpired);
    });
    const data = await enrichDecisionLocations(decisions, alertCoordinates);

    return {
      data,
      pagination: {
        page: pageRequest.page,
        page_size: pageRequest.pageSize,
        total,
        total_pages: Math.ceil(total / pageRequest.pageSize),
        unfiltered_total: unfilteredTotal,
      },
      selectable_ids: data
        .filter((decision) => !isDecisionListItemExpired(decision))
        .map((decision) => decision.id),
      ...(config.instances.length > 1 ? {
        selectable_refs: data
          .filter((decision) => !isDecisionListItemExpired(decision))
          .map((decision) => ({ instance_id: decision.instance_id || primaryInstance.id, id: decision.id })),
      } : {}),
    };
  }

  async function queryAlertFacet(
    request: FacetRequest,
    filters: AlertListFilters,
    searchAst: SearchNode | null,
  ): Promise<FacetResponse> {
    const effectiveFilters = withoutAlertFacetFilter(filters, request.field);
    const prunedSearchAst = removeSearchField(searchAst, request.field);
    const cacheKey = facetCacheKey(
      'alerts',
      request,
      effectiveFilters,
      prunedSearchAst,
      request.field === 'decision' ? { timeBucket: Math.floor(Date.now() / 60_000) } : {},
    );
    const cached = getCachedFacetResponse(cacheKey);
    if (cached) return cached;

    const since = new Date(Date.now() - config.lookbackMs).toISOString();
    const baseWhere = createSqlWhere();
    baseWhere.add('created_at >= ?', since);
    if (effectiveFilters.instanceId !== 'all') {
      baseWhere.add('instance_id = ?', effectiveFilters.instanceId);
    } else {
      baseWhere.add(`instance_id IN (${config.instances.map(() => '?').join(',')})`, ...config.instances.map((instance) => instance.id));
    }
    if (!config.simulationsEnabled) {
      baseWhere.add('simulated = 0');
    }

    const filteredWhere = baseWhere.clone();
    addAlertSqlFilters(filteredWhere, effectiveFilters);
    const searchWhere = compileAlertSearchSql(prunedSearchAst, effectiveFilters);
    if (searchWhere) {
      filteredWhere.add(searchWhere.sql, ...searchWhere.params);
    }

    const valueSql = ({
      id: "COALESCE(TRIM(CAST(upstream_id AS TEXT)), '')",
      instance: "COALESCE(TRIM(instance_id), '')",
      scenario: "COALESCE(TRIM(scenario), '')",
      country: "COALESCE(TRIM(country), '')",
      region: "COALESCE(TRIM(region), '')",
      city: "COALESCE(TRIM(city), '')",
      as: "COALESCE(TRIM(as_name), '')",
      ip: "COALESCE(TRIM(source_ip), '')",
      target: "COALESCE(TRIM(target), '')",
      machine: "COALESCE(TRIM(machine), '')",
      origin: "COALESCE(TRIM(origins), '')",
    } as Record<string, string>)[request.field];
    if (request.field === 'decision') {
      const simulationSql = config.simulationsEnabled ? '' : ' AND facet_decision.simulated = 0';
      const now = new Date().toISOString();
      const response = await queryFacetValues(
        'alerts',
        "''",
        [],
        filteredWhere,
        request,
        searchAst,
        {
          sql: `
            WITH filtered_alerts AS (
              SELECT id
              FROM alerts
              ${filteredWhere.toSql()}
            )
            SELECT 'active' AS value
            FROM filtered_alerts
            WHERE EXISTS (
                SELECT 1 FROM decisions facet_decision
                WHERE facet_decision.alert_id = filtered_alerts.id
                  AND facet_decision.stop_at > ?${simulationSql}
              )
            UNION ALL
            SELECT 'expired' AS value
            FROM filtered_alerts
            WHERE EXISTS (
                SELECT 1 FROM decisions facet_decision
                WHERE facet_decision.alert_id = filtered_alerts.id
                  AND facet_decision.stop_at <= ?${simulationSql}
              )
            UNION ALL
            SELECT '' AS value
            FROM filtered_alerts
            WHERE NOT EXISTS (
                SELECT 1 FROM decisions facet_decision
                WHERE facet_decision.alert_id = filtered_alerts.id${simulationSql}
              )
          `,
          params: [
            ...filteredWhere.params,
            now,
            now,
          ],
        },
      );
      setCachedFacetResponse(cacheKey, response);
      return response;
    }
    if (!valueSql) throw new Error(`Unsupported alert facet field: ${request.field}`);

    const response = await queryFacetValues(
      'alerts',
      valueSql,
      [],
      filteredWhere,
      request,
      searchAst,
    );
    setCachedFacetResponse(cacheKey, response);
    return response;
  }

  async function queryDecisionFacet(
    request: FacetRequest,
    filters: DecisionListFilters,
    searchAst: SearchNode | null,
    includeExpired: boolean,
  ): Promise<FacetResponse> {
    const effectiveFilters = withoutDecisionFacetFilter(filters, request.field);
    const prunedSearchAst = removeSearchField(searchAst, request.field);
    const effectiveIncludeExpired = includeExpired || request.field === 'status';
    const cacheKey = facetCacheKey('decisions', request, effectiveFilters, prunedSearchAst, {
      includeExpired: effectiveIncludeExpired,
      timeBucket: Math.floor(Date.now() / 60_000),
    });
    const cached = getCachedFacetResponse(cacheKey);
    if (cached) return cached;

    const since = new Date(Date.now() - config.lookbackMs).toISOString();
    const now = new Date().toISOString();
    const baseWhere = createSqlWhere();
    if (effectiveFilters.instanceId !== 'all') {
      baseWhere.add('instance_id = ?', effectiveFilters.instanceId);
    } else {
      baseWhere.add(`instance_id IN (${config.instances.map(() => '?').join(',')})`, ...config.instances.map((instance) => instance.id));
    }
    if (effectiveIncludeExpired) {
      baseWhere.add('(created_at >= ? OR stop_at > ?)', since, now);
    } else {
      baseWhere.add('stop_at > ?', now);
    }
    if (!config.simulationsEnabled) {
      baseWhere.add('simulated = 0');
    }

    const filteredWhere = baseWhere.clone();
    addDecisionSqlFilters(filteredWhere, effectiveFilters, true);
    const searchWhere = compileDecisionSearchSql(prunedSearchAst, effectiveFilters, now);
    if (searchWhere) {
      filteredWhere.add(searchWhere.sql, ...searchWhere.params);
    }

    const valueDefinition = request.field === 'status'
      ? { sql: "CASE WHEN stop_at > ? THEN 'active' ELSE 'expired' END", params: [now] }
      : {
        sql: ({
          id: "COALESCE(TRIM(CAST(upstream_id AS TEXT)), '')",
          instance: "COALESCE(TRIM(instance_id), '')",
          alert: "COALESCE(TRIM(CAST(alert_upstream_id AS TEXT)), '')",
          scenario: "COALESCE(TRIM(scenario), '')",
          country: "COALESCE(TRIM(country), '')",
          region: "COALESCE(TRIM(region), '')",
          city: "COALESCE(TRIM(city), '')",
          as: "COALESCE(TRIM(as_name), '')",
          ip: "COALESCE(TRIM(value), '')",
          target: "COALESCE(TRIM(target), '')",
          action: "COALESCE(TRIM(type), '')",
          machine: "COALESCE(TRIM(machine), '')",
          origin: "COALESCE(TRIM(origin), '')",
        } as Record<string, string>)[request.field],
        params: [],
      };
    if (!valueDefinition.sql) throw new Error(`Unsupported decision facet field: ${request.field}`);

    const response = await queryFacetValues(
      'decisions',
      valueDefinition.sql,
      valueDefinition.params,
      filteredWhere,
      request,
      searchAst,
    );
    setCachedFacetResponse(cacheKey, response);
    return response;
  }

  async function queryFacetValues(
    tableName: 'alerts' | 'decisions',
    valueSql: string,
    valueParams: unknown[],
    where: SqlWhere,
    request: FacetRequest,
    originalSearchAst: SearchNode | null,
    facetRows?: { sql: string; params: unknown[] },
  ): Promise<FacetResponse> {
    const selection = getSearchFacetSelection(originalSearchAst, request.field);
    const selectedValues = [...new Set([...selection.included, ...selection.excluded])]
      .slice(0, FACET_MAX_LIMIT);
    const outerClauses: string[] = [];
    const outerParams: unknown[] = [];
    const selectedPlaceholders = selectedValues.map(() => '?').join(', ');

    if (request.search) {
      const searchClause = "LOWER(value) LIKE ? ESCAPE '\\'";
      if (selectedValues.length > 0) {
        outerClauses.push(`(${searchClause} OR value IN (${selectedPlaceholders}))`);
        outerParams.push(likeParam(request.search), ...selectedValues);
      } else {
        outerClauses.push(searchClause);
        outerParams.push(likeParam(request.search));
      }
    }

    const selectedOrderSql = selectedValues.length > 0
      ? `CASE WHEN value IN (${selectedPlaceholders}) THEN 0 ELSE 1 END, `
      : '';
    const rows = await facetQueryWorker.all<{ value: string | null; count: number }>(`
      WITH facet_rows(value) AS (
        ${facetRows?.sql ?? `
          SELECT ${valueSql}
          FROM ${tableName}
          ${where.toSql()}
        `}
      )
      SELECT value, COUNT(*) AS count
      FROM facet_rows
      ${outerClauses.length > 0 ? `WHERE ${outerClauses.join(' AND ')}` : ''}
      GROUP BY value
      ORDER BY ${selectedOrderSql}count DESC, value COLLATE NOCASE ASC
      LIMIT ? OFFSET ?
    `, [
      ...(facetRows?.params ?? [...valueParams, ...where.params]),
      ...outerParams,
      ...(selectedValues.length > 0 ? selectedValues : []),
      request.limit + 1,
      request.offset,
    ]);

    return {
      field: request.field,
      values: rows.slice(0, request.limit).map((row) => ({
        value: row.value || '',
        count: Number(row.count) || 0,
      })),
      offset: request.offset,
      has_more: rows.length > request.limit,
    };
  }

  function facetCacheKey(
    page: 'alerts' | 'decisions',
    request: FacetRequest,
    filters: AlertListFilters | DecisionListFilters,
    searchAst: SearchNode | null,
    extra: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({
      version: facetCacheVersion,
      page,
      request,
      filters,
      query: serializeSearchNode(searchAst),
      ...extra,
    });
  }

  function getCachedFacetResponse(key: string): FacetResponse | null {
    const cached = facetResponseCache.get(key);
    if (!cached) return null;
    facetResponseCache.delete(key);
    facetResponseCache.set(key, cached);
    return cached;
  }

  function setCachedFacetResponse(key: string, response: FacetResponse): void {
    facetResponseCache.delete(key);
    facetResponseCache.set(key, response);
    while (facetResponseCache.size > FACET_CACHE_MAX_ENTRIES) {
      const oldestKey = facetResponseCache.keys().next().value;
      if (oldestKey) facetResponseCache.delete(oldestKey);
      else break;
    }
  }

  async function queryCount(tableName: 'alerts' | 'decisions', where: SqlWhere): Promise<number> {
    const row = await queryWorker.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${tableName} ${where.toSql()}`, where.params);
    return row.count;
  }

  async function enrichAlertLocations(alerts: SlimAlert[]): Promise<SlimAlert[]> {
    const coordinates = alerts.flatMap((alert, index) => {
      if (alert.source?.city && alert.source.region) return [];
      const latitude = normalizeDashboardCoordinate(alert.source?.latitude, -90, 90);
      const longitude = normalizeDashboardCoordinate(alert.source?.longitude, -180, 180);
      return latitude === undefined || longitude === undefined ? [] : [{ index, latitude, longitude }];
    });
    if (coordinates.length === 0) return alerts;

    const resolved = await attackLocationResolver.resolve(coordinates);
    const locationByIndex = new Map(resolved.map((location) => [location.index, location]));
    return alerts.map((alert, index) => {
      const location = locationByIndex.get(index);
      if (!alert.source || (!location?.city && !location?.region)) return alert;
      return {
        ...alert,
        source: {
          ...alert.source,
          city: location.city || alert.source.city,
          region: location.region || alert.source.region,
        },
      };
    });
  }

  async function enrichAlertRecordLocations(alerts: AlertRecord[]): Promise<AlertRecord[]> {
    const coordinates = alerts.flatMap((alert, index) => {
      if (alert.source?.city && alert.source.region) return [];
      const latitude = normalizeDashboardCoordinate(alert.source?.latitude, -90, 90);
      const longitude = normalizeDashboardCoordinate(alert.source?.longitude, -180, 180);
      return latitude === undefined || longitude === undefined ? [] : [{ index, latitude, longitude }];
    });
    if (coordinates.length === 0) return alerts;

    const resolved = await attackLocationResolver.resolve(coordinates);
    const locationByIndex = new Map(resolved.map((location) => [location.index, location]));
    return alerts.map((alert, index) => {
      const location = locationByIndex.get(index);
      if (!alert.source || (!location?.city && !location?.region)) return alert;
      return {
        ...alert,
        source: {
          ...alert.source,
          city: location.city || alert.source.city,
          region: location.region || alert.source.region,
        },
      };
    });
  }

  async function enrichDecisionLocations(
    decisions: DecisionListItem[],
    alertCoordinates: Map<string, { latitude: number; longitude: number }>,
  ): Promise<DecisionListItem[]> {
    const coordinates = decisions.flatMap((decision, index) => {
      if (decision.detail.city && decision.detail.region) return [];
      const alertId = decision.detail.alert_id;
      const coordinate = alertId === undefined ? undefined : alertCoordinates.get(String(alertId));
      return coordinate ? [{ index, ...coordinate }] : [];
    });
    if (coordinates.length === 0) return decisions;

    const resolved = await attackLocationResolver.resolve(coordinates);
    const locationByIndex = new Map(resolved.map((location) => [location.index, location]));
    return decisions.map((decision, index) => {
      const location = locationByIndex.get(index);
      if (!location?.city && !location?.region) return decision;
      return {
        ...decision,
        detail: {
          ...decision.detail,
          city: location.city || decision.detail.city,
          region: location.region || decision.detail.region,
          country: decision.detail.country && decision.detail.country !== 'Unknown'
            ? decision.detail.country
            : location.countryCode,
        },
      };
    });
  }

  async function getAlertCoordinatesByIds(
    alertIds: Array<string | number | null | undefined>,
  ): Promise<Map<string, { latitude: number; longitude: number }>> {
    const uniqueIds = [...new Set(alertIds.filter((id): id is string | number => id !== null && id !== undefined).map(String))];
    const coordinates = new Map<string, { latitude: number; longitude: number }>();
    for (let offset = 0; offset < uniqueIds.length; offset += 800) {
      const ids = uniqueIds.slice(offset, offset + 800);
      const placeholders = ids.map(() => '?').join(', ');
      const rows = await queryWorker.all<{
        id: string | number;
        latitude?: number | null;
        longitude?: number | null;
      }>(`SELECT id, latitude, longitude FROM alerts WHERE id IN (${placeholders})`, ids);
      for (const row of rows) {
        const latitude = normalizeDashboardCoordinate(row.latitude, -90, 90);
        const longitude = normalizeDashboardCoordinate(row.longitude, -180, 180);
        if (latitude !== undefined && longitude !== undefined) {
          coordinates.set(String(row.id), { latitude, longitude });
        }
      }
    }
    return coordinates;
  }

  function addAlertSqlFilters(where: SqlWhere, filters: AlertListFilters): void {
    if (filters.ip) addIpCondition(where, 'source_ip', filters.ip);
    if (filters.country) {
      const country = filters.country.trim();
      if (/^[a-z]{2}$/i.test(country)) {
        where.add('country = ?', country.toUpperCase());
      } else {
        where.add("(LOWER(country) LIKE ? ESCAPE '\\' OR LOWER(country_name) LIKE ? ESCAPE '\\')", likeParam(country), likeParam(country));
      }
    }
    if (filters.scenario) addLike(where, 'LOWER(scenario)', filters.scenario);
    if (filters.as) addLike(where, 'LOWER(as_name)', filters.as);
    if (filters.target) addLike(where, 'LOWER(target)', filters.target);
    if (filters.date) where.add("created_at LIKE ? ESCAPE '\\'", `${escapeLike(filters.date)}%`);
    addDateRangeFilter(where, 'created_at', filters.dateStart, filters.dateEnd, filters.timezoneOffsetMinutes, filters.timeZone);
    addSimulationFilter(where, filters.simulation);
  }

  function addDecisionSqlFilters(
    where: SqlWhere,
    filters: DecisionListFilters,
    includeDuplicateFilter: boolean,
  ): void {
    if (includeDuplicateFilter && !filters.showDuplicates) {
      where.add('decisions.is_duplicate = 0');
    }
    if (filters.alertId) where.add('alert_id = ?', filters.alertId);
    addSimulationFilter(where, filters.simulation);
    if (filters.country) where.add('country = ?', filters.country);
    if (filters.scenario) where.add('scenario = ?', filters.scenario);
    if (filters.as) where.add('as_name = ?', filters.as);
    if (filters.ip) addIpCondition(where, 'value', filters.ip);
    if (filters.target) {
      where.add("(LOWER(value) LIKE ? ESCAPE '\\' OR LOWER(target) LIKE ? ESCAPE '\\')", likeParam(filters.target), likeParam(filters.target));
    }
    addDateRangeFilter(where, 'created_at', filters.dateStart, filters.dateEnd, filters.timezoneOffsetMinutes, filters.timeZone);
  }

  function addSimulationFilter(where: SqlWhere, filter: string): void {
    if (filter === 'simulated') where.add('simulated = 1');
    if (filter === 'live') where.add('simulated = 0');
  }

  function addDateRangeFilter(
    where: SqlWhere,
    column: string,
    dateStart: string,
    dateEnd: string,
    timezoneOffsetMinutes: number,
    timeZone: string | null,
  ): void {
    if (!dateStart && !dateEnd) return;
    const includeHour = dateStart.includes('T') || dateEnd.includes('T');
    if (dateStart) {
      where.add(`${column} >= ?`, getDateFilterBoundary(dateStart, timezoneOffsetMinutes, timeZone, includeHour).toISOString());
    }
    if (dateEnd) {
      where.add(`${column} <= ?`, getDateFilterBoundary(dateEnd, timezoneOffsetMinutes, timeZone, includeHour).toISOString());
    }
  }

  function compileAlertSearchSql(ast: SearchNode | null, filters: AlertListFilters): SqlCondition | null {
    return compileSearchNodeSql(ast, {
      page: 'alerts',
      dateOptions: filters,
      fieldCondition: (field, value, exact) => alertFieldCondition(
        field,
        value,
        config.instances,
        exact,
        new Date().toISOString(),
        config.simulationsEnabled,
      ),
      freeTextCondition: (value) => freeTextSearchCondition('alerts', value, database.searchIndexAvailable),
    });
  }

  function compileDecisionSearchSql(
    ast: SearchNode | null,
    filters: DecisionListFilters,
    now: string,
  ): SqlCondition | null {
    return compileSearchNodeSql(ast, {
      page: 'decisions',
      dateOptions: filters,
      fieldCondition: (field, value, exact) => decisionFieldCondition(field, value, now, config.instances, exact),
      // The default decision view contains only one row per duplicate group.
      // Scanning that small indexed set is substantially cheaper than asking
      // FTS to materialize every matching duplicate ID from large blocklists.
      freeTextCondition: (value) => freeTextSearchCondition(
        'decisions',
        value,
        database.searchIndexAvailable && filters.showDuplicates,
      ),
    });
  }

  async function getDashboardStatsIndex(instanceId: string): Promise<DashboardStatsCache> {
    const cacheKey = getDashboardStatsCacheKey(instanceId);
    const cached = dashboardStatsCaches.get(cacheKey);
    if (cached) {
      dashboardStatsCaches.delete(cacheKey);
      dashboardStatsCaches.set(cacheKey, cached);
      return cached;
    }

    const pending = dashboardStatsIndexPromises.get(cacheKey);
    if (pending) {
      return pending;
    }

    const promise = buildDashboardStatsIndex(cacheKey, instanceId).finally(() => {
      dashboardStatsIndexPromises.delete(cacheKey);
    });
    dashboardStatsIndexPromises.set(cacheKey, promise);
    return promise;
  }

  async function buildDashboardStatsIndex(cacheKey: string, instanceId: string): Promise<DashboardStatsCache> {
    const since = new Date(Date.now() - config.lookbackMs).toISOString();
    const nowIso = new Date().toISOString();
    const nowTimestamp = Date.now();

    const alertWhere = createSqlWhere();
    alertWhere.add('created_at >= ?', since);
    if (instanceId === 'all') {
      alertWhere.add(`instance_id IN (${config.instances.map(() => '?').join(',')})`, ...config.instances.map((instance) => instance.id));
    } else {
      alertWhere.add('instance_id = ?', instanceId);
    }
    if (!config.simulationsEnabled) {
      alertWhere.add('simulated = 0');
    }
    const alerts: DashboardAlertStatsRecord[] = [];
    let simulatedAlerts = 0;
    let lastAlertId = Number.MIN_SAFE_INTEGER;
    while (true) {
      const batchWhere = alertWhere.clone();
      batchWhere.add('id > ?', lastAlertId);
      const alertRows = await queryWorker.all<{
      id: number;
      instance_id: string;
      created_at: string;
      country?: string | null;
      scenario?: string | null;
      as_name?: string | null;
      source_ip?: string | null;
      latitude?: number | null;
      longitude?: number | null;
      target?: string | null;
      simulated?: number | null;
    }>(`
      SELECT id, instance_id, created_at, country, scenario, as_name, source_ip, latitude, longitude, target, simulated
      FROM alerts
      ${batchWhere.toSql()}
      ORDER BY id ASC
      LIMIT ?
    `, [...batchWhere.params, DASHBOARD_INDEX_BATCH_SIZE]);
      if (alertRows.length === 0) {
        break;
      }

      for (let index = 0; index < alertRows.length; index += 1) {
        const row = alertRows[index];
        const createdAt = row.created_at;
        const timestamp = Date.parse(createdAt);
        if (!Number.isFinite(timestamp)) {
          continue;
        }

        const simulated = row.simulated === 1;
        if (simulated) {
          simulatedAlerts += 1;
        }

        alerts.push({
          instanceId: row.instance_id,
          createdAt,
          timestamp,
          country: row.country || undefined,
          scenario: row.scenario || undefined,
          asName: row.as_name || undefined,
          ip: row.source_ip || undefined,
          latitude: normalizeDashboardCoordinate(row.latitude, -90, 90),
          longitude: normalizeDashboardCoordinate(row.longitude, -180, 180),
          target: row.target || undefined,
          simulated,
        });
      }

      lastAlertId = Number(alertRows[alertRows.length - 1]?.id || lastAlertId);
      await delay(0);
    }

    const decisionWhere = createSqlWhere();
    decisionWhere.add('(created_at >= ? OR stop_at > ?)', since, nowIso);
    if (instanceId === 'all') {
      decisionWhere.add(`instance_id IN (${config.instances.map(() => '?').join(',')})`, ...config.instances.map((instance) => instance.id));
    } else {
      decisionWhere.add('instance_id = ?', instanceId);
    }
    if (!config.simulationsEnabled) {
      decisionWhere.add('simulated = 0');
    }
    const decisions: DashboardDecisionStatsRecord[] = [];
    let activeDecisions = 0;
    let activeSimulatedDecisions = 0;
    let lastDecisionRowId = 0;
    while (true) {
      const batchWhere = decisionWhere.clone();
      batchWhere.add('rowid > ?', lastDecisionRowId);
      const decisionRows = await queryWorker.all<{
      rowid: number;
      instance_id: string;
      created_at: string;
      stop_at?: string | null;
      value?: string | null;
      country?: string | null;
      simulated?: number | null;
    }>(`
      SELECT rowid, instance_id, created_at, stop_at, value, country, simulated
      FROM decisions
      ${batchWhere.toSql()}
      ORDER BY rowid ASC
      LIMIT ?
    `, [...batchWhere.params, DASHBOARD_INDEX_BATCH_SIZE]);
      if (decisionRows.length === 0) {
        break;
      }

      for (let index = 0; index < decisionRows.length; index += 1) {
        const row = decisionRows[index];
        const createdAt = row.created_at;
        const timestamp = Date.parse(createdAt);
        if (!Number.isFinite(timestamp)) {
          continue;
        }

        const stopAt = row.stop_at || undefined;
        const stopTimestamp = stopAt ? Date.parse(stopAt) : Number.NaN;
        const normalizedStopTimestamp = Number.isFinite(stopTimestamp) ? stopTimestamp : 0;
        const simulated = row.simulated === 1;
        if (normalizedStopTimestamp > nowTimestamp) {
          if (simulated) {
            activeSimulatedDecisions += 1;
          } else {
            activeDecisions += 1;
          }
        }

        decisions.push({
          instanceId: row.instance_id,
          createdAt,
          stopAt,
          timestamp,
          stopTimestamp: normalizedStopTimestamp,
          value: row.value || undefined,
          country: row.country || undefined,
          simulated,
        });
      }

      lastDecisionRowId = Number(decisionRows[decisionRows.length - 1]?.rowid || lastDecisionRowId);
      await delay(0);
    }

    const totals: DashboardStatsTotals = {
      alerts: alerts.length,
      decisions: activeDecisions,
      simulatedAlerts,
      simulatedDecisions: activeSimulatedDecisions,
    };

    const statsCache = { key: cacheKey, scope: instanceId, alerts, decisions, totals };
    if (cacheKey === getDashboardStatsCacheKey(instanceId)) {
      dashboardStatsCaches.set(cacheKey, statsCache);
      while (dashboardStatsCaches.size > Math.max(4, config.instances.length + 1)) {
        const oldest = dashboardStatsCaches.keys().next().value;
        if (oldest) dashboardStatsCaches.delete(oldest);
        else break;
      }
    }
    return statsCache;
  }

  async function buildDashboardStats(filters: DashboardStatsFilters): Promise<DashboardStatsResponse> {
    // A secondary sync can finish while a large Combined index or response is
    // being assembled. Scope generations make that work obsolete. Retry here
    // so a response that completes after the commit can never expose the old
    // generation or put it back into a current cache entry.
    while (true) {
      const statsIndex = await getDashboardStatsIndex(filters.instanceId);
      if (statsIndex.key !== getDashboardStatsCacheKey(filters.instanceId)) continue;

      const responseCacheKey = getDashboardStatsResponseCacheKey(statsIndex.key, filters);
      const cachedResponse = dashboardStatsResponseCache.get(responseCacheKey);
      if (cachedResponse) {
        if (statsIndex.key === getDashboardStatsCacheKey(filters.instanceId)) return cachedResponse;
        continue;
      }

      const pending = dashboardStatsResponsePromises.get(responseCacheKey);
      if (pending) {
        const response = await pending;
        if (statsIndex.key === getDashboardStatsCacheKey(filters.instanceId)) return response;
        continue;
      }

      const promise = buildDashboardStatsResponse(statsIndex, filters, responseCacheKey).finally(() => {
        dashboardStatsResponsePromises.delete(responseCacheKey);
      });
      dashboardStatsResponsePromises.set(responseCacheKey, promise);
      const response = await promise;
      if (statsIndex.key === getDashboardStatsCacheKey(filters.instanceId)) return response;
    }
  }

  function createEmptyDashboardStatsResponse(options: { pending?: boolean } = {}): DashboardStatsResponse {
    const totals: DashboardStatsTotals = {
      alerts: 0,
      decisions: 0,
      simulatedAlerts: 0,
      simulatedDecisions: 0,
    };

    return {
      pending: options.pending || undefined,
      retryAfterMs: options.pending ? 1_500 : undefined,
      totals,
      filteredTotals: totals,
      globalTotal: 0,
      topTargets: [],
      topCountries: [],
      allCountries: [],
      attackLocations: [],
      topScenarios: [],
      topAS: [],
      series: {
        alertsHistory: [],
        simulatedAlertsHistory: [],
        decisionsHistory: [],
        simulatedDecisionsHistory: [],
        activeDecisionsHistory: [],
        activeSimulatedDecisionsHistory: [],
        unfilteredAlertsHistory: [],
        unfilteredSimulatedAlertsHistory: [],
        unfilteredDecisionsHistory: [],
        unfilteredSimulatedDecisionsHistory: [],
      },
    };
  }

  function isDashboardStatsBuildInProgress(filters: DashboardStatsFilters): boolean {
    const indexKey = getDashboardStatsCacheKey(filters.instanceId);
    if (!dashboardStatsCaches.has(indexKey)) {
      return dashboardStatsIndexPromises.has(indexKey);
    }

    return dashboardStatsResponsePromises.has(getDashboardStatsResponseCacheKey(indexKey, filters));
  }

  function warmDashboardStatsCache(filters: DashboardStatsFilters): void {
    const warmingKey = getDashboardStatsCacheKey(filters.instanceId);
    void buildDashboardStats(filters).then(() => {
      if (
        warmingKey !== getDashboardStatsCacheKey(filters.instanceId) ||
        dashboardStatsReadyPublishedKeys.has(warmingKey) ||
        !cacheRefreshCompletedAt
      ) {
        return;
      }

      // A cold dashboard request initially receives the previous response with
      // pending=true. Notify clients again when the new index and response are
      // read-visible so a superseded retry cannot leave the page stale.
      dashboardStatsReadyPublishedKeys.add(warmingKey);
      publishCacheUpdate(cacheRefreshCompletedAt);
    }).catch((error: any) => {
      console.error('Failed to warm dashboard statistics cache:', error.message);
    });
  }

  async function prepareDashboardStatsAfterRefresh(): Promise<boolean> {
    if (!lastDashboardStatsFilters) return false;
    await buildDashboardStats(lastDashboardStatsFilters);
    return true;
  }

  async function buildDashboardStatsResponse(
    statsIndex: DashboardStatsCache,
    filters: DashboardStatsFilters,
    responseCacheKey: string,
  ): Promise<DashboardStatsResponse> {
    const nowTimestamp = Date.now();
    const lookbackDays = Math.max(1, Math.round(lookbackHours(config.lookbackPeriod) / 24));

    const filteredAlertAccumulator = createDashboardStatsAccumulator();
    const chartAlertAccumulator = createDashboardStatsAccumulator();
    const sliderAlertAccumulator = createDashboardStatsAccumulator();
    const alertCountryByIp = new Map<string, string>();
    const filteredAlertIps = new Set<string>();
    const sliderAlertIps = new Set<string>();

    for (let index = 0; index < statsIndex.alerts.length; index += 1) {
      if (index > 0 && index % DASHBOARD_LOOP_YIELD_INTERVAL === 0) {
        await delay(0);
      }
      const alert = statsIndex.alerts[index];
      if (filters.instanceId !== 'all' && alert.instanceId !== filters.instanceId) continue;
      if (alert.ip && alert.country && alert.country !== 'Unknown') {
        alertCountryByIp.set(alert.ip, alert.country);
      }

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
        addDashboardAttackLocation(filteredAlertAccumulator.attackLocations, alert);
        addDashboardAlert(chartAlertAccumulator, alert, filters);
        if (alert.ip) {
          filteredAlertIps.add(alert.ip);
        }
      }
    }

    const filteredDecisionAccumulator = createDashboardDecisionAccumulator();
    const chartDecisionAccumulator = createDashboardDecisionAccumulator();
    const sliderDecisionAccumulator = createDashboardDecisionAccumulator();

    let globalTotal = 0;
    for (let index = 0; index < statsIndex.decisions.length; index += 1) {
      if (index > 0 && index % DASHBOARD_LOOP_YIELD_INTERVAL === 0) {
        await delay(0);
      }
      const decision = statsIndex.decisions[index];
      if (filters.instanceId !== 'all' && decision.instanceId !== filters.instanceId) continue;
      if (!matchesDashboardSimulationFilter(decision.simulated, filters.simulation)) {
        continue;
      }

      const isActive = decision.stopTimestamp > nowTimestamp;
      if (matchesDashboardDecisionFilters(decision, filters, sliderAlertIps, false)) {
        addDashboardDecision(sliderDecisionAccumulator, decision, filters, isActive);
      }

      if (matchesDashboardDecisionFilters(decision, filters, filteredAlertIps, true)) {
        addDashboardDecision(chartDecisionAccumulator, decision, filters, isActive);
        const country = normalizeDashboardCountryCode(decision.country)
          || (decision.value ? alertCountryByIp.get(decision.value) : undefined);
        addDashboardDecisionCountry(filteredDecisionAccumulator, decision, country, isActive);
        if (isActive) {
          if (decision.simulated) {
            filteredDecisionAccumulator.simulatedDecisions += 1;
          } else {
            filteredDecisionAccumulator.decisions += 1;
          }
        }
      }
    }
    for (let index = 0; index < statsIndex.alerts.length; index += 1) {
      if (index > 0 && index % DASHBOARD_LOOP_YIELD_INTERVAL === 0) {
        await delay(0);
      }
      if (
        (filters.instanceId === 'all' || statsIndex.alerts[index].instanceId === filters.instanceId)
        && matchesDashboardSimulationFilter(statsIndex.alerts[index].simulated, filters.simulation)
      ) {
        globalTotal += 1;
      }
    }

    const attackLocations = await attackLocationResolver.resolve(
      dashboardAttackLocationData(filteredAlertAccumulator.attackLocations),
    );

    const response: DashboardStatsResponse = {
      totals: statsIndex.totals,
      filteredTotals: {
        alerts: filteredAlertAccumulator.alerts,
        decisions: filteredDecisionAccumulator.decisions,
        simulatedAlerts: filteredAlertAccumulator.simulatedAlerts,
        simulatedDecisions: filteredDecisionAccumulator.simulatedDecisions,
      },
      globalTotal,
      topTargets: topDashboardEntries(filteredAlertAccumulator.targets),
      topCountries: dashboardCountryList(filteredAlertAccumulator.countries, 10),
      allCountries: dashboardWorldMapData(filteredAlertAccumulator.countries, filteredDecisionAccumulator.countries),
      attackLocations,
      topScenarios: topDashboardEntries(filteredAlertAccumulator.scenarios),
      topAS: topDashboardEntries(filteredAlertAccumulator.asNames),
      series: {
        alertsHistory: dashboardBuckets(chartAlertAccumulator.liveAlertBuckets, filters, lookbackDays),
        simulatedAlertsHistory: dashboardBuckets(chartAlertAccumulator.simulatedAlertBuckets, filters, lookbackDays),
        decisionsHistory: dashboardBuckets(chartDecisionAccumulator.liveDecisionBuckets, filters, lookbackDays),
        simulatedDecisionsHistory: dashboardBuckets(chartDecisionAccumulator.simulatedDecisionBuckets, filters, lookbackDays),
        activeDecisionsHistory: dashboardBuckets(chartDecisionAccumulator.activeLiveDecisionBuckets, filters, lookbackDays),
        activeSimulatedDecisionsHistory: dashboardBuckets(chartDecisionAccumulator.activeSimulatedDecisionBuckets, filters, lookbackDays),
        unfilteredAlertsHistory: dashboardBuckets(sliderAlertAccumulator.liveAlertBuckets, filters, lookbackDays, true),
        unfilteredSimulatedAlertsHistory: dashboardBuckets(sliderAlertAccumulator.simulatedAlertBuckets, filters, lookbackDays, true),
        unfilteredDecisionsHistory: dashboardBuckets(sliderDecisionAccumulator.liveDecisionBuckets, filters, lookbackDays, true),
        unfilteredSimulatedDecisionsHistory: dashboardBuckets(sliderDecisionAccumulator.simulatedDecisionBuckets, filters, lookbackDays, true),
      },
    };

    if (statsIndex.key === getDashboardStatsCacheKey(filters.instanceId)) {
      dashboardStatsResponseCache.set(responseCacheKey, response);
      const staleCacheKey = getStaleDashboardStatsResponseCacheKey(filters);
      staleDashboardStatsResponseCache.set(staleCacheKey, response);
      if (dashboardStatsResponseCache.size > 50) {
        const firstKey = dashboardStatsResponseCache.keys().next().value;
        if (firstKey) {
          dashboardStatsResponseCache.delete(firstKey);
        }
      }
      if (staleDashboardStatsResponseCache.size > 50) {
        const firstKey = staleDashboardStatsResponseCache.keys().next().value;
        if (firstKey) {
          staleDashboardStatsResponseCache.delete(firstKey);
        }
      }
    }

    return response;
  }

  function getDashboardStatsCacheKey(instanceId = 'all'): string {
    const scopeVersion = dashboardStatsScopeVersions.get(instanceId) || 0;
    return `${dashboardStatsCacheVersion}:${scopeVersion}:${config.lookbackMs}:${config.simulationsEnabled ? 'sim' : 'live'}:${instanceId}`;
  }

  function invalidateDashboardStatsCache(instanceId?: string): void {
    facetResponseCache.clear();
    facetCacheVersion += 1;
    if (instanceId) {
      const affectedScopes = new Set([instanceId, 'all']);
      for (const scope of affectedScopes) {
        dashboardStatsScopeVersions.set(scope, (dashboardStatsScopeVersions.get(scope) || 0) + 1);
      }
      dashboardStatsReadyPublishedKeys.clear();
      for (const [key, cached] of dashboardStatsCaches) {
        if (affectedScopes.has(cached.scope)) dashboardStatsCaches.delete(key);
      }
      for (const key of dashboardStatsResponseCache.keys()) {
        if (key.includes(`\"instanceId\":\"${instanceId}\"`) || key.includes(`\"instanceId\":\"all\"`)) {
          dashboardStatsResponseCache.delete(key);
        }
      }
      for (const key of staleDashboardStatsResponseCache.keys()) {
        if (key.includes(`\"instanceId\":\"${instanceId}\"`) || key.includes(`\"instanceId\":\"all\"`)) {
          staleDashboardStatsResponseCache.delete(key);
        }
      }
      return;
    }
    dashboardStatsCaches.clear();
    dashboardStatsResponseCache.clear();
    staleDashboardStatsResponseCache.clear();
    dashboardStatsReadyPublishedKeys.clear();
    dashboardStatsCacheVersion += 1;
  }

  function getDashboardStatsResponseCacheKey(indexKey: string, filters: DashboardStatsFilters): string {
    return `${dashboardStatsCacheVersion}:${indexKey}:${JSON.stringify(filters)}`;
  }

  function getStaleDashboardStatsResponseCacheKey(filters: DashboardStatsFilters): string {
    return JSON.stringify(filters);
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
        const summary = await syncAlertWindow(start, now, now, (window, alerts, decisions) => {
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
        client.updateStatus(true);
        status.state = 'complete';
        status.progress = 100;
        status.message = `${instance.name} sync complete`;
        status.errors = [];
        instanceLastUpdates.set(instanceId, new Date(now).toISOString());
        if (summary.changed) {
          invalidateDashboardStatsCache(instanceId);
          const revision = new Date().toISOString();
          cacheRefreshCompletedAt = revision;
          publishCacheUpdate(revision, [instanceId]);
        }
        console.log(`[${instance.name}] Delta update complete: ${summary.alerts} alerts and ${summary.decisions} decisions synced.`);
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

interface SqlCondition {
  sql: string;
  params: unknown[];
}

class SqlWhere {
  private readonly clauses: string[];
  readonly params: unknown[];

  constructor(clauses: string[] = [], params: unknown[] = []) {
    this.clauses = clauses;
    this.params = params;
  }

  add(sql: string, ...params: unknown[]): void {
    this.clauses.push(sql);
    this.params.push(...params);
  }

  clone(): SqlWhere {
    return new SqlWhere([...this.clauses], [...this.params]);
  }

  toSql(): string {
    return this.clauses.length > 0 ? `WHERE ${this.clauses.map((clause) => `(${clause})`).join(' AND ')}` : '';
  }
}

function createSqlWhere(): SqlWhere {
  return new SqlWhere();
}

const DECISION_COVERED_SEARCH_FIELDS = new Set([
  'id', 'instance', 'alert', 'scenario', 'ip', 'country', 'region', 'city', 'as', 'target',
  'date', 'action', 'type', 'status', 'duplicate', 'sim', 'machine', 'origin',
]);

function getDecisionPageIndexHint(filters: DecisionListFilters, searchAst: SearchNode | null): string {
  if (filters.showDuplicates || filters.alertId || searchAstContainsField(searchAst, 'id', 'alert')) {
    return '';
  }

  if (
    filters.instanceId !== 'all'
    && !searchAst
    && !filters.country
    && !filters.scenario
    && !filters.as
    && !filters.ip
    && !filters.target
  ) {
    return 'INDEXED BY idx_decisions_instance_duplicate_paging';
  }

  const simpleIp = getSimpleSearchFieldValue(searchAst, 'ip');
  if (isIP((simpleIp || filters.ip).trim()) !== 0) {
    return 'INDEXED BY idx_decisions_duplicate_value_paging';
  }

  if (searchAst && isDecisionSearchCoveredByFilterIndex(searchAst)) {
    return 'INDEXED BY idx_decisions_duplicate_filters';
  }
  if (filters.country || filters.scenario || filters.as || filters.ip || filters.target) {
    return 'INDEXED BY idx_decisions_duplicate_filters';
  }
  return 'INDEXED BY idx_decisions_duplicate_paging';
}

function searchAstContainsField(node: SearchNode | null, ...fields: string[]): boolean {
  if (!node) return false;
  if (node.kind === 'field' || node.kind === 'comparison') {
    if (fields.includes(node.field)) return true;
    return node.kind === 'field' && searchAstContainsField(node.expression, ...fields);
  }
  if (node.kind === 'not') return searchAstContainsField(node.expression, ...fields);
  if (node.kind === 'binary') {
    return searchAstContainsField(node.left, ...fields) || searchAstContainsField(node.right, ...fields);
  }
  return false;
}

function getSimpleSearchFieldValue(node: SearchNode | null, field: string): string {
  if (!node) return '';
  if (node.kind === 'field' && node.field === field && node.expression.kind === 'term') {
    return node.expression.value;
  }
  if (node.kind === 'comparison' && node.field === field && node.operator === '=') {
    return node.value;
  }
  return '';
}

function isDecisionSearchCoveredByFilterIndex(node: SearchNode, fieldContext = false): boolean {
  if (node.kind === 'term') return fieldContext;
  if (node.kind === 'comparison') return DECISION_COVERED_SEARCH_FIELDS.has(node.field);
  if (node.kind === 'field') {
    return DECISION_COVERED_SEARCH_FIELDS.has(node.field)
      && isDecisionSearchCoveredByFilterIndex(node.expression, true);
  }
  if (node.kind === 'not') return isDecisionSearchCoveredByFilterIndex(node.expression, fieldContext);
  return isDecisionSearchCoveredByFilterIndex(node.left, fieldContext)
    && isDecisionSearchCoveredByFilterIndex(node.right, fieldContext);
}

function addLike(where: SqlWhere, columnSql: string, value: string): void {
  where.add(`${columnSql} LIKE ? ESCAPE '\\'`, likeParam(value));
}

function addIpCondition(where: SqlWhere, column: string, value: string): void {
  const normalized = value.trim().toLowerCase();
  if (isIP(normalized) !== 0) {
    where.add(`${column} = ?`, normalized);
    return;
  }
  where.add(`(matches_ip_search_value(${column}, ?) = 1 OR LOWER(${column}) LIKE ? ESCAPE '\\')`, value, likeParam(value));
}

function textCondition(columnSql: string, value: string, exact = false): SqlCondition {
  const normalizedColumn = `COALESCE(${columnSql}, '')`;
  return exact
    ? { sql: `${normalizedColumn} = ?`, params: [value.trim().toLowerCase()] }
    : { sql: `${normalizedColumn} LIKE ? ESCAPE '\\'`, params: [likeParam(value)] };
}

function spaceSeparatedTextCondition(column: string, value: string): SqlCondition {
  return {
    sql: `(' ' || COALESCE(LOWER(${column}), '') || ' ') LIKE ? ESCAPE '\\'`,
    params: [`% ${escapeLike(value.trim().toLowerCase())} %`],
  };
}

function ipCondition(column: string, value: string, exact = false): SqlCondition {
  const normalized = value.trim().toLowerCase();
  if (exact) {
    return { sql: `COALESCE(LOWER(${column}), '') = ?`, params: [normalized] };
  }
  if (isIP(normalized) !== 0) {
    return { sql: `${column} = ?`, params: [normalized] };
  }
  return {
    sql: `(matches_ip_search_value(${column}, ?) = 1 OR COALESCE(LOWER(${column}), '') LIKE ? ESCAPE '\\')`,
    params: [value, likeParam(value)],
  };
}

function freeTextSearchCondition(page: SearchPageForSql, value: string, searchIndexAvailable: boolean): SqlCondition {
  const fallback = textCondition('LOWER(search_text)', value);
  if (!searchIndexAvailable) {
    return fallback;
  }

  const ftsQuery = toFtsQuery(value);
  if (!ftsQuery) {
    return fallback;
  }

  if (page === 'alerts') {
    return {
      sql: 'id IN (SELECT CAST(alert_id AS INTEGER) FROM alerts_fts WHERE alerts_fts MATCH ?)',
      params: [ftsQuery],
    };
  }

  return {
    sql: 'id IN (SELECT decision_id FROM decisions_fts WHERE decisions_fts MATCH ?)',
    params: [ftsQuery],
  };
}

function alertFieldCondition(
  field: string,
  value: string,
  instances: ReadonlyArray<{ id: string; name: string }>,
  exact = false,
  now = new Date().toISOString(),
  simulationsEnabled = true,
): SqlCondition {
  if (value.trim() === '') {
    return alertEmptyFieldCondition(field, simulationsEnabled);
  }

  switch (field) {
    case 'id':
      return { sql: 'CAST(upstream_id AS TEXT) = ?', params: [value] };
    case 'instance':
      return instanceFieldCondition(value, instances, exact);
    case 'scenario':
      return textCondition('LOWER(scenario)', value, exact);
    case 'message':
      return textCondition('LOWER(message)', value, exact);
    case 'ip':
      return ipCondition('source_ip', value, exact);
    case 'country':
      return countryCondition(value, exact);
    case 'region':
      return textCondition('LOWER(region)', value, exact);
    case 'city':
      return textCondition('LOWER(city)', value, exact);
    case 'as':
      return textCondition('LOWER(as_name)', value, exact);
    case 'target':
      return textCondition('LOWER(target)', value, exact);
    case 'date':
      return textCondition('LOWER(created_at)', value, exact);
    case 'sim':
      return simulationTermCondition(value);
    case 'machine':
      return textCondition('LOWER(machine)', value, exact);
    case 'origin':
      return exact ? spaceSeparatedTextCondition('origins', value) : textCondition('LOWER(origins)', value);
    case 'decision':
      return alertDecisionCondition(value, now, simulationsEnabled);
    default:
      return { sql: '0 = 1', params: [] };
  }
}

function decisionFieldCondition(
  field: string,
  value: string,
  now: string,
  instances: ReadonlyArray<{ id: string; name: string }>,
  exact = false,
): SqlCondition {
  if (value.trim() === '') {
    return decisionEmptyFieldCondition(field);
  }

  switch (field) {
    case 'id':
      return { sql: 'CAST(upstream_id AS TEXT) = ?', params: [value] };
    case 'instance':
      return instanceFieldCondition(value, instances, exact);
    case 'alert':
      return { sql: 'alert_upstream_id = ?', params: [value] };
    case 'scenario':
      return textCondition('LOWER(scenario)', value, exact);
    case 'ip':
      return ipCondition('value', value, exact);
    case 'country':
      return countryCondition(value, exact);
    case 'region':
      return textCondition('LOWER(region)', value, exact);
    case 'city':
      return textCondition('LOWER(city)', value, exact);
    case 'as':
      return textCondition('LOWER(as_name)', value, exact);
    case 'target':
      return textCondition('LOWER(target)', value, exact);
    case 'date':
      return textCondition('LOWER(created_at)', value, exact);
    case 'action':
    case 'type':
      return textCondition('LOWER(type)', value, exact);
    case 'status':
      return decisionStatusCondition(value, now);
    case 'duplicate':
      return booleanColumnCondition(value, 'decisions.is_duplicate');
    case 'sim':
      return simulationTermCondition(value);
    case 'machine':
      return textCondition('LOWER(machine)', value, exact);
    case 'origin':
      return textCondition('LOWER(origin)', value, exact);
    default:
      return { sql: '0 = 1', params: [] };
  }
}

function instanceFieldCondition(
  value: string,
  instances: ReadonlyArray<{ id: string; name: string }>,
  exact = false,
): SqlCondition {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return { sql: '0 = 1', params: [] };

  const matchingIds = instances
    .filter((instance) => exact
      ? [instance.id, instance.name].some((candidate) => candidate.trim().toLowerCase() === normalized)
      : `${instance.id} ${instance.name}`.trim().toLowerCase().includes(normalized))
    .map((instance) => instance.id);
  if (matchingIds.length === 0) return { sql: '0 = 1', params: [] };

  return {
    sql: `instance_id IN (${matchingIds.map(() => '?').join(',')})`,
    params: matchingIds,
  };
}

function alertEmptyFieldCondition(field: string, simulationsEnabled = true): SqlCondition {
  switch (field) {
    case 'scenario':
    case 'message':
    case 'ip':
    case 'country':
    case 'region':
    case 'city':
    case 'as':
    case 'target':
    case 'machine':
    case 'origin':
      return emptyTextCondition({
        scenario: 'scenario',
        message: 'message',
        ip: 'source_ip',
        country: 'country',
        region: 'region',
        city: 'city',
        as: 'as_name',
        target: 'target',
        machine: 'machine',
        origin: 'origins',
      }[field]);
    case 'decision':
      return {
        sql: `NOT EXISTS (
          SELECT 1 FROM decisions facet_decision
          WHERE facet_decision.alert_id = alerts.id${simulationsEnabled ? '' : ' AND facet_decision.simulated = 0'}
        )`,
        params: [],
      };
    default:
      return { sql: '0 = 1', params: [] };
  }
}

function alertDecisionCondition(value: string, now: string, simulationsEnabled: boolean): SqlCondition {
  const normalized = value.trim().toLowerCase();
  const simulationSql = simulationsEnabled ? '' : ' AND facet_decision.simulated = 0';
  if (normalized === 'active') {
    return {
      sql: `EXISTS (
        SELECT 1 FROM decisions facet_decision
        WHERE facet_decision.alert_id = alerts.id
          AND facet_decision.stop_at > ?${simulationSql}
      )`,
      params: [now],
    };
  }
  if (normalized === 'expired' || normalized === 'inactive') {
    return {
      sql: `EXISTS (
        SELECT 1 FROM decisions facet_decision
        WHERE facet_decision.alert_id = alerts.id
          AND facet_decision.stop_at <= ?${simulationSql}
      )`,
      params: [now],
    };
  }
  return { sql: '0 = 1', params: [] };
}

function decisionEmptyFieldCondition(field: string): SqlCondition {
  switch (field) {
    case 'alert':
    case 'scenario':
    case 'ip':
    case 'country':
    case 'region':
    case 'city':
    case 'as':
    case 'target':
    case 'action':
    case 'type':
    case 'machine':
    case 'origin':
      return emptyTextCondition({
        alert: 'alert_id',
        scenario: 'scenario',
        ip: 'value',
        country: 'country',
        region: 'region',
        city: 'city',
        as: 'as_name',
        target: 'target',
        action: 'type',
        type: 'type',
        machine: 'machine',
        origin: 'origin',
      }[field]);
    default:
      return { sql: '0 = 1', params: [] };
  }
}

function emptyTextCondition(columnSql: string): SqlCondition {
  return { sql: `COALESCE(TRIM(${columnSql}), '') = ''`, params: [] };
}

function countryCondition(value: string, exact = false): SqlCondition {
  const normalized = value.trim().toLowerCase();
  if (exact) {
    return {
      sql: "(COALESCE(LOWER(country_name), '') = ? OR COALESCE(LOWER(country), '') = ?)",
      params: [normalized, normalized],
    };
  }
  if (/^[a-z]{2}$/.test(normalized)) {
    return { sql: 'country = ?', params: [normalized.toUpperCase()] };
  }
  return {
    sql: "(COALESCE(LOWER(country_name), '') LIKE ? ESCAPE '\\' OR COALESCE(LOWER(country), '') = ?)",
    params: [likeParam(value), normalized],
  };
}

function simulationTermCondition(value: string): SqlCondition {
  const parsed = parseSimulationSearchValue(value);
  if (parsed === true) {
    return { sql: 'simulated = 1', params: [] };
  }
  if (parsed === false) {
    return { sql: 'simulated = 0', params: [] };
  }
  return { sql: '0 = 1', params: [] };
}

function simulationComparisonCondition(operator: string, value: string): SqlCondition {
  const parsed = parseSimulationSearchValue(value);
  if (parsed === null) {
    return { sql: '0 = 1', params: [] };
  }
  if (operator === '=') {
    return { sql: `simulated = ${parsed ? 1 : 0}`, params: [] };
  }
  if (operator === '<>') {
    return { sql: `simulated = ${parsed ? 0 : 1}`, params: [] };
  }
  return { sql: '0 = 1', params: [] };
}

function parseSimulationSearchValue(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (['sim', 'simulated', 'simulation', 'true', 'yes', '1'].includes(normalized)) {
    return true;
  }
  if (['live', 'false', 'no', '0'].includes(normalized)) {
    return false;
  }
  return null;
}

function decisionStatusCondition(value: string, now: string): SqlCondition {
  const normalized = value.trim().toLowerCase();
  if (['expired', 'inactive'].includes(normalized)) {
    return { sql: 'stop_at <= ?', params: [now] };
  }
  if (['active', 'live'].includes(normalized)) {
    return { sql: 'stop_at > ?', params: [now] };
  }
  return { sql: '0 = 1', params: [] };
}

function booleanCondition(value: string, trueSql: string): SqlCondition {
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', '1', 'on'].includes(normalized)) {
    return { sql: trueSql, params: [] };
  }
  if (['false', 'no', '0', 'off'].includes(normalized)) {
    return { sql: `NOT (${trueSql})`, params: [] };
  }
  return { sql: '0 = 1', params: [] };
}

function booleanColumnCondition(value: string, columnSql: string): SqlCondition {
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', '1', 'on'].includes(normalized)) {
    return { sql: `${columnSql} = 1`, params: [] };
  }
  if (['false', 'no', '0', 'off'].includes(normalized)) {
    return { sql: `${columnSql} = 0`, params: [] };
  }
  return { sql: '0 = 1', params: [] };
}

function compileSearchNodeSql(
  node: SearchNode | null,
  context: {
    page: SearchPageForSql;
    dateOptions: { timezoneOffsetMinutes: number; timeZone: string | null };
    fieldCondition: (field: string, value: string, exact?: boolean) => SqlCondition;
    freeTextCondition: (value: string) => SqlCondition;
  },
  scopedField?: string,
): SqlCondition | null {
  if (!node) return null;

  if (node.kind === 'term') {
    return scopedField ? context.fieldCondition(scopedField, node.value) : context.freeTextCondition(node.value);
  }

  if (node.kind === 'comparison') {
    if (node.field === 'date') {
      return dateComparisonCondition('created_at', node.operator, node.value, context.dateOptions);
    }
    if (node.field === 'sim') {
      return simulationComparisonCondition(node.operator, node.value);
    }
    const condition = context.fieldCondition(node.field, node.value, true);
    if (node.operator === '<>') {
      return { sql: `NOT (${condition.sql})`, params: condition.params };
    }
    return condition;
  }

  if (node.kind === 'field') {
    return compileSearchNodeSql(node.expression, context, node.field);
  }

  if (node.kind === 'not') {
    const condition = compileSearchNodeSql(node.expression, context, scopedField);
    return condition ? { sql: `NOT (${condition.sql})`, params: condition.params } : null;
  }

  const left = compileSearchNodeSql(node.left, context, scopedField);
  const right = compileSearchNodeSql(node.right, context, scopedField);
  if (!left) return right;
  if (!right) return left;
  return {
    sql: `(${left.sql}) ${node.operator} (${right.sql})`,
    params: [...left.params, ...right.params],
  };
}

type SearchPageForSql = 'alerts' | 'decisions';

function dateComparisonCondition(
  column: string,
  operator: string,
  value: string,
  dateOptions: { timezoneOffsetMinutes: number; timeZone: string | null },
): SqlCondition {
  const range = parseSqlSearchDateValue(value, dateOptions);
  if (!range) return { sql: '0 = 1', params: [] };
  const start = new Date(range.start).toISOString();
  const end = new Date(range.end).toISOString();

  if (range.precision === 'day' || range.precision === 'hour') {
    if (operator === '=') return { sql: `${column} >= ? AND ${column} < ?`, params: [start, end] };
    if (operator === '<>') return { sql: `(${column} < ? OR ${column} >= ?)`, params: [start, end] };
    if (operator === '<') return { sql: `${column} < ?`, params: [start] };
    if (operator === '<=') return { sql: `${column} < ?`, params: [end] };
    if (operator === '>') return { sql: `${column} >= ?`, params: [end] };
    if (operator === '>=') return { sql: `${column} >= ?`, params: [start] };
  }

  if (operator === '=') return { sql: `${column} = ?`, params: [start] };
  if (operator === '<>') return { sql: `${column} <> ?`, params: [start] };
  if (operator === '<') return { sql: `${column} < ?`, params: [start] };
  if (operator === '<=') return { sql: `${column} <= ?`, params: [start] };
  if (operator === '>') return { sql: `${column} > ?`, params: [start] };
  if (operator === '>=') return { sql: `${column} >= ?`, params: [start] };

  return { sql: '0 = 1', params: [] };
}

function parseSqlSearchDateValue(
  value: string,
  dateOptions: { timezoneOffsetMinutes: number; timeZone: string | null },
): { start: number; end: number; precision: 'day' | 'hour' | 'instant' } | null {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const start = parseDashboardBucketKey(trimmed, dateOptions.timezoneOffsetMinutes, dateOptions.timeZone);
    const endKey = formatDashboardClientBucketKey(addDashboardBucketInterval(parseDashboardWallKey(trimmed), 'day'), 'day');
    const end = parseDashboardBucketKey(endKey, dateOptions.timezoneOffsetMinutes, dateOptions.timeZone);
    return { start: start.getTime(), end: end.getTime(), precision: 'day' };
  }

  if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(trimmed)) {
    const start = parseDashboardBucketKey(trimmed, dateOptions.timezoneOffsetMinutes, dateOptions.timeZone);
    const endKey = formatDashboardClientBucketKey(addDashboardBucketInterval(parseDashboardWallKey(trimmed), 'hour'), 'hour');
    const end = parseDashboardBucketKey(endKey, dateOptions.timezoneOffsetMinutes, dateOptions.timeZone);
    return { start: start.getTime(), end: end.getTime(), precision: 'hour' };
  }

  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return null;
  return { start: timestamp, end: timestamp, precision: 'instant' };
}

function getDateFilterBoundary(
  value: string,
  timezoneOffsetMinutes: number,
  timeZone: string | null,
  includeHour: boolean,
): Date {
  if ((includeHour && /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(value)) || (!includeHour && /^\d{4}-\d{2}-\d{2}$/.test(value))) {
    return parseDashboardBucketKey(value, timezoneOffsetMinutes, timeZone);
  }
  const timestamp = Date.parse(value);
  return new Date(Number.isFinite(timestamp) ? timestamp : 0);
}

function likeParam(value: string): string {
  return `%${escapeLike(value.trim().toLowerCase())}%`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function toFtsQuery(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (Array.from(normalized).length < 3) return null;
  return `"${normalized.replace(/"/g, '""')}"`;
}

function loadMetricsSidebarVisible(database: CrowdsecDatabase): boolean {
  try {
    const value = database.getMeta(METRICS_SIDEBAR_VISIBLE_META_KEY)?.value;
    return value !== 'false';
  } catch (error) {
    console.error('Error loading metrics sidebar preference from database:', error);
    return true;
  }
}

function saveMetricsSidebarVisible(database: CrowdsecDatabase, visible: boolean): void {
  database.setMeta(METRICS_SIDEBAR_VISIBLE_META_KEY, visible ? 'true' : 'false');
}

function loadPersistedConfig(database: CrowdsecDatabase): PersistedConfig {
  try {
    const refreshInterval = database.getMeta('refresh_interval_ms')?.value;
    const manualRefresh = database.getMeta('manual_refresh_enabled')?.value;
    const config: PersistedConfig = {};
    if (refreshInterval !== undefined) {
      config.refresh_interval_ms = Number.parseInt(refreshInterval, 10);
    }
    if (manualRefresh !== undefined) {
      config.manual_refresh_enabled = manualRefresh === 'true';
    }
    if (Object.keys(config).length > 0) {
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
    if (config.manual_refresh_enabled !== undefined) {
      database.setMeta('manual_refresh_enabled', String(config.manual_refresh_enabled));
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
    instance_id: typeof decision.instance_id === 'string' ? decision.instance_id : undefined,
    instance_name: typeof decision.instance_name === 'string' ? decision.instance_name : undefined,
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
      region: typeof decision.region === 'string' ? decision.region : undefined,
      city: typeof decision.city === 'string' ? decision.city : undefined,
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
  const primaryMap = new Map<string, { id: string | number; expirationMs: number; numericId: number }>();

  for (const decision of decisions) {
    if (decision.expired) continue;
    const key = `${decision.instance_id || 'default'}|${decision.value ?? ''}|${decision.simulated === true ? 'simulated' : 'live'}`;
    const expirationMs = getDecisionExpirationMs(decision);
    const numericId = getNumericDecisionId(decision.id);
    const current = primaryMap.get(key);
    if (
      current === undefined ||
      expirationMs > current.expirationMs ||
      (expirationMs === current.expirationMs && numericId > current.numericId)
    ) {
      primaryMap.set(key, { id: decision.id, expirationMs, numericId });
    }
  }

  return decisions.map((decision) => {
    if (decision.expired) return { ...decision, is_duplicate: false };
    const primaryId = primaryMap.get(`${decision.instance_id || 'default'}|${decision.value ?? ''}|${decision.simulated === true ? 'simulated' : 'live'}`);
    return { ...decision, is_duplicate: String(decision.id) !== String(primaryId?.id) };
  });
}

function getDecisionExpirationMs(decision: DecisionListItem): number {
  const expiration = decision.detail.expiration ? Date.parse(decision.detail.expiration) : Number.NaN;
  return Number.isFinite(expiration) ? expiration : Number.NEGATIVE_INFINITY;
}

function getNumericDecisionId(id: string | number): number {
  const value = String(id);
  if (value.startsWith('dup_')) return Number.NEGATIVE_INFINITY;
  const numeric = Number.parseInt(value, 10);
  return Number.isNaN(numeric) ? Number.NEGATIVE_INFINITY : numeric;
}

function emptyAlertDecisionSummary(): AlertDecisionSummary {
  return {
    origins: [],
    active_count: 0,
    expired_count: 0,
    simulated_active_count: 0,
    simulated_expired_count: 0,
  };
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

function getAlertListFilters(context: HonoContext, timeZone: string | null): AlertListFilters {
  return getAlertListFiltersFromValues((key) => context.req.query(key), timeZone);
}

function getFacetRequest(
  context: HonoContext,
  allowedFields: readonly string[],
): FacetRequest | { error: string } {
  const field = String(context.req.query('field') || '').trim().toLowerCase();
  if (!allowedFields.includes(field)) {
    return { error: `field must be one of: ${allowedFields.join(', ')}` };
  }

  return {
    field: field as FacetField,
    search: String(context.req.query('search') || '').trim().slice(0, 200),
    offset: clampInteger(context.req.query('offset'), 0, FACET_MAX_OFFSET, 0),
    limit: clampInteger(context.req.query('limit'), 1, FACET_MAX_LIMIT, FACET_DEFAULT_LIMIT),
  };
}

function clampInteger(
  rawValue: string | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const parsed = Number.parseInt(rawValue || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function withoutAlertFacetFilter(filters: AlertListFilters, field: FacetField): AlertListFilters {
  const result = { ...filters };
  if (field === 'instance') result.instanceId = 'all';
  if (field === 'country') result.country = '';
  if (field === 'scenario') result.scenario = '';
  if (field === 'as') result.as = '';
  if (field === 'ip') result.ip = '';
  if (field === 'target') result.target = '';
  return result;
}

function withoutDecisionFacetFilter(filters: DecisionListFilters, field: FacetField): DecisionListFilters {
  const result = { ...filters };
  if (field === 'instance') result.instanceId = 'all';
  if (field === 'alert') result.alertId = '';
  if (field === 'country') result.country = '';
  if (field === 'scenario') result.scenario = '';
  if (field === 'as') result.as = '';
  if (field === 'ip') result.ip = '';
  if (field === 'target') result.target = '';
  return result;
}

function getAlertListFiltersFromValues(readValue: (key: string) => string | undefined, timeZone: string | null): AlertListFilters {
  return {
    instanceId: readValue('instance') || 'all',
    q: readValue('q') || '',
    ip: lowerValue(readValue('ip')),
    country: lowerValue(readValue('country')),
    scenario: lowerValue(readValue('scenario')),
    as: lowerValue(readValue('as')),
    date: readValue('date') || '',
    dateStart: readValue('dateStart') || '',
    dateEnd: readValue('dateEnd') || '',
    target: lowerValue(readValue('target')),
    simulation: readValue('simulation') || 'all',
    timezoneOffsetMinutes: parseTimezoneOffsetValue(readValue('tz_offset')),
    timeZone: getEffectiveRequestTimeZoneValue(readValue('browser_tz'), timeZone),
  };
}

function getDecisionListFilters(context: HonoContext, timeZone: string | null): DecisionListFilters {
  return getDecisionListFiltersFromValues((key) => context.req.query(key), timeZone);
}

function getDecisionListFiltersFromValues(readValue: (key: string) => string | undefined, timeZone: string | null): DecisionListFilters {
  const alertId = readValue('alert_id') || '';
  return {
    instanceId: readValue('instance') || 'all',
    q: readValue('q') || '',
    alertId,
    country: readValue('country') || '',
    scenario: readValue('scenario') || '',
    as: readValue('as') || '',
    ip: readValue('ip') || '',
    target: lowerValue(readValue('target')),
    dateStart: readValue('dateStart') || '',
    dateEnd: readValue('dateEnd') || '',
    simulation: readValue('simulation') || 'all',
    showDuplicates: readValue('hide_duplicates') === 'false' || Boolean(alertId),
    timezoneOffsetMinutes: parseTimezoneOffsetValue(readValue('tz_offset')),
    timeZone: getEffectiveRequestTimeZoneValue(readValue('browser_tz'), timeZone),
  };
}

function getDashboardStatsFilters(context: HonoContext, timeZone: string | null): DashboardStatsFilters {
  return {
    instanceId: context.req.query('instance') || 'all',
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
    timeZone: getEffectiveRequestTimeZone(context, timeZone),
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
    attackLocations: new Map(),
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
    countries: new Map(),
    liveDecisionBuckets: new Map(),
    simulatedDecisionBuckets: new Map(),
    activeLiveDecisionBuckets: new Map(),
    activeSimulatedDecisionBuckets: new Map(),
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
  if (filters.ip && !matchesIpSearchValue(alert.ip, filters.ip)) return false;
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
  if (filters.ip && !matchesIpSearchValue(decision.value, filters.ip)) return false;

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

  const itemKey = getDateTimeKey(
    isoString,
    filters.granularity === 'hour' || filters.dateStart.includes('T') || filters.dateEnd.includes('T'),
    filters.timezoneOffsetMinutes,
    filters.timeZone,
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

function addDashboardDecision(
  accumulator: DashboardDecisionAccumulator,
  decision: DashboardDecisionStatsRecord,
  filters: DashboardStatsFilters,
  isActive: boolean,
): void {
  const bucketMap = decision.simulated ? accumulator.simulatedDecisionBuckets : accumulator.liveDecisionBuckets;
  const bucketKey = getDashboardBucketKey(decision.createdAt, filters);
  incrementCount(bucketMap, bucketKey);
  if (isActive) {
    const activeBucketMap = decision.simulated
      ? accumulator.activeSimulatedDecisionBuckets
      : accumulator.activeLiveDecisionBuckets;
    incrementCount(activeBucketMap, bucketKey);
  }
}

function normalizeDashboardCountryCode(country: string | undefined): string | undefined {
  const normalized = country?.trim().toUpperCase();
  return normalized && /^[A-Z]{2}$/.test(normalized) ? normalized : undefined;
}

function normalizeDashboardCoordinate(value: unknown, minimum: number, maximum: number): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const coordinate = typeof value === 'number' ? value : Number(value.trim());
  return Number.isFinite(coordinate) && coordinate >= minimum && coordinate <= maximum ? coordinate : undefined;
}

function addDashboardDecisionCountry(
  accumulator: DashboardDecisionAccumulator,
  decision: DashboardDecisionStatsRecord,
  country: string | undefined,
  isActive: boolean,
): void {
  const countryCode = normalizeDashboardCountryCode(country);
  if (!countryCode) return;

  const current = accumulator.countries.get(countryCode) || {
    liveDecisionCount: 0,
    simulatedDecisionCount: 0,
    activeLiveDecisionCount: 0,
    activeSimulatedDecisionCount: 0,
  };
  if (decision.simulated) {
    current.simulatedDecisionCount += 1;
    if (isActive) current.activeSimulatedDecisionCount += 1;
  } else {
    current.liveDecisionCount += 1;
    if (isActive) current.activeLiveDecisionCount += 1;
  }
  accumulator.countries.set(countryCode, current);
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

function dashboardWorldMapData(
  countries: DashboardStatsAccumulator['countries'],
  decisionCountries: DashboardDecisionAccumulator['countries'],
): DashboardWorldMapDatum[] {
  const countryCodes = new Set([...countries.keys(), ...decisionCountries.keys()]);
  return Array.from(countryCodes)
    .map((code) => {
      const summary = countries.get(code);
      const decisionSummary = decisionCountries.get(code);
      return {
        label: getCountryName(code) || code,
        count: summary?.count || 0,
        countryCode: code,
        simulatedCount: summary?.simulatedCount || 0,
        liveCount: summary?.liveCount || 0,
        liveDecisionCount: decisionSummary?.liveDecisionCount || 0,
        simulatedDecisionCount: decisionSummary?.simulatedDecisionCount || 0,
        activeLiveDecisionCount: decisionSummary?.activeLiveDecisionCount || 0,
        activeSimulatedDecisionCount: decisionSummary?.activeSimulatedDecisionCount || 0,
      };
    });
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
    fullDate: getDashboardBucketFullDate(date, filters.timezoneOffsetMinutes, filters.timeZone),
  }));
}

function getDashboardBucketKeys(
  filters: DashboardStatsFilters,
  lookbackDays: number,
  ignoreDateRange: boolean,
): string[] {
  const keys: string[] = [];
  const useExplicitRange = !ignoreDateRange && Boolean(filters.dateStart && filters.dateEnd);

  if (filters.timeZone && filters.granularity === 'hour') {
    const endKey = useExplicitRange
      ? filters.dateEnd
      : getDateTimeKey(new Date().toISOString(), true, filters.timezoneOffsetMinutes, filters.timeZone);
    let startKey = useExplicitRange ? filters.dateStart : endKey;
    if (!useExplicitRange) {
      const startWallDate = parseDashboardWallKey(endKey);
      startWallDate.setUTCDate(startWallDate.getUTCDate() - (lookbackDays - 1));
      startWallDate.setUTCHours(0, 0, 0, 0);
      startKey = formatDashboardClientBucketKey(startWallDate, 'hour');
    }
    return getZonedHourlyBucketKeys(startKey, endKey, filters.timeZone);
  }

  if (useExplicitRange) {
    let cursor = parseDashboardWallKey(filters.dateStart);
    const end = parseDashboardWallKey(filters.dateEnd);
    while (cursor <= end) {
      keys.push(formatDashboardClientBucketKey(cursor, filters.granularity));
      cursor = addDashboardBucketInterval(cursor, filters.granularity);
    }
    return keys;
  }

  const nowKey = getDateTimeKey(
    new Date().toISOString(),
    filters.granularity === 'hour',
    filters.timezoneOffsetMinutes,
    filters.timeZone,
  );
  const end = parseDashboardWallKey(nowKey);
  let cursor = new Date(Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate() - (lookbackDays - 1),
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
  return getDateTimeKey(isoString, filters.granularity === 'hour', filters.timezoneOffsetMinutes, filters.timeZone);
}

function parseDashboardWallKey(key: string): Date {
  const [datePart, timePart] = key.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const hour = timePart === undefined ? 0 : Number(timePart);
  return new Date(Date.UTC(year, month - 1, day, hour, 0, 0, 0));
}

function parseDashboardBucketKey(key: string, timezoneOffsetMinutes: number, timeZone: string | null): Date {
  const wallDate = parseDashboardWallKey(key);
  if (!timeZone) {
    return new Date(wallDate.getTime() + timezoneOffsetMinutes * 60_000);
  }

  const wallTime = wallDate.getTime();
  let instant = new Date(wallTime);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    instant = new Date(wallTime - getTimeZoneOffsetMs(instant, timeZone));
  }
  return instant;
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

function addDashboardBucketInterval(date: Date, granularity: DashboardGranularity): Date {
  const next = new Date(date);
  if (granularity === 'hour') {
    next.setUTCHours(next.getUTCHours() + 1);
  } else {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

function getDashboardBucketFullDate(key: string, timezoneOffsetMinutes: number, timeZone: string | null): string {
  return parseDashboardBucketKey(key, timezoneOffsetMinutes, timeZone).toISOString();
}
function lowerQuery(context: HonoContext, key: string): string {
  return lowerValue(context.req.query(key));
}

function lowerValue(value: string | undefined): string {
  return (value || '').toLowerCase();
}

function toSearchErrorResponse(error: SearchParseError): { error: string; details: SearchParseError } {
  return {
    error: error.message,
    details: error,
  };
}

function parseTimezoneOffset(context: HonoContext): number {
  return parseTimezoneOffsetValue(context.req.query('tz_offset'));
}

function parseTimezoneOffsetValue(rawValue: string | undefined): number {
  const value = Number.parseInt(rawValue || '0', 10);
  return Number.isFinite(value) ? value : 0;
}

function getEffectiveRequestTimeZone(context: HonoContext, configuredTimeZone: string | null): string | null {
  return getEffectiveRequestTimeZoneValue(context.req.query('browser_tz'), configuredTimeZone);
}

function getEffectiveRequestTimeZoneValue(browserTimeZone: string | undefined, configuredTimeZone: string | null): string | null {
  return configuredTimeZone || sanitizeRequestTimeZone(browserTimeZone);
}

function sanitizeRequestTimeZone(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(new Date(0));
    return value;
  } catch {
    return null;
  }
}

function matchesAlertListFilters(alert: SlimAlert, filters: AlertListFilters): boolean {
  if (!matchesSimulationFilter(alert.simulated === true, filters.simulation)) return false;

  const scenario = (alert.scenario || '').toLowerCase();
  const cn = (alert.source?.cn || '').toLowerCase();
  const asName = (alert.source?.as_name || '').toLowerCase();
  const target = (alert.target || '').toLowerCase();

  if (filters.ip && !getSlimAlertSourceValues(alert).some((value) => matchesIpSearchValue(value, filters.ip))) return false;
  if (filters.country && !cn.includes(filters.country)) return false;
  if (filters.scenario && !scenario.includes(filters.scenario)) return false;
  if (filters.as && !asName.includes(filters.as)) return false;
  if (filters.target && !target.includes(filters.target)) return false;
  if (filters.date && !(alert.created_at && alert.created_at.startsWith(filters.date))) return false;

  if (filters.dateStart || filters.dateEnd) {
    const itemKey = getDateTimeKey(
      alert.created_at,
      filters.dateStart.includes('T') || filters.dateEnd.includes('T'),
      filters.timezoneOffsetMinutes,
      filters.timeZone,
    );
    if (filters.dateStart && itemKey < filters.dateStart) return false;
    if (filters.dateEnd && itemKey > filters.dateEnd) return false;
  }

  return true;
}

function matchesDecisionListFilters(decision: DecisionListItem, filters: DecisionListFilters): boolean {
  if (!filters.showDuplicates && decision.is_duplicate) return false;
  if (filters.alertId && String(decision.detail.alert_id) !== filters.alertId) return false;
  if (!matchesSimulationFilter(decision.simulated === true, filters.simulation)) return false;
  if (filters.country && decision.detail.country !== filters.country) return false;
  if (filters.scenario && decision.detail.reason !== filters.scenario) return false;
  if (filters.as && decision.detail.as !== filters.as) return false;
  if (filters.ip && !matchesIpSearchValue(decision.value, filters.ip)) return false;

  if (filters.target) {
    const value = (decision.value || '').toLowerCase();
    const target = (decision.detail.target || '').toLowerCase();
    if (!value.includes(filters.target) && !target.includes(filters.target)) return false;
  }

  if (filters.dateStart || filters.dateEnd) {
    if (!decision.created_at) return false;
    const itemKey = getDateTimeKey(
      decision.created_at,
      filters.dateStart.includes('T') || filters.dateEnd.includes('T'),
      filters.timezoneOffsetMinutes,
      filters.timeZone,
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

function getSlimAlertSourceValues(alert: SlimAlert): string[] {
  return [alert.source?.ip, alert.source?.value, alert.source?.range]
    .filter((value): value is string => Boolean(value));
}

function isDecisionListItemExpired(decision: DecisionListItem): boolean {
  return decision.expired === true;
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
