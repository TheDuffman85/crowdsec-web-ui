import type { Hono } from 'hono';
import type { DashboardAuth } from '../app-auth';
import type { CrowdsecDatabase } from '../database';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const IP_LIMIT = 200;

export interface AsnSummary {
  asn: string;
  name: string | null;
  alerts: number;
  unique_ips: number;
  last_seen: string;
  countries: Array<{ code: string; count: number }>;
  scenarios: Array<{ name: string; count: number }>;
  ranges: Array<{ range: string; count: number }>;
}

export interface AsnIp {
  ip: string;
  alerts: number;
  last_seen: string;
  country: string | null;
  scenarios: string[];
  banned_now: boolean;
}

export interface AsnDetail {
  asn: string;
  name: string | null;
  alerts: number;
  unique_ips: number;
  ips: AsnIp[];
  ranges: Array<{ range: string; count: number }>;
  scenarios: Array<{ name: string; count: number }>;
  truncated: boolean;
}

/** Plain AS numbers only. "0" is how CrowdSec reports an unknown AS. */
export function normalizeAsn(value: string | undefined): string | null {
  const text = (value ?? '').trim().replace(/^as/i, '');
  return /^[1-9]\d{0,9}$/.test(text) ? text : null;
}

const since = (days: number, now: number) => new Date(now - days * 86_400_000).toISOString();

function topBy<T extends { count: number }>(rows: T[], limit: number): T[] {
  return [...rows].sort((a, b) => b.count - a.count).slice(0, limit);
}

/** Attackers grouped by the network that announces them, busiest first. */
export function listAsns(database: CrowdsecDatabase, options: { days?: number; limit?: number; now?: number } = {}): { asns: AsnSummary[]; unknown_alerts: number; days: number } {
  const days = options.days ?? DEFAULT_DAYS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const from = since(days, options.now ?? Date.now());
  const rows = database.db.query(`
    SELECT source_as_number AS asn, MAX(as_name) AS name, COUNT(*) AS alerts, COUNT(DISTINCT source_ip) AS unique_ips, MAX(created_at) AS last_seen
    FROM alerts
    WHERE simulated = 0 AND created_at >= ? AND source_as_number IS NOT NULL AND source_as_number NOT IN ('', '0')
    GROUP BY source_as_number ORDER BY alerts DESC, asn LIMIT ?
  `).all(from, limit) as Array<Omit<AsnSummary, 'countries' | 'scenarios' | 'ranges'>>;
  const unknown = (database.db.query(`
    SELECT COUNT(*) AS count FROM alerts WHERE simulated = 0 AND created_at >= ? AND (source_as_number IS NULL OR source_as_number IN ('', '0'))
  `).get(from) as { count: number }).count;

  const summaries: AsnSummary[] = rows.map((row) => ({ ...row, countries: [], scenarios: [], ranges: [] }));
  if (summaries.length > 0) {
    const byAsn = new Map(summaries.map((summary) => [summary.asn, summary]));
    const marks = summaries.map(() => '?').join(',');
    const params = [from, ...summaries.map((summary) => summary.asn)];
    const group = (column: string) => database.db.query(`
      SELECT source_as_number AS asn, ${column} AS value, COUNT(*) AS count FROM alerts
      WHERE simulated = 0 AND created_at >= ? AND source_as_number IN (${marks}) AND ${column} IS NOT NULL AND ${column} <> ''
      GROUP BY source_as_number, ${column}
    `).all(...params) as Array<{ asn: string; value: string; count: number }>;
    const collect = <K extends 'countries' | 'scenarios' | 'ranges'>(column: string, key: K, shape: (value: string, count: number) => AsnSummary[K][number], take: number) => {
      const grouped = new Map<string, Array<AsnSummary[K][number] & { count: number }>>();
      for (const row of group(column)) {
        const list = grouped.get(row.asn) ?? [];
        list.push(shape(row.value, row.count) as AsnSummary[K][number] & { count: number });
        grouped.set(row.asn, list);
      }
      for (const [asn, list] of grouped) (byAsn.get(asn)![key] as unknown[]) = topBy(list, take);
    };
    collect('country', 'countries', (code, count) => ({ code, count }), 3);
    collect('scenario', 'scenarios', (name, count) => ({ name, count }), 3);
    collect('source_range', 'ranges', (range, count) => ({ range, count }), 5);
  }
  return { asns: summaries, unknown_alerts: unknown, days };
}

