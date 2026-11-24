import { useEffect, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { GitCompareArrows } from 'lucide-react';
import { addStatisticsDays, statisticsDay, type StatisticsResponse } from '../../../shared/statistics';
import { alignSeries, fetchStatisticsRange, percentChange, previousRange } from '../lib/comparePeriods';
import { DASHBOARD_COLORS } from '../lib/dashboardColors';
import { useI18n } from '../lib/i18n';
import { CompareToggle } from './CompareToggle';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';

const RANGES = [7, 30, 90] as const;
type RangeDays = (typeof RANGES)[number];

interface PeriodCompareCardProps {
  timeZone: string;
}

interface Loaded { key: string; current?: StatisticsResponse; previous?: StatisticsResponse | null; error?: string }

/** Alerts and decisions for the last 7, 30 or 90 days, optionally set against the period before. */
export function PeriodCompareCard({ timeZone }: PeriodCompareCardProps) {
  const { t, language } = useI18n();
  const [days, setDays] = useState<RangeDays>(7);
  const [compare, setCompare] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // Fixed when the card mounts, so a re-render never changes the range being compared.
  const [mountedAt] = useState(() => Date.now());
  const today = statisticsDay(mountedAt, timeZone);
  const from = addStatisticsDays(today, -(days - 1));
  const key = `${from}:${today}:${compare}`;

  useEffect(() => {
    const abort = new AbortController();
    const before = previousRange(from, today);
    Promise.all([
      fetchStatisticsRange(from, today, abort.signal),
      compare ? fetchStatisticsRange(before.from, before.to, abort.signal).catch(() => null) : Promise.resolve(undefined),
    ])
      .then(([current, previous]) => { if (!abort.signal.aborted) setLoaded({ key, current, previous }); })
      .catch((error: unknown) => { if (!abort.signal.aborted) setLoaded({ key, error: error instanceof Error ? error.message : t('components.compare.loadFailed') }); });
    return () => abort.abort();
  }, [from, today, compare, key, t]);

  const state = loaded?.key === key ? loaded : null;
  const current = state?.current;
  const previous = state?.previous ?? null;
  const rows = current ? alignSeries(current.series, compare ? previous?.series ?? null : null) : [];
  const showPrevious = compare && previous !== null;
  const format = (value: number) => value.toLocaleString(language);
  const day = (value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString(language, { month: 'short', day: 'numeric', timeZone: 'UTC' });

  const tiles = current ? [
    { id: 'alerts', title: t('components.compare.alerts'), value: current.totals.alerts, before: previous ? previous.totals.alerts : null },
    { id: 'decisions', title: t('components.compare.decisions'), value: current.totals.decisions, before: previous ? previous.totals.decisions : null },
    { id: 'ips', title: t('components.compare.uniqueIps'), value: current.totals.uniqueIPs, before: previous ? previous.totals.uniqueIPs : null },
  ] : [];

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            <GitCompareArrows className="h-5 w-5 shrink-0 text-primary-600 dark:text-primary-400" aria-hidden="true" />
            {t('components.compare.title')}
          </CardTitle>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('components.compare.description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <label className="text-sm text-gray-700 dark:text-gray-300">
            <span className="mr-2">{t('components.compare.rangeLabel')}</span>
            <select value={days} onChange={(event) => setDays(Number(event.target.value) as RangeDays)} className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800">
              {RANGES.map((value) => <option key={value} value={value}>{t(`components.compare.range.${value}`)}</option>)}
            </select>
          </label>
          <CompareToggle checked={compare} onChange={setCompare} />
        </div>
      </CardHeader>
      <CardContent>
        {!state && <p className="text-sm text-gray-500">{t('components.compare.loading')}</p>}
        {state?.error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{state.error}</p>}
        {current && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              {tiles.map((tile) => {
                const change = tile.before === null ? null : percentChange(tile.value, tile.before);
                const text = tile.before === null ? null : change === null ? t('components.compare.noBaseline') : `${change > 0 ? '+' : ''}${format(change)}%`;
                // More attacks is worse, so an increase is red.
                const tone = tile.before === null || tile.value === tile.before ? 'text-gray-500 dark:text-gray-400' : tile.value > tile.before ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400';
                return (
                  <div key={tile.id} data-testid={`compare-${tile.id}`} className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                    <p className="text-sm text-gray-500 dark:text-gray-400">{tile.title}</p>
                    <p className="text-2xl font-bold tabular-nums text-gray-900 dark:text-gray-100">{format(tile.value)}</p>
                    {text && <p className={`text-sm font-medium ${tone}`}>{t('components.compare.vsPrevious', { value: text })}{tile.before !== null && <span className="ml-1 font-normal text-gray-500 dark:text-gray-400">({format(tile.before)})</span>}</p>}
                  </div>
                );
              })}
            </div>
            <div className="h-64 min-w-0" role="img" aria-label={t('components.compare.title')}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={rows} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} vertical={false} />
                  <XAxis dataKey="date" tickFormatter={(value: string) => day(value)} minTickGap={32} tick={{ fontSize: 12 }} />
                  <YAxis allowDecimals={false} width={48} tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Legend verticalAlign="top" height={32} iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 13 }} />
                  <Line type="monotone" dataKey="alerts" name={t('components.compare.alerts')} stroke={DASHBOARD_COLORS.liveAlerts} dot={false} isAnimationActive={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="decisions" name={t('components.compare.decisions')} stroke={DASHBOARD_COLORS.liveDecisions} dot={false} isAnimationActive={false} strokeWidth={2} />
                  {showPrevious && <Line type="monotone" dataKey="previousAlerts" name={t('components.compare.previousAlerts')} stroke={DASHBOARD_COLORS.liveAlerts} strokeOpacity={0.55} strokeDasharray="5 4" dot={false} isAnimationActive={false} strokeWidth={2} />}
                  {showPrevious && <Line type="monotone" dataKey="previousDecisions" name={t('components.compare.previousDecisions')} stroke={DASHBOARD_COLORS.liveDecisions} strokeOpacity={0.55} strokeDasharray="5 4" dot={false} isAnimationActive={false} strokeWidth={2} />}
                </LineChart>
              </ResponsiveContainer>
            </div>
            {compare && !previous && <p role="status" className="text-xs text-amber-700 dark:text-amber-400">{t('components.compare.unavailable')}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
