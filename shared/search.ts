import type { DecisionListItem, SlimAlert } from './contracts';
import { resolveMachineName } from './machine';
import { collectDistinctOrigins } from './origin';

export type SearchPage = 'alerts' | 'decisions';
export type SearchBooleanOperator = 'AND' | 'OR';
export type SearchComparisonOperator = '=' | '<>' | '<' | '>' | '<=' | '>=';
type SearchFieldValueType = 'text' | 'date';

export interface SearchFeatureFlags {
  machineEnabled?: boolean;
  originEnabled?: boolean;
}

export interface SearchFieldDefinition {
  name: string;
  aliases: string[];
  description: string;
  descriptionKey?: string;
  availability?: 'always' | 'machine' | 'origin';
  valueType?: SearchFieldValueType;
}

export interface SearchHelpExample {
  query: string;
  description: string;
  descriptionKey?: string;
}

export interface SearchHelpOperatorDefinition {
  label: string;
  insertText: string;
  description: string;
  descriptionKey?: string;
}

export interface SearchHelpTip {
  text: string;
  translationKey: string;
}

export interface SearchHelpDefinition {
  page: SearchPage;
  title: string;
  titleKey: string;
  summary: string;
  summaryKey: string;
  tips: SearchHelpTip[];
  operators: SearchHelpOperatorDefinition[];
  examples: SearchHelpExample[];
  fields: SearchFieldDefinition[];
}

export interface SearchHelpSampleData {
  alerts?: SlimAlert[];
  decisions?: DecisionListItem[];
}

export interface SearchParseError {
  message: string;
  position: number;
  length: number;
  query: string;
  token?: string;
}

export type SearchHighlightTokenKind =
  | 'term'
  | 'string'
  | 'field'
  | 'booleanOperator'
  | 'comparator'
  | 'paren'
  | 'negation';

export interface SearchHighlightToken {
  kind: SearchHighlightTokenKind;
  start: number;
  end: number;
  value: string;
  normalizedValue?: string;
}

export interface SearchQueryAnalysis {
  tokens: SearchHighlightToken[];
  error: SearchParseError | null;
}

export type SearchNode =
  | { kind: 'term'; value: string; quoted: boolean }
  | { kind: 'not'; expression: SearchNode }
  | { kind: 'binary'; operator: SearchBooleanOperator; left: SearchNode; right: SearchNode }
  | { kind: 'field'; field: string; expression: SearchNode }
  | { kind: 'comparison'; field: string; operator: SearchComparisonOperator; value: string; quoted: boolean };

type SearchComparatorTokenValue = ':' | '=' | '<>' | '<' | '>' | '<=' | '>=' | '=>';

type SearchToken =
  | { type: 'word'; value: string; start: number; end: number }
  | { type: 'string'; value: string; start: number; end: number }
  | { type: 'operator'; value: 'AND' | 'OR' | 'NOT'; start: number; end: number }
  | { type: 'lparen'; start: number; end: number }
  | { type: 'rparen'; start: number; end: number }
  | { type: 'comparator'; value: SearchComparatorTokenValue; start: number; end: number }
  | { type: 'minus'; start: number; end: number };

type FieldMap = Map<string, SearchFieldDefinition>;
type AlertMatcher = (alert: SlimAlert, value: string) => boolean;
type DecisionMatcher = (decision: DecisionListItem, value: string) => boolean;

type AlertFieldMatcherMap = Record<string, AlertMatcher>;
type DecisionFieldMatcherMap = Record<string, DecisionMatcher>;

type SearchCompileSuccess<T> = {
  ok: true;
  ast: SearchNode | null;
  help: SearchHelpDefinition;
  predicate: (item: T) => boolean;
};

type SearchCompileFailure = {
  ok: false;
  error: SearchParseError;
  help: SearchHelpDefinition;
};

export type AlertSearchCompileResult = SearchCompileSuccess<SlimAlert> | SearchCompileFailure;
export type DecisionSearchCompileResult = SearchCompileSuccess<DecisionListItem> | SearchCompileFailure;

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

const alertFieldDefinitions: SearchFieldDefinition[] = [
  { name: 'id', aliases: [], description: 'Exact alert ID', descriptionKey: 'components.searchSyntax.fields.alerts.id' },
  { name: 'scenario', aliases: [], description: 'Scenario name', descriptionKey: 'components.searchSyntax.fields.alerts.scenario' },
  { name: 'message', aliases: [], description: 'Alert message text', descriptionKey: 'components.searchSyntax.fields.alerts.message' },
  { name: 'ip', aliases: ['source'], description: 'Source IP, value, or range', descriptionKey: 'components.searchSyntax.fields.alerts.ip' },
  { name: 'country', aliases: [], description: 'Country code or name', descriptionKey: 'components.searchSyntax.fields.country' },
  { name: 'as', aliases: [], description: 'Autonomous system / provider name', descriptionKey: 'components.searchSyntax.fields.as' },
  { name: 'target', aliases: [], description: 'Alert target', descriptionKey: 'components.searchSyntax.fields.alerts.target' },
  { name: 'date', aliases: ['created', 'created_at', 'time'], description: 'Alert creation date or ISO timestamp', descriptionKey: 'components.searchSyntax.fields.alerts.date', valueType: 'date' },
  { name: 'sim', aliases: ['simulation'], description: 'Simulation state (`live` or `simulated`)', descriptionKey: 'components.searchSyntax.fields.sim' },
  { name: 'machine', aliases: [], description: 'Machine alias or ID', descriptionKey: 'components.searchSyntax.fields.machine', availability: 'machine' },
  { name: 'origin', aliases: [], description: 'Decision origin', descriptionKey: 'components.searchSyntax.fields.origin', availability: 'origin' },
];

