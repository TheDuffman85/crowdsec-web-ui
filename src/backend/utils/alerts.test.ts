import { describe, expect, test } from 'bun:test';
import { buildMetaSearch, getAlertTarget, toSlimAlert, toSlimDecision } from './alerts';

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
});
