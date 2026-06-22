import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { fetchConfig } from './api';
import {
  DEFAULT_DATE_TIME_SETTINGS,
  DateTimeContext,
  formatDateTimeValue,
  formatDateValue,
  formatTimeValue,
  type DateTimeSettings,
} from './dateTime';

export function DateTimeProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<DateTimeSettings>(DEFAULT_DATE_TIME_SETTINGS);

  useEffect(() => {
    let cancelled = false;
    void fetchConfig()
      .then((config) => {
        if (!cancelled) {
          setSettings({
            timeZone: config.time_zone ?? null,
            timeFormat: config.time_format ?? 'browser',
          });
        }
      })
      .catch((error) => console.error('Failed to load date and time configuration', error));
    return () => {
      cancelled = true;
    };
  }, []);

  const formatDate = useCallback(
    (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => formatDateValue(value, settings, options),
    [settings],
  );
  const formatTime = useCallback(
    (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => formatTimeValue(value, settings, options),
    [settings],
  );
  const formatDateTime = useCallback(
    (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => formatDateTimeValue(value, settings, options),
    [settings],
  );
  const value = useMemo(
    () => ({ ...settings, formatDate, formatTime, formatDateTime }),
    [formatDate, formatDateTime, formatTime, settings],
  );

  return <DateTimeContext.Provider value={value}>{children}</DateTimeContext.Provider>;
}