const decisionFieldDefinitions: SearchFieldDefinition[] = [
  { name: 'id', aliases: [], description: 'Exact decision ID', descriptionKey: 'components.searchSyntax.fields.decisions.id' },
  { name: 'alert', aliases: ['alert_id'], description: 'Linked alert ID', descriptionKey: 'components.searchSyntax.fields.decisions.alert' },
  { name: 'scenario', aliases: ['reason'], description: 'Decision scenario / reason', descriptionKey: 'components.searchSyntax.fields.decisions.scenario' },
  { name: 'ip', aliases: ['value'], description: 'Decision IP or range', descriptionKey: 'components.searchSyntax.fields.decisions.ip' },
  { name: 'country', aliases: [], description: 'Country code or name', descriptionKey: 'components.searchSyntax.fields.country' },
  { name: 'as', aliases: [], description: 'Autonomous system / provider name', descriptionKey: 'components.searchSyntax.fields.as' },
  { name: 'target', aliases: [], description: 'Decision target', descriptionKey: 'components.searchSyntax.fields.decisions.target' },
  { name: 'date', aliases: ['created', 'created_at', 'time'], description: 'Decision creation date or ISO timestamp', descriptionKey: 'components.searchSyntax.fields.decisions.date', valueType: 'date' },
  { name: 'action', aliases: [], description: 'Decision action', descriptionKey: 'components.searchSyntax.fields.decisions.action' },
  { name: 'type', aliases: [], description: 'Decision type', descriptionKey: 'components.searchSyntax.fields.decisions.type' },
  { name: 'status', aliases: [], description: 'Decision status (`active` or `expired`)', descriptionKey: 'components.searchSyntax.fields.decisions.status' },
  { name: 'duplicate', aliases: [], description: 'Duplicate state (`true` or `false`)', descriptionKey: 'components.searchSyntax.fields.decisions.duplicate' },
  { name: 'sim', aliases: ['simulation'], description: 'Simulation state (`live` or `simulated`)', descriptionKey: 'components.searchSyntax.fields.sim' },
  { name: 'machine', aliases: [], description: 'Machine alias or ID', descriptionKey: 'components.searchSyntax.fields.machine', availability: 'machine' },
  { name: 'origin', aliases: [], description: 'Decision origin', descriptionKey: 'components.searchSyntax.fields.origin', availability: 'origin' },
];

const fallbackAlertExamples: SearchHelpExample[] = [
  { query: 'ssh hetzner', description: 'Normal free-text search across the existing alert fields', descriptionKey: 'components.searchSyntax.examples.alerts.freeText' },
  { query: '"nginx bf"', description: 'Find an exact phrase', descriptionKey: 'components.searchSyntax.examples.alerts.phrase' },
  { query: 'country:germany ssh', description: 'Mix fielded search with normal free-text terms', descriptionKey: 'components.searchSyntax.examples.alerts.mixedField' },
  { query: 'date>=2026-03-24 AND date<2026-03-25', description: 'Filter alerts by date or timestamp ranges', descriptionKey: 'components.searchSyntax.examples.alerts.dateRange' },
  { query: 'country:(germany OR france) AND -sim:simulated', description: 'Use grouping, boolean logic, and negation', descriptionKey: 'components.searchSyntax.examples.alerts.boolean' },
  { query: 'ip:1.2.3.4 AND target:ssh', description: 'Match a specific IP and target', descriptionKey: 'components.searchSyntax.examples.alerts.specificField' },
];

const fallbackDecisionExamples: SearchHelpExample[] = [
  { query: 'ssh ban', description: 'Normal free-text search across the existing decision fields', descriptionKey: 'components.searchSyntax.examples.decisions.freeText' },
  { query: 'status:active AND action:ban', description: 'Filter semantic decision fields', descriptionKey: 'components.searchSyntax.examples.decisions.semantic' },
  { query: 'date>=2026-03-24 AND action:ban', description: 'Combine date filters with semantic decision fields', descriptionKey: 'components.searchSyntax.examples.decisions.dateAction' },
  { query: 'alert:123 OR ip:"192.168.5.0/24"', description: 'Search by linked alert or a quoted IP/range', descriptionKey: 'components.searchSyntax.examples.decisions.linkedRecord' },
  { query: 'country:(germany OR france) AND -duplicate:true', description: 'Exclude duplicates while grouping countries', descriptionKey: 'components.searchSyntax.examples.decisions.boolean' },
  { query: 'target:ssh AND sim:live', description: 'Limit results to one target and simulation state', descriptionKey: 'components.searchSyntax.examples.decisions.simulation' },
];

const searchHelpOperators: SearchHelpOperatorDefinition[] = [
  { label: 'AND', insertText: ' AND ', description: 'Both expressions must match', descriptionKey: 'components.searchSyntax.operators.and' },
  { label: 'OR', insertText: ' OR ', description: 'Either expression may match', descriptionKey: 'components.searchSyntax.operators.or' },
  { label: 'NOT', insertText: 'NOT ', description: 'Negate the next expression', descriptionKey: 'components.searchSyntax.operators.not' },
  { label: '-', insertText: '-', description: 'Short negation for a single term or field', descriptionKey: 'components.searchSyntax.operators.minus' },
  { label: ':', insertText: ':', description: 'Broad field match, for example `country:germany`', descriptionKey: 'components.searchSyntax.operators.contains' },
  { label: '=', insertText: '=', description: 'Exact match, for example `country=DE` or `date=2026-03-24`', descriptionKey: 'components.searchSyntax.operators.equals' },
  { label: '<>', insertText: '<>', description: 'Exclude a value, for example `sim<>simulated`', descriptionKey: 'components.searchSyntax.operators.notEquals' },
  { label: '>', insertText: '>', description: 'Date is after the supplied value, for example `date>2026-03-24`', descriptionKey: 'components.searchSyntax.operators.greaterThan' },
  { label: '>=', insertText: '>=', description: 'Date is on or after the supplied value, for example `date>=2026-03-24`', descriptionKey: 'components.searchSyntax.operators.greaterOrEqual' },
  { label: '<', insertText: '<', description: 'Date is before the supplied value, for example `date<2026-03-24`', descriptionKey: 'components.searchSyntax.operators.lessThan' },
  { label: '<=', insertText: '<=', description: 'Date is on or before the supplied value, for example `date<=2026-03-24`', descriptionKey: 'components.searchSyntax.operators.lessOrEqual' },
];

const EXAMPLE_STOP_WORDS = new Set(['crowdsecurity', 'crowdsec', 'manual', 'web', 'ui']);

function getSearchHelpExamples(page: SearchPage, samples?: SearchHelpSampleData): SearchHelpExample[] {
  return page === 'alerts'
    ? buildAlertExamples(samples?.alerts)
    : buildDecisionExamples(samples?.decisions);
}

function buildAlertExamples(alerts?: SlimAlert[]): SearchHelpExample[] {
  return [
    buildSearchHelpExample(fallbackAlertExamples[0], findAlertFreeTextExample(alerts)),
    buildSearchHelpExample(fallbackAlertExamples[1], findAlertPhraseExample(alerts)),
    buildSearchHelpExample(fallbackAlertExamples[2], findAlertMixedFieldExample(alerts)),
    buildSearchHelpExample(fallbackAlertExamples[3], findAlertDateExample(alerts)),
    buildSearchHelpExample(fallbackAlertExamples[4], findAlertBooleanExample(alerts)),
    buildSearchHelpExample(fallbackAlertExamples[5], findAlertSpecificFieldExample(alerts)),
  ];
}

