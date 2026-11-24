import type { Hono } from 'hono';
import type { DashboardAuth } from '../app-auth';
import type { CrowdsecDatabase } from '../database';

export interface BlocklistEntry {
  /** Blocklist name; for the community list this is its scenario. */
  name: string;
  active: number;
  total: number;
  unique_values: number;
}

export interface DecisionOrigin {
  origin: string;
  kind: 'community' | 'subscribed' | 'local';
  active: number;
  total: number;
  unique_values: number;
  /** Per-list breakdown for community and subscribed lists. */
  lists: BlocklistEntry[];
}

export interface BlocklistOverview {
  origins: DecisionOrigin[];
  /** Subscribing to or removing a blocklist is not possible through the Local API. */
  manageable: false;
}

const LIST_LIMIT = 100;

export function classifyOrigin(origin: string): DecisionOrigin['kind'] {
  const lower = origin.toLowerCase();
  if (lower === 'capi') return 'community';
  if (lower === 'lists' || lower.startsWith('lists:')) return 'subscribed';
  return 'local';
}

interface Row {
  origin: string | null;
  scenario: string | null;
  total: number;
  active: number;
  unique_values: number;
}

/**
 * Summarises where decisions come from. CrowdSec lets the Local API read and
 * add decisions but not subscribe to blocklists (that is done in the CrowdSec
 * Console or with its Service API), so this view is read-only.
 */
export function summarizeBlocklists(database: CrowdsecDatabase, now = Date.now()): BlocklistOverview {
  const rows = database.db.query(`
    SELECT COALESCE(NULLIF(origin, ''), 'unknown') AS origin, scenario,
      COUNT(*) AS total, SUM(stop_at > ?) AS active, COUNT(DISTINCT value) AS unique_values
    FROM decisions WHERE simulated = 0
    GROUP BY COALESCE(NULLIF(origin, ''), 'unknown'), scenario
  `).all(new Date(now).toISOString()) as Row[];

  const byOrigin = new Map<string, DecisionOrigin>();
  for (const row of rows) {
    const origin = row.origin ?? 'unknown';
    const kind = classifyOrigin(origin);
    const entry = byOrigin.get(origin) ?? { origin, kind, active: 0, total: 0, unique_values: 0, lists: [] };
    entry.active += row.active;
    entry.total += row.total;
    // Different scenarios can share a value, so this is an upper bound across scenarios.
    entry.unique_values += row.unique_values;
    if (kind !== 'local') {
      const listed = origin.toLowerCase().startsWith('lists:') ? origin.slice('lists:'.length) : row.scenario;
      entry.lists.push({ name: listed || origin, active: row.active, total: row.total, unique_values: row.unique_values });
    }
    byOrigin.set(origin, entry);
  }

  const kindOrder = { community: 0, subscribed: 1, local: 2 } as const;
  const origins = [...byOrigin.values()]
    .map((entry) => ({ ...entry, lists: entry.lists.sort((a, b) => b.active - a.active || a.name.localeCompare(b.name)).slice(0, LIST_LIMIT) }))
    .sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || b.active - a.active || a.origin.localeCompare(b.origin));
  return { origins, manageable: false };
}

export function registerBlocklistRoutes(options: {
  app: Hono;
  basePath: string;
  database: CrowdsecDatabase;
  auth: DashboardAuth;
}): void {
  const { app, basePath, database, auth } = options;
  app.get(`${basePath}/api/blocklists`, auth.ensureAuth, (context) => context.json(summarizeBlocklists(database)));
}
