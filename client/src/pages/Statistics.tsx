import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import {
  Activity, AlertCircle, ArrowUpRight, Ban, Clock3, Crosshair, Database, Gavel, Globe, Info, Layers, Network,
  RefreshCw, Repeat, Server, ShieldAlert, TrendingUp, Users, X,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { StatCard } from '../components/StatCard';
import { ScenarioName } from '../components/ScenarioName';
import { CountryFlag } from '../components/CountryFlag';
import { InstanceIcon } from '../components/InstanceIcon';
import { fetchConfig } from '../lib/api';
import { sessionFetch } from '../lib/sessionFetch';
import { apiUrl } from '../lib/basePath';
import { useI18n } from '../lib/i18n';
import { formatDateTimeValue, useDateTime } from '../lib/dateTime';
import { getCountryName } from '../lib/utils';
import { DASHBOARD_COLORS } from '../lib/dashboardColors';
import { formatCustomDate } from '../../../shared/date-format';
import type { ConfigResponse } from '../types';
import type { StatisticsRanking, StatisticsResponse } from '../../../shared/statistics';

const DAY = 86_400_000;
const isoDay = (stamp: number) => new Date(stamp).toISOString().slice(0, 10);
const isIsoDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));

const PRESETS = ['today', 'yesterday', '7', '30', '90', '365'] as const;
type Preset = typeof PRESETS[number];
const DEFAULT_PRESET: Preset = '30';
const SIMULATION_MODES = ['live', 'simulated', 'all'];
const LIMITS = ['10', '20', '50'];
const isPreset = (value: unknown): value is Preset => PRESETS.includes(value as Preset);
const presetRange = (preset: Preset, today: string) => {
  const end = Date.parse(today);
  if (preset === 'today') return { from: today, to: today };
  if (preset === 'yesterday') return { from: isoDay(end - DAY), to: isoDay(end - DAY) };
  return { from: isoDay(end - (Number(preset) - 1) * DAY), to: today };
};

// The last selection is remembered in this browser. Presets are stored by name so they stay relative to today.
const SELECTION_STORAGE_KEY = 'statistics_selection';
interface StoredSelection { preset?: Preset; from?: string; to?: string; simulation?: string; limit?: string }
function readStoredSelection(): StoredSelection {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SELECTION_STORAGE_KEY) || '{}');
    if (!value || typeof value !== 'object') return {};
    const input = value as Record<string, unknown>;
    return {
      ...(isPreset(input.preset) ? { preset: input.preset } : {}),
      ...(isIsoDay(input.from) && isIsoDay(input.to) && input.from <= input.to ? { from: input.from, to: input.to } : {}),
      ...(SIMULATION_MODES.includes(input.simulation as string) ? { simulation: input.simulation as string } : {}),
      ...(LIMITS.includes(input.limit as string) ? { limit: input.limit as string } : {}),
    };
  } catch {
    return {};
  }
}
const formatNumber = (value: number) => value.toLocaleString();

// Shared with the Settings page so form controls look the same everywhere.
const labelClass = 'block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400';
const inputClass = 'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:[color-scheme:dark]';
const linkClass = 'font-medium text-primary-600 hover:text-primary-700 hover:underline dark:text-primary-400 dark:hover:text-primary-300';
// Same axis styling as the dashboard activity chart.
const axisProps = { stroke: '#888888', fontSize: 12, tickLine: false, axisLine: false } as const;

type Tone = 'primary' | 'alert' | 'decision';
const toneClasses: Record<Tone, string> = {
  primary: 'bg-primary-50 text-primary-600 dark:bg-primary-900/30 dark:text-primary-400',
  alert: 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400',
  decision: 'bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400',
};

function SectionHeader({ icon: Icon, title, description, actions }: { icon: LucideIcon; title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <CardTitle className="flex items-center gap-2">
          <Icon className="h-5 w-5 shrink-0 text-primary-600 dark:text-primary-400" aria-hidden="true" />
          {title}
        </CardTitle>
        {description && <p className="mt-1 text-sm leading-6 text-gray-500 dark:text-gray-400">{description}</p>}
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </CardHeader>
  );
}

