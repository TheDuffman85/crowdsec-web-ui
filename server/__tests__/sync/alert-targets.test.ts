import { describe, expect, test } from 'vitest';
import { getAlertTargets, getAlertTargetSummary } from '../../utils/alerts';

describe('getAlertTargets', () => {
  test('guesses the service from the scenario when events carry no target', () => {
    expect(getAlertTargets({ scenario: 'crowdsecurity/ssh-bf', machine_id: 'host-1' })).toEqual(['ssh']);
  });

  test('leaves the target empty for Web UI decisions, even with a stale stored target', () => {
    for (const scenario of ['manual/web-ui', 'beta/blubb']) {
      const alert = {
        scenario,
        message: 'Manual decision from Web UI: abuse report',
        machine_id: 'crowdsec-web-ui',
        targets: ['blubb'],
      };
      expect(getAlertTargets(alert)).toEqual([]);
      expect(getAlertTargetSummary(alert)).toEqual({ target: '', count: 0 });
    }
  });
});
