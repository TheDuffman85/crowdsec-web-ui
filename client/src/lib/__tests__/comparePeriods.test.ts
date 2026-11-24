import { describe, expect, test } from 'vitest';
import { alignSeries, percentChange, previousRange, totalOf } from '../comparePeriods';

describe('comparePeriods', () => {
  test('previousRange is the period of equal length just before', () => {
    expect(previousRange('2026-11-14', '2026-11-20')).toEqual({ from: '2026-11-07', to: '2026-11-13' });
    expect(previousRange('2026-11-20', '2026-11-20')).toEqual({ from: '2026-11-19', to: '2026-11-19' });
    expect(previousRange('2026-03-01', '2026-03-31')).toEqual({ from: '2026-01-29', to: '2026-02-28' });
  });

  test('alignSeries pairs buckets by position and tolerates a shorter or missing baseline', () => {
    const current = [{ date: 'd3', alerts: 5, decisions: 2 }, { date: 'd4', alerts: null, decisions: null }, { date: 'd5', alerts: 1, decisions: 0 }];
    const previous = [{ date: 'd1', alerts: 3, decisions: 1 }, { date: 'd2', alerts: 4, decisions: null }];
    expect(alignSeries(current, previous)).toEqual([
      { date: 'd3', alerts: 5, decisions: 2, previousDate: 'd1', previousAlerts: 3, previousDecisions: 1 },
      { date: 'd4', alerts: null, decisions: null, previousDate: 'd2', previousAlerts: 4, previousDecisions: null },
      { date: 'd5', alerts: 1, decisions: 0, previousDate: null, previousAlerts: null, previousDecisions: null },
    ]);
    expect(alignSeries(current, null).every((row) => row.previousAlerts === null)).toBe(true);
  });

  test('percentChange and totals', () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(50, 100)).toBe(-50);
    expect(percentChange(5, 0)).toBeNull();
    expect(totalOf([{ date: 'a', alerts: 2, decisions: null }, { date: 'b', alerts: null, decisions: 3 }, { date: 'c', alerts: 4, decisions: 1 }], 'alerts')).toBe(6);
  });
});