function buildDecisionExamples(decisions?: DecisionListItem[]): SearchHelpExample[] {
  return [
    buildSearchHelpExample(fallbackDecisionExamples[0], findDecisionFreeTextExample(decisions)),
    buildSearchHelpExample(fallbackDecisionExamples[1], findDecisionSemanticExample(decisions)),
    buildSearchHelpExample(fallbackDecisionExamples[2], findDecisionDateExample(decisions)),
    buildSearchHelpExample(fallbackDecisionExamples[3], findDecisionLinkedRecordExample(decisions)),
    buildSearchHelpExample(fallbackDecisionExamples[4], findDecisionBooleanExample(decisions)),
    buildSearchHelpExample(fallbackDecisionExamples[5], findDecisionSimulationExample(decisions)),
  ];
}

function buildSearchHelpExample(fallbackExample: SearchHelpExample, query: string | null): SearchHelpExample {
  return {
    ...fallbackExample,
    query: query ?? fallbackExample.query,
  };
}

function findAlertFreeTextExample(alerts?: SlimAlert[]): string | null {
  for (const alert of alerts ?? []) {
    const terms = uniqueTerms(
      extractExampleTerms(alert.target),
      extractExampleTerms(alert.source?.as_name),
      extractExampleTerms(alert.scenario),
      extractExampleTerms(alert.meta_search),
    );
    if (terms.length >= 2) {
      return `${terms[0]} ${terms[1]}`;
    }
  }
  return null;
}

function findAlertPhraseExample(alerts?: SlimAlert[]): string | null {
  for (const alert of alerts ?? []) {
    const messagePhrase = extractQuotedPhrase(alert.message);
    if (messagePhrase) {
      return messagePhrase;
    }

    const scenario = sanitizeExampleValue(alert.scenario);
    if (scenario) {
      return quoteSearchValue(scenario);
    }
  }
  return null;
}

function findAlertMixedFieldExample(alerts?: SlimAlert[]): string | null {
  for (const alert of alerts ?? []) {
    const country = getAlertCountryExampleValue(alert);
    const term = getAlertTargetOrScenarioTerm(alert);
    if (country && term) {
      return `country:${formatSearchExampleValue(country)} ${term}`;
    }
  }
  return null;
}

function findAlertDateExample(alerts?: SlimAlert[]): string | null {
  for (const alert of alerts ?? []) {
    const dateRange = getUtcDateRangeQuery(alert.created_at);
    if (dateRange) {
      return dateRange;
    }
  }
  return null;
}

function findAlertBooleanExample(alerts?: SlimAlert[]): string | null {
  const countries = collectDistinctValues((alerts ?? []).map(getAlertCountryExampleValue));
  if (countries.length < 2) {
    return null;
  }
  return `country:(${formatSearchExampleValue(countries[0])} OR ${formatSearchExampleValue(countries[1])}) AND -sim:simulated`;
}

function findAlertSpecificFieldExample(alerts?: SlimAlert[]): string | null {
  for (const alert of alerts ?? []) {
    const sourceValue = getAlertSourceExampleValue(alert);
    const target = sanitizeExampleValue(alert.target);
    if (sourceValue && target) {
      return `ip:${formatSearchExampleValue(sourceValue)} AND target:${formatSearchExampleValue(target)}`;
    }
  }
  return null;
}

function findDecisionFreeTextExample(decisions?: DecisionListItem[]): string | null {
  for (const decision of decisions ?? []) {
    const terms = uniqueTerms(
      extractExampleTerms(decision.detail.reason || decision.scenario),
      extractExampleTerms(decision.detail.action),
      extractExampleTerms(decision.detail.type),
    );
    if (terms.length >= 2) {
      return `${terms[0]} ${terms[1]}`;
    }
  }
  return null;
}

function findDecisionSemanticExample(decisions?: DecisionListItem[]): string | null {
  for (const decision of decisions ?? []) {
    const action = sanitizeExampleValue(decision.detail.action);
    if (action) {
      return `status:${isDecisionExpired(decision) ? 'expired' : 'active'} AND action:${formatSearchExampleValue(action)}`;
    }
  }
  return null;
}

function findDecisionDateExample(decisions?: DecisionListItem[]): string | null {
  for (const decision of decisions ?? []) {
    const day = getUtcDateString(decision.created_at);
    const action = sanitizeExampleValue(decision.detail.action);
    if (day && action) {
      return `date>=${day} AND action:${formatSearchExampleValue(action)}`;
    }
  }
  return null;
}

function findDecisionLinkedRecordExample(decisions?: DecisionListItem[]): string | null {
  for (const decision of decisions ?? []) {
    const alertId = decision.detail.alert_id;
    const value = sanitizeExampleValue(decision.value);
    if (alertId !== undefined && alertId !== null && value) {
      return `alert:${String(alertId)} OR ip:${quoteSearchValue(value)}`;
    }
  }
  return null;
}

function findDecisionBooleanExample(decisions?: DecisionListItem[]): string | null {
  const countries = collectDistinctValues((decisions ?? []).map(getDecisionCountryExampleValue));
  if (countries.length < 2) {
    return null;
  }
  return `country:(${formatSearchExampleValue(countries[0])} OR ${formatSearchExampleValue(countries[1])}) AND -duplicate:true`;
}

function findDecisionSimulationExample(decisions?: DecisionListItem[]): string | null {
  for (const decision of decisions ?? []) {
    const target = sanitizeExampleValue(decision.detail.target || undefined);
    if (target) {
      return `target:${formatSearchExampleValue(target)} AND sim:${decision.simulated === true ? 'simulated' : 'live'}`;
    }
  }
  return null;
}

function getAlertCountryExampleValue(alert: SlimAlert): string | null {
  return getCountryExampleValue(alert.source?.cn);
}

function getDecisionCountryExampleValue(decision: DecisionListItem): string | null {
  return getCountryExampleValue(decision.detail.country);
}

function getCountryExampleValue(countryCode: string | undefined): string | null {
  const countryName = sanitizeExampleValue(getCountryName(countryCode));
  if (countryName) {
    return countryName;
  }

  return sanitizeExampleValue(countryCode);
}

function getAlertTargetOrScenarioTerm(alert: SlimAlert): string | null {
  const terms = uniqueTerms(extractExampleTerms(alert.target), extractExampleTerms(alert.scenario));
  return terms[0] ?? null;
}

function getAlertSourceExampleValue(alert: SlimAlert): string | null {
  return sanitizeExampleValue(alert.source?.ip) ||
    sanitizeExampleValue(alert.source?.value) ||
    sanitizeExampleValue(alert.source?.range);
}

function uniqueTerms(...groups: string[][]): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];

  for (const group of groups) {
    for (const term of group) {
      if (!seen.has(term)) {
        seen.add(term);
        terms.push(term);
      }
    }
  }

  return terms;
}

function extractExampleTerms(value: string | null | undefined): string[] {
  const normalized = sanitizeExampleValue(value)?.toLowerCase() ?? '';
  if (!normalized) {
    return [];
  }

  return normalized
    .split(/[^a-z0-9]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && /[a-z]/i.test(term) && !EXAMPLE_STOP_WORDS.has(term));
}

