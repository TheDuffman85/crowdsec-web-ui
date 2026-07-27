import type {
  AlertDecision,
  AlertDecisionSummary,
  AlertRecord,
  DecisionListItem,
  SlimAlert,
} from '../../shared/contracts';
import { collectDistinctOrigins } from '../../shared/origin';
import {
  getAlertSourceValue,
  getAlertTargets,
  getAlertTargetSummary,
  resolveAlertHistoryAt,
  resolveAlertReason,
  resolveAlertScenario,
} from '../utils/alerts';
import { parseGoDuration } from '../utils/duration';

export function lookbackHours(duration: string): number {
  const match = duration.match(/^(\d+)([hmd])$/);
  if (!match) return 168;
  const value = Number.parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 'h') return value;
  if (unit === 'd') return value * 24;
  return value / 60;
}

export function parseSimulationBoolean(value: unknown): boolean | null {
  if (value === true || value === false) {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return null;
}

export function matchesSimulationFilter(isSimulated: boolean, filter: string): boolean {
  if (filter === 'simulated') return isSimulated;
  if (filter === 'live') return !isSimulated;
  return true;
}

export function hasSimulationMarker(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.startsWith('(simul)') || normalized.includes('simulated');
}

export function normalizeAlertSimulated(alert: Pick<AlertRecord, 'simulated'> | null | undefined): boolean {
  const explicit = parseSimulationBoolean(alert?.simulated);
  if (explicit !== null) {
    return explicit;
  }

  return false;
}

export function normalizeDecisionSimulated(
  decision: Pick<AlertDecision, 'simulated'> | (AlertDecision & Record<string, unknown>),
  alert?: Pick<AlertRecord, 'simulated'> | null,
): boolean {
  const explicit = parseSimulationBoolean(decision.simulated);
  if (explicit !== null) {
    return explicit;
  }

  if (
    hasSimulationMarker((decision as Record<string, unknown>).type) ||
    hasSimulationMarker((decision as Record<string, unknown>).action) ||
    hasSimulationMarker((decision as Record<string, unknown>).decisions)
  ) {
    return true;
  }

  return normalizeAlertSimulated(alert);
}

export function isAlertSimulated(alert: AlertRecord): boolean {
  if (normalizeAlertSimulated(alert)) {
    return true;
  }

  return Array.isArray(alert.decisions) &&
    alert.decisions.length > 0 &&
    alert.decisions.every((decision) => normalizeDecisionSimulated(decision, alert));
}

export function applySimulationModeToAlert(alert: AlertRecord, simulationsEnabled: boolean): AlertRecord | null {
  const alertWithSimulation: AlertRecord = {
    ...alert,
    decisions: Array.isArray(alert.decisions)
      ? alert.decisions.map((decision) => ({
          ...decision,
          simulated: normalizeDecisionSimulated(decision, alert),
        }))
      : [],
    simulated: isAlertSimulated(alert),
  };

  if (!simulationsEnabled && alertWithSimulation.simulated) {
    return null;
  }

  if (!simulationsEnabled) {
    alertWithSimulation.decisions = (alertWithSimulation.decisions || []).filter((decision) => !decision.simulated);
  }

  return alertWithSimulation;
}

export function toDecisionListItem(
  decision: AlertDecision & Record<string, unknown>,
  includeExpired: boolean,
): DecisionListItem {
  const expired = includeExpired
    ? Boolean(decision.stop_at && new Date(String(decision.stop_at)) < new Date())
    : false;

  return {
    id: decision.id,
    instance_id: typeof decision.instance_id === 'string' ? decision.instance_id : undefined,
    instance_name: typeof decision.instance_name === 'string' ? decision.instance_name : undefined,
    created_at: String(decision.created_at || ''),
    machine: typeof decision.machine === 'string' ? decision.machine : undefined,
    machine_id: typeof decision.machine_id === 'string' ? decision.machine_id : undefined,
    machine_alias: typeof decision.machine_alias === 'string' ? decision.machine_alias : undefined,
    scenario: typeof decision.scenario === 'string' ? decision.scenario : undefined,
    value: typeof decision.value === 'string' ? decision.value : undefined,
    expired,
    is_duplicate: decision.is_duplicate === true,
    simulated: normalizeDecisionSimulated(decision),
    detail: {
      origin: typeof decision.origin === 'string' ? decision.origin : 'manual',
      type: typeof decision.type === 'string' ? decision.type : undefined,
      reason: typeof decision.scenario === 'string' ? decision.scenario : undefined,
      action: typeof decision.type === 'string' ? decision.type : undefined,
      country: typeof decision.country === 'string' ? decision.country : 'Unknown',
      region: typeof decision.region === 'string' ? decision.region : undefined,
      city: typeof decision.city === 'string' ? decision.city : undefined,
      as: typeof decision.as === 'string' ? decision.as : 'Unknown',
      events_count: typeof decision.events_count === 'number' ? decision.events_count : 0,
      duration: typeof decision.duration === 'string' ? decision.duration : 'N/A',
      expiration: typeof decision.stop_at === 'string' ? decision.stop_at : undefined,
      alert_id: decision.alert_id as string | number | undefined,
      target: typeof decision.target === 'string' ? decision.target : null,
      targets: Array.isArray(decision.targets)
        ? decision.targets.filter((target): target is string => typeof target === 'string' && target.trim().length > 0)
        : undefined,
      target_count: typeof decision.target_count === 'number' ? decision.target_count : undefined,
      simulated: normalizeDecisionSimulated(decision),
    },
  };
}

export function markDuplicateDecisions(decisions: DecisionListItem[]): DecisionListItem[] {
  const primaryMap = new Map<string, { id: string | number; expirationMs: number; numericId: number }>();

  for (const decision of decisions) {
    if (decision.expired) continue;
    const key = `${decision.instance_id || 'default'}|${decision.value ?? ''}|${decision.simulated === true ? 'simulated' : 'live'}`;
    const expirationMs = getDecisionExpirationMs(decision);
    const numericId = getNumericDecisionId(decision.id);
    const current = primaryMap.get(key);
    if (
      current === undefined ||
      expirationMs > current.expirationMs ||
      (expirationMs === current.expirationMs && numericId > current.numericId)
    ) {
      primaryMap.set(key, { id: decision.id, expirationMs, numericId });
    }
  }

  return decisions.map((decision) => {
    if (decision.expired) return { ...decision, is_duplicate: false };
    const primaryId = primaryMap.get(`${decision.instance_id || 'default'}|${decision.value ?? ''}|${decision.simulated === true ? 'simulated' : 'live'}`);
    return { ...decision, is_duplicate: String(decision.id) !== String(primaryId?.id) };
  });
}

export function getDecisionExpirationMs(decision: DecisionListItem): number {
  const expiration = decision.detail.expiration ? Date.parse(decision.detail.expiration) : Number.NaN;
  return Number.isFinite(expiration) ? expiration : Number.NEGATIVE_INFINITY;
}

export function getNumericDecisionId(id: string | number): number {
  const value = String(id);
  if (value.startsWith('dup_')) return Number.NEGATIVE_INFINITY;
  const numeric = Number.parseInt(value, 10);
  return Number.isNaN(numeric) ? Number.NEGATIVE_INFINITY : numeric;
}

export function emptyAlertDecisionSummary(): AlertDecisionSummary {
  return {
    origins: [],
    active_count: 0,
    expired_count: 0,
    simulated_active_count: 0,
    simulated_expired_count: 0,
  };
}
