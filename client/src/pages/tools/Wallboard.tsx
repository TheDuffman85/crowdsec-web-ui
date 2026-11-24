import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { CountryFlag } from '../../components/CountryFlag';
import { ToolMessage, ToolPage } from '../../components/ToolPage';
import { fetchLiveFeed, type HostCount, type LiveFeedSnapshot } from '../../lib/insightsApi';
import { useRefresh } from '../../contexts/useRefresh';
import { useI18n } from '../../lib/i18n';
import { useDateTime } from '../../lib/dateTime';

export const WALLBOARD_POLL_MS = 10_000;

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
      <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</p>
      <p className="mt-1 text-5xl font-bold tabular-nums text-gray-900 dark:text-gray-100">{value}</p>
    </div>
  );
}

function TopList({ title, rows, flag }: { title: string; rows: HostCount[]; flag?: boolean }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
      <p className="mb-2 text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{title}</p>
      <ul className="space-y-1.5">
        {rows.map((row) => (
          <li key={row.name} className="flex items-center justify-between gap-3 text-lg">
            <span className="flex min-w-0 items-center gap-2">{flag && <CountryFlag code={row.name} />}<span className="truncate">{row.name}</span></span>
            <span className="tabular-nums text-gray-500 dark:text-gray-400">{row.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A screen meant to stay open on a wall: headline counters and the newest attacks, updated as the server syncs. */
export function Wallboard() {
  const { t } = useI18n();
  const { formatDateTime } = useDateTime();
  const { refreshSignal = 0 } = useRefresh();
  const [snapshot, setSnapshot] = useState<LiveFeedSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const frame = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setSnapshot(await fetchLiveFeed(20));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('tools.wallboard.loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [load, refreshSignal]);
  useEffect(() => {
    const timer = window.setInterval(() => { void load(); }, WALLBOARD_POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === frame.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void frame.current?.requestFullscreen?.();
  };

  return (
    <ToolPage
      title={t('tools.wallboard.title')}
      description={t('tools.wallboard.description')}
      actions={(
        <button type="button" onClick={toggleFullscreen} className="inline-flex h-9 items-center gap-2 rounded-lg border border-gray-300 px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800">
          {fullscreen ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}
          {fullscreen ? t('tools.wallboard.exitFullscreen') : t('tools.wallboard.fullscreen')}
        </button>
      )}
    >
      <div ref={frame} className={`space-y-4 ${fullscreen ? 'min-h-screen overflow-auto bg-gray-100 p-6 dark:bg-gray-900' : ''}`}>
        {error && <ToolMessage tone="error">{error}</ToolMessage>}
        {!snapshot && !error && <p className="text-sm text-gray-500">{t('app.loading')}</p>}
        {snapshot && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Counter label={t('tools.wallboard.lastHour')} value={snapshot.last_hour} />
              <Counter label={t('tools.wallboard.last24h')} value={snapshot.last_24h} />
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800 lg:col-span-2">
                <p className="mb-2 text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('tools.wallboard.latest')}</p>
                {snapshot.alerts.length === 0 && <p className="text-sm text-gray-500">{t('tools.wallboard.quiet')}</p>}
                <ul className="divide-y divide-gray-100 dark:divide-gray-700/50" data-testid="wallboard-alerts">
                  {snapshot.alerts.map((alert) => (
                    <li key={alert.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-base">
                      <span className="w-40 shrink-0 text-gray-500 dark:text-gray-400">{formatDateTime(alert.created_at)}</span>
                      <span className="inline-flex items-center gap-2"><CountryFlag code={alert.country} /><span className="font-mono">{alert.source_ip}</span></span>
                      <span className="min-w-0 truncate text-gray-800 dark:text-gray-200">{alert.scenario}</span>
                      {alert.machine && <span className="text-sm text-gray-500 dark:text-gray-400">{alert.machine}</span>}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="space-y-4">
                <TopList title={t('tools.wallboard.topCountries')} rows={snapshot.top_countries} flag />
                <TopList title={t('tools.wallboard.topScenarios')} rows={snapshot.top_scenarios} />
              </div>
            </div>
          </>
        )}
      </div>
    </ToolPage>
  );
}