function extractQuotedPhrase(value: string | null | undefined): string | null {
  const sanitized = sanitizeExampleValue(value);
  if (!sanitized) {
    return null;
  }

  const words = sanitized.split(/\s+/).filter(Boolean);
  if (words.length < 2) {
    return null;
  }

  return quoteSearchValue(words.slice(0, Math.min(words.length, 4)).join(' '));
}

function sanitizeExampleValue(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const sanitized = value.replace(/"/g, '').replace(/\s+/g, ' ').trim();
  return sanitized || null;
}

function formatSearchExampleValue(value: string): string {
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : quoteSearchValue(value);
}

function quoteSearchValue(value: string): string {
  return `"${value}"`;
}

function collectDistinctValues(values: Array<string | null>): string[] {
  const distinct: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (!value) {
      continue;
    }

    const normalized = normalizeValue(value);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      distinct.push(value);
    }
  }

  return distinct;
}

function getUtcDateRangeQuery(value: string | undefined): string | null {
  const start = getUtcDateString(value);
  if (!start) {
    return null;
  }

  const end = getNextUtcDateString(start);
  if (!end) {
    return null;
  }

  return `date>=${start} AND date<${end}`;
}

function getUtcDateString(value: string | undefined): string | null {
  const timestamp = parseIsoTimestamp(value);
  if (timestamp === null) {
    return null;
  }

  return new Date(timestamp).toISOString().slice(0, 10);
}

function getNextUtcDateString(day: string): string | null {
  const timestamp = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return new Date(timestamp + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const alertFieldMatchers: AlertFieldMatcherMap = {
  id: (alert, value) => normalizeValue(alert.id) === normalizeValue(value),
  scenario: (alert, value) => includesNormalized(alert.scenario, value),
  message: (alert, value) => includesNormalized(alert.message, value),
  ip: (alert, value) => getAlertSourceValues(alert).some((candidate) => matchesIpSearchValue(candidate, value)),
  country: (alert, value) => matchesCountryField(alert.source?.cn || '', value),
  as: (alert, value) => includesNormalized(alert.source?.as_name, value),
  target: (alert, value) => includesNormalized(alert.target, value),
  date: (alert, value) => includesNormalized(alert.created_at, value),
  sim: (alert, value) => matchesSimulationTerm(alert.simulated === true, value),
  machine: (alert, value) => includesNormalized(resolveMachineName(alert), value),
  origin: (alert, value) => collectDistinctOrigins(alert.decisions).some((origin) => includesNormalized(origin, value)),
};

const decisionFieldMatchers: DecisionFieldMatcherMap = {
  id: (decision, value) => normalizeValue(decision.id) === normalizeValue(value),
  alert: (decision, value) => normalizeValue(decision.detail.alert_id) === normalizeValue(value),
  scenario: (decision, value) => includesNormalized(decision.detail.reason || decision.scenario, value),
  ip: (decision, value) => matchesIpSearchValue(decision.value, value),
  country: (decision, value) => matchesCountryField(decision.detail.country || '', value),
  as: (decision, value) => includesNormalized(decision.detail.as, value),
  target: (decision, value) => includesNormalized(decision.detail.target, value),
  date: (decision, value) => includesNormalized(decision.created_at, value),
  action: (decision, value) => includesNormalized(decision.detail.action, value),
  type: (decision, value) => includesNormalized(decision.detail.type, value),
  status: (decision, value) => matchesDecisionStatus(decision, value),
  duplicate: (decision, value) => matchesBoolean(decision.is_duplicate, value),
  sim: (decision, value) => matchesSimulationTerm(decision.simulated === true, value),
  machine: (decision, value) => includesNormalized(decision.machine, value),
  origin: (decision, value) => includesNormalized(decision.detail.origin, value),
};

export function getSearchHelpDefinition(
  page: SearchPage,
  features: SearchFeatureFlags = {},
  samples?: SearchHelpSampleData,
): SearchHelpDefinition {
  return {
    page,
    title: page === 'alerts' ? 'Alert Search Syntax' : 'Decision Search Syntax',
    titleKey: page === 'alerts' ? 'components.searchSyntax.alerts.title' : 'components.searchSyntax.decisions.title',
    summary: 'Start with normal free-text search, then add exact phrases, field filters, and date comparisons only when you need them. Use `field:value` for broad matches, `=` / `<>` for exact field checks, and `date>=2026-03-24` style comparisons for time-based filters.',
    summaryKey: 'components.searchSyntax.summary',
    tips: [
      {
        text: 'Click any field or operator below to insert it into the search box.',
        translationKey: 'components.searchSyntax.tips.insert',
      },
      {
        text: 'Use the `date` field with `YYYY-MM-DD` or a full ISO timestamp such as `2026-03-24T10:00:00Z`.',
        translationKey: 'components.searchSyntax.tips.date',
      },
      {
        text: 'If you want literal text such as `AND`, `OR`, `NOT`, or `date`, wrap it in double quotes like `"AND"`.',
        translationKey: 'components.searchSyntax.tips.literal',
      },
      {
        text: 'Boolean operators, unary `-`, and parentheses can be combined with fielded and date searches.',
        translationKey: 'components.searchSyntax.tips.boolean',
      },
    ],
    operators: searchHelpOperators,
    fields: getFieldDefinitions(page, features),
    examples: getSearchHelpExamples(page, samples),
  };
}

export function compileAlertSearch(query: string, features: SearchFeatureFlags = {}): AlertSearchCompileResult {
  const help = getSearchHelpDefinition('alerts', features);
  const fieldMap = getFieldMap('alerts', features);
  const parsed = parseQuery(query, fieldMap);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, help };
  }

  return {
    ok: true,
    ast: parsed.ast,
    help,
    predicate: (alert) => parsed.ast === null || evaluateNode(parsed.ast, alert, alertFieldMatchers, matchAlertFreeText),
  };
}

export function compileDecisionSearch(query: string, features: SearchFeatureFlags = {}): DecisionSearchCompileResult {
  const help = getSearchHelpDefinition('decisions', features);
  const fieldMap = getFieldMap('decisions', features);
  const parsed = parseQuery(query, fieldMap);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, help };
  }

  return {
    ok: true,
    ast: parsed.ast,
    help,
    predicate: (decision) => parsed.ast === null || evaluateNode(parsed.ast, decision, decisionFieldMatchers, matchDecisionFreeText),
  };
}

