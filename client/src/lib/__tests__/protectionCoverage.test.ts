import { describe, expect, test } from 'vitest';
import type { CrowdsecMetricsResponse } from '../../types';
import { computeProtectionCoverage, STALE_HEARTBEAT_MS } from '../protectionCoverage';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');

function metrics(overrides: Partial<CrowdsecMetricsResponse> = {}): CrowdsecMetricsResponse {
  return {
    fetched_at: '2026-11-20T12:00:00.000Z',
    totals: {
      bouncerRequests: 0, machineRequests: 0, appsecRequests: 0, appsecBlocked: 0,
      parserProcessed: 0, parserOk: 0, parserKo: 0, parserSuccessRate: null, parserAverageSeconds: null,
      whitelistHits: 0, whitelisted: 0, activeDecisions: 12,
    },
    bouncers: [], machines: [], parserSources: [], parserNodes: [], whitelists: [], parserTimings: [],
    ...overrides,
  };
}

const machine = (name: string, lastHeartbeatAt: string | null) => ({ name, requests: 5, topRoute: null, topMethod: null, lastHeartbeatAt });

describe('computeProtectionCoverage', () => {
  test('is critical when nothing enforces decisions', () => {
    const result = computeProtectionCoverage(metrics({ machines: [machine('odin', '2026-11-20T11:59:30.000Z')] }), NOW);
    expect(result.level).toBe('critical');
    expect(result.enforcementMissing).toBe(true);
    expect(result.activeDecisions).toBe(12);
  });

  test('warns about machines whose heartbeat is older than the threshold', () => {
    const stale = new Date(NOW - STALE_HEARTBEAT_MS - 1000).toISOString();
    const fresh = new Date(NOW - 30_000).toISOString();
    const result = computeProtectionCoverage(metrics({
      bouncers: [{ name: 'firewall', requests: 10, topRoute: null, topMethod: null, mode: 'stream' }],
      machines: [machine('thor', stale), machine('odin', fresh)],
    }), NOW);
    expect(result.level).toBe('warning');
    expect(result.staleMachines.map((entry) => entry.name)).toEqual(['thor']);
    expect(result.bouncers[0]).toEqual({ name: 'firewall', mode: 'stream', requests: 10 });
  });

  test('is healthy with a bouncer and fresh machines, and ignores missing or invalid heartbeats', () => {
    const result = computeProtectionCoverage(metrics({
      bouncers: [{ name: 'traefik', requests: 1, topRoute: null, topMethod: null }],
      machines: [machine('odin', null), machine('loki', 'not-a-date'), machine('heimdall', new Date(NOW - 1000).toISOString())],
    }), NOW);
    expect(result.level).toBe('ok');
    expect(result.staleMachines).toEqual([]);
    expect(result.bouncers[0]?.mode).toBe('unknown');
  });

  test('warns when no machine has reported at all', () => {
    const result = computeProtectionCoverage(metrics({
      bouncers: [{ name: 'traefik', requests: 1, topRoute: null, topMethod: null }],
    }), NOW);
    expect(result.level).toBe('warning');
  });
});
