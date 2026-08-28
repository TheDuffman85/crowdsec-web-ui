import { isIP } from 'node:net';
import type { SearchNode } from '../../shared/search';
import type { AlertListFilters, DecisionListFilters } from './types';
import {
  addDashboardBucketInterval,
  formatDashboardClientBucketKey,
  parseDashboardBucketKey,
  parseDashboardWallKey,
} from './dashboard-stats';

export interface SqlCondition {
  sql: string;
  params: unknown[];
}

export class SqlWhere {
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

export function createSqlWhere(): SqlWhere {
  return new SqlWhere();
}

const DECISION_COVERED_SEARCH_FIELDS = new Set([
  'id', 'instance', 'alert', 'scenario', 'ip', 'country', 'region', 'city', 'as', 'target',
  'kind', 'date', 'action', 'type', 'status', 'duplicate', 'sim', 'machine', 'origin',
]);

const ALERT_COVERED_SEARCH_FIELDS = new Set([
  'id', 'instance', 'scenario', 'message', 'ip', 'country', 'region', 'city', 'as',
  'kind', 'target', 'date', 'sim', 'machine', 'origin', 'decision',
]);

// These fields are part of the duplicate-group identity. Applying predicates
// that only reference them cannot hide the persisted primary while leaving
// another member of the same group visible, so the precomputed duplicate
// flags remain correct for any boolean combination of these predicates.
const DECISION_DUPLICATE_GROUP_INVARIANT_FIELDS = new Set([
  'instance',
  'ip',
  'sim',
]);

export function decisionSearchCanSplitDuplicateGroup(
  node: SearchNode | null,
  includeExpired: boolean,
  scopedField?: string,
): boolean {
  if (!node) return false;

  if (node.kind === 'term') {
    if (!scopedField) return true;
    if (DECISION_DUPLICATE_GROUP_INVARIANT_FIELDS.has(scopedField)) return false;
    // The active-only base predicate has already removed every expired row.
    // A status expression can therefore only retain all candidates or none.
    return scopedField !== 'status' || includeExpired;
  }

  if (node.kind === 'comparison') {
    if (DECISION_DUPLICATE_GROUP_INVARIANT_FIELDS.has(node.field)) return false;
    return node.field !== 'status' || includeExpired;
  }

  if (node.kind === 'field') {
    return decisionSearchCanSplitDuplicateGroup(node.expression, includeExpired, node.field);
  }

  if (node.kind === 'not') {
    return decisionSearchCanSplitDuplicateGroup(node.expression, includeExpired, scopedField);
  }

  return decisionSearchCanSplitDuplicateGroup(node.left, includeExpired, scopedField)
    || decisionSearchCanSplitDuplicateGroup(node.right, includeExpired, scopedField);
}

export function getAlertCountIndexHint(
  filters: AlertListFilters,
  searchAst: SearchNode | null,
): '' | 'INDEXED BY idx_alerts_filters' {
  if (searchAst && !isAlertSearchCoveredByFilterIndex(searchAst)) {
    return '';
  }
  if (
    searchAst
    || filters.ip
    || filters.country
    || filters.scenario
    || filters.as
    || filters.target
    || filters.date
    || filters.dateStart
    || filters.dateEnd
    || filters.simulation !== 'all'
  ) {
    return 'INDEXED BY idx_alerts_filters';
  }
  return '';
}

export function getDecisionPageIndexHint(filters: DecisionListFilters, searchAst: SearchNode | null): string {
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

export function isAlertSearchCoveredByFilterIndex(node: SearchNode, fieldContext = false): boolean {
  if (node.kind === 'term') return fieldContext;
  if (node.kind === 'comparison') return ALERT_COVERED_SEARCH_FIELDS.has(node.field);
  if (node.kind === 'field') {
    return ALERT_COVERED_SEARCH_FIELDS.has(node.field)
      && isAlertSearchCoveredByFilterIndex(node.expression, true);
  }
  if (node.kind === 'not') return isAlertSearchCoveredByFilterIndex(node.expression, fieldContext);
  return isAlertSearchCoveredByFilterIndex(node.left, fieldContext)
    && isAlertSearchCoveredByFilterIndex(node.right, fieldContext);
}

export function searchAstContainsField(node: SearchNode | null, ...fields: string[]): boolean {
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

export function getSimpleSearchFieldValue(node: SearchNode | null, field: string): string {
  if (!node) return '';
  if (node.kind === 'field' && node.field === field && node.expression.kind === 'term') {
    return node.expression.value;
  }
  if (node.kind === 'comparison' && node.field === field && node.operator === '=') {
    return node.value;
  }
  return '';
}

export function isDecisionSearchCoveredByFilterIndex(node: SearchNode, fieldContext = false): boolean {
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

export function addLike(where: SqlWhere, columnSql: string, value: string): void {
  where.add(`${columnSql} LIKE ? ESCAPE '\\'`, likeParam(value));
}

export function addIpCondition(where: SqlWhere, column: string, value: string): void {
  const normalized = value.trim().toLowerCase();
  if (isIP(normalized) !== 0) {
    where.add(`${column} = ?`, normalized);
    return;
  }
  where.add(`(matches_ip_search_value(${column}, ?) = 1 OR LOWER(${column}) LIKE ? ESCAPE '\\')`, value, likeParam(value));
}

export function textCondition(columnSql: string, value: string, exact = false): SqlCondition {
  const normalizedColumn = `COALESCE(${columnSql}, '')`;
  return exact
    ? { sql: `${normalizedColumn} = ?`, params: [value.trim().toLowerCase()] }
    : { sql: `${normalizedColumn} LIKE ? ESCAPE '\\'`, params: [likeParam(value)] };
}

export function spaceSeparatedTextCondition(column: string, value: string): SqlCondition {
  return {
    sql: `(' ' || COALESCE(LOWER(${column}), '') || ' ') LIKE ? ESCAPE '\\'`,
    params: [`% ${escapeLike(value.trim().toLowerCase())} %`],
  };
}

export function buildInstanceFacetLabelSql(
  column: string,
  instances: ReadonlyArray<{ id: string; name: string }>,
): { sql: string; params: unknown[] } {
  if (instances.length === 0) {
    return { sql: `COALESCE(TRIM(${column}), '')`, params: [] };
  }
  return {
    sql: `CASE COALESCE(TRIM(${column}), '')
      ${instances.map(() => 'WHEN ? THEN ?').join('\n')}
      ELSE COALESCE(TRIM(${column}), '')
    END`,
    params: instances.flatMap((instance) => [instance.id, instance.name]),
  };
}

export function normalizedMachineIdSql(idColumn: string, fallbackColumn: string): string {
  return `CASE
    WHEN COALESCE(LOWER(TRIM(${idColumn})), '') IN ('', 'n/a', 'na', 'unknown')
      THEN COALESCE(TRIM(${fallbackColumn}), '')
    ELSE TRIM(${idColumn})
  END`;
}

export function decisionMachineIdSql(extraDataColumn: string, fallbackColumn: string): string {
  const idColumn = `CAST(json_extract(${extraDataColumn}, '$.machine_id') AS TEXT)`;
  return normalizedMachineIdSql(idColumn, fallbackColumn);
}

export function decisionMachineLabelSql(extraDataColumn: string, fallbackColumn: string): string {
  const aliasColumn = `CAST(json_extract(${extraDataColumn}, '$.machine_alias') AS TEXT)`;
  return `CASE
    WHEN COALESCE(LOWER(TRIM(${aliasColumn})), '') IN ('', 'n/a', 'na', 'unknown')
      THEN COALESCE(TRIM(${fallbackColumn}), '')
    ELSE TRIM(${aliasColumn})
  END`;
}

export function jsonStringArraySql(extraDataColumn: string, key: string, fallbackColumn: string): string {
  const path = `$.${key}`;
  return `CASE
    WHEN json_valid(${extraDataColumn}) = 1
      AND json_type(${extraDataColumn}, '${path}') = 'array'
      THEN json_extract(${extraDataColumn}, '${path}')
    ELSE json_array(${fallbackColumn})
  END`;
}

export function anyTextColumnCondition(columns: string[], value: string, exact = false): SqlCondition {
  const conditions = columns.map((column) => textCondition(`LOWER(${column})`, value, exact));
  return {
    sql: `(${conditions.map((condition) => condition.sql).join(' OR ')})`,
    params: conditions.flatMap((condition) => condition.params),
  };
}

export function targetFieldCondition(
  targetColumn: string,
  extraDataColumn: string,
  value: string,
  exact = false,
): SqlCondition {
  const primary = textCondition(`LOWER(${targetColumn})`, value, exact);
  const arrayValue = "LOWER(TRIM(CAST(target_filter_value.value AS TEXT)))";
  const arrayCondition = textCondition(arrayValue, value, exact);
  return {
    sql: `(${primary.sql} OR EXISTS (
      SELECT 1
      FROM json_each(${jsonStringArraySql(extraDataColumn, 'targets', targetColumn)}) AS target_filter_value
      WHERE ${arrayCondition.sql}
    ))`,
    params: [...primary.params, ...arrayCondition.params],
  };
}

export function targetEmptyCondition(targetColumn: string, extraDataColumn: string): SqlCondition {
  return {
    sql: `NOT EXISTS (
      SELECT 1
      FROM json_each(${jsonStringArraySql(extraDataColumn, 'targets', targetColumn)}) AS target_filter_value
      WHERE COALESCE(TRIM(CAST(target_filter_value.value AS TEXT)), '') <> ''
    )`,
    params: [],
  };
}

export function ipCondition(column: string, value: string, exact = false): SqlCondition {
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

export function freeTextSearchCondition(page: SearchPageForSql, value: string, searchIndexAvailable: boolean): SqlCondition {
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

export function alertFieldCondition(
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
    case 'kind':
      return textCondition('LOWER(kind)', value, exact);
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
      return targetFieldCondition('target', 'extra_data', value, exact);
    case 'date':
      return textCondition('LOWER(created_at)', value, exact);
    case 'sim':
      return simulationTermCondition(value);
    case 'machine':
      return anyTextColumnCondition([
        normalizedMachineIdSql('machine_id', 'machine'),
        'machine_alias',
        'machine',
      ], value, exact);
    case 'origin':
      return exact ? spaceSeparatedTextCondition('origins', value) : textCondition('LOWER(origins)', value);
    case 'decision':
      return alertDecisionCondition(value, now, simulationsEnabled);
    default:
      return { sql: '0 = 1', params: [] };
  }
}

export function decisionFieldCondition(
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
    case 'kind':
      return textCondition('LOWER((SELECT kind FROM alerts WHERE alerts.id = decisions.alert_id))', value, exact);
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
      return targetFieldCondition('target', 'extra_data', value, exact);
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
      return anyTextColumnCondition([
        decisionMachineIdSql('extra_data', 'machine'),
        decisionMachineLabelSql('extra_data', 'machine'),
        'machine',
      ], value, exact);
    case 'origin':
      return textCondition('LOWER(origin)', value, exact);
    default:
      return { sql: '0 = 1', params: [] };
  }
}

export function instanceFieldCondition(
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

export function alertEmptyFieldCondition(field: string, simulationsEnabled = true): SqlCondition {
  if (field === 'target') {
    return targetEmptyCondition('target', 'extra_data');
  }
  if (field === 'machine') {
    return {
      sql: `COALESCE(TRIM(${normalizedMachineIdSql('machine_id', 'machine')}), '') = ''`,
      params: [],
    };
  }
  switch (field) {
    case 'scenario':
    case 'kind':
    case 'message':
    case 'ip':
    case 'country':
    case 'region':
    case 'city':
    case 'as':
    case 'origin':
      return emptyTextCondition({
        scenario: 'scenario',
        kind: 'kind',
        message: 'message',
        ip: 'source_ip',
        country: 'country',
        region: 'region',
        city: 'city',
        as: 'as_name',
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

export function alertDecisionCondition(value: string, now: string, simulationsEnabled: boolean): SqlCondition {
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

export function decisionEmptyFieldCondition(field: string): SqlCondition {
  if (field === 'target') {
    return targetEmptyCondition('target', 'extra_data');
  }
  if (field === 'machine') {
    return {
      sql: `COALESCE(TRIM(${decisionMachineIdSql('extra_data', 'machine')}), '') = ''`,
      params: [],
    };
  }
  switch (field) {
    case 'alert':
    case 'scenario':
    case 'kind':
    case 'ip':
    case 'country':
    case 'region':
    case 'city':
    case 'as':
    case 'action':
    case 'type':
    case 'origin':
      return emptyTextCondition({
        alert: 'alert_id',
        scenario: 'scenario',
        kind: '(SELECT kind FROM alerts WHERE alerts.id = decisions.alert_id)',
        ip: 'value',
        country: 'country',
        region: 'region',
        city: 'city',
        as: 'as_name',
        action: 'type',
        type: 'type',
        origin: 'origin',
      }[field]);
    default:
      return { sql: '0 = 1', params: [] };
  }
}

export function emptyTextCondition(columnSql: string): SqlCondition {
  return { sql: `COALESCE(TRIM(${columnSql}), '') = ''`, params: [] };
}

export function countryCondition(value: string, exact = false): SqlCondition {
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

export function simulationTermCondition(value: string): SqlCondition {
  const parsed = parseSimulationSearchValue(value);
  if (parsed === true) {
    return { sql: 'simulated = 1', params: [] };
  }
  if (parsed === false) {
    return { sql: 'simulated = 0', params: [] };
  }
  return { sql: '0 = 1', params: [] };
}

export function simulationComparisonCondition(operator: string, value: string): SqlCondition {
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

export function parseSimulationSearchValue(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (['sim', 'simulated', 'simulation', 'true', 'yes', '1'].includes(normalized)) {
    return true;
  }
  if (['live', 'false', 'no', '0'].includes(normalized)) {
    return false;
  }
  return null;
}

export function decisionStatusCondition(value: string, now: string): SqlCondition {
  const normalized = value.trim().toLowerCase();
  if (['expired', 'inactive'].includes(normalized)) {
    return { sql: 'stop_at <= ?', params: [now] };
  }
  if (['active', 'live'].includes(normalized)) {
    return { sql: 'stop_at > ?', params: [now] };
  }
  return { sql: '0 = 1', params: [] };
}

export function booleanCondition(value: string, trueSql: string): SqlCondition {
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', '1', 'on'].includes(normalized)) {
    return { sql: trueSql, params: [] };
  }
  if (['false', 'no', '0', 'off'].includes(normalized)) {
    return { sql: `NOT (${trueSql})`, params: [] };
  }
  return { sql: '0 = 1', params: [] };
}

export function booleanColumnCondition(value: string, columnSql: string): SqlCondition {
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', '1', 'on'].includes(normalized)) {
    return { sql: `${columnSql} = 1`, params: [] };
  }
  if (['false', 'no', '0', 'off'].includes(normalized)) {
    return { sql: `${columnSql} = 0`, params: [] };
  }
  return { sql: '0 = 1', params: [] };
}

export function compileSearchNodeSql(
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

export function dateComparisonCondition(
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

export function parseSqlSearchDateValue(
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

export function getDateFilterBoundary(
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

export function likeParam(value: string): string {
  return `%${escapeLike(value.trim().toLowerCase())}%`;
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function toFtsQuery(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (Array.from(normalized).length < 3) return null;
  return `"${normalized.replace(/"/g, '""')}"`;
}
