import { describe, expect, test } from 'vitest';
import {
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
});
