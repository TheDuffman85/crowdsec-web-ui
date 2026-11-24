import { addStatisticsDays, type StatisticsResponse } from '../../../shared/statistics';
import { apiUrl } from './basePath';
import { sessionFetch } from './sessionFetch';

type SeriesRow = StatisticsResponse['series'][number];

export interface CompareRow {
  date: string;
  alerts: number | null;
  decisions: number | null;
  previousDate: string | null;
  previousAlerts: number | null;
  previousDecisions: number | null;
}

/** The period of equal length that ends the day before `from`. Both ends are inclusive days. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const length = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  return { from: addStatisticsDays(from, -length), to: addStatisticsDays(from, -1) };
}

/** Lines the two periods up bucket by bucket (first with first), so they can share an axis. */
export function alignSeries(current: SeriesRow[], previous: SeriesRow[] | null): CompareRow[] {
  return current.map((row, index) => {
    const before = previous?.[index];
    return {
      date: row.date, alerts: row.alerts, decisions: row.decisions,
      previousDate: before?.date ?? null, previousAlerts: before?.alerts ?? null, previousDecisions: before?.decisions ?? null,
    };
  });
}

/** Percent change, or null when there is nothing to compare against. */
export function percentChange(current: number, previous: number): number | null {
  return previous === 0 ? null : Math.round(((current - previous) / previous) * 100);
}

export function totalOf(series: SeriesRow[], key: 'alerts' | 'decisions'): number {
  return series.reduce((sum, row) => sum + (row[key] ?? 0), 0);
}

/** Loads the statistics of the period before the given query. */
export async function fetchPreviousStatistics(query: URLSearchParams, signal?: AbortSignal): Promise<StatisticsResponse> {
  const from = query.get('from');
  const to = query.get('to');
  if (!from || !to) throw new Error('A date range is required');
  const shifted = new URLSearchParams(query);
  const range = previousRange(from, to);
  shifted.set('from', range.from);
  shifted.set('to', range.to);
  const response = await sessionFetch(`${apiUrl('/api/statistics')}?${shifted}`, { signal });
  if (!response.ok) throw new Error('Failed to load the previous period');
  return response.json() as Promise<StatisticsResponse>;
}

/** Loads statistics for whole days, over all instances and live activity. */
export async function fetchStatisticsRange(from: string, to: string, signal?: AbortSignal): Promise<StatisticsResponse> {
  const query = new URLSearchParams({ from, to, instance: 'all', simulation: 'live', limit: '10' });
  const response = await sessionFetch(`${apiUrl('/api/statistics')}?${query}`, { signal });
  if (!response.ok) throw new Error('Failed to load statistics');
  return response.json() as Promise<StatisticsResponse>;
}
