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
  availability?: 'always' | 'machine' | 'origin';
  valueType?: SearchFieldValueType;
}

export interface SearchHelpExample {
  query: string;
  description: string;
}

export interface SearchHelpOperatorDefinition {
  label: string;
  insertText: string;
  description: string;
}

export interface SearchHelpDefinition {
  page: SearchPage;
  title: string;
  summary: string;
  tips: string[];
  operators: SearchHelpOperatorDefinition[];
  examples: SearchHelpExample[];
  fields: SearchFieldDefinition[];
}

export interface SearchParseError {
  message: string;
  position: number;
  length: number;
  query: string;
  token?: string;
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
  { name: 'id', aliases: [], description: 'Exact alert ID' },
  { name: 'scenario', aliases: [], description: 'Scenario name' },
  { name: 'message', aliases: [], description: 'Alert message text' },
  { name: 'ip', aliases: ['source'], description: 'Source IP, value, or range' },
  { name: 'country', aliases: [], description: 'Country code or name' },
  { name: 'as', aliases: [], description: 'Autonomous system / provider name' },
  { name: 'target', aliases: [], description: 'Alert target' },
  { name: 'date', aliases: ['created', 'created_at', 'time'], description: 'Alert creation date or ISO timestamp', valueType: 'date' },
  { name: 'sim', aliases: ['simulation'], description: 'Simulation state (`live` or `simulated`)' },
  { name: 'machine', aliases: [], description: 'Machine alias or ID', availability: 'machine' },
  { name: 'origin', aliases: [], description: 'Decision origin', availability: 'origin' },
];

const decisionFieldDefinitions: SearchFieldDefinition[] = [
  { name: 'id', aliases: [], description: 'Exact decision ID' },
  { name: 'alert', aliases: ['alert_id'], description: 'Linked alert ID' },
  { name: 'scenario', aliases: ['reason'], description: 'Decision scenario / reason' },
  { name: 'ip', aliases: ['value'], description: 'Decision IP or range' },
  { name: 'country', aliases: [], description: 'Country code or name' },
  { name: 'as', aliases: [], description: 'Autonomous system / provider name' },
  { name: 'target', aliases: [], description: 'Decision target' },
  { name: 'date', aliases: ['created', 'created_at', 'time'], description: 'Decision creation date or ISO timestamp', valueType: 'date' },
  { name: 'action', aliases: [], description: 'Decision action' },
  { name: 'type', aliases: [], description: 'Decision type' },
  { name: 'status', aliases: [], description: 'Decision status (`active` or `expired`)' },
  { name: 'duplicate', aliases: [], description: 'Duplicate state (`true` or `false`)' },
  { name: 'sim', aliases: ['simulation'], description: 'Simulation state (`live` or `simulated`)' },
  { name: 'machine', aliases: [], description: 'Machine alias or ID', availability: 'machine' },
  { name: 'origin', aliases: [], description: 'Decision origin', availability: 'origin' },
];

const alertExamples: SearchHelpExample[] = [
  { query: 'ssh hetzner', description: 'Normal free-text search across the existing alert fields' },
  { query: '"nginx bf"', description: 'Find an exact phrase' },
  { query: 'country:germany ssh', description: 'Mix fielded search with normal free-text terms' },
  { query: 'date>=2026-03-24 AND date<2026-03-25', description: 'Filter alerts by date or timestamp ranges' },
  { query: 'origin:(manual OR CAPI) AND -sim:simulated', description: 'Use grouping, boolean logic, and negation' },
  { query: 'machine:host-a AND target:ssh', description: 'Match a specific machine and target when available' },
];

const decisionExamples: SearchHelpExample[] = [
  { query: 'manual live', description: 'Normal free-text search across the existing decision fields' },
  { query: 'status:active AND action:ban', description: 'Filter semantic decision fields' },
  { query: 'date>=2026-03-24 AND action:ban', description: 'Combine date filters with semantic decision fields' },
  { query: 'alert:123 OR ip:"192.168.5.0/24"', description: 'Search by linked alert or a quoted IP/range' },
  { query: 'origin:(manual OR CAPI) AND -duplicate:true', description: 'Exclude duplicates while grouping origins' },
  { query: 'machine:host-a AND sim:live', description: 'Limit results to one machine and live decisions' },
];

