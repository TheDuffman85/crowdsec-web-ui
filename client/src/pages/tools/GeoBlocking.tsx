import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { CountryFlag } from '../../components/CountryFlag';
import { ToolMessage, ToolPage } from '../../components/ToolPage';
import { addDecisions, fetchConfig } from '../../lib/api';
import { fetchGeoBlocking, type GeoBlockingSummary } from '../../lib/insightsApi';
import { impactOf } from '../../lib/geoBlocking';
import { useI18n } from '../../lib/i18n';
import { useOptionalToast } from '../../contexts/useToast';
import { getCountryName } from '../../lib/utils';

const PERIODS = [24, 24 * 7, 24 * 30, 24 * 90];
const DURATIONS = ['24h', '168h', '720h', '2160h', '8760h'];

/** Pick countries, see how much recent attack traffic they account for, then block them with one Country-scope ban each. */
export function GeoBlocking() {
  const { t, language } = useI18n();
  const toast = useOptionalToast();
  const [hours, setHours] = useState(PERIODS[1]!);
  const [summary, setSummary] = useState<GeoBlockingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [duration, setDuration] = useState(DURATIONS[2]!);
  const [reason, setReason] = useState('');
  const [canWrite, setCanWrite] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSummary(await fetchGeoBlocking(hours));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('tools.geo.loadFailed'));
    }
  }, [hours, t]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [load]);
  useEffect(() => {
    void fetchConfig().then((config) => setCanWrite(config.permissions?.can_manage_enforcement !== false)).catch(() => undefined);
  }, []);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (summary?.countries ?? []).filter((country) => !needle
      || country.code.toLowerCase().includes(needle)
      || (getCountryName(country.code, language) ?? '').toLowerCase().includes(needle));
  }, [filter, language, summary]);

  const impact = summary ? impactOf(summary, selected) : null;

  const toggle = (code: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });

  const apply = async () => {
    if (!selected.size) return;
    setBusy(true);
    try {
      const result = await addDecisions({
        values: [...selected],
        value_scope: 'country',
        duration,
        reason: reason.trim() || 'geo-block',
        type: 'ban',
      });
      toast?.addToast(t('tools.geo.applied', { count: result.added.length }), 'success');
      setSelected(new Set());
      setReason('');
      await load();
    } catch (applyError) {
      toast?.addToast(applyError instanceof Error ? applyError.message : t('tools.geo.applyFailed'), 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ToolPage title={t('tools.geo.title')} description={t('tools.geo.description')}>
      <ToolMessage tone="warning">{t('tools.geo.bouncerWarning')}</ToolMessage>
      {error && <ToolMessage tone="error">{error}</ToolMessage>}
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>{t('tools.geo.countries')}</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t('tools.geo.filter')}
              aria-label={t('tools.geo.filter')}
              className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
            <select
              value={hours}
              onChange={(event) => setHours(Number(event.target.value))}
              aria-label={t('tools.geo.period')}
              className="h-9 rounded-lg border border-gray-300 bg-white px-2 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            >
              {PERIODS.map((value) => <option key={value} value={value}>{t('tools.geo.periodDays', { days: value / 24 })}</option>)}
            </select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {!summary && !error && <p className="p-6 text-sm text-gray-500">{t('app.loading')}</p>}
          {summary && visible.length === 0 && <p className="p-6 text-sm text-gray-500">{t('tools.geo.empty')}</p>}
          {visible.length > 0 && (
            <div className="max-h-[28rem] overflow-auto">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-gray-50 text-xs uppercase text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                  <tr>
                    <th className="w-10 px-4 py-2" />
                    <th className="px-4 py-2">{t('tools.geo.country')}</th>
                    <th className="px-4 py-2 text-right">{t('tools.geo.alerts')}</th>
                    <th className="px-4 py-2 text-right">{t('tools.geo.uniqueIps')}</th>
                    <th className="px-4 py-2">{t('tools.geo.status')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                  {visible.map((country) => (
                    <tr key={country.code}>
                      <td className="px-4 py-2">
                        <input
                          type="checkbox"
                          checked={selected.has(country.code)}
                          disabled={country.blocked || !canWrite}
                          onChange={() => toggle(country.code)}
                          aria-label={t('tools.geo.select', { country: getCountryName(country.code, language) ?? country.code })}
                        />
                      </td>
                      <td className="px-4 py-2">
                        <span className="inline-flex items-center gap-2">
                          <CountryFlag code={country.code} />
                          <span className="text-gray-900 dark:text-gray-100">{getCountryName(country.code, language) ?? country.code}</span>
                          <span className="font-mono text-xs text-gray-500">{country.code}</span>
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{country.alerts}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{country.unique_ips}</td>
                      <td className="px-4 py-2">{country.blocked && <Badge variant="danger">{t('tools.geo.blocked')}</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('tools.geo.apply')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {!canWrite && <ToolMessage>{t('tools.geo.readOnly')}</ToolMessage>}
          <p className="text-sm text-gray-700 dark:text-gray-300" data-testid="geo-impact">
            {selected.size === 0
              ? t('tools.geo.nothingSelected')
              : t('tools.geo.impact', { countries: selected.size, alerts: impact?.alerts ?? 0, share: impact?.share ?? 0, ips: impact?.uniqueIps ?? 0, days: hours / 24 })}
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm text-gray-700 dark:text-gray-300">
              <span className="mb-1 block">{t('tools.geo.duration')}</span>
              <select value={duration} onChange={(event) => setDuration(event.target.value)} className="h-9 rounded-lg border border-gray-300 bg-white px-2 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100">
                {DURATIONS.map((value) => <option key={value} value={value}>{t('tools.geo.durationDays', { days: Number.parseInt(value, 10) / 24 })}</option>)}
              </select>
            </label>
            <label className="min-w-[14rem] flex-1 text-sm text-gray-700 dark:text-gray-300">
              <span className="mb-1 block">{t('tools.geo.reason')}</span>
              <input value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} className="h-9 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
            </label>
            <button
              type="button"
              disabled={busy || !selected.size || !canWrite}
              onClick={() => void apply()}
              className="h-9 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('tools.geo.blockSelected', { count: selected.size })}
            </button>
          </div>
        </CardContent>
      </Card>
    </ToolPage>
  );
}
