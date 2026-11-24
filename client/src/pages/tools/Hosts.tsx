import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { CountryFlag } from '../../components/CountryFlag';
import { ToolMessage, ToolPage } from '../../components/ToolPage';
import { fetchHostDetail, fetchHosts, type HostCount, type HostDetail, type HostSummary } from '../../lib/insightsApi';
import { sparklinePoints } from '../../lib/trends';
import { useI18n } from '../../lib/i18n';
import { useDateTime } from '../../lib/dateTime';

function CountList({ title, rows, flag }: { title: string; rows: HostCount[]; flag?: boolean }) {
  const { t } = useI18n();
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="space-y-1.5 py-4">
        {rows.length === 0 && <p className="text-sm text-gray-500">{t('tools.hosts.none')}</p>}
        {rows.map((row) => (
          <div key={row.name} className="flex items-center justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              {flag && <CountryFlag code={row.name} />}
              <span className="truncate text-gray-800 dark:text-gray-200" title={row.name}>{row.name}</span>
            </span>
            <span className="tabular-nums text-gray-500 dark:text-gray-400">{row.count}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function HostDetailView({ machine }: { machine: string }) {
  const { t } = useI18n();
  const { formatDateTime } = useDateTime();
  const [detail, setDetail] = useState<HostDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchHostDetail(machine)
      .then((data) => { if (active) setDetail(data); })
      .catch((loadError: unknown) => { if (active) setError(loadError instanceof Error ? loadError.message : t('tools.hosts.loadFailed')); });
    return () => { active = false; };
  }, [machine, t]);

  if (error) return <ToolMessage tone="error">{error}</ToolMessage>;
  if (!detail) return <p className="text-sm text-gray-500">{t('app.loading')}</p>;
  const points = sparklinePoints(detail.daily.map((day) => day.count), 560, 80);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        {[
          [t('tools.hosts.alerts24h'), detail.alerts_24h],
          [t('tools.hosts.alerts7d'), detail.alerts_7d],
          [t('tools.hosts.alertsTotal'), detail.alerts_total],
          [t('tools.hosts.activeDecisions'), detail.active_decisions],
        ].map(([label, value]) => (
          <Card key={String(label)}><CardContent className="py-4"><p className="text-xs uppercase text-gray-500 dark:text-gray-400">{label}</p><p className="text-2xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">{value}</p></CardContent></Card>
        ))}
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">{t('tools.hosts.last14Days')}</CardTitle></CardHeader>
        <CardContent>
          <svg viewBox="0 0 560 80" className="h-24 w-full" role="img" aria-label={t('tools.hosts.last14Days')} preserveAspectRatio="none">
            <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" className="text-primary-600 dark:text-primary-400" vectorEffect="non-scaling-stroke" />
          </svg>
        </CardContent>
      </Card>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <CountList title={t('tools.hosts.topScenarios')} rows={detail.top_scenarios} />
        <CountList title={t('tools.hosts.topSources')} rows={detail.top_sources} />
        <CountList title={t('tools.hosts.topCountries')} rows={detail.top_countries} flag />
        <CountList title={t('tools.hosts.topTargets')} rows={detail.top_targets} />
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">{t('tools.hosts.recent')}</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-left text-sm">
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
              {detail.recent_alerts.map((alert) => (
                <tr key={alert.id}>
                  <td className="whitespace-nowrap px-4 py-2 text-gray-500">{formatDateTime(alert.created_at)}</td>
                  <td className="px-4 py-2">{alert.scenario}</td>
                  <td className="px-4 py-2"><span className="inline-flex items-center gap-2"><CountryFlag code={alert.country} />{alert.source_ip && <Link to={`/alerts?q=${encodeURIComponent(alert.source_ip)}`} className="font-mono text-primary-700 hover:underline dark:text-primary-400">{alert.source_ip}</Link>}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

/** Security engines and agents that report to the Local API, with a per-host breakdown. */
export function Hosts() {
  const { t } = useI18n();
  const { formatDateTime } = useDateTime();
  const [params, setParams] = useSearchParams();
  const [hosts, setHosts] = useState<HostSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = params.get('machine');

  useEffect(() => {
    let active = true;
    fetchHosts()
      .then((data) => { if (active) setHosts(data); })
      .catch((loadError: unknown) => { if (active) setError(loadError instanceof Error ? loadError.message : t('tools.hosts.loadFailed')); });
    return () => { active = false; };
  }, [t]);

  return (
    <ToolPage title={t('tools.hosts.title')} description={t('tools.hosts.description')}>
      {error && <ToolMessage tone="error">{error}</ToolMessage>}
      {!hosts && !error && <p className="text-sm text-gray-500">{t('app.loading')}</p>}
      {hosts?.length === 0 && <ToolMessage>{t('tools.hosts.empty')}</ToolMessage>}
      {hosts && hosts.length > 0 && (
        <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('tools.hosts.title')}>
          {hosts.map((host) => (
            <button
              key={host.machine}
              type="button"
              role="tab"
              aria-selected={selected === host.machine}
              onClick={() => setParams({ machine: host.machine })}
              className={`rounded-lg border px-3 py-2 text-left text-sm ${selected === host.machine ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/30' : 'border-gray-200 bg-white hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700'}`}
            >
              <span className="block font-medium text-gray-900 dark:text-gray-100">{host.machine}</span>
              <span className="block text-xs text-gray-500 dark:text-gray-400">
                {t('tools.hosts.summaryLine', { day: host.alerts_24h, week: host.alerts_7d })}
                {host.last_alert_at ? ` · ${formatDateTime(host.last_alert_at)}` : ''}
              </span>
              {host.alerts_24h === 0 && <Badge variant="secondary" className="mt-1">{t('tools.hosts.quiet')}</Badge>}
            </button>
          ))}
        </div>
      )}
      {selected && <HostDetailView key={selected} machine={selected} />}
      {hosts && hosts.length > 0 && !selected && <ToolMessage>{t('tools.hosts.pick')}</ToolMessage>}
    </ToolPage>
  );
}
