import type {
  DashboardGranularity,
  DashboardSimulationFilter,
  DashboardStatListItem,
  DashboardStatsBucket,
  DashboardWorldMapDatum,
} from '../../shared/contracts';
import { matchesIpSearchValue } from '../../shared/search';
import { getDateTimeKey, getTimeZoneOffsetMs, getZonedHourlyBucketKeys } from '../utils/date-time';
import {
  addDashboardAttackLocation,
  dashboardAttackLocationData,
} from '../dashboard-locations';
import type {
  DashboardAlertStatsRecord,
  DashboardDecisionAccumulator,
  DashboardDecisionStatsRecord,
  DashboardStatsAccumulator,
  DashboardStatsFilters,
} from './types';
import { parseSimulationBoolean } from './simulation';
import { matchesSimulationFilter } from './simulation';
import { getCountryName } from './country';

export function createDashboardStatsAccumulator(): DashboardStatsAccumulator {
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

export function createDashboardDecisionAccumulator(): DashboardDecisionAccumulator {
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

export function matchesDashboardSimulationFilter(isSimulated: boolean, filter: DashboardSimulationFilter): boolean {
  return matchesSimulationFilter(isSimulated, filter);
}

export function matchesDashboardAlertFilters(
  alert: DashboardAlertStatsRecord,
  filters: DashboardStatsFilters,
  searchPredicate: ((alert: DashboardAlertStatsRecord) => boolean) | null,
  includeDateRange: boolean,
): boolean {
  if (searchPredicate && !searchPredicate(alert)) return false;
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

export function matchesDashboardDecisionFilters(
  decision: DashboardDecisionStatsRecord,
  filters: DashboardStatsFilters,
  searchPredicate: ((decision: DashboardDecisionStatsRecord) => boolean) | null,
  alertIps: Set<string>,
  includeDateRange: boolean,
): boolean {
  if (searchPredicate && !searchPredicate(decision)) return false;
  if (filters.ip && !matchesIpSearchValue(decision.value, filters.ip)) return false;
  if (filters.country && decision.country !== filters.country) return false;
  if (filters.scenario && decision.scenario !== filters.scenario) return false;
  if (filters.as && decision.asName !== filters.as) return false;
  if (filters.target && decision.target !== filters.target) return false;

  // Legacy Dashboard requests supplied only an alert-oriented q. Preserve their
  // alert-to-decision relationship when no explicit decision query is present.
  if (
    !filters.decisionQ
    && requiresDashboardAlertIpJoin(filters)
    && (!decision.value || !alertIps.has(decision.value))
  ) {
    return false;
  }

  if (includeDateRange && !matchesDashboardDateRange(decision.createdAt, filters)) {
    return false;
  }

  return true;
}

export function requiresDashboardAlertIpJoin(filters: DashboardStatsFilters): boolean {
  return Boolean(filters.q || filters.country || filters.scenario || filters.as || filters.target);
}

export function matchesDashboardDateRange(isoString: string, filters: DashboardStatsFilters): boolean {
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

export function addDashboardAlert(accumulator: DashboardStatsAccumulator, alert: DashboardAlertStatsRecord, filters: DashboardStatsFilters): void {
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

export function addDashboardDecision(
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

export function selectDashboardDecisionPrimary(
  primaries: Map<string, DashboardDecisionStatsRecord>,
  candidate: DashboardDecisionStatsRecord,
): void {
  const valueKey = candidate.value === undefined ? '\u0001' : `\u0002${candidate.value}`;
  const key = `${candidate.instanceId}\u0000${valueKey}\u0000${candidate.simulated ? '1' : '0'}`;
  const current = primaries.get(key);
  if (!current || compareDashboardDecisionRank(candidate, current) > 0) {
    primaries.set(key, candidate);
  }
}

export function compareDashboardDecisionRank(
  left: DashboardDecisionStatsRecord,
  right: DashboardDecisionStatsRecord,
): number {
  if (left.stopTimestamp !== right.stopTimestamp) {
    return left.stopTimestamp - right.stopTimestamp;
  }

  const leftId = String(left.id);
  const rightId = String(right.id);
  const leftNumericId = /^\d+$/.test(leftId) ? Number(leftId) : -1;
  const rightNumericId = /^\d+$/.test(rightId) ? Number(rightId) : -1;
  if (leftNumericId !== rightNumericId) {
    return leftNumericId - rightNumericId;
  }
  return leftId.localeCompare(rightId);
}

export function normalizeDashboardCountryCode(country: string | undefined): string | undefined {
  const normalized = country?.trim().toUpperCase();
  return normalized && /^[A-Z]{2}$/.test(normalized) ? normalized : undefined;
}

export function normalizeDashboardCoordinate(value: unknown, minimum: number, maximum: number): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const coordinate = typeof value === 'number' ? value : Number(value.trim());
  return Number.isFinite(coordinate) && coordinate >= minimum && coordinate <= maximum ? coordinate : undefined;
}

export function addDashboardDecisionCountry(
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

export function incrementCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) || 0) + 1);
}

export function topDashboardEntries(map: Map<string, number>, limit = 10): DashboardStatListItem[] {
  return Array.from(map.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

export function dashboardCountryList(
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

export function dashboardWorldMapData(
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

export function dashboardBuckets(
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

export function getDashboardBucketKeys(
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

export function getDashboardBucketKey(isoString: string, filters: DashboardStatsFilters): string {
  return getDateTimeKey(isoString, filters.granularity === 'hour', filters.timezoneOffsetMinutes, filters.timeZone);
}

export function parseDashboardWallKey(key: string): Date {
  const [datePart, timePart] = key.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const hour = timePart === undefined ? 0 : Number(timePart);
  return new Date(Date.UTC(year, month - 1, day, hour, 0, 0, 0));
}

export function parseDashboardBucketKey(key: string, timezoneOffsetMinutes: number, timeZone: string | null): Date {
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

export function formatDashboardClientBucketKey(date: Date, granularity: DashboardGranularity): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  if (granularity === 'hour') {
    return `${year}-${month}-${day}T${String(date.getUTCHours()).padStart(2, '0')}`;
  }
  return `${year}-${month}-${day}`;
}

export function addDashboardBucketInterval(date: Date, granularity: DashboardGranularity): Date {
  const next = new Date(date);
  if (granularity === 'hour') {
    next.setUTCHours(next.getUTCHours() + 1);
  } else {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

export function getDashboardBucketFullDate(key: string, timezoneOffsetMinutes: number, timeZone: string | null): string {
  return parseDashboardBucketKey(key, timezoneOffsetMinutes, timeZone).toISOString();
}
