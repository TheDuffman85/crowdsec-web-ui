import type {
  AlertDecision,
  AlertRecord,
  LapiStatus,
  SyncStatus,
} from '../../shared/contracts';
import type { SearchNode } from '../../shared/search';
import type { RuntimeConfig } from '../config';
import type { AlertInsertParams, CrowdsecDatabase, DecisionInsertParams } from '../database';
import type { LapiClient } from '../lapi';
import type { NormalizedAlertRow } from '../normalized-record';
import type { DatabaseQueryWorker } from '../query-worker-client';
import type {
  AlertDecisionComparison,
  AlertDecisionComparisonResult,
  SyncAlertMutation,
} from '../sync-worker-client';

type HonoContext = any;
type HonoNext = any;

interface AlertSyncQuery {
  origin?: string;
  scenario?: string;
  includeCapi?: boolean;
  singleScopeOnly?: boolean;
}

interface AlertSyncDelta {
  decisionIdsToPersist: Set<string> | null;
  removedIds: Set<string>;
  reconcileDecisions: boolean;
  updateAlertRawDataOnly: boolean;
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

export interface SyncServiceState extends Record<string, any> {
  reconcileWindowState: ReconcileWindowState;
  initializationPromise: Promise<SyncHistorySummary | null> | null;
  cacheRefreshCompletedAt: string | null;
  cacheRefreshPromise: Promise<void> | null;
  nextRefreshAt: string | null;
  refreshIntervalMs: number;
}

export interface SyncServiceDependencies extends Record<string, any> {
  config: RuntimeConfig;
  database: CrowdsecDatabase;
  lapiClient: LapiClient;
  lapiClients: Map<string, LapiClient>;
  queryWorker: DatabaseQueryWorker;
  state: SyncServiceState;
}

export function createSyncService(dependencies: SyncServiceDependencies) {
  const state = dependencies.state;
  const {
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
  } = dependencies;

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
  return effectiveOrigins.some((origin: string) => includedOrigins.has(origin));
}

function shouldExcludeAlertByOrigin(alert: AlertRecord): boolean {
  const effectiveOrigins = getAlertFallbackOrigins(alert);
  if (effectiveOrigins.length === 0) {
    return config.alertExcludeOriginEmpty;
  }

  if (config.alertExcludeOrigins.length === 0) return false;
  return effectiveOrigins.some((origin: string) => config.alertExcludeOrigins.includes(origin));
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
    const hasAllowedExplicitOrigin = effectiveOrigins.some((origin: string) =>
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
  const targetSummary = getAlertTargetSummary(alert);
  const targets = getAlertTargets(alert);
  const target = targetSummary.target;
  const machine = resolveMachineName(alert);
  const simulated = isAlertSimulated(alert);
  const enrichedAlert: AlertRecord = {
    ...alert,
    target,
    targets,
    target_count: targetSummary.count,
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
      machine_id: alert.machine_id,
      machine_alias: alert.machine_alias,
      target,
      targets,
      target_count: targetSummary.count,
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
  const deltas = await getAlertSyncDeltas(alerts, observedAt, instanceId);
  let decisionMutationCount = 0;
  for (let alertIndex = 0; alertIndex < alerts.length; alertIndex += 1) {
    const alert = alerts[alertIndex];
    const decisions = Array.isArray(alert.decisions) ? alert.decisions : [];
    const alertId = String(alert.id);
    const delta = deltas[alertIndex];
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

async function getAlertSyncDeltas(
  alerts: AlertRecord[],
  observedAt: string,
  instanceId: string,
): Promise<Array<AlertSyncDelta | null>> {
  if (!syncWorker.compareAlertDecisions) {
    return alerts.map((alert) => getAlertSyncDelta(
      alert,
      Array.isArray(alert.decisions) ? alert.decisions : [],
      observedAt,
      instanceId,
    ));
  }

  const comparisons = alerts.map((alert) => buildAlertDecisionComparison(
    alert,
    Array.isArray(alert.decisions) ? alert.decisions : [],
    observedAt,
    instanceId,
  ));
  const decisionCount = comparisons.reduce((total, comparison) => total + comparison.decisionIds.length, 0);
  const startedAt = Date.now();
  const results = await syncWorker.compareAlertDecisions(comparisons);
  if (decisionCount >= SYNC_DEFER_SEARCH_INDEX_DECISION_THRESHOLD) {
    console.log(
      `Compared ${decisionCount} incoming decision IDs with the committed cache `
      + `in ${formatElapsedTime(Date.now() - startedAt)} off the request thread.`,
    );
  }
  return results.map(toAlertSyncDelta);
}

function buildAlertDecisionComparison(
  alert: AlertRecord,
  decisions: AlertDecision[],
  observedAt: string,
  instanceId: string,
): AlertDecisionComparison {
  const decisionIds: string[] = [];
  const inactiveDecisionIds: string[] = [];
  for (const decision of decisions) {
    const id = String(decision.id);
    decisionIds.push(id);
    if (isIncomingDecisionInactive(decision)) inactiveDecisionIds.push(id);
  }

  const { decisions: _incomingDecisions, ...incomingAlertMetadata } = alert;
  const targetSummary = getAlertTargetSummary(alert);
  const targets = getAlertTargets(alert);
  const incomingMetadata = {
    ...incomingAlertMetadata,
    target: targetSummary.target,
    targets,
    target_count: targetSummary.count,
    simulated: isAlertSimulated(alert),
  } as AlertRecord;
  return {
    alertId: alert.id,
    instanceId,
    metadataHash: alertMetadataFingerprint(incomingMetadata),
    decisionIds,
    inactiveDecisionIds,
    observedAt,
    origins: collectDistinctOrigins(decisions).join(' ').trim() || null,
    simulated: isAlertSimulated(alert) ? 1 : 0,
  };
}

function toAlertSyncDelta(result: AlertDecisionComparisonResult | null): AlertSyncDelta | null {
  if (!result) return null;
  return {
    decisionIdsToPersist: result.decisionIdsToPersist === null
      ? null
      : new Set(result.decisionIdsToPersist),
    removedIds: new Set(result.removedIds),
    reconcileDecisions: result.reconcileDecisions,
    updateAlertRawDataOnly: result.updateAlertRawDataOnly,
  };
}

function getAlertSyncDelta(
  alert: AlertRecord,
  decisions: AlertDecision[],
  observedAt: string,
  instanceId = primaryInstance.id,
): AlertSyncDelta | null {
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
  const targetSummary = getAlertTargetSummary(alert);
  const targets = getAlertTargets(alert);
  const incomingMetadata = {
    ...incomingAlertMetadata,
    target: targetSummary.target,
    targets,
    target_count: targetSummary.count,
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
  state.reconcileWindowState = {
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
      lastSuccess: state.reconcileWindowState.windows[window.key] || 0,
    };
  });
  candidates.push({
    key: headKey,
    start: headStart,
    end: now,
    active: headActive,
    intervalMs: headActive ? config.reconcileActiveIntervalMs : config.reconcileRecentIntervalMs,
    lastSuccess: state.reconcileWindowState.headLastSuccess,
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
  if (window.head) state.reconcileWindowState.headLastSuccess = now;
  else state.reconcileWindowState.windows[window.key] = now;
}

function finishReconcilePlan(plan: ReconcilePlan): void {
  state.reconcileWindowState.windows = Object.fromEntries(
    Object.entries(state.reconcileWindowState.windows).filter(([key]) => plan.currentKeys.has(key)),
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
  if (state.initializationPromise) {
    console.log('Cache initialization already in progress, waiting...');
    return state.initializationPromise;
  }

  state.initializationPromise = (async () => {
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
      cache.lastUpdate = syncSummary.syncedThrough;
      instanceLastUpdates.set(primaryInstance.id, syncSummary.syncedThrough);
      cache.isInitialized = syncSummary.state !== 'failed';
      cache.isComplete = syncSummary.state === 'complete';
      if (syncSummary.state === 'complete') {
        seedReconcileWindowState(Date.parse(syncSummary.syncedThrough));
      }
      lapiClient.updateStatus(syncSummary.state === 'complete', syncSummary.errors[0] ? { message: syncSummary.errors[0] } : null);
      if (cache.isInitialized) {
        if (syncStatus.isSyncing) {
          updateSyncStatus({
            progress: 99,
            message: t('components.syncOverlay.statusPreparingDashboard'),
          });
        }
        try {
          const prepared = await prepareDashboardStatsAfterRefresh(
            syncSummary.changed,
            undefined,
            { force: true },
          );
          if (!prepared) {
            await getDashboardStatsIndex('all', true);
          }
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
      state.cacheRefreshCompletedAt = new Date().toISOString();
      publishCacheUpdate(state.cacheRefreshCompletedAt);
      const errorSummary = syncSummary.errors.length > 0
        ? `  Errors: ${syncSummary.errors.length} window${syncSummary.errors.length === 1 ? '' : 's'} failed
`
        : '';
      const cacheSummary = `Cache ${syncSummary.state === 'complete' ? 'initialized successfully' : 'initialized partially'}:
  Historical: ${syncSummary.historicalAlerts} alerts and ${syncSummary.historicalDecisions} decisions fetched
  Cache: ${syncSummary.cachedAlerts} alerts and ${syncSummary.cachedDecisions} decisions
${errorSummary}  Status: ${syncSummary.state}
  Refresh Interval: ${getIntervalName(state.refreshIntervalMs)}
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
      state.initializationPromise = null;
    }
  })();

  return state.initializationPromise;
}

async function initializeMultiInstanceCache(options: { showOverlay?: boolean } = {}): Promise<SyncHistorySummary | null> {
  if (state.initializationPromise) {
    console.log('Multi-instance cache initialization already in progress, waiting...');
    return state.initializationPromise;
  }

  state.initializationPromise = (async () => {
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
          // Multi-instance initialization has always invalidated the combined
          // dashboard after rebuilding shared indexes, even when LAPI rows did
          // not change. Keep that boundary while warming the active response.
          const prepared = await prepareDashboardStatsAfterRefresh(
            true,
            undefined,
            { force: true },
          );
          if (!prepared) {
            await getDashboardStatsIndex('all', true);
          }
        } catch (error: any) {
          console.error('Failed to prepare Combined dashboard data before completing initial sync:', error.message);
        }
      }

      const completedAt = new Date().toISOString();
      const allErrors: string[] = [];
      for (let index = 0; index < runtimes.length; index += 1) {
        const runtime = runtimes[index];
        const summary = summaries[index];
        const errors = summary.errors.map((error: string) => `${runtime.instanceName}: ${error}`);
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
    dependencies.state.cacheRefreshCompletedAt = completedAt;
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
      state.initializationPromise = null;
    }
  })();

  return state.initializationPromise;
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
    const reconcileStateBeforeRefresh = structuredClone(state.reconcileWindowState);
    let refreshResult: {
      deltaSummary: WindowSyncSummary;
      reconcileSummary: WindowSyncSummary;
      dataChanged: boolean;
    };
    let releasePublishedRevision: (() => void) | null = null;
    try {
      const committedRefresh = await runConsistentDatabaseRefresh(async () => {
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
        const removed = await cleanupOldData();
        const dataChanged = deltaSummary.changed
          || reconcileSummary.changed
          || removed.alerts > 0
          || removed.decisions > 0;
        const duplicateRefreshStartedAt = Date.now();
        await syncWorker.refreshDecisionDuplicateFlags(new Date().toISOString());
        console.log(`Decision duplicate index refreshed in ${formatElapsedTime(Date.now() - duplicateRefreshStartedAt)}.`);
        return { deltaSummary, reconcileSummary, dataChanged };
      });
      refreshResult = committedRefresh.result;
      releasePublishedRevision = committedRefresh.releasePublishedRevision;
    } catch (error) {
      state.reconcileWindowState = reconcileStateBeforeRefresh;
      throw error;
    }

    let publishedRevision: string | null = null;
    try {
      const { deltaSummary, reconcileSummary, dataChanged } = refreshResult;
      if (reconcilePlan) finishReconcilePlan(reconcilePlan);
      prepareDashboardStatsAfterRefreshInBackground(dataChanged, undefined, 'delta update');
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
      state.cacheRefreshCompletedAt = new Date().toISOString();
      publishedRevision = state.cacheRefreshCompletedAt;
    } finally {
      releasePublishedRevision?.();
    }
    if (publishedRevision) publishCacheUpdate(publishedRevision);
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
    const committedRefresh = await runConsistentDatabaseRefresh(async () => {
      const summary = await syncAlertWindow(start, now, now);
      if (summary.errors.length > 0) {
        const error = summary.lastError || new Error(`Latest-window refresh incomplete: ${summary.errors.join('; ')}`);
        lapiClient.updateStatus(false, error);
        throw error;
      }
      const removed = await cleanupOldData();
      const dataChanged = summary.changed || removed.alerts > 0 || removed.decisions > 0;
      await syncWorker.refreshDecisionDuplicateFlags(new Date().toISOString());
      return { summary, dataChanged };
    });
    let publishedRevision: string | null = null;
    try {
      const { summary, dataChanged } = committedRefresh.result;
      state.reconcileWindowState.headLastSuccess = now;
      saveReconcileWindowState();
      prepareDashboardStatsAfterRefreshInBackground(dataChanged, undefined, 'latest-window refresh');
      cache.lastUpdate = new Date(now).toISOString();
      instanceLastUpdates.set(primaryInstance.id, cache.lastUpdate);
      lapiClient.updateStatus(true, null);
      state.cacheRefreshCompletedAt = new Date().toISOString();
      publishedRevision = state.cacheRefreshCompletedAt;
      console.log(`Latest-window refresh complete: ${summary.alerts} alerts and ${summary.decisions} decisions synced.`);
    } finally {
      committedRefresh.releasePublishedRevision();
    }
    if (publishedRevision) publishCacheUpdate(publishedRevision);
    await runNotificationEvaluation('manual latest-window refresh');
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

async function cleanupOldData(): Promise<{ alerts: number; decisions: number }> {
  const cutoff = new Date(Date.now() - config.lookbackMs).toISOString();
  try {
    const removed = await syncWorker.cleanupOldData(cutoff);
    console.log(`Cleanup: Removed ${removed.alerts} old alerts, ${removed.decisions} old decisions`);
    return removed;
  } catch (error: any) {
    console.error('Cleanup failed:', error.message);
    return { alerts: 0, decisions: 0 };
  }
}

function runCacheRefresh(operation: () => Promise<void>, skipIfBusy = false): Promise<void> {
  if (state.cacheRefreshPromise) return skipIfBusy ? Promise.resolve() : state.cacheRefreshPromise;

  state.cacheRefreshPromise = operation().finally(() => {
    state.cacheRefreshPromise = null;
  });
  return state.cacheRefreshPromise;
}

async function runConsistentDatabaseRefresh<T>(
  operation: () => Promise<T>,
): Promise<{ result: T; releasePublishedRevision: () => void }> {
  let releasePublishedRevision: (() => void) | null = null;
  try {
    const result = syncWorker.runTransaction
      ? await syncWorker.runTransaction(operation, {
          beforeCommit: async () => {
            releasePublishedRevision = await acquirePublishedRevisionWrite();
          },
        })
      : await (async () => {
          releasePublishedRevision = await acquirePublishedRevisionWrite();
          return operation();
        })();
    let released = false;
    return {
      result,
      releasePublishedRevision: () => {
        if (released) return;
        released = true;
        releasePublishedRevision?.();
      },
    };
  } catch (error) {
    (releasePublishedRevision as (() => void) | null)?.();
    throw error;
  }
}

async function updateCache(options: { throwOnError?: boolean; reconcile?: boolean; skipIfBusy?: boolean } = {}): Promise<void> {
  return runCacheRefresh(async () => {
    await updateCacheDelta(options);
    await runNotificationEvaluation('cache update');
  }, options.skipIfBusy);
}

function clearBootstrapRetryTimeout(): void {
  if (state.bootstrapRetryTimeout) {
    clearTimeout(state.bootstrapRetryTimeout);
    state.bootstrapRetryTimeout = null;
  }
}

function finalizeBootstrapRecovery(): void {
  clearBootstrapRetryTimeout();
  state.bootstrapWaitLogged = false;
  if (state.refreshIntervalMs > 0 && !state.isSchedulerRunning) {
    console.log('Bootstrap recovery completed. Starting background refresh scheduler.');
    startRefreshScheduler();
  }
}

function scheduleBootstrapRetry(reason = 'retry requested', options: { allowInitialized?: boolean } = {}): void {
  if (
    !lapiClient.hasAuthConfig() ||
    !config.bootstrapRetryEnabled ||
    (!options.allowInitialized && cache.isInitialized) ||
    state.bootstrapRetryTimeout
  ) {
    return;
  }

  console.log(`Next bootstrap attempt scheduled in ${getIntervalName(config.bootstrapRetryDelayMs)}: ${reason}.`);
  state.bootstrapRetryTimeout = setTimeout(() => {
    state.bootstrapRetryTimeout = null;
    void ensureBootstrapReady('bootstrap retry');
  }, config.bootstrapRetryDelayMs);
}

async function prepareReadCache(source: string): Promise<void> {
  if (cache.isInitialized) {
    return;
  }

  if (state.bootstrapPromise && isBackgroundBootstrapSource(state.bootstrapSource)) {
    return;
  }

  await ensureBootstrapReady(source);
}

async function prepareOnDemandRefresh(context: HonoContext): Promise<void> {
  if (
    state.refreshIntervalMs === 0
    && !context.get(onDemandRefreshPreparedContextKey)
  ) {
    await updateCache({ skipIfBusy: true });
  }
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

  if (state.bootstrapPromise) {
    console.log(`Bootstrap recovery already in progress; joining it (${source})...`);
    return state.bootstrapPromise;
  }

  // A manually or request-triggered recovery supersedes any older retry that
  // was scheduled while the cache was unavailable.
  clearBootstrapRetryTimeout();
  state.bootstrapSource = source;
  state.bootstrapPromise = (async () => {
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
    return await state.bootstrapPromise;
  } finally {
    state.bootstrapPromise = null;
    state.bootstrapSource = null;
  }
}

async function runSchedulerLoop(): Promise<void> {
  if (!state.isSchedulerRunning) return;
  state.schedulerTimeout = null;
  state.nextRefreshAt = null;

  const now = Date.now();
  const isIdle = now - state.lastRequestTime > config.idleThresholdMs;

  try {
    if (state.bootstrapPromise || state.initializationPromise) {
      if (!state.bootstrapWaitLogged) {
        state.bootstrapWaitLogged = true;
        console.log('Background refresh paused until bootstrap recovery completes.');
      }
    } else if (historicalInstanceSyncPending.size > 0) {
      if (!state.bootstrapWaitLogged) {
        state.bootstrapWaitLogged = true;
        console.log('Background refresh paused until all instance history is synchronized.');
      }
    } else if (!cache.isInitialized) {
      if (!state.bootstrapWaitLogged) {
        state.bootstrapWaitLogged = true;
        console.log('Background refresh paused because the cache is not initialized.');
      }
      scheduleBootstrapRetry('cache is not initialized');
    } else {
      if (state.cacheRefreshPromise) {
        console.log('Background refresh skipped because another refresh is already in progress.');
      } else {
        console.log(`Background refresh triggered (${isIdle ? 'IDLE' : 'ACTIVE'})...`);
        await updateCache({ skipIfBusy: true });
      }
    }
  } catch (error) {
    console.error('Scheduler update failed:', error);
  }

  if (!state.isSchedulerRunning) return;

  const currentIdle = Date.now() - state.lastRequestTime > config.idleThresholdMs;
  let nextInterval = state.refreshIntervalMs;

  if (nextInterval > 0 && currentIdle && nextInterval < config.idleRefreshIntervalMs) {
    nextInterval = config.idleRefreshIntervalMs;
    console.log(`Idle mode active. Next refresh in ${getIntervalName(nextInterval)}.`);
  }

  if (nextInterval <= 0) {
    console.log('Scheduler in manual mode. Stopping loop.');
    state.isSchedulerRunning = false;
    return;
  }

  state.schedulerTimeout = setTimeout(() => {
    void runSchedulerLoop();
  }, nextInterval);
  state.nextRefreshAt = new Date(Date.now() + nextInterval).toISOString();
}

function startRefreshScheduler(): void {
  stopRefreshScheduler(false);
  if (state.refreshIntervalMs <= 0) {
    console.log('Manual refresh mode - cache will update on each request');
    return;
  }

  console.log(`Starting smart scheduler (active: ${getIntervalName(state.refreshIntervalMs)}, idle: ${getIntervalName(config.idleRefreshIntervalMs)})...`);
  state.isSchedulerRunning = true;
  state.schedulerTimeout = setTimeout(() => {
    void runSchedulerLoop();
  }, state.refreshIntervalMs);
  state.nextRefreshAt = new Date(Date.now() + state.refreshIntervalMs).toISOString();
}

function stopRefreshScheduler(logStop = true): void {
  if (logStop && (state.isSchedulerRunning || state.schedulerTimeout || state.bootstrapRetryTimeout)) {
    console.log('Stopping refresh scheduler...');
  }
  state.isSchedulerRunning = false;
  state.nextRefreshAt = null;
  if (state.schedulerTimeout) {
    clearTimeout(state.schedulerTimeout);
    state.schedulerTimeout = null;
  }
  if (state.bootstrapRetryTimeout) {
    clearTimeout(state.bootstrapRetryTimeout);
    state.bootstrapRetryTimeout = null;
  }
}

async function sendMachineHeartbeat(): Promise<void> {
  if (!lapiClient.hasAuthConfig()) {
    return;
  }

  if (state.heartbeatPromise) {
    return state.heartbeatPromise;
  }

  state.heartbeatPromise = (async () => {
    try {
      await lapiClient.heartbeat();
      await lapiClient.sendUsageMetrics();
      if (state.heartbeatFailureLogged) {
        console.log('CrowdSec machine heartbeat restored.');
      }
      state.heartbeatFailureLogged = false;
    } catch (error: any) {
      const message = error?.message || 'Unknown error';
      if (!state.heartbeatFailureLogged) {
        console.warn(`CrowdSec machine heartbeat or metrics update failed: ${message}`);
      }
      state.heartbeatFailureLogged = true;
    } finally {
      state.heartbeatPromise = null;
    }
  })();

  return state.heartbeatPromise;
}

async function runHeartbeatLoop(): Promise<void> {
  if (!state.isHeartbeatSchedulerRunning) return;

  await sendMachineHeartbeat();

  if (!state.isHeartbeatSchedulerRunning || config.heartbeatIntervalMs <= 0) return;

  state.heartbeatTimeout = setTimeout(() => {
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
  state.isHeartbeatSchedulerRunning = true;
  state.heartbeatTimeout = setTimeout(() => {
    void runHeartbeatLoop();
  }, 0);
}

function stopHeartbeatScheduler(logStop = true): void {
  if (logStop && (state.isHeartbeatSchedulerRunning || state.heartbeatTimeout)) {
    console.log('Stopping CrowdSec machine heartbeat...');
  }
  state.isHeartbeatSchedulerRunning = false;
  if (state.heartbeatTimeout) {
    clearTimeout(state.heartbeatTimeout);
    state.heartbeatTimeout = null;
  }
}

async function activityTrackerMiddleware(context: HonoContext, next: HonoNext): Promise<void> {
  const pathname = new URL(context.req.url).pathname;
  if (pathname === '/api/health' || pathname === `${config.basePath}/api/health`) {
    await next();
    return;
  }

  const now = Date.now();
  const wasIdle = now - state.lastRequestTime > config.idleThresholdMs;
  state.lastRequestTime = now;

  if (wasIdle && state.isSchedulerRunning) {
    console.log('System waking up from idle mode. Triggering immediate refresh...');
    if (state.schedulerTimeout) {
      clearTimeout(state.schedulerTimeout);
      state.schedulerTimeout = null;
    }
    state.nextRefreshAt = null;
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



  return {
    runNotificationEvaluation,
    syncAlertWindow,
    syncHistory,
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
  };
}
