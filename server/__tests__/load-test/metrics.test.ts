import { describe, expect, test } from 'vitest';
import { parsePrometheusText, summarizeCrowdsecMetrics } from '../../metrics';
import { buildLoadTestFleetMetrics } from '../../../scripts/load-test-metrics';

describe('load-test metrics fleet', () => {
  const now = Date.parse('2026-10-30T12:00:00.000Z');

  test('generates deterministic metrics that summarize to the full fleet', () => {
    const options = { bouncers: 40, machines: 45, seed: 1337, now };
    const text = buildLoadTestFleetMetrics(options);
    expect(buildLoadTestFleetMetrics(options)).toBe(text);

    const summary = summarizeCrowdsecMetrics(parsePrometheusText(text));
    expect(summary.bouncers).toHaveLength(40);
    expect(summary.machines).toHaveLength(45);
    expect(new Set(summary.bouncers.map((bouncer) => bouncer.mode))).toEqual(new Set(['stream', 'live', 'mixed']));

    const heartbeatAges = summary.machines.map((machine) => (
      machine.lastHeartbeatAt ? now - Date.parse(machine.lastHeartbeatAt) : null
    ));
    expect(heartbeatAges.filter((age) => age !== null && age < 2 * 60 * 1_000)).toHaveLength(33);
    expect(heartbeatAges.filter((age) => age !== null && age >= 15 * 60 * 1_000)).toHaveLength(8);
    expect(heartbeatAges.filter((age) => age === null)).toHaveLength(4);
    expect(summary.parserSources).toHaveLength(45);
    expect(summary.parserSources.every((source) => source.linesRead !== null)).toBe(true);
    expect(summary.parserNodes).toHaveLength(90);
    expect(summary.parserTimings).toHaveLength(45);
    expect(summary.appsecEngines).toHaveLength(15);
    expect(summary.whitelists).toHaveLength(12);
    expect(summary.scenarios).toHaveLength(30);
  });

  test('generates nothing when the fleet is disabled', () => {
    expect(buildLoadTestFleetMetrics({ bouncers: 0, machines: 0, seed: 1337, now })).toBe('');
  });
});
