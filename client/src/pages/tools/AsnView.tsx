import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { AddDecisionModal } from '../../components/AddDecisionModal';
import { CountryFlag } from '../../components/CountryFlag';
import { ThreatScoreBadge } from '../../components/ThreatScoreBadge';
import { ToolMessage, ToolPage } from '../../components/ToolPage';
import { Badge } from '../../components/ui/Badge';
import { Card, CardContent } from '../../components/ui/Card';
import { fetchConfig } from '../../lib/api';
import { fetchAsnDetail, fetchAsns, fetchThreatScores, type AsnDetail, type AsnList, type ThreatScore } from '../../lib/insightsApi';
import { useDateTime } from '../../lib/dateTime';
import { useI18n } from '../../lib/i18n';
import type { ConfigResponse } from '../../types';

const PERIODS = [7, 30, 90] as const;
const SCORE_BATCH = 100;

interface DetailState { key: string; detail?: AsnDetail; error?: string }

function AsnDetailPanel({ asn, days, canBan, onBanRange }: { asn: string; days: number; canBan: boolean; onBanRange: (range: string, name: string | null) => void }) {
  const { t } = useI18n();
  const { formatDateTime } = useDateTime();
  const key = `${asn}:${days}`;
  const [state, setState] = useState<DetailState | null>(null);
  const [scores, setScores] = useState<Map<string, ThreatScore>>(new Map());

  useEffect(() => {
    let active = true;
    fetchAsnDetail(asn, days)
      .then(async (detail) => {
        if (!active) return;
        setState({ key, detail });
        const batch = detail.ips.map((entry) => entry.ip).filter((ip) => !ip.includes('/')).slice(0, SCORE_BATCH);
        const loaded = await fetchThreatScores(batch).catch(() => []);
        if (active) setScores(new Map(loaded.map((score) => [score.ip, score])));
      })
      .catch((error: unknown) => { if (active) setState({ key, error: error instanceof Error ? error.message : t('tools.asn.loadFailed') }); });
    return () => { active = false; };
  }, [asn, days, key, t]);

  const current = state?.key === key ? state : null;
  if (!current) return <p className="px-4 py-3 text-sm text-gray-500">{t('app.loading')}</p>;
  if (current.error || !current.detail) return <div className="px-4 py-3"><ToolMessage tone="error">{current.error}</ToolMessage></div>;
  const { detail } = current;

  return (
    <div className="space-y-4 bg-gray-50 px-4 py-4 dark:bg-gray-800/40" data-testid={`asn-detail-${asn}`}>
      {detail.ranges.length > 0 && (
        <div>
          <h4 className="mb-1 text-sm font-semibold text-gray-800 dark:text-gray-200">{t('tools.asn.ranges')}</h4>
          <ul className="flex flex-wrap gap-2">
            {detail.ranges.map((entry) => (
              <li key={entry.range} className="inline-flex items-center gap-2 rounded-md border border-gray-200 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800">
                <span className="font-mono">{entry.range}</span>
                <span className="text-xs text-gray-500">{t('tools.asn.alertCount', { count: entry.count })}</span>
                {canBan && (
                  <button type="button" onClick={() => onBanRange(entry.range, detail.name)} className="rounded bg-red-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-700" aria-label={t('tools.asn.banRangeLabel', { range: entry.range })}>
                    {t('tools.asn.banRange')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h4 className="mb-1 text-sm font-semibold text-gray-800 dark:text-gray-200">{t('tools.asn.addresses', { count: detail.unique_ips })}</h4>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-3 py-1">{t('tools.offenders.address')}</th>
                <th className="px-3 py-1">{t('components.threatScore.label')}</th>
                <th className="px-3 py-1 text-right">{t('tools.asn.alerts')}</th>
                <th className="px-3 py-1">{t('tools.asn.scenarios')}</th>
                <th className="px-3 py-1">{t('tools.asn.lastSeen')}</th>
                <th className="px-3 py-1" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
              {detail.ips.map((entry) => (
                <tr key={entry.ip}>
                  <td className="px-3 py-1">
                    <span className="inline-flex items-center gap-2">
                      <CountryFlag code={entry.country ?? undefined} />
                      <Link to={`/alerts?q=${encodeURIComponent(entry.ip)}`} className="font-mono text-primary-700 hover:underline dark:text-primary-400">{entry.ip}</Link>
                      {entry.banned_now && <Badge variant="danger">{t('tools.offenders.bannedNow')}</Badge>}
                    </span>
                  </td>
                  <td className="px-3 py-1"><ThreatScoreBadge score={scores.get(entry.ip) ?? null} /></td>
                  <td className="px-3 py-1 text-right tabular-nums">{entry.alerts}</td>
                  <td className="max-w-xs truncate px-3 py-1" title={entry.scenarios.join(', ')}>{entry.scenarios.join(', ')}</td>
                  <td className="whitespace-nowrap px-3 py-1">{formatDateTime(entry.last_seen)}</td>
                  <td className="px-3 py-1"><Link to={`/tools/ip-timeline?ip=${encodeURIComponent(entry.ip)}`} className="text-xs text-primary-700 hover:underline dark:text-primary-400">{t('tools.timeline.open')}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {detail.truncated && <p className="mt-1 text-xs text-gray-500">{t('tools.asn.truncated', { count: detail.ips.length })}</p>}
      </div>
    </div>
  );
}

/** Attackers grouped by the network (AS number and organisation) that announces them. */
export function AsnView() {
  const { t } = useI18n();
  const { formatDateTime } = useDateTime();
  const [days, setDays] = useState<number>(30);
  const [filter, setFilter] = useState('');
  const [loaded, setLoaded] = useState<{ days: number; list?: AsnList; error?: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [ban, setBan] = useState<{ range: string; reason: string } | null>(null);

  useEffect(() => {
    let active = true;
    fetchAsns(days)
      .then((list) => { if (active) setLoaded({ days, list }); })
      .catch((error: unknown) => { if (active) setLoaded({ days, error: error instanceof Error ? error.message : t('tools.asn.loadFailed') }); });
    return () => { active = false; };
  }, [days, t]);
  useEffect(() => {
    let active = true;
    fetchConfig().then((value) => { if (active) setConfig(value); }).catch(() => { /* Without it banning stays hidden. */ });
    return () => { active = false; };
  }, []);

  const current = loaded?.days === days ? loaded : null;
  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = current?.list?.asns ?? [];
    return needle ? all.filter((entry) => `as${entry.asn} ${entry.asn} ${entry.name ?? ''}`.toLowerCase().includes(needle)) : all;
  }, [current, filter]);
  const canBan = config !== null && config.permissions?.can_manage_enforcement !== false;
  const instances = config?.instances ?? [];

  return (
    <ToolPage title={t('tools.asn.title')} description={t('tools.asn.description')}>
      <div className="flex flex-wrap items-end gap-4">
        <label className="text-sm text-gray-700 dark:text-gray-300"><span className="mb-1 block">{t('tools.asn.period')}</span>
          <select value={days} onChange={(event) => { setOpen(null); setDays(Number(event.target.value)); }} className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800">
            {PERIODS.map((value) => <option key={value} value={value}>{t('tools.asn.days', { count: value })}</option>)}
          </select>
        </label>
        <label className="text-sm text-gray-700 dark:text-gray-300"><span className="mb-1 block">{t('tools.asn.filter')}</span>
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t('tools.asn.filterPlaceholder')} className="w-64 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800" />
        </label>
      </div>

      {!current && <p className="text-sm text-gray-500">{t('app.loading')}</p>}
      {current?.error && <ToolMessage tone="error">{current.error}</ToolMessage>}
      {current?.list && current.list.asns.length === 0 && <ToolMessage>{t('tools.asn.empty')}</ToolMessage>}
      {current?.list && current.list.asns.length > 0 && (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-left text-sm" data-testid="asn-table">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                <tr>
                  <th className="w-8 px-2 py-2" />
                  <th className="px-4 py-2">{t('tools.asn.network')}</th>
                  <th className="px-4 py-2 text-right">{t('tools.asn.alerts')}</th>
                  <th className="px-4 py-2 text-right">{t('tools.asn.ips')}</th>
                  <th className="px-4 py-2">{t('tools.asn.countries')}</th>
                  <th className="px-4 py-2">{t('tools.asn.scenarios')}</th>
                  <th className="px-4 py-2">{t('tools.asn.lastSeen')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {rows.map((entry) => {
                  const expanded = open === entry.asn;
                  return (
                    <Fragment key={entry.asn}>
                      <tr>
                        <td className="px-2 py-2">
                          <button type="button" onClick={() => setOpen(expanded ? null : entry.asn)} aria-expanded={expanded} aria-label={t('tools.asn.toggle', { asn: entry.asn })} className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700">
                            {expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
                          </button>
                        </td>
                        <td className="px-4 py-2"><span className="font-mono text-gray-500">AS{entry.asn}</span> <span className="font-medium text-gray-900 dark:text-gray-100">{entry.name ?? t('tools.asn.unnamed')}</span></td>
                        <td className="px-4 py-2 text-right tabular-nums">{entry.alerts}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{entry.unique_ips}</td>
                        <td className="px-4 py-2"><span className="inline-flex gap-1">{entry.countries.map((country) => <CountryFlag key={country.code} code={country.code} />)}</span></td>
                        <td className="max-w-xs truncate px-4 py-2" title={entry.scenarios.map((scenario) => scenario.name).join(', ')}>{entry.scenarios.map((scenario) => scenario.name).join(', ')}</td>
                        <td className="whitespace-nowrap px-4 py-2">{formatDateTime(entry.last_seen)}</td>
                      </tr>
                      {expanded && (
                        <tr><td colSpan={7} className="p-0"><AsnDetailPanel asn={entry.asn} days={days} canBan={canBan} onBanRange={(range, name) => setBan({ range, reason: `AS${entry.asn}${name ? ` ${name}` : ''}` })} /></td></tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 0 && <p className="px-4 py-3 text-sm text-gray-500">{t('tools.asn.noMatch')}</p>}
          </CardContent>
        </Card>
      )}
      {current?.list && current.list.unknown_alerts > 0 && <p className="text-xs text-gray-500 dark:text-gray-400">{t('tools.asn.unknown', { count: current.list.unknown_alerts })}</p>}

      {ban && (
        <AddDecisionModal
          initialDecision={{ ip: ban.range, duration: '24h', reason: ban.reason }}
          instances={instances}
          multipleInstances={instances.length > 1}
          defaultAllInstances
          onClose={() => setBan(null)}
          onDecisionAdded={async () => { setBan(null); }}
        />
      )}
    </ToolPage>
  );
}
