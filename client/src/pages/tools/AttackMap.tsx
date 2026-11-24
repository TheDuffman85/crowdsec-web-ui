import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { CountryFlag } from '../../components/CountryFlag';
import { ToolMessage, ToolPage } from '../../components/ToolPage';
import { fetchGeoBlocking, type GeoBlockingSummary, type GeoCountrySummary } from '../../lib/insightsApi';
import { intensity, loadCountryShapes, MAP_HEIGHT, MAP_WIDTH, type CountryShape } from '../../lib/worldGeo';
import { useI18n } from '../../lib/i18n';
import { getCountryName } from '../../lib/utils';

const PERIODS = [24, 24 * 7, 24 * 30, 24 * 90];

/** Where attacks come from, coloured by alert volume. Click a country to see its numbers and jump to its alerts. */
export function AttackMap() {
  const { t, language } = useI18n();
  const [hours, setHours] = useState(PERIODS[1]!);
  const [summary, setSummary] = useState<GeoBlockingSummary | null>(null);
  const [shapes, setShapes] = useState<CountryShape[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSummary(await fetchGeoBlocking(hours));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('tools.attackMap.loadFailed'));
    }
  }, [hours, t]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [load]);
  useEffect(() => {
    let active = true;
    loadCountryShapes()
      .then((loaded) => { if (active) setShapes(loaded); })
      .catch(() => { if (active) setError(t('tools.attackMap.mapFailed')); });
    return () => { active = false; };
  }, [t]);

  const byCode = useMemo(() => new Map((summary?.countries ?? []).map((country) => [country.code, country])), [summary]);
  const withAlerts = useMemo(() => (summary?.countries ?? []).filter((country) => country.alerts > 0), [summary]);
  const max = withAlerts[0]?.alerts ?? 0;
  const current: GeoCountrySummary | null = selected ? byCode.get(selected) ?? { code: selected, alerts: 0, unique_ips: 0, blocked: false } : null;
  const countryName = (code: string) => getCountryName(code, language) ?? code;
  const share = (country: GeoCountrySummary) => (summary && summary.total_alerts > 0 ? Math.round((country.alerts / summary.total_alerts) * 1000) / 10 : 0);

  return (
    <ToolPage
      title={t('tools.attackMap.title')}
      description={t('tools.attackMap.description')}
      actions={(
        <select value={hours} onChange={(event) => setHours(Number(event.target.value))} aria-label={t('tools.geo.period')} className="h-9 rounded-lg border border-gray-300 bg-white px-2 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100">
          {PERIODS.map((value) => <option key={value} value={value}>{t('tools.geo.periodDays', { days: value / 24 })}</option>)}
        </select>
      )}
    >
      {error && <ToolMessage tone="error">{error}</ToolMessage>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="p-3">
            {!shapes && !error && <p className="p-6 text-center text-sm text-gray-500">{t('common.loadingMap')}</p>}
            {shapes && (
              <svg viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} className="h-auto w-full" role="group" aria-label={t('tools.attackMap.title')} data-testid="attack-map">
                {shapes.map((shape) => {
                  const country = byCode.get(shape.code);
                  const volume = country?.alerts ?? 0;
                  const interactive = volume > 0;
                  const isSelected = selected === shape.code;
                  return (
                    <path
                      key={shape.code}
                      d={shape.path}
                      data-country={shape.code}
                      className={`${volume === 0 ? 'fill-gray-200 dark:fill-gray-700' : ''} stroke-white stroke-[0.4] dark:stroke-gray-900 ${interactive ? 'cursor-pointer outline-none focus-visible:stroke-primary-600' : ''} ${isSelected ? 'stroke-primary-600 stroke-[1.5] dark:stroke-primary-400' : ''}`}
                      style={volume > 0 ? { fill: `rgba(220, 38, 38, ${intensity(volume, max).toFixed(2)})` } : undefined}
                      {...(interactive ? {
                        role: 'button',
                        tabIndex: 0,
                        'aria-label': t('tools.attackMap.countryLabel', { country: countryName(shape.code), alerts: volume }),
                        'aria-pressed': isSelected,
                        onClick: () => setSelected(shape.code),
                        onKeyDown: (event: React.KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(shape.code); } },
                      } : {})}
                    >
                      <title>{`${countryName(shape.code)}: ${volume}`}</title>
                    </path>
                  );
                })}
              </svg>
            )}
            <div className="mt-2 flex items-center gap-2 px-2 text-xs text-gray-500 dark:text-gray-400" aria-hidden="true">
              <span>{t('tools.attackMap.fewer')}</span>
              <span className="h-2 w-32 rounded" style={{ background: 'linear-gradient(to right, rgba(220, 38, 38, 0.18), rgb(220, 38, 38))' }} />
              <span>{t('tools.attackMap.more')}</span>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base">{current ? countryName(current.code) : t('tools.attackMap.pick')}</CardTitle></CardHeader>
            <CardContent className="text-sm">
              <div className="space-y-3" data-testid="attack-map-details">
              {!current && <p className="text-gray-500">{t('tools.attackMap.pickHint')}</p>}
              {current && (
                <>
                  <p className="flex items-center gap-2"><CountryFlag code={current.code} /><span className="font-mono text-xs text-gray-500">{current.code}</span>{current.blocked && <Badge variant="danger">{t('tools.geo.blocked')}</Badge>}</p>
                  <p>{t('tools.attackMap.stats', { alerts: current.alerts, ips: current.unique_ips, share: share(current) })}</p>
                  <div className="flex flex-wrap gap-2">
                    <Link to={`/alerts?q=${encodeURIComponent(`country:${current.code}`)}`} className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-700">{t('tools.attackMap.viewAlerts')}</Link>
                    <Link to="/tools/geo-blocking" className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800">{t('tools.attackMap.blockCountry')}</Link>
                  </div>
                </>
              )}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">{t('tools.attackMap.top')}</CardTitle></CardHeader>
            <CardContent className="space-y-1 py-3">
              {withAlerts.length === 0 && <p className="text-sm text-gray-500">{t('tools.geo.empty')}</p>}
              {withAlerts.slice(0, 10).map((country) => (
                <button key={country.code} type="button" onClick={() => setSelected(country.code)} className={`flex w-full items-center justify-between gap-3 rounded px-2 py-1 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-700 ${selected === country.code ? 'bg-gray-100 dark:bg-gray-700' : ''}`}>
                  <span className="flex min-w-0 items-center gap-2"><CountryFlag code={country.code} /><span className="truncate">{countryName(country.code)}</span></span>
                  <span className="tabular-nums text-gray-500 dark:text-gray-400">{country.alerts}</span>
                </button>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </ToolPage>
  );
}
