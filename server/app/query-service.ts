import type {
  AlertDecision,
  AlertDecisionSummary,
  AlertRecord,
  DashboardStatsResponse,
  DashboardStatsTotals,
  DecisionListItem,
  FacetResponse,
  PaginatedResponse,
  SlimAlert,
} from '../../shared/contracts';
import type { SearchNode } from '../../shared/search';
import type { RuntimeConfig } from '../config';
import type { AttackLocationResolver } from '../attack-location-geocoder';
import type { CrowdsecDatabase } from '../database';
import type { NormalizedAlertRow, NormalizedDecisionRow } from '../normalized-record';
import type { DatabaseQueryWorker } from '../query-worker-client';
import type {
  AlertListFilters,
  DashboardAlertStatsRecord,
  DashboardDecisionStatsRecord,
  DashboardStatsCache,
  DashboardStatsFilters,
  DecisionListFilters,
  FacetRequest,
  PageRequest,
} from './types';
import type { SqlCondition, SqlWhere } from './search-sql';

export interface QueryServiceState extends Record<string, any> {
  facetCacheVersion: number;
  dashboardStatsCacheVersion: number;
  dashboardStatsResponseVersion: number;
  cacheRefreshCompletedAt: string | null;
  lastDashboardStatsFilters: DashboardStatsFilters | null;
  lastDashboardStatsRequestedAt: number;
  refreshIntervalMs: number;
}

export interface QueryServiceDependencies extends Record<string, any> {
  config: RuntimeConfig;
  database: CrowdsecDatabase;
  queryWorker: DatabaseQueryWorker;
  analyticsQueryWorker: DatabaseQueryWorker;
  facetQueryWorker: DatabaseQueryWorker;
  attackLocationResolver: AttackLocationResolver;
  compileSearchNodeSql: typeof import('./search-sql').compileSearchNodeSql;
  dashboardAttackLocationData: typeof import('../dashboard-locations').dashboardAttackLocationData;
  decisionFromRow: typeof import('../normalized-record').decisionFromRow;
  state: QueryServiceState;
}

