import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertCircle,
  Bot,
  CheckCircle2,
  Clock3,
  DatabaseZap,
  FileSearch,
  ListChecks,
  Network,
  RefreshCw,
  Server,
  ShieldCheck,
  ShieldOff,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { fetchConfig, fetchCrowdsecMetrics } from '../lib/api';
import { useRefresh } from '../contexts/useRefresh';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card';
import { Switch } from '../components/ui/Switch';
import { useI18n } from '../lib/i18n';
import type {
  CrowdsecMetricsApiEntity,
  CrowdsecMetricsAppsecEngine,
  CrowdsecMetricsLapiRoute,
  CrowdsecMetricsParserNode,
  CrowdsecMetricsParserSource,
  CrowdsecMetricsResponse,
  CrowdsecMetricsTiming,
  CrowdsecMetricsWhitelist,
  InstanceSummary,
} from '../types';

type MetricsState =
  | { status: 'loading' }
  | { status: 'disabled' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: CrowdsecMetricsResponse };

const SHOW_CHILD_PARSER_NODES_STORAGE_KEY = 'crowdsec-web-ui:metrics:show-child-parser-nodes';

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString();
}

function formatPercent(value: number | null, notAvailable = 'n/a'): string {
  if (value === null) return notAvailable;
  return `${(value * 100).toFixed(1)}%`;
}

function formatDuration(value: number | null, notAvailable = 'n/a'): string {
  if (value === null) return notAvailable;
  if (value < 0.001) return `${(value * 1_000_000).toFixed(1)} us`;
  if (value < 1) return `${(value * 1_000).toFixed(1)} ms`;
  return `${value.toFixed(2)} s`;
}

