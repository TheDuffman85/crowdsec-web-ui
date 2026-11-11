import { useCallback, useEffect, useEffectEvent, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import {
  AlertCircle, Clock3, Crosshair, Database, Gavel, Globe, Info, ListChecks, Network,
  RefreshCw, Repeat, RotateCcw, Server, ShieldAlert, ShieldCheck, Target, TrendingUp, Users, X,
} from 'lucide-react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { ClickableTableRow } from '../components/ui/ClickableTableRow';
import { ResetColumnWidthsButton, ResizableTable } from '../components/ui/ResizableTable';
import { useResizableTable, type ResizableTableColumn, type ResizableTableController } from '../lib/useResizableTable';
import { StatCard } from '../components/StatCard';
import { ScenarioName } from '../components/ScenarioName';
import { CountryFlag } from '../components/CountryFlag';
import { InstanceIcon } from '../components/InstanceIcon';
import { AddDecisionModal } from '../components/AddDecisionModal';
import { PeriodChangeRow } from '../components/PeriodChange';
import { RemediationPills } from '../components/RemediationPills';
import { useRemediationTypeLabel } from '../lib/remediationTypes';
import { usePeriodChange } from '../lib/periodChange';
import { BanAllButton, DecisionAddedBadge, DecisionIconButton, StatisticsFindings, type DecisionDraft, type Finding } from '../components/StatisticsFindings';
import { fetchConfig, lookupManualDecisions } from '../lib/api';
import { pendingBanValues } from '../lib/pendingBans';
import { sessionFetch } from '../lib/sessionFetch';
import { apiUrl } from '../lib/basePath';
import { useI18n } from '../lib/i18n';
import { formatDateTimeValue, formatTimeValue, getBrowserTimeZone, useDateTime } from '../lib/dateTime';
import { mergeStoredQuickFiltersIntoQuery, saveStoredQuickFilters, type QuickFilterSimulationValue, type StoredQuickFilters } from '../lib/quickFilters';
import { getCountryName } from '../lib/utils';
import { STICKY_ACTIONS_CELL_CLASS_NAME, STICKY_ACTIONS_HEADER_CLASS_NAME } from '../lib/tableColumns';
import { DASHBOARD_COLORS } from '../lib/dashboardColors';
import { formatCustomDate } from '../../../shared/date-format';
import type { ConfigResponse, FacetField } from '../types';
import type { SearchDateRange } from '../../../shared/search';
import { MANUAL_DECISION_LOOKUP_MAX } from '../../../shared/contracts';
import {
  addStatisticsDays, statisticsDay, statisticsDayStart, type StatisticsRanking, type StatisticsResponse, type StatisticsScenario,
} from '../../../shared/statistics';

const HOUR = 3_600_000;

const TABLE_HEADER_CELL = 'whitespace-nowrap px-4 py-3 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 first:pl-6 last:pr-6';
const TABLE_RIGHT_HEADER_CELL = `${TABLE_HEADER_CELL} text-right`;
// Fits the ban button and the decision badge that replaces it.
const ACTIONS_COLUMN_WIDTH = 128;

/**
 * The hour containing `stamp` as an hour-precision search value (`YYYY-MM-DDTHH`) in `timeZone`,
 * the format the Alerts and Decisions quick filters use. Returns null when `stamp` is not a whole
 * hour there, as when the statistics day starts at a different offset than `timeZone` uses.
 */
function searchHour(stamp: number, timeZone: string | null): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en', {
      ...(timeZone ? { timeZone } : {}),
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(stamp);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? '';
    return part('minute') === '00' ? `${part('year')}-${part('month')}-${part('day')}T${part('hour')}` : null;
  } catch {
    return null;
  }
}

/**
 * The Statistics day range (days of `statisticsZone`) as a quick-filter date range for the Alerts
 * and Decisions pages, which use `timeZone`.
 */
function quickFilterDateRange(from: string, to: string, statisticsZone: string, timeZone: string | null): SearchDateRange {
  const startStamp = statisticsDayStart(from, statisticsZone);
  const endStamp = statisticsDayStart(addStatisticsDays(to, 1), statisticsZone);
  const start = searchHour(startStamp, timeZone);
  // An hour-precision `date<=` includes the whole hour, so the last hour of the day ends the range.
  const end = searchHour(endStamp - HOUR, timeZone);
  return start && end ? { start, end } : { start: new Date(startStamp).toISOString(), end: new Date(endStamp - 1).toISOString() };
}
const isIsoDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));

