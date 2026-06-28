import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Bot,
  CheckCircle2,
  Clock3,
  DatabaseZap,
  FileSearch,
  ListChecks,
  RefreshCw,
  Server,
  ShieldCheck,
  ShieldOff,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { fetchConfig, fetchCrowdsecMetrics } from '../lib/api';
import { useRefresh } from '../contexts/useRefresh';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card';
import { useI18n } from '../lib/i18n';
import type {
  CrowdsecMetricsApiEntity,
  CrowdsecMetricsParserNode,
  CrowdsecMetricsParserSource,
  CrowdsecMetricsResponse,
  CrowdsecMetricsTiming,
  CrowdsecMetricsWhitelist,
} from '../types';

type MetricsState =
  | { status: 'loading' }
  | { status: 'disabled' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: CrowdsecMetricsResponse };

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

function ProgressBar({ value }: { value: number | null }) {
  const percent = value === null ? 0 : Math.max(0, Math.min(100, value * 100));

  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
      <div
        className="h-full rounded-full bg-primary-500 transition-[width]"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function MetricTile({
  title,
  value,
  detail,
  icon: Icon,
}: {
  title: string;
  value: string;
  detail: string;
  icon: LucideIcon;
}) {
  return (
    <Card>
      <CardContent className="flex min-h-32 items-center gap-4 p-4 sm:p-5">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600 dark:bg-primary-900/30 dark:text-primary-300">
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
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <CardHeader>
      <CardTitle className="flex items-center gap-2">
        <Icon className="h-5 w-5 text-primary-600 dark:text-primary-400" />
        {title}
      </CardTitle>
      <p className="mt-2 text-sm leading-6 text-gray-500 dark:text-gray-400">{description}</p>
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
              const decisionTotal = (item.decisionsOk || 0) + (item.decisionsKo || 0);
              const decisionHitRate = decisionTotal > 0 ? (item.decisionsOk || 0) / decisionTotal : null;

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
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-md bg-green-50 px-2 py-1 text-green-700 dark:bg-green-900/20 dark:text-green-300">
                        {t('pages.metrics.labels.nonEmpty', { count: formatNumber(item.decisionsOk || 0) })}
                      </div>
                      <div className="rounded-md bg-gray-50 px-2 py-1 text-gray-600 dark:bg-gray-700/50 dark:text-gray-300">
                        {t('pages.metrics.labels.empty', { count: formatNumber(item.decisionsKo || 0) })}
                      </div>
                      <div className="col-span-2">
                        <ProgressBar value={decisionHitRate} />
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
  const notAvailable = t('pages.metrics.notAvailable');

  return (
    <Card>
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
                  <span className="shrink-0 rounded-md bg-primary-50 px-2 py-1 text-xs font-semibold text-primary-700 dark:bg-primary-900/30 dark:text-primary-300">
                    {formatPercent(item.successRate, notAvailable)}
                  </span>
                </div>
                <div className="mt-4">
                  <ProgressBar value={item.successRate} />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-5">
                  <div>
                    <p className="font-mono text-sm font-semibold text-gray-900 dark:text-white">{formatOptionalNumber(item.linesRead)}</p>
                    <p className="text-gray-500 dark:text-gray-400">{t('pages.metrics.labels.read')}</p>
                  </div>
                  <div>
                    <p className="font-mono text-sm font-semibold text-green-700 dark:text-green-300">{formatNumber(item.parsedOk)}</p>
                    <p className="text-gray-500 dark:text-gray-400">{t('pages.metrics.labels.parsed')}</p>
                  </div>
                  <div>
                    <p className="font-mono text-sm font-semibold text-gray-700 dark:text-gray-200">{formatNumber(item.parsedKo)}</p>
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

function ParserNodeList({ items }: { items: CrowdsecMetricsParserNode[] }) {
  const { t } = useI18n();
  const notAvailable = t('pages.metrics.notAvailable');

  return (
    <Card>
      <SectionHeader
        icon={DatabaseZap}
        title={t('pages.metrics.parserNodes')}
        description={t('pages.metrics.parserNodesDescription')}
      />
      <CardContent>
        {items.length === 0 ? (
          <EmptyState message={t('pages.metrics.emptyParserNodes')} />
        ) : (
          <div className="overflow-hidden rounded-lg border border-gray-100 dark:border-gray-700/70">
            <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1fr)_110px_110px] gap-3 border-b border-gray-100 bg-gray-50 px-4 py-2 text-xs font-semibold uppercase text-gray-500 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-400 lg:grid">
              <span>{t('pages.metrics.columns.node')}</span>
              <span>{t('pages.metrics.columns.stage')}</span>
              <span className="text-right">{t('pages.metrics.columns.processed')}</span>
              <span className="text-right">{t('pages.metrics.columns.success')}</span>
            </div>
            <div className="divide-y divide-gray-100 dark:divide-gray-700/70">
              {items.map((item) => (
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
                    <ProgressBar value={item.successRate} />
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

  return (
    <Card>
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
                  <p className="font-mono text-lg font-bold text-gray-900 dark:text-white">{formatDuration(item.averageSeconds, notAvailable)}</p>
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

export function Metrics() {
  const { t } = useI18n();
  const { refreshSignal, setLastUpdated } = useRefresh();
  const [state, setState] = useState<MetricsState>({ status: 'loading' });

  const load = useCallback(async (background = false) => {
    if (!background) setState({ status: 'loading' });

    try {
      const config = await fetchConfig();
      if (!config.metrics_enabled) {
        setState({ status: 'disabled' });
        return;
      }

      const data = await fetchCrowdsecMetrics();
      setLastUpdated(new Date());
      setState({ status: 'ready', data });
    } catch (error: unknown) {
      setState({ status: 'error', message: getErrorMessage(error, t('pages.metrics.fetchFailed')) });
    }
  }, [setLastUpdated, t]);

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
              CROWDSEC_PROMETHEUS_URL
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
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
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

        <ParserSourceList items={data.parserSources} />
        <TimingList items={data.parserTimings} />
        <ParserNodeList items={data.parserNodes} />
        <WhitelistList items={data.whitelists} />
      </div>
    );
  }, [load, state, t]);

  return content;
}
