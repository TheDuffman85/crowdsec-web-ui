import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import {
  collectAllPages,
  CSV_EXPORT_MAX_ROWS,
  csvFilename,
  downloadCsv,
  toCsv,
  type CsvColumn,
  type CsvPage,
} from '../lib/csvExport';

interface ExportCsvButtonProps<T> {
  kind: 'alerts' | 'decisions' | 'audit-log';
  columns: CsvColumn<T>[];
  fetchPage: (page: number) => Promise<CsvPage<T>>;
}

/** Downloads every row matching the page's current filters as a CSV file. */
export function ExportCsvButton<T>({ kind, columns, fetchPage }: ExportCsvButtonProps<T>) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);

  const handleExport = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const { rows, truncated } = await collectAllPages(fetchPage);
      downloadCsv(csvFilename(kind), toCsv(rows, columns));
      if (truncated) {
        setMessage({ tone: 'info', text: t('components.exportCsv.truncated', { count: CSV_EXPORT_MAX_ROWS.toLocaleString() }) });
      }
    } catch {
      setMessage({ tone: 'error', text: t('components.exportCsv.failed') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-start">
      <button
        type="button"
        onClick={() => void handleExport()}
        disabled={busy}
        aria-label={t('components.exportCsv.label')}
        title={t('components.exportCsv.title')}
        className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
      >
        {busy ? <Loader2 size={18} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Download size={18} aria-hidden="true" />}
        <span className="hidden sm:inline">{t('components.exportCsv.button')}</span>
      </button>
      {message && (
        <span role={message.tone === 'error' ? 'alert' : 'status'} className={`mt-1 text-xs ${message.tone === 'error' ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}>
          {message.text}
        </span>
      )}
    </div>
  );
}
