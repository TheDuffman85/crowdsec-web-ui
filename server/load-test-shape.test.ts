import { describe, expect, test } from 'vitest';
import {
  getLoadTestBatchCreatedAtEnd,
  getLoadTestHeadSyncEnd,
  getLoadTestDecisionIdsForAlert,
  getLoadTestSourceAlertIdForDecision,
  normalizeLoadTestBlocklistDecisionCount,
} from '../scripts/load-test-shape';

describe('load-test dataset shape', () => {
  test('concentrates the requested decisions in one blocklist alert and distributes the remainder', () => {
    const decisionsByAlert = Array.from({ length: 4 }, (_, index) =>
      Array.from(getLoadTestDecisionIdsForAlert(index + 1, 4, 10, 4)),
    );

    expect(decisionsByAlert).toEqual([
      [1, 2, 3, 4],
      [5, 8],
      [6, 9],
      [7, 10],
    ]);
    for (const [alertIndex, decisionIds] of decisionsByAlert.entries()) {
      for (const decisionId of decisionIds) {
        expect(getLoadTestSourceAlertIdForDecision(decisionId, 4, 10, 4)).toBe(alertIndex + 1);
      }
    }
  });

  test('clamps the blocklist size and keeps all decisions when only one alert exists', () => {
    expect(normalizeLoadTestBlocklistDecisionCount(1, 3, 100_000)).toBe(3);
    expect(Array.from(getLoadTestDecisionIdsForAlert(1, 1, 3, 100_000))).toEqual([1, 2, 3]);
    expect(normalizeLoadTestBlocklistDecisionCount(0, 3, 100_000)).toBe(0);
  });

  test('generates refresh data only for a current authoritative sync window', () => {
    const now = Date.parse('2026-07-15T13:10:03.853Z');
    const deltaEnd = Date.parse('2026-07-15T13:10:02.116Z');

    expect(getLoadTestHeadSyncEnd(deltaEnd, now, 30_000)).toBe(deltaEnd);
    expect(getLoadTestBatchCreatedAtEnd(deltaEnd, now)).toBe(deltaEnd - 1);
    expect(getLoadTestHeadSyncEnd(now - 60 * 60_000, now, 30_000)).toBeNull();
    expect(getLoadTestHeadSyncEnd(undefined, now, 30_000)).toBeNull();
  });
});
