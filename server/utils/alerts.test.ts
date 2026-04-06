import { describe, expect, test } from 'vitest';
import { normalizeMachineId, resolveMachineName } from '../../shared/machine';
import { buildMetaSearch, getAlertSourceValue, getAlertTarget, resolveAlertReason, resolveAlertScenario, toSlimAlert, toSlimDecision } from './alerts';

describe('alert helpers', () => {
  test('getAlertTarget prioritizes event metadata', () => {
    expect(
      getAlertTarget({
        events: [{ meta: [{ key: 'target_fqdn', value: 'example.org' }] }],
        scenario: 'crowdsecurity/ssh-bf',
      }),
    ).toBe('example.org');

    expect(
      getAlertTarget({
        events: [{ meta: [{ key: 'service', value: 'nginx' }] }],
        scenario: 'crowdsecurity/ssh-bf',
      }),
    ).toBe('nginx');

    expect(
      getAlertTarget({
        events: [],
        scenario: 'crowdsecurity/proftpd-bf',
        machine_alias: 'host-a',
      }),
    ).toBe('proftpd');

    expect(
      getAlertTarget({
        events: [],
        machine_alias: 'host-a',
      }),
    ).toBe('host-a');

    expect(
      getAlertTarget({
        events: [],
        machine_id: 'machine-1',
      }),
    ).toBe('machine-1');

    expect(
      getAlertTarget({
        events: [],
        scenario: 'crowdsecurity/-bf',
      }),
    ).toBe('Unknown');
  });

  test('buildMetaSearch excludes context keys and empty values', () => {
    expect(
      buildMetaSearch([
        {
          meta: [
            { key: 'context', value: 'skip' },
            { key: 'service', value: 'ssh' },
            { key: 'scope', value: '' },
          ],
        },
      ]),
    ).toBe('ssh');
  });

  test('getAlertSourceValue falls back from ip to value to range', () => {
    expect(getAlertSourceValue({ ip: '1.2.3.4', value: '9.9.9.9', range: '192.168.5.0/24' })).toBe('1.2.3.4');
    expect(getAlertSourceValue({ value: '9.9.9.9', range: '192.168.5.0/24' })).toBe('9.9.9.9');
    expect(getAlertSourceValue({ range: '192.168.5.0/24' })).toBe('192.168.5.0/24');
    expect(getAlertSourceValue(null)).toBeUndefined();
  });

  test('toSlimDecision and toSlimAlert preserve display fields', () => {
    expect(
      toSlimDecision({
        id: 5,
        type: 'ban',
        value: '1.2.3.4',
        duration: '5m',
        stop_at: '2025-01-01T00:00:00.000Z',
        origin: 'crowdsec',
        expired: true,
      }),
    ).toEqual({
      id: 5,
      type: 'ban',
      value: '1.2.3.4',
      duration: '5m',
      stop_at: '2025-01-01T00:00:00.000Z',
      origin: 'crowdsec',
      expired: true,
      simulated: false,
    });

    const slim = toSlimAlert({
      id: 1,
      created_at: '2025-01-01T00:00:00.000Z',
      scenario: 'crowdsecurity/ssh-bf',
      message: 'hello',
      source: { ip: '1.2.3.4', cn: 'DE' },
      target: 'ssh',
      events: [{ meta: [{ key: 'service', value: 'ssh' }] }],
      decisions: [{ id: 5, type: 'ban', duration: '5m' }],
    });

    expect(slim.meta_search).toBe('ssh');
    expect(slim.decisions).toHaveLength(1);
    expect(slim.source?.ip).toBe('1.2.3.4');
    expect(slim.simulated).toBe(false);
  });

  test('resolveAlertScenario prefers source scope for capi alerts', () => {
    expect(resolveAlertScenario({
      id: 1,
      created_at: '2025-01-01T00:00:00.000Z',
      kind: 'capi',
      scenario: 'update : +15000/-0 IPs',
      source: {
        scope: 'crowdsecurity/community-blocklist',
      },
    })).toBe('crowdsecurity/community-blocklist');

    expect(toSlimAlert({
      id: 2,
      created_at: '2025-01-01T00:00:00.000Z',
      kind: 'capi',
      scenario: 'update : +15000/-0 IPs',
      source: {
        scope: 'crowdsecurity/community-blocklist',
      },
      decisions: [],
    }).scenario).toBe('crowdsecurity/community-blocklist');
  });

  test('resolveAlertScenario prefers source scope for update-style blocklist alerts even when kind is missing', () => {
    expect(resolveAlertScenario({
      id: 11,
      created_at: '2025-01-01T00:00:00.000Z',
      scenario: 'update : +15000/-0 IPs',
      source: {
        scope: 'crowdsecurity/community-blocklist',
      },
    })).toBe('crowdsecurity/community-blocklist');

    expect(toSlimAlert({
      id: 12,
      created_at: '2025-01-01T00:00:00.000Z',
      scenario: 'update : +15000/-0 IPs',
      source: {
        scope: 'crowdsecurity/community-blocklist',
      },
      decisions: [],
    }).scenario).toBe('crowdsecurity/community-blocklist');
  });

  test('resolveAlertReason preserves raw scenario when display scenario is remapped', () => {
    expect(resolveAlertReason({
      id: 3,
      created_at: '2025-01-01T00:00:00.000Z',
      kind: 'capi',
      scenario: 'update : +15000/-0 IPs',
      source: {
        scope: 'crowdsecurity/community-blocklist',
      },
    })).toBe('update : +15000/-0 IPs');

    expect(toSlimAlert({
      id: 4,
      created_at: '2025-01-01T00:00:00.000Z',
      kind: 'capi',
      scenario: 'update : +15000/-0 IPs',
      source: {
        scope: 'crowdsecurity/community-blocklist',
      },
      decisions: [],
    }).reason).toBe('update : +15000/-0 IPs');
  });

  test('machine helpers ignore placeholder values like N/A and Unknown', () => {
    expect(normalizeMachineId('N/A')).toBeUndefined();
    expect(normalizeMachineId(' unknown ')).toBeUndefined();
    expect(resolveMachineName({ machine_id: 'N/A' })).toBeUndefined();
    expect(resolveMachineName({ machine_alias: 'Unknown', machine_id: 'machine-1' })).toBe('machine-1');
    expect(resolveMachineName({ machine_alias: 'localhost', machine_id: 'N/A' })).toBe('localhost');
  });

});
