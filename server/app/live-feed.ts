import type { Hono } from 'hono';
import type { DashboardAuth } from '../app-auth';
import type { CrowdsecDatabase } from '../database';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const HOUR_MS = 3_600_000;

export interface LiveFeedAlert {
  id: number;
  created_at: string;
  scenario: string | null;
  source_ip: string | null;
  country: string | null;
  as_name: string | null;
  latitude: number | null;
  longitude: number | null;
  target: string | null;
  machine: string | null;
}

export interface LiveFeedSnapshot {
  server_time: string;
  alerts: LiveFeedAlert[];
  last_hour: number;
  last_24h: number;
  top_countries: Array<{ name: string; count: number }>;
  top_scenarios: Array<{ name: string; count: number }>;
}

function top(database: CrowdsecDatabase, column: 'country' | 'scenario', since: string): Array<{ name: string; count: number }> {
  return database.db.query(`
    SELECT ${column} AS name, COUNT(*) AS count FROM alerts
    WHERE simulated = 0 AND created_at >= ? AND ${column} IS NOT NULL AND ${column} <> ''
    GROUP BY ${column} ORDER BY count DESC, name LIMIT 5
  `).all(since) as Array<{ name: string; count: number }>;
}

/** Newest live alerts (optionally only those after `since`) plus headline counters for the wallboard. */
export function liveFeedSnapshot(
  database: CrowdsecDatabase,
  options: { since?: string; limit?: number; now?: number } = {},
): LiveFeedSnapshot {
  const now = options.now ?? Date.now();
  const limit = Math.min(Math.max(Math.floor(options.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const hourAgo = new Date(now - HOUR_MS).toISOString();
  const dayAgo = new Date(now - 24 * HOUR_MS).toISOString();
  const alerts = (options.since
    ? database.db.query(`
        SELECT id, created_at, scenario, source_ip, country, as_name, latitude, longitude, target, machine FROM alerts
        WHERE simulated = 0 AND created_at > ? ORDER BY created_at DESC, id DESC LIMIT ?
      `).all(options.since, limit)
    : database.db.query(`
        SELECT id, created_at, scenario, source_ip, country, as_name, latitude, longitude, target, machine FROM alerts
        WHERE simulated = 0 ORDER BY created_at DESC, id DESC LIMIT ?
      `).all(limit)) as LiveFeedAlert[];
  const count = (since: string) => (database.db.query('SELECT COUNT(*) AS count FROM alerts WHERE simulated = 0 AND created_at >= ?').get(since) as { count: number }).count;
  return {
    server_time: new Date(now).toISOString(),
    alerts,
    last_hour: count(hourAgo),
    last_24h: count(dayAgo),
    top_countries: top(database, 'country', dayAgo),
    top_scenarios: top(database, 'scenario', dayAgo),
  };
}

export function registerLiveFeedRoutes(options: {
  app: Hono;
  basePath: string;
  database: CrowdsecDatabase;
  auth: DashboardAuth;
}): void {
  const { app, basePath, database, auth } = options;
  app.get(`${basePath}/api/live-feed`, auth.ensureAuth, (context) => {
    const since = context.req.query('since');
    if (since !== undefined && Number.isNaN(Date.parse(since))) return context.json({ error: 'since must be an ISO timestamp' }, 400);
    const limit = Number.parseInt(context.req.query('limit') ?? '', 10);
    return context.json(liveFeedSnapshot(database, {
      ...(since ? { since: new Date(since).toISOString() } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
    }));
  });
}