const PRESETS = ['today', 'yesterday', '7', '30', '90', '365'] as const;
type Preset = typeof PRESETS[number];
const DEFAULT_PRESET: Preset = '30';
const SIMULATION_MODES = ['live', 'simulated', 'all'];
const LIMITS = ['10', '20', '50'];
const isPreset = (value: unknown): value is Preset => PRESETS.includes(value as Preset);
const presetRange = (preset: Preset, today: string) => {
  if (preset === 'today') return { from: today, to: today };
  if (preset === 'yesterday') return { from: addStatisticsDays(today, -1), to: addStatisticsDays(today, -1) };
  return { from: addStatisticsDays(today, -(Number(preset) - 1)), to: today };
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
/** Share of alerting IPs with a remediation, in whole percent, or null without single IPs. */
const remediationCoverage = (remediatedIPs: number, uniqueIPs: number) => (uniqueIPs > 0 ? Math.round(remediatedIPs / uniqueIPs * 100) : null);

// Thresholds for findings. They favour few, clear signals over many weak ones.
const FINDINGS = {
  /** A scenario with at least this many alerts and no remediation at all. */
  unremediatedScenarioAlerts: 10,
  /** One AS with at least this share of all alerts, from at least this many IPs. */
  networkShare: 0.2,
  networkIPs: 5,
  /** A machine with at least this many alerts and this factor over the preceding period. */
  spikeAlerts: 20,
  spikeFactor: 2,
  /** A ranked IP that attacked at least this many machines. */
  wideScannerMachines: 3,
  /** A scenario blocked in-band by AppSec with at least this many alerts and no remediation. */
  inBandAlerts: 10,
} as const;
// AppSec (WAF) rules block the request itself; remediations only follow from scenarios.
const isInBandScenario = (label: string) => /(^|\/)(vpatch-|appsec)/i.test(label);
const PROFILE_DOCS = 'https://docs.crowdsec.net/docs/local_api/profiles/format';

// Shared with the Settings page so form controls look the same everywhere.
const labelClass = 'block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400';
const inputClass = 'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:[color-scheme:dark]';
const actionButtonClass = 'inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200 focus-visible:outline-2 focus-visible:outline-primary-500 dark:border-gray-700 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600';
const linkClass = 'cursor-pointer font-medium text-primary-600 hover:text-primary-700 hover:underline focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-primary-400 dark:hover:text-primary-300';
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
    // Actions line up with the description below the title.
    <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
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

/** Change against the preceding period; `better` says which direction is an improvement. */
interface TileDelta { current: number; previous: number; better: 'up' | 'down' | 'neutral'; points?: boolean }

function DeltaLabel({ delta, label }: { delta: TileDelta; label: string }) {
  const difference = delta.current - delta.previous;
  const sign = difference > 0 ? '+' : difference < 0 ? '−' : '±';
  const amount = delta.points ? `${Math.abs(difference)} pp`
    : delta.previous === 0 ? formatNumber(Math.abs(difference))
      : `${Math.round(Math.abs(difference) / delta.previous * 100)}%`;
  const improved = delta.better === 'up' ? difference > 0 : difference < 0;
  const color = difference === 0 || delta.better === 'neutral' ? 'text-gray-500 dark:text-gray-400'
    : improved ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400';
  return <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400"><span className={`font-semibold tabular-nums ${color}`}>{sign}{amount}</span> {label}</p>;
}

function SummaryTile({ icon: Icon, title, value, tone = 'primary', hint, delta, deltaLabel }: {
  icon: LucideIcon; title: string; value: number | string; tone?: Tone; hint?: string; delta?: TileDelta | null; deltaLabel: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-4 sm:p-5">
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${toneClasses[tone]}`}>
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">{title}</p>
          <p className="mt-1 truncate text-2xl font-bold tabular-nums text-gray-900 dark:text-white">{typeof value === 'number' ? formatNumber(value) : value}</p>
          {hint && <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">{hint}</p>}
          {delta && <DeltaLabel delta={delta} label={deltaLabel} />}
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
          className={`shrink-0 cursor-pointer whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-all focus-visible:outline-2 focus-visible:outline-primary-500 ${option.selected
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
      <button type="button" aria-label={clearLabel} onClick={onClear} className="cursor-pointer rounded-full p-0.5 hover:bg-primary-100 focus-visible:outline-2 focus-visible:outline-primary-500 dark:hover:bg-primary-800/60">
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
  const [result, setResult] = useState<{ key: string; queryString: string; data: StatisticsResponse | null; error: string; retryable?: boolean } | null>(null);
  const [configError, setConfigError] = useState('');
  const [reload, setReload] = useState(0);
  const [archiveChange, setArchiveChange] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  // Days are those of the statistics time zone, known once the configuration has loaded.
  const statisticsZone = config?.statistics?.timeZone ?? (configError ? 'UTC' : null);
  const timeZone = statisticsZone ?? 'UTC';
  const today = statisticsDay(now, timeZone);
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
  const simulationsEnabled = config?.simulations_enabled !== false;
  const simulation = params.get('simulation') || stored.simulation || 'live';
  const limit = params.get('limit') || stored.limit || '10';
  const ip = params.get('ip');
  const machine = params.get('machine');
  const scenario = params.get('scenario');
  const country = params.get('country');
  const network = params.get('network');
  const target = params.get('target');
  const query = new URLSearchParams({ from, to, instance, simulation, limit });
  if (ip) query.set('ip', ip);
  if (machine) query.set('machine', machine);
  if (scenario) query.set('scenario', scenario);
  if (country) query.set('country', country);
  if (network) query.set('network', network);
  if (target) query.set('target', target);
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
  const toggleFilters = (values: Record<string, string | null>) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(values)) {
        if (value === null || previous.get(key) === value) next.delete(key);
        else next.set(key, value);
      }
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
    if (!statisticsZone) return;
    const abort = new AbortController();
    void sessionFetch(`${apiUrl('/api/statistics')}?${queryString}`, { signal: abort.signal }).then(async (response) => {
      if (!response.ok) {
        if (!abort.signal.aborted) setResult({ key: requestKey, queryString, data: null, error: t('pages.statistics.loadError'), retryable: response.status >= 500 });
        return;
      }
      const payload = await response.json() as StatisticsResponse;
      if (!abort.signal.aborted) setResult({ key: requestKey, queryString, data: payload, error: '' });
    }).catch((e: unknown) => {
      if (!abort.signal.aborted) setResult({ key: requestKey, queryString, data: null, error: e instanceof Error ? e.message : t('pages.statistics.loadError'), retryable: true });
    });
    return () => abort.abort();
  }, [queryString, requestKey, statisticsZone, t]);
  const refreshArchive = useEffectEvent((statistics: ConfigResponse['statistics']) => {
    if (!statistics) return;
    const retentionDays = statistics.settings.retentionDays;
    const knownRetention = config?.statistics?.settings.retentionDays;
    if (knownRetention !== undefined && retentionDays !== knownRetention) {
      setArchiveChange((change) => change + 1);
      return;
    }
    if (!current) return;
    const { revision } = statistics.status;
    const stale = data && (revision > data.revision || retentionDays !== data.configuration.settings.retentionDays);
    const retry = result.retryable && (statistics.settings.enabled || revision > 0);
    if (stale || retry) setArchiveChange((change) => change + 1);
  });
  // Poll configuration while visible and fetch statistics when the archive
  // changes or a temporary error can be retried.
  useEffect(() => {
    let active = true;
    let inFlight = false;
    const loadConfig = async (polling: boolean) => {
      if (inFlight) return;
      inFlight = true;
      try {
        const value = await fetchConfig();
        if (!active) return;
        setConfig(value);
        setConfigError('');
        if (polling) refreshArchive(value.statistics);
      } catch {
        if (active && !polling) setConfigError(t('pages.statistics.loadError'));
      } finally {
        inFlight = false;
      }
    };
    const poll = () => {
      if (document.visibilityState === 'hidden') return;
      setNow(Date.now());
      void loadConfig(true);
    };
    void loadConfig(false);
    const timer = setInterval(poll, 60_000);
    document.addEventListener('visibilitychange', poll);
    return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [reload, t]);

  const configuration = config?.statistics ?? data?.configuration;
  const instances = config?.instances || [];
  // Days are calendar dates, so they are formatted as such, independent of any time zone.
  const formatDay = (day: string, compact = false) => {
    const date = new Date(`${day}T00:00:00Z`);
    if (!Number.isFinite(date.getTime())) return day;
    if (!compact && dateFormat !== 'browser') return formatCustomDate(date, dateFormat, 'UTC');
    return date.toLocaleDateString(undefined, compact
      ? { month: 'short', day: 'numeric', timeZone: 'UTC' }
      : { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  };
  // Timestamps use the configured date and time format in the time zone of the statistics days.
  const formatTimestamp = (value: string | null | undefined) => (value ? formatDateTimeValue(value, { ...dateTime, timeZone }) : '—');
  /** Chart ticks for hourly series; across two days they also name the day. */
  const formatHour = (value: string, withDay: boolean) => {
    const time = formatTimeValue(value, { ...dateTime, timeZone }, { hour: '2-digit', minute: '2-digit' });
    return withDay ? `${formatDay(statisticsDay(value, timeZone), true)} ${time}` : time;
  };
  const unknown = (label: string) => (label === 'Unknown' ? t('pages.statistics.unknown') : label);

  // "View Alerts" and "View Decisions" apply the Statistics filters as the saved quick filters of
  // those pages, replacing what was saved there, so the target shows exactly what was selected here
  // and keeps it, like a drill-down from the Dashboard.
  let relatedInstance = instance;
  const relatedSelections: StoredQuickFilters['selections'] = {};
  const include = (field: FacetField, value: string | null | undefined) => {
    if (value) relatedSelections[field] = { included: [value], excluded: [] };
  };
  include('ip', ip);
  include('scenario', scenario);
  include('country', country);
  include('as', network);
  include('target', target);
  if (machine) {
    try { const key = JSON.parse(machine) as string[]; relatedInstance = key[0]; include('machine', key[1]); } catch { /* The API reports invalid URL filters. */ }
  }
  const relatedQuickFilters: StoredQuickFilters = {
    selections: relatedSelections,
    dateRange: quickFilterDateRange(from, to, timeZone, dateTime.timeZone || getBrowserTimeZone()),
    simulation: simulationsEnabled ? simulation as QuickFilterSimulationValue : 'all',
  };
  const relatedHref = (page: 'alerts' | 'decisions') => {
    const params = new URLSearchParams({ instance: relatedInstance, q: mergeStoredQuickFiltersIntoQuery(page, '', relatedQuickFilters) });
    if (page === 'decisions') params.set('include_expired', 'true');
    return `/${page}?${params}`;
  };
  const applyRelatedQuickFilters = () => saveStoredQuickFilters(relatedQuickFilters);

  const presetLabel = (key: Preset) => (key === 'today' ? t('pages.statistics.today')
    : key === 'yesterday' ? t('pages.statistics.yesterday')
      : t('pages.statistics.lastDays', { count: Number(key) }));
  const selectRange = (values: { range: Preset } | { from: string; to: string }) => update('range' in values
    ? { range: values.range, from: null, to: null }
    : { range: null, from: values.from, to: values.to });
  const rangeLabel = `${formatDay(from)} – ${formatDay(to)}`;
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

  const activity = (row: Pick<StatisticsRanking, 'activeDays' | 'firstActivity' | 'lastActivity'>) => (
    <>
      <span className="font-medium text-gray-900 dark:text-gray-100">{t('pages.statistics.activeDays', { count: row.activeDays })}</span>
      {(row.firstActivity || row.lastActivity) && (
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-xs text-gray-500 dark:text-gray-400">
          <dt>{t('pages.statistics.firstSeen')}</dt>
          <dd className="tabular-nums text-gray-700 dark:text-gray-300">{formatTimestamp(row.firstActivity)}</dd>
          <dt>{t('pages.statistics.lastSeen')}</dt>
          <dd className="tabular-nums text-gray-700 dark:text-gray-300">{formatTimestamp(row.lastActivity)}</dd>
        </dl>
      )}
    </>
  );

  const rankings = (kind: 'attackers' | 'machines') => {
    const rows = data?.[kind] || [];
    const attackers = kind === 'attackers';
    const actions = attackers && canBan;
    const title = t(attackers ? 'pages.dashboard.topIps' : 'pages.dashboard.topMachines');
    const table = attackers ? attackerTable : machineTable;
    const cell = 'px-4 py-4 align-top first:pl-6 last:pr-6';
    // Like a single ban, IPs that all returned after a remediation get the longer duration.
    const pending = actions ? pendingBanValues(rows.map((row) => row.value), decided) : [];
    const returned = pending.every((value) => rows.find((row) => row.value === value)?.returnedAfterRemediation);
    const banAll = pending.length > 0 && (
      <BanAllButton count={pending.length} onClick={() => setPendingDecision({
        value: '', values: pending, reason: t(returned ? 'pages.statistics.reasonReturned' : 'pages.statistics.reasonTopAttacker'), duration: returned ? '7d' : '4h',
      })} />
    );
    const reset = resetWidths(table);
    return (
      <Card className="flex flex-col overflow-clip">
        <SectionHeader icon={attackers ? Crosshair : Server} title={title} description={rangeLabel}
          actions={(reset || banAll) && <div className="flex flex-wrap items-center justify-end gap-2">{reset}{banAll}</div>} />
        {rows.length === 0 ? <CardContent><EmptyState>{t('common.noDataAvailable')}</EmptyState></CardContent> : (
          <ResizableTable table={table} bodyClassName="divide-y divide-gray-200 dark:divide-gray-700">
                {rows.map((row) => {
                  const countryName = row.country && row.country !== 'Unknown' ? getCountryName(row.country, language) ?? row.country : t('pages.statistics.unknown');
                  const asn = row.asn && row.asn !== '0' ? (/^AS/i.test(row.asn) ? row.asn : `AS${row.asn}`) : '';
                  return (
                    <ClickableTableRow key={row.value} aria-label={row.label} selected={(attackers ? ip : machine) === row.value} onSelect={() => toggleFilters({ [attackers ? 'ip' : 'machine']: row.value })}>
                      <td className={`${cell} min-w-64`}>
                        <span className="break-all font-medium text-gray-900 dark:text-gray-100">{row.label}</span>
                        {row.returnedAfterRemediation && <Badge variant="danger" className="ml-2 align-middle">{t('pages.statistics.returnedAfterRemediation')}</Badge>}
                        {/* Like the rest of the app, instances are only named when several are configured. */}
                        {(attackers || instances.length > 1) && <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                          {attackers ? <>
                            <CountryFlag code={row.country} />
                            <span className="truncate">{[countryName, asn, row.network].filter(Boolean).join(' · ')}</span>
                          </> : <>
                            {instanceIcon(row.instance)}
                            <span className="truncate">{instanceName(row.instance)}</span>
                          </>}
                        </div>}
                        {scenarioChips(row.scenarios)}
                      </td>
                      <td className={`${cell} text-right font-semibold tabular-nums text-gray-900 dark:text-gray-100`}>{formatNumber(row.alerts)}</td>
                      <td className={`${cell} text-right`}><RemediationPills types={row.remediationTypes} /></td>
                      <td className={cell}>
                        <span className="font-medium tabular-nums text-gray-900 dark:text-gray-100">{formatNumber(attackers ? row.machines : row.uniqueIPs)}</span>
                      </td>
                      <td className={`${cell} whitespace-nowrap`}>{activity(row)}</td>
                      {actions && (
                        <td className={`${cell} whitespace-nowrap text-right ${STICKY_ACTIONS_CELL_CLASS_NAME}`}>
                          {decided.has(row.value)
                            ? <DecisionAddedBadge />
                            : (
                              <DecisionIconButton
                                label={t('pages.statistics.ban')}
                                onClick={() => setPendingDecision({ value: row.value, reason: row.scenarios[0]?.label && row.scenarios[0].label !== 'Unknown' ? row.scenarios[0].label : 'manual', duration: row.returnedAfterRemediation ? '7d' : '4h' })}
                                className="-my-2"
                              />
                            )}
                        </td>
                      )}
                    </ClickableTableRow>
                  );
                })}
          </ResizableTable>
        )}
      </Card>
    );
  };

  // Distinct IPs tell one noisy host apart from many hosts, such as a botnet.
  const breakdown = (title: string, icon: LucideIcon, entries: Array<{ label: string; count: number; uniqueIPs?: number }>, total: number, kind: 'country' | 'network' | 'target') => (
    <StatCard
      key={title}
      title={title}
      icon={icon}
      total={total}
      selectedValue={params.get(kind)}
      onSelect={(item) => toggleFilters({ [kind]: item.value })}
      items={entries.map((entry) => ({
        ...entry,
        label: kind === 'country' && entry.label !== 'Unknown' ? getCountryName(entry.label, language) ?? entry.label : unknown(entry.label),
        value: entry.label,
        countryCode: kind === 'country' && entry.label !== 'Unknown' ? entry.label : undefined,
      }))}
      renderLabel={entries.some((entry) => entry.uniqueIPs !== undefined) ? (item) => (
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100" title={item.label}>{item.label}</span>
          {item.uniqueIPs !== undefined && <span className="shrink-0 text-xs tabular-nums text-gray-500 dark:text-gray-400">{t('pages.statistics.ipCount', { count: formatNumber(item.uniqueIPs) })}</span>}
        </span>
      ) : undefined}
    />
  );

  // Machines with unchanged alert counts, or none in either period, are not listed.
  const machineChanges = data ? [
    { key: 'rising', title: t('pages.statistics.machinesRising'), tone: 'text-red-600 dark:text-red-400', rows: data.increases },
    { key: 'falling', title: t('pages.statistics.machinesFalling'), tone: 'text-green-600 dark:text-green-400', rows: data.decreases },
    { key: 'quiet', title: t('pages.statistics.quiet'), tone: 'text-amber-600 dark:text-amber-400', rows: data.quietMachines.map((row) => ({ ...row, current: 0 })) },
  ].filter((group) => group.rows.length > 0) : [];
  // Quiet machines are absent from the current ranking but still belong to the comparison.
  const hasMultipleMachines = !!data && data.machines.length + data.quietMachines.length > 1;
  const periodChange = usePeriodChange();
  const machineInstance = (value: string) => { try { return (JSON.parse(value) as string[])[0]; } catch { return undefined; } };
  // Ranges within the last two days are charted by hour.
  const hourly = data?.granularity === 'hour';
  const compared = data && !data.coverage.comparisonPartial ? data.previousTotals : null;
  const coverage = data ? remediationCoverage(data.totals.remediatedIPs, data.totals.uniqueIPs) : null;
  const previousCoverage = compared ? remediationCoverage(compared.remediatedIPs, compared.uniqueIPs) : null;
  const delta = (current: number, previous: number | undefined, better: TileDelta['better']): TileDelta | null => (compared && previous !== undefined ? { current, previous, better } : null);
  const decisionTypeLabel = useRemediationTypeLabel();
  const machineName = (value: string, label?: string) => label || (() => { try { return (JSON.parse(value) as string[])[1]; } catch { return value; } })();

  const canBan = config?.permissions?.can_manage_enforcement !== false;
  const rankingColumns = (attackers: boolean): ResizableTableColumn[] => [
    { id: attackers ? 'ip' : 'machine', label: t(attackers ? 'pages.dashboard.ip' : 'tableColumns.machine'), className: TABLE_HEADER_CELL },
    { id: 'alerts', label: t('pages.statistics.alerts'), className: TABLE_RIGHT_HEADER_CELL },
    { id: 'remediations', label: t('pages.statistics.remediations'), className: TABLE_RIGHT_HEADER_CELL },
    { id: attackers ? 'machines' : 'uniqueIPs', label: t(attackers ? 'pages.dashboard.machines' : 'pages.statistics.uniqueIPs'), className: TABLE_HEADER_CELL },
    { id: 'activity', label: t('pages.statistics.activity'), className: TABLE_HEADER_CELL },
    ...(attackers && canBan ? [{ id: 'actions', label: t('tableColumns.actions'), className: `${TABLE_RIGHT_HEADER_CELL} ${STICKY_ACTIONS_HEADER_CLASS_NAME}`, fixedWidth: ACTIONS_COLUMN_WIDTH }] : []),
  ];
  const attackerTable = useResizableTable('statistics-attackers', rankingColumns(true));
  const machineTable = useResizableTable('statistics-machines', rankingColumns(false));
  const scenarioTableWidths = useResizableTable('statistics-scenarios', [
    { id: 'scenario', label: t('tableColumns.scenario'), className: TABLE_HEADER_CELL },
    { id: 'alerts', label: t('pages.statistics.alerts'), className: TABLE_RIGHT_HEADER_CELL },
    { id: 'uniqueIPs', label: t('pages.statistics.uniqueIPs'), className: TABLE_RIGHT_HEADER_CELL },
    { id: 'machines', label: t('pages.dashboard.machines'), className: TABLE_RIGHT_HEADER_CELL },
    { id: 'remediations', label: t('pages.statistics.remediations'), className: TABLE_RIGHT_HEADER_CELL },
    { id: 'coverage', label: t('pages.statistics.remediationCoverage'), className: TABLE_RIGHT_HEADER_CELL },
    { id: 'activity', label: t('pages.statistics.activity'), className: TABLE_HEADER_CELL },
  ]);
  const resetWidths = (table: ResizableTableController) => table.columnWidths.hasCustomWidths && <ResetColumnWidthsButton table={table} />;
  const [pendingDecision, setPendingDecision] = useState<{ value: string; values?: string[]; reason: string; duration: string } | null>(null);
  // Decisions added on this page, and active manual decisions found on the server for the listed values,
  // so the badges survive a reload and disappear once the decisions expire.
  const [decidedByValue, setDecidedByValue] = useState<Map<string, Set<string>>>(() => new Map());
  const [activeByValue, setActiveByValue] = useState<Map<string, Set<string>>>(() => new Map());
  const loadDecided = useCallback((values: string[]) => {
    const unique = [...new Set(values)].slice(0, MANUAL_DECISION_LOOKUP_MAX);
    if (!unique.length) return;
    void lookupManualDecisions(unique).then(({ decisions }) => setActiveByValue((current) => {
      const next = new Map(current);
      for (const value of unique) next.delete(value);
      for (const { value, instance_id } of decisions) next.set(value, new Set([...(next.get(value) ?? []), instance_id]));
      return next;
    }), () => {
      // The ban buttons stay available when the lookup fails.
    });
  }, []);
  const visibleInstanceIds = instance === 'all' ? instances.map(({ id }) => id) : [instance];
  const decided = new Set<string>();
  for (const value of new Set([...decidedByValue.keys(), ...activeByValue.keys()])) {
    const instanceIds = new Set([...(decidedByValue.get(value) ?? []), ...(activeByValue.get(value) ?? [])]);
    if (visibleInstanceIds.length > 0 && visibleInstanceIds.every((id) => instanceIds.has(id))) decided.add(value);
  }
  const attackerValues = canBan ? (data?.attackers ?? []).map((row) => row.value).join('\n') : '';
  useEffect(() => {
    if (attackerValues) loadDecided(attackerValues.split('\n'));
  }, [attackerValues, loadDecided]);
  const findings: Finding[] = [];
  if (data) {
    const compare = !data.coverage.comparisonPartial;
    const scenarioDraft = (scenario: string): DecisionDraft => ({ reason: scenario, duration: '4h' });
    // A machine without alerts may have a stopped agent or broken acquisition.
    data.quietMachines.forEach((row) => findings.push({ key: `quiet-${row.value}`, severity: 'warning',
      text: t('pages.statistics.findingQuietMachine', { machine: machineName(row.value, row.label), count: formatNumber(row.previous) }),
      detail: { kind: 'machines', machines: [row.value] } }));
    // Alerts that never lead to a remediation point at a profile gap.
    const unremediated = data.scenarios.filter((row) => row.remediations === 0);
    unremediated.filter((row) => !isInBandScenario(row.label) && row.count >= FINDINGS.unremediatedScenarioAlerts).forEach((row) => findings.push({
      key: `unremediated-${row.label}`, severity: 'warning',
      text: t('pages.statistics.findingUnremediatedScenario', { scenario: row.label, count: formatNumber(row.count), ips: formatNumber(row.uniqueIPs) }),
      help: { text: t('pages.statistics.findingUnremediatedScenarioHelp'), href: PROFILE_DOCS },
      action: { label: t('pages.statistics.showScenario'), onSelect: () => update({ scenario: row.label }) },
      detail: { kind: 'ips', scenario: row.label, decision: scenarioDraft(row.label) },
    }));
    if (data.totals.returnedAfterRemediation > 0) {
      findings.push({ key: 'returned', severity: 'warning',
        text: t('pages.statistics.findingReturnedAfterRemediation', { count: formatNumber(data.totals.returnedAfterRemediation) }),
        help: { text: t('pages.statistics.findingReturnedAfterRemediationHelp'), href: `${PROFILE_DOCS}#duration_expr` },
        detail: { kind: 'returned', history: compare, decision: { reason: t('pages.statistics.reasonReturned'), duration: '7d' } } });
    }
    if (compare) {
      data.increases.filter((row) => row.current >= FINDINGS.spikeAlerts && row.current >= row.previous * FINDINGS.spikeFactor).forEach((row) => findings.push({
        key: `spike-${row.value}`, severity: 'warning',
        text: t('pages.statistics.findingMachineSpike', { machine: machineName(row.value, row.label), current: formatNumber(row.current), previous: formatNumber(row.previous) }),
        action: { label: t('pages.statistics.showMachine'), onSelect: () => update({ machine: row.value }) },
        detail: { kind: 'machines', machines: [row.value] },
      }));
    }
    unremediated.filter((row) => isInBandScenario(row.label) && row.count >= FINDINGS.inBandAlerts).forEach((row) => findings.push({
      key: `inband-${row.label}`, severity: 'info',
      text: t('pages.statistics.findingInBandScenario', { scenario: row.label, count: formatNumber(row.count), ips: formatNumber(row.uniqueIPs) }),
      help: { text: t('pages.statistics.findingInBandScenarioHelp') },
      action: { label: t('pages.statistics.showScenario'), onSelect: () => update({ scenario: row.label }) },
      detail: { kind: 'ips', scenario: row.label, decision: scenarioDraft(row.label) },
    }));
    if (compare) {
      data.scenarios.filter((row) => row.previous === 0).forEach((row) => findings.push({
        key: `new-${row.label}`, severity: 'info',
        text: t('pages.statistics.findingNewScenario', { scenario: row.label, count: formatNumber(row.count), ips: formatNumber(row.uniqueIPs) }),
        action: { label: t('pages.statistics.showScenario'), onSelect: () => update({ scenario: row.label }) },
        detail: { kind: 'ips', scenario: row.label, decision: scenarioDraft(row.label) },
      }));
    }
    const network = data.networks[0];
    if (network && data.totals.alerts > 0 && network.count / data.totals.alerts >= FINDINGS.networkShare && network.uniqueIPs >= FINDINGS.networkIPs) {
      findings.push({ key: 'network', severity: 'info', text: t('pages.statistics.findingNetwork', {
        network: network.label, percent: Math.round(network.count / data.totals.alerts * 100), ips: formatNumber(network.uniqueIPs) }),
      help: { text: t('pages.statistics.findingNetworkHelp') },
      detail: { kind: 'ips', network: network.label, decision: { reason: t('pages.statistics.reasonNetwork', { network: network.label }), duration: '4h', rangeDuration: '24h' } } });
    }
    const scanners = data.attackers.filter((row) => row.machines >= FINDINGS.wideScannerMachines);
    if (scanners.length) findings.push({ key: 'scanners', severity: 'info',
      text: t('pages.statistics.findingWideScanners', { count: scanners.length, machines: FINDINGS.wideScannerMachines }),
      detail: { kind: 'scanners', rows: scanners, decision: { reason: t('pages.statistics.reasonScanner'), duration: '4h' } } });
  }
  const findingContext = {
    query: queryString, canBan, decided, loadDecided, formatTimestamp, machineName: (value: string) => machineName(value),
    formatDay: (day: string) => formatDay(day),
    onFilter: toggleFilters,
    onBan: (value: string, draft: DecisionDraft, range: boolean) => setPendingDecision({ value, reason: draft.reason, duration: range ? draft.rangeDuration || draft.duration : draft.duration }),
    onBanAll: (values: string[], draft: DecisionDraft, range: boolean) => setPendingDecision({ value: '', values, reason: draft.reason, duration: range ? draft.rangeDuration || draft.duration : draft.duration }),
  };

  const scenarioTable = (rows: StatisticsScenario[]) => {
    const cell = 'px-4 py-3 align-top first:pl-6 last:pr-6';
    return (
      <Card className="flex flex-col overflow-clip">
        <SectionHeader icon={ShieldAlert} title={t('pages.dashboard.topScenarios')} description={t('pages.statistics.scenariosHelp')} actions={resetWidths(scenarioTableWidths)} />
        {rows.length === 0 ? <CardContent><EmptyState>{t('common.noDataAvailable')}</EmptyState></CardContent> : (
          <ResizableTable table={scenarioTableWidths} bodyClassName="divide-y divide-gray-200 dark:divide-gray-700">
                {rows.map((row) => {
                  const share = remediationCoverage(row.remediatedIPs, row.uniqueIPs);
                  const change = row.previous === null || row.previous === 0 ? null : Math.round((row.count - row.previous) / row.previous * 100);
                  return (
                    <ClickableTableRow key={row.label} aria-label={row.label} selected={scenario === row.label} onSelect={() => toggleFilters({ scenario: row.label })}>
                      <td className={`${cell} min-w-64`}>
                        <div className="flex items-start gap-2">
                          <ScenarioName name={row.label} showLink className="min-w-0" />
                          {row.previous === 0 && <Badge variant="info" className="shrink-0">{t('pages.statistics.new')}</Badge>}
                        </div>
                      </td>
                      <td className={`${cell} text-right`}>
                        <span className="font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatNumber(row.count)}</span>
                        {change !== null && <div className={`text-xs tabular-nums ${change > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}>{change > 0 ? '+' : change < 0 ? '−' : '±'}{Math.abs(change)}%</div>}
                      </td>
                      <td className={`${cell} text-right tabular-nums text-gray-700 dark:text-gray-300`}>{formatNumber(row.uniqueIPs)}</td>
                      <td className={`${cell} text-right tabular-nums text-gray-700 dark:text-gray-300`}>{formatNumber(row.machines)}</td>
                      <td className={`${cell} text-right`}><RemediationPills types={row.remediationTypes} /></td>
                      <td className={`${cell} text-right font-medium tabular-nums ${share === 0 && row.count >= FINDINGS.unremediatedScenarioAlerts ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100'}`}>{share === null ? '—' : `${share}%`}</td>
                      <td className={`${cell} whitespace-nowrap`}>{activity(row)}</td>
                    </ClickableTableRow>
                  );
                })}
          </ResizableTable>
        )}
      </Card>
    );
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-5 p-4 sm:p-6">
          <SegmentedControl
            label={t('pages.statistics.range')}
            // Longer presets than the retention would only show an uncovered range.
            options={PRESETS.filter((key) => key === preset || !/^\d+$/.test(key) || !configuration || Number(key) <= configuration.settings.retentionDays).map((key) => ({
              key,
              label: presetLabel(key),
              selected: preset === key,
              onSelect: () => selectRange({ range: key }),
            }))}
          />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <label htmlFor="statistics-from" className={labelClass}>{t('pages.statistics.from')}</label>
              <input id="statistics-from" type="date" max={to} value={from} className={inputClass} onChange={(e) => { if (e.target.value) selectRange({ from: e.target.value, to }); }} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="statistics-to" className={labelClass}>{t('pages.statistics.to')}</label>
              <input id="statistics-to" type="date" min={from} max={today} value={to} className={inputClass} onChange={(e) => { if (e.target.value) selectRange({ from, to: e.target.value }); }} />
            </div>
            {simulationsEnabled && <div className="space-y-1.5">
              <label htmlFor="statistics-mode" className={labelClass}>{t('pages.dashboard.mode')}</label>
              <select id="statistics-mode" value={simulation} className={inputClass} onChange={(e) => update({ simulation: e.target.value })}>
                <option value="live">{t('common.live')}</option>
                <option value="simulated">{t('pages.dashboard.simulation')}</option>
                <option value="all">{t('common.all')}</option>
              </select>
            </div>}
            <div className="space-y-1.5">
              <label htmlFor="statistics-limit" className={labelClass}>{t('pages.statistics.rankings')}</label>
              <select id="statistics-limit" value={limit} className={inputClass} onChange={(e) => update({ limit: e.target.value })}>
                {[10, 20, 50].map((n) => <option key={n} value={n}>{t('pages.statistics.top', { count: n })}</option>)}
              </select>
            </div>
          </div>
          <p className="flex items-start gap-1.5 text-xs leading-5 text-gray-500 dark:text-gray-400">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t('pages.statistics.rangeHint', { timeZone })}
          </p>
          {(ip || machine || scenario || country || network || target) && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-gray-100 pt-4 text-sm dark:border-gray-700/50">
              <div className="flex flex-wrap gap-2">
                {ip && <FilterChip label={ip} clearLabel={t('pages.statistics.clearIP')} onClear={() => update({ ip: null })} />}
                {machine && <FilterChip label={data?.machines.find((m) => m.value === machine)?.label || t('tableColumns.machine')} clearLabel={t('pages.statistics.clearMachine')} onClear={() => update({ machine: null })} />}
                {scenario && <FilterChip label={scenario} clearLabel={t('pages.statistics.clearScenario')} onClear={() => update({ scenario: null })} />}
                {country && <FilterChip label={getCountryName(country, language) ?? country} clearLabel={t('components.quickFilters.clearSection', { field: t('tableColumns.country') })} onClear={() => update({ country: null })} />}
                {network && <FilterChip label={network} clearLabel={t('components.quickFilters.clearSection', { field: t('tableColumns.as') })} onClear={() => update({ network: null })} />}
                {target && <FilterChip label={target} clearLabel={t('components.quickFilters.clearSection', { field: t('tableColumns.target') })} onClear={() => update({ target: null })} />}
              </div>
              <div className="flex flex-wrap gap-2">
                <Link className={actionButtonClass} to={relatedHref('alerts')} onClick={applyRelatedQuickFilters}>
                  <ShieldAlert className="h-4 w-4" aria-hidden="true" />
                  {t('pages.dashboard.viewAlerts')}
                </Link>
                <Link className={actionButtonClass} to={relatedHref('decisions')} onClick={applyRelatedQuickFilters}>
                  <Gavel className="h-4 w-4" aria-hidden="true" />
                  {t('pages.dashboard.viewDecisions')}
                </Link>
              </div>
              <span className="text-xs text-gray-500 dark:text-gray-400">{t('pages.statistics.detailsRetention', { days: config?.lookback_days || 7 })}</span>
            </div>
          )}
        </CardContent>
        {configuration && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-gray-100 bg-gray-50 px-4 py-3 text-xs text-gray-500 sm:px-6 dark:border-gray-700/50 dark:bg-gray-900/40 dark:text-gray-400">
            <span className="inline-flex items-center gap-1.5"><Database className="h-3.5 w-3.5" aria-hidden="true" />{t('pages.statistics.retainedDays', { count: configuration.settings.retentionDays })}</span>
            <span className="inline-flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" aria-hidden="true" />{t('pages.statistics.lastUpdate')}: {formatTimestamp(configuration.status.lastSuccess)}</span>
            <span>{t('pages.statistics.backlog')}: <span className="tabular-nums">{formatNumber(configuration.status.backlog)}</span></span>
            {configuration.status.backfillPending && <Badge variant="info">{t('pages.statistics.backfilling')}</Badge>}
            {!configuration.settings.enabled && <Badge>{t('common.disabled')}</Badge>}
          </div>
        )}
      </Card>

      {data && data.coverage.partial && (
        <Notice tone="warning">
          <p>{t('pages.statistics.partial')}</p>
          <p className="mt-1 text-xs opacity-80">
            {t('pages.statistics.coverage')}: {data.coverage.from ? formatDay(statisticsDay(data.coverage.from, timeZone)) : '—'} – {formatTimestamp(data.coverage.through)}
          </p>
        </Notice>
      )}

      {data && <StatisticsFindings findings={findings} context={{
        ...findingContext, archiveKey: `${data.revision}:${data.configuration.settings.retentionDays}`,
      }} />}

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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 min-[1800px]:grid-cols-6">
          <SummaryTile icon={ShieldAlert} tone="alert" title={t('pages.statistics.alerts')} value={data.totals.alerts} deltaLabel={t('pages.statistics.vsPrevious')}
            delta={delta(data.totals.alerts, compared?.alerts, 'down')} />
          <SummaryTile icon={Users} title={t('pages.statistics.uniqueIPs')} value={data.totals.uniqueIPs} deltaLabel={t('pages.statistics.vsPrevious')}
            hint={data.totals.newIPs === null ? undefined : t('pages.statistics.newIPs', { count: formatNumber(data.totals.newIPs) })}
            delta={delta(data.totals.uniqueIPs, compared?.uniqueIPs, 'down')} />
          <SummaryTile icon={Gavel} tone="decision" title={t('pages.statistics.remediations')} value={data.totals.remediations} deltaLabel={t('pages.statistics.vsPrevious')}
            hint={data.remediationTypes.map((row) => `${decisionTypeLabel(row.label)} ${formatNumber(row.count)}`).join(' · ') || undefined}
            delta={delta(data.totals.remediations, compared?.remediations, 'neutral')} />
          <SummaryTile icon={ShieldCheck} tone="decision" title={t('pages.statistics.remediationCoverage')} value={coverage === null ? '—' : `${coverage}%`} deltaLabel={t('pages.statistics.vsPrevious')}
            hint={t('pages.statistics.remediatedIPs', { remediated: formatNumber(data.totals.remediatedIPs), total: formatNumber(data.totals.uniqueIPs) })}
            delta={coverage !== null && previousCoverage !== null ? { ...delta(coverage, previousCoverage, 'up')!, points: true } : null} />
          <SummaryTile icon={Repeat} title={t('pages.statistics.repeatAttackers')} value={data.totals.repeatAttackers} deltaLabel={t('pages.statistics.vsPrevious')}
            hint={t('pages.statistics.repeatAttackersHelp')} delta={delta(data.totals.repeatAttackers, compared?.repeatAttackers, 'down')} />
          <SummaryTile icon={RotateCcw} tone="alert" title={t('pages.statistics.returnedAfterRemediation')} value={data.totals.returnedAfterRemediation} deltaLabel={t('pages.statistics.vsPrevious')}
            hint={t('pages.statistics.returnedAfterRemediationHelp')} />
        </div>

        <Card>
          <SectionHeader icon={TrendingUp} title={t('components.dashboardCharts.activityHistory')} description={t('pages.statistics.activityHistoryHelp')} />
          <CardContent>
            <div className="h-72 min-w-0" role="img" aria-label={t('components.dashboardCharts.activityHistory')}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.series} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} vertical={false} />
                  <XAxis dataKey="date" {...axisProps} tickFormatter={(value: string) => (hourly ? formatHour(value, from !== to) : formatDay(value, true))} minTickGap={hourly && from !== to ? 48 : 32} />
                  <YAxis {...axisProps} allowDecimals={false} width={48} tickFormatter={formatNumber} />
                  <Tooltip content={<ChartTooltip formatLabel={(value) => (hourly ? formatTimestamp(String(value)) : formatDay(String(value)))} />} />
                  <Legend verticalAlign="top" height={36} iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 13 }} />
                  <Line type="monotone" dataKey="alerts" name={t('pages.statistics.alerts')} stroke={DASHBOARD_COLORS.liveAlerts} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} connectNulls={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="decisions" name={t('pages.statistics.decisions')} stroke={DASHBOARD_COLORS.liveDecisions} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} connectNulls={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {rankings('attackers')}
        {scenarioTable(data.scenarios)}
        {hasMultipleMachines && rankings('machines')}

        <div className="space-y-6">
          <div className="grid min-w-0 items-start gap-6 md:grid-cols-2 xl:grid-cols-3">
            {breakdown(t('pages.dashboard.topTargets'), Target, data.targets, data.totals.alerts, 'target')}
            {breakdown(t('pages.dashboard.topCountries'), Globe, data.countries, data.totals.alerts, 'country')}
            {breakdown(t('pages.dashboard.topAs'), Network, data.networks, data.totals.alerts, 'network')}
          </div>
          {hasMultipleMachines && <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <TrendingUp className="h-5 w-5 text-primary-600 dark:text-primary-400" aria-hidden="true" />
                {t('pages.statistics.machineChanges')}
              </CardTitle>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('pages.statistics.machineChangesHelp')}</p>
            </CardHeader>
            <CardContent>
              {data.coverage.comparisonPartial ? <EmptyState>{t('pages.statistics.comparisonPartial')}</EmptyState>
                : machineChanges.length === 0 ? <EmptyState>{t('common.noDataAvailable')}</EmptyState> : (
                  <div className={`grid gap-6 ${machineChanges.length === 3 ? 'lg:grid-cols-3' : ''} ${machineChanges.length > 1 ? 'md:grid-cols-2' : ''}`}>
                    {machineChanges.map((group) => (
                      <section key={group.key} aria-label={group.title}>
                        <h3 className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{group.title}</h3>
                        <div className="space-y-1">
                          {group.rows.map((row) => {
                            const quiet = row.current === 0;
                            const owner = machineInstance(row.value);
                            const label = t('pages.statistics.machineChangeLabel', { machine: machineName(row.value, row.label), previous: formatNumber(row.previous), current: formatNumber(row.current) });
                            return (
                              <button
                                key={row.value}
                                type="button"
                                disabled={quiet}
                                onClick={() => toggleFilters({ machine: row.value })}
                                title={label}
                                aria-label={label}
                                aria-pressed={machine === row.value}
                                className={`block w-full cursor-pointer rounded-lg border p-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-primary-500 disabled:cursor-default disabled:hover:bg-transparent dark:disabled:hover:bg-transparent ${machine === row.value
                                  ? 'border-primary-200 bg-primary-50 dark:border-primary-800 dark:bg-primary-900/40'
                                  : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-700/50'}`}
                              >
                                <PeriodChangeRow
                                  previous={row.previous}
                                  current={row.current}
                                  change={periodChange(row.previous, row.current)}
                                  changeClassName={group.tone}
                                  label={<>
                                    {instances.length > 1 && owner && instanceIcon(owner)}
                                    <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{machineName(row.value, row.label)}</span>
                                    {instances.length > 1 && owner && <span className="hidden shrink-0 truncate text-xs text-gray-500 sm:inline dark:text-gray-400">{instanceName(owner)}</span>}
                                  </>}
                                />
                              </button>
                            );
                          })}
                        </div>
                      </section>
                    ))}
                  </div>
                )}
            </CardContent>
          </Card>}
        </div>
      </>}

      {pendingDecision && (
        <AddDecisionModal
          initialDecision={{ ip: pendingDecision.value, duration: pendingDecision.duration, reason: pendingDecision.reason }}
          values={pendingDecision.values}
          instances={instances}
          multipleInstances={instances.length > 1}
          currentInstanceId={instance !== 'all' ? instance : undefined}
          currentInstanceName={instance !== 'all' ? instanceName(instance) : undefined}
          defaultAllInstances={instance === 'all'}
          onClose={() => setPendingDecision(null)}
          onDecisionAdded={async (added) => {
            setDecidedByValue((current) => {
              const next = new Map(current);
              for (const { values, instanceIds } of added) {
                for (const value of values) next.set(value, new Set([...(next.get(value) ?? []), ...instanceIds]));
              }
              return next;
            });
          }}
        />
      )}
    </div>
  );
}
