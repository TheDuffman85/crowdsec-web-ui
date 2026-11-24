import type { Hono } from 'hono';
import type { DashboardAuth } from '../app-auth';
import type { CrowdsecDatabase } from '../database';

const DEFAULT_HOURS = 24 * 7;
const MAX_HOURS = 24 * 90;

export interface GeoCountrySummary {
  code: string;
  alerts: number;
  unique_ips: number;
  /** True when an active Country-scope decision already exists for this code. */
  blocked: boolean;
}

export interface GeoBlockingSummary {
  hours: number;
  total_alerts: number;
  countries: GeoCountrySummary[];
  blocked_countries: string[];
}

/** Recent live alerts per source country, and which countries already have an active Country decision. */
export function summarizeGeoBlocking(database: CrowdsecDatabase, options: { hours?: number; now?: number } = {}): GeoBlockingSummary {
  const hours = Math.min(Math.max(Math.floor(options.hours ?? DEFAULT_HOURS), 1), MAX_HOURS);
  const now = options.now ?? Date.now();
  const since = new Date(now - hours * 3_600_000).toISOString();
  const rows = database.db.query(`
    SELECT UPPER(country) AS code, COUNT(*) AS alerts, COUNT(DISTINCT source_ip) AS unique_ips
    FROM alerts
    WHERE created_at >= ? AND simulated = 0 AND country IS NOT NULL AND country <> ''
    GROUP BY UPPER(country) ORDER BY alerts DESC, code
  `).all(since) as Array<{ code: string; alerts: number; unique_ips: number }>;
  const blockedRows = database.db.query(`
    SELECT DISTINCT UPPER(value) AS code FROM decisions
    WHERE simulated = 0 AND type = 'ban' AND LOWER(scope) = 'country' AND stop_at > ?
  `).all(new Date(now).toISOString()) as Array<{ code: string }>;
  const blocked = new Set(blockedRows.map((row) => row.code));
  const total = database.db.query(`
    SELECT COUNT(*) AS count FROM alerts WHERE created_at >= ? AND simulated = 0
  `).get(since) as { count: number };
  const countries = rows.map((row) => ({ code: row.code, alerts: row.alerts, unique_ips: row.unique_ips, blocked: blocked.has(row.code) }));
  for (const code of blocked) {
    if (!countries.some((country) => country.code === code)) countries.push({ code, alerts: 0, unique_ips: 0, blocked: true });
  }
  return { hours, total_alerts: total.count, countries, blocked_countries: [...blocked].sort() };
}

/**
 * Read side of geo-blocking. Applying a block goes through the existing bulk
 * decision endpoint with `value_scope: "country"`, so permissions, audit
 * logging and multi-instance handling stay in one place.
 */
export function registerGeoBlockingRoutes(options: {
  app: Hono;
  basePath: string;
  database: CrowdsecDatabase;
  auth: DashboardAuth;
}): void {
  const { app, basePath, database, auth } = options;
  app.get(`${basePath}/api/geo-blocking`, auth.ensureAuth, (context) => {
    const hours = Number.parseInt(context.req.query('hours') ?? '', 10);
    return context.json(summarizeGeoBlocking(database, Number.isFinite(hours) ? { hours } : {}));
  });
}
