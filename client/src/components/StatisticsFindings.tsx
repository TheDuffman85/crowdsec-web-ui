import { useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, ArrowUpRight, ChevronRight, ExternalLink, Gavel, Info, ListChecks } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Badge } from './ui/Badge';
import { CountryFlag } from './CountryFlag';
import { PeriodChangeBar, PeriodLegend } from './PeriodChange';
import { usePeriodChange } from '../lib/periodChange';
import { sessionFetch } from '../lib/sessionFetch';
import { apiUrl } from '../lib/basePath';
import { useI18n } from '../lib/i18n';
import { getCountryName } from '../lib/utils';
import { BULK_ADD_DECISIONS_MAX } from '../../../shared/contracts';
import { STICKY_ACTIONS_CELL_CLASS_NAME, STICKY_ACTIONS_HEADER_CLASS_NAME } from '../lib/tableColumns';
import { STATISTICS_DETAIL_MAX, STATISTICS_DETAIL_PAGE, type StatisticsDetailIP, type StatisticsDetails, type StatisticsRanking } from '../../../shared/statistics';

/** What an expanded finding shows. Server-backed kinds load only when opened. */
export type FindingDetail =
  | { kind: 'ips'; scenario?: string; network?: string; decision: DecisionDraft }
  | { kind: 'returned'; history: boolean; decision: DecisionDraft }
  | { kind: 'machines'; machines: string[] }
  | { kind: 'scanners'; rows: StatisticsRanking[]; decision: DecisionDraft };

/** Prefilled values for the add-decision dialog; `value` is filled in per row. */
export interface DecisionDraft { reason: string; duration: string; rangeDuration?: string }

export interface Finding {
  key: string;
  /** Findings of one group beyond the first few stay hidden until requested. */
  group: string;
  severity: 'warning' | 'info';
  text: string;
  help?: { text: string; href?: string };
  action?: { label: string; onSelect: () => void };
  detail?: FindingDetail;
}

interface DetailContext {
  /** Current page filters as a query string, without the detail parameters. */
  query: string;
  canBan: boolean;
  /** Values that received a decision on this page. */
  decided: Set<string>;
  onBan: (value: string, draft: DecisionDraft, range: boolean) => void;
  /** Opens one decision dialog for several values. */
  onBanAll: (values: string[], draft: DecisionDraft, range: boolean) => void;
  onFilter: (values: Record<string, string | null>) => void;
  formatTimestamp: (value: string | null | undefined) => string;
  formatDay: (day: string) => string;
  machineName: (value: string) => string;
}

const LISTED = 3;
const linkClass = 'font-medium text-primary-600 hover:text-primary-700 hover:underline dark:text-primary-400 dark:hover:text-primary-300';
const headerCell = 'whitespace-nowrap px-3 py-2 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400';
const cell = 'px-3 py-2 align-top';
const formatNumber = (value: number) => value.toLocaleString();

/** The add-decision row action of the Alerts table. */
export function DecisionIconButton({ label, onClick, className = '' }: { label: string; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`rounded-full p-2 text-primary-600 transition-colors hover:bg-primary-50 hover:text-primary-900 dark:text-primary-400 dark:hover:bg-primary-900/20 dark:hover:text-primary-300 ${className}`}
    >
      <Gavel size={16} aria-hidden="true" />
    </button>
  );
}

function BanButton({ value, draft, range = false, context }: { value: string; draft: DecisionDraft; range?: boolean; context: DetailContext }) {
  const { t } = useI18n();
  if (context.decided.has(value)) return <Badge variant="success">{t('pages.statistics.decisionAdded')}</Badge>;
  return <DecisionIconButton label={t(range ? 'pages.statistics.blockRange' : 'pages.statistics.ban')} onClick={() => context.onBan(value, draft, range)} className="-my-2" />;
}

