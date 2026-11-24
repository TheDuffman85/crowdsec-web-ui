import type { Hono } from 'hono';
import type { DashboardAuth } from '../app-auth';
import type { CrowdsecDatabase } from '../database';

const HOUR_MS = 3_600_000;
const SERIES_DAYS = 14;
const TOP_LIMIT = 10;
const RECENT_LIMIT = 20;
const MAX_MACHINE_LENGTH = 200;

export interface HostSummary {
  machine: string;
  alerts_total: number;
  alerts_24h: number;
  alerts_7d: number;
  last_alert_at: string | null;
}

export interface HostCount {
  name: string;
  count: number;
}

export interface HostDetail extends HostSummary {
  active_decisions: number;
  /** Alerts per UTC day for the last 14 days, oldest first, zero-filled. */
  daily: Array<{ date: string; count: number }>;
  top_scenarios: HostCount[];
  top_sources: HostCount[];
  top_countries: HostCount[];
  top_targets: HostCount[];
  recent_alerts: Array<{ id: number; created_at: string; scenario: string | null; source_ip: string | null; country: string | null; target: string | null }>;
}

const LIVE = "simulated = 0 AND machine IS NOT NULL AND machine <> ''";

export function listHosts(database: CrowdsecDatabase, now = Date.now()): HostSummary[] {
  return database.db.query(`
    SELECT machine, COUNT(*) AS alerts_total,
      SUM(created_at >= ?) AS alerts_24h, SUM(created_at >= ?) AS alerts_7d, MAX(created_at) AS last_alert_at
    FROM alerts WHERE ${LIVE}
    GROUP BY machine ORDER BY alerts_7d DESC, alerts_total DESC, machine
  `).all(new Date(now - 24 * HOUR_MS).toISOString(), new Date(now - 7 * 24 * HOUR_MS).toISOString()) as HostSummary[];
}

function top(database: CrowdsecDatabase, column: string, machine: string): HostCount[] {
  return database.db.query(`
    SELECT ${column} AS name, COUNT(*) AS count FROM alerts
    WHERE ${LIVE} AND machine = ? AND ${column} IS NOT NULL AND ${column} <> ''
    GROUP BY ${column} ORDER BY count DESC, name LIMIT ${TOP_LIMIT}
  `).all(machine) as HostCount[];
}

export function hostDetail(database: CrowdsecDatabase, machine: string, now = Date.now()): HostDetail | null {
  const summary = listHosts(database, now).find((host) => host.machine === machine);
  if (!summary) return null;

  const firstDay = new Date(now - (SERIES_DAYS - 1) * 24 * HOUR_MS);
  firstDay.setUTCHours(0, 0, 0, 0);
  const counts = new Map((database.db.query(`
    SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count FROM alerts
    WHERE ${LIVE} AND machine = ? AND created_at >= ? GROUP BY day
  `).all(machine, firstDay.toISOString()) as Array<{ day: string; count: number }>).map((row) => [row.day, row.count]));
  const daily = Array.from({ length: SERIES_DAYS }, (_, index) => {
    const date = new Date(firstDay.getTime() + index * 24 * HOUR_MS).toISOString().slice(0, 10);
    return { date, count: counts.get(date) ?? 0 };
  });

  const decisions = database.db.query(`
    SELECT COUNT(*) AS count FROM decisions WHERE simulated = 0 AND machine = ? AND stop_at > ?
  `).get(machine, new Date(now).toISOString()) as { count: number };
  const recent = database.db.query(`
    SELECT id, created_at, scenario, source_ip, country, target FROM alerts
    WHERE ${LIVE} AND machine = ? ORDER BY created_at DESC, id DESC LIMIT ${RECENT_LIMIT}
  `).all(machine) as HostDetail['recent_alerts'];

  return {
    ...summary,
    active_decisions: decisions.count,
    daily,
    top_scenarios: top(database, 'scenario', machine),
    top_sources: top(database, 'source_ip', machine),
    top_countries: top(database, 'country', machine),
    top_targets: top(database, 'target', machine),
    recent_alerts: recent,
  };
}

/** Per-machine drill-down: which detection hosts report the most alerts, and what they see. */
export function registerHostRoutes(options: {
  app: Hono;
  basePath: string;
  database: CrowdsecDatabase;
  auth: DashboardAuth;
}): void {
  const { app, basePath, database, auth } = options;
  app.get(`${basePath}/api/hosts`, auth.ensureAuth, (context) => context.json({ hosts: listHosts(database) }));
  app.get(`${basePath}/api/hosts/detail`, auth.ensureAuth, (context) => {
    const machine = (context.req.query('machine') ?? '').trim();
    if (!machine || machine.length > MAX_MACHINE_LENGTH) return context.json({ error: 'A machine name is required' }, 400);
    const detail = hostDetail(database, machine);
    if (!detail) return context.json({ error: 'Host not found' }, 404);
    return context.json(detail);
  });
}
