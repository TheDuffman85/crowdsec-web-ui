import type { TimeFormat } from '../config';

const TIMESTAMP_KEYS = new Set([
  'timestamp',
  'expiration',
  'offline_since',
  'last_check',
]);
const DATE_TIME_KEY_FORMATTER_CACHE_MAX_ENTRIES = 32;
const dateTimeKeyFormatters = new Map<string, Intl.DateTimeFormat>();
const timeZoneOffsetFormatters = new Map<string, Intl.DateTimeFormat>();

function getCachedFormatter(
  cache: Map<string, Intl.DateTimeFormat>,
  key: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const formatter = new Intl.DateTimeFormat('en', options);
  cache.set(key, formatter);
  if (cache.size > DATE_TIME_KEY_FORMATTER_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  return formatter;
}

export function normalizeIsoTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
}

function isTimestampKey(key: string): boolean {
  return TIMESTAMP_KEYS.has(key) || key.endsWith('_at') || key.endsWith('At');
}

export function normalizeTimestampJson(rawData: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData) as unknown;
  } catch {
    return rawData;
  }

  let changed = false;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;

    for (const [key, entry] of Object.entries(value)) {
      if (isTimestampKey(key) && typeof entry === 'string') {
        const normalized = normalizeIsoTimestamp(entry);
        if (normalized !== entry) {
          (value as Record<string, unknown>)[key] = normalized;
          changed = true;
        }
      } else if (entry && typeof entry === 'object') {
        visit(entry);
      }
    }
  };

  visit(parsed);
  return changed ? JSON.stringify(parsed) : rawData;
}

export const normalizeCrowdsecTimestampJson = normalizeTimestampJson;

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
    const formatterKey = `${timeZone}\u0000${includeHour ? 'hour' : 'day'}`;
    const parts = getCachedFormatter(dateTimeKeyFormatters, formatterKey, {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      ...(includeHour ? { hour: '2-digit' as const, hourCycle: 'h23' as const } : {}),
    }).formatToParts(source);
    let year = '';
    let month = '';
    let day = '';
    let hour = '';
    for (const part of parts) {
      if (part.type === 'year') year = part.value;
      else if (part.type === 'month') month = part.value;
      else if (part.type === 'day') day = part.value;
      else if (part.type === 'hour') hour = part.value;
    }
    const dateKey = `${year}-${month}-${day}`;
    return includeHour ? `${dateKey}T${hour}` : dateKey;
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
  const parts = getCachedFormatter(timeZoneOffsetFormatters, timeZone, {
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
