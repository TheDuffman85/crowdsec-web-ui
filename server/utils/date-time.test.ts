import { describe, expect, test } from 'vitest';
import {
  formatDateTime,
  getDateTimeKey,
  getZonedHourlyBucketKeys,
  normalizeCrowdsecTimestampJson,
  normalizeIsoTimestamp,
  normalizeTimestampJson,
} from './date-time';

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

  test('normalizes equivalent ISO timestamps to UTC with millisecond precision', () => {
    expect(normalizeIsoTimestamp('2026-07-14T08:56:33-04:00')).toBe('2026-07-14T12:56:33.000Z');
    expect(normalizeIsoTimestamp('2026-07-14T12:56:33Z')).toBe('2026-07-14T12:56:33.000Z');
    expect(normalizeIsoTimestamp('not-a-timestamp')).toBe('not-a-timestamp');
  });

  test('normalizes CrowdSec timestamps throughout cached JSON', () => {
    const rawData = JSON.stringify({
      created_at: '2026-07-14T08:56:33-04:00',
      start_at: '2026-07-14T08:55:00-04:00',
      events: [{ timestamp: '2026-07-14T12:55:30Z' }],
      decisions: [{ stop_at: '2026-07-14T13:43:55.732Z' }],
    });

    expect(JSON.parse(normalizeCrowdsecTimestampJson(rawData))).toEqual({
      created_at: '2026-07-14T12:56:33.000Z',
      start_at: '2026-07-14T12:55:00.000Z',
      events: [{ timestamp: '2026-07-14T12:55:30.000Z' }],
      decisions: [{ stop_at: '2026-07-14T13:43:55.732Z' }],
    });
  });

  test('normalizes timestamp fields in generic persisted JSON without changing ordinary text', () => {
    const rawData = JSON.stringify({
      created_at: '2026-07-14T12:56:33Z',
      delivery: { attempted_at: '2026-07-14T08:56:34-04:00' },
      status: { offline_since: '2026-07-14T12:50:00Z', last_check: '2026-07-14T12:57:00Z' },
      expiration: '2026-07-14T13:56:33Z',
      description: 'Created at noon',
    });

    expect(JSON.parse(normalizeTimestampJson(rawData))).toEqual({
      created_at: '2026-07-14T12:56:33.000Z',
      delivery: { attempted_at: '2026-07-14T12:56:34.000Z' },
      status: {
        offline_since: '2026-07-14T12:50:00.000Z',
        last_check: '2026-07-14T12:57:00.000Z',
      },
      expiration: '2026-07-14T13:56:33.000Z',
      description: 'Created at noon',
    });
  });
});
