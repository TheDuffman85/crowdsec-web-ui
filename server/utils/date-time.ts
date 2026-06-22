import type { TimeFormat } from '../config';

export function getHour12(timeFormat: TimeFormat): boolean | undefined {
  if (timeFormat === '12h') return true;
  if (timeFormat === '24h') return false;
  return undefined;
}

export function formatDateTime(
  date: Date,
  timeZone: string | null,
  timeFormat: TimeFormat,
): string {
  return date.toLocaleString(undefined, {
    ...(timeZone ? { timeZone } : {}),
    ...(timeFormat === 'browser' ? {} : { hour12: getHour12(timeFormat) }),
  });
}

export function getDateTimeKey(
  isoString: string,
  includeHour: boolean,
  timezoneOffsetMinutes: number,
  timeZone: string | null = null,
): string {
  const source = new Date(isoString);
  if (timeZone) {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      ...(includeHour ? { hour: '2-digit' as const, hourCycle: 'h23' as const } : {}),
    }).formatToParts(source);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value || '';
    const dateKey = `${part('year')}-${part('month')}-${part('day')}`;
    return includeHour ? `${dateKey}T${part('hour')}` : dateKey;
  }

  const localDate = new Date(source.getTime() - timezoneOffsetMinutes * 60_000);
  const year = localDate.getUTCFullYear();
  const month = String(localDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(localDate.getUTCDate()).padStart(2, '0');
  return includeHour
    ? `${year}-${month}-${day}T${String(localDate.getUTCHours()).padStart(2, '0')}`
    : `${year}-${month}-${day}`;
}

export function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((entry) => entry.type === type)?.value || 0);
  const representedAsUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  return representedAsUtc - Math.floor(date.getTime() / 1_000) * 1_000;
}

function parseWallDateTimeKey(key: string): number {
  const [datePart, timePart] = key.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  return Date.UTC(year, month - 1, day, Number(timePart || 0), 0, 0, 0);
}

export function zonedDateTimeKeyToDate(key: string, timeZone: string): Date {
  const wallTime = parseWallDateTimeKey(key);
  let instant = new Date(wallTime);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    instant = new Date(wallTime - getTimeZoneOffsetMs(instant, timeZone));
  }
  return instant;
}

export function getZonedHourlyBucketKeys(startKey: string, endKey: string, timeZone: string): string[] {
  const end = zonedDateTimeKeyToDate(endKey, timeZone);
  let cursor = zonedDateTimeKeyToDate(startKey, timeZone);
  const keys: string[] = [];

  while (cursor <= end) {
    const key = getDateTimeKey(cursor.toISOString(), true, 0, timeZone);
    if (keys[keys.length - 1] !== key && key >= startKey && key <= endKey) {
      keys.push(key);
    }
    cursor = new Date(cursor.getTime() + 60 * 60 * 1_000);
  }

  return keys;
}