/** Bans every listed value without a decision from this page; shown above its table. */
function BanAllButton({ values, draft, range = false, context }: { values: string[]; draft: DecisionDraft; range?: boolean; context: DetailContext }) {
  const { t } = useI18n();
  const pending = values.filter((value) => !context.decided.has(value)).slice(0, BULK_ADD_DECISIONS_MAX);
  if (pending.length < 2) return null;
  return (
    <button
      type="button"
      onClick={() => context.onBanAll(pending, draft, range)}
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-primary-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-primary-700"
    >
      <Gavel size={14} aria-hidden="true" />
      {t(range ? 'pages.statistics.blockAllRanges' : 'pages.statistics.banAll', { count: pending.length })}
    </button>
  );
}

/** The Actions column, like on the Alerts and Decisions pages. */
function ActionsHeader() {
  const { t } = useI18n();
  return <th className={`${headerCell} text-right ${STICKY_ACTIONS_HEADER_CLASS_NAME}`}>{t('tableColumns.actions')}</th>;
}

function ActionsCell({ children }: { children: ReactNode }) {
  return <td className={`${cell} whitespace-nowrap text-right ${STICKY_ACTIONS_CELL_CLASS_NAME}`}>{children}</td>;
}

/** Lists are shown in pages; the total counts every match. */
function ShowMore({ shown, total, loading, onMore }: { shown: number; total: number; loading: boolean; onMore: () => void }) {
  const { t } = useI18n();
  if (total <= shown) return null;
  const next = Math.min(STATISTICS_DETAIL_PAGE, total - shown, STATISTICS_DETAIL_MAX - shown);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500 dark:text-gray-400">
      <span>{t('pages.statistics.shownOf', { shown: formatNumber(shown), total: formatNumber(total) })}</span>
      {next > 0 && (
        <button type="button" className={linkClass} disabled={loading} onClick={onMore}>
          {loading ? t('app.loading') : t('pages.statistics.showMore', { count: formatNumber(next) })}
        </button>
      )}
    </div>
  );
}

function Table({ title, bulk, head, children, footer }: { title?: string; bulk?: ReactNode; head: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="space-y-2">
      {(title || bulk) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {title ? <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{title}</p> : <span />}
          {bulk}
        </div>
      )}
      <div className="overflow-x-auto rounded-md border border-gray-100 dark:border-gray-700/60">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 dark:bg-gray-900/50"><tr>{head}</tr></thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700/60">{children}</tbody>
        </table>
      </div>
      {footer}
    </div>
  );
}

function IPTable({ title, rows, draft, returned = false, context, footer }: { title?: string; rows: StatisticsDetailIP[]; draft: DecisionDraft; returned?: boolean; context: DetailContext; footer?: ReactNode }) {
  const { t, language } = useI18n();
  const right = `${headerCell} text-right`;
  return (
    <Table title={title} footer={footer} bulk={context.canBan && <BanAllButton values={rows.map((row) => row.ip)} draft={draft} context={context} />} head={<>
      <th className={headerCell}>{t('pages.dashboard.ip')}</th>
      <th className={right}>{t('pages.statistics.alerts')}</th>
      <th className={right}>{t('pages.statistics.bans')}</th>
      <th className={right}>{t('pages.dashboard.machines')}</th>
      <th className={headerCell}>{t(returned ? 'pages.statistics.firstBan' : 'pages.statistics.lastSeen')}</th>
      {context.canBan && <ActionsHeader />}
    </>}>
      {rows.map((row) => {
        const country = row.country && row.country !== 'Unknown' ? getCountryName(row.country, language) ?? row.country : '';
        const asn = row.asn && row.asn !== '0' ? (/^AS/i.test(row.asn) ? row.asn : `AS${row.asn}`) : '';
        return (
          <tr key={row.ip}>
            <td className={`${cell} min-w-56`}>
              <button type="button" className={`${linkClass} break-all text-left`} onClick={() => context.onFilter({ ip: row.ip })}>{row.ip}</button>
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                {country && <CountryFlag code={row.country} />}
                <span className="truncate">{[country, asn, row.network].filter(Boolean).join(' · ')}</span>
              </div>
            </td>
            <td className={`${cell} text-right font-semibold tabular-nums text-gray-900 dark:text-gray-100`}>{formatNumber(row.alerts)}</td>
            <td className={`${cell} text-right tabular-nums text-gray-700 dark:text-gray-300`}>{formatNumber(row.bans)}</td>
            <td className={`${cell} text-right tabular-nums text-gray-700 dark:text-gray-300`}>{formatNumber(row.machines)}</td>
            <td className={`${cell} whitespace-nowrap text-xs text-gray-600 dark:text-gray-300`}>
              {returned ? (row.bannedBefore ? t('pages.statistics.bannedBeforeRange') : row.firstBan ? context.formatDay(row.firstBan) : '—') : context.formatTimestamp(row.lastActivity)}
            </td>
            {context.canBan && <ActionsCell><BanButton value={row.ip} draft={draft} context={context} /></ActionsCell>}
          </tr>
        );
      })}
    </Table>
  );
}