function formatOptionalNumber(value: number | null): string {
  return value === null ? '-' : formatNumber(value);
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function readStoredShowChildParserNodes(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return window.localStorage.getItem(SHOW_CHILD_PARSER_NODES_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveShowChildParserNodes(showChildParserNodes: boolean): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(SHOW_CHILD_PARSER_NODES_STORAGE_KEY, String(showChildParserNodes));
  } catch {
    // This is a convenience preference; metrics continue to render without storage.
  }
}

type MetricTone = 'neutral' | 'success' | 'warning' | 'danger';

const toneClasses: Record<MetricTone, {
  text: string;
  bg: string;
  bar: string;
}> = {
  neutral: {
    text: 'text-primary-600 dark:text-primary-400',
    bg: 'bg-primary-50 dark:bg-primary-900/30',
    bar: 'bg-primary-500',
  },
  success: {
    text: 'text-emerald-700 dark:text-emerald-300',
    bg: 'bg-emerald-50 dark:bg-emerald-950/40',
    bar: 'bg-emerald-500',
  },
  warning: {
    text: 'text-amber-700 dark:text-amber-300',
    bg: 'bg-amber-50 dark:bg-amber-950/40',
    bar: 'bg-amber-500',
  },
  danger: {
    text: 'text-amber-800 dark:text-amber-300',
    bg: 'bg-amber-50 dark:bg-amber-950/40',
    bar: 'bg-amber-500',
  },
};

function successTone(value: number | null): MetricTone {
  if (value === null) return 'neutral';
  if (value >= 0.8) return 'success';
  if (value >= 0.5) return 'warning';
  return 'danger';
}

function latencyTone(value: number | null): MetricTone {
  if (value === null) return 'neutral';
  if (value > 1) return 'danger';
  if (value > 0.25) return 'warning';
  return 'success';
}

function parserTimingTone(value: number | null): MetricTone {
  if (value === null) return 'neutral';
  if (value > 0.01) return 'danger';
  if (value >= 0.001) return 'warning';
  return 'success';
}

function ProgressBar({ value, tone = 'neutral' }: { value: number | null; tone?: MetricTone }) {
  const percent = value === null ? 0 : Math.max(0, Math.min(100, value * 100));

  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
      <div
        className={`h-full rounded-full transition-[width] ${toneClasses[tone].bar}`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function DecisionResponseBar({ empty, nonEmpty }: { empty: number; nonEmpty: number }) {
  const total = empty + nonEmpty;
  const emptyPercent = total > 0 ? Math.max(0, Math.min(100, (empty / total) * 100)) : 0;

  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-amber-500">
      <div
        className="h-full rounded-full bg-emerald-500 transition-[width]"
        style={{ width: `${emptyPercent}%` }}
      />
    </div>
  );
}

function ParserResultBar({ parsed, unparsed }: { parsed: number; unparsed: number }) {
  const total = parsed + unparsed;
  const parsedPercent = total > 0 ? Math.max(0, Math.min(100, (parsed / total) * 100)) : 0;

  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-amber-500">
      <div
        className="h-full rounded-full bg-emerald-500 transition-[width]"
        style={{ width: `${parsedPercent}%` }}
      />
    </div>
  );
}

function MetricTile({
  title,
  value,
  detail,
  icon: Icon,
  tone = 'neutral',
}: {
  title: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  tone?: MetricTone;
}) {
  const toneClass = toneClasses[tone];

  return (
    <Card>
      <CardContent className="flex min-h-32 items-center gap-4 p-4 sm:p-5">
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${toneClass.bg} ${toneClass.text}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">{title}</p>
          <p className="mt-1 truncate text-2xl font-bold text-gray-900 dark:text-white">{value}</p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{detail}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function SectionHeader({
  icon: Icon,
  title,
  description,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <CardTitle className="flex items-center gap-2">
          <Icon className="h-5 w-5 text-primary-600 dark:text-primary-400" />
          {title}
        </CardTitle>
        <p className="mt-2 text-sm leading-6 text-gray-500 dark:text-gray-400">{description}</p>
      </div>
      {actions && (
        <div className="shrink-0 sm:pt-0.5">
          {actions}
        </div>
      )}
    </CardHeader>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-200 p-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
      {message}
    </div>
  );
}

function TooltipValue({ children, tone, tooltip, className = '' }: { children: ReactNode; tone: MetricTone; tooltip: string; className?: string }) {
  return (
    <span className="group relative inline-flex shrink-0">
      <span
        tabIndex={0}
        aria-label={tooltip}
        className={`rounded-md px-2 py-1 outline-none ring-offset-2 ring-offset-white focus:ring-2 focus:ring-primary-500 dark:ring-offset-gray-800 ${toneClasses[tone].bg} ${toneClasses[tone].text} ${className}`}
      >
        {children}
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute right-0 top-full z-20 mt-2 hidden w-72 rounded-lg bg-gray-900 px-3 py-2 text-left text-xs font-normal leading-5 text-white shadow-lg group-hover:block group-focus-within:block dark:bg-gray-700"
      >
        {tooltip}
      </span>
    </span>
  );
}

function ParserSuccessBadge({ value, tooltip }: { value: number | null; tooltip: string }) {
  return (
    <TooltipValue tone={successTone(value)} tooltip={tooltip} className="text-xs font-semibold">
      {formatPercent(value)}
    </TooltipValue>
  );
}

function TimingValue({ value, tooltip, fallback }: { value: number | null; tooltip: string; fallback: string }) {
  return (
    <TooltipValue tone={parserTimingTone(value)} tooltip={tooltip} className="font-mono text-lg font-bold">
      {formatDuration(value, fallback)}
    </TooltipValue>
  );
}

function EntityList({
  title,
  icon: Icon,
  items,
  emptyMessage,
  description,
}: {
  title: string;
  icon: LucideIcon;
  items: CrowdsecMetricsApiEntity[];
  emptyMessage: string;
  description: string;
}) {
  const { t } = useI18n();

  return (
    <Card className="h-full">
      <SectionHeader icon={Icon} title={title} description={description} />
      <CardContent>
        {items.length === 0 ? (
          <EmptyState message={emptyMessage} />
        ) : (
          <div className="space-y-3">
            {items.map((item) => {
              const nonEmptyDecisions = item.decisionsOk || 0;
              const emptyDecisions = item.decisionsKo || 0;
              const decisionTotal = nonEmptyDecisions + emptyDecisions;

              return (
                <div key={item.name} className="rounded-lg border border-gray-100 p-3 dark:border-gray-700/70">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-gray-900 dark:text-white" title={item.name}>{item.name}</p>
                      <p className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">
                        {item.topMethod && item.topRoute ? `${item.topMethod} ${item.topRoute}` : t('pages.metrics.noRouteActivity')}
                      </p>
                    </div>
                    <div className="text-left sm:text-right">
                      <p className="font-mono text-lg font-semibold text-gray-900 dark:text-white">{formatNumber(item.requests)}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{t('pages.metrics.labels.requests')}</p>
                    </div>
                  </div>
                  {decisionTotal > 0 && (
                    <div className="mt-3">
                      <DecisionResponseBar empty={emptyDecisions} nonEmpty={nonEmptyDecisions} />
                      <div className="mt-3 grid grid-cols-2 gap-2 text-center text-xs">
                        <div>
                          <p className="font-mono text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                            {formatNumber(emptyDecisions)}
                          </p>
                          <p className="text-gray-500 dark:text-gray-400">
                            {t('pages.metrics.labels.empty', { count: '' }).trim()}
                          </p>
                        </div>
                        <div>
                          <p className="font-mono text-sm font-semibold text-amber-700 dark:text-amber-300">
                            {formatNumber(nonEmptyDecisions)}
                          </p>
                          <p className="text-gray-500 dark:text-gray-400">
                            {t('pages.metrics.labels.nonEmpty', { count: '' }).trim()}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ParserSourceList({ items }: { items: CrowdsecMetricsParserSource[] }) {
  const { t } = useI18n();

  return (
    <Card className="overflow-visible">
      <SectionHeader
        icon={FileSearch}
        title={t('pages.metrics.parserSources')}
        description={t('pages.metrics.parserSourcesDescription')}
      />
      <CardContent>
        {items.length === 0 ? (
          <EmptyState message={t('pages.metrics.emptyParserSources')} />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {items.map((item) => (
              <div key={`${item.source}-${item.type}`} className="rounded-lg border border-gray-100 p-4 dark:border-gray-700/70">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-gray-900 dark:text-white" title={item.source}>{item.source}</p>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {item.type}{item.acquisTypes.length > 0 ? ` / ${item.acquisTypes.join(', ')}` : ''}
                    </p>
                  </div>
                  <ParserSuccessBadge
                    value={item.successRate}
                    tooltip={t('pages.metrics.parserSuccessTooltip')}
                  />
                </div>
                <div className="mt-4">
                  <ParserResultBar parsed={item.parsedOk} unparsed={item.parsedKo} />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-5">
                  <div>
                    <p className="font-mono text-sm font-semibold text-gray-900 dark:text-white">{formatOptionalNumber(item.linesRead)}</p>
                    <p className="text-gray-500 dark:text-gray-400">{t('pages.metrics.labels.read')}</p>
                  </div>
                  <div>
                    <p className="font-mono text-sm font-semibold text-emerald-700 dark:text-emerald-300">{formatNumber(item.parsedOk)}</p>
                    <p className="text-gray-500 dark:text-gray-400">{t('pages.metrics.labels.parsed')}</p>
                  </div>
                  <div>
                    <p className="font-mono text-sm font-semibold text-amber-800 dark:text-amber-300">{formatNumber(item.parsedKo)}</p>
                    <p className="text-gray-500 dark:text-gray-400">{t('pages.metrics.labels.unparsed')}</p>
                  </div>
                  <div>
                    <p className="font-mono text-sm font-semibold text-gray-900 dark:text-white">{formatNumber(item.pouredToBucket)}</p>
                    <p className="text-gray-500 dark:text-gray-400">{t('pages.metrics.labels.poured')}</p>
                  </div>
                  <div>
                    <p className="font-mono text-sm font-semibold text-gray-900 dark:text-white">{formatNumber(item.whitelisted)}</p>
                    <p className="text-gray-500 dark:text-gray-400">{t('pages.metrics.labels.whitelisted')}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AppsecActivityBar({ requests, blocked }: { requests: number; blocked: number }) {
  const allowed = Math.max(requests - blocked, 0);
  const total = requests > 0 ? requests : blocked;
  const allowedPercent = total > 0 ? Math.max(0, Math.min(100, (allowed / total) * 100)) : 0;
  const blockedPercent = total > 0 ? Math.max(0, Math.min(100, (blocked / total) * 100)) : 0;

  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
      <div
        className="h-full bg-emerald-500 transition-[width]"
        style={{ width: `${allowedPercent}%` }}
      />
      <div
        className="h-full bg-amber-500 transition-[width]"
        style={{ width: `${blockedPercent}%` }}
      />
    </div>
  );
}

function ParserNodeList({ items, showChildNodes, onShowChildNodesChange }: { items: CrowdsecMetricsParserNode[]; showChildNodes: boolean; onShowChildNodesChange: (next: boolean) => void }) {
  const { t } = useI18n();
  const notAvailable = t('pages.metrics.notAvailable');
  const visibleItems = showChildNodes ? items : items.filter((item) => !item.isChild);
  const switchId = 'show-child-parser-nodes';
  const switchLabelId = `${switchId}-label`;

  return (
    <Card>
      <SectionHeader
        icon={DatabaseZap}
        title={t('pages.metrics.parserNodes')}
        description={t('pages.metrics.parserNodesDescription')}
        actions={items.length > 0 ? (
          <div className="flex items-center gap-2 rounded-md border border-gray-100 bg-gray-50 px-2.5 py-1.5 dark:border-gray-700/70 dark:bg-gray-900/40">
            <label id={switchLabelId} htmlFor={switchId} className="whitespace-nowrap text-xs font-medium text-gray-700 dark:text-gray-200">
              {t('pages.metrics.showChildParserNodes')}
            </label>
            <Switch id={switchId} checked={showChildNodes} onCheckedChange={onShowChildNodesChange} ariaLabelledBy={switchLabelId} />
          </div>
        ) : undefined}
      />
      <CardContent>
        {items.length === 0 ? (
          <EmptyState message={t('pages.metrics.emptyParserNodes')} />
        ) : visibleItems.length === 0 ? (
          <EmptyState message={t('pages.metrics.emptyParserNodesAfterFilter')} />
        ) : (
          <div className="overflow-hidden rounded-lg border border-gray-100 dark:border-gray-700/70">
            <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1fr)_110px_110px] gap-3 border-b border-gray-100 bg-gray-50 px-4 py-2 text-xs font-semibold uppercase text-gray-500 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-400 lg:grid">
              <span>{t('pages.metrics.columns.node')}</span>
              <span>{t('pages.metrics.columns.stage')}</span>
              <span className="text-right">{t('pages.metrics.columns.processed')}</span>
              <span className="text-right">{t('pages.metrics.columns.success')}</span>
            </div>
            <div className="divide-y divide-gray-100 dark:divide-gray-700/70">
              {visibleItems.map((item) => (
                <div key={`${item.name}-${item.stage}-${item.source}-${item.acquisType || ''}`} className="grid gap-2 px-4 py-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_110px_110px] lg:items-center lg:gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-gray-900 dark:text-white" title={item.name}>{item.name}</p>
                    <p className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400" title={item.source}>
                      {item.type} / {item.source}
                    </p>
                  </div>
                  <div className="text-sm text-gray-600 dark:text-gray-300">{item.stage}</div>
                  <div className="font-mono text-sm font-semibold text-gray-900 dark:text-white lg:text-right">{formatNumber(item.processed)}</div>
                  <div className="space-y-1 lg:text-right">
                    <span className="text-sm font-semibold text-gray-900 dark:text-white">{formatPercent(item.successRate, notAvailable)}</span>
                    <ProgressBar value={item.successRate} tone={successTone(item.successRate)} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function WhitelistList({ items }: { items: CrowdsecMetricsWhitelist[] }) {
  const { t } = useI18n();

  if (items.length === 0) {
    return null;
  }

  return (
    <Card>
      <SectionHeader
        icon={ListChecks}
        title={t('pages.metrics.whitelists')}
        description={t('pages.metrics.whitelistsDescription')}
      />
      <CardContent>
        <div className="overflow-hidden rounded-lg border border-gray-100 dark:border-gray-700/70">
          <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,2fr)_100px_120px] gap-3 border-b border-gray-100 bg-gray-50 px-4 py-2 text-xs font-semibold uppercase text-gray-500 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-400 lg:grid">
            <span>{t('pages.metrics.columns.whitelist')}</span>
            <span>{t('pages.metrics.columns.reason')}</span>
            <span className="text-right">{t('pages.metrics.columns.hits')}</span>
            <span className="text-right">{t('pages.metrics.columns.whitelisted')}</span>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-700/70">
            {items.map((item) => (
              <div key={`${item.name}-${item.reason}`} className="grid gap-2 px-4 py-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_100px_120px] lg:items-center lg:gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-gray-900 dark:text-white" title={item.name}>{item.name}</p>
                </div>
                <div className="truncate text-sm text-gray-600 dark:text-gray-300" title={item.reason}>{item.reason}</div>
                <div className="font-mono text-sm font-semibold text-gray-900 dark:text-white lg:text-right">{formatNumber(item.hits)}</div>
                <div className="font-mono text-sm font-semibold text-gray-900 dark:text-white lg:text-right">{formatNumber(item.whitelisted)}</div>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function TimingList({ items }: { items: CrowdsecMetricsTiming[] }) {
  const { t } = useI18n();
  const notAvailable = t('pages.metrics.notAvailable');
  const timingTooltip = t('pages.metrics.parserTimingTooltip');

  return (
    <Card className="overflow-visible">
      <SectionHeader
        icon={Clock3}
        title={t('pages.metrics.parserTiming')}
        description={t('pages.metrics.parserTimingDescription')}
      />
      <CardContent>
        {items.length === 0 ? (
          <EmptyState message={t('pages.metrics.emptyParserTiming')} />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {items.map((item) => (
              <div key={`${item.source}-${item.type}`} className="rounded-lg bg-gray-50 p-4 dark:bg-gray-900/40">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-gray-900 dark:text-white" title={item.source}>{item.source}</p>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{item.type}</p>
                  </div>
                  <TimingValue value={item.averageSeconds} tooltip={timingTooltip} fallback={notAvailable} />
                </div>
                <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">{t('pages.metrics.parsedLinesTimed', { count: formatNumber(item.count) })}</p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LapiLatencyList({ items }: { items?: CrowdsecMetricsLapiRoute[] }) {
  const { t } = useI18n();
  const notAvailable = t('pages.metrics.notAvailable');
  const routes = items || [];

  return (
    <Card>
      <SectionHeader
        icon={Network}
        title={t('pages.metrics.lapiLatency')}
        description={t('pages.metrics.lapiLatencyDescription')}
      />
      <CardContent>
        {routes.length === 0 ? (
          <EmptyState message={t('pages.metrics.emptyLapiLatency')} />
        ) : (
          <div className="overflow-hidden rounded-lg border border-gray-100 dark:border-gray-700/70">
            <div className="hidden grid-cols-[90px_minmax(0,2fr)_110px_130px] gap-3 border-b border-gray-100 bg-gray-50 px-4 py-2 text-xs font-semibold uppercase text-gray-500 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-400 lg:grid">
              <span>{t('pages.metrics.columns.method')}</span>
              <span>{t('pages.metrics.columns.route')}</span>
              <span className="text-right">{t('pages.metrics.columns.requests')}</span>
              <span className="text-right">{t('pages.metrics.columns.average')}</span>
            </div>
            <div className="divide-y divide-gray-100 dark:divide-gray-700/70">
              {routes.map((item) => {
                const tone = latencyTone(item.averageSeconds);

                return (
                  <div key={`${item.method}-${item.route}`} className="grid gap-2 px-4 py-3 lg:grid-cols-[90px_minmax(0,2fr)_110px_130px] lg:items-center lg:gap-3">
                    <div className="font-mono text-xs font-semibold text-gray-600 dark:text-gray-300">{item.method}</div>
                    <div className="truncate text-sm font-medium text-gray-900 dark:text-white" title={item.route}>{item.route}</div>
                    <div className="font-mono text-sm font-semibold text-gray-900 dark:text-white lg:text-right">{formatNumber(item.requests)}</div>
                    <div className={`font-mono text-sm font-semibold lg:text-right ${toneClasses[tone].text}`}>{formatDuration(item.averageSeconds, notAvailable)}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AppsecEngineList({ items }: { items?: CrowdsecMetricsAppsecEngine[] }) {
  const { t } = useI18n();
  const notAvailable = t('pages.metrics.notAvailable');
  const engines = items || [];
  const blockRateTooltip = t('pages.metrics.appsecBlockRateTooltip');

  return (
    <Card className="overflow-visible">
      <SectionHeader
        icon={ShieldOff}
        title={t('pages.metrics.appsecEngines')}
        description={t('pages.metrics.appsecEnginesDescription')}
      />
      <CardContent>
        {engines.length === 0 ? (
          <EmptyState message={t('pages.metrics.emptyAppsecEngines')} />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {engines.map((item) => {
              const blockTone: MetricTone = item.blocked > 0 ? 'warning' : 'neutral';
              const allowed = Math.max(item.requests - item.blocked, 0);

              return (
                <div key={`${item.engine}-${item.source}`} className="rounded-lg border border-gray-100 p-4 dark:border-gray-700/70">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-gray-900 dark:text-white" title={item.engine}>{item.engine}</p>
                      <p className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400" title={item.source}>{item.source}</p>
                    </div>
                    <TooltipValue tone={blockTone} tooltip={blockRateTooltip} className="text-xs font-semibold">
                      {formatPercent(item.blockRate, notAvailable)}
                    </TooltipValue>
                  </div>
                  <div className="mt-4">
                    <AppsecActivityBar requests={item.requests} blocked={item.blocked} />
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                    <div className="text-left">
                      <p className="font-mono text-sm font-semibold text-gray-900 dark:text-white">{formatNumber(item.requests)}</p>
                      <p className="text-gray-500 dark:text-gray-400">{t('pages.metrics.labels.requests')}</p>
                    </div>
                    <div className="text-center">
                      <p className="font-mono text-sm font-semibold text-emerald-700 dark:text-emerald-300">{formatNumber(allowed)}</p>
                      <p className="text-gray-500 dark:text-gray-400">{t('pages.metrics.labels.allowed')}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-mono text-sm font-semibold text-amber-700 dark:text-amber-300">{formatNumber(item.blocked)}</p>
                      <p className="text-gray-500 dark:text-gray-400">{t('pages.metrics.labels.blocked')}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function Metrics() {
  const { t } = useI18n();
  const { refreshSignal } = useRefresh();
  const location = useLocation();
  const navigate = useNavigate();
  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const setSearchParams = useCallback((next: URLSearchParams, options?: { replace?: boolean }) => {
    const nextSearch = next.toString();
    void navigate({
      pathname: location.pathname,
      search: nextSearch ? `?${nextSearch}` : '',
      hash: location.hash,
    }, { replace: options?.replace });
  }, [location.hash, location.pathname, navigate]);
  const [state, setState] = useState<MetricsState>({ status: 'loading' });
  const [instances, setInstances] = useState<InstanceSummary[]>([]);
  const [showChildParserNodes, setShowChildParserNodes] = useState(readStoredShowChildParserNodes);
  const requestedInstanceId = searchParams.get('instance');
  const requestedEndpointId = searchParams.get('endpoint');
  const requestedMetricsInstanceId = searchParams.get('metrics_instance');

  const handleShowChildParserNodesChange = useCallback((next: boolean) => {
    setShowChildParserNodes(next);
    saveShowChildParserNodes(next);
  }, []);

  const load = useCallback(async (background = false) => {
    if (!background) setState({ status: 'loading' });

    try {
      const config = await fetchConfig();
      const configuredInstances = config.instances || [];
      setInstances(configuredInstances);
      if (configuredInstances.length === 0) {
        if (config.metrics_enabled === false) {
          setState({ status: 'disabled' });
          return;
        }
        const data = await fetchCrowdsecMetrics();
        setState({ status: 'ready', data });
        return;
      }
      const instanceScope = requestedInstanceId || (configuredInstances.length > 1 ? 'all' : configuredInstances[0].id);
      const scopedInstances = instanceScope === 'all'
        ? configuredInstances
        : [configuredInstances.find((instance) => instance.id === instanceScope) || configuredInstances[0]];
      const endpointChoices = scopedInstances.flatMap((instance) =>
        instance.prometheus.map((endpoint) => ({ instance, endpoint })),
      );
      if (endpointChoices.length === 0) {
        setState({ status: 'disabled' });
        return;
      }

      const selectedChoice = endpointChoices.find(({ instance, endpoint }) =>
        endpoint.id === requestedEndpointId
        && (instanceScope !== 'all' || instance.id === requestedMetricsInstanceId),
      ) || endpointChoices.find(({ endpoint }) => endpoint.id === requestedEndpointId)
        || endpointChoices[0];
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set('endpoint', selectedChoice.endpoint.id);
      if (instanceScope === 'all') {
        nextParams.set('metrics_instance', selectedChoice.instance.id);
      } else {
        nextParams.delete('metrics_instance');
      }
      if (nextParams.toString() !== searchParams.toString()) {
        setSearchParams(nextParams, { replace: true });
      }
      const data = await fetchCrowdsecMetrics(selectedChoice.instance.id, selectedChoice.endpoint.id);
      setState({ status: 'ready', data });
    } catch (error: unknown) {
      setState({ status: 'error', message: getErrorMessage(error, t('pages.metrics.fetchFailed')) });
    }
  }, [requestedEndpointId, requestedInstanceId, requestedMetricsInstanceId, searchParams, setSearchParams, t]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void load();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [load]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      if (state.status === 'ready') {
        void load(true);
      }
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [load, refreshSignal, state.status]);

  const content = useMemo(() => {
    if (state.status === 'loading') {
      return (
        <Card>
          <CardContent className="p-8 text-center text-gray-500 dark:text-gray-400">{t('app.loading')}</CardContent>
        </Card>
      );
    }

    if (state.status === 'disabled') {
      return (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {t('pages.metrics.disabledTitle')}{' '}
            {t('pages.metrics.disabledPrefix')}{' '}
            <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs dark:bg-amber-900/50">
              CONFIG_INSTANCE_METRICS_URL
            </code>{' '}
            {t('pages.metrics.disabledMiddle')}{' '}
            <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs dark:bg-amber-900/50">full</code>{' '}
            {t('pages.metrics.disabledSuffix')}
          </span>
        </div>
      );
    }

    if (state.status === 'error') {
      return (
        <Card>
          <CardContent className="flex flex-col gap-4 p-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" />
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{t('pages.metrics.unavailableTitle')}</h2>
                <p className="mt-2 break-words text-sm leading-6 text-gray-600 dark:text-gray-300">{state.message}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex w-fit items-center gap-2 rounded-lg bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-700"
            >
              <RefreshCw className="h-4 w-4" />
              {t('pages.metrics.retry')}
            </button>
          </CardContent>
        </Card>
      );
    }

    const { data } = state;

    return (
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 min-[1800px]:grid-cols-6">
          <MetricTile title={t('pages.metrics.bouncerApiRequests')} value={formatNumber(data.totals.bouncerRequests)} detail={t('pages.metrics.groupedByBouncer')} icon={ShieldCheck} />
          <MetricTile title={t('pages.metrics.machineApiRequests')} value={formatNumber(data.totals.machineRequests)} detail={t('pages.metrics.groupedByMachine')} icon={Server} />
          <MetricTile title={t('pages.metrics.appsecRequests')} value={formatNumber(data.totals.appsecRequests)} detail={t('pages.metrics.blockedCount', { count: formatNumber(data.totals.appsecBlocked) })} icon={ShieldOff} />
          <MetricTile title={t('pages.metrics.whitelistHits')} value={formatNumber(data.totals.whitelistHits)} detail={t('pages.metrics.whitelistedCount', { count: formatNumber(data.totals.whitelisted) })} icon={ListChecks} />
          <MetricTile title={t('pages.metrics.parserEvents')} value={formatNumber(data.totals.parserProcessed)} detail={t('pages.metrics.unparsedCount', { count: formatNumber(data.totals.parserKo) })} icon={Activity} />
          <MetricTile title={t('pages.metrics.parsedSuccessfully')} value={formatPercent(data.totals.parserSuccessRate, t('pages.metrics.notAvailable'))} detail={t('pages.metrics.averageDuration', { duration: formatDuration(data.totals.parserAverageSeconds, t('pages.metrics.notAvailable')) })} icon={CheckCircle2} />
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <EntityList title={t('pages.metrics.bouncers')} icon={ShieldCheck} items={data.bouncers} emptyMessage={t('pages.metrics.emptyBouncers')} description={t('pages.metrics.bouncersDescription')} />
          <EntityList title={t('pages.metrics.machines')} icon={Bot} items={data.machines} emptyMessage={t('pages.metrics.emptyMachines')} description={t('pages.metrics.machinesDescription')} />
        </div>

        <AppsecEngineList items={data.appsecEngines} />
        <ParserSourceList items={data.parserSources} />
        <TimingList items={data.parserTimings} />
        <LapiLatencyList items={data.lapiRoutes} />
        <ParserNodeList items={data.parserNodes} showChildNodes={showChildParserNodes} onShowChildNodesChange={handleShowChildParserNodesChange} />
        <WhitelistList items={data.whitelists} />
      </div>
    );
  }, [handleShowChildParserNodesChange, load, showChildParserNodes, state, t]);

  const instanceScope = requestedInstanceId || (instances.length > 1 ? 'all' : instances[0]?.id);
  const scopedInstances = instanceScope === 'all'
    ? instances
    : [instances.find((instance) => instance.id === instanceScope) || instances[0]].filter(Boolean) as InstanceSummary[];
  const endpointChoices = scopedInstances.flatMap((instance) =>
    instance.prometheus.map((endpoint) => ({ instance, endpoint })),
  );
  const selectedChoice = endpointChoices.find(({ instance, endpoint }) =>
    endpoint.id === requestedEndpointId
    && (instanceScope !== 'all' || instance.id === requestedMetricsInstanceId),
  ) || endpointChoices.find(({ endpoint }) => endpoint.id === requestedEndpointId)
    || endpointChoices[0];
  const showEndpointSelector = endpointChoices.length > 1;

  return (
    <div className="space-y-6">
      {showEndpointSelector && selectedChoice && (
        <div className="flex flex-wrap gap-3 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <label className="flex min-w-52 flex-col gap-1 text-sm font-medium text-gray-700 dark:text-gray-200">
            {t('pages.metrics.metricsEndpoint')}
            <select
              value={`${selectedChoice.instance.id}:${selectedChoice.endpoint.id}`}
              onChange={(event) => {
                const choice = endpointChoices.find(({ instance, endpoint }) =>
                  `${instance.id}:${endpoint.id}` === event.target.value,
                );
                if (!choice) return;
                const next = new URLSearchParams(searchParams);
                next.set('endpoint', choice.endpoint.id);
                if (instanceScope === 'all') {
                  next.set('metrics_instance', choice.instance.id);
                } else {
                  next.delete('metrics_instance');
                }
                setSearchParams(next);
              }}
              className="rounded-md border border-gray-300 bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-900"
            >
              {endpointChoices.map(({ instance, endpoint }) => (
                <option key={`${instance.id}:${endpoint.id}`} value={`${instance.id}:${endpoint.id}`}>
                  {instanceScope === 'all'
                    ? `${instance.icon ? `${instance.icon} ` : ''}${instance.name} — ${endpoint.name}`
                    : endpoint.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {content}
    </div>
  );
}
