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
}

export interface StatisticsRanking {
  value: string;
  label: string;
  instance?: string;
  machineId?: string;
  alerts: number;
  events: number;
  bans: number;
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
  /** IP rankings only: the IP raised alerts on a later UTC day than its first ban in the range. */
  returnedAfterBan?: boolean;
}

/** Per-IP outcome counts; repeat attackers were active on more than one UTC day. */
export interface StatisticsAttackerTotals {
  uniqueIPs: number;
  /** Alerting IPs with at least one ban linked to their alerts. */
  bannedIPs: number;
  repeatAttackers: number;
  /** IPs that raised alerts on a later UTC day than a ban, including bans before the range. */
  returnedAfterBan: number;
}

export interface StatisticsScenario {
  label: string;
  /** Alerts. */
  count: number;
  uniqueIPs: number;
  machines: number;
  bans: number;
  bannedIPs: number;
  /** Alerts in the preceding period of equal length, or null when it is not fully covered. */
  previous: number | null;
}

export interface StatisticsResponse {
  filters: StatisticsFilters;
  revision: number;
  configuration: StatisticsConfiguration;
  coverage: { from: string | null; through: string | null; partial: boolean; comparisonPartial: boolean };
  totals: StatisticsAttackerTotals & {
    alerts: number; events: number; bans: number; decisions: number;
    /** Alerting IPs not seen in the archive before the range, or null without complete earlier coverage. */
    newIPs: number | null;
  };
  /** The preceding period of equal length, or null when it is not fully covered. */
  previousTotals: (Omit<StatisticsAttackerTotals, 'returnedAfterBan'> & { alerts: number; bans: number; decisions: number }) | null;
  attackers: StatisticsRanking[];
  machines: StatisticsRanking[];
  /** UTC days, or UTC hours (ISO timestamps) for ranges within the last STATISTICS_HOURLY_DAYS days. */
  series: Array<{ date: string; alerts: number | null; decisions: number | null }>;
  granularity: 'day' | 'hour';
  scenarios: StatisticsScenario[];
  countries: Array<{ label: string; count: number; uniqueIPs: number }>;
  /** Known alert targets, ranked by alert count. Older observations may have no target. */
  targets: Array<{ label: string; count: number; uniqueIPs: number }>;
  networks: Array<{ label: string; count: number; uniqueIPs: number }>;
  decisionTypes: Array<{ label: string; count: number }>;
  decisionOrigins: Array<{ label: string; count: number }>;
  /** Machines with more alerts than in the preceding period. */
  increases: Array<{ value: string; label: string; current: number; previous: number; change: number }>;
  /** Machines that still raised alerts, but fewer than in the preceding period. */
  decreases: Array<{ value: string; label: string; current: number; previous: number; change: number }>;
  /** Machines that raised alerts in the preceding period but none in this one. */
  quietMachines: Array<{ value: string; label: string; previous: number }>;
}

/** UTC days, including today, whose activity is also kept per hour for the chart. */
export const STATISTICS_HOURLY_DAYS = 2;

export function statisticsCutoff(retentionDays: number, now = Date.now()): string {
  return new Date(Date.parse(new Date(now).toISOString().slice(0, 10)) - (retentionDays - 1) * 86_400_000).toISOString().slice(0, 10);
}

/** Drill-down data for one finding, loaded only when the finding is expanded. */
/** Rows a finding's detail lists first, and how far "Show more" can extend them. */
export const STATISTICS_DETAIL_PAGE = 25;
export const STATISTICS_DETAIL_MAX = 500;

/** `size` limits listed IPs and ranges (default STATISTICS_DETAIL_PAGE, at most STATISTICS_DETAIL_MAX). */
export type StatisticsDetailRequest =
  /** Top IPs in the filtered scope, optionally within one AS, with their address ranges. */
  | { kind: 'ips'; network?: string; size?: number }
  /** IPs that attacked again after a ban; `history` includes bans before the range. */
  | { kind: 'returned'; history: boolean; size?: number }
  /** Recent activity of machines compared with the preceding period. */
  | { kind: 'machines'; machines: string[] };

export interface StatisticsDetailIP {
  ip: string;
  alerts: number;
  bans: number;
  machines: number;
  activeDays: number;
  country: string;
  asn: string;
  network: string;
  lastActivity: string | null;
  /** First UTC day with a ban in the range. */
  firstBan: string | null;
  /** Banned before the range. */
  bannedBefore: boolean;
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
