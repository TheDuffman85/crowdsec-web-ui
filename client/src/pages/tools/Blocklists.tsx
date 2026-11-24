import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { ToolMessage, ToolPage } from '../../components/ToolPage';
import { fetchBlocklists, type BlocklistOverview, type DecisionOrigin } from '../../lib/insightsApi';
import { useI18n } from '../../lib/i18n';

const KIND_LABELS: Record<DecisionOrigin['kind'], string> = {
  community: 'tools.blocklists.kindCommunity',
  subscribed: 'tools.blocklists.kindSubscribed',
  local: 'tools.blocklists.kindLocal',
};

/** Where the active decisions come from. Subscribing to lists is only possible in the CrowdSec Console or its Service API. */
export function Blocklists() {
  const { t } = useI18n();
  const [overview, setOverview] = useState<BlocklistOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchBlocklists()
      .then((data) => { if (active) setOverview(data); })
      .catch((loadError: unknown) => { if (active) setError(loadError instanceof Error ? loadError.message : t('tools.blocklists.loadFailed')); });
    return () => { active = false; };
  }, [t]);

  return (
    <ToolPage title={t('tools.blocklists.title')} description={t('tools.blocklists.description')}>
      <ToolMessage>{t('tools.blocklists.readOnly')}</ToolMessage>
      {error && <ToolMessage tone="error">{error}</ToolMessage>}
      {!overview && !error && <p className="text-sm text-gray-500">{t('app.loading')}</p>}
      {overview?.origins.length === 0 && <ToolMessage>{t('tools.blocklists.empty')}</ToolMessage>}
      <div className="space-y-4">
        {overview?.origins.map((origin) => (
          <Card key={origin.origin}>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2">
                <span className="font-mono text-base">{origin.origin}</span>
                <Badge variant={origin.kind === 'local' ? 'secondary' : origin.kind === 'community' ? 'info' : 'success'}>{t(KIND_LABELS[origin.kind])}</Badge>
              </CardTitle>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {t('tools.blocklists.counts', { active: origin.active, unique: origin.unique_values })}
              </span>
            </CardHeader>
            {origin.lists.length > 0 && (
              <CardContent className="p-0">
                <table className="w-full text-left text-sm">
                  <thead className="bg-gray-50 text-xs uppercase text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                    <tr>
                      <th className="px-6 py-2">{t('tools.blocklists.list')}</th>
                      <th className="px-6 py-2 text-right">{t('tools.blocklists.active')}</th>
                      <th className="px-6 py-2 text-right">{t('tools.blocklists.total')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                    {origin.lists.map((list) => (
                      <tr key={list.name}>
                        <td className="px-6 py-2 text-gray-900 dark:text-gray-100">{list.name}</td>
                        <td className="px-6 py-2 text-right tabular-nums">{list.active}</td>
                        <td className="px-6 py-2 text-right tabular-nums">{list.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            )}
          </Card>
        ))}
      </div>
    </ToolPage>
  );
}
