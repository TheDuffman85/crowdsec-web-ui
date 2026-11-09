import type { ManagedSettingSource } from './contracts';
import { parseDurationMs } from './duration';

export interface StatisticsSettings {
  enabled: boolean;
  retentionDays: number;
  jobInterval: string;
  jobTimeBudget: string;
}

export const DEFAULT_STATISTICS_SETTINGS: StatisticsSettings = {
  enabled: false, retentionDays: 90, jobInterval: '1h', jobTimeBudget: '30s',
};

export function validateStatisticsSettings(value: unknown): StatisticsSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('statistics must be an object');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !Object.prototype.hasOwnProperty.call(DEFAULT_STATISTICS_SETTINGS, key))) throw new Error('Unknown statistics setting');
  const settings = { ...DEFAULT_STATISTICS_SETTINGS, ...input } as StatisticsSettings;
  if (typeof settings.enabled !== 'boolean') throw new Error('statistics.enabled must be a boolean');
  if (!Number.isInteger(settings.retentionDays) || settings.retentionDays < 1 || settings.retentionDays > 3650) {
    throw new Error('statistics.retentionDays must be an integer between 1 and 3650');
  }
  if (typeof settings.jobInterval === 'string') settings.jobInterval = settings.jobInterval.trim();
  if (typeof settings.jobTimeBudget === 'string') settings.jobTimeBudget = settings.jobTimeBudget.trim();
  const interval = typeof settings.jobInterval === 'string' ? parseDurationMs(settings.jobInterval) : null;
  const budget = typeof settings.jobTimeBudget === 'string' ? parseDurationMs(settings.jobTimeBudget) : null;
  if (interval === null || interval < 300_000 || interval > 86_400_000) throw new Error('statistics.jobInterval must be between 5m and 24h');
  if (budget === null || budget < 1000 || budget > 60_000) throw new Error('statistics.jobTimeBudget must be between 1s and 60s');
  return settings;
}

export interface StatisticsStatus {
  running: boolean;
  lastSuccess: string | null;
  backlog: number;
  backfillPending: boolean;
  error: string | null;
  /** Archive revision after the last consolidation; changes whenever query results can change. */
  revision: number;
}

export interface StatisticsConfiguration {
  settings: StatisticsSettings;
  managed: Partial<Record<keyof StatisticsSettings, ManagedSettingSource>>;
  status: StatisticsStatus;
  /** IANA time zone whose calendar days the statistics are bucketed by. */
  timeZone: string;
}

export interface StatisticsFilters {
  from: string;
  to: string;
  instance: string;
  simulation: 'all' | 'live' | 'simulated';
  limit: 10 | 20 | 50;
  ip?: string;
  machine?: string;
  scenario?: string;
  country?: string;
  network?: string;
  target?: string;
}

/** Remediations of one decision type, such as ban or captcha, most frequent first. */
export interface StatisticsRemediationType { label: string; count: number }

export interface StatisticsRanking {
  value: string;
  label: string;
  instance?: string;
  machineId?: string;
  alerts: number;
  events: number;
  remediations: number;
  remediationTypes: StatisticsRemediationType[];
  uniqueIPs: number;
  machines: number;
  activeDays: number;
  firstActivity: string | null;
  lastActivity: string | null;
  country: string;
  asn: string;
  network: string;
  scenarios: Array<{ label: string; count: number }>;
  targetedMachines: Array<{ value: string; label: string; count: number }>;
  /** IP rankings only: the IP raised alerts on a later day than its first remediation in the range. */
  returnedAfterRemediation?: boolean;
}

/** Per-IP outcome counts; repeat attackers were active on more than one day. */
export interface StatisticsAttackerTotals {
  uniqueIPs: number;
  /** Alerting IPs with at least one decision of any type (ban, captcha, ...) linked to their alerts. */
  remediatedIPs: number;
  repeatAttackers: number;
  /** IPs that raised alerts on a later day than a remediation, including remediations before the range. */
  returnedAfterRemediation: number;
}

export interface StatisticsScenario {
  label: string;
  /** Alerts. */
  count: number;
  uniqueIPs: number;
  machines: number;
  remediations: number;
  remediationTypes: StatisticsRemediationType[];
  remediatedIPs: number;
  /** Days with alerts of the scenario in the range. */
  activeDays: number;
  firstActivity: string | null;
  lastActivity: string | null;
  /** Alerts in the preceding period of equal length, or null when it is not fully covered. */
  previous: number | null;
}

export interface StatisticsResponse {
  filters: StatisticsFilters;
  revision: number;
  configuration: StatisticsConfiguration;
  coverage: { from: string | null; through: string | null; partial: boolean; comparisonPartial: boolean };
  totals: StatisticsAttackerTotals & {
    alerts: number; events: number; remediations: number; decisions: number;
    /** Alerting IPs not seen in the archive before the range, or null without complete earlier coverage. */
    newIPs: number | null;
  };
  /** The preceding period of equal length, or null when it is not fully covered. */
  previousTotals: (Omit<StatisticsAttackerTotals, 'returnedAfterRemediation'> & { alerts: number; remediations: number; decisions: number }) | null;
  attackers: StatisticsRanking[];
  machines: StatisticsRanking[];
  /** Days, or hours (ISO timestamps) for ranges within the last STATISTICS_HOURLY_DAYS days. */
  series: Array<{ date: string; alerts: number | null; decisions: number | null }>;
  granularity: 'day' | 'hour';
  scenarios: StatisticsScenario[];
  countries: Array<{ label: string; count: number; uniqueIPs: number }>;
  /** Known alert targets, ranked by alert count. Older observations may have no target. */
  targets: Array<{ label: string; count: number; uniqueIPs: number }>;
  networks: Array<{ label: string; count: number; uniqueIPs: number }>;
  /** Remediations (alert-linked decisions) by decision type, such as ban or captcha; they add up to `totals.remediations`. */
  remediationTypes: StatisticsRemediationType[];
  decisionTypes: Array<{ label: string; count: number }>;
  decisionOrigins: Array<{ label: string; count: number }>;
  /** Machines with more alerts than in the preceding period. */
  increases: Array<{ value: string; label: string; current: number; previous: number; change: number }>;
  /** Machines that still raised alerts, but fewer than in the preceding period. */
  decreases: Array<{ value: string; label: string; current: number; previous: number; change: number }>;
  /** Machines that raised alerts in the preceding period but none in this one. */
  quietMachines: Array<{ value: string; label: string; previous: number }>;
}