export function analyzeSearchQuery(
  query: string,
  page: SearchPage,
  features: SearchFeatureFlags = {},
): SearchQueryAnalysis {
  const fieldMap = getFieldMap(page, features);
  const { trimmedQuery, trimOffset } = normalizeSearchQuery(query);

  if (!trimmedQuery) {
    return { tokens: [], error: null };
  }

  const tokenResult = tokenizeQuery(trimmedQuery, fieldMap);
  if (!tokenResult.ok) {
    return {
      tokens: [],
      error: shiftParseError(tokenResult.error, query, trimOffset),
    };
  }

  const tokens = classifyHighlightTokens(tokenResult.tokens, fieldMap).map((token) => ({
    ...token,
    start: token.start + trimOffset,
    end: token.end + trimOffset,
  }));
  const parser = new SearchParser(trimmedQuery, tokenResult.tokens, fieldMap);
  const parsed = parser.parse();

  return {
    tokens,
    error: parsed.ok ? null : shiftParseError(parsed.error, query, trimOffset),
  };
}

function getFieldDefinitions(page: SearchPage, features: SearchFeatureFlags): SearchFieldDefinition[] {
  const definitions = page === 'alerts' ? alertFieldDefinitions : decisionFieldDefinitions;
  return definitions.filter((definition) => isFieldAvailable(definition, features));
}

function getFieldMap(page: SearchPage, features: SearchFeatureFlags): FieldMap {
  const map: FieldMap = new Map();
  for (const definition of getFieldDefinitions(page, features)) {
    map.set(definition.name.toLowerCase(), definition);
    for (const alias of definition.aliases) {
      map.set(alias.toLowerCase(), definition);
    }
  }
  return map;
}

function isFieldAvailable(definition: SearchFieldDefinition, features: SearchFeatureFlags): boolean {
  void definition;
  void features;
  return true;
}

function parseQuery(query: string, fieldMap: FieldMap): { ok: true; ast: SearchNode | null } | { ok: false; error: SearchParseError } {
  const { trimmedQuery, trimOffset } = normalizeSearchQuery(query);
  if (!trimmedQuery) {
    return { ok: true, ast: null };
  }

  const tokenResult = tokenizeQuery(trimmedQuery, fieldMap);
  if (!tokenResult.ok) {
    return {
      ok: false,
      error: shiftParseError(tokenResult.error, query, trimOffset),
    };
  }

  const parser = new SearchParser(trimmedQuery, tokenResult.tokens, fieldMap);
  const parsed = parser.parse();
  if (!parsed.ok) {
    return {
      ok: false,
      error: shiftParseError(parsed.error, query, trimOffset),
    };
  }

  return parsed;
}

function tokenizeQuery(query: string, fieldMap: FieldMap): { ok: true; tokens: SearchToken[] } | { ok: false; error: SearchParseError } {
  const tokens: SearchToken[] = [];
  let index = 0;
  const lowercaseBooleanMode = enableLowercaseBooleanMode(query);

  while (index < query.length) {
    const char = query[index];

    if (isWhitespace(char)) {
      index += 1;
      continue;
    }

    if (char === '(') {
      tokens.push({ type: 'lparen', start: index, end: index + 1 });
      index += 1;
      continue;
    }

    if (char === ')') {
      tokens.push({ type: 'rparen', start: index, end: index + 1 });
      index += 1;
      continue;
    }

    if (char === '"') {
      const endIndex = findClosingQuote(query, index + 1);
      if (endIndex === -1) {
        return {
          ok: false,
          error: createParseError(query, 'Unterminated quoted phrase', index, 1),
        };
      }
      tokens.push({
        type: 'string',
        value: query.slice(index + 1, endIndex),
        start: index,
        end: endIndex + 1,
      });
      index = endIndex + 1;
      continue;
    }

    if (char === '-' && isUnaryMinusBoundary(query, index)) {
      tokens.push({ type: 'minus', start: index, end: index + 1 });
      index += 1;
      continue;
    }

    const start = index;
    let value = '';
    while (index < query.length) {
      const current = query[index];
      if (isWhitespace(current) || current === '(' || current === ')' || current === '"') {
        break;
      }

      if (shouldSplitComparator(value, query, index, fieldMap)) {
        break;
      }

      value += current;
      index += 1;
    }

    if (!value) {
      const comparator = readComparatorToken(query, index);
      if (comparator) {
        tokens.push({
          type: 'comparator',
          value: comparator.value,
          start: index,
          end: index + comparator.length,
        });
        index += comparator.length;
        continue;
      }

      return {
        ok: false,
        error: createParseError(query, `Unexpected character \`${query[index]}\``, index, 1),
      };
    }

    const operator = toOperatorToken(value, lowercaseBooleanMode);
    if (operator) {
      tokens.push({
        type: 'operator',
        value: operator,
        start,
        end: start + value.length,
      });
    } else {
      tokens.push({
        type: 'word',
        value,
        start,
        end: start + value.length,
      });
    }

    const comparator = readComparatorToken(query, index);
    if (comparator && shouldSplitComparator(value, query, index, fieldMap)) {
      tokens.push({
        type: 'comparator',
        value: comparator.value,
        start: index,
        end: index + comparator.length,
      });
      index += comparator.length;
    }
  }

  return { ok: true, tokens };
}

function normalizeSearchQuery(query: string): { trimmedQuery: string; trimOffset: number } {
  const trimmedQuery = query.trim();
  return {
    trimmedQuery,
    trimOffset: query.indexOf(trimmedQuery),
  };
}

function shiftParseError(error: SearchParseError, originalQuery: string, offset: number): SearchParseError {
  return {
    ...error,
    query: originalQuery,
    position: error.position + offset,
  };
}

function classifyHighlightTokens(tokens: SearchToken[], fieldMap: FieldMap): SearchHighlightToken[] {
  return tokens.map((token, index) => {
    if (token.type === 'word') {
      const nextToken = tokens[index + 1];
      const definition = fieldMap.get(token.value.toLowerCase());
      if (definition && nextToken?.type === 'comparator') {
        return {
          kind: 'field',
          start: token.start,
          end: token.end,
          value: token.value,
          normalizedValue: definition.name,
        };
      }

      return {
        kind: 'term',
        start: token.start,
        end: token.end,
        value: token.value,
      };
    }

    if (token.type === 'string') {
      return {
        kind: 'string',
        start: token.start,
        end: token.end,
        value: token.value,
      };
    }

    if (token.type === 'operator') {
      return {
        kind: 'booleanOperator',
        start: token.start,
        end: token.end,
        value: token.value,
        normalizedValue: token.value,
      };
    }

    if (token.type === 'comparator') {
      return {
        kind: 'comparator',
        start: token.start,
        end: token.end,
        value: token.value,
        normalizedValue: token.value === ':' ? ':' : normalizeComparisonOperator(token.value),
      };
    }

    if (token.type === 'minus') {
      return {
        kind: 'negation',
        start: token.start,
        end: token.end,
        value: '-',
      };
    }

    return {
      kind: 'paren',
      start: token.start,
      end: token.end,
      value: token.type === 'lparen' ? '(' : ')',
    };
  });
}

