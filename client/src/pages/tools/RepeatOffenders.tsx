import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Card, CardContent } from '../../components/ui/Card';
import { CountryFlag } from '../../components/CountryFlag';
import { ThreatScoreBadge } from '../../components/ThreatScoreBadge';
import { ToolMessage, ToolPage } from '../../components/ToolPage';
import { fetchRepeatOffenders, fetchThreatScores, type RepeatOffender, type ThreatScore } from '../../lib/insightsApi';
import { useI18n } from '../../lib/i18n';
import { useDateTime } from '../../lib/dateTime';

/** Addresses that were banned, came back and were banned again. */
export function RepeatOffenders() {
  const { t } = useI18n();
  const { formatDateTime } = useDateTime();
  const [offenders, setOffenders] = useState<RepeatOffender[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scores, setScores] = useState<Map<string, ThreatScore>>(new Map());

  useEffect(() => {
    let active = true;
    fetchRepeatOffenders()
      .then(async (data) => {
        if (active) setOffenders(data);
        const batch = data.map((offender) => offender.ip).filter((address) => !address.includes('/')).slice(0, 100);
        const loaded = await fetchThreatScores(batch).catch(() => []);
        if (active) setScores(new Map(loaded.map((score) => [score.ip, score])));
      })
      .catch((loadError: unknown) => { if (active) setError(loadError instanceof Error ? loadError.message : t('tools.offenders.loadFailed')); });
    return () => { active = false; };
  }, [t]);

  return (
    <ToolPage title={t('tools.offenders.title')} description={t('tools.offenders.description')}>
      {error && <ToolMessage tone="error">{error}</ToolMessage>}
      {!offenders && !error && <p className="text-sm text-gray-500">{t('app.loading')}</p>}
      {offenders?.length === 0 && <ToolMessage>{t('tools.offenders.empty')}</ToolMessage>}
      {offenders && offenders.length > 0 && (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                <tr>
                  <th className="px-4 py-2">{t('tools.offenders.address')}</th>
                  <th className="px-4 py-2">{t('components.threatScore.label')}</th>
                  <th className="px-4 py-2 text-right">{t('tools.offenders.bans')}</th>
                  <th className="px-4 py-2">{t('tools.offenders.lastBan')}</th>
                  <th className="px-4 py-2">{t('tools.offenders.scenarios')}</th>
                  <th className="px-4 py-2">{t('tools.offenders.suggested')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {offenders.map((offender) => (
                  <tr key={offender.ip}>
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-2">
                        <CountryFlag code={offender.country} />
                        <Link to={`/alerts?q=${encodeURIComponent(offender.ip)}`} className="font-mono text-primary-700 hover:underline dark:text-primary-400">{offender.ip}</Link>
                        {offender.banned_now && <Badge variant="danger">{t('tools.offenders.bannedNow')}</Badge>}
                      </span>
                    </td>
                    <td className="px-4 py-2"><ThreatScoreBadge score={scores.get(offender.ip) ?? null} /></td>
                    <td className="px-4 py-2 text-right tabular-nums">{offender.episodes}</td>
                    <td className="px-4 py-2 whitespace-nowrap">{formatDateTime(offender.last_ban_end)}</td>
                    <td className="max-w-xs truncate px-4 py-2" title={offender.scenarios.join(', ')}>{offender.scenarios.join(', ')}</td>
                    <td className="px-4 py-2 font-mono">{offender.suggested_duration}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </ToolPage>
  );
}
