import { useEffect, useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card';
import { ToolMessage, ToolPage } from '../../components/ToolPage';
import { downloadReportPdf, fetchReport, type ReportSelection, type ReportSummary } from '../../lib/insightsApi';
import { recentMonths } from '../../lib/reportPeriods';
import { useI18n } from '../../lib/i18n';
import { useOptionalToast } from '../../contexts/useToast';

const DAY_CHOICES = [7, 30, 90];

function selectionFromValue(value: string): ReportSelection {
  return value.startsWith('m:') ? { month: value.slice(2) } : { days: Number(value.slice(2)) };
}

/** Summary of a period with a PDF download. A monthly copy can also be written to disk by the server (REPORT_MONTHLY_ENABLED). */
export function Report() {
  const { t } = useI18n();
  const toast = useOptionalToast();
  const months = useMemo(() => recentMonths(), []);
  const [value, setValue] = useState('d:30');
  const [report, setReport] = useState<ReportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const timeoutId = window.setTimeout(() => {
      setReport(null);
      fetchReport(selectionFromValue(value))
        .then((data) => { if (active) { setReport(data); setError(null); } })
        .catch((loadError: unknown) => { if (active) setError(loadError instanceof Error ? loadError.message : t('tools.report.loadFailed')); });
    }, 0);
    return () => { active = false; window.clearTimeout(timeoutId); };
  }, [t, value]);

  const download = async () => {
    setBusy(true);
    try {
      await downloadReportPdf(selectionFromValue(value));
    } catch (downloadError) {
      toast?.addToast(downloadError instanceof Error ? downloadError.message : t('tools.report.downloadFailed'), 'danger');
    } finally {
      setBusy(false);
    }
  };

  const figures: Array<[string, number]> = report ? [
    [t('tools.report.alerts'), report.total_alerts],
    [t('tools.report.sources'), report.unique_sources],
    [t('tools.report.decisions'), report.decisions_created],
    [t('tools.report.active'), report.active_decisions],
    [t('tools.report.offenders'), report.repeat_offenders],
  ] : [];
  const lists: Array<[string, Array<{ name: string; count: number }>]> = report ? [
    [t('tools.report.topScenarios'), report.top_scenarios],
    [t('tools.report.topCountries'), report.top_countries],
    [t('tools.report.topSources'), report.top_sources],
    [t('tools.report.topMachines'), report.top_machines],
  ] : [];
  const peak = report ? Math.max(1, ...report.daily.map((day) => day.count)) : 1;

  return (
    <ToolPage
      title={t('tools.report.title')}
      description={t('tools.report.description')}
      actions={(
        <div className="flex items-center gap-2">
          <select value={value} onChange={(event) => setValue(event.target.value)} aria-label={t('tools.report.period')} className="h-9 rounded-lg border border-gray-300 bg-white px-2 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100">
            <optgroup label={t('tools.report.rolling')}>
              {DAY_CHOICES.map((days) => <option key={days} value={`d:${days}`}>{t('tools.report.lastDays', { days })}</option>)}
            </optgroup>
            <optgroup label={t('tools.report.months')}>
              {months.map((month) => <option key={month} value={`m:${month}`}>{month}</option>)}
            </optgroup>
          </select>
          <button type="button" disabled={busy} onClick={() => void download()} className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary-600 px-3 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-60">
            <Download size={16} aria-hidden="true" />
            {t('tools.report.download')}
          </button>
        </div>
      )}
    >
      {error && <ToolMessage tone="error">{error}</ToolMessage>}
      {!report && !error && <p className="text-sm text-gray-500">{t('app.loading')}</p>}
      {report && (
        <>
          <p className="text-sm text-gray-500 dark:text-gray-400">{report.period.label}</p>
          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
            {figures.map(([label, figure]) => (
              <Card key={label}><CardContent className="py-4"><p className="text-xs uppercase text-gray-500 dark:text-gray-400">{label}</p><p className="text-2xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">{figure}</p></CardContent></Card>
            ))}
          </div>
          <Card>
            <CardHeader><CardTitle className="text-base">{t('tools.report.perDay')}</CardTitle></CardHeader>
            <CardContent>
              <div className="flex h-28 items-end gap-px" role="img" aria-label={t('tools.report.perDay')}>
                {report.daily.map((day) => (
                  <div key={day.date} title={`${day.date}: ${day.count}`} className="min-w-px flex-1 rounded-t bg-primary-500" style={{ height: `${Math.max(2, (day.count / peak) * 100)}%` }} />
                ))}
              </div>
            </CardContent>
          </Card>
          <div className="grid gap-4 md:grid-cols-2">
            {lists.map(([title, rows]) => (
              <Card key={title}>
                <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
                <CardContent className="space-y-1.5 py-4">
                  {rows.length === 0 && <p className="text-sm text-gray-500">{t('tools.hosts.none')}</p>}
                  {rows.map((row) => (
                    <div key={row.name} className="flex items-center justify-between gap-3 text-sm">
                      <span className="truncate" title={row.name}>{row.name}</span>
                      <span className="tabular-nums text-gray-500 dark:text-gray-400">{row.count}</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </ToolPage>
  );
}
