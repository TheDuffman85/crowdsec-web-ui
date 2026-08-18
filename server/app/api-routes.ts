import type { Hono } from 'hono';
import type {
  AddDecisionRequest,
  AlertRecord,
  BulkDeleteResult,
  BulkDeleteRequest,
  CleanupByIpRequest,
  ConfigResponse,
  CrowdsecMetricsResponse,
  InstanceEntityRef,
  StatsAlert,
  StatsDecision,
  UpdateManualRefreshSettingRequest,
  UpdateMetricsSidebarPreferenceRequest,
  UpsertNotificationChannelRequest,
  UpsertNotificationRuleRequest,
} from '../../shared/contracts';
import type { AuditOutcome } from '../audit-log';
import type { RuntimeConfig } from '../config';
import type { CrowdsecDatabase } from '../database';
import type { LapiClient } from '../lapi';
import type { DatabaseQueryWorker } from '../query-worker-client';
import type { DashboardStatsFilters } from './types';

type HonoContext = any;
type AnyError = Error & {
  code?: string;
  response?: { data?: unknown; status: number };
  request?: unknown;
  helpLink?: string;
  helpText?: string;
};

export interface ApiRouteState {
  refreshIntervalMs: number;
  manualRefreshEnabled: boolean;
  metricsSidebarVisible: boolean;
  cacheRefreshCompletedAt: string | null;
  cache: { isInitialized: boolean; isComplete: boolean; lastUpdate: string | null };
  initialHistorySyncs: Set<string>;
  instanceLastUpdates: Map<string, string | null>;
  staleDashboardStatsResponseCache: Map<string, unknown>;
  lastDashboardStatsFilters: DashboardStatsFilters | null;
  lastDashboardStatsRequestedAt: number;
  historicalInstanceSyncPending: Set<string>;
  nextRefreshAt: string | null;
  cacheRefreshPromise: Promise<void> | null;
  initializationPromise: Promise<unknown> | null;
  bootstrapPromise: Promise<unknown> | null;
}

export interface ApiRouteDependencies extends Record<string, any> {
  app: Hono;
  config: RuntimeConfig;
  database: CrowdsecDatabase;
  lapiClient: LapiClient;
  lapiClients: Map<string, LapiClient>;
  analyticsQueryWorker: DatabaseQueryWorker;
  state: ApiRouteState;
}