function shouldSplitComparator(currentValue: string, query: string, index: number, fieldMap: FieldMap): boolean {
  const comparator = readComparatorToken(query, index);
  if (!comparator) {
    return false;
  }

  const nextChar = query[index + comparator.length] || '';
  if (!currentValue) {
    return false;
  }

  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(currentValue)) {
    return false;
  }

  if (comparator.value === ':' && (nextChar === ':' || nextChar === '/')) {
    return false;
  }

  if (fieldMap.has(currentValue.toLowerCase())) {
    return true;
  }

  if (comparator.value === ':') {
    return nextChar === '"' || nextChar === '(' || /[A-Za-z_]/.test(nextChar) || isWhitespace(nextChar);
  }

  return nextChar === '"' || /[A-Za-z0-9_-]/.test(nextChar);
}

function readComparatorToken(query: string, index: number): { value: SearchComparatorTokenValue; length: number } | null {
  for (const value of ['<=', '>=', '=>', '<>', ':', '<', '>', '='] as const) {
    if (query.startsWith(value, index)) {
      return { value, length: value.length };
    }
  }
  return null;
}

function enableLowercaseBooleanMode(query: string): boolean {
  return /(^|\s)-(?=\S)|[()"]|[A-Za-z_][A-Za-z0-9_-]*\s*(?::|<=|>=|=>|<>|=|<|>)|\b(?:AND|OR|NOT)\b/.test(query);
}

function toOperatorToken(value: string, lowercaseBooleanMode: boolean): 'AND' | 'OR' | 'NOT' | null {
  const normalized = value.toUpperCase();
  if (!['AND', 'OR', 'NOT'].includes(normalized)) {
    return null;
  }

  if (value === normalized || lowercaseBooleanMode) {
    return normalized as 'AND' | 'OR' | 'NOT';
  }

  return null;
}

function findClosingQuote(query: string, startIndex: number): number {
  for (let index = startIndex; index < query.length; index += 1) {
    if (query[index] === '"') {
      return index;
    }
  }
  return -1;
}

function isUnaryMinusBoundary(query: string, index: number): boolean {
  const previous = query[index - 1];
  const next = query[index + 1];
  const previousAllowsUnary = previous === undefined || isWhitespace(previous) || previous === '(' || previous === ':' || previous === '=' || previous === '<' || previous === '>';
  return previousAllowsUnary && Boolean(next) && !isWhitespace(next);
}

class SearchParser {
  private index = 0;

  constructor(
    private readonly query: string,
    private readonly tokens: SearchToken[],
    private readonly fieldMap: FieldMap,
  ) {}

  parse(): { ok: true; ast: SearchNode | null } | { ok: false; error: SearchParseError } {
    if (this.tokens.length === 0) {
      return { ok: true, ast: null };
    }

    try {
      const ast = this.parseOr();
      if (this.current()) {
        const token = this.current()!;
        throw this.error(`Unexpected token \`${tokenToText(token)}\``, token.start, token.end - token.start, tokenToText(token));
      }
      return { ok: true, ast };
    } catch (error) {
      return { ok: false, error: error as SearchParseError };
    }
  }

  private parseOr(): SearchNode {
    let left = this.parseAnd();
    while (this.isOperator('OR')) {
      this.index += 1;
      left = {
        kind: 'binary',
        operator: 'OR',
        left,
        right: this.parseAnd(),
      };
    }
    return left;
  }

  private parseAnd(): SearchNode {
    let left = this.parseUnary();
    while (true) {
      if (this.isOperator('AND')) {
        this.index += 1;
      } else if (!this.isImplicitAndStart()) {
        break;
      }

      left = {
        kind: 'binary',
        operator: 'AND',
        left,
        right: this.parseUnary(),
      };
    }
    return left;
  }

  private parseUnary(): SearchNode {
    const token = this.current();
    if (!token) {
      throw this.error('Unexpected end of query', this.query.length, 0);
    }

    if (token.type === 'minus' || this.isOperator('NOT')) {
      this.index += 1;
      return {
        kind: 'not',
        expression: this.parseUnary(),
      };
    }

    if (this.isFieldPrefix()) {
      const fieldToken = this.current() as SearchToken & { type: 'word' };
      const comparatorToken = this.peek(1) as SearchToken & { type: 'comparator' };
      const definition = this.fieldMap.get(fieldToken.value.toLowerCase());
      if (!definition) {
        throw this.error(`Unknown field \`${fieldToken.value}\``, fieldToken.start, fieldToken.end - fieldToken.start, fieldToken.value);
      }

      this.index += 2;
      if (!this.current()) {
        throw this.error(`Missing search value after \`${fieldToken.value}${comparatorToken.value}\``, comparatorToken.end, 0, fieldToken.value);
      }

      if (comparatorToken.value === ':') {
        return {
          kind: 'field',
          field: definition.name,
          expression: this.parseUnary(),
        };
      }

      const operator = normalizeComparisonOperator(comparatorToken.value);
      if (!supportsComparisonOperator(definition, operator)) {
        throw this.error(
          `Operator \`${comparatorToken.value}\` is only supported for date fields`,
          comparatorToken.start,
          comparatorToken.end - comparatorToken.start,
          comparatorToken.value,
        );
      }

      const valueToken = this.current();
      if (!valueToken) {
        throw this.error(`Missing search value after \`${fieldToken.value}${comparatorToken.value}\``, comparatorToken.end, 0, fieldToken.value);
      }
      if (valueToken.type !== 'word' && valueToken.type !== 'string') {
        throw this.error(
          `Expected a value after \`${fieldToken.value}${comparatorToken.value}\``,
          valueToken.start,
          valueToken.end - valueToken.start,
          tokenToText(valueToken),
        );
      }

      if (definition.valueType === 'date' && parseSearchDateValue(valueToken.value) === null) {
        throw this.error(
          'Invalid date value. Use `YYYY-MM-DD` or an ISO timestamp',
          valueToken.start,
          valueToken.end - valueToken.start,
          valueToken.value,
        );
      }

      this.index += 1;
      return {
        kind: 'comparison',
        field: definition.name,
        operator,
        value: valueToken.value,
        quoted: valueToken.type === 'string',
      };
    }

    return this.parsePrimary();
  }

  private parsePrimary(): SearchNode {
    const token = this.current();
    if (!token) {
      throw this.error('Unexpected end of query', this.query.length, 0);
    }

    if (token.type === 'word' || token.type === 'string') {
      this.index += 1;
      return {
        kind: 'term',
        value: token.value,
        quoted: token.type === 'string',
      };
    }

    if (token.type === 'lparen') {
      this.index += 1;
      let expression: SearchNode;
      try {
        expression = this.parseOr();
      } catch (error) {
        const parseError = error as SearchParseError;
        if (parseError.message === 'Unexpected end of query') {
          throw this.error('Missing closing parenthesis', token.start, 1);
        }
        throw error;
      }
      const closing = this.current();
      if (!closing || closing.type !== 'rparen') {
        throw this.error('Missing closing parenthesis', token.start, 1);
      }
      this.index += 1;
      return expression;
    }

    throw this.error(`Unexpected token \`${tokenToText(token)}\``, token.start, token.end - token.start, tokenToText(token));
  }

  private isFieldPrefix(): boolean {
    const current = this.current();
    const next = this.peek(1);
    return current?.type === 'word' && next?.type === 'comparator';
  }

  private isImplicitAndStart(): boolean {
    const token = this.current();
    if (!token) {
      return false;
    }
    if (token.type === 'rparen' || (token.type === 'operator' && token.value === 'OR')) {
      return false;
    }
    return true;
  }

  private isOperator(operator: 'AND' | 'OR' | 'NOT'): boolean {
    const token = this.current();
    return token?.type === 'operator' && token.value === operator;
  }

  private current(): SearchToken | undefined {
    return this.tokens[this.index];
  }

  private peek(offset: number): SearchToken | undefined {
    return this.tokens[this.index + offset];
  }

  private error(message: string, position: number, length: number, token?: string): SearchParseError {
    return createParseError(this.query, message, position, length, token);
  }
}

function createParseError(query: string, message: string, position: number, length: number, token?: string): SearchParseError {
  return {
    message,
    position,
    length,
    query,
    token,
  };
}

function tokenToText(token: SearchToken): string {
  if (token.type === 'lparen') return '(';
  if (token.type === 'rparen') return ')';
  if (token.type === 'comparator') return token.value;
  if ('value' in token) {
    return token.value;
  }
  return '-';
}

function evaluateNode<T>(
  node: SearchNode,
  item: T,
  fieldMatchers: Record<string, (item: T, value: string) => boolean>,
  freeTextMatcher: (item: T, value: string) => boolean,
  scopedField?: string,
): boolean {
  switch (node.kind) {
    case 'term':
      if (scopedField) {
        return fieldMatchers[scopedField]?.(item, node.value) === true;
      }
      return freeTextMatcher(item, node.value);
    case 'comparison':
      return compareFieldValue(item, node.field, node.operator, node.value, fieldMatchers);
    case 'field':
      return evaluateNode(node.expression, item, fieldMatchers, freeTextMatcher, node.field);
    case 'not':
      return !evaluateNode(node.expression, item, fieldMatchers, freeTextMatcher, scopedField);
    case 'binary':
      if (node.operator === 'AND') {
        return evaluateNode(node.left, item, fieldMatchers, freeTextMatcher, scopedField) &&
          evaluateNode(node.right, item, fieldMatchers, freeTextMatcher, scopedField);
      }
      return evaluateNode(node.left, item, fieldMatchers, freeTextMatcher, scopedField) ||
        evaluateNode(node.right, item, fieldMatchers, freeTextMatcher, scopedField);
    default:
      return false;
  }
}

function matchAlertFreeText(alert: SlimAlert, value: string): boolean {
  const scenario = alert.scenario || '';
  const message = alert.message || '';
  const asName = alert.source?.as_name || '';
  const target = alert.target || '';
  const countryCode = alert.source?.cn || '';
  const countryName = getCountryName(countryCode);
  const machine = resolveMachineName(alert) || '';
  const origins = collectDistinctOrigins(alert.decisions);
  const simulationSearch = alert.simulated === true ? 'simulation simulated' : 'live';
  const sourceValues = getAlertSourceValues(alert);

  return sourceValues.some((candidate) => matchesIpSearchValue(candidate, value)) || [
    scenario,
    message,
    asName,
    target,
    countryCode,
    countryName,
    machine,
    alert.meta_search || '',
    simulationSearch,
    ...origins,
  ].some((candidate) => includesNormalized(candidate, value));
}

function matchDecisionFreeText(decision: DecisionListItem, value: string): boolean {
  const countryCode = decision.detail.country || '';
  const countryName = getCountryName(countryCode);
  const machine = decision.machine || '';
  const simulationSearch = decision.simulated === true ? 'simulation simulated' : 'live';

  return matchesIpSearchValue(decision.value, value) || [
    decision.detail.reason || decision.scenario || '',
    countryCode,
    countryName,
    decision.detail.as || '',
    decision.detail.action || '',
    decision.detail.type || '',
    decision.detail.origin || '',
    machine,
    simulationSearch,
  ].some((candidate) => includesNormalized(candidate, value));
}

function normalizeComparisonOperator(value: Exclude<SearchComparatorTokenValue, ':'>): SearchComparisonOperator {
  return value === '=>' ? '>=' : value;
}

function supportsComparisonOperator(definition: SearchFieldDefinition, operator: SearchComparisonOperator): boolean {
  if (operator === '=' || operator === '<>') {
    return true;
  }
  return definition.valueType === 'date';
}

function compareFieldValue<T>(
  item: T,
  field: string,
  operator: SearchComparisonOperator,
  value: string,
  fieldMatchers: Record<string, (item: T, value: string) => boolean>,
): boolean {
  if (field === 'date') {
    return compareDateValue((item as { created_at?: string }).created_at, operator, value);
  }

  const matcher = fieldMatchers[field];
  if (!matcher) {
    return false;
  }

  if (operator === '=') {
    return matcher(item, value);
  }

  if (operator === '<>') {
    return !matcher(item, value);
  }

  return false;
}

function getAlertSourceValues(alert: SlimAlert): string[] {
  return [alert.source?.ip, alert.source?.value, alert.source?.range].filter((value): value is string => Boolean(value));
}

export function matchesIpSearchValue(candidate: string | number | null | undefined, value: string): boolean {
  const normalizedCandidate = normalizeValue(candidate);
  const normalizedValue = normalizeValue(value);
  if (!normalizedCandidate || !normalizedValue) {
    return false;
  }

  if (normalizedCandidate === normalizedValue) {
    return true;
  }

  const filterCidr = parseCidrRange(normalizedValue);
  if (filterCidr) {
    const candidateIp = parseIpAddress(normalizedCandidate);
    if (candidateIp && candidateIp.version === filterCidr.version) {
      return cidrContainsIp(filterCidr, candidateIp);
    }

    const candidateCidr = parseCidrRange(normalizedCandidate);
    if (candidateCidr && candidateCidr.version === filterCidr.version) {
      return cidrContainsCidr(filterCidr, candidateCidr);
    }
  }

  return includesNormalized(normalizedCandidate, normalizedValue);
}

function includesNormalized(candidate: string | number | null | undefined, value: string): boolean {
  return normalizeValue(candidate).includes(normalizeValue(value));
}

function normalizeValue(value: string | number | null | undefined): string {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim().toLowerCase();
}

function matchesCountryField(countryCode: string, value: string): boolean {
  const normalizedValue = normalizeValue(value);
  if (!normalizedValue) {
    return false;
  }

  const normalizedCode = normalizeValue(countryCode);
  const normalizedName = normalizeValue(getCountryName(countryCode));

  // Treat short alphabetic searches as ISO country-code lookups so `DE`
  // does not accidentally match the `de` in names like `Sweden`.
  if (/^[a-z]{2}$/.test(normalizedValue)) {
    return normalizedCode === normalizedValue;
  }

  return normalizedName.includes(normalizedValue) || normalizedCode === normalizedValue;
}

function getCountryName(code?: string | null): string {
  if (!code) {
    return '';
  }
  try {
    return regionNames.of(code.toUpperCase()) || code;
  } catch {
    return code;
  }
}

function matchesSimulationTerm(isSimulated: boolean, value: string): boolean {
  const normalized = normalizeValue(value);
  if (['sim', 'simulated', 'simulation', 'true', 'yes', '1'].includes(normalized)) {
    return isSimulated;
  }
  if (['live', 'false', 'no', '0'].includes(normalized)) {
    return !isSimulated;
  }
  return false;
}

function isDecisionExpired(decision: DecisionListItem): boolean {
  return decision.expired === true;
}

function matchesDecisionStatus(decision: DecisionListItem, value: string): boolean {
  const normalized = normalizeValue(value);
  const isExpired = isDecisionExpired(decision);
  if (['expired', 'inactive'].includes(normalized)) {
    return isExpired;
  }
  if (['active', 'live'].includes(normalized)) {
    return !isExpired;
  }
  return false;
}

function matchesBoolean(candidate: boolean, value: string): boolean {
  const normalized = normalizeValue(value);
  if (['true', 'yes', '1'].includes(normalized)) {
    return candidate;
  }
  if (['false', 'no', '0'].includes(normalized)) {
    return !candidate;
  }
  return false;
}

type ParsedIpAddress = { version: 4 | 6; bits: 32 | 128; value: bigint };
type ParsedCidrRange = ParsedIpAddress & { prefix: number };

function parseCidrRange(value: string): ParsedCidrRange | null {
  const [addressText, prefixText, extraText] = value.split('/');
  if (extraText !== undefined || prefixText === undefined || !/^\d+$/.test(prefixText)) {
    return null;
  }

  const address = parseIpAddress(addressText);
  if (!address) {
    return null;
  }

  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > address.bits) {
    return null;
  }

  return { ...address, prefix };
}

