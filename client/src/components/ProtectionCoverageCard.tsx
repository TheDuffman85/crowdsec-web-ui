import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ShieldAlert } from 'lucide-react';
import { fetchCombinedCrowdsecMetrics, fetchConfig, fetchCrowdsecMetrics } from '../lib/api';
import { fetchHubServers, type HubServer } from '../lib/insightsApi';
import { useI18n } from '../lib/i18n';
import { computeProtectionCoverage, type ProtectionCoverage } from '../lib/protectionCoverage';
import { Badge } from './ui/Badge';
import { Card, CardContent } from './ui/Card';

type CoverageState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ready'; coverage: ProtectionCoverage };

const INSTALLER_LABEL_KEYS = {
  detected: 'components.protectionCoverage.installerDetected',
  pending: 'components.protectionCoverage.installerPending',
  paired: 'components.protectionCoverage.installerPaired',
  error: 'components.protectionCoverage.installerError',
} as const;
const INSTALLER_VARIANTS = { detected: 'secondary', pending: 'warning', paired: 'success', error: 'danger' } as const;

const LEVEL_STYLES = {
  ok: { icon: CheckCircle2, tone: 'text-emerald-600 dark:text-emerald-400', border: 'border-emerald-200 dark:border-emerald-900/60' },
  warning: { icon: AlertTriangle, tone: 'text-amber-600 dark:text-amber-400', border: 'border-amber-200 dark:border-amber-900/60' },
  critical: { icon: ShieldAlert, tone: 'text-red-600 dark:text-red-400', border: 'border-red-200 dark:border-red-900/60' },
} as const;

async function loadMetrics() {
  const config = await fetchConfig();
  const instances = config.instances || [];
  if (instances.length === 0) {
    if (config.metrics_enabled === false) return null;
    return fetchCrowdsecMetrics();
  }
  const scoped = instances.filter((instance) => instance.prometheus.length > 0);
  if (scoped.length === 0) return null;
  const endpointCount = scoped.reduce((sum, instance) => sum + instance.prometheus.length, 0);
  if (endpointCount > 1 || instances.length > 1) {
    return fetchCombinedCrowdsecMetrics(instances.length > 1 ? 'all' : instances[0].id);
  }
  return fetchCrowdsecMetrics(scoped[0].id, scoped[0].prometheus[0].id);
}

/**
 * Dashboard panel that shows whether CrowdSec decisions are enforced by at
 * least one bouncer and whether detection machines are still reporting.
 * Needs a configured Prometheus metrics endpoint; stays hidden without one.
 */
export function ProtectionCoverageCard() {
  const { t } = useI18n();
  const [state, setState] = useState<CoverageState>({ status: 'loading' });
  const [hubServers, setHubServers] = useState<HubServer[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const metrics = await loadMetrics();
        if (cancelled) return;
        setState(metrics ? { status: 'ready', coverage: computeProtectionCoverage(metrics) } : { status: 'unavailable' });
      } catch {
        if (!cancelled) setState({ status: 'unavailable' });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Which machines have a hub installer set up. Failing to read it only hides this part of the card.
  useEffect(() => {
    let cancelled = false;
    fetchHubServers().then((hub) => { if (!cancelled) setHubServers(hub.servers); }).catch(() => { /* The hub page explains the problem. */ });
    return () => { cancelled = true; };
  }, []);

  const coverage = state.status === 'ready' ? state.coverage : null;
  // Machines that only appear in the metrics are also detected, even before they raise an alert.
  const known = new Set(hubServers.map((server) => server.machine ?? server.name));
  const installerRows = [
    ...hubServers,
    ...(coverage?.machines ?? []).filter((machine) => !known.has(machine.name)).map((machine): HubServer => ({
      id: null, name: machine.name, machine: machine.name, status: 'detected', source: null, transport: null, host: null, port: null, ssh_user: null,
      mode: null, host_key_fingerprint: null, last_check_at: null, last_error: null, pending_reload: false, profile: null, apply_profile: false,
      paired_at: null, pairing_expired: false, pairing_expires_at: null,
    })),
  ];
  const pairedCount = installerRows.filter((row) => row.status === 'paired').length;
  const installers = installerRows.length > 0 && (
    <div className={coverage ? 'mt-3 border-t border-gray-200 pt-3 dark:border-gray-700' : ''} data-testid="installer-coverage">
      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('components.protectionCoverage.installers')}</p>
      <p className="text-xs text-gray-500 dark:text-gray-400">{t('components.protectionCoverage.installersSummary', { paired: pairedCount, total: installerRows.length })}</p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {installerRows.map((row) => (
          <li key={row.id ?? `machine:${row.name}`} className="flex items-center gap-1 text-xs text-gray-700 dark:text-gray-300" data-testid="installer-machine" data-status={row.status}>
            <span className="font-medium">{row.name}</span>
            <Badge variant={INSTALLER_VARIANTS[row.status]}>{t(INSTALLER_LABEL_KEYS[row.status])}</Badge>
          </li>
        ))}
      </ul>
      <Link to="/tools/hub" className="mt-2 inline-block text-xs font-medium text-blue-600 hover:underline dark:text-blue-400">{t('components.protectionCoverage.installersLink')}</Link>
    </div>
  );

  if (!coverage) {
    // Without metrics the card only exists to show the installers.
    if (state.status === 'loading' || !installers) return null;
    return (
      <Card className={LEVEL_STYLES.ok.border}>
        <CardContent>
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('components.protectionCoverage.title')}</h3>
          <div className="mt-2" data-testid="protection-coverage" data-level="ok">{installers}</div>
        </CardContent>
      </Card>
    );
  }

  const style = LEVEL_STYLES[coverage.level];
  const Icon = style.icon;
  const headline = coverage.enforcementMissing
    ? t('components.protectionCoverage.noBouncers')
    : coverage.staleMachines.length > 0
      ? t('components.protectionCoverage.silentMachines', { count: coverage.staleMachines.length })
      : coverage.machines.length === 0
        ? t('components.protectionCoverage.noMachines')
        : t('components.protectionCoverage.healthy');

  return (
    <Card className={style.border}>
      <CardContent>
        <div className="flex items-start gap-3" data-testid="protection-coverage" data-level={coverage.level}>
          <Icon className={`mt-0.5 h-6 w-6 shrink-0 ${style.tone}`} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('components.protectionCoverage.title')}</h3>
            <p className={`text-sm font-medium ${style.tone}`}>{headline}</p>
            {coverage.enforcementMissing && (
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                {t('components.protectionCoverage.noBouncersHint', { decisions: coverage.activeDecisions ?? 0 })}
              </p>
            )}
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-gray-500 dark:text-gray-400">{t('components.protectionCoverage.bouncers')}</dt>
                <dd className="font-semibold text-gray-900 dark:text-gray-100">{coverage.bouncers.length}</dd>
              </div>
              <div>
                <dt className="text-gray-500 dark:text-gray-400">{t('components.protectionCoverage.machines')}</dt>
                <dd className="font-semibold text-gray-900 dark:text-gray-100">{coverage.machines.length}</dd>
              </div>
              <div>
                <dt className="text-gray-500 dark:text-gray-400">{t('components.protectionCoverage.silent')}</dt>
                <dd className="font-semibold text-gray-900 dark:text-gray-100">{coverage.staleMachines.length}</dd>
              </div>
            </dl>
            {coverage.staleMachines.length > 0 && (
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                {t('components.protectionCoverage.silentList', { names: coverage.staleMachines.map((machine) => machine.name).join(', ') })}
              </p>
            )}
            {installers}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
