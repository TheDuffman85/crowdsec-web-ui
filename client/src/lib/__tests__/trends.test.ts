import { describe, expect, test } from 'vitest';
import type { DashboardStatsBucket } from '../../types';
import { computeTrend, sparklinePoints } from '../trends';

const buckets = (counts: number[]): DashboardStatsBucket[] =>
  counts.map((count, index) => ({ date: `d${index}`, fullDate: `2026-11-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`, count }));

describe('computeTrend', () => {
  test('compares the latest week with the week before for daily buckets', () => {
    const trend = computeTrend(buckets([...Array(7).fill(10), ...Array(7).fill(15)]), 'days')!;
    expect(trend).toMatchObject({ windowSize: 7, current: 105, previous: 70, percentChange: 50, direction: 'up', unit: 'days' });
    expect(trend.values).toHaveLength(14);
  });

  test('uses the latest week even when more history is available', () => {
    const trend = computeTrend(buckets([999, ...Array(7).fill(4), ...Array(7).fill(2)]), 'days')!;
    expect(trend).toMatchObject({ windowSize: 7, current: 14, previous: 28, percentChange: -50, direction: 'down' });
  });

  test('splits a short range in half', () => {
    const trend = computeTrend(buckets([1, 1, 1, 4, 4, 4]), 'days')!;
    expect(trend).toMatchObject({ windowSize: 3, current: 12, previous: 3, percentChange: 300, direction: 'up' });
    expect(computeTrend(buckets([2, 8, 5]), 'days')).toMatchObject({ windowSize: 1, current: 5, previous: 8 });
  });

  test('uses a day of hourly buckets as the window', () => {
    const trend = computeTrend(buckets([...Array(24).fill(1), ...Array(24).fill(1)]), 'hours')!;
    expect(trend).toMatchObject({ windowSize: 24, current: 24, previous: 24, percentChange: 0, direction: 'flat', unit: 'hours' });
  });

  test('reports no percentage when the previous window was empty', () => {
    const trend = computeTrend(buckets([0, 0, 3, 3]), 'days')!;
    expect(trend.percentChange).toBeNull();
    expect(trend.direction).toBe('up');
  });

  test('needs at least two buckets', () => {
    expect(computeTrend([], 'days')).toBeNull();
    expect(computeTrend(buckets([5]), 'days')).toBeNull();
  });
});

describe('sparklinePoints', () => {
  test('scales values into the box with the highest value at the top', () => {
    expect(sparklinePoints([0, 5, 10], 100, 20, 0)).toBe('0,20 50,10 100,0');
  });

  test('draws a flat line in the middle and handles single or empty series', () => {
    expect(sparklinePoints([3, 3, 3], 100, 20, 0)).toBe('0,10 50,10 100,10');
    expect(sparklinePoints([4], 100, 20)).toBe('50,10');
    expect(sparklinePoints([], 100, 20)).toBe('');
  });
});