function cidrContainsIp(cidr: ParsedCidrRange, address: ParsedIpAddress): boolean {
  if (cidr.version !== address.version) {
    return false;
  }

  const mask = getCidrMask(cidr.bits, cidr.prefix);
  return (cidr.value & mask) === (address.value & mask);
}

function cidrContainsCidr(filter: ParsedCidrRange, candidate: ParsedCidrRange): boolean {
  return filter.version === candidate.version &&
    candidate.prefix >= filter.prefix &&
    cidrContainsIp(filter, candidate);
}

function getCidrMask(bits: 32 | 128, prefix: number): bigint {
  if (prefix === 0) {
    return 0n;
  }

  return ((1n << BigInt(bits)) - 1n) ^ ((1n << BigInt(bits - prefix)) - 1n);
}

function parseIpAddress(value: string): ParsedIpAddress | null {
  if (value.includes(':')) {
    const parsed = parseIpv6Address(value);
    return parsed === null ? null : { version: 6, bits: 128, value: parsed };
  }

  const parsed = parseIpv4Address(value);
  return parsed === null ? null : { version: 4, bits: 32, value: parsed };
}

function parseIpv4Address(value: string): bigint | null {
  const parts = value.split('.');
  if (parts.length !== 4) {
    return null;
  }

  let result = 0n;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }

    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return null;
    }

    result = (result << 8n) + BigInt(octet);
  }
  return result;
}

