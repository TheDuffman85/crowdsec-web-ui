import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bell, Gavel, ScrollText, StickyNote, type LucideIcon } from 'lucide-react';
import { Card, CardContent } from '../../components/ui/Card';
import { ThreatScoreBadge } from '../../components/ThreatScoreBadge';
import { ToolMessage, ToolPage } from '../../components/ToolPage';
import { fetchIpTimeline, type IpTimeline as IpTimelineData, type TimelineEvent, type TimelineKind } from '../../lib/insightsApi';
import { useDateTime } from '../../lib/dateTime';
import { useI18n } from '../../lib/i18n';

const KINDS: readonly TimelineKind[] = ['alert', 'decision', 'note', 'audit'];
const ICONS: Record<TimelineKind, LucideIcon> = { alert: Bell, decision: Gavel, note: StickyNote, audit: ScrollText };
const COLOURS: Record<TimelineKind, string> = {
  alert: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  decision: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  note: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  audit: 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
};
const ADDRESS = /^[0-9a-fA-F:.]+$/;

interface Loaded { ip: string; timeline?: IpTimelineData; error?: string }

/** Everything that happened to one address: alerts, decisions, notes and admin actions, across machines. */
export function IpTimeline() {
  const { t } = useI18n();
  const { formatDateTime } = useDateTime();
  const [params, setParams] = useSearchParams();
  const ip = (params.get('ip') ?? '').trim().toLowerCase();
  const [draft, setDraft] = useState(ip);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<TimelineKind>>(new Set());
  const [machine, setMachine] = useState('');
  const valid = ADDRESS.test(ip);

  useEffect(() => {
    if (!valid) return;
    let active = true;
    fetchIpTimeline(ip)
      .then((timeline) => { if (active) setLoaded({ ip, timeline }); })
      .catch((error: unknown) => { if (active) setLoaded({ ip, error: error instanceof Error ? error.message : t('tools.timeline.loadFailed') }); });
    return () => { active = false; };
  }, [ip, valid, t]);

  const current = loaded && loaded.ip === ip ? loaded : null;
  const timeline = current?.timeline;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = draft.trim();
    setMachine('');
    setParams(next ? { ip: next } : {});
  };
  const toggle = (kind: TimelineKind) => setHidden((now) => { const next = new Set(now); if (next.has(kind)) next.delete(kind); else next.add(kind); return next; });
  const actionLabel = (action: string) => { const key = `tools.audit.action.${action}`; const label = t(key); return label === key ? action : label; };
  const visible = (timeline?.events ?? []).filter((event) => !hidden.has(event.kind) && (!machine || event.machine === machine));

  const describe = (event: TimelineEvent): string => {
    const d = event.detail;
    switch (event.kind) {
      case 'alert': return t('tools.timeline.alertDetail', { events: Number(d.events ?? 0) }) + (d.simulated ? ` (${t('tools.timeline.simulated')})` : '');
      case 'decision': return t('tools.timeline.decisionDetail', { duration: String(d.duration ?? '-'), until: formatDateTime(String(d.until ?? '')) }) + (d.origin ? ` · ${String(d.origin)}` : '');
      case 'note': return String(d.body ?? '');
      default: return t('tools.timeline.auditDetail', { user: String(d.user ?? ''), outcome: t(`tools.audit.outcomes.${String(d.outcome)}`) }) + (d.reason ? ` · ${String(d.reason)}` : '');
    }
  };
  const title = (event: TimelineEvent) => (event.kind === 'audit' ? actionLabel(event.title) : event.kind === 'note' ? t('tools.timeline.noteBy', { author: event.title }) : event.title);

  return (
    <ToolPage title={t('tools.timeline.title')} description={t('tools.timeline.description')}>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-gray-700 dark:text-gray-300">
          <span className="mb-1 block">{t('tools.timeline.address')}</span>
          <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="203.0.113.5" className="w-64 rounded-md border border-gray-300 bg-white px-3 py-1.5 font-mono text-sm dark:border-gray-600 dark:bg-gray-800" />
        </label>
        <button type="submit" className="rounded-md bg-primary-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-primary-700">{t('tools.timeline.show')}</button>
      </form>

      {ip && !valid && <ToolMessage tone="error">{t('tools.timeline.invalid')}</ToolMessage>}
      {valid && !current && <p className="text-sm text-gray-500">{t('app.loading')}</p>}
      {current?.error && <ToolMessage tone="error">{current.error}</ToolMessage>}

      {valid && timeline && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Link to={`/alerts?q=${encodeURIComponent(ip)}`} className="font-mono text-lg font-semibold text-primary-700 hover:underline dark:text-primary-400">{ip}</Link>
            <ThreatScoreBadge ip={ip} />
            <span className="text-sm text-gray-500 dark:text-gray-400">{t('tools.timeline.machines', { count: timeline.machines.length })}</span>
          </div>
          <div className="flex flex-wrap items-center gap-4" role="group" aria-label={t('tools.timeline.filters')}>
            {KINDS.filter((kind) => kind !== 'audit' || timeline.audit_included).map((kind) => (
              <label key={kind} className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input type="checkbox" checked={!hidden.has(kind)} onChange={() => toggle(kind)} />
                {t(`tools.timeline.kind.${kind}`)} ({timeline.counts[kind]})
              </label>
            ))}
            {timeline.machines.length > 1 && (
              <label className="text-sm text-gray-700 dark:text-gray-300">
                <span className="mr-2">{t('tools.timeline.machine')}</span>
                <select value={machine} onChange={(event) => setMachine(event.target.value)} className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800">
                  <option value="">{t('tools.audit.any')}</option>
                  {timeline.machines.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>
            )}
          </div>
          {!timeline.audit_included && <p className="text-xs text-gray-500 dark:text-gray-400">{t('tools.timeline.auditHidden')}</p>}
          {timeline.truncated && <ToolMessage tone="warning">{t('tools.timeline.truncated', { count: timeline.events.length })}</ToolMessage>}
          {visible.length === 0 ? <ToolMessage>{t('tools.timeline.empty')}</ToolMessage> : (
            <Card>
              <CardContent className="p-0">
                <ol className="divide-y divide-gray-100 dark:divide-gray-700/50" data-testid="timeline-list">
                  {visible.map((event, index) => {
                    const Icon = ICONS[event.kind];
                    return (
                      <li key={`${event.kind}-${event.time}-${index}`} className="flex gap-3 px-4 py-3" data-kind={event.kind}>
                        <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${COLOURS[event.kind]}`}>
                          <Icon size={14} aria-label={t(`tools.timeline.kind.${event.kind}`)} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-3">
                            <span className="break-all text-sm font-medium text-gray-900 dark:text-gray-100">{title(event)}</span>
                            <span className="text-xs text-gray-500 dark:text-gray-400">{formatDateTime(event.time)}</span>
                          </div>
                          <p className="break-words text-sm text-gray-600 dark:text-gray-300">{describe(event)}</p>
                          {(event.machine || event.instance) && (
                            <p className="text-xs text-gray-500 dark:text-gray-400">{[event.machine, event.instance].filter(Boolean).join(' · ')}</p>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </ToolPage>
  );
}
