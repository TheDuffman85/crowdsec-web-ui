import type { AlertSource } from '../shared/contracts';

export const DEFAULT_LOAD_TEST_BLOCKLIST_DECISIONS = 100_000;

export function isLoadTestListOrigin(origin: string | null | undefined): boolean {
  const normalized = origin?.trim().toLowerCase();
  return normalized === 'capi' || normalized === 'lists';
}

export function withoutLoadTestListAlertAddress(
  source: AlertSource | null | undefined,
  origins: ReadonlyArray<string | null | undefined>,
): AlertSource | null | undefined {
  if (!origins.some(isLoadTestListOrigin)) return source;
  return source?.scope ? { scope: source.scope } : {};
}

export interface LoadTestDecisionLayout {
  alertCount: number;
  decisionCount: number;
  blocklistDecisionCounts: number[];
  emptyAlertCount?: number;
}

export function getLoadTestHeadSyncEnd(
  relativeWindowEndMs: number | null | undefined,
  nowMs: number,
  maxLagMs: number,
): number | null {
  if (!Number.isFinite(relativeWindowEndMs) || !Number.isFinite(nowMs) || !Number.isFinite(maxLagMs)) {
    return null;
  }

  const endMs = relativeWindowEndMs as number;
  if (endMs > nowMs || nowMs - endMs <= Math.max(0, maxLagMs)) {
    return endMs;
  }
  return null;
}

export function getLoadTestBatchCreatedAtEnd(authoritativeEndMs: number, nowMs: number): number {
  return Math.min(nowMs - 1, authoritativeEndMs - 1);
}

export function getLoadTestRefreshDecisionCount(
  alertId: number,
  seed: number,
  minimum: number,
  maximum: number,
): number {
  const normalizedMinimum = Math.max(0, Math.floor(minimum));
  const normalizedMaximum = Math.max(0, Math.floor(maximum));
  if (normalizedMaximum <= 0 || normalizedMaximum < normalizedMinimum) return 0;

  let hash = Math.imul((Math.floor(alertId) + 83) ^ Math.floor(seed), 0x45d9f3b);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x45d9f3b);
  hash ^= hash >>> 16;
  return normalizedMinimum + ((hash >>> 0) % (normalizedMaximum - normalizedMinimum + 1));
}

export function normalizeLoadTestBlocklistDecisionCount(
  alertCount: number,
  decisionCount: number,
  requestedCount: number,
): number {
  if (alertCount <= 0 || decisionCount <= 0) return 0;
  return Math.min(decisionCount, Math.max(0, requestedCount));
}

export function normalizeLoadTestBlocklistDecisionCounts(
  alertCount: number,
  decisionCount: number,
  requestedCounts: number[],
): number[] {
  if (alertCount <= 0 || decisionCount <= 0) return [];
  const result: number[] = [];
  let remaining = decisionCount;
  for (const requested of requestedCounts.slice(0, alertCount)) {
    if (remaining <= 0) break;
    const count = Math.min(remaining, Math.max(0, Math.floor(requested)));
    if (count <= 0) continue;
    result.push(count);
    remaining -= count;
  }
  return result;
}

function resolveDecisionLayout(layout: LoadTestDecisionLayout) {
  const alertCount = Math.max(0, Math.floor(layout.alertCount));
  const decisionCount = Math.max(0, Math.floor(layout.decisionCount));
  const blocklistDecisionCounts = normalizeLoadTestBlocklistDecisionCounts(
    alertCount,
    decisionCount,
    layout.blocklistDecisionCounts,
  );
  let blocklistTotal = blocklistDecisionCounts.reduce((total, count) => total + count, 0);
  const remainingDecisions = Math.max(0, decisionCount - blocklistTotal);
  const regularAlertCapacity = Math.max(0, alertCount - blocklistDecisionCounts.length);
  const requestedEmptyAlerts = Math.max(0, Math.floor(layout.emptyAlertCount || 0));
  const maximumEmptyAlerts = Math.max(0, regularAlertCapacity - (remainingDecisions > 0 ? 1 : 0));
  const emptyAlertCount = Math.min(requestedEmptyAlerts, maximumEmptyAlerts);
  const regularAlertStart = blocklistDecisionCounts.length + 1;
  const regularAlertEnd = alertCount - emptyAlertCount;
  const regularAlertCount = Math.max(0, regularAlertEnd - regularAlertStart + 1);

  if (remainingDecisions > 0 && regularAlertCount === 0 && blocklistDecisionCounts.length > 0) {
    blocklistDecisionCounts[blocklistDecisionCounts.length - 1] += remainingDecisions;
    blocklistTotal += remainingDecisions;
  }

  return {
    alertCount,
    decisionCount,
    blocklistDecisionCounts,
    blocklistTotal,
    emptyAlertCount,
    regularAlertStart,
    regularAlertEnd,
    regularAlertCount,
  };
}

export function* getLoadTestDecisionIdsForAlertLayout(
  alertId: number,
  layout: LoadTestDecisionLayout,
): Generator<number> {
  const resolved = resolveDecisionLayout(layout);
  if (alertId < 1 || alertId > resolved.alertCount || resolved.decisionCount <= 0) return;

  if (alertId <= resolved.blocklistDecisionCounts.length) {
    const start = resolved.blocklistDecisionCounts
      .slice(0, alertId - 1)
      .reduce((total, count) => total + count, 0) + 1;
    const end = start + resolved.blocklistDecisionCounts[alertId - 1] - 1;
    for (let decisionId = start; decisionId <= end; decisionId += 1) yield decisionId;
    return;
  }

  if (alertId < resolved.regularAlertStart || alertId > resolved.regularAlertEnd || resolved.regularAlertCount <= 0) return;
  const firstDecisionId = resolved.blocklistTotal + 1 + alertId - resolved.regularAlertStart;
  for (
    let decisionId = firstDecisionId;
    decisionId <= resolved.decisionCount;
    decisionId += resolved.regularAlertCount
  ) {
    yield decisionId;
  }
}

export function getLoadTestSourceAlertIdForDecisionLayout(
  decisionId: number,
  layout: LoadTestDecisionLayout,
): number | null {
  const resolved = resolveDecisionLayout(layout);
  if (decisionId < 1 || decisionId > resolved.decisionCount || resolved.alertCount <= 0) return null;

  let blocklistEnd = 0;
  for (let index = 0; index < resolved.blocklistDecisionCounts.length; index += 1) {
    blocklistEnd += resolved.blocklistDecisionCounts[index];
    if (decisionId <= blocklistEnd) return index + 1;
  }

  if (resolved.regularAlertCount <= 0) {
    return resolved.blocklistDecisionCounts.length > 0 ? resolved.blocklistDecisionCounts.length : null;
  }
  return resolved.regularAlertStart + ((decisionId - resolved.blocklistTotal - 1) % resolved.regularAlertCount);
}

export function getLoadTestSourceAlertIdForDecision(
  decisionId: number,
  alertCount: number,
  decisionCount: number,
  blocklistDecisionCount: number,
): number | null {
  return getLoadTestSourceAlertIdForDecisionLayout(decisionId, {
    alertCount,
    decisionCount,
    blocklistDecisionCounts: [blocklistDecisionCount],
  });
}

export function* getLoadTestDecisionIdsForAlert(
  alertId: number,
  alertCount: number,
  decisionCount: number,
  blocklistDecisionCount: number,
): Generator<number> {
  yield* getLoadTestDecisionIdsForAlertLayout(alertId, {
    alertCount,
    decisionCount,
    blocklistDecisionCounts: [blocklistDecisionCount],
  });
}
