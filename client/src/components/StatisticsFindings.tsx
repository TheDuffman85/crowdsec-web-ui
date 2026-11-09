import { useEffect, useId, useState, type ReactNode } from 'react';
import { AlertCircle, ChevronRight, ExternalLink, Filter, Gavel, Info, ListChecks, type LucideIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Badge } from './ui/Badge';
import { ClickableTableRow } from './ui/ClickableTableRow';
import { ResetColumnWidthsButton, ResizableTable } from './ui/ResizableTable';
import { useResizableTable, type ResizableTableColumn } from '../lib/useResizableTable';
import { CountryFlag } from './CountryFlag';
import { RemediationPills } from './RemediationPills';
import { PeriodChangeRow } from './PeriodChange';
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
  severity: 'warning' | 'info';
  text: string;
  help?: { text: string; href?: string };
  action?: { label: string; onSelect: () => void };
  detail?: FindingDetail;
}

interface DetailContext {
  /** Current page filters as a query string, without the detail parameters. */
  query: string;
  archiveKey: string;
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

const LISTED = 5;
const SEVERITY_ORDER = { warning: 0, info: 1 };
const linkClass = 'cursor-pointer font-medium text-primary-600 hover:text-primary-700 hover:underline focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-primary-400 dark:hover:text-primary-300';
const headerCell = 'whitespace-nowrap px-3 py-2 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400';
const cell = 'px-3 py-2 align-top';
const rightHeaderCell = `${headerCell} text-right`;
// Fits the ban button. Once the widths are fixed, the decision badge wraps instead.
const ACTIONS_COLUMN_WIDTH = 112;
const formatNumber = (value: number) => value.toLocaleString();

/** The add-decision row action of the Alerts table. */
export function DecisionIconButton({ label, onClick, className = '' }: { label: string; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`cursor-pointer rounded-full p-2 text-primary-600 transition-colors hover:bg-primary-50 hover:text-primary-900 focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-primary-400 dark:hover:bg-primary-900/20 dark:hover:text-primary-300 ${className}`}
    >
      <Gavel size={16} aria-hidden="true" />
    </button>
  );
}

