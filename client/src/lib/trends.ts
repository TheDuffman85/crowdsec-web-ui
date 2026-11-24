import type { DashboardStatsBucket } from '../types';

export type TrendUnit = 'days' | 'hours';
export type TrendDirection = 'up' | 'down' | 'flat';

export interface Trend {
  values: number[];
  /** Number of buckets in each compared window. */
  windowSize: number;
  unit: TrendUnit;
  current: number;
  previous: number;
  /** Percent change against the previous window, or null when the previous window was empty. */
  percentChange: number | null;
  direction: TrendDirection;
}

const WEEK_DAYS = 7;
const DAY_HOURS = 24;

/**
 * Compares the latest window of buckets against the window before it: a week
 * against the preceding week for daily buckets, a day against the preceding
 * day for hourly ones. When the range is too short for two full windows, the
 * range is split in half instead. Returns null with fewer than two buckets.
 */
export function computeTrend(buckets: DashboardStatsBucket[], unit: TrendUnit): Trend | null {
  if (buckets.length < 2) return null;
  const preferred = unit === 'days' ? WEEK_DAYS : DAY_HOURS;
  const windowSize = Math.min(preferred, Math.floor(buckets.length / 2));
  const values = buckets.map((bucket) => bucket.count);
  const sum = (items: number[]) => items.reduce((total, value) => total + value, 0);
  const current = sum(values.slice(-windowSize));
  const previous = sum(values.slice(-windowSize * 2, -windowSize));
  const percentChange = previous === 0 ? null : Math.round(((current - previous) / previous) * 100);
  const direction: TrendDirection = current > previous ? 'up' : current < previous ? 'down' : 'flat';
  return { values, windowSize, unit, current, previous, percentChange, direction };
}

/** Polyline points for an SVG sparkline in a `width` by `height` box. */
export function sparklinePoints(values: number[], width: number, height: number, padding = 2): string {
  if (values.length === 0) return '';
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;
  const step = values.length > 1 ? innerWidth / (values.length - 1) : 0;
  return values
    .map((value, index) => {
      const x = values.length > 1 ? padding + index * step : width / 2;
      const y = max === min ? height / 2 : padding + innerHeight - ((value - min) / range) * innerHeight;
      return `${round(x)},${round(y)}`;
    })
    .join(' ');
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