export function registerApiRoutes(dependencies: ApiRouteDependencies): void {
  const app = dependencies.app;
  const state = dependencies.state;
  const {
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
    groupInstanceEntityRefs,
    hydrateAlertsBatch,
    hydrateAlertWithDecisions,
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
    noteDashboardStatsRequest,
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
    warmDashboardStatsCache,
    withAlertTargetSummary,
    withInstanceName,
    decisionFromRow,
  } = dependencies;

  // Audit lists stay bounded so a large bulk operation cannot produce an
  // unusable log line; the requested/deleted counters remain exact.
  const AUDIT_LIST_LIMIT = 100;

  function capAuditEntries(entries: string[]): { entries: string[]; truncated: boolean } {
    return entries.length > AUDIT_LIST_LIMIT
      ? { entries: entries.slice(0, AUDIT_LIST_LIMIT), truncated: true }
      : { entries, truncated: false };
  }

  function auditOutcome(succeeded: number, failed: number): AuditOutcome {
    if (failed === 0) return 'success';
    return succeeded > 0 ? 'partial' : 'failure';
  }

  // Deletions are requested by decision ID, so the banned value (IP or range)
  // is resolved from the local cache while the rows still exist.
  function resolveDecisionValues(refs: Array<{ id: string | number; instance_id?: string }>): string[] {
    const values = new Set<string>();
    for (const ref of refs) {
      const internalId = ref.instance_id ? database.getDecisionInternalId(ref.instance_id, ref.id) : String(ref.id);
      const value = internalId === null ? undefined : database.getDecisionById(internalId)?.value;
      if (typeof value === 'string' && value) values.add(value);
    }
    return Array.from(values);
  }

app.get(`${config.basePath}/api/alerts`, ensureAuth, ensurePublishedRevisionRead, async (context) => {
  try {
    await prepareOnDemandRefresh(context);

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
      .map((alert: AlertRecord) => applySimulationModeToAlert(alert, config.simulationsEnabled))
      .filter((alert: AlertRecord | null): alert is AlertRecord => alert !== null)
      .map((alert: AlertRecord) => toSlimAlert(alert))
      .sort((left: { created_at: string }, right: { created_at: string }) =>
        new Date(right.created_at).getTime() - new Date(left.created_at).getTime());

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

app.get(`${config.basePath}/api/alerts/facets`, ensureAuth, ensurePublishedRevisionRead, async (context) => {
  const request = getFacetRequest(context, ALERT_FACET_FIELDS);
  if ('error' in request) {
    return context.json({ error: request.error }, 400);
  }

  try {
    await prepareOnDemandRefresh(context);
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
      const alertIds = capAuditEntries(validated.map((ref: InstanceEntityRef) => `${ref.instance_id}:${ref.id}`));
      auditLog.record(context, {
        action: 'alert.delete',
        alert_ids: alertIds.entries,
        ...(alertIds.truncated ? { truncated: true } : {}),
        requested_alerts: result.requested_alerts,
        deleted_alerts: result.deleted_alerts,
        outcome: auditOutcome(result.deleted_alerts, result.failed.length),
      });
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
    const alertIds = capAuditEntries(ids);
    auditLog.record(context, {
      action: 'alert.delete',
      alert_ids: alertIds.entries,
      ...(alertIds.truncated ? { truncated: true } : {}),
      deleted_alerts: result.deleted_alerts,
      deleted_decisions: result.deleted_decisions,
      outcome: auditOutcome(result.deleted_alerts + result.deleted_decisions, result.failed.length),
    });
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

app.get(`${config.basePath}/api/alerts/:id`, ensureAuth, ensurePublishedRevisionRead, async (context) => {
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
      const payload = applySimulationModeToAlert({ ...withAlertTargetSummary(alert), decisions: [] }, config.simulationsEnabled);
      return payload ? context.json(payload) : context.json({ error: 'Alert not found' }, 404);
    }

    const alertData = await lapiClient.getAlertById(alertId);
    const normalizedAlert = normalizeAlertDetail(alertData, alertId);
    if (!normalizedAlert) {
      return context.json({ error: 'Alert not found' }, 404);
    }

    const payload = applySimulationModeToAlert(hydrateAlertWithDecisions(withAlertTargetSummary(normalizedAlert)), config.simulationsEnabled);
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
    auditLog.record(context, {
      action: 'alert.delete',
      alert_ids: [alertId],
      deleted_alerts: result.deleted_alerts,
      deleted_decisions: result.deleted_decisions,
      outcome: auditOutcome(result.deleted_alerts + result.deleted_decisions, result.failed.length),
    });
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

app.get(`${config.basePath}/api/decisions`, ensureAuth, ensurePublishedRevisionRead, async (context) => {
  try {
    await prepareOnDemandRefresh(context);

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

app.get(`${config.basePath}/api/decisions/facets`, ensureAuth, ensurePublishedRevisionRead, async (context) => {
  const request = getFacetRequest(context, DECISION_FACET_FIELDS);
  if ('error' in request) {
    return context.json({ error: request.error }, 400);
  }

  try {
    await prepareOnDemandRefresh(context);
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

app.get(`${config.basePath}/api/instances/:instanceId/alerts/:id`, ensureAuth, ensurePublishedRevisionRead, async (context) => {
  const instanceId = String(context.req.param('instanceId'));
  const instance = config.instances.find((candidate) => candidate.id === instanceId);
  if (!instance) return context.json({ error: 'Unknown CrowdSec instance' }, 404);
  try {
    const alert = normalizeAlertDetail(await lapiClients.get(instanceId)!.getAlertById(context.req.param('id')), context.req.param('id'));
    return alert
      ? context.json(withInstanceName({ ...withAlertTargetSummary(alert), instance_id: instanceId }))
      : context.json({ error: 'Alert not found' }, 404);
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
    const alertId = String(context.req.param('id'));
    await lapiClients.get(instanceId)!.deleteAlert(alertId);
    await syncWorker.runExclusive(() => database.deleteAlertByInstanceId(instanceId, alertId));
    invalidateDashboardStatsCache();
    auditLog.record(context, {
      action: 'alert.delete',
      alert_ids: [alertId],
      instance: instance.name,
      outcome: 'success',
    });
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
    const decisionId = String(context.req.param('id'));
    const values = resolveDecisionValues([{ id: decisionId, instance_id: instanceId }]);
    await lapiClients.get(instanceId)!.deleteDecision(decisionId);
    await syncWorker.runExclusive(() => database.deleteDecisionByInstanceId(instanceId, decisionId));
    invalidateDashboardStatsCache();
    auditLog.record(context, {
      action: 'decision.delete',
      decision_ids: [decisionId],
      ...(values.length > 0 ? { values } : {}),
      instance: instance.name,
      outcome: 'success',
    });
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
    refresh_interval: state.refreshIntervalMs,
    manual_refresh_enabled: state.manualRefreshEnabled,
    current_interval_name: getIntervalName(state.refreshIntervalMs),
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
    cache_last_update: state.cacheRefreshCompletedAt,
    next_refresh_at: state.nextRefreshAt,
    simulations_enabled: config.simulationsEnabled,
    machine_features_enabled: true,
    origin_features_enabled: true,
    time_zone: config.timeZone,
    time_format: config.timeFormat,
    metrics_enabled: config.instances.some((instance) => instance.prometheus.length > 0),
    metrics_sidebar_visible: state.metricsSidebarVisible,
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
    state.metricsSidebarVisible = body.visible;

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
    const previous = getIntervalName(state.refreshIntervalMs);
    state.refreshIntervalMs = nextInterval;
    await syncWorker.runExclusive(() => savePersistedConfig(database, { refresh_interval_ms: nextInterval }));
    startRefreshScheduler();
    console.log(`Refresh interval changed: ${previous} -> ${interval} (${nextInterval}ms)`);

    return context.json({
      success: true,
      old_interval: previous,
      new_interval: interval,
      new_interval_ms: nextInterval,
      next_refresh_at: state.nextRefreshAt,
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

    state.manualRefreshEnabled = body.enabled;
    await syncWorker.runExclusive(() => savePersistedConfig(database, {
      manual_refresh_enabled: state.manualRefreshEnabled,
    }));
    console.log(`Manual refresh ${state.manualRefreshEnabled ? 'enabled' : 'disabled'}`);

    return context.json({
      success: true,
      manual_refresh_enabled: state.manualRefreshEnabled,
    });
  } catch (error: any) {
    console.error('Error updating manual refresh setting:', error.message);
    return context.json({ error: 'Failed to update manual refresh setting' }, 500);
  }
});

app.post(`${config.basePath}/api/cache/refresh`, ensureAuth, async (context) => {
  if (!state.manualRefreshEnabled) {
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
  if (state.cacheRefreshPromise || state.initializationPromise || state.bootstrapPromise) {
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
    return context.json({ success: true, mode: body.mode, completed_at: state.cacheRefreshCompletedAt });
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
    const results = await Promise.all(targets.map(async (instance: RuntimeConfig['instances'][number]) => {
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
    auditLog.record(context, {
      action: 'cleanup.by-ip',
      ip,
      instances: results.map((result) => result.instance_name),
      deleted_alerts: results.reduce((total, entry) => total + ('result' in entry && entry.result ? entry.result.deleted_alerts : 0), 0),
      deleted_decisions: results.reduce((total, entry) => total + ('result' in entry && entry.result ? entry.result.deleted_decisions : 0), 0),
      outcome: auditOutcome(succeeded, results.length - succeeded),
    });
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
    state.cache.isInitialized = false;
    state.cache.isComplete = false;
    state.cache.lastUpdate = null;
    for (const instance of config.instances) {
      state.initialHistorySyncs.add(instance.id);
      state.instanceLastUpdates.set(instance.id, null);
    }
    state.cacheRefreshCompletedAt = null;
    state.staleDashboardStatsResponseCache.clear();
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

app.get(`${config.basePath}/api/stats/alerts`, ensureAuth, ensurePublishedRevisionRead, async (context) => {
  try {
    await prepareOnDemandRefresh(context);

    await prepareReadCache('stats alerts request');

    const where = createSqlWhere();
    where.add('created_at >= ?', new Date(Date.now() - config.lookbackMs).toISOString());
    if (!config.simulationsEnabled) {
      where.add('simulated = 0');
    }
    const alerts = (await analyticsQueryWorker.all<{
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
    `, where.params, { label: 'alert statistics' })).map((row): StatsAlert => ({
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

app.get(`${config.basePath}/api/stats/decisions`, ensureAuth, ensurePublishedRevisionRead, async (context) => {
  try {
    await prepareOnDemandRefresh(context);

    await prepareReadCache('stats decisions request');

    const now = new Date().toISOString();
    const where = createSqlWhere();
    where.add('(created_at >= ? OR stop_at > ?)', new Date(Date.now() - config.lookbackMs).toISOString(), now);
    if (!config.simulationsEnabled) {
      where.add('simulated = 0');
    }
    const decisions = (await analyticsQueryWorker.all<{
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
    `, where.params, { label: 'decision statistics' })).map((row): StatsDecision => ({
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

app.get(`${config.basePath}/api/dashboard/stats`, ensureAuth, ensurePublishedRevisionRead, async (context) => {
  try {
    await prepareOnDemandRefresh(context);

    await prepareReadCache('dashboard stats request');
    const filters = getDashboardStatsFilters(context, config.timeZone);
    noteDashboardStatsRequest(filters);
    state.lastDashboardStatsFilters = { ...filters };
    state.lastDashboardStatsRequestedAt = Date.now();
    const initialScopePending = filters.instanceId === 'all'
      ? state.historicalInstanceSyncPending.size > 0
      : state.historicalInstanceSyncPending.has(filters.instanceId);
    if (initialScopePending) {
      return context.json(createEmptyDashboardStatsResponse({ pending: true }));
    }
    if (isDashboardStatsBuildInProgress(filters)) {
      warmDashboardStatsCache(filters);
      const staleResponse = state.staleDashboardStatsResponseCache.get(getStaleDashboardStatsResponseCacheKey(filters));
      if (staleResponse) {
        return context.json({
          ...staleResponse,
          pending: true,
          stale: true,
          retryAfterMs: 1_500,
        });
      }
      return context.json(createEmptyDashboardStatsResponse({ pending: true }));
    }

    return context.json(await buildDashboardStats(filters, context.req.raw.signal));
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
    const results = await Promise.all(targets.map(async (instance: RuntimeConfig['instances'][number]) => {
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
    auditLog.record(context, {
      action: 'decision.add',
      ip,
      type,
      duration,
      reason: reason.slice(0, 256),
      instances: results.map((result) => result.instance_name),
      outcome: auditOutcome(succeeded, results.length - succeeded),
    });
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
      const auditValues = capAuditEntries(resolveDecisionValues(validated));
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
      const decisionIds = capAuditEntries(validated.map((ref: InstanceEntityRef) => `${ref.instance_id}:${ref.id}`));
      auditLog.record(context, {
        action: 'decision.delete',
        decision_ids: decisionIds.entries,
        ...(auditValues.entries.length > 0 ? { values: auditValues.entries } : {}),
        ...(decisionIds.truncated || auditValues.truncated ? { truncated: true } : {}),
        requested_decisions: result.requested_decisions,
        deleted_decisions: result.deleted_decisions,
        outcome: auditOutcome(result.deleted_decisions, result.failed.length),
      });
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

    const auditValues = capAuditEntries(resolveDecisionValues(ids.map((id: string) => ({ id }))));
    const result = await deleteDecisionsByIdsInChunks(ids);
    const decisionIds = capAuditEntries(ids);
    auditLog.record(context, {
      action: 'decision.delete',
      decision_ids: decisionIds.entries,
      ...(auditValues.entries.length > 0 ? { values: auditValues.entries } : {}),
      ...(decisionIds.truncated || auditValues.truncated ? { truncated: true } : {}),
      requested_decisions: result.requested_decisions,
      deleted_decisions: result.deleted_decisions,
      outcome: auditOutcome(result.deleted_decisions, result.failed.length),
    });
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
    const values = resolveDecisionValues([{ id: decisionId }]);
    const result = await deleteDecisionFromLapi(decisionId);
    console.log(`Removing decision ${decisionId} from local cache...`);
    await syncWorker.runExclusive(() => {
      database.deleteDecision(decisionId);
      database.refreshDecisionDuplicateFlags(new Date().toISOString());
    });
    invalidateDashboardStatsCache();
    auditLog.record(context, {
      action: 'decision.delete',
      decision_ids: [decisionId],
      ...(values.length > 0 ? { values } : {}),
      outcome: 'success',
    });
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


}
