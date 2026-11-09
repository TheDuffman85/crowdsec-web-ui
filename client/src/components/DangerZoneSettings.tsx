import { useState } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Modal } from './ui/Modal';
import { sessionFetch } from '../lib/sessionFetch';
import { apiUrl } from '../lib/basePath';
import { useI18n } from '../lib/i18n';

interface DangerZoneSettingsProps {
  /** Clearing the cache requires enforcement permission, like the API. */
  canDeleteCache: boolean;
  /** Statistics can be deleted with settings permission while the archive exists in the configuration. */
  canDeleteStatistics: boolean;
  showStatistics: boolean;
  showToast: (message: string, type?: 'success' | 'danger' | 'info') => void;
}

interface DangerAction {
  key: 'cache' | 'statistics';
  label: string;
  title: string;
  description: string;
  allowed: boolean;
  request: () => Promise<Response>;
  success: string;
  error: string;
}

// The same red as the delete icons in the tables. Dark mode uses dark text for contrast on the lighter red.
const dangerButtonClass = 'inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-red-400 dark:text-gray-950 dark:hover:bg-red-300';
const secondaryButtonClass = 'inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800';

/** Irreversible maintenance actions, each confirmed in a dialog before it runs. */
export function DangerZoneSettings({ canDeleteCache, canDeleteStatistics, showStatistics, showToast }: DangerZoneSettingsProps) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState<DangerAction['key'] | null>(null);
  const [running, setRunning] = useState(false);
  const actions: DangerAction[] = [
    {
      key: 'cache', label: t('pages.settings.deleteCache'), title: t('pages.settings.deleteCacheTitle'), description: t('pages.settings.deleteCacheDescription'),
      allowed: canDeleteCache, request: () => sessionFetch(apiUrl('/api/cache/clear'), { method: 'POST' }),
      success: t('pages.settings.deleteCacheSuccess'), error: t('pages.settings.deleteCacheError'),
    },
    ...(showStatistics ? [{
      key: 'statistics' as const, label: t('pages.statistics.deleteAll'), title: t('pages.statistics.deleteAllTitle'), description: t('pages.statistics.deleteAllConfirm'),
      allowed: canDeleteStatistics, request: () => sessionFetch(apiUrl('/api/statistics'), { method: 'DELETE' }),
      success: t('pages.statistics.deleteAllSuccess'), error: t('pages.statistics.deleteAllError'),
    }] : []),
  ];
  const action = actions.find((candidate) => candidate.key === confirming) ?? null;
  const run = async (current: DangerAction) => {
    setRunning(true);
    try {
      const response = await current.request();
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || current.error);
      setConfirming(null);
      showToast(current.success, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : current.error, 'danger');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card className="mt-6 border-red-300 bg-red-50 dark:border-red-900/70 dark:bg-red-950/40">
      <CardHeader className="border-red-200 bg-red-100/70 dark:border-red-900/50 dark:bg-red-950/60">
        <CardTitle className="flex items-center gap-2 text-red-700 dark:text-red-400">
          <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          {t('pages.settings.dangerZone')}
        </CardTitle>
        <p className="mt-1 text-sm text-red-700/80 dark:text-red-300/80">{t('pages.settings.dangerZoneDescription')}</p>
      </CardHeader>
      <CardContent className="divide-y divide-red-200 py-0 dark:divide-red-900/50">
        {actions.map((candidate) => (
          <div key={candidate.key} className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div className="min-w-0">
              <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{candidate.label}</h4>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{candidate.description}</p>
            </div>
            <button type="button" onClick={() => setConfirming(candidate.key)} disabled={!candidate.allowed || running} className={dangerButtonClass}>
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              {candidate.label}
            </button>
          </div>
        ))}
      </CardContent>
      <Modal isOpen={action !== null} onClose={() => !running && setConfirming(null)} title={action?.title}>
        {action && (
          <div className="space-y-5">
            <p className="text-sm text-gray-500 dark:text-gray-400">{action.description}</p>
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button type="button" onClick={() => setConfirming(null)} disabled={running} className={secondaryButtonClass}>
                {t('common.cancel')}
              </button>
              <button type="button" onClick={() => void run(action)} disabled={running} className={dangerButtonClass}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                {running ? t('common.deleting') : action.label}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
}
