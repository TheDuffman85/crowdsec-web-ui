import { describe, expect, test } from 'vitest';
import en from '../../locales/en.json';
import { buildSummaryParts, type SummaryInput } from '../smartSummary';

const t = (key: string, values: Record<string, string | number> = {}) => Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), (en as Record<string, string>)[key] ?? key);
const days = (counts: number[]) => counts.map((count, index) => ({ date: `d${index}`, fullDate: `d${index}`, label: `d${index}`, count }));
const base = (overrides: Partial<SummaryInput> = {}): SummaryInput => ({
  alerts: days([10, 10, 10, 10, 10, 10, 10, 20, 20, 20, 20, 20, 20, 20]), granularity: 'day', totalAlerts: 210,
  topScenarios: [{ label: 'crowdsecurity/ssh-bf', count: 105 }], topCountries: [{ label: 'DE', count: 63, countryCode: 'DE' }],
  topIPs: [{ label: '203.0.113.5', count: 40 }], countryName: (code, fallback) => (code === 'DE' ? 'Germany' : fallback), t, ...overrides,
});
const text = (input: SummaryInput) => buildSummaryParts(input).map((part) => t(part.key, part.values)).join(' ');

describe('smart summary', () => {
  test('describes a rise with the main scenario, country and address', () => {
    expect(text(base())).toBe(
      'Alerts over the last 7 days are up 100% on the period before (140 against 70). crowdsecurity/ssh-bf caused 50% of alerts. Most attacks came from Germany (30%). The busiest address was 203.0.113.5 with 40 alerts.',
    );
  });

  test('describes a fall, a flat week and a first appearance', () => {
    expect(text(base({ alerts: days([20, 20, 20, 20, 20, 20, 20, 10, 10, 10, 10, 10, 10, 10]) }))).toContain('are down 50% on the period before (70 against 140)');
    expect(text(base({ alerts: days(new Array(14).fill(5)) }))).toContain('level with the period before (35)');
    expect(text(base({ alerts: days([0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0]) }))).toContain('3 alerts over the last 7 days, with none in the period before');
    expect(text(base({ alerts: days(new Array(14).fill(0)) }))).toContain('No alerts over the last 7 days or the period before');
  });

  test('uses hours for an hourly range and falls back to a total with too little history', () => {
    expect(text(base({ granularity: 'hour', alerts: days(new Array(48).fill(1).map((value, index) => (index < 24 ? value : value * 2))) }))).toContain('over the last 24 hours are up 100%');
    expect(text(base({ alerts: days([4]), totalAlerts: 4, topScenarios: [], topCountries: [], topIPs: [] }))).toBe('4 alerts in the selected range.');
  });

  test('says so when there are no alerts, and skips lists that add nothing', () => {
    expect(text(base({ totalAlerts: 0 }))).toBe('No alerts in the selected range.');
    const quiet = text(base({ topIPs: [{ label: '203.0.113.5', count: 1 }], topScenarios: [], topCountries: [] }));
    expect(quiet).not.toContain('busiest');
    expect(quiet).not.toContain('caused');
  });

  test('never reports more than 100% and falls back to the country label', () => {
    const result = text(base({ totalAlerts: 10, topScenarios: [{ label: 'x', count: 50 }], topCountries: [{ label: 'Atlantis', count: 5 }] }));
    expect(result).toContain('x caused 100% of alerts');
    expect(result).toContain('Most attacks came from Atlantis (50%)');
  });
});