/** The addresses behind one AS number, with what they did and whether they are banned right now. */
export function asnDetail(database: CrowdsecDatabase, asn: string, options: { days?: number; now?: number } = {}): AsnDetail | null {
  const now = options.now ?? Date.now();
  const from = since(options.days ?? DEFAULT_DAYS, now);
  const totals = database.db.query(`
    SELECT MAX(as_name) AS name, COUNT(*) AS alerts, COUNT(DISTINCT source_ip) AS unique_ips
    FROM alerts WHERE simulated = 0 AND created_at >= ? AND source_as_number = ?
  `).get(from, asn) as { name: string | null; alerts: number; unique_ips: number };
  if (totals.alerts === 0) return null;

  const ipRows = database.db.query(`
    SELECT source_ip AS ip, COUNT(*) AS alerts, MAX(created_at) AS last_seen, MAX(country) AS country
    FROM alerts WHERE simulated = 0 AND created_at >= ? AND source_as_number = ? AND source_ip IS NOT NULL AND source_ip <> ''
    GROUP BY source_ip ORDER BY alerts DESC, ip LIMIT ?
  `).all(from, asn, IP_LIMIT) as Array<{ ip: string; alerts: number; last_seen: string; country: string | null }>;
  const scenarioRows = database.db.query(`
    SELECT source_ip AS ip, scenario, COUNT(*) AS count FROM alerts
    WHERE simulated = 0 AND created_at >= ? AND source_as_number = ? AND scenario IS NOT NULL AND scenario <> ''
    GROUP BY source_ip, scenario
  `).all(from, asn) as Array<{ ip: string; scenario: string; count: number }>;
  const rangeRows = database.db.query(`
    SELECT source_range AS range, COUNT(*) AS count FROM alerts
    WHERE simulated = 0 AND created_at >= ? AND source_as_number = ? AND source_range IS NOT NULL AND source_range <> ''
    GROUP BY source_range ORDER BY count DESC, range LIMIT 20
  `).all(from, asn) as Array<{ range: string; count: number }>;
  const banned = new Set((database.db.query(`
    SELECT DISTINCT value FROM decisions WHERE stop_at > ? AND simulated = 0 AND value IN (SELECT source_ip FROM alerts WHERE source_as_number = ? AND created_at >= ?)
  `).all(new Date(now).toISOString(), asn, from) as Array<{ value: string }>).map((row) => row.value));

  const perIp = new Map<string, Array<{ name: string; count: number }>>();
  const perScenario = new Map<string, number>();
  for (const row of scenarioRows) {
    perIp.set(row.ip, [...(perIp.get(row.ip) ?? []), { name: row.scenario, count: row.count }]);
    perScenario.set(row.scenario, (perScenario.get(row.scenario) ?? 0) + row.count);
  }
  return {
    asn,
    name: totals.name,
    alerts: totals.alerts,
    unique_ips: totals.unique_ips,
    ips: ipRows.map((row) => ({
      ...row,
      scenarios: topBy(perIp.get(row.ip) ?? [], 3).map((entry) => entry.name),
      banned_now: banned.has(row.ip),
    })),
    ranges: rangeRows,
    scenarios: topBy([...perScenario].map(([name, count]) => ({ name, count })), 5),
    truncated: totals.unique_ips > ipRows.length,
  };
}

const intParam = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
};

export function registerAsnRoutes(options: { app: Hono; basePath: string; database: CrowdsecDatabase; auth: DashboardAuth }): void {
  const { app, basePath, database, auth } = options;

  app.get(`${basePath}/api/asn`, auth.ensureAuth, (context) => {
    const days = intParam(context.req.query('days'), DEFAULT_DAYS, 1, MAX_DAYS);
    const limit = intParam(context.req.query('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
    return context.json(listAsns(database, { days, limit }));
  });

  app.get(`${basePath}/api/asn/:asn`, auth.ensureAuth, (context) => {
    const asn = normalizeAsn(context.req.param('asn'));
    if (!asn) return context.json({ error: 'A valid AS number is required' }, 400);
    const detail = asnDetail(database, asn, { days: intParam(context.req.query('days'), DEFAULT_DAYS, 1, MAX_DAYS) });
    if (!detail) return context.json({ error: 'No alerts from this AS in the selected period' }, 404);
    return context.json(detail);
  });
}
