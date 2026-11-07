import { useState, type ReactNode } from 'react';
import { Save } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Switch } from './ui/Switch';
import { sessionFetch } from '../lib/sessionFetch';
import { apiUrl } from '../lib/basePath';
import { useI18n } from '../lib/i18n';
import type { ManagedSettingSource } from '../../../shared/contracts';
import { DEFAULT_STATISTICS_SETTINGS, type StatisticsConfiguration, type StatisticsSettings as Settings } from '../../../shared/statistics';

interface StatisticsSettingsProps {
  /** The configuration the Settings page has already loaded. */
  initial: StatisticsConfiguration;
  inputClass: string;
  labelClass: string;
  renderManagedLock: (source: ManagedSettingSource | undefined) => ReactNode;
  showToast: (message: string, type?: 'success' | 'danger' | 'info') => void;
  disabled?: boolean;
}

export function StatisticsSettings({ initial, inputClass, labelClass, renderManagedLock, showToast, disabled = false }: StatisticsSettingsProps) {
  const { t } = useI18n();
  const [configuration, setConfiguration] = useState<StatisticsConfiguration>(initial);
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_STATISTICS_SETTINGS, ...initial.settings });
  const [saving, setSaving] = useState(false);
  const locked = (key: keyof Settings) => disabled || saving || Boolean(configuration.managed[key]);
  const save = async () => {
    setSaving(true);
    try {
      const editable = Object.fromEntries(Object.entries(settings).filter(([key]) => !configuration.managed[key as keyof Settings]));
      const response = await sessionFetch(apiUrl('/api/config/statistics'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(editable) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || t('pages.statistics.saveError'));
      setConfiguration(payload.statistics);
      setSettings(payload.statistics.settings);
      showToast(t('pages.settings.settingsSaved'), 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('pages.statistics.saveError'), 'danger');
    } finally {
      setSaving(false);
    }
  };
  const field = (key: 'retentionDays' | 'jobInterval' | 'jobTimeBudget', id: string, label: string, input: ReactNode) => (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <label htmlFor={id} className={labelClass}>{label}</label>
        {renderManagedLock(configuration.managed[key])}
      </div>
      {input}
    </div>
  );

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>{t('pages.statistics.title')}</CardTitle>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('pages.statistics.settingsHelp')}</p>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <Switch id="statistics-enabled" ariaLabelledBy="statistics-enabled-label" checked={settings.enabled} disabled={locked('enabled')} onCheckedChange={(enabled) => setSettings((s) => ({ ...s, enabled }))} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <label id="statistics-enabled-label" htmlFor="statistics-enabled" className={labelClass}>{t('pages.statistics.enable')}</label>
              {renderManagedLock(configuration.managed.enabled)}
            </div>
          </div>
        </div>

        <div className="mt-6 grid gap-6 md:grid-cols-3">
          {field('retentionDays', 'statistics-retention', t('pages.statistics.retention'),
            <input id="statistics-retention" type="number" min={1} max={3650} className={inputClass} value={settings.retentionDays} disabled={locked('retentionDays')} onChange={(e) => setSettings((s) => ({ ...s, retentionDays: Number(e.target.value) }))} />)}
          {field('jobInterval', 'statistics-interval', t('pages.statistics.interval'),
            <input id="statistics-interval" className={inputClass} value={settings.jobInterval} placeholder="1h" disabled={locked('jobInterval')} onChange={(e) => setSettings((s) => ({ ...s, jobInterval: e.target.value }))} />)}
          {field('jobTimeBudget', 'statistics-budget', t('pages.statistics.budget'),
            <input id="statistics-budget" className={inputClass} value={settings.jobTimeBudget} placeholder="30s" disabled={locked('jobTimeBudget')} onChange={(e) => setSettings((s) => ({ ...s, jobTimeBudget: e.target.value }))} />)}
        </div>
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{t('pages.statistics.retentionHelp')}</p>

        <div className="mt-6 flex justify-start">
          <button
            type="button"
            onClick={() => void save()}
            disabled={disabled || saving}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Save className="h-4 w-4" aria-hidden="true" />
            {t(saving ? 'common.saving' : 'common.save')}
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
