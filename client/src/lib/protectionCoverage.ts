import type { CrowdsecMetricsResponse } from '../types';

/** A machine that has not sent a heartbeat for this long is treated as silent. */
export const STALE_HEARTBEAT_MS = 10 * 60 * 1000;

export type CoverageLevel = 'ok' | 'warning' | 'critical';

export interface CoverageMachine {
  name: string;
  lastHeartbeatAt: string | null;
  stale: boolean;
}

export interface CoverageBouncer {
  name: string;
  mode: string;
  requests: number;
}

export interface ProtectionCoverage {
  level: CoverageLevel;
  bouncers: CoverageBouncer[];
  machines: CoverageMachine[];
  staleMachines: CoverageMachine[];
  /** Decisions exist but nothing is registered to enforce them. */
  enforcementMissing: boolean;
  /** Active decision count from the metrics scrape, when available. */
  activeDecisions: number | null;
}

function isStale(lastHeartbeatAt: string | null | undefined, now: number): boolean {
  if (!lastHeartbeatAt) return false;
  const timestamp = Date.parse(lastHeartbeatAt);
  if (Number.isNaN(timestamp)) return false;
  return now - timestamp > STALE_HEARTBEAT_MS;
}

/**
 * Summarises whether decisions are actually being enforced and whether the
 * machines that detect attacks are still reporting, from one metrics scrape.
 */
export function computeProtectionCoverage(metrics: CrowdsecMetricsResponse, now = Date.now()): ProtectionCoverage {
  const bouncers: CoverageBouncer[] = metrics.bouncers.map((bouncer) => ({
    name: bouncer.name,
    mode: bouncer.mode ?? 'unknown',
    requests: bouncer.requests,
  }));
  const machines: CoverageMachine[] = metrics.machines.map((machine) => ({
    name: machine.name,
    lastHeartbeatAt: machine.lastHeartbeatAt ?? null,
    stale: isStale(machine.lastHeartbeatAt, now),
  }));
  const staleMachines = machines.filter((machine) => machine.stale);
  const activeDecisions = typeof metrics.totals.activeDecisions === 'number' ? metrics.totals.activeDecisions : null;
  const enforcementMissing = bouncers.length === 0;

  let level: CoverageLevel = 'ok';
  if (enforcementMissing) level = 'critical';
  else if (staleMachines.length > 0 || machines.length === 0) level = 'warning';

  return { level, bouncers, machines, staleMachines, enforcementMissing, activeDecisions };
}