function SummaryTile({ icon: Icon, title, value, tone = 'primary' }: { icon: LucideIcon; title: string; value: number; tone?: Tone }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-4 sm:p-5">
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${toneClasses[tone]}`}>
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">{title}</p>
          <p className="mt-1 truncate text-2xl font-bold tabular-nums text-gray-900 dark:text-white">{formatNumber(value)}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function Notice({ tone, role, children }: { tone: 'info' | 'warning'; role?: 'alert'; children: ReactNode }) {
  const Icon = tone === 'info' ? Info : AlertCircle;
  const className = tone === 'info'
    ? 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-100'
    : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100';
  return (
    <div role={role} className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${className}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <p className="py-4 text-center text-sm text-gray-500 dark:text-gray-400">{children}</p>;
}

interface ChartTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: Array<{ name?: string; value?: number | null; color?: string }>;
  formatLabel: (label: string | number) => string;
}

function ChartTooltip({ active, label, payload, formatLabel }: ChartTooltipProps) {
  if (!active || !payload?.length || label === undefined) return null;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-lg dark:border-gray-700 dark:bg-gray-800">
      <p className="mb-2 text-sm font-medium text-gray-900 dark:text-gray-100">{formatLabel(label)}</p>
      {payload.map((entry) => (
        <div key={entry.name} className="mb-1 flex items-center gap-2 text-sm last:mb-0">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: entry.color }} aria-hidden="true" />
          <span className="text-gray-600 dark:text-gray-300">{entry.name}:</span>
          <span className="font-medium tabular-nums text-gray-900 dark:text-gray-100">{typeof entry.value === 'number' ? formatNumber(entry.value) : '—'}</span>
        </div>
      ))}
    </div>
  );
}

function SegmentedControl({ label, options }: { label: string; options: Array<{ key: string; label: string; selected: boolean; onSelect: () => void }> }) {
  return (
    <div className="flex w-fit max-w-full overflow-x-auto rounded-lg bg-gray-100 p-1 [scrollbar-width:none] dark:bg-gray-900/60 [&::-webkit-scrollbar]:hidden" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          onClick={option.onSelect}
          aria-pressed={option.selected}
          className={`shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-all ${option.selected
            ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100'
            : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200'}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function FilterChip({ label, clearLabel, onClear }: { label: string; clearLabel: string; onClear: () => void }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary-200 bg-primary-50 py-1 pl-3 pr-1 text-sm font-medium text-primary-800 dark:border-primary-800 dark:bg-primary-900/40 dark:text-primary-100">
      <span className="truncate">{label}</span>
      <button type="button" aria-label={clearLabel} onClick={onClear} className="rounded-full p-0.5 hover:bg-primary-100 focus-visible:outline-2 focus-visible:outline-primary-500 dark:hover:bg-primary-800/60">
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </span>
  );
}

