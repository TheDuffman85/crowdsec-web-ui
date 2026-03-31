import { describe, expect, test } from 'vitest';
import type { StatsAlert, StatsDecision } from '../types';
import {
  filterLastNDays,
  getAggregatedData,
  getAllCountries,
  getTopAS,
  getTopCountries,
  getTopIPs,
  getTopScenarios,
  getTopTargets,
} from './stats';

const now = Date.now();

const alerts: StatsAlert[] = [
  {
    created_at: new Date(now).toISOString(),
    scenario: 'crowdsecurity/ssh-bf',
    source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
    target: 'ssh',
  },
  {
    created_at: new Date(now - 60 * 60 * 1000).toISOString(),
    scenario: 'crowdsecurity/ssh-bf',
    source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
    target: 'ssh',
  },
  {
    created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    scenario: 'crowdsecurity/nginx-http-probing',
    source: { ip: '5.6.7.8', value: '5.6.7.8', cn: 'US', as_name: 'AWS' },
    target: 'nginx',
  },
];

const decisions: StatsDecision[] = [
  {
    id: 1,
    created_at: new Date(now).toISOString(),
    scenario: 'crowdsecurity/ssh-bf',
    value: '1.2.3.4',
    stop_at: new Date(now + 60 * 60 * 1000).toISOString(),
    target: 'ssh',
  },
  {
    id: 2,
    created_at: new Date(now - 60 * 60 * 1000).toISOString(),
    scenario: 'crowdsecurity/nginx-http-probing',
    value: '5.6.7.8',
    stop_at: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
    target: 'nginx',
  },
];

describe('stats helpers', () => {
  test('filters and summarizes top entities', () => {
    expect(filterLastNDays([...alerts, { created_at: undefined }], 7)).toHaveLength(3);
    expect(getTopIPs(alerts, 1)).toEqual([{ label: '1.2.3.4', count: 2 }]);
    expect(getTopCountries(alerts, 2)[0]).toMatchObject({ value: 'DE', count: 2, countryCode: 'DE' });
    expect(getAllCountries(alerts)).toHaveLength(2);
    expect(getTopScenarios(alerts, 1)).toEqual([{ label: 'crowdsecurity/ssh-bf', count: 2 }]);
    expect(getTopAS(alerts, 2)).toEqual([
      { label: 'Hetzner', count: 2 },
      { label: 'AWS', count: 1 },
    ]);
    expect(getTopTargets(alerts, 2)).toEqual([
      { label: 'ssh', count: 2 },
      { label: 'nginx', count: 1 },
    ]);
    expect(getTopTargets(decisions, 2)).toEqual([
      { label: 'ssh', count: 1 },
      { label: 'nginx', count: 1 },
    ]);
  });

  test('ignores unknown or missing values in summary helpers', () => {
    const noisyAlerts: StatsAlert[] = [
      ...alerts,
      {
        created_at: new Date(now).toISOString(),
        scenario: 'crowdsecurity/ssh-bf',
        source: { ip: '9.9.9.9', value: '9.9.9.9', cn: 'Unknown', as_name: 'Unknown' },
        target: 'Unknown',
      },
      {
        created_at: new Date(now).toISOString(),
        scenario: 'crowdsecurity/ssh-bf',
        source: null,
        target: undefined,
      } as unknown as StatsAlert,
    ];

    expect(getTopCountries(noisyAlerts, 5).every((item) => item.value !== 'Unknown')).toBe(true);
    expect(getAllCountries(noisyAlerts).every((item) => item.countryCode !== 'Unknown')).toBe(true);
    expect(getTopAS(noisyAlerts, 5).some((item) => item.label === 'Unknown')).toBe(false);
    expect(getTopTargets(noisyAlerts, 5).some((item) => item.label === 'Unknown')).toBe(false);
  });

  test('aggregates daily and hourly data with explicit ranges', () => {
    const daily = getAggregatedData(alerts, 3, 'day');
    expect(daily.at(-1)?.count).toBeGreaterThan(0);

    const explicitDaily = getAggregatedData(alerts, 3, 'day', {
      start: daily[0]?.date || '',
      end: daily.at(-1)?.date || '',
    });
    expect(explicitDaily.length).toBeGreaterThan(0);

    const hourly = getAggregatedData(alerts, 1, 'hour', {
      start: `${new Date(now).getFullYear()}-${String(new Date(now).getMonth() + 1).padStart(2, '0')}-${String(new Date(now).getDate()).padStart(2, '0')}T00`,
      end: `${new Date(now).getFullYear()}-${String(new Date(now).getMonth() + 1).padStart(2, '0')}-${String(new Date(now).getDate()).padStart(2, '0')}T23`,
    });
    expect(hourly).toHaveLength(24);

    const implicitHourly = getAggregatedData(
      [
        ...alerts,
        { created_at: undefined, source: null, target: 'noop' },
        {
          created_at: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
          scenario: 'old',
          source: null,
          target: 'old',
        },
      ],
      1,
      'hour',
    );
    expect(implicitHourly.length).toBeGreaterThan(0);
  });

  test('skips items outside the requested aggregation range', () => {
    const range = getAggregatedData(
      [
        {
          created_at: new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString(),
        },
        {
          created_at: new Date(now).toISOString(),
        },
      ],
      2,
      'day',
    );

    expect(range.at(-1)?.count).toBe(1);
    expect(range.every((item) => item.count >= 0)).toBe(true);
  });
});
