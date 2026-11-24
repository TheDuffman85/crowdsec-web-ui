import { Fragment, useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Card, CardContent } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { ExportCsvButton } from '../../components/ExportCsvButton';
import { ToolMessage, ToolPage } from '../../components/ToolPage';
import { AUDIT_CSV_COLUMNS, CSV_EXPORT_PAGE_SIZE } from '../../lib/csvExport';
import { fetchAuditLog, type AuditEvent, type AuditFilters, type AuditPage } from '../../lib/insightsApi';
import { useI18n } from '../../lib/i18n';
import { useDateTime } from '../../lib/dateTime';

const OUTCOMES = ['success', 'partial', 'failure', 'queued'];
const OUTCOME_VARIANT: Record<string, 'success' | 'warning' | 'danger' | 'info'> = {
  success: 'success', partial: 'warning', failure: 'danger', queued: 'info',
};
const FIELD = 'h-9 rounded-lg border border-gray-300 bg-white px-2 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100';

/** Who banned, unbanned, deleted or changed what, and when. Administrators only. */
export function AuditLog() {
  const { t } = useI18n();
  const { formatDateTime } = useDateTime();
  const [filters, setFilters] = useState<AuditFilters>({});
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AuditPage | null>(null);
  const [facets, setFacets] = useState<{ users: string[]; actions: string[] }>({ users: [], actions: [] });
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());

  const load = useCallback(async () => {
    try {
      const data = await fetchAuditLog(filters, page);
      setResult(data);
      if (data.users && data.actions) setFacets({ users: data.users, actions: data.actions });
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('tools.audit.loadFailed'));
    }
  }, [filters, page, t]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [load]);

  const update = (patch: Partial<AuditFilters>) => { setPage(1); setFilters((current) => ({ ...current, ...patch })); };
  const toggle = (id: number) => setOpen((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const actionLabel = (action: string) => {
    const key = `tools.audit.action.${action}`;
    const label = t(key);
    return label === key ? action : label;
  };
  const pagination = result?.pagination;

  return (
    <ToolPage
      title={t('tools.audit.title')}
      description={t('tools.audit.description')}
      actions={(
        <ExportCsvButton<AuditEvent>
          kind="audit-log"
          columns={AUDIT_CSV_COLUMNS}
          fetchPage={(csvPage) => fetchAuditLog(filters, csvPage, CSV_EXPORT_PAGE_SIZE)}
        />
      )}
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-gray-700 dark:text-gray-300"><span className="mb-1 block">{t('tools.audit.user')}</span>
          <select className={FIELD} value={filters.user ?? ''} onChange={(event) => update({ user: event.target.value })}>
            <option value="">{t('tools.audit.any')}</option>
            {facets.users.map((user) => <option key={user} value={user}>{user}</option>)}
          </select>
        </label>
        <label className="text-sm text-gray-700 dark:text-gray-300"><span className="mb-1 block">{t('tools.audit.actionLabel')}</span>
          <select className={FIELD} value={filters.action ?? ''} onChange={(event) => update({ action: event.target.value })}>
            <option value="">{t('tools.audit.any')}</option>
            {facets.actions.map((action) => <option key={action} value={action}>{actionLabel(action)}</option>)}
          </select>
        </label>
        <label className="text-sm text-gray-700 dark:text-gray-300"><span className="mb-1 block">{t('tools.audit.outcome')}</span>
          <select className={FIELD} value={filters.outcome ?? ''} onChange={(event) => update({ outcome: event.target.value })}>
            <option value="">{t('tools.audit.any')}</option>
            {OUTCOMES.map((outcome) => <option key={outcome} value={outcome}>{t(`tools.audit.outcomes.${outcome}`)}</option>)}
          </select>
        </label>
        <label className="text-sm text-gray-700 dark:text-gray-300"><span className="mb-1 block">{t('tools.audit.from')}</span>
          <input type="date" className={FIELD} value={filters.from ?? ''} onChange={(event) => update({ from: event.target.value })} />
        </label>
        <label className="text-sm text-gray-700 dark:text-gray-300"><span className="mb-1 block">{t('tools.audit.to')}</span>
          <input type="date" className={FIELD} value={filters.to ?? ''} onChange={(event) => update({ to: event.target.value })} />
        </label>
        <label className="min-w-[12rem] flex-1 text-sm text-gray-700 dark:text-gray-300"><span className="mb-1 block">{t('tools.audit.search')}</span>
          <input type="search" className={`${FIELD} w-full`} value={filters.q ?? ''} placeholder={t('tools.audit.searchPlaceholder')} onChange={(event) => update({ q: event.target.value })} />
        </label>
      </div>

      {error && <ToolMessage tone="error">{error}</ToolMessage>}
      {!result && !error && <p className="text-sm text-gray-500">{t('app.loading')}</p>}
      {result?.data.length === 0 && <ToolMessage>{t('tools.audit.empty')}</ToolMessage>}
      {result && result.data.length > 0 && (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-left text-sm" data-testid="audit-table">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                <tr>
                  <th className="w-8 px-2 py-2" />
                  <th className="px-4 py-2">{t('tools.audit.when')}</th>
                  <th className="px-4 py-2">{t('tools.audit.user')}</th>
                  <th className="px-4 py-2">{t('tools.audit.actionLabel')}</th>
                  <th className="px-4 py-2">{t('tools.audit.target')}</th>
                  <th className="px-4 py-2">{t('tools.audit.outcome')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {result.data.map((event) => (
                  <Fragment key={event.id}>
                    <tr>
                      <td className="px-2 py-2">
                        <button type="button" onClick={() => toggle(event.id)} aria-expanded={open.has(event.id)} aria-label={t('tools.audit.details')} className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700">
                          {open.has(event.id) ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
                        </button>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-gray-500">{formatDateTime(event.time)}</td>
                      <td className="px-4 py-2">
                        <span className="font-medium text-gray-900 dark:text-gray-100">{event.user}</span>
                        {event.role && <span className="ml-2 text-xs text-gray-500">{event.role}</span>}
                      </td>
                      <td className="px-4 py-2">{actionLabel(event.action)}</td>
                      <td className="px-4 py-2 font-mono text-xs">{event.target ?? '-'}</td>
                      <td className="px-4 py-2"><Badge variant={OUTCOME_VARIANT[event.outcome] ?? 'secondary'}>{t(`tools.audit.outcomes.${event.outcome}`)}</Badge></td>
                    </tr>
                    {open.has(event.id) && (
                      <tr>
                        <td />
                        <td colSpan={5} className="px-4 pb-3">
                          <pre className="max-h-64 overflow-auto rounded bg-gray-50 p-3 text-xs text-gray-700 dark:bg-gray-900 dark:text-gray-300">{JSON.stringify(event.details, null, 2)}</pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
      {pagination && pagination.total_pages > 1 && (
        <div className="flex items-center justify-between text-sm text-gray-600 dark:text-gray-300">
          <span>{t('tools.audit.pageOf', { page: pagination.page, pages: pagination.total_pages, total: pagination.total })}</span>
          <div className="flex gap-2">
            <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="h-9 rounded-lg border border-gray-300 px-3 disabled:opacity-50 dark:border-gray-700">{t('tools.audit.previous')}</button>
            <button type="button" disabled={page >= pagination.total_pages} onClick={() => setPage(page + 1)} className="h-9 rounded-lg border border-gray-300 px-3 disabled:opacity-50 dark:border-gray-700">{t('tools.audit.next')}</button>
          </div>
        </div>
      )}
    </ToolPage>
  );
}
