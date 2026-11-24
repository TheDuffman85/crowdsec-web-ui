import type { DashboardStatListItem, DashboardStatsBucket } from '../types';
import { computeTrend } from './trends';

export interface SummaryPart {
  /** Translation key of the sentence template. */
  key: string;
  values: Record<string, string | number>;
}

export interface SummaryInput {
  alerts: DashboardStatsBucket[];
  granularity: 'day' | 'hour';
  totalAlerts: number;
  topScenarios: DashboardStatListItem[];
  topCountries: DashboardStatListItem[];
  topIPs: DashboardStatListItem[];
  countryName: (code: string | undefined, fallback: string) => string;
  t: (key: string, values?: Record<string, string | number>) => string;
}

const share = (count: number, total: number) => Math.min(100, Math.round((count / total) * 100));

/**
 * Builds the sentences of the dashboard summary from numbers already on the
 * page. It is plain template filling: nothing is sent anywhere and the same
 * numbers always give the same text.
 */
export function buildSummaryParts(input: SummaryInput): SummaryPart[] {
  if (input.totalAlerts <= 0) return [{ key: 'components.smartSummary.none', values: {} }];
  const parts: SummaryPart[] = [];

  const trend = computeTrend(input.alerts, input.granularity === 'day' ? 'days' : 'hours');
  if (trend) {
    const values = {
      window: input.t(`components.trendCards.window.${trend.unit}`, { count: trend.windowSize }),
      current: trend.current.toLocaleString(),
      previous: trend.previous.toLocaleString(),
    };
    if (trend.percentChange === null) {
      parts.push({ key: trend.current > 0 ? 'components.smartSummary.activity.new' : 'components.smartSummary.activity.quiet', values });
    } else if (trend.direction === 'flat') {
      parts.push({ key: 'components.smartSummary.activity.flat', values });
    } else {
      parts.push({ key: `components.smartSummary.activity.${trend.direction}`, values: { ...values, percent: Math.abs(trend.percentChange) } });
    }
  } else {
    parts.push({ key: 'components.smartSummary.total', values: { count: input.totalAlerts.toLocaleString() } });
  }

  const scenario = input.topScenarios[0];
  if (scenario && scenario.count > 0) {
    parts.push({ key: 'components.smartSummary.scenario', values: { scenario: scenario.label, share: share(scenario.count, input.totalAlerts) } });
  }
  const country = input.topCountries[0];
  if (country && country.count > 0) {
    parts.push({ key: 'components.smartSummary.country', values: { country: input.countryName(country.countryCode ?? country.sourceCountryCode, country.label), share: share(country.count, input.totalAlerts) } });
  }
  const address = input.topIPs[0];
  if (address && address.count > 1) {
    parts.push({ key: 'components.smartSummary.address', values: { ip: address.label, count: address.count.toLocaleString() } });
  }
  return parts;
}