export function Statistics() {
  const { t, language } = useI18n();
  const dateTime = useDateTime();
  const { dateFormat } = dateTime;
  const [params, setParams] = useSearchParams();
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [result, setResult] = useState<{ key: string; queryString: string; data: StatisticsResponse | null; error: string } | null>(null);
  const [configError, setConfigError] = useState('');
  const [reload, setReload] = useState(0);
  // Bumped when the server reports a newer archive revision than the one shown.
  const [archiveChange, setArchiveChange] = useState(0);
  const shownRevision = useRef<number | null>(null);
  const [today, setToday] = useState(() => isoDay(Date.now()));
  const [stored] = useState(readStoredSelection);
  // The URL wins over the stored selection, so links keep working.
  const urlPreset = params.get('range');
  const urlFrom = params.get('from');
  const urlTo = params.get('to');
  const preset: Preset | null = isPreset(urlPreset) ? urlPreset
    : urlFrom || urlTo ? null
      : stored.preset ?? (stored.from ? null : DEFAULT_PRESET);
  const range = preset ? presetRange(preset, today)
    : { from: urlFrom || stored.from || presetRange(DEFAULT_PRESET, today).from, to: urlTo || stored.to || today };
  const { from, to } = range;
  const instance = params.get('instance') || 'all';
  const simulation = params.get('simulation') || stored.simulation || 'live';
  const limit = params.get('limit') || stored.limit || '10';
  const ip = params.get('ip');
  const machine = params.get('machine');
  const query = new URLSearchParams({ from, to, instance, simulation, limit });
  if (ip) query.set('ip', ip);
  if (machine) query.set('machine', machine);
  const queryString = query.toString();
  const requestKey = `${queryString}:${reload}:${archiveChange}`;
  const current = result?.key === requestKey;
  // Keep showing the previous result for the same filters while it refreshes.
  const data = result && (current || result.queryString === queryString) ? result.data : null;
  const error = (current ? result.error : '') || configError;
  const loading = !current;
  const update = (values: Record<string, string | null>) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(values)) { if (value === null) next.delete(key); else next.set(key, value); }
      return next;
    });
  };
  const selection = JSON.stringify(preset ? { preset, simulation, limit } : { from, to, simulation, limit });
  useEffect(() => {
    try { localStorage.setItem(SELECTION_STORAGE_KEY, selection); } catch { /* Storage is a convenience; the page works without it. */ }
  }, [selection]);
  // The instance comes from the sidebar; drop a machine filter that belongs to another instance.
  useEffect(() => {
    if (!machine || instance === 'all') return;
    let machineInstance: string | undefined;
    try { machineInstance = (JSON.parse(machine) as string[])[0]; } catch { return; }
    if (machineInstance !== instance) {
      setParams((previous) => { const next = new URLSearchParams(previous); next.delete('machine'); return next; }, { replace: true });
    }
  }, [instance, machine, setParams]);
  useEffect(() => {
    let active = true;
    void fetchConfig().then((value) => { if (active) { setConfig(value); setConfigError(''); } }).catch(() => { if (active) setConfigError(t('pages.statistics.loadError')); });
    return () => { active = false; };
  }, [reload, t]);
  useEffect(() => {
    const abort = new AbortController();
    void sessionFetch(`${apiUrl('/api/statistics')}?${queryString}`, { signal: abort.signal }).then(async (response) => {
      if (!response.ok) throw new Error(t('pages.statistics.loadError'));
      const payload = await response.json() as StatisticsResponse;
      if (!abort.signal.aborted) setResult({ key: requestKey, queryString, data: payload, error: '' });
    }).catch((e: unknown) => { if (!abort.signal.aborted) setResult({ key: requestKey, queryString, data: null, error: e instanceof Error ? e.message : t('pages.statistics.loadError') }); });
    return () => abort.abort();
  }, [queryString, requestKey, t]);
  useEffect(() => { if (data) shownRevision.current = data.revision; }, [data]);
  // The archive only changes when a background job commits. While the page is
  // visible, poll the lightweight configuration and rerun the statistics query
  // only after the server reports a newer revision (or the UTC day rolls over).
  useEffect(() => {
    let active = true;
    const poll = () => {
      if (document.visibilityState === 'hidden') return;
      setToday(isoDay(Date.now()));
      void fetchConfig().then((value) => {
        if (!active) return;
        setConfig(value);
        const revision = value.statistics?.status.revision;
        if (revision !== undefined && shownRevision.current !== null && revision > shownRevision.current) setArchiveChange((r) => r + 1);
      }).catch(() => { /* Keep the current view; the next poll retries. */ });
    };
    const timer = setInterval(poll, 60_000);
    document.addEventListener('visibilitychange', poll);
    return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, []);

  const configuration = data?.configuration || config?.statistics;
  const instances = config?.instances || [];
  // Statistics are bucketed by UTC day, so days are always formatted in UTC.
  const formatDay = (day: string, compact = false) => {
    const date = new Date(`${day}T00:00:00Z`);
    if (!Number.isFinite(date.getTime())) return day;
    if (!compact && dateFormat !== 'browser') return formatCustomDate(date, dateFormat, 'UTC');
    return date.toLocaleDateString(undefined, compact
      ? { month: 'short', day: 'numeric', timeZone: 'UTC' }
      : { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  };
  // Timestamps use the configured date and time format, but stay in UTC like the rest of the page.
  const formatTimestamp = (value: string | null | undefined) => (value ? formatDateTimeValue(value, { ...dateTime, timeZone: 'UTC' }) : '—');
  const unknown = (label: string) => (label === 'Unknown' ? t('pages.statistics.unknown') : label);
  const weekday = (index: number) => t(`pages.statistics.weekday${index}`);
  const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

  const related = new URLSearchParams({ instance });
  const end = Number.isFinite(Date.parse(to)) ? isoDay(Date.parse(to) + DAY) : to;
  const search: string[] = [`date>=${from}T00:00:00Z`, `date<${end}T00:00:00Z`];
  if (ip) search.push(`ip=${JSON.stringify(ip)}`);
  if (machine) {
    try { const key = JSON.parse(machine) as string[]; related.set('instance', key[0]); search.push(`machine=${JSON.stringify(key[1])}`); } catch { /* The API reports invalid URL filters. */ }
  }
  related.set('q', search.join(' AND '));
  related.set('simulation', simulation);

  const presetLabel = (key: Preset) => (key === 'today' ? t('pages.statistics.today')
    : key === 'yesterday' ? t('pages.statistics.yesterday')
      : t('pages.statistics.lastDays', { count: Number(key) }));
  const selectRange = (values: { range: Preset } | { from: string; to: string }) => update('range' in values
    ? { range: values.range, from: null, to: null }
    : { range: null, from: values.from, to: values.to });
  const rangeLabel = `${formatDay(from)} – ${formatDay(to)} (UTC)`;
  const instanceName = (id?: string) => instances.find((candidate) => candidate.id === id)?.name || id || '';
  const instanceIcon = (id?: string) => {
    const index = instances.findIndex((candidate) => candidate.id === id);
    return index === -1 ? null : <InstanceIcon icon={instances[index].icon} colorIndex={index} />;
  };

  const scenarioChips = (scenarios: StatisticsRanking['scenarios']) => scenarios.length > 0 && (
    <div className="mt-2 flex flex-wrap gap-1">
      {scenarios.map((scenario) => (
        <span key={scenario.label} className="inline-flex max-w-full items-center gap-1 rounded-md bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-700/60 dark:text-gray-200">
          <span className="truncate">{unknown(scenario.label)}</span>
          <span className="tabular-nums text-gray-500 dark:text-gray-400">{formatNumber(scenario.count)}</span>
        </span>
      ))}
    </div>
  );

  const rankings = (kind: 'attackers' | 'machines') => {
    const rows = data?.[kind] || [];
    const attackers = kind === 'attackers';
    const headerCell = 'whitespace-nowrap px-4 py-3 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 first:pl-6 last:pr-6';
    const cell = 'px-4 py-4 align-top first:pl-6 last:pr-6';
    return (
      <Card className="flex flex-col">
        <SectionHeader icon={attackers ? Crosshair : Server} title={t(`pages.statistics.${kind}`)} description={rangeLabel} />
        {rows.length === 0 ? <CardContent><EmptyState>{t('common.noDataAvailable')}</EmptyState></CardContent> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <th className={headerCell}>{t(`pages.statistics.${attackers ? 'ip' : 'machine'}`)}</th>
                  <th className={`${headerCell} text-right`}>{t('pages.statistics.alerts')}</th>
                  <th className={`${headerCell} text-right`}>{t('pages.statistics.bans')}</th>
                  <th className={headerCell}>{t(`pages.statistics.${attackers ? 'targetedMachines' : 'uniqueIPs'}`)}</th>
                  <th className={headerCell}>{t('pages.statistics.activity')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {rows.map((row) => {
                  const countryName = row.country && row.country !== 'Unknown' ? getCountryName(row.country, language) ?? row.country : t('pages.statistics.unknown');
                  const asn = row.asn ? (/^AS/i.test(row.asn) ? row.asn : `AS${row.asn}`) : '';
                  return (
                    <tr key={row.value} className="transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/30">
                      <td className={`${cell} min-w-64`}>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 break-all text-left font-medium text-gray-900 hover:text-primary-600 dark:text-gray-100 dark:hover:text-primary-400"
                          onClick={() => update({ [attackers ? 'ip' : 'machine']: row.value })}
                        >
                          {row.label}<ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-gray-400" aria-hidden="true" />
                        </button>
                        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                          {attackers ? <>
                            <CountryFlag code={row.country} />
                            <span className="truncate">{[countryName, asn, row.network].filter(Boolean).join(' · ')}</span>
                          </> : <>
                            {instanceIcon(row.instance)}
                            <span className="truncate">{instanceName(row.instance)}</span>
                          </>}
                        </div>
                        {scenarioChips(row.scenarios)}
                      </td>
                      <td className={`${cell} text-right font-semibold tabular-nums text-gray-900 dark:text-gray-100`}>{formatNumber(row.alerts)}</td>
                      <td className={`${cell} text-right tabular-nums text-gray-700 dark:text-gray-300`}>{formatNumber(row.bans)}</td>
                      <td className={cell}>
                        {attackers ? <>
                          <span className="font-medium tabular-nums text-gray-900 dark:text-gray-100">{formatNumber(row.machines)}</span>
                          {row.targetedMachines.length > 0 && (
                            <div className="mt-1 flex flex-col items-start gap-0.5 text-xs">
                              {row.targetedMachines.map((target) => (
                                <button key={target.value} type="button" className={`${linkClass} max-w-48 truncate text-left`} onClick={() => update({ machine: target.value })}>{target.label}</button>
                              ))}
                            </div>
                          )}
                        </> : <span className="font-medium tabular-nums text-gray-900 dark:text-gray-100">{formatNumber(row.uniqueIPs)}</span>}
                      </td>
                      <td className={`${cell} whitespace-nowrap`}>
                        <span className="font-medium text-gray-900 dark:text-gray-100">{t('pages.statistics.activeDays', { count: row.activeDays })}</span>
                        {(row.firstActivity || row.lastActivity) && (
                          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                            <div>{formatTimestamp(row.firstActivity)}</div>
                            <div>{formatTimestamp(row.lastActivity)}</div>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    );
  };

  const breakdown = (title: string, icon: LucideIcon, entries: Array<{ label: string; count: number }>, total: number, kind?: 'scenario' | 'country') => (
    <StatCard
      key={title}
      title={title}
      icon={icon}
      total={total}
      items={entries.map((entry) => ({
        ...entry,
        label: kind === 'country' && entry.label !== 'Unknown' ? getCountryName(entry.label, language) ?? entry.label : unknown(entry.label),
        value: entry.label,
        countryCode: kind === 'country' && entry.label !== 'Unknown' ? entry.label : undefined,
      }))}
      renderLabel={kind === 'scenario' ? (item) => (item.value === 'Unknown'
        ? <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{item.label}</span>
        : <ScenarioName name={item.value} showLink />) : undefined}
    />
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-5 p-4 sm:p-6">
          <SegmentedControl
            label={t('pages.statistics.range')}
            options={PRESETS.map((key) => ({
              key,
              label: presetLabel(key),
              selected: preset === key,
              onSelect: () => selectRange({ range: key }),
            }))}
          />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <label htmlFor="statistics-from" className={labelClass}>{t('pages.statistics.from')} (UTC)</label>
              <input id="statistics-from" type="date" max={to} value={from} className={inputClass} onChange={(e) => { if (e.target.value) selectRange({ from: e.target.value, to }); }} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="statistics-to" className={labelClass}>{t('pages.statistics.to')} (UTC)</label>
              <input id="statistics-to" type="date" min={from} max={today} value={to} className={inputClass} onChange={(e) => { if (e.target.value) selectRange({ from, to: e.target.value }); }} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="statistics-mode" className={labelClass}>{t('pages.statistics.mode')}</label>
              <select id="statistics-mode" value={simulation} className={inputClass} onChange={(e) => update({ simulation: e.target.value })}>
                <option value="live">{t('common.live')}</option>
                <option value="simulated">{t('pages.statistics.simulated')}</option>
                <option value="all">{t('common.all')}</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="statistics-limit" className={labelClass}>{t('pages.statistics.rankings')}</label>
              <select id="statistics-limit" value={limit} className={inputClass} onChange={(e) => update({ limit: e.target.value })}>
                {[10, 20, 50].map((n) => <option key={n} value={n}>{t('pages.statistics.top', { count: n })}</option>)}
              </select>
            </div>
          </div>
          {(ip || machine) && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-gray-100 pt-4 text-sm dark:border-gray-700/50">
              <div className="flex flex-wrap gap-2">
                {ip && <FilterChip label={ip} clearLabel={t('pages.statistics.clearIP')} onClear={() => update({ ip: null })} />}
                {machine && <FilterChip label={data?.machines.find((m) => m.value === machine)?.label || t('pages.statistics.machine')} clearLabel={t('pages.statistics.clearMachine')} onClear={() => update({ machine: null })} />}
              </div>
              <Link className={`${linkClass} inline-flex items-center gap-1`} to={`/alerts?${related}`}>
                {t('pages.statistics.investigate')}
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
              <span className="text-xs text-gray-500 dark:text-gray-400">{t('pages.statistics.detailsRetention', { days: config?.lookback_days || 7 })}</span>
            </div>
          )}
        </CardContent>
        {configuration && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-gray-100 bg-gray-50 px-4 py-3 text-xs text-gray-500 sm:px-6 dark:border-gray-700/50 dark:bg-gray-900/40 dark:text-gray-400">
            <span className="inline-flex items-center gap-1.5"><Database className="h-3.5 w-3.5" aria-hidden="true" />{t('pages.statistics.retainedDays', { count: configuration.settings.retentionDays })}</span>
            <span className="inline-flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" aria-hidden="true" />{t('pages.statistics.lastUpdate')}: {formatTimestamp(configuration.status.lastSuccess)} UTC</span>
            <span>{t('pages.statistics.backlog')}: <span className="tabular-nums">{formatNumber(configuration.status.backlog)}</span></span>
            {configuration.status.backfillPending && <Badge variant="info">{t('pages.statistics.backfilling')}</Badge>}
            {!configuration.settings.enabled && <Badge>{t('common.disabled')}</Badge>}
          </div>
        )}
      </Card>

      {configuration && !configuration.settings.enabled && (
        <Notice tone="info">
          <p>{t('pages.statistics.disabledHelp')}</p>
          <Link to="/settings?tab=general" className={`${linkClass} mt-1 inline-block`}>{t('pages.statistics.openSettings')}</Link>
        </Notice>
      )}
      {error && (
        <Notice tone="warning" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => setReload((r) => r + 1)} disabled={loading} className={`${linkClass} mt-1 inline-flex items-center gap-1.5 disabled:opacity-60`}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            {t('pages.statistics.retry')}
          </button>
        </Notice>
      )}
      {loading && !data && <p role="status" className="p-8 text-center text-gray-500 dark:text-gray-400">{t('app.loading')}</p>}

      {data && <>
        {data.coverage.partial && (
          <Notice tone="warning">
            <p>{t('pages.statistics.partial')}</p>
            <p className="mt-1 text-xs opacity-80">
              {t('pages.statistics.coverage')}: {data.coverage.from ? formatDay(data.coverage.from.slice(0, 10)) : '—'} – {formatTimestamp(data.coverage.through)} UTC
            </p>
          </Notice>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 min-[1800px]:grid-cols-6">
          <SummaryTile icon={ShieldAlert} tone="alert" title={t('pages.statistics.alerts')} value={data.totals.alerts} />
          <SummaryTile icon={Activity} title={t('pages.statistics.events')} value={data.totals.events} />
          <SummaryTile icon={Users} title={t('pages.statistics.uniqueIPs')} value={data.totals.uniqueIPs} />
          <SummaryTile icon={Repeat} title={t('pages.statistics.repeatAttackers')} value={data.totals.repeatAttackers} />
          <SummaryTile icon={Ban} tone="decision" title={t('pages.statistics.bans')} value={data.totals.bans} />
          <SummaryTile icon={Gavel} tone="decision" title={t('pages.statistics.decisions')} value={data.totals.decisions} />
        </div>

        <Card>
          <SectionHeader icon={TrendingUp} title={t('pages.statistics.trend')} description={t('pages.statistics.countingHelp')} />
          <CardContent>
            <div className="h-72 min-w-0" role="img" aria-label={t('pages.statistics.trend')}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.series} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} vertical={false} />
                  <XAxis dataKey="date" {...axisProps} tickFormatter={(day: string) => formatDay(day, true)} minTickGap={32} />
                  <YAxis {...axisProps} allowDecimals={false} width={48} tickFormatter={formatNumber} />
                  <Tooltip content={<ChartTooltip formatLabel={(day) => formatDay(String(day))} />} />
                  <Legend verticalAlign="top" height={36} iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 13 }} />
                  <Line type="monotone" dataKey="alerts" name={t('pages.statistics.alerts')} stroke={DASHBOARD_COLORS.liveAlerts} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} connectNulls={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="decisions" name={t('pages.statistics.decisions')} stroke={DASHBOARD_COLORS.liveDecisions} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} connectNulls={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {rankings('attackers')}
        {rankings('machines')}

        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          {breakdown(t('pages.statistics.scenarios'), ShieldAlert, data.scenarios, data.totals.alerts, 'scenario')}
          {breakdown(t('pages.statistics.countries'), Globe, data.countries, data.totals.alerts, 'country')}
          {breakdown(t('pages.statistics.networks'), Network, data.networks, data.totals.alerts)}
          {breakdown(t('pages.statistics.decisionTypes'), Gavel, data.decisionTypes, data.totals.decisions)}
          {breakdown(t('pages.statistics.decisionOrigins'), Layers, data.decisionOrigins, data.totals.decisions)}
          <Card className="h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <TrendingUp className="h-5 w-5 text-primary-600 dark:text-primary-400" aria-hidden="true" />
                {t('pages.statistics.increases')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.coverage.comparisonPartial ? <EmptyState>{t('pages.statistics.comparisonPartial')}</EmptyState> : data.increases.length === 0 ? <EmptyState>{t('common.noDataAvailable')}</EmptyState> : (
                <div className="space-y-2">
                  {data.increases.map((row, index) => (
                    <button
                      key={row.value}
                      type="button"
                      onClick={() => update({ machine: row.value })}
                      className="flex w-full items-center justify-between gap-2 rounded-lg border border-transparent p-2 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50"
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-100 text-xs font-semibold text-primary-700 dark:bg-primary-900/30 dark:text-primary-300">{index + 1}</span>
                        <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{row.label}</span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end">
                        <span className="text-sm font-bold tabular-nums text-red-600 dark:text-red-400">+{formatNumber(row.change)}</span>
                        <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">{formatNumber(row.previous)} → {formatNumber(row.current)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <SectionHeader icon={Clock3} title={t('pages.statistics.busiest')} description="UTC" />
          <CardContent className="grid gap-6 lg:grid-cols-3">
            <div className="h-56 min-w-0 lg:col-span-2" role="img" aria-label={t('pages.statistics.busiest')}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.hours.map((count, hour) => ({ hour, count }))} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} vertical={false} />
                  <XAxis dataKey="hour" {...axisProps} tickFormatter={(hour: number) => String(hour).padStart(2, '0')} interval={2} />
                  <YAxis {...axisProps} allowDecimals={false} width={48} tickFormatter={formatNumber} />
                  <Tooltip cursor={{ fill: 'transparent' }} content={<ChartTooltip formatLabel={(hour) => `${hourLabel(Number(hour))} UTC`} />} />
                  <Bar dataKey="count" name={t('pages.statistics.alerts')} fill={DASHBOARD_COLORS.liveAlerts} radius={[4, 4, 0, 0]} maxBarSize={40} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="h-56 min-w-0" role="img" aria-label={t('pages.statistics.busiest')}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.weekdays.map((count, day) => ({ day: weekday(day), count }))} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} vertical={false} />
                  <XAxis dataKey="day" {...axisProps} interval={0} />
                  <YAxis {...axisProps} allowDecimals={false} width={48} tickFormatter={formatNumber} />
                  <Tooltip cursor={{ fill: 'transparent' }} content={<ChartTooltip formatLabel={String} />} />
                  <Bar dataKey="count" name={t('pages.statistics.alerts')} fill={DASHBOARD_COLORS.liveAlerts} radius={[4, 4, 0, 0]} maxBarSize={40} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </>}
    </div>
  );
}
