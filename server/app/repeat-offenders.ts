import type { Hono } from 'hono';
import type { DashboardAuth } from '../app-auth';
import type { CrowdsecDatabase } from '../database';
import { escalateDuration } from '../../shared/escalation';

export const DEFAULT_MIN_EPISODES = 2;
const MAX_CANDIDATES = 500;
const MAX_RESULTS = 200;
const IP_SCOPE = "(scope IS NULL OR LOWER(scope) = 'ip')";

export interface BanInterval {
  start: number;
  end: number;
  scenario?: string | null;
}

export interface RepeatOffender {
  ip: string;
  /** Separate bans: a new ban that starts after the previous one ended counts as a new episode. */
  episodes: number;
  first_ban_at: string;
  last_ban_end: string;
  banned_now: boolean;
  scenarios: string[];
  country: string | null;
  /** Suggested length for the next ban, doubling with every earlier episode. */
  suggested_duration: string;
}

/** Merges overlapping or touching bans so an extended ban counts once. */
export function countEpisodes(intervals: BanInterval[]): { episodes: number; firstStart: number; lastEnd: number } | null {
  const sorted = intervals.filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end)).sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return null;
  let episodes = 1;
  let currentEnd = sorted[0].end;
  let lastEnd = currentEnd;
  for (const item of sorted.slice(1)) {
    if (item.start > currentEnd) {
      episodes += 1;
      currentEnd = item.end;
    } else {
      currentEnd = Math.max(currentEnd, item.end);
    }
    lastEnd = Math.max(lastEnd, item.end);
  }
  return { episodes, firstStart: sorted[0].start, lastEnd };
}

interface DecisionRow {
  value: string;
  created_at: string;
  stop_at: string;
  scenario: string | null;
  country: string | null;
}

function summarize(ip: string, rows: DecisionRow[], now: number, options: { base?: string; max?: string }): RepeatOffender | null {
  const intervals = rows.map((row) => ({ start: Date.parse(row.created_at), end: Date.parse(row.stop_at), scenario: row.scenario }));
  const result = countEpisodes(intervals);
  if (!result) return null;
  const scenarioCounts = new Map<string, number>();
  for (const row of rows) if (row.scenario) scenarioCounts.set(row.scenario, (scenarioCounts.get(row.scenario) ?? 0) + 1);
  const scenarios = [...scenarioCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([name]) => name);
  return {
    ip,
    episodes: result.episodes,
    first_ban_at: new Date(result.firstStart).toISOString(),
    last_ban_end: new Date(result.lastEnd).toISOString(),
    banned_now: intervals.some((item) => item.start <= now && item.end > now),
    scenarios,
    country: rows.find((row) => row.country)?.country ?? null,
    suggested_duration: escalateDuration(result.episodes, options.base, options.max),
  };
}

function fetchRows(database: CrowdsecDatabase, ips: string[]): Map<string, DecisionRow[]> {
  const grouped = new Map<string, DecisionRow[]>();
  for (let offset = 0; offset < ips.length; offset += 400) {
    const chunk = ips.slice(offset, offset + 400);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = database.db.query(`
      SELECT value, created_at, stop_at, scenario, country FROM decisions
      WHERE simulated = 0 AND type = 'ban' AND ${IP_SCOPE} AND value IN (${placeholders})
    `).all(...chunk) as DecisionRow[];
    for (const row of rows) {
      const list = grouped.get(row.value) ?? [];
      list.push(row);
      grouped.set(row.value, list);
    }
  }
  return grouped;
}

/** Addresses banned in at least `minEpisodes` separate episodes within the retained history. */
export function findRepeatOffenders(
  database: CrowdsecDatabase,
  options: { minEpisodes?: number; limit?: number; now?: number; base?: string; max?: string } = {},
): RepeatOffender[] {
  const minEpisodes = Math.max(2, options.minEpisodes ?? DEFAULT_MIN_EPISODES);
  const limit = Math.min(options.limit ?? 50, MAX_RESULTS);
  const now = options.now ?? Date.now();
  const candidates = database.db.query(`
    SELECT value FROM decisions
    WHERE simulated = 0 AND type = 'ban' AND ${IP_SCOPE} AND value IS NOT NULL
    GROUP BY value HAVING COUNT(*) >= 2
    ORDER BY COUNT(*) DESC, value LIMIT ${MAX_CANDIDATES}
  `).all() as Array<{ value: string }>;
  const grouped = fetchRows(database, candidates.map((row) => row.value));
  const offenders: RepeatOffender[] = [];
  for (const [ip, rows] of grouped) {
    const offender = summarize(ip, rows, now, options);
    if (offender && offender.episodes >= minEpisodes) offenders.push(offender);
  }
  return offenders
    .sort((a, b) => b.episodes - a.episodes || b.last_ban_end.localeCompare(a.last_ban_end) || a.ip.localeCompare(b.ip))
    .slice(0, limit);
}

/** Ban history for one address; null when it was never banned. */
export function checkOffender(
  database: CrowdsecDatabase,
  ip: string,
  options: { now?: number; base?: string; max?: string } = {},
): RepeatOffender | null {
  const rows = fetchRows(database, [ip]).get(ip);
  if (!rows) return null;
  return summarize(ip, rows, options.now ?? Date.now(), options);
}

export function registerRepeatOffenderRoutes(options: {
  app: Hono;
  basePath: string;
  database: CrowdsecDatabase;
  auth: DashboardAuth;
  isValidIpOrRange: (value: string) => boolean;
}): void {
  const { app, basePath, database, auth, isValidIpOrRange } = options;
  const root = `${basePath}/api/repeat-offenders`;

  app.get(root, auth.ensureAuth, (context) => {
    const min = Number.parseInt(context.req.query('min') ?? '', 10);
    const limit = Number.parseInt(context.req.query('limit') ?? '', 10);
    return context.json({
      offenders: findRepeatOffenders(database, {
        ...(Number.isFinite(min) ? { minEpisodes: min } : {}),
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      }),
    });
  });

  app.get(`${root}/check`, auth.ensureAuth, (context) => {
    const ip = (context.req.query('ip') ?? '').trim();
    if (!ip || !isValidIpOrRange(ip) || ip.includes('/')) return context.json({ error: 'A valid IP address is required' }, 400);
    const offender = checkOffender(database, ip);
    return context.json({
      ip,
      previous_bans: offender?.episodes ?? 0,
      repeat_offender: (offender?.episodes ?? 0) >= DEFAULT_MIN_EPISODES,
      offender,
    });
  });
}