/** Days, including today, whose activity is also kept per hour for the chart. */
export const STATISTICS_HOURLY_DAYS = 2;

/*
 * Statistics are bucketed by calendar days of one time zone (the configured TZ,
 * or the server's zone). Days are `YYYY-MM-DD` strings; day arithmetic uses UTC
 * dates so it is independent of daylight saving time.
 */
const HOUR_MS = 3_600_000;
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();
const offsetCache = new Map<string, number>();

/** UTC offset of `timeZone` in the UTC hour containing `stamp`, cached per hour. */
function zoneOffsetMs(stamp: number, timeZone: string): number {
  if (timeZone === 'UTC') return 0;
  const hour = Math.floor(stamp / HOUR_MS) * HOUR_MS;
  const key = `${timeZone}\u0000${hour}`;
  let offset = offsetCache.get(key);
  if (offset !== undefined) return offset;
  let formatter = offsetFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    offsetFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(hour);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((entry) => entry.type === type)?.value || 0);
  offset = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute')) - hour;
  if (offsetCache.size >= 100_000) offsetCache.clear();
  offsetCache.set(key, offset);
  return offset;
}

/** The calendar day of an instant in `timeZone`. */
export function statisticsDay(at: string | number, timeZone: string): string {
  const stamp = typeof at === 'number' ? at : Date.parse(at);
  return new Date(stamp + zoneOffsetMs(stamp, timeZone)).toISOString().slice(0, 10);
}

/** The instant (epoch ms) at which `day` begins in `timeZone`. */
export function statisticsDayStart(day: string, timeZone: string): number {
  const wall = Date.parse(`${day}T00:00:00.000Z`);
  const guess = wall - zoneOffsetMs(wall, timeZone);
  const start = wall - zoneOffsetMs(guess, timeZone);
  // Where midnight is skipped by a daylight saving change, the day starts at the transition.
  return statisticsDay(start, timeZone) === day ? start : guess;
}

export function addStatisticsDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** First retained day. */
export function statisticsCutoff(retentionDays: number, now = Date.now(), timeZone = 'UTC'): string {
  return addStatisticsDays(statisticsDay(now, timeZone), -(retentionDays - 1));
}

/** Drill-down data for one finding, loaded only when the finding is expanded. */
/** Rows a finding's detail lists first, and how far "Show more" can extend them. */
export const STATISTICS_DETAIL_PAGE = 25;
export const STATISTICS_DETAIL_MAX = 500;

/** `size` limits listed IPs and ranges (default STATISTICS_DETAIL_PAGE, at most STATISTICS_DETAIL_MAX). */
export type StatisticsDetailRequest =
  /** Top IPs in the filtered scope, optionally within one AS, with their address ranges. */
  | { kind: 'ips'; network?: string; size?: number }
  /** IPs that attacked again after a remediation; `history` includes remediations before the range. */
  | { kind: 'returned'; history: boolean; size?: number }
  /** Recent activity of machines compared with the preceding period. */
  | { kind: 'machines'; machines: string[] };

export interface StatisticsDetailIP {
  ip: string;
  alerts: number;
  remediations: number;
  remediationTypes: StatisticsRemediationType[];
  machines: number;
  activeDays: number;
  country: string;
  asn: string;
  network: string;
  lastActivity: string | null;
  /** First day with a remediation in the range. */
  firstRemediation: string | null;
  /** Remediated before the range. */
  remediatedBefore: boolean;
}

export interface StatisticsDetailMachine {
  value: string;
  /** Latest alert in the retained archive up to the end of the range. */
  lastActivity: string | null;
  scenarios: Array<{ label: string; current: number; previous: number }>;
  ips: Array<{ ip: string; alerts: number }>;
}

export type StatisticsDetails =
  /** `total` and `rangeTotal` count every matching IP and range, not only the listed ones. */
  | { kind: 'ips'; ips: StatisticsDetailIP[]; total: number; ranges: Array<{ range: string; ips: number; alerts: number }>; rangeTotal: number }
  | { kind: 'returned'; ips: StatisticsDetailIP[]; total: number }
  | { kind: 'machines'; machines: StatisticsDetailMachine[] };

/** IPv4 addresses group by /24 and IPv6 by /64, the usual blocks for one host or customer. */
export function statisticsAddressRange(ip: string): string {
  if (ip.includes('.') && !ip.includes(':')) {
    const parts = ip.split('.');
    return parts.length === 4 ? `${parts.slice(0, 3).join('.')}.0/24` : '';
  }
  const [head, tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = ip.includes('::') && tail ? tail.split(':') : [];
  if (right.some((group) => group.includes('.')) || left.some((group) => group.includes('.'))) return '';
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  if (groups.length !== 8) return '';
  return `${groups.slice(0, 4).map((group) => (parseInt(group, 16) || 0).toString(16)).join(':')}::/64`;
}
