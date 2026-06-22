import { describe, expect, test } from 'vitest';
import { formatDateTimeValue, formatTimeValue } from './dateTime';

describe('date and time formatting', () => {
  const timestamp = '2025-01-01T13:34:56.000Z';

  test('applies a fixed timezone and 24-hour clock', () => {
    const settings = { timeZone: 'Europe/Berlin', timeFormat: '24h' as const };
    expect(formatTimeValue(timestamp, settings, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })).toBe(new Date(timestamp).toLocaleTimeString(undefined, {
      timeZone: 'Europe/Berlin',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }));
  });

  test('supports a 12-hour clock independently of timezone', () => {
    const settings = { timeZone: 'UTC', timeFormat: '12h' as const };
    expect(formatDateTimeValue(timestamp, settings)).toBe(new Date(timestamp).toLocaleString(undefined, {
      timeZone: 'UTC',
      hour12: true,
    }));
  });

  test('preserves invalid source timestamps', () => {
    expect(formatDateTimeValue('not-a-date', { timeZone: 'UTC', timeFormat: '24h' })).toBe('not-a-date');
  });
});
