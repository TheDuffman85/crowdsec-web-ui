import { describe, expect, test } from 'vitest';
import { formatDateTime, getDateTimeKey, getZonedHourlyBucketKeys } from './date-time';

describe('server date and time helpers', () => {
  test('uses the configured IANA timezone on both sides of a DST jump', () => {
    expect(getDateTimeKey('2026-03-29T00:30:00.000Z', true, 720, 'Europe/Berlin')).toBe('2026-03-29T01');
    expect(getDateTimeKey('2026-03-29T01:30:00.000Z', true, 720, 'Europe/Berlin')).toBe('2026-03-29T03');
  });

  test('skips missing hours and deduplicates repeated hours in dashboard buckets', () => {
    expect(getZonedHourlyBucketKeys('2026-03-29T01', '2026-03-29T04', 'Europe/Berlin')).toEqual([
      '2026-03-29T01',
      '2026-03-29T03',
      '2026-03-29T04',
    ]);
    expect(getZonedHourlyBucketKeys('2026-10-25T01', '2026-10-25T04', 'Europe/Berlin')).toEqual([
      '2026-10-25T01',
      '2026-10-25T02',
      '2026-10-25T03',
      '2026-10-25T04',
    ]);
  });

  test('retains numeric browser-offset behavior without TZ', () => {
    expect(getDateTimeKey('2026-03-29T01:30:00.000Z', true, -120)).toBe('2026-03-29T03');
  });

  test('applies the configured hour cycle to server-generated timestamps', () => {
    const date = new Date('2026-03-29T13:30:00.000Z');
    expect(formatDateTime(date, 'UTC', '24h')).toBe(date.toLocaleString(undefined, { timeZone: 'UTC', hour12: false }));
    expect(formatDateTime(date, 'UTC', '12h')).toBe(date.toLocaleString(undefined, { timeZone: 'UTC', hour12: true }));
  });
});
