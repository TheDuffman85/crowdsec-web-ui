export const DEFAULT_LOAD_TEST_BLOCKLIST_DECISIONS = 100_000;

export function normalizeLoadTestBlocklistDecisionCount(
  alertCount: number,
  decisionCount: number,
  requestedCount: number,
): number {
  if (alertCount <= 0 || decisionCount <= 0) return 0;
  return Math.min(decisionCount, Math.max(0, requestedCount));
}

export function getLoadTestSourceAlertIdForDecision(
  decisionId: number,
  alertCount: number,
  decisionCount: number,
  blocklistDecisionCount: number,
): number | null {
  if (decisionId < 1 || decisionId > decisionCount || alertCount <= 0) return null;
  const concentratedCount = normalizeLoadTestBlocklistDecisionCount(
    alertCount,
    decisionCount,
    blocklistDecisionCount,
  );
  if (decisionId <= concentratedCount) return 1;

  const regularAlertStart = concentratedCount > 0 ? 2 : 1;
  const regularAlertCount = alertCount - regularAlertStart + 1;
  if (regularAlertCount <= 0) return concentratedCount > 0 ? 1 : null;
  return regularAlertStart + ((decisionId - concentratedCount - 1) % regularAlertCount);
}

export function* getLoadTestDecisionIdsForAlert(
  alertId: number,
  alertCount: number,
  decisionCount: number,
  blocklistDecisionCount: number,
): Generator<number> {
  if (alertId < 1 || alertId > alertCount || decisionCount <= 0) return;
  const concentratedCount = normalizeLoadTestBlocklistDecisionCount(
    alertCount,
    decisionCount,
    blocklistDecisionCount,
  );
  const hasBlocklistAlert = concentratedCount > 0;

  if (hasBlocklistAlert && alertId === 1) {
    const upperBound = alertCount === 1 ? decisionCount : concentratedCount;
    for (let decisionId = 1; decisionId <= upperBound; decisionId += 1) {
      yield decisionId;
    }
    return;
  }

  const regularAlertStart = hasBlocklistAlert ? 2 : 1;
  const regularAlertCount = alertCount - regularAlertStart + 1;
  if (regularAlertCount <= 0 || alertId < regularAlertStart) return;
  const firstDecisionId = concentratedCount + 1 + alertId - regularAlertStart;
  for (
    let decisionId = firstDecisionId;
    decisionId <= decisionCount;
    decisionId += regularAlertCount
  ) {
    yield decisionId;
  }
}
