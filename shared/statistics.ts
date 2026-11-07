import type { ManagedSettingSource } from './contracts';
import { parseDurationMs } from './duration';

export interface StatisticsSettings {
  enabled: boolean;
  retentionDays: number;
  jobInterval: string;
  jobTimeBudget: string;
}

export const DEFAULT_STATISTICS_SETTINGS: StatisticsSettings = {
  enabled: false, retentionDays: 365, jobInterval: '1h', jobTimeBudget: '30s',
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
}

export interface StatisticsResponse {
  filters: StatisticsFilters;
  revision: number;
  configuration: StatisticsConfiguration;
  coverage: { from: string | null; through: string | null; partial: boolean; comparisonPartial: boolean };
  totals: { alerts: number; events: number; uniqueIPs: number; bans: number; decisions: number; repeatAttackers: number };
  attackers: StatisticsRanking[];
  machines: StatisticsRanking[];
  series: Array<{ date: string; alerts: number | null; decisions: number | null }>;
  scenarios: Array<{ label: string; count: number }>;
  countries: Array<{ label: string; count: number }>;
  networks: Array<{ label: string; count: number }>;
  decisionTypes: Array<{ label: string; count: number }>;
  decisionOrigins: Array<{ label: string; count: number }>;
  hours: number[];
  weekdays: number[];
  increases: Array<{ value: string; label: string; current: number; previous: number; change: number }>;
}

export function statisticsCutoff(retentionDays: number, now = Date.now()): string {
  return new Date(Date.parse(new Date(now).toISOString().slice(0, 10)) - (retentionDays - 1) * 86_400_000).toISOString().slice(0, 10);
}
