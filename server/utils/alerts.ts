import type { AlertDecision, AlertEvent, AlertMeta, AlertRecord, AlertSource, SlimAlert, SlimDecision } from '../../shared/contracts';
import { resolveMachineName } from '../../shared/machine';

export function getAlertTarget(alert: Pick<AlertRecord, 'events' | 'scenario' | 'machine_alias' | 'machine_id'> | null | undefined): string {
  if (!alert) return 'Unknown';

  const events = Array.isArray(alert.events) ? alert.events : [];
  for (const event of events) {
    const metas = Array.isArray(event.meta) ? event.meta : [];
    const fqdn = findMetaValue(metas, 'target_fqdn');
    if (fqdn) return fqdn;

    const host = findMetaValue(metas, 'target_host');
    if (host) return host;

    const service = findMetaValue(metas, 'service');
    if (service) return service;
  }

  if (alert.scenario) {
    const [, scenarioName] = alert.scenario.split('/');
    if (scenarioName) {
      const serviceName = scenarioName.split('-')[0];
      if (serviceName) {
        return serviceName;
      }
    }
  }

  return resolveMachineName(alert) || 'Unknown';
}

export function buildMetaSearch(events: AlertEvent[] | undefined): string {
  const values = new Set<string>();

  for (const event of events || []) {
    for (const meta of event.meta || []) {
      if (meta.key !== 'context' && meta.value !== '') {
        values.add(String(meta.value));
      }
    }
  }

  return values.size > 0 ? [...values].join(' ') : '';
}

export function toSlimDecision(decision: AlertDecision): SlimDecision {
  return {
    id: decision.id,
    type: typeof decision.type === 'string' ? decision.type : undefined,
    value: typeof decision.value === 'string' ? decision.value : undefined,
    duration: typeof decision.duration === 'string' ? decision.duration : undefined,
    stop_at: typeof decision.stop_at === 'string' ? decision.stop_at : undefined,
    origin: typeof decision.origin === 'string' ? decision.origin : undefined,
    expired: Boolean(decision.expired),
    simulated: decision.simulated === true,
  };
}

export function getAlertSourceValue(source: Pick<AlertSource, 'ip' | 'value' | 'range'> | null | undefined): string | undefined {
  if (!source) return undefined;

  const values = [source.ip, source.value, source.range];
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

export function resolveAlertScenario(alert: AlertRecord): string | undefined {
  const scenario = typeof alert.scenario === 'string' ? alert.scenario : undefined;
  const sourceScope = typeof alert.source?.scope === 'string' ? alert.source.scope : undefined;
  const kind = typeof alert.kind === 'string' ? alert.kind.toLowerCase() : undefined;

  if (sourceScope && (kind === 'capi' || (scenario?.startsWith('update :') && sourceScope.includes('/')))) {
    return sourceScope;
  }

  return scenario;
}

export function resolveAlertReason(alert: AlertRecord): string | undefined {
  const scenario = typeof alert.scenario === 'string' ? alert.scenario : undefined;
  const displayScenario = resolveAlertScenario(alert);

  if (scenario && displayScenario && scenario !== displayScenario) {
    return scenario;
  }

  return typeof alert.reason === 'string' ? alert.reason : undefined;
}

export function toSlimAlert(alert: AlertRecord): SlimAlert {
  return {
    id: alert.id,
    created_at: alert.created_at,
    scenario: resolveAlertScenario(alert),
    reason: resolveAlertReason(alert),
    message: typeof alert.message === 'string' ? alert.message : undefined,
    events_count: typeof alert.events_count === 'number' ? alert.events_count : undefined,
    machine_id: alert.machine_id,
    machine_alias: alert.machine_alias,
    source: alert.source || null,
    target: alert.target,
    meta_search: buildMetaSearch(alert.events),
    decisions: (alert.decisions || []).map(toSlimDecision),
    simulated: alert.simulated === true,
  };
}

function findMetaValue(metas: AlertMeta[], key: string): string | undefined {
  const value = metas.find((meta) => meta.key === key)?.value;
  return typeof value === 'string' ? value : undefined;
}
