import { createContext, useContext } from 'react';

export type TimeFormat = 'browser' | '12h' | '24h';

export interface DateTimeSettings {
  timeZone: string | null;
  timeFormat: TimeFormat;
}

export interface DateTimeContextValue extends DateTimeSettings {
  formatDate: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  formatTime: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  formatDateTime: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
}

export const DEFAULT_DATE_TIME_SETTINGS: DateTimeSettings = { timeZone: null, timeFormat: 'browser' };

function toDate(value: Date | string | number): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function withSettings(settings: DateTimeSettings, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions {
  return {
    ...options,
    ...(settings.timeZone ? { timeZone: settings.timeZone } : {}),
    ...(settings.timeFormat === 'browser' ? {} : { hour12: settings.timeFormat === '12h' }),
  };
}

export function formatDateValue(value: Date | string | number, settings: DateTimeSettings, options: Intl.DateTimeFormatOptions = {}): string {
  const date = toDate(value);
  return date ? date.toLocaleDateString(undefined, withSettings(settings, options)) : String(value);
}

export function formatTimeValue(value: Date | string | number, settings: DateTimeSettings, options: Intl.DateTimeFormatOptions = {}): string {
  const date = toDate(value);
  return date ? date.toLocaleTimeString(undefined, withSettings(settings, options)) : String(value);
}

export function formatDateTimeValue(value: Date | string | number, settings: DateTimeSettings, options: Intl.DateTimeFormatOptions = {}): string {
  const date = toDate(value);
  return date ? date.toLocaleString(undefined, withSettings(settings, options)) : String(value);
}

export function getBrowserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function createDateTimeContextValue(settings: DateTimeSettings): DateTimeContextValue {
  return {
    ...settings,
    formatDate: (value, options) => formatDateValue(value, settings, options),
    formatTime: (value, options) => formatTimeValue(value, settings, options),
    formatDateTime: (value, options) => formatDateTimeValue(value, settings, options),
  };
}

export const DateTimeContext = createContext<DateTimeContextValue | null>(null);

export function useDateTime(): DateTimeContextValue {
  return useContext(DateTimeContext) ?? createDateTimeContextValue(DEFAULT_DATE_TIME_SETTINGS);
}