function DetailBody({ detail, context }: { detail: FindingDetail; context: DetailContext }) {
  const { t } = useI18n();
  const [state, setState] = useState<{ data: StatisticsDetails | null; error: boolean; url?: string }>({ data: null, error: false });
  const [size, setSize] = useState(STATISTICS_DETAIL_PAGE);
  const [attempt, setAttempt] = useState(0);
  const periodChange = usePeriodChange();
  const parameters = new URLSearchParams(context.query);
  if (detail.kind === 'ips') {
    parameters.set('kind', 'ips');
    if (detail.scenario) parameters.set('scenario', detail.scenario);
    if (detail.network) parameters.set('network', detail.network);
  } else if (detail.kind === 'returned') {
    parameters.set('kind', 'returned');
    if (detail.history) parameters.set('history', '1');
  } else if (detail.kind === 'machines') {
    parameters.set('kind', 'machines');
    parameters.set('machines', JSON.stringify(detail.machines));
  }
  if (detail.kind === 'ips' || detail.kind === 'returned') parameters.set('size', String(size));
  const url = detail.kind === 'scanners' ? null : `${apiUrl('/api/statistics/details')}?${parameters}`;
  useEffect(() => {
    if (!url) return;
    const abort = new AbortController();
    void sessionFetch(url, { signal: abort.signal }).then(async (response) => {
      if (!response.ok) throw new Error('details');
      const data = await response.json() as StatisticsDetails;
      // The previous rows stay visible until more have loaded.
      if (!abort.signal.aborted) setState({ data, error: false, url });
    }).catch(() => { if (!abort.signal.aborted) setState({ data: null, error: true }); });
    return () => abort.abort();
  }, [url, attempt]);

  if (detail.kind === 'scanners') {
    return (
      <Table bulk={context.canBan && <BanAllButton values={detail.rows.map((row) => row.value)} draft={detail.decision} context={context} />} head={<>
        <th className={headerCell}>{t('pages.dashboard.ip')}</th>
        <th className={`${headerCell} text-right`}>{t('pages.statistics.alerts')}</th>
        <th className={headerCell}>{t('pages.statistics.targetedMachines')}</th>
        {context.canBan && <ActionsHeader />}
      </>}>
        {detail.rows.map((row) => (
          <tr key={row.value}>
            <td className={cell}><button type="button" className={`${linkClass} break-all text-left`} onClick={() => context.onFilter({ ip: row.value })}>{row.label}</button></td>
            <td className={`${cell} text-right font-semibold tabular-nums text-gray-900 dark:text-gray-100`}>{formatNumber(row.alerts)}</td>
            <td className={`${cell} text-xs text-gray-600 dark:text-gray-300`}>
              {t('pages.statistics.machineCount', { count: formatNumber(row.machines) })}: {row.targetedMachines.map((machine) => machine.label).join(', ')}
            </td>
            {context.canBan && <ActionsCell><BanButton value={row.value} draft={detail.decision} context={context} /></ActionsCell>}
          </tr>
        ))}
      </Table>
    );
  }
  if (state.error) {
    return (
      <p className="text-sm text-amber-700 dark:text-amber-300">
        {t('pages.statistics.detailsError')}{' '}
        <button type="button" className={linkClass} onClick={() => { setState({ data: null, error: false }); setAttempt((value) => value + 1); }}>{t('pages.statistics.retry')}</button>
      </p>
    );
  }
  const data = state.data;
  if (!data || data.kind !== detail.kind) return <p role="status" className="text-sm text-gray-500 dark:text-gray-400">{t('app.loading')}</p>;

  if (data.kind === 'machines') {
    return (
      <div className="space-y-2">
      <PeriodLegend />
      <div className="grid gap-3 lg:grid-cols-2">
        {data.machines.map((machine) => {
          // Scenarios of one machine share a scale.
          const scale = Math.max(...machine.scenarios.map((scenario) => Math.max(scenario.previous, scenario.current)), 1);
          return (
          <div key={machine.value} className="rounded-md border border-gray-100 p-3 text-sm dark:border-gray-700/60">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium text-gray-900 dark:text-gray-100">{context.machineName(machine.value)}</span>
              <span className="text-xs text-gray-500 dark:text-gray-400">{t('pages.statistics.lastAlert')}: {machine.lastActivity ? `${context.formatTimestamp(machine.lastActivity)} UTC` : t('pages.statistics.noneRetained')}</span>
            </div>
            {machine.scenarios.length > 0 && (
              <ul className="mt-3 space-y-2.5">
                {machine.scenarios.map((scenario) => (
                  <li key={scenario.label} className="text-xs"
                    title={t('pages.statistics.machineChangeLabel', { machine: scenario.label, previous: formatNumber(scenario.previous), current: formatNumber(scenario.current) })}>
                    <span className="mb-1 flex items-center justify-between gap-2">
                      <span className="truncate text-gray-700 dark:text-gray-300">{scenario.label}</span>
                      <span className={`shrink-0 font-semibold tabular-nums ${scenario.current > scenario.previous ? 'text-red-600 dark:text-red-400'
                        : scenario.current < scenario.previous ? 'text-amber-600 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400'}`}>
                        {periodChange(scenario.previous, scenario.current)}
                      </span>
                    </span>
                    <PeriodChangeBar previous={scenario.previous} current={scenario.current} scale={scale} />
                  </li>
                ))}
              </ul>
            )}
            {machine.ips.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {machine.ips.map((row) => (
                  <button key={row.ip} type="button" onClick={() => context.onFilter({ ip: row.ip })}
                    className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-200 dark:bg-gray-700/60 dark:text-gray-200 dark:hover:bg-gray-700">
                    {row.ip}<span className="tabular-nums text-gray-500 dark:text-gray-400">{formatNumber(row.alerts)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          );
        })}
      </div>
      </div>
    );
  }
  if (detail.kind === 'machines') return null;
  if (!data.ips.length && !(data.kind === 'ips' && data.ranges.length)) return <p className="text-sm text-gray-500 dark:text-gray-400">{t('common.noDataAvailable')}</p>;
  const more = (shown: number, total: number) => (
    <ShowMore shown={shown} total={total} loading={state.url !== url} onMore={() => setSize((value) => Math.min(value + STATISTICS_DETAIL_PAGE, STATISTICS_DETAIL_MAX))} />
  );
  return (
    <div className="space-y-3">
      {data.kind === 'ips' && data.ranges.length > 0 && (
        <>
          <Table title={t('pages.statistics.addressRanges')} footer={more(data.ranges.length, data.rangeTotal)} bulk={context.canBan && <BanAllButton values={data.ranges.map((range) => range.range)} draft={detail.decision} range context={context} />} head={<>
            <th className={headerCell}>{t('pages.statistics.addressRange')}</th>
            <th className={`${headerCell} text-right`}>{t('pages.statistics.uniqueIPs')}</th>
            <th className={`${headerCell} text-right`}>{t('pages.statistics.alerts')}</th>
            {context.canBan && <ActionsHeader />}
          </>}>
            {data.ranges.map((range) => (
              <tr key={range.range}>
                <td className={`${cell} font-mono text-xs text-gray-900 dark:text-gray-100`}>{range.range}</td>
                <td className={`${cell} text-right tabular-nums text-gray-700 dark:text-gray-300`}>{formatNumber(range.ips)}</td>
                <td className={`${cell} text-right tabular-nums text-gray-700 dark:text-gray-300`}>{formatNumber(range.alerts)}</td>
                {context.canBan && <ActionsCell><BanButton value={range.range} draft={detail.decision} range context={context} /></ActionsCell>}
              </tr>
            ))}
          </Table>
        </>
      )}
      {data.ips.length > 0 && <IPTable title={data.kind === 'ips' && data.ranges.length > 0 ? t('pages.statistics.topAddresses') : undefined}
        rows={data.ips} draft={detail.decision} returned={data.kind === 'returned'} context={context} footer={more(data.ips.length, data.total)} />}
    </div>
  );
}

function FindingItem({ finding, context }: { finding: Finding; context: DetailContext }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const Icon = finding.severity === 'warning' ? AlertCircle : Info;
  const detailId = `finding-${finding.key.replace(/[^\w-]/g, '_')}`;
  return (
    <li className="rounded-lg border border-gray-100 text-sm dark:border-gray-700/60">
      <div className="flex items-start gap-3 p-3">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${finding.severity === 'warning' ? 'text-amber-600 dark:text-amber-400' : 'text-blue-600 dark:text-blue-400'}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="break-words text-gray-800 dark:text-gray-200">{finding.text}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            {finding.detail && (
              <button type="button" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((value) => !value)} className={`${linkClass} inline-flex items-center gap-1`}>
                <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
                {t(open ? 'pages.statistics.hideDetails' : 'pages.statistics.showDetails')}
              </button>
            )}
            {finding.action && (
              <button type="button" className={`${linkClass} inline-flex items-center gap-1`} onClick={finding.action.onSelect}>
                {finding.action.label}<ArrowUpRight className="h-3 w-3" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>
      {open && finding.detail && (
        <div id={detailId} className="space-y-3 border-t border-gray-100 px-3 pb-3 pt-3 sm:pl-10 dark:border-gray-700/60">
          {finding.help && (
            <p className="text-xs text-gray-600 dark:text-gray-300">
              {finding.help.text}
              {finding.help.href && <>{' '}<a href={finding.help.href} target="_blank" rel="noopener noreferrer" className={`${linkClass} inline-flex items-center gap-0.5`}>{t('common.learnMore')}<ExternalLink className="h-3 w-3" aria-hidden="true" /></a></>}
            </p>
          )}
          <DetailBody detail={finding.detail} context={context} />
        </div>
      )}
    </li>
  );
}

export function StatisticsFindings({ findings, context }: { findings: Finding[]; context: DetailContext }) {
  const { t } = useI18n();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const groups: string[] = [];
  const byGroup = new Map<string, Finding[]>();
  for (const finding of findings) {
    if (!byGroup.has(finding.group)) { groups.push(finding.group); byGroup.set(finding.group, []); }
    byGroup.get(finding.group)!.push(finding);
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ListChecks className="h-5 w-5 shrink-0 text-primary-600 dark:text-primary-400" aria-hidden="true" />
          {t('pages.statistics.findings')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {findings.length === 0 ? <p className="py-4 text-center text-sm text-gray-500 dark:text-gray-400">{t('pages.statistics.noFindings')}</p> : (
          <ul className="space-y-2">
            {groups.flatMap((group) => {
              const items = byGroup.get(group)!;
              const expanded = expandedGroups.has(group);
              const shown = expanded ? items : items.slice(0, LISTED);
              const rows = shown.map((finding) => <FindingItem key={finding.key} finding={finding} context={context} />);
              if (items.length > LISTED) {
                rows.push(
                  <li key={`${group}-toggle`}>
                    <button type="button" className={`${linkClass} px-3 text-xs`} onClick={() => setExpandedGroups((current) => {
                      const next = new Set(current);
                      if (next.has(group)) next.delete(group); else next.add(group);
                      return next;
                    })}>
                      {expanded ? t('pages.statistics.showFewer') : t('pages.statistics.showMore', { count: items.length - LISTED })}
                    </button>
                  </li>,
                );
              }
              return rows;
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