/** Finding toolbar actions share dimensions, icon placement and focus treatment. */
function FindingActionButton({ icon: Icon, primary = false, onClick, children }: { icon: LucideIcon; primary?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary-500 ${primary
        ? 'border-transparent bg-primary-600 text-white hover:bg-primary-700'
        : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600'}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {children}
    </button>
  );
}

/** Replaces the ban button once a decision was added. Wraps when the column widths are fixed, since the Actions column is sized for the button. */
export function DecisionAddedBadge() {
  const { t } = useI18n();
  return <Badge variant="success" className="[table[data-column-widths=fixed]_&]:whitespace-normal">{t('pages.statistics.decisionAdded')}</Badge>;
}

function BanButton({ value, draft, range = false, context }: { value: string; draft: DecisionDraft; range?: boolean; context: DetailContext }) {
  const { t } = useI18n();
  if (context.decided.has(value)) return <DecisionAddedBadge />;
  return <DecisionIconButton label={t(range ? 'pages.statistics.blockRange' : 'pages.statistics.ban')} onClick={() => context.onBan(value, draft, range)} className="-my-2" />;
}

/** Bans every listed value without a decision from this page; shown above its table. */
function BanAllButton({ values, draft, range = false, context }: { values: string[]; draft: DecisionDraft; range?: boolean; context: DetailContext }) {
  const { t } = useI18n();
  const pending = values.filter((value) => !context.decided.has(value)).slice(0, BULK_ADD_DECISIONS_MAX);
  if (pending.length < 2) return null;
  return (
    <FindingActionButton icon={Gavel} primary onClick={() => context.onBanAll(pending, draft, range)}>
      {t(range ? 'pages.statistics.blockAllRanges' : 'pages.statistics.banAll', { count: pending.length })}
    </FindingActionButton>
  );
}

/** The Actions column, like on the Alerts and Decisions pages. */
function actionsColumn(label: string): ResizableTableColumn {
  return { id: 'actions', label, className: `${headerCell} text-right ${STICKY_ACTIONS_HEADER_CLASS_NAME}`, fixedWidth: ACTIONS_COLUMN_WIDTH };
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

/** Column widths are shared by the tables of one kind across findings, by `widthsKey`. */
function Table({ title, actions, bulk, widthsKey, columns, children, footer }: { title?: string; actions?: ReactNode; bulk?: ReactNode; widthsKey: `statistics-${string}`; columns: ResizableTableColumn[]; children: ReactNode; footer?: ReactNode }) {
  const table = useResizableTable(widthsKey, columns);
  const reset = <ResetColumnWidthsButton table={table} />;
  return (
    <div className="space-y-2">
      {(title || actions || bulk || table.columnWidths.hasCustomWidths) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {title ? <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{title}</p> : <span />}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{reset}{actions}{bulk}</div>
        </div>
      )}
      <div className="overflow-clip rounded-md border border-gray-100 dark:border-gray-700/60">
        <ResizableTable table={table} bodyClassName="divide-y divide-gray-100 dark:divide-gray-700/60">{children}</ResizableTable>
      </div>
      {footer}
    </div>
  );
}

function IPTable({ title, actions, rows, draft, returned = false, context, footer }: { title?: string; actions?: ReactNode; rows: StatisticsDetailIP[]; draft: DecisionDraft; returned?: boolean; context: DetailContext; footer?: ReactNode }) {
  const { t, language } = useI18n();
  const selectedIP = new URLSearchParams(context.query).get('ip');
  return (
    <Table title={title} actions={actions} footer={footer} bulk={context.canBan && <BanAllButton values={rows.map((row) => row.ip)} draft={draft} context={context} />} widthsKey="statistics-finding-ips" columns={[
      { id: 'ip', label: t('pages.dashboard.ip'), className: headerCell },
      { id: 'alerts', label: t('pages.statistics.alerts'), className: rightHeaderCell },
      { id: 'remediations', label: t('pages.statistics.remediations'), className: rightHeaderCell },
      { id: 'machines', label: t('pages.dashboard.machines'), className: rightHeaderCell },
      { id: 'activity', label: t(returned ? 'pages.statistics.firstRemediation' : 'pages.statistics.lastSeen'), className: headerCell },
      ...(context.canBan ? [actionsColumn(t('tableColumns.actions'))] : []),
    ]}>
      {rows.map((row) => {
        const country = row.country && row.country !== 'Unknown' ? getCountryName(row.country, language) ?? row.country : '';
        const asn = row.asn && row.asn !== '0' ? (/^AS/i.test(row.asn) ? row.asn : `AS${row.asn}`) : '';
        return (
          <ClickableTableRow key={row.ip} aria-label={row.ip} selected={selectedIP === row.ip} onSelect={() => context.onFilter({ ip: row.ip })}>
            <td className={`${cell} min-w-56`}>
              <span className="break-all font-medium text-gray-900 dark:text-gray-100">{row.ip}</span>
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                {country && <CountryFlag code={row.country} />}
                <span className="truncate">{[country, asn, row.network].filter(Boolean).join(' · ')}</span>
              </div>
            </td>
            <td className={`${cell} text-right font-semibold tabular-nums text-gray-900 dark:text-gray-100`}>{formatNumber(row.alerts)}</td>
            <td className={`${cell} text-right`}><RemediationPills types={row.remediationTypes} /></td>
            <td className={`${cell} text-right tabular-nums text-gray-700 dark:text-gray-300`}>{formatNumber(row.machines)}</td>
            <td className={`${cell} whitespace-nowrap text-xs text-gray-600 dark:text-gray-300`}>
              {returned ? (row.remediatedBefore ? t('pages.statistics.remediatedBeforeRange') : row.firstRemediation ? context.formatDay(row.firstRemediation) : '—') : context.formatTimestamp(row.lastActivity)}
            </td>
            {context.canBan && <ActionsCell><BanButton value={row.ip} draft={draft} context={context} /></ActionsCell>}
          </ClickableTableRow>
        );
      })}
    </Table>
  );
}

function DetailBody({ detail, context, actions }: { detail: FindingDetail; context: DetailContext; actions?: ReactNode }) {
  const { t } = useI18n();
  const { archiveKey } = context;
  const [result, setResult] = useState<{ data: StatisticsDetails | null; archiveKey: string; url: string } | null>(null);
  const state = result?.archiveKey === archiveKey ? result : null;
  const [size, setSize] = useState(STATISTICS_DETAIL_PAGE);
  const [attempt, setAttempt] = useState(0);
  const periodChange = usePeriodChange();
  const actionBar = actions && <div className="flex justify-end">{actions}</div>;
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
      if (!abort.signal.aborted) setResult({ data, archiveKey, url });
    }).catch(() => { if (!abort.signal.aborted) setResult({ data: null, archiveKey, url }); });
    return () => abort.abort();
  }, [url, attempt, archiveKey]);

  if (detail.kind === 'scanners') {
    return (
      <Table actions={actions} bulk={context.canBan && <BanAllButton values={detail.rows.map((row) => row.value)} draft={detail.decision} context={context} />} widthsKey="statistics-finding-scanners" columns={[
        { id: 'ip', label: t('pages.dashboard.ip'), className: headerCell },
        { id: 'alerts', label: t('pages.statistics.alerts'), className: rightHeaderCell },
        { id: 'targetedMachines', label: t('pages.statistics.targetedMachines'), className: headerCell },
        ...(context.canBan ? [actionsColumn(t('tableColumns.actions'))] : []),
      ]}>
        {detail.rows.map((row) => (
          <ClickableTableRow key={row.value} aria-label={row.label} selected={parameters.get('ip') === row.value} onSelect={() => context.onFilter({ ip: row.value })}>
            <td className={`${cell} break-all font-medium text-gray-900 dark:text-gray-100`}>{row.label}</td>
            <td className={`${cell} text-right font-semibold tabular-nums text-gray-900 dark:text-gray-100`}>{formatNumber(row.alerts)}</td>
            <td className={`${cell} text-xs text-gray-600 dark:text-gray-300`}>
              {t('pages.statistics.machineCount', { count: formatNumber(row.machines) })}: {row.targetedMachines.map((machine) => machine.label).join(', ')}
            </td>
            {context.canBan && <ActionsCell><BanButton value={row.value} draft={detail.decision} context={context} /></ActionsCell>}
          </ClickableTableRow>
        ))}
      </Table>
    );
  }
  if (state && !state.data) {
    return (
      <>{actionBar}<p className="text-sm text-amber-700 dark:text-amber-300">
        {t('pages.statistics.detailsError')}{' '}
        <button type="button" className={linkClass} onClick={() => { setResult(null); setAttempt((value) => value + 1); }}>{t('pages.statistics.retry')}</button>
      </p></>
    );
  }
  if (!state?.data || state.data.kind !== detail.kind) return <>{actionBar}<p role="status" className="text-sm text-gray-500 dark:text-gray-400">{t('app.loading')}</p></>;
  const { data } = state;

  if (data.kind === 'machines') {
    return (
      <>{actionBar}<div className="grid gap-3 lg:grid-cols-2">
        {data.machines.map((machine) => (
          <div key={machine.value} className="rounded-md border border-gray-100 p-3 text-sm dark:border-gray-700/60">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium text-gray-900 dark:text-gray-100">{context.machineName(machine.value)}</span>
              <span className="text-xs text-gray-500 dark:text-gray-400">{t('pages.statistics.lastAlert')}: {machine.lastActivity ? context.formatTimestamp(machine.lastActivity) : t('pages.statistics.noneRetained')}</span>
            </div>
            {machine.scenarios.length > 0 && (
              <ul className="mt-3 space-y-2">
                {machine.scenarios.map((scenario) => (
                  <li key={scenario.label}
                    title={t('pages.statistics.machineChangeLabel', { machine: scenario.label, previous: formatNumber(scenario.previous), current: formatNumber(scenario.current) })}>
                    <PeriodChangeRow
                      previous={scenario.previous}
                      current={scenario.current}
                      change={periodChange(scenario.previous, scenario.current)}
                      changeClassName={scenario.current > scenario.previous ? 'text-red-600 dark:text-red-400'
                        : scenario.current < scenario.previous ? 'text-amber-600 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400'}
                      label={<span className="truncate text-gray-700 dark:text-gray-300">{scenario.label}</span>}
                    />
                  </li>
                ))}
              </ul>
            )}
            {machine.ips.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1">
                {machine.ips.map((row) => (
                  <button key={row.ip} type="button" onClick={() => context.onFilter({ ip: row.ip })}
                    aria-pressed={parameters.get('ip') === row.ip}
                    className={`inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-xs focus-visible:outline-2 focus-visible:outline-primary-500 ${parameters.get('ip') === row.ip
                      ? 'bg-primary-50 text-primary-800 dark:bg-primary-900/40 dark:text-primary-100'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700/60 dark:text-gray-200 dark:hover:bg-gray-700'}`}>
                    {row.ip}<span className="tabular-nums text-gray-500 dark:text-gray-400">{formatNumber(row.alerts)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div></>
    );
  }
  if (detail.kind === 'machines') return null;
  if (!data.ips.length && !(data.kind === 'ips' && data.ranges.length)) return <>{actionBar}<p className="text-sm text-gray-500 dark:text-gray-400">{t('common.noDataAvailable')}</p></>;
  const more = (shown: number, total: number) => (
    <ShowMore shown={shown} total={total} loading={state.url !== url} onMore={() => setSize((value) => Math.min(value + STATISTICS_DETAIL_PAGE, STATISTICS_DETAIL_MAX))} />
  );
  return (
    <div className="space-y-3">
      {data.kind === 'ips' && data.ranges.length > 0 && (
        <>
          <Table title={t('pages.statistics.addressRanges')} actions={actions} footer={more(data.ranges.length, data.rangeTotal)} bulk={context.canBan && <BanAllButton values={data.ranges.map((range) => range.range)} draft={detail.decision} range context={context} />} widthsKey="statistics-finding-ranges" columns={[
            { id: 'range', label: t('pages.statistics.addressRange'), className: headerCell },
            { id: 'uniqueIPs', label: t('pages.statistics.uniqueIPs'), className: rightHeaderCell },
            { id: 'alerts', label: t('pages.statistics.alerts'), className: rightHeaderCell },
            ...(context.canBan ? [actionsColumn(t('tableColumns.actions'))] : []),
          ]}>
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
        actions={data.kind === 'ips' && data.ranges.length > 0 ? undefined : actions}
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
      <button
        type="button"
        aria-expanded={finding.detail ? open : undefined}
        aria-controls={finding.detail ? detailId : undefined}
        onClick={() => finding.detail ? setOpen((value) => !value) : finding.action?.onSelect()}
        className="flex w-full cursor-pointer items-start gap-3 rounded-lg p-3 text-left transition-colors hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-primary-500 dark:hover:bg-gray-700/50"
      >
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${finding.severity === 'warning' ? 'text-amber-600 dark:text-amber-400' : 'text-blue-600 dark:text-blue-400'}`} aria-hidden="true" />
        <span className="min-w-0 flex-1 break-words text-gray-800 dark:text-gray-200">{finding.text}</span>
        {finding.detail && <ChevronRight className={`mt-0.5 h-4 w-4 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />}
      </button>
      {open && finding.detail && (
        <div id={detailId} className="space-y-3 border-t border-gray-100 px-3 pb-3 pt-3 sm:pl-10 dark:border-gray-700/60">
          {finding.help && (
            <p className="text-xs text-gray-600 dark:text-gray-300">
              {finding.help.text}
              {finding.help.href && <>{' '}<a href={finding.help.href} target="_blank" rel="noopener noreferrer" className={`${linkClass} inline-flex items-center gap-0.5`}>{t('common.learnMore')}<ExternalLink className="h-3 w-3" aria-hidden="true" /></a></>}
            </p>
          )}
          <DetailBody detail={finding.detail} context={context} actions={finding.action && (
            <FindingActionButton icon={Filter} onClick={finding.action.onSelect}>{finding.action.label}</FindingActionButton>
          )} />
        </div>
      )}
    </li>
  );
}

export function StatisticsFindings({ findings, context }: { findings: Finding[]; context: DetailContext }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const ordered = [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const shown = expanded ? ordered : ordered.slice(0, LISTED);
  const extraCount = findings.length - LISTED;
  return (
    // Clipping without overflow-hidden lets the scrollbars of the detail tables stick to the page.
    <Card className="overflow-clip">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ListChecks className="h-5 w-5 shrink-0 text-primary-600 dark:text-primary-400" aria-hidden="true" />
          {t('pages.statistics.findings')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {shown.length === 0 ? <p className="py-4 text-center text-sm text-gray-500 dark:text-gray-400">{t('pages.statistics.noFindings')}</p> : (
          <ul id={listId} className="space-y-2">
            {shown.map((finding) => <FindingItem key={finding.key} finding={finding} context={context} />)}
          </ul>
        )}
        {extraCount > 0 && (
          <button type="button" aria-expanded={expanded} aria-controls={listId}
            className={`${linkClass} mt-2 px-3 text-xs`} onClick={() => setExpanded((value) => !value)}>
            {expanded ? t('pages.statistics.showFewer') : t('pages.statistics.showMore', { count: extraCount })}
          </button>
        )}
      </CardContent>
    </Card>
  );
}