function parseIpv6Address(value: string): bigint | null {
  const normalized = value.toLowerCase();
  const [leftText, rightText, extraText] = normalized.split('::');
  if (extraText !== undefined) {
    return null;
  }

  const leftParts = splitIpv6Parts(leftText || '');
  const rightParts = rightText === undefined ? [] : splitIpv6Parts(rightText || '');
  if (!leftParts || !rightParts) {
    return null;
  }

  const missingParts = 8 - leftParts.length - rightParts.length;
  if (rightText === undefined ? missingParts !== 0 : missingParts < 1) {
    return null;
  }

  const parts = [...leftParts, ...Array.from({ length: missingParts }, () => 0), ...rightParts];
  if (parts.length !== 8) {
    return null;
  }

  return parts.reduce((result, part) => (result << 16n) + BigInt(part), 0n);
}

function splitIpv6Parts(value: string): number[] | null {
  if (!value) {
    return [];
  }

  const parts = value.split(':');
  const parsed: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) {
      return null;
    }
    parsed.push(Number.parseInt(part, 16));
  }
  return parsed;
}

function compareDateValue(candidate: string | undefined, operator: SearchComparisonOperator, rawValue: string): boolean {
  const candidateTimestamp = parseIsoTimestamp(candidate);
  const filterRange = parseSearchDateValue(rawValue);
  if (candidateTimestamp === null || filterRange === null) {
    return false;
  }

  if (filterRange.precision === 'day') {
    switch (operator) {
      case '=':
        return candidateTimestamp >= filterRange.start && candidateTimestamp < filterRange.end;
      case '<>':
        return candidateTimestamp < filterRange.start || candidateTimestamp >= filterRange.end;
      case '<':
        return candidateTimestamp < filterRange.start;
      case '<=':
        return candidateTimestamp < filterRange.end;
      case '>':
        return candidateTimestamp >= filterRange.end;
      case '>=':
        return candidateTimestamp >= filterRange.start;
      default:
        return false;
    }
  }

  switch (operator) {
    case '=':
      return candidateTimestamp === filterRange.start;
    case '<>':
      return candidateTimestamp !== filterRange.start;
    case '<':
      return candidateTimestamp < filterRange.start;
    case '<=':
      return candidateTimestamp <= filterRange.start;
    case '>':
      return candidateTimestamp > filterRange.start;
    case '>=':
      return candidateTimestamp >= filterRange.start;
    default:
      return false;
  }
}

function parseSearchDateValue(value: string): { start: number; end: number; precision: 'day' | 'instant' } | null {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmedValue)) {
    const start = Date.parse(`${trimmedValue}T00:00:00.000Z`);
    if (Number.isNaN(start)) {
      return null;
    }

    return {
      start,
      end: start + 24 * 60 * 60 * 1000,
      precision: 'day',
    };
  }

  const timestamp = Date.parse(trimmedValue);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return {
    start: timestamp,
    end: timestamp,
    precision: 'instant',
  };
}

function parseIsoTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function isWhitespace(value: string): boolean {
  return /\s/.test(value);
}
