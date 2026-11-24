import { useState } from 'react';
import { Globe2, Loader2 } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { fetchIpIntel, type IntelSource, type IpIntel } from '../lib/insightsApi';

function Row({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="flex gap-2">
      <dt className="w-32 shrink-0 text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="min-w-0 break-words text-gray-900 dark:text-gray-100">{value}</dd>
    </div>
  );
}

function SourceBlock<T>({ title, source, envName, children }: { title: string; source: IntelSource<T>; envName?: string; children: (data: T) => React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="rounded-md bg-gray-50 p-3 dark:bg-gray-900/50" data-testid={`intel-${title}`}>
      <h5 className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">{title}</h5>
      {source.status === 'ok' && source.data && <dl className="space-y-1 text-sm">{children(source.data)}</dl>}
      {source.status === 'not_found' && <p className="text-sm text-gray-500 dark:text-gray-400">{t('components.ipIntel.notFound')}</p>}
      {source.status === 'not_configured' && (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('components.ipIntel.notConfigured', { name: envName ?? '' })}</p>
      )}
      {source.status === 'error' && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t('components.ipIntel.sourceError', { reason: source.error ?? '' })}</p>
      )}
    </div>
  );
}

/** On-demand reputation lookup; nothing is sent to a third party until the button is pressed. */
export function IpIntelPanel({ ip }: { ip: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<{ status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; intel: IpIntel }>({ status: 'idle' });

  const lookup = async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', intel: await fetchIpIntel(ip) });
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error && error.message ? error.message : t('components.ipIntel.failed') });
    }
  };

  return (
    <section className="rounded-lg border border-gray-200 p-4 dark:border-gray-700" aria-label={t('components.ipIntel.title')} data-testid="ip-intel-panel">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-white">{t('components.ipIntel.title')}</h4>
        <button
          type="button"
          onClick={() => void lookup()}
          disabled={state.status === 'loading'}
          className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          {state.status === 'loading' ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Globe2 size={16} aria-hidden="true" />}
          {state.status === 'ready' ? t('components.ipIntel.refresh') : t('components.ipIntel.lookup')}
        </button>
      </div>
      {state.status === 'idle' && <p className="text-xs text-gray-500 dark:text-gray-400">{t('components.ipIntel.privacy')}</p>}
      {state.status === 'error' && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{state.message}</p>}
      {state.status === 'ready' && (
        <div className="grid gap-3 md:grid-cols-3">
          <SourceBlock title="WHOIS" source={state.intel.whois}>
            {(data) => (
              <>
                <Row label={t('components.ipIntel.network')} value={data.name} />
                <Row label={t('components.ipIntel.range')} value={data.start_address && data.end_address ? `${data.start_address} – ${data.end_address}` : null} />
                <Row label={t('components.ipIntel.country')} value={data.country} />
                <Row label={t('components.ipIntel.registered')} value={data.registered_at ? new Date(data.registered_at).toLocaleDateString() : null} />
              </>
            )}
          </SourceBlock>
          <SourceBlock title="AbuseIPDB" source={state.intel.abuseipdb} envName="ABUSEIPDB_API_KEY">
            {(data) => (
              <>
                <Row label={t('components.ipIntel.abuseScore')} value={`${data.abuse_confidence_score}%`} />
                <Row label={t('components.ipIntel.reports')} value={t('components.ipIntel.reportsValue', { reports: data.total_reports, reporters: data.distinct_reporters })} />
                <Row label={t('components.ipIntel.lastReported')} value={data.last_reported_at ? new Date(data.last_reported_at).toLocaleString() : null} />
                <Row label="ISP" value={data.isp} />
                <Row label={t('components.ipIntel.usage')} value={data.usage_type} />
              </>
            )}
          </SourceBlock>
          <SourceBlock title="Shodan" source={state.intel.shodan} envName="SHODAN_API_KEY">
            {(data) => (
              <>
                <Row label={t('components.ipIntel.ports')} value={data.ports.join(', ')} />
                <Row label={t('components.ipIntel.hostnames')} value={data.hostnames.join(', ')} />
                <Row label={t('components.ipIntel.organization')} value={data.organization} />
                <Row label="OS" value={data.os} />
                <Row label={t('components.ipIntel.vulnerabilities')} value={data.vulnerabilities.join(', ')} />
              </>
            )}
          </SourceBlock>
        </div>
      )}
    </section>
  );
}
