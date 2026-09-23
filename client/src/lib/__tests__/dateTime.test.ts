import { describe, expect, test } from 'vitest';
import { formatDateTimeValue, formatDateValue, formatTimeValue } from '../dateTime';

describe('date and time formatting', () => {
  const timestamp = '2025-01-01T13:34:56.000Z';

  test('applies a fixed timezone and 24-hour clock', () => {
    const settings = { timeZone: 'Europe/Berlin', timeFormat: '24h' as const, dateFormat: 'browser' as const };
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
    const settings = { timeZone: 'UTC', timeFormat: '12h' as const, dateFormat: 'browser' as const };
    expect(formatDateTimeValue(timestamp, settings)).toBe(new Date(timestamp).toLocaleString(undefined, {
      timeZone: 'UTC',
      hour12: true,
    }));
  });

  test('formats complete dates as dd/mm/yyyy and keeps the configured 24-hour clock', () => {
    const settings = { timeZone: 'Europe/Berlin', timeFormat: '24h' as const, dateFormat: 'dd/mm/yyyy' as const };
    expect(formatDateValue(timestamp, settings)).toBe('01/01/2025');
    expect(formatDateTimeValue(timestamp, settings)).toBe('01/01/2025, 14:34:56');
  });

  test('keeps the browser clock style when only the date format is overridden', () => {
    const settings = { timeZone: 'UTC', timeFormat: 'browser' as const, dateFormat: 'dd/mm/yyyy' as const };
    expect(formatDateTimeValue(timestamp, settings)).toBe(`01/01/2025, ${new Date(timestamp).toLocaleTimeString(undefined, { timeZone: 'UTC' })}`);
  });

  test('keeps a configured 12-hour clock with dd/mm/yyyy dates', () => {
    const settings = { timeZone: 'UTC', timeFormat: '12h' as const, dateFormat: 'dd/mm/yyyy' as const };
    expect(formatDateTimeValue(timestamp, settings)).toMatch(/^01\/01\/2025, 1:34:56 pm$/i);
  });

  test('supports reordered fields, month names, and literal text', () => {
    const settings = { timeZone: 'UTC', timeFormat: '24h' as const, dateFormat: 'yyyy-MM-dd' };
    expect(formatDateValue(timestamp, settings)).toBe('2025-01-01');
    expect(formatDateTimeValue(timestamp, settings)).toBe('2025-01-01, 13:34:56');
    expect(formatDateValue(timestamp, { ...settings, dateFormat: "d 'of' MMMM yyyy" })).toBe(
      `1 of ${new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', month: 'long' }).format(new Date(timestamp))} 2025`,
    );
  });

  test('formats the date in the selected timezone, including across a day boundary', () => {
    const settings = { timeZone: 'America/Los_Angeles', timeFormat: '24h' as const, dateFormat: 'mm/dd/yy' };
    expect(formatDateValue(timestamp, settings)).toBe('01/01/25');
    expect(formatDateValue('2025-01-01T01:00:00.000Z', settings)).toBe('12/31/24');
  });

  test('preserves invalid source timestamps', () => {
    expect(formatDateTimeValue('not-a-date', { timeZone: 'UTC', timeFormat: '24h', dateFormat: 'browser' })).toBe('not-a-date');
  });
});