const searchHelpOperators: SearchHelpOperatorDefinition[] = [
  { label: 'AND', insertText: ' AND ', description: 'Both expressions must match' },
  { label: 'OR', insertText: ' OR ', description: 'Either expression may match' },
  { label: 'NOT', insertText: 'NOT ', description: 'Negate the next expression' },
  { label: '-', insertText: '-', description: 'Short negation for a single term or field' },
  { label: ':', insertText: ':', description: 'Broad field match, for example `country:germany`' },
  { label: '=', insertText: '=', description: 'Exact match, for example `origin=manual` or `date=2026-03-24`' },
  { label: '<>', insertText: '<>', description: 'Exclude a value, for example `sim<>simulated`' },
  { label: '>', insertText: '>', description: 'Date is after the supplied value, for example `date>2026-03-24`' },
  { label: '>=', insertText: '>=', description: 'Date is on or after the supplied value, for example `date>=2026-03-24`' },
  { label: '<', insertText: '<', description: 'Date is before the supplied value, for example `date<2026-03-24`' },
  { label: '<=', insertText: '<=', description: 'Date is on or before the supplied value, for example `date<=2026-03-24`' },
];

const alertFieldMatchers: AlertFieldMatcherMap = {
  id: (alert, value) => normalizeValue(alert.id) === normalizeValue(value),
  scenario: (alert, value) => includesNormalized(alert.scenario, value),
  message: (alert, value) => includesNormalized(alert.message, value),
  ip: (alert, value) => getAlertSourceValues(alert).some((candidate) => includesNormalized(candidate, value)),
  country: (alert, value) => {
    const countryCode = alert.source?.cn || '';
    return includesNormalized(countryCode, value) || includesNormalized(getCountryName(countryCode), value);
  },
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
  ip: (decision, value) => includesNormalized(decision.value, value),
  country: (decision, value) => {
    const countryCode = decision.detail.country || '';
    return includesNormalized(countryCode, value) || includesNormalized(getCountryName(countryCode), value);
  },
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

export function getSearchHelpDefinition(page: SearchPage, features: SearchFeatureFlags = {}): SearchHelpDefinition {
  return {
    page,
    title: page === 'alerts' ? 'Alert Search Syntax' : 'Decision Search Syntax',
    summary: 'Start with normal free-text search, then add exact phrases, field filters, and date comparisons only when you need them. Use `field:value` for broad matches, `=` / `<>` for exact field checks, and `date>=2026-03-24` style comparisons for time-based filters.',
    tips: [
      'Click any field or operator below to insert it into the search box.',
      'Use the `date` field with `YYYY-MM-DD` or a full ISO timestamp such as `2026-03-24T10:00:00Z`.',
      'If you want literal text such as `AND`, `OR`, `NOT`, or `date`, wrap it in double quotes like `"AND"`.',
      'Boolean operators, unary `-`, and parentheses can be combined with fielded and date searches.',
    ],
    operators: searchHelpOperators,
    fields: getFieldDefinitions(page, features),
    examples: page === 'alerts' ? alertExamples : decisionExamples,
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
  if (definition.availability === 'machine') {
    return features.machineEnabled === true;
  }
  if (definition.availability === 'origin') {
    return features.originEnabled === true;
  }
  return true;
}

function parseQuery(query: string, fieldMap: FieldMap): { ok: true; ast: SearchNode | null } | { ok: false; error: SearchParseError } {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return { ok: true, ast: null };
  }

  const tokenResult = tokenizeQuery(trimmedQuery, fieldMap);
  if (!tokenResult.ok) {
    return tokenResult;
  }

  const parser = new SearchParser(trimmedQuery, tokenResult.tokens, fieldMap);
  return parser.parse();
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

  return [
    scenario,
    message,
    asName,
    target,
    countryCode,
    countryName,
    machine,
    alert.meta_search || '',
    simulationSearch,
    ...getAlertSourceValues(alert),
    ...origins,
  ].some((candidate) => includesNormalized(candidate, value));
}

function matchDecisionFreeText(decision: DecisionListItem, value: string): boolean {
  const countryCode = decision.detail.country || '';
  const countryName = getCountryName(countryCode);
  const machine = decision.machine || '';
  const simulationSearch = decision.simulated === true ? 'simulation simulated' : 'live';

  return [
    decision.value || '',
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

function includesNormalized(candidate: string | number | null | undefined, value: string): boolean {
  return normalizeValue(candidate).includes(normalizeValue(value));
}

function normalizeValue(value: string | number | null | undefined): string {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim().toLowerCase();
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

function matchesDecisionStatus(decision: DecisionListItem, value: string): boolean {
  const normalized = normalizeValue(value);
  const isExpired = decision.expired === true || (decision.detail.duration || '').startsWith('-');
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
