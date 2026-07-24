import type { AlertDecision, AlertEvent, AlertMeta, AlertRecord, AlertSource, SlimAlert, SlimDecision } from '../../shared/contracts';
import { resolveMachineName } from '../../shared/machine';

export interface AlertTargetSummary {
  target: string;
  count: number;
}

export function getAlertTargetSummary(
  alert: Pick<AlertRecord, 'events' | 'scenario' | 'machine_alias' | 'machine_id'> | null | undefined,
): AlertTargetSummary {
  if (!alert) return { target: 'Unknown', count: 1 };

  const targetCounts = new Map<string, number>();
  const events = Array.isArray(alert.events) ? alert.events : [];
  for (const event of events) {
    const metas = Array.isArray(event.meta) ? event.meta : [];
    const target = findMetaValue(metas, 'target_fqdn')
      || findMetaValue(metas, 'target_host')
      || findMetaValue(metas, 'service');
    if (target) {
      targetCounts.set(target, (targetCounts.get(target) || 0) + 1);
    }
  }

  if (targetCounts.size > 0) {
    const [target] = [...targetCounts.entries()]
      .sort((left, right) => right[1] - left[1])[0];
    return { target, count: targetCounts.size };
  }

  if (alert.scenario) {
    const [, scenarioName] = alert.scenario.split('/');
    if (scenarioName) {
      const serviceName = scenarioName.split('-')[0];
      if (serviceName) {
        return { target: serviceName, count: 1 };
      }
    }
  }

  return { target: resolveMachineName(alert) || 'Unknown', count: 1 };
}

export function getAlertTarget(alert: Pick<AlertRecord, 'events' | 'scenario' | 'machine_alias' | 'machine_id'> | null | undefined): string {
  return getAlertTargetSummary(alert).target;
}

export function withAlertTargetSummary<T extends AlertRecord>(alert: T): T {
  const summary = getAlertTargetSummary(alert);
  return {
    ...alert,
    target: summary.target,
    target_count: summary.count,
  };
}

export function buildMetaSearch(events: AlertEvent[] | undefined, alertMeta: AlertMeta[] | undefined = undefined): string {
  const values = new Set<string>();

  const addValue = (value: AlertMeta['value']) => {
    if (value == null) return;
    const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
    const normalized = serialized?.trim();
    if (normalized) values.add(normalized);
  };

  for (const event of events || []) {
    for (const meta of event.meta || []) {
      if (meta.key !== 'context') addValue(meta.value);
    }
  }

  for (const meta of alertMeta || []) addValue(meta.value);

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

export function resolveAlertHistoryAt(alert: Pick<AlertRecord, 'created_at' | 'start_at'>): string {
  if (typeof alert.start_at === 'string' && Number.isFinite(Date.parse(alert.start_at))) {
    return alert.start_at;
  }

  return alert.created_at;
}

export function toSlimAlert(alert: AlertRecord): SlimAlert {
  return {
    id: alert.id,
    instance_id: alert.instance_id,
    instance_name: alert.instance_name,
    created_at: resolveAlertHistoryAt(alert),
    scenario: resolveAlertScenario(alert),
    reason: resolveAlertReason(alert),
    message: typeof alert.message === 'string' ? alert.message : undefined,
    events_count: typeof alert.events_count === 'number' ? alert.events_count : undefined,
    machine_id: alert.machine_id,
    machine_alias: alert.machine_alias,
    source: alert.source || null,
    target: alert.target,
    target_count: typeof alert.target_count === 'number' ? alert.target_count : undefined,
    meta_search: typeof alert.meta_search === 'string' ? alert.meta_search : buildMetaSearch(alert.events, alert.meta),
    decisions: (alert.decisions || []).map(toSlimDecision),
    simulated: alert.simulated === true,
  };
}

function findMetaValue(metas: AlertMeta[], key: string): string | undefined {
  const value = metas.find((meta) => meta.key === key)?.value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}
