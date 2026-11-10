import type { AlertSessionScenarioGroup, AlertSessionTarget } from '../../shared/contracts';
import { isUnspecifiedSourceAddress } from '../../shared/source';

export const ALERT_SESSION_GAP_MS = 30 * 60_000;
export const ALERT_SESSION_SCAN_BATCH_SIZE = 2_000;

// Sessions only keep the alert IDs needed for their decision counts. A larger
// session reports those counts as partial instead of holding every ID in memory.
const MAX_SESSION_ALERT_IDS = 2_000;
export const MAX_SESSION_SCENARIOS_PER_KIND = 25;
const MAX_SESSION_TARGETS = 3;
const NO_SCENARIO_KIND = '';

export type AlertSessionScanRow = {
  id: number;
  instance_id: string;
  created_at: string;
  source_ip: string | null;
  source_scope: string | null;
  simulated: number | boolean | null;
  kind: string | null;
  scenario: string | null;
  target: string | null;
};

export type AlertSessionScan = {
  key: string;
  latestAlertId: number;
  alertCount: number;
  firstSeen: string;
  lastSeen: string;
  alertIds: number[];
  scenarioGroups: AlertSessionScenarioGroup[];
  scenarioCount: number;
  targets: AlertSessionTarget[];
  targetCount: number;
};

type OpenAlertSession = {
  identity: string | null;
  latestAlertId: number;
  alertCount: number;
  firstSeen: string;
  firstSeenMs: number;
  lastSeen: string;
  alertIds: number[];
  scenarios: Map<string, Map<string, number>>;
  targets: Map<string, number>;
};

function getSessionIdentity(row: AlertSessionScanRow): string | null {
  // Placeholder sources stand for many IPs, so they do not identify an attacker.
  if (!row.source_ip || isUnspecifiedSourceAddress(row.source_ip)) return null;
  const scope = row.source_scope?.trim().toLowerCase();
  if (scope && scope !== 'ip' && scope !== 'range') return null;
  return `${row.instance_id}\u0000${row.simulated ? 1 : 0}\u0000${row.source_ip}`;
}

function countByValue(counts: Map<string, number>, value: string): void {
  counts.set(value, (counts.get(value) || 0) + 1);
}

function topCounts(counts: Map<string, number>, limit: number): Array<[string, number]> {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit);
}

/**
 * Builds attack sessions from alerts supplied newest first. A session's newest
 * alert is the first one seen, so sessions are discovered in last-activity order
 * and only the head of that list has to be read to fill a page.
 */
export class AlertSessionWalker {
  private readonly sessions: OpenAlertSession[] = [];
  private readonly latestByIdentity = new Map<string, OpenAlertSession>();
  private complete = 0;

  add(row: AlertSessionScanRow): void {
    const createdAtMs = Date.parse(row.created_at);
    const identity = getSessionIdentity(row);
    let session = identity ? this.latestByIdentity.get(identity) : undefined;
    if (!session || session.firstSeenMs - createdAtMs > ALERT_SESSION_GAP_MS) {
      session = {
        identity,
        latestAlertId: row.id,
        alertCount: 0,
        firstSeen: row.created_at,
        firstSeenMs: createdAtMs,
        lastSeen: row.created_at,
        alertIds: [],
        scenarios: new Map(),
        targets: new Map(),
      };
      this.sessions.push(session);
      if (identity) this.latestByIdentity.set(identity, session);
    }

    session.alertCount += 1;
    session.firstSeen = row.created_at;
    session.firstSeenMs = createdAtMs;
    if (session.alertIds.length < MAX_SESSION_ALERT_IDS) session.alertIds.push(row.id);
    if (row.scenario) {
      const kind = row.kind || NO_SCENARIO_KIND;
      const scenarios = session.scenarios.get(kind) || new Map<string, number>();
      countByValue(scenarios, row.scenario);
      session.scenarios.set(kind, scenarios);
    }
    if (row.target) countByValue(session.targets, row.target);
  }

  /**
   * Marks sessions complete now that every alert newer than `createdAt` has been
   * read. A session is returned only once nothing newer is still open, because a
   * burst that is still growing would otherwise be sorted behind older sessions.
   */
  advanceTo(createdAt: string): void {
    const cursorMs = Date.parse(createdAt);
    while (this.complete < this.sessions.length) {
      const session = this.sessions[this.complete];
      if (session.identity && session.firstSeenMs - cursorMs <= ALERT_SESSION_GAP_MS) break;
      this.complete += 1;
    }
  }

  finish(): void {
    this.complete = this.sessions.length;
  }

  get completeCount(): number {
    return this.complete;
  }

  toScans(): AlertSessionScan[] {
    return this.sessions.slice(0, this.complete).map(toAlertSessionScan);
  }
}

function toAlertSessionScan(session: OpenAlertSession): AlertSessionScan {
  const scenarioGroups = [...session.scenarios.entries()]
    .map(([kind, scenarios]) => ({
      kind: kind === NO_SCENARIO_KIND ? null : kind,
      scenario_count: scenarios.size,
      alert_count: [...scenarios.values()].reduce((total, count) => total + count, 0),
      scenarios: topCounts(scenarios, MAX_SESSION_SCENARIOS_PER_KIND)
        .map(([scenario, count]) => ({ scenario, count })),
    }))
    .sort((left, right) => right.alert_count - left.alert_count);

  return {
    key: `${session.identity ?? `alert\u0000${session.latestAlertId}`}\u0000${session.firstSeen}`,
    latestAlertId: session.latestAlertId,
    alertCount: session.alertCount,
    firstSeen: session.firstSeen,
    lastSeen: session.lastSeen,
    alertIds: session.alertIds,
    scenarioGroups,
    scenarioCount: scenarioGroups.reduce((total, group) => total + group.scenario_count, 0),
    targets: topCounts(session.targets, MAX_SESSION_TARGETS).map(([value, count]) => ({ value, count })),
    targetCount: session.targets.size,
  };
}
