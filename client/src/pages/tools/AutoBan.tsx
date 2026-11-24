import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { ToolMessage, ToolPage } from '../../components/ToolPage';
import { fetchConfig } from '../../lib/api';
import {
  fetchAutoBan, previewAutoBan, saveAutoBan,
  type AutoBanCandidate, type AutoBanLogEntry, type AutoBanRule, type AutoBanSettings,
} from '../../lib/insightsApi';
import { useI18n } from '../../lib/i18n';
import { useDateTime } from '../../lib/dateTime';
import { useOptionalToast } from '../../contexts/useToast';

const ACTION_LABELS: Record<AutoBanLogEntry['action'], string> = {
  would_ban: 'tools.autoBan.actionWouldBan',
  banned: 'tools.autoBan.actionBanned',
  skipped_allowlisted: 'tools.autoBan.actionAllowlisted',
  failed: 'tools.autoBan.actionFailed',
};

const NEW_RULE: AutoBanRule = { name: '', scenario: 'ssh', min_alerts: 5, window_minutes: 60, duration: '4h', escalate: true };

const INPUT = 'h-9 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100';

/** Rules that ban an address after repeated matching alerts. Off until enabled, and a dry run until switched to live. */
export function AutoBan() {
  const { t } = useI18n();
  const { formatDateTime } = useDateTime();
  const toast = useOptionalToast();
  const [settings, setSettings] = useState<AutoBanSettings | null>(null);
  const [log, setLog] = useState<AutoBanLogEntry[]>([]);
  const [preview, setPreview] = useState<Array<{ rule_id: string; rule_name: string; candidates: AutoBanCandidate[] }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchAutoBan();
      setSettings(data.settings);
      setLog(data.log);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('tools.autoBan.loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [load]);
  useEffect(() => {
    void fetchConfig().then((config) => setCanManage(config.permissions?.can_manage_settings !== false)).catch(() => undefined);
  }, []);

  const update = (patch: Partial<AutoBanSettings>) => setSettings((current) => (current ? { ...current, ...patch } : current));
  const updateRule = (index: number, patch: Partial<AutoBanRule>) => setSettings((current) => (current
    ? { ...current, rules: current.rules.map((rule, position) => (position === index ? { ...rule, ...patch } : rule)) }
    : current));

  const save = async () => {
    if (!settings) return;
    if (settings.enabled && !settings.dry_run && !window.confirm(t('tools.autoBan.confirmLive'))) return;
    setBusy(true);
    try {
      setSettings(await saveAutoBan(settings));
      toast?.addToast(t('tools.autoBan.saved'), 'success');
    } catch (saveError) {
      toast?.addToast(saveError instanceof Error ? saveError.message : t('tools.autoBan.saveFailed'), 'danger');
    } finally {
      setBusy(false);
    }
  };

  const runPreview = async () => {
    try {
      setPreview(await previewAutoBan());
    } catch (previewError) {
      toast?.addToast(previewError instanceof Error ? previewError.message : t('tools.autoBan.previewFailed'), 'danger');
    }
  };

  const live = settings?.enabled && !settings.dry_run;

  return (
    <ToolPage title={t('tools.autoBan.title')} description={t('tools.autoBan.description')}>
      {error && <ToolMessage tone="error">{error}</ToolMessage>}
      {!settings && !error && <p className="text-sm text-gray-500">{t('app.loading')}</p>}
      {!canManage && <ToolMessage>{t('tools.autoBan.readOnly')}</ToolMessage>}
      {settings && (
        <>
          <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>{t('tools.autoBan.status')}</CardTitle>
              <Badge variant={live ? 'danger' : settings.enabled ? 'warning' : 'secondary'}>
                {live ? t('tools.autoBan.stateLive') : settings.enabled ? t('tools.autoBan.stateDryRun') : t('tools.autoBan.stateOff')}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              <label className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
                <input type="checkbox" checked={settings.enabled} disabled={!canManage} onChange={(event) => update({ enabled: event.target.checked })} />
                {t('tools.autoBan.enable')}
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
                <input type="checkbox" checked={settings.dry_run} disabled={!canManage} onChange={(event) => update({ dry_run: event.target.checked })} />
                {t('tools.autoBan.dryRun')}
              </label>
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('tools.autoBan.safety')}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>{t('tools.autoBan.rules')}</CardTitle>
              <button
                type="button"
                disabled={!canManage || settings.rules.length >= 20}
                onClick={() => update({ rules: [...settings.rules, { ...NEW_RULE }] })}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-gray-300 px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
              >
                <Plus size={16} aria-hidden="true" />{t('tools.autoBan.addRule')}
              </button>
            </CardHeader>
            <CardContent className="space-y-4">
              {settings.rules.length === 0 && <p className="text-sm text-gray-500">{t('tools.autoBan.noRules')}</p>}
              {settings.rules.map((rule, index) => (
                <fieldset key={rule.id ?? `new-${index}`} className="grid gap-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700 sm:grid-cols-2 lg:grid-cols-3">
                  <legend className="px-1 text-xs uppercase text-gray-500">{t('tools.autoBan.ruleNumber', { number: index + 1 })}</legend>
                  <label className="text-sm"><span className="mb-1 block">{t('tools.autoBan.ruleName')}</span><input className={INPUT} value={rule.name} maxLength={60} disabled={!canManage} onChange={(event) => updateRule(index, { name: event.target.value })} /></label>
                  <label className="text-sm"><span className="mb-1 block">{t('tools.autoBan.scenario')}</span><input className={INPUT} value={rule.scenario} maxLength={100} disabled={!canManage} onChange={(event) => updateRule(index, { scenario: event.target.value })} /></label>
                  <label className="text-sm"><span className="mb-1 block">{t('tools.autoBan.minAlerts')}</span><input className={INPUT} type="number" min={2} max={1000} value={rule.min_alerts} disabled={!canManage} onChange={(event) => updateRule(index, { min_alerts: Number(event.target.value) })} /></label>
                  <label className="text-sm"><span className="mb-1 block">{t('tools.autoBan.window')}</span><input className={INPUT} type="number" min={1} max={10080} value={rule.window_minutes} disabled={!canManage} onChange={(event) => updateRule(index, { window_minutes: Number(event.target.value) })} /></label>
                  <label className="text-sm"><span className="mb-1 block">{t('tools.autoBan.duration')}</span><input className={INPUT} value={rule.duration} disabled={!canManage} onChange={(event) => updateRule(index, { duration: event.target.value })} /></label>
                  <div className="flex items-end justify-between gap-3">
                    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={rule.escalate} disabled={!canManage} onChange={(event) => updateRule(index, { escalate: event.target.checked })} />{t('tools.autoBan.escalate')}</label>
                    <button type="button" disabled={!canManage} onClick={() => update({ rules: settings.rules.filter((_, position) => position !== index) })} aria-label={t('tools.autoBan.removeRule', { number: index + 1 })} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"><Trash2 size={16} aria-hidden="true" /></button>
                  </div>
                </fieldset>
              ))}
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy || !canManage} onClick={() => void save()} className="h-9 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50">{t('tools.autoBan.save')}</button>
                <button type="button" onClick={() => void runPreview()} className="h-9 rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800">{t('tools.autoBan.preview')}</button>
              </div>
              {preview && (
                <div className="space-y-2" data-testid="auto-ban-preview">
                  <p className="text-xs text-gray-500">{t('tools.autoBan.previewNote')}</p>
                  {preview.length === 0 && <p className="text-sm text-gray-500">{t('tools.autoBan.noRules')}</p>}
                  {preview.map((entry) => (
                    <div key={entry.rule_id} className="text-sm">
                      <p className="font-medium text-gray-900 dark:text-gray-100">{entry.rule_name}</p>
                      {entry.candidates.length === 0
                        ? <p className="text-gray-500">{t('tools.autoBan.noMatches')}</p>
                        : <ul>{entry.candidates.map((candidate) => (
                          <li key={candidate.ip} className="font-mono text-xs">{t('tools.autoBan.candidate', { ip: candidate.ip, alerts: candidate.alerts, duration: candidate.duration })}</li>
                        ))}</ul>}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t('tools.autoBan.log')}</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto p-0">
              {log.length === 0 && <p className="p-6 text-sm text-gray-500">{t('tools.autoBan.logEmpty')}</p>}
              {log.length > 0 && (
                <table className="w-full text-left text-sm">
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                    {log.map((entry) => (
                      <tr key={entry.id}>
                        <td className="whitespace-nowrap px-4 py-2 text-gray-500">{formatDateTime(entry.at)}</td>
                        <td className="px-4 py-2 font-mono">{entry.ip}</td>
                        <td className="px-4 py-2">{entry.rule_name}</td>
                        <td className="px-4 py-2"><Badge variant={entry.action === 'banned' ? 'danger' : entry.action === 'failed' ? 'warning' : 'secondary'}>{t(ACTION_LABELS[entry.action])}</Badge></td>
                        <td className="px-4 py-2 text-gray-500">{entry.duration}{entry.detail ? ` · ${entry.detail}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </ToolPage>
  );
}
