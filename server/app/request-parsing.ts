import type {
  DashboardSimulationFilter,
  FacetField,
  PaginatedResponse,
  SlimAlert,
  DecisionListItem,
} from '../../shared/contracts';
import type { SearchParseError } from '../../shared/search';
import { matchesIpSearchValue } from '../../shared/search';
import { getDateTimeKey } from '../utils/date-time';
import type {
  AlertListFilters,
  DashboardStatsFilters,
  DecisionListFilters,
  FacetRequest,
  PageRequest,
} from './types';
import { getDateFilterBoundary } from './search-sql';
import { getCountryName } from './country';
import { matchesSimulationFilter } from './simulation';

type HonoContext = any;

const FACET_DEFAULT_LIMIT = 10;
const FACET_MAX_LIMIT = 50;
const FACET_MAX_OFFSET = 500;

export function getPageRequest(context: HonoContext): PageRequest | null {
  if (!context.req.query('page')) {
    return null;
  }

  const page = Math.max(1, Number.parseInt(context.req.query('page') || '1', 10) || 1);
  const pageSize = Math.min(200, Math.max(10, Number.parseInt(context.req.query('page_size') || '50', 10) || 50));
  return { page, pageSize };
}

export function toPaginatedResponse<T>(
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

export function getAlertListFilters(context: HonoContext, timeZone: string | null): AlertListFilters {
  return getAlertListFiltersFromValues((key) => context.req.query(key), timeZone);
}

export function getFacetRequest(
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
    searchValues: parseFacetSearchValues(context.req.query('search_values')),
    offset: clampInteger(context.req.query('offset'), 0, FACET_MAX_OFFSET, 0),
    limit: clampInteger(context.req.query('limit'), 1, FACET_MAX_LIMIT, FACET_DEFAULT_LIMIT),
  };
}

export function parseFacetSearchValues(rawValue: string | undefined): string[] {
  if (!rawValue) return [];
  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean))]
      .slice(0, 700);
  } catch {
    return [];
  }
}

export function clampInteger(
  rawValue: string | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const parsed = Number.parseInt(rawValue || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function withoutAlertFacetFilter(filters: AlertListFilters, field: FacetField): AlertListFilters {
  const result = { ...filters };
  if (field === 'instance') result.instanceId = 'all';
  if (field === 'country') result.country = '';
  if (field === 'scenario') result.scenario = '';
  if (field === 'as') result.as = '';
  if (field === 'ip') result.ip = '';
  if (field === 'target') result.target = '';
  return result;
}

export function withoutDecisionFacetFilter(filters: DecisionListFilters, field: FacetField): DecisionListFilters {
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

export function getAlertListFiltersFromValues(readValue: (key: string) => string | undefined, timeZone: string | null): AlertListFilters {
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

export function getDecisionListFilters(context: HonoContext, timeZone: string | null): DecisionListFilters {
  return getDecisionListFiltersFromValues((key) => context.req.query(key), timeZone);
}

export function getDecisionListFiltersFromValues(readValue: (key: string) => string | undefined, timeZone: string | null): DecisionListFilters {
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

export function getDashboardStatsFilters(context: HonoContext, timeZone: string | null): DashboardStatsFilters {
  return {
    instanceId: context.req.query('instance') || 'all',
    q: context.req.query('q') || '',
    decisionQ: context.req.query('decision_q') ?? context.req.query('q') ?? '',
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

export function parseDashboardSimulationFilter(value: string | undefined): DashboardSimulationFilter {
  if (value === 'live' || value === 'simulated') {
    return value;
  }

  return 'all';
}


export function lowerQuery(context: HonoContext, key: string): string {
  return lowerValue(context.req.query(key));
}

export function lowerValue(value: string | undefined): string {
  return (value || '').toLowerCase();
}

export function toSearchErrorResponse(error: SearchParseError): { error: string; details: SearchParseError } {
  return {
    error: error.message,
    details: error,
  };
}

export function parseTimezoneOffset(context: HonoContext): number {
  return parseTimezoneOffsetValue(context.req.query('tz_offset'));
}

export function parseTimezoneOffsetValue(rawValue: string | undefined): number {
  const value = Number.parseInt(rawValue || '0', 10);
  return Number.isFinite(value) ? value : 0;
}

export function getEffectiveRequestTimeZone(context: HonoContext, configuredTimeZone: string | null): string | null {
  return getEffectiveRequestTimeZoneValue(context.req.query('browser_tz'), configuredTimeZone);
}

export function getEffectiveRequestTimeZoneValue(browserTimeZone: string | undefined, configuredTimeZone: string | null): string | null {
  return configuredTimeZone || sanitizeRequestTimeZone(browserTimeZone);
}

export function sanitizeRequestTimeZone(value: string | undefined): string | null {
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

export function parseRecordExtras(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function readExtraString(value: string | null | undefined, key: string): string | undefined {
  const candidate = parseRecordExtras(value)[key];
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}

export function readExtraStringArray(
  value: string | null | undefined,
  key: string,
  fallback?: string | null,
): string[] | undefined {
  const candidate = parseRecordExtras(value)[key];
  const values = Array.isArray(candidate)
    ? candidate.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  if (values.length > 0) return [...new Set(values.map((item) => item.trim()))];
  return typeof fallback === 'string' && fallback.trim() ? [fallback.trim()] : undefined;
}

export function matchesAlertListFilters(alert: SlimAlert, filters: AlertListFilters): boolean {
  if (!matchesSimulationFilter(alert.simulated === true, filters.simulation)) return false;

  const scenario = (alert.scenario || '').toLowerCase();
  const cn = (alert.source?.cn || '').toLowerCase();
  const asName = (alert.source?.as_name || '').toLowerCase();

  if (filters.ip && !getSlimAlertSourceValues(alert).some((value) => matchesIpSearchValue(value, filters.ip))) return false;
  if (filters.country && !cn.includes(filters.country)) return false;
  if (filters.scenario && !scenario.includes(filters.scenario)) return false;
  if (filters.as && !asName.includes(filters.as)) return false;
  if (filters.target && ![...(alert.targets || []), alert.target || '']
    .some((target) => target.toLowerCase().includes(filters.target))) return false;
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

export function matchesDecisionListFilters(decision: DecisionListItem, filters: DecisionListFilters): boolean {
  if (!filters.showDuplicates && decision.is_duplicate) return false;
  if (filters.alertId && String(decision.detail.alert_id) !== filters.alertId) return false;
  if (!matchesSimulationFilter(decision.simulated === true, filters.simulation)) return false;
  if (filters.country && decision.detail.country !== filters.country) return false;
  if (filters.scenario && decision.detail.reason !== filters.scenario) return false;
  if (filters.as && decision.detail.as !== filters.as) return false;
  if (filters.ip && !matchesIpSearchValue(decision.value, filters.ip)) return false;

  if (filters.target) {
    const value = (decision.value || '').toLowerCase();
    const matchesTarget = [...(decision.detail.targets || []), decision.detail.target || '']
      .some((target) => target.toLowerCase().includes(filters.target));
    if (!value.includes(filters.target) && !matchesTarget) return false;
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

export function getSlimAlertSourceValues(alert: SlimAlert): string[] {
  return [alert.source?.ip, alert.source?.value, alert.source?.range]
    .filter((value): value is string => Boolean(value));
}

export function isDecisionListItemExpired(decision: DecisionListItem): boolean {
  return decision.expired === true;
}
