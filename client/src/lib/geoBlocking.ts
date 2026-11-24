import type { GeoBlockingSummary } from './insightsApi';

/** Share of recent alerts that came from the selected countries. */
export function impactOf(summary: GeoBlockingSummary, selected: ReadonlySet<string>) {
  const rows = summary.countries.filter((country) => selected.has(country.code));
  const alerts = rows.reduce((sum, row) => sum + row.alerts, 0);
  return {
    alerts,
    uniqueIps: rows.reduce((sum, row) => sum + row.unique_ips, 0),
    share: summary.total_alerts > 0 ? Math.round((alerts / summary.total_alerts) * 1000) / 10 : 0,
  };
}
