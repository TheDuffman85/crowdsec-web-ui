import { describe, expect, test } from 'vitest';
import {
  getLoadTestBatchCreatedAtEnd,
  getLoadTestHeadSyncEnd,
  getLoadTestDecisionIdsForAlert,
  getLoadTestDecisionIdsForAlertLayout,
  getLoadTestRefreshDecisionCount,
  getLoadTestSourceAlertIdForDecision,
  getLoadTestSourceAlertIdForDecisionLayout,
  isLoadTestListOrigin,
  normalizeLoadTestBlocklistDecisionCount,
  normalizeLoadTestBlocklistDecisionCounts,
  withoutLoadTestListAlertAddress,
} from '../../../scripts/load-test-shape';

describe('load-test dataset shape', () => {
  test('omits parent-alert addresses for CAPI and lists origins', () => {
    const source = {
      scope: 'lists:load-test-blocklist-1',
      value: '45.1.2.3',
      ip: '45.1.2.3',
      cn: 'DE',
      city: 'Berlin',
    };

    expect(isLoadTestListOrigin('CAPI')).toBe(true);
    expect(isLoadTestListOrigin('lists')).toBe(true);
    expect(isLoadTestListOrigin('manual')).toBe(false);
    expect(withoutLoadTestListAlertAddress(source, ['CAPI'])).toEqual({
      scope: 'lists:load-test-blocklist-1',
    });
    expect(withoutLoadTestListAlertAddress(source, ['lists'])).toEqual({
      scope: 'lists:load-test-blocklist-1',
    });
    expect(withoutLoadTestListAlertAddress(source, ['manual'])).toBe(source);
  });

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

  test('supports several blocklists, evenly spreads the remainder, and leaves requested alerts empty', () => {
    const layout = {
      alertCount: 6,
      decisionCount: 14,
      blocklistDecisionCounts: [5, 3],
      emptyAlertCount: 1,
    };
    const decisionsByAlert = Array.from({ length: layout.alertCount }, (_, index) =>
      Array.from(getLoadTestDecisionIdsForAlertLayout(index + 1, layout)),
    );

    expect(decisionsByAlert).toEqual([
      [1, 2, 3, 4, 5],
      [6, 7, 8],
      [9, 12],
      [10, 13],
      [11, 14],
      [],
    ]);
    for (const [alertIndex, decisionIds] of decisionsByAlert.entries()) {
      for (const decisionId of decisionIds) {
        expect(getLoadTestSourceAlertIdForDecisionLayout(decisionId, layout)).toBe(alertIndex + 1);
      }
    }
  });

  test('clamps multiple blocklists to the available decisions', () => {
    expect(normalizeLoadTestBlocklistDecisionCounts(3, 12, [8, 8, 8])).toEqual([8, 4]);
    expect(normalizeLoadTestBlocklistDecisionCounts(0, 12, [8])).toEqual([]);
  });

  test('generates refresh data only for a current authoritative sync window', () => {
    const now = Date.parse('2026-07-15T13:10:03.853Z');
    const deltaEnd = Date.parse('2026-07-15T13:10:02.116Z');

    expect(getLoadTestHeadSyncEnd(deltaEnd, now, 30_000)).toBe(deltaEnd);
    expect(getLoadTestBatchCreatedAtEnd(deltaEnd, now)).toBe(deltaEnd - 1);
    expect(getLoadTestHeadSyncEnd(now - 60 * 60_000, now, 30_000)).toBeNull();
    expect(getLoadTestHeadSyncEnd(undefined, now, 30_000)).toBeNull();
  });

  test('selects deterministic inclusive per-alert decision counts for mixed blocklist deltas', () => {
    expect([31, 32, 33].map((alertId) =>
      getLoadTestRefreshDecisionCount(alertId, 1337, 1_000, 25_000),
    )).toEqual([10_414, 12_829, 14_713]);
    expect(getLoadTestRefreshDecisionCount(31, 1337, 0, 0)).toBe(0);
    expect(getLoadTestRefreshDecisionCount(31, 1337, 25_000, 1_000)).toBe(0);
  });
});