export function createQueryService(dependencies: QueryServiceDependencies) {
  const state = dependencies.state;
  const {
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
    compileSearchNodeSql,
    compileAlertSearch,
    compileDecisionSearch,
    config,
    createDashboardDecisionAccumulator,
    createDashboardStatsAccumulator,
    createSqlWhere,
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
  } = dependencies;

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
  clone.decisions = normalizedDecisions.map((decision: AlertDecision) => hydrateDecisionForAlert(decision, clone));

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
  const filteredCountIndexHint = getAlertCountIndexHint(filters, searchAst);
  const [unfilteredTotal, total, rows] = await Promise.all([
    queryCount('alerts', baseWhere),
    queryCount('alerts', filteredWhere, filteredCountIndexHint),
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
  const now = new Date().toISOString();
  const query = buildDecisionListQuery(filters, searchAst, includeExpired, now);

  const offset = (pageRequest.page - 1) * pageRequest.pageSize;
  const [unfilteredTotal, total, rows] = await Promise.all([
    queryCount('decisions', query.baseWhere),
    queryDecisionListCount(query),
    queryWorker.all<NormalizedDecisionRow & {
      is_duplicate?: number;
      latitude?: number | null;
      longitude?: number | null;
    }>(`
      ${query.cteSql}
      SELECT ${DECISION_RECORD_COLUMNS}, ${query.dynamicDedup ? '0' : '(is_duplicate = 1)'} AS is_duplicate,
        (SELECT latitude FROM alerts WHERE alerts.id = decisions.alert_id) AS latitude,
        (SELECT longitude FROM alerts WHERE alerts.id = decisions.alert_id) AS longitude
      FROM ${query.fromSql}
      ${query.outerWhereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `, [...query.params, pageRequest.pageSize, offset]),
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

function buildDecisionListQuery(
  filters: DecisionListFilters,
  searchAst: SearchNode | null,
  includeExpired: boolean,
  now: string,
): {
  baseWhere: SqlWhere;
  cteSql: string;
  fromSql: string;
  outerWhereSql: string;
  params: unknown[];
  dynamicDedup: boolean;
} {
  const since = new Date(Date.now() - config.lookbackMs).toISOString();
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

  const dynamicDedup = !filters.showDuplicates && decisionFiltersCanSplitDuplicateGroup(filters, searchAst);
  const filteredWhere = baseWhere.clone();
  addDecisionSqlFilters(filteredWhere, filters, !dynamicDedup);
  const searchWhere = compileDecisionSearchSql(searchAst, filters, now);
  if (searchWhere) {
    filteredWhere.add(searchWhere.sql, ...searchWhere.params);
  }

  if (!dynamicDedup) {
    return {
      baseWhere,
      cteSql: '',
      fromSql: `decisions AS decisions ${getDecisionPageIndexHint(filters, searchAst)}`.trim(),
      outerWhereSql: filteredWhere.toSql(),
      params: filteredWhere.params,
      dynamicDedup: false,
    };
  }

  return {
    baseWhere,
    cteSql: `
      WITH ranked_filtered_decisions AS (
        SELECT decisions.*,
          CASE
            WHEN stop_at <= ? THEN 1
            ELSE ROW_NUMBER() OVER (
              PARTITION BY instance_id, value, simulated
              ORDER BY
                stop_at DESC,
                CASE WHEN id GLOB '[0-9]*' THEN CAST(id AS INTEGER) ELSE -1 END DESC,
                id DESC
            )
          END AS filtered_duplicate_rank
        FROM decisions
        ${filteredWhere.toSql()}
      )
    `,
    fromSql: 'ranked_filtered_decisions AS decisions',
    outerWhereSql: 'WHERE filtered_duplicate_rank = 1',
    params: [now, ...filteredWhere.params],
    dynamicDedup: true,
  };
}

function decisionFiltersCanSplitDuplicateGroup(
  filters: DecisionListFilters,
  searchAst: SearchNode | null,
): boolean {
  return Boolean(
    searchAst
    || filters.alertId
    || filters.country
    || filters.scenario
    || filters.as
    || filters.ip
    || filters.target
    || filters.dateStart
    || filters.dateEnd
  );
}

async function queryDecisionListCount(query: {
  cteSql: string;
  fromSql: string;
  outerWhereSql: string;
  params: unknown[];
}): Promise<number> {
  const row = await queryWorker.get<{ count: number }>(`
    ${query.cteSql}
    SELECT COUNT(*) AS count
    FROM ${query.fromSql}
    ${query.outerWhereSql}
  `, query.params);
  return row.count;
}

async function queryDashboardFilteredListTotals(
  filters: DashboardStatsFilters,
  alertSearchAst: SearchNode | null,
  decisionSearchAst: SearchNode | null,
): Promise<{
  alerts: number;
  decisions: number;
  simulatedAlerts: number;
  simulatedDecisions: number;
}> {
  const alertFilters: AlertListFilters = {
    instanceId: filters.instanceId,
    q: filters.q,
    ip: filters.ip,
    country: filters.country,
    scenario: filters.scenario,
    as: filters.as,
    date: '',
    dateStart: filters.dateStart,
    dateEnd: filters.dateEnd,
    target: filters.target,
    simulation: filters.simulation,
    timezoneOffsetMinutes: filters.timezoneOffsetMinutes,
    timeZone: filters.timeZone,
  };
  const decisionFilters: DecisionListFilters = {
    instanceId: filters.instanceId,
    q: filters.decisionQ,
    alertId: '',
    country: filters.country,
    scenario: filters.scenario,
    as: filters.as,
    ip: filters.ip,
    target: filters.target,
    dateStart: filters.dateStart,
    dateEnd: filters.dateEnd,
    simulation: filters.simulation,
    showDuplicates: false,
    timezoneOffsetMinutes: filters.timezoneOffsetMinutes,
    timeZone: filters.timeZone,
  };

  const alertWhere = createSqlWhere();
  alertWhere.add('created_at >= ?', new Date(Date.now() - config.lookbackMs).toISOString());
  if (filters.instanceId !== 'all') {
    alertWhere.add('instance_id = ?', filters.instanceId);
  } else {
    alertWhere.add(`instance_id IN (${config.instances.map(() => '?').join(',')})`, ...config.instances.map((instance) => instance.id));
  }
  if (!config.simulationsEnabled) {
    alertWhere.add('simulated = 0');
  }
  addAlertSqlFilters(alertWhere, alertFilters);
  const alertSearchWhere = compileAlertSearchSql(alertSearchAst, alertFilters);
  if (alertSearchWhere) {
    alertWhere.add(alertSearchWhere.sql, ...alertSearchWhere.params);
  }

  const decisionQuery = buildDecisionListQuery(
    decisionFilters,
    decisionSearchAst,
    false,
    new Date().toISOString(),
  );
  const [alertRows, decisionRows] = await Promise.all([
    analyticsQueryWorker.all<{ simulated: number; count: number }>(`
      SELECT simulated, COUNT(*) AS count
      FROM alerts ${getAlertCountIndexHint(alertFilters, alertSearchAst)}
      ${alertWhere.toSql()}
      GROUP BY simulated
    `, alertWhere.params, { label: 'dashboard alert totals' }),
    analyticsQueryWorker.all<{ simulated: number; count: number }>(`
      ${decisionQuery.cteSql}
      SELECT simulated, COUNT(*) AS count
      FROM ${decisionQuery.fromSql}
      ${decisionQuery.outerWhereSql}
      GROUP BY simulated
    `, decisionQuery.params, { label: 'dashboard decision totals' }),
  ]);

  const alerts = alertRows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const simulatedAlerts = alertRows
    .filter((row) => row.simulated === 1)
    .reduce((sum, row) => sum + Number(row.count || 0), 0);
  const decisions = decisionRows
    .filter((row) => row.simulated !== 1)
    .reduce((sum, row) => sum + Number(row.count || 0), 0);
  const simulatedDecisions = decisionRows
    .filter((row) => row.simulated === 1)
    .reduce((sum, row) => sum + Number(row.count || 0), 0);

  return { alerts, decisions, simulatedAlerts, simulatedDecisions };
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
    machine: normalizedMachineIdSql('machine_id', 'machine'),
    origin: "COALESCE(TRIM(origins), '')",
  } as Record<string, string>)[request.field];
  const instanceLabel = request.field === 'instance'
    ? buildInstanceFacetLabelSql('instance_id', config.instances)
    : null;
  const labelDefinition = request.field === 'country'
    ? {
      sql: "COALESCE(NULLIF(TRIM(country_name), ''), COALESCE(TRIM(country), ''))",
      params: [] as unknown[],
    }
    : request.field === 'machine'
      ? {
        sql: "COALESCE(NULLIF(TRIM(machine), ''), COALESCE(TRIM(machine_id), ''))",
        params: [] as unknown[],
      }
      : instanceLabel;
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
          SELECT 'active' AS value, 'active' AS label
          FROM filtered_alerts
          WHERE EXISTS (
              SELECT 1 FROM decisions facet_decision
              WHERE facet_decision.alert_id = filtered_alerts.id
                AND facet_decision.stop_at > ?${simulationSql}
            )
          UNION ALL
          SELECT 'expired' AS value, 'expired' AS label
          FROM filtered_alerts
          WHERE EXISTS (
              SELECT 1 FROM decisions facet_decision
              WHERE facet_decision.alert_id = filtered_alerts.id
                AND facet_decision.stop_at <= ?${simulationSql}
            )
          UNION ALL
          SELECT '' AS value, '' AS label
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
  if (request.field === 'origin') {
    const simulationSql = config.simulationsEnabled ? '' : ' AND facet_decision.simulated = 0';
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
          ),
          distinct_origins AS (
            SELECT DISTINCT filtered_alerts.id AS alert_id, TRIM(facet_decision.origin) AS value
            FROM filtered_alerts
            INNER JOIN decisions AS facet_decision
              ON facet_decision.alert_id = filtered_alerts.id
            WHERE COALESCE(TRIM(facet_decision.origin), '') <> ''${simulationSql}
          )
          SELECT value, value AS label
          FROM distinct_origins
          UNION ALL
          SELECT '' AS value, '' AS label
          FROM filtered_alerts
          WHERE NOT EXISTS (
            SELECT 1
            FROM decisions AS facet_decision
            WHERE facet_decision.alert_id = filtered_alerts.id
              AND COALESCE(TRIM(facet_decision.origin), '') <> ''${simulationSql}
          )
        `,
        params: filteredWhere.params,
      },
    );
    setCachedFacetResponse(cacheKey, response);
    return response;
  }
  if (request.field === 'target') {
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
            SELECT id, target, extra_data
            FROM alerts
            ${filteredWhere.toSql()}
          ),
          distinct_targets AS (
            SELECT DISTINCT filtered_alerts.id AS alert_id,
              COALESCE(TRIM(CAST(target_value.value AS TEXT)), '') AS value
            FROM filtered_alerts
            INNER JOIN json_each(${jsonStringArraySql('filtered_alerts.extra_data', 'targets', 'filtered_alerts.target')}) AS target_value
          )
          SELECT value, value AS label
          FROM distinct_targets
        `,
        params: filteredWhere.params,
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
    undefined,
    labelDefinition || undefined,
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

  const now = new Date().toISOString();
  const decisionQuery = buildDecisionListQuery(
    effectiveFilters,
    prunedSearchAst,
    effectiveIncludeExpired,
    now,
  );

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
        machine: decisionMachineIdSql('extra_data', 'machine'),
        origin: "COALESCE(TRIM(origin), '')",
      } as Record<string, string>)[request.field],
      params: [],
    };
  if (!valueDefinition.sql) throw new Error(`Unsupported decision facet field: ${request.field}`);

  const instanceLabel = request.field === 'instance'
    ? buildInstanceFacetLabelSql('instance_id', config.instances)
    : null;
  const labelDefinition = request.field === 'country'
    ? {
      sql: "COALESCE(NULLIF(TRIM(country_name), ''), COALESCE(TRIM(country), ''))",
      params: [] as unknown[],
    }
    : request.field === 'machine'
      ? {
        sql: decisionMachineLabelSql('extra_data', 'machine'),
        params: [] as unknown[],
      }
      : instanceLabel;

  if (request.field === 'target') {
    const response = await queryFacetValues(
      'decisions',
      "''",
      [],
      createSqlWhere(),
      request,
      searchAst,
      {
        prefixSql: decisionQuery.cteSql,
        sql: `
          WITH filtered_decisions AS (
            SELECT id, target, extra_data
            FROM ${decisionQuery.fromSql}
            ${decisionQuery.outerWhereSql}
          ),
          distinct_targets AS (
            SELECT DISTINCT filtered_decisions.id AS decision_id,
              COALESCE(TRIM(CAST(target_value.value AS TEXT)), '') AS value
            FROM filtered_decisions
            INNER JOIN json_each(${jsonStringArraySql('filtered_decisions.extra_data', 'targets', 'filtered_decisions.target')}) AS target_value
          )
          SELECT value, value AS label
          FROM distinct_targets
        `,
        params: decisionQuery.params,
      },
    );
    setCachedFacetResponse(cacheKey, response);
    return response;
  }

  const response = await queryFacetValues(
    'decisions',
    valueDefinition.sql,
    valueDefinition.params,
    createSqlWhere(),
    request,
    searchAst,
    {
      prefixSql: decisionQuery.cteSql,
      sql: labelDefinition
        ? `
          SELECT ${valueDefinition.sql} AS value, ${labelDefinition.sql} AS label
          FROM ${decisionQuery.fromSql}
          ${decisionQuery.outerWhereSql}
        `
        : `
          SELECT value, value AS label
          FROM (
            SELECT ${valueDefinition.sql} AS value
            FROM ${decisionQuery.fromSql}
            ${decisionQuery.outerWhereSql}
          )
        `,
      params: decisionQuery.cteSql
        ? [
          ...decisionQuery.params,
          ...valueDefinition.params,
          ...(labelDefinition?.params || []),
        ]
        : [
          ...valueDefinition.params,
          ...(labelDefinition?.params || []),
          ...decisionQuery.params,
        ],
    },
    labelDefinition || undefined,
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
  facetRows?: { prefixSql?: string; sql: string; params: unknown[] },
  labelDefinition?: { sql: string; params: unknown[] },
): Promise<FacetResponse> {
  const selection = getSearchFacetSelection(originalSearchAst, request.field);
  const selectedValues = [...new Set([...selection.included, ...selection.excluded])]
    .slice(0, FACET_MAX_LIMIT);
  const outerClauses: string[] = [];
  const outerParams: unknown[] = [];
  const selectedPlaceholders = selectedValues.map(() => '?').join(', ');

  if (request.search || request.searchValues.length > 0) {
    const searchClauses: string[] = [];
    const searchParams: unknown[] = [];
    if (request.search) {
      searchClauses.push("LOWER(value) LIKE ? ESCAPE '\\'", "LOWER(label) LIKE ? ESCAPE '\\'");
      searchParams.push(likeParam(request.search), likeParam(request.search));
    }
    if (request.searchValues.length > 0) {
      searchClauses.push(`value IN (${request.searchValues.map(() => '?').join(', ')})`);
      searchParams.push(...request.searchValues);
    }
    const searchClause = `(${searchClauses.join(' OR ')})`;
    if (selectedValues.length > 0) {
      outerClauses.push(`(${searchClause}
        OR value IN (${selectedPlaceholders})
        OR label IN (${selectedPlaceholders}))`);
      outerParams.push(...searchParams, ...selectedValues, ...selectedValues);
    } else {
      outerClauses.push(searchClause);
      outerParams.push(...searchParams);
    }
  }

  const selectedOrderSql = selectedValues.length > 0
    ? `CASE
      WHEN value IN (${selectedPlaceholders}) OR label IN (${selectedPlaceholders}) THEN 0
      ELSE 1
    END, `
    : '';
  const facetRowsCte = facetRows
    ? `facet_rows(value, label) AS (
      ${facetRows.sql}
    )`
    : labelDefinition
      ? `facet_rows(value, label) AS (
        SELECT ${valueSql}
          AS value, ${labelDefinition.sql} AS label
        FROM ${tableName}
        ${where.toSql()}
      )`
      : `facet_values(value) AS (
        SELECT ${valueSql}
        FROM ${tableName}
        ${where.toSql()}
      ),
      facet_rows(value, label) AS (
        SELECT value, value AS label
        FROM facet_values
      )`;
  const rows = await facetQueryWorker.all<{ value: string | null; label: string | null; count: number }>(`
    ${facetRows?.prefixSql
      ? `${facetRows.prefixSql.trim()}, ${facetRowsCte}`
      : `WITH ${facetRowsCte}`}
    SELECT value, MAX(label) AS label, COUNT(*) AS count
    FROM facet_rows
    ${outerClauses.length > 0 ? `WHERE ${outerClauses.join(' AND ')}` : ''}
    GROUP BY value
    ORDER BY ${selectedOrderSql}count DESC, label COLLATE NOCASE ASC, value COLLATE NOCASE ASC
    LIMIT ? OFFSET ?
  `, [
    ...(facetRows?.params ?? [
      ...valueParams,
      ...(labelDefinition?.params || []),
      ...where.params,
    ]),
    ...outerParams,
    ...(selectedValues.length > 0 ? [...selectedValues, ...selectedValues] : []),
    request.limit + 1,
    request.offset,
  ]);

  return {
    field: request.field,
    values: rows.slice(0, request.limit).map((row) => ({
      value: row.value || '',
      ...((row.label || '') !== (row.value || '') ? { label: row.label || '' } : {}),
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
    version: state.facetCacheVersion,
    page,
    request,
    filters,
    query: serializeSearchNode(searchAst),
    ...extra,
  });
}

function getCachedFacetResponse(key: string): FacetResponse | null {
  const cached = state.facetResponseCache.get(key);
  if (!cached) return null;
  state.facetResponseCache.delete(key);
  state.facetResponseCache.set(key, cached);
  return cached;
}

function setCachedFacetResponse(key: string, response: FacetResponse): void {
  state.facetResponseCache.delete(key);
  state.facetResponseCache.set(key, response);
  while (state.facetResponseCache.size > FACET_CACHE_MAX_ENTRIES) {
    const oldestKey = state.facetResponseCache.keys().next().value;
    if (oldestKey) state.facetResponseCache.delete(oldestKey);
    else break;
  }
}

async function queryCount(
  tableName: 'alerts' | 'decisions',
  where: SqlWhere,
  indexHint: '' | 'INDEXED BY idx_alerts_filters' = '',
): Promise<number> {
  const row = await queryWorker.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM ${tableName} ${indexHint} ${where.toSql()}`,
    where.params,
  );
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
  if (dateStart) {
    const parsedStart = parseSqlSearchDateValue(dateStart, { timezoneOffsetMinutes, timeZone });
    where.add(
      `${column} >= ?`,
      new Date(parsedStart?.start ?? getDateFilterBoundary(
        dateStart,
        timezoneOffsetMinutes,
        timeZone,
        dateStart.includes('T'),
      ).getTime()).toISOString(),
    );
  }
  if (dateEnd) {
    const parsedEnd = parseSqlSearchDateValue(dateEnd, { timezoneOffsetMinutes, timeZone });
    if (parsedEnd && parsedEnd.precision !== 'instant') {
      where.add(`${column} < ?`, new Date(parsedEnd.end).toISOString());
    } else {
      where.add(
        `${column} <= ?`,
        new Date(parsedEnd?.end ?? getDateFilterBoundary(
          dateEnd,
          timezoneOffsetMinutes,
          timeZone,
          dateEnd.includes('T'),
        ).getTime()).toISOString(),
      );
    }
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
  const cached = state.dashboardStatsCaches.get(cacheKey);
  if (cached) {
    state.dashboardStatsCaches.delete(cacheKey);
    state.dashboardStatsCaches.set(cacheKey, cached);
    return cached;
  }

  const pending = state.dashboardStatsIndexPromises.get(cacheKey);
  if (pending) {
    return pending;
  }

  const promise = buildDashboardStatsIndex(cacheKey, instanceId).finally(() => {
    state.dashboardStatsIndexPromises.delete(cacheKey);
  });
  state.dashboardStatsIndexPromises.set(cacheKey, promise);
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
    const alertRows = await analyticsQueryWorker.all<{
    id: string;
    internal_id: number;
    instance_id: string;
    created_at: string;
    country?: string | null;
    region?: string | null;
    city?: string | null;
    scenario?: string | null;
    as_name?: string | null;
    source_ip?: string | null;
    source_value?: string | null;
    source_range?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    target?: string | null;
    machine_id?: string | null;
    machine_alias?: string | null;
    machine?: string | null;
    extra_data?: string | null;
    origins?: string | null;
    simulated?: number | null;
  }>(`
    SELECT COALESCE(upstream_id, CAST(id AS TEXT)) AS id, id AS internal_id,
      instance_id, created_at, country, region, city, scenario, as_name,
      source_ip, source_value, source_range, latitude, longitude, target,
      machine_id, machine_alias, machine, origins, simulated, extra_data
    FROM alerts
    ${batchWhere.toSql()}
    ORDER BY alerts.id ASC
    LIMIT ?
  `, [...batchWhere.params, DASHBOARD_INDEX_BATCH_SIZE], { label: 'dashboard alert index' });
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
        id: row.id,
        instanceId: row.instance_id,
        createdAt,
        timestamp,
        country: row.country || undefined,
        region: row.region || undefined,
        city: row.city || undefined,
        scenario: row.scenario || undefined,
        asName: row.as_name || undefined,
        ip: row.source_ip || undefined,
        sourceValue: row.source_value || undefined,
        sourceRange: row.source_range || undefined,
        latitude: normalizeDashboardCoordinate(row.latitude, -90, 90),
        longitude: normalizeDashboardCoordinate(row.longitude, -180, 180),
        target: row.target || undefined,
        targets: readExtraStringArray(row.extra_data, 'targets', row.target),
        machine: row.machine || undefined,
        machineId: row.machine_id || undefined,
        machineAlias: row.machine_alias || undefined,
        origins: row.origins?.split(/\s+/).filter(Boolean),
        simulated,
      });
    }

    lastAlertId = Number(alertRows[alertRows.length - 1]?.internal_id || lastAlertId);
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
    const decisionRows = await analyticsQueryWorker.all<{
    rowid: number;
    upstream_id?: string | null;
    instance_id: string;
    alert_upstream_id?: string | null;
    created_at: string;
    stop_at?: string | null;
    value?: string | null;
    country?: string | null;
    region?: string | null;
    city?: string | null;
    scenario?: string | null;
    as_name?: string | null;
    target?: string | null;
    type?: string | null;
    origin?: string | null;
    machine?: string | null;
    extra_data?: string | null;
    duration?: string | null;
    is_duplicate?: number | null;
    simulated?: number | null;
  }>(`
    SELECT rowid, COALESCE(upstream_id, CAST(id AS TEXT)) AS upstream_id,
      instance_id, alert_upstream_id, created_at, stop_at, value, country,
      region, city, scenario, as_name, target, type, origin, machine, duration,
      is_duplicate, simulated, extra_data
    FROM decisions NOT INDEXED
    ${batchWhere.toSql()}
    ORDER BY rowid ASC
    LIMIT ?
  `, [...batchWhere.params, DASHBOARD_INDEX_BATCH_SIZE], { label: 'dashboard decision index' });
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
        id: row.upstream_id || row.rowid,
        instanceId: row.instance_id,
        alertId: row.alert_upstream_id || undefined,
        createdAt,
        stopAt,
        timestamp,
        stopTimestamp: normalizedStopTimestamp,
        value: row.value || undefined,
        country: row.country || undefined,
        region: row.region || undefined,
        city: row.city || undefined,
        scenario: row.scenario || undefined,
        asName: row.as_name || undefined,
        target: row.target || undefined,
        targets: readExtraStringArray(row.extra_data, 'targets', row.target),
        type: row.type || undefined,
        origin: row.origin || undefined,
        machine: row.machine || undefined,
        machineId: readExtraString(row.extra_data, 'machine_id'),
        machineAlias: readExtraString(row.extra_data, 'machine_alias'),
        duration: row.duration || undefined,
        isDuplicate: row.is_duplicate === 1,
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
    state.dashboardStatsCaches.set(cacheKey, statsCache);
    while (state.dashboardStatsCaches.size > Math.max(4, config.instances.length + 1)) {
      const oldest = state.dashboardStatsCaches.keys().next().value;
      if (oldest) state.dashboardStatsCaches.delete(oldest);
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
    const cachedResponse = state.dashboardStatsResponseCache.get(responseCacheKey);
    const cachedResponseValidUntil = state.dashboardStatsResponseValidUntil.get(responseCacheKey) || 0;
    if (cachedResponse && cachedResponseValidUntil > Date.now()) {
      if (statsIndex.key === getDashboardStatsCacheKey(filters.instanceId)) return cachedResponse;
      continue;
    }
    state.dashboardStatsResponseCache.delete(responseCacheKey);
    state.dashboardStatsResponseValidUntil.delete(responseCacheKey);

    const pending = state.dashboardStatsResponsePromises.get(responseCacheKey);
    if (pending) {
      const response = await pending;
      if (statsIndex.key === getDashboardStatsCacheKey(filters.instanceId)) return response;
      continue;
    }

    const promise = buildDashboardStatsResponse(statsIndex, filters, responseCacheKey).finally(() => {
      state.dashboardStatsResponsePromises.delete(responseCacheKey);
    });
    state.dashboardStatsResponsePromises.set(responseCacheKey, promise);
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
  if (!state.dashboardStatsCaches.has(indexKey)) {
    return state.dashboardStatsIndexPromises.has(indexKey);
  }

  return state.dashboardStatsResponsePromises.has(getDashboardStatsResponseCacheKey(indexKey, filters));
}

function warmDashboardStatsCache(filters: DashboardStatsFilters): void {
  const warmingKey = getDashboardStatsCacheKey(filters.instanceId);
  void buildDashboardStats(filters).then(() => {
    if (
      warmingKey !== getDashboardStatsCacheKey(filters.instanceId) ||
      state.dashboardStatsReadyPublishedKeys.has(warmingKey) ||
      !state.cacheRefreshCompletedAt
    ) {
      return;
    }

    // A cold dashboard request initially receives the previous response with
    // pending=true. Notify clients again when the new index and response are
    // read-visible so a superseded retry cannot leave the page stale.
    state.dashboardStatsReadyPublishedKeys.add(warmingKey);
    publishCacheUpdate(state.cacheRefreshCompletedAt);
  }).catch((error: any) => {
    console.error('Failed to warm dashboard statistics cache:', error.message);
  });
}

async function prepareDashboardStatsAfterRefresh(
  dataChanged: boolean,
  instanceId?: string,
): Promise<boolean> {
  if (dataChanged) {
    // Preserve the last complete response while the new analytics generation
    // warms. Dashboard requests mark it pending, while list endpoints can
    // immediately read the newly committed SQLite revision.
    invalidateDashboardStatsCache(instanceId, { preserveStale: true });
  } else {
    invalidateFacetResponses();
    if (!state.lastDashboardStatsFilters) return false;
    if (
      instanceId
      && state.lastDashboardStatsFilters.instanceId !== 'all'
      && state.lastDashboardStatsFilters.instanceId !== instanceId
    ) {
      return false;
    }
    const indexKey = getDashboardStatsCacheKey(state.lastDashboardStatsFilters.instanceId);
    const responseKey = getDashboardStatsResponseCacheKey(indexKey, state.lastDashboardStatsFilters);
    if (
      state.dashboardStatsResponseCache.has(responseKey)
      && (state.dashboardStatsResponseValidUntil.get(responseKey) || 0) > Date.now()
    ) {
      return false;
    }
    // Time-dependent decision state can change without a SQLite mutation.
    // Keep the expensive row index and rebuild only cached responses so the
    // dashboard and list endpoints use the same current timestamp semantics.
    invalidateDashboardStatsResponses({ preserveStale: true, invalidateFacets: false });
  }
  if (!state.lastDashboardStatsFilters) return false;
  if (
    instanceId
    && state.lastDashboardStatsFilters.instanceId !== 'all'
    && state.lastDashboardStatsFilters.instanceId !== instanceId
  ) {
    return false;
  }
  // A dashboard visit used to make every future refresh rebuild the entire
  // dashboard index, even after the user moved to Alerts or Decisions. Keep
  // eager preparation only while dashboard requests are still active. An
  // inactive dashboard builds synchronously from the published database
  // revision on its next request, so it cannot expose a mixed revision.
  const dashboardActivityWindowMs = Math.max(10_000, state.refreshIntervalMs * 2);
  if (Date.now() - state.lastDashboardStatsRequestedAt > dashboardActivityWindowMs) {
    return false;
  }
  // Build the shared row index first. The user may change dashboard filters
  // while a large post-refresh index is being assembled; in that case only
  // prepare the latest requested response instead of finishing an obsolete
  // filter and then scanning the same rows again.
  const indexFilters = { ...state.lastDashboardStatsFilters };
  await getDashboardStatsIndex(indexFilters.instanceId);
  const responseFilters = state.lastDashboardStatsFilters;
  if (
    instanceId
    && responseFilters.instanceId !== 'all'
    && responseFilters.instanceId !== instanceId
  ) {
    return true;
  }
  await buildDashboardStats(responseFilters);
  return true;
}

function prepareDashboardStatsAfterRefreshInBackground(
  dataChanged: boolean,
  instanceId: string | undefined,
  refreshLabel: string,
  onPrepared?: () => void,
): void {
  const startedAt = Date.now();
  // Cache invalidation happens synchronously before the first await in
  // prepareDashboardStatsAfterRefresh. The publication writer can therefore
  // be released as soon as this function returns; only the expensive warm-up
  // continues in the background.
  void prepareDashboardStatsAfterRefresh(dataChanged, instanceId).then((prepared) => {
    if (!prepared) return;
    console.log(`Dashboard statistics prepared in ${formatElapsedTime(Date.now() - startedAt)}.`);
    onPrepared?.();
  }).catch((error: any) => {
    // Dashboard requests retain their normal lazy-build fallback if cache
    // preparation fails; a reporting-cache failure must not lose a valid
    // LAPI delta or prevent the next refresh from running.
    console.error(`Failed to prepare dashboard statistics after ${refreshLabel}:`, error.message);
  });
}

async function buildDashboardStatsResponse(
  statsIndex: DashboardStatsCache,
  filters: DashboardStatsFilters,
  responseCacheKey: string,
): Promise<DashboardStatsResponse> {
  const nowTimestamp = Date.now();
  let responseValidUntil = nowTimestamp + 60 * 60_000;
  const lookbackDays = Math.max(1, Math.round(lookbackHours(config.lookbackPeriod) / 24));
  const includeTimeBoundary = (timestamp: number) => {
    if (timestamp > nowTimestamp && timestamp < responseValidUntil) {
      responseValidUntil = timestamp;
    }
  };
  const instanceNameById = new Map(
    config.instances.map((instance) => [instance.id, instance.name]),
  );
  const compiledDashboardSearch = compileAlertSearch(
    filters.q,
    { machineEnabled: true, originEnabled: true },
    {
      timezoneOffsetMinutes: filters.timezoneOffsetMinutes,
      timeZone: filters.timeZone,
    },
  );
  const compiledDashboardDecisionSearch = compileDecisionSearch(
    filters.decisionQ,
    { machineEnabled: true, originEnabled: true },
    {
      timezoneOffsetMinutes: filters.timezoneOffsetMinutes,
      timeZone: filters.timeZone,
    },
  );
  const dashboardSearchPredicate = compiledDashboardSearch.ok
    ? (alert: DashboardAlertStatsRecord) => compiledDashboardSearch.predicate({
      id: alert.id,
      instance_id: alert.instanceId,
      instance_name: instanceNameById.get(alert.instanceId),
      created_at: alert.createdAt,
      scenario: alert.scenario,
      machine_id: alert.machineId,
      machine_alias: alert.machineAlias || alert.machine,
      source: {
        ip: alert.ip,
        value: alert.sourceValue,
        range: alert.sourceRange,
        cn: alert.country,
        region: alert.region,
        city: alert.city,
        as_name: alert.asName,
      },
      target: alert.target,
      targets: alert.targets,
      meta_search: '',
      decisions: (alert.origins || []).map((origin, index) => ({
        id: index,
        origin,
      })),
      simulated: alert.simulated,
    })
    : null;
  const dashboardDecisionSearchPredicate = compiledDashboardDecisionSearch.ok
    ? (decision: DashboardDecisionStatsRecord) => compiledDashboardDecisionSearch.predicate({
      id: decision.id,
      instance_id: decision.instanceId,
      instance_name: instanceNameById.get(decision.instanceId),
      created_at: decision.createdAt,
      machine: decision.machine,
      machine_id: decision.machineId,
      machine_alias: decision.machineAlias,
      scenario: decision.scenario,
      value: decision.value,
      expired: decision.stopTimestamp <= nowTimestamp,
      is_duplicate: decision.isDuplicate,
      simulated: decision.simulated,
      detail: {
        origin: decision.origin || '',
        type: decision.type,
        reason: decision.scenario,
        action: decision.type,
        country: decision.country,
        city: decision.city,
        region: decision.region,
        as: decision.asName,
        duration: decision.duration,
        expiration: decision.stopAt,
        alert_id: decision.alertId,
        target: decision.target,
        targets: decision.targets,
        simulated: decision.simulated,
      },
    })
    : null;
  // Keep the database totals query concurrent with the in-memory chart
  // aggregation, but attach its rejection handler immediately. A slow
  // analytics worker used to let this promise reject while the dashboard
  // loops or location resolver were still running; Node then treated the
  // temporarily unhandled rejection as a fatal process error.
  const exactListTotalsResultPromise = queryDashboardFilteredListTotals(
    filters,
    compiledDashboardSearch.ok ? compiledDashboardSearch.ast : null,
    compiledDashboardDecisionSearch.ok ? compiledDashboardDecisionSearch.ast : null,
  ).then(
    (value) => ({ value, error: null as Error | null }),
    (error: unknown) => ({
      value: null,
      error: error instanceof Error ? error : new Error(String(error)),
    }),
  );

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
    includeTimeBoundary(alert.timestamp + config.lookbackMs);
    if (alert.ip && alert.country && alert.country !== 'Unknown') {
      alertCountryByIp.set(alert.ip, alert.country);
    }

    if (!matchesDashboardSimulationFilter(alert.simulated, filters.simulation)) {
      continue;
    }

    if (matchesDashboardAlertFilters(alert, filters, dashboardSearchPredicate, false)) {
      addDashboardAlert(sliderAlertAccumulator, alert, filters);
      if (alert.ip) {
        sliderAlertIps.add(alert.ip);
      }
    }

    if (matchesDashboardAlertFilters(alert, filters, dashboardSearchPredicate, true)) {
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
  const filteredActiveDecisionPrimaries = new Map<string, DashboardDecisionStatsRecord>();
  const sliderActiveDecisionPrimaries = new Map<string, DashboardDecisionStatsRecord>();
  let currentActiveDecisions = 0;
  let currentActiveSimulatedDecisions = 0;

  let globalTotal = 0;
  for (let index = 0; index < statsIndex.decisions.length; index += 1) {
    if (index > 0 && index % DASHBOARD_LOOP_YIELD_INTERVAL === 0) {
      await delay(0);
    }
    const decision = statsIndex.decisions[index];
    if (filters.instanceId !== 'all' && decision.instanceId !== filters.instanceId) continue;
    const isActive = decision.stopTimestamp > nowTimestamp;
    if (isActive) {
      includeTimeBoundary(decision.stopTimestamp);
    } else {
      includeTimeBoundary(decision.timestamp + config.lookbackMs);
    }
    if (isActive) {
      if (decision.simulated) {
        currentActiveSimulatedDecisions += 1;
      } else {
        currentActiveDecisions += 1;
      }
    }
    if (!matchesDashboardSimulationFilter(decision.simulated, filters.simulation)) {
      continue;
    }

    if (matchesDashboardDecisionFilters(
      decision,
      filters,
      dashboardDecisionSearchPredicate,
      sliderAlertIps,
      false,
    )) {
      if (isActive) {
        selectDashboardDecisionPrimary(sliderActiveDecisionPrimaries, decision);
      } else {
        addDashboardDecision(sliderDecisionAccumulator, decision, filters, false);
      }
    }

    if (
      matchesDashboardDecisionFilters(
        decision,
        filters,
        dashboardDecisionSearchPredicate,
        filteredAlertIps,
        true,
      )
    ) {
      if (isActive) {
        selectDashboardDecisionPrimary(filteredActiveDecisionPrimaries, decision);
      } else {
        addDashboardDecision(chartDecisionAccumulator, decision, filters, false);
        const country = normalizeDashboardCountryCode(decision.country)
          || (decision.value ? alertCountryByIp.get(decision.value) : undefined);
        addDashboardDecisionCountry(filteredDecisionAccumulator, decision, country, false);
      }
    }
  }
  for (const decision of sliderActiveDecisionPrimaries.values()) {
    addDashboardDecision(sliderDecisionAccumulator, decision, filters, true);
  }
  for (const decision of filteredActiveDecisionPrimaries.values()) {
    addDashboardDecision(chartDecisionAccumulator, decision, filters, true);
    const country = normalizeDashboardCountryCode(decision.country)
      || (decision.value ? alertCountryByIp.get(decision.value) : undefined);
    addDashboardDecisionCountry(filteredDecisionAccumulator, decision, country, true);
    if (decision.simulated) {
      filteredDecisionAccumulator.simulatedDecisions += 1;
    } else {
      filteredDecisionAccumulator.decisions += 1;
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
  const exactListTotalsResult = await exactListTotalsResultPromise;
  if (exactListTotalsResult.error) throw exactListTotalsResult.error;
  const exactListTotals = exactListTotalsResult.value!;

  const response: DashboardStatsResponse = {
    totals: {
      alerts: statsIndex.totals.alerts,
      decisions: currentActiveDecisions,
      simulatedAlerts: statsIndex.totals.simulatedAlerts,
      simulatedDecisions: currentActiveSimulatedDecisions,
    },
    filteredTotals: {
      alerts: exactListTotals.alerts,
      decisions: exactListTotals.decisions,
      simulatedAlerts: exactListTotals.simulatedAlerts,
      simulatedDecisions: exactListTotals.simulatedDecisions,
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

  if (
    statsIndex.key === getDashboardStatsCacheKey(filters.instanceId)
    && responseCacheKey === getDashboardStatsResponseCacheKey(statsIndex.key, filters)
  ) {
    state.dashboardStatsResponseCache.set(responseCacheKey, response);
    state.dashboardStatsResponseValidUntil.set(responseCacheKey, responseValidUntil);
    const staleCacheKey = getStaleDashboardStatsResponseCacheKey(filters);
    state.staleDashboardStatsResponseCache.set(staleCacheKey, response);
    if (state.dashboardStatsResponseCache.size > 50) {
      const firstKey = state.dashboardStatsResponseCache.keys().next().value;
      if (firstKey) {
        state.dashboardStatsResponseCache.delete(firstKey);
        state.dashboardStatsResponseValidUntil.delete(firstKey);
      }
    }
    if (state.staleDashboardStatsResponseCache.size > 50) {
      const firstKey = state.staleDashboardStatsResponseCache.keys().next().value;
      if (firstKey) {
        state.staleDashboardStatsResponseCache.delete(firstKey);
      }
    }
  }

  return response;
}

function getDashboardStatsCacheKey(instanceId = 'all'): string {
  const scopeVersion = state.dashboardStatsScopeVersions.get(instanceId) || 0;
  return `${state.dashboardStatsCacheVersion}:${scopeVersion}:${config.lookbackMs}:${config.simulationsEnabled ? 'sim' : 'live'}:${instanceId}`;
}

function invalidateFacetResponses(): void {
  state.facetResponseCache.clear();
  state.facetCacheVersion += 1;
}

function invalidateDashboardStatsResponses(
  options: { preserveStale?: boolean; invalidateFacets?: boolean } = {},
): void {
  if (options.invalidateFacets !== false) {
    invalidateFacetResponses();
  }
  state.dashboardStatsResponseCache.clear();
  state.dashboardStatsResponseValidUntil.clear();
  state.dashboardStatsReadyPublishedKeys.clear();
  state.dashboardStatsResponseVersion += 1;
  if (!options.preserveStale) {
    state.staleDashboardStatsResponseCache.clear();
  }
}

function invalidateDashboardStatsCache(
  instanceId?: string,
  options: { preserveStale?: boolean } = {},
): void {
  invalidateDashboardStatsResponses({ preserveStale: options.preserveStale });
  if (instanceId) {
    const affectedScopes = new Set([instanceId, 'all']);
    for (const scope of affectedScopes) {
      state.dashboardStatsScopeVersions.set(scope, (state.dashboardStatsScopeVersions.get(scope) || 0) + 1);
    }
    for (const [key, cached] of state.dashboardStatsCaches) {
      if (affectedScopes.has(cached.scope)) state.dashboardStatsCaches.delete(key);
    }
    return;
  }
  state.dashboardStatsCaches.clear();
  state.dashboardStatsCacheVersion += 1;
}

function getDashboardStatsResponseCacheKey(indexKey: string, filters: DashboardStatsFilters): string {
  return `${state.dashboardStatsResponseVersion}:${indexKey}:${JSON.stringify(filters)}`;
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



  return {
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
    isDashboardStatsBuildInProgress,
    warmDashboardStatsCache,
    prepareDashboardStatsAfterRefresh,
    prepareDashboardStatsAfterRefreshInBackground,
    invalidateFacetResponses,
    invalidateDashboardStatsCache,
    getStaleDashboardStatsResponseCacheKey,
    normalizeAlertDetail,
  };
}
