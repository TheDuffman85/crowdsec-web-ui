import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import type { DashboardAuth } from '../app-auth';
import type { CrowdsecDatabase } from '../database';
import { escalateDuration } from '../../shared/escalation';
import { parseDurationMs } from '../../shared/duration';
import { checkOffender } from './repeat-offenders';
import { isPrivateAddress } from './ip-intel';

const MAX_RULES = 20;
const MAX_ACTIONS_PER_RUN = 25;
const MAX_CANDIDATES_PER_RULE = 100;
const LOG_LIMIT = 50;
const MAX_WINDOW_MINUTES = 7 * 24 * 60;
const MAX_BAN_MS = 3650 * 86_400_000;

export interface AutoBanRule {
  id: string;
  name: string;
  /** Matches scenarios containing this text (case-insensitive); `*` matches every scenario. */
  scenario: string;
  /** Alerts from one address within the window needed to trigger. */
  min_alerts: number;
  window_minutes: number;
  /** Ban length, `<number><s|m|h|d>`. */
  duration: string;
  /** Double the ban for every earlier ban of the same address. */
  escalate: boolean;
}

export interface AutoBanSettings {
  enabled: boolean;
  /** While true, matches are only logged and nothing is banned. */
  dry_run: boolean;
  rules: AutoBanRule[];
}

export type AutoBanAction = 'would_ban' | 'banned' | 'skipped_allowlisted' | 'failed';

export interface AutoBanLogEntry {
  id: number;
  at: string;
  rule_id: string;
  rule_name: string;
  ip: string;
  action: AutoBanAction;
  duration: string | null;
  alerts: number;
  detail: string | null;
}

export const DEFAULT_AUTO_BAN_SETTINGS: AutoBanSettings = { enabled: false, dry_run: true, rules: [] };

export function validateAutoBanSettings(input: unknown): { settings: AutoBanSettings } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Settings must be an object' };
  const body = input as Record<string, unknown>;
  if (typeof body.enabled !== 'boolean') return { error: 'enabled must be true or false' };
  if (typeof body.dry_run !== 'boolean') return { error: 'dry_run must be true or false' };
  if (!Array.isArray(body.rules)) return { error: 'rules must be a list' };
  if (body.rules.length > MAX_RULES) return { error: `At most ${MAX_RULES} rules are allowed` };
  const rules: AutoBanRule[] = [];
  for (const [index, raw] of body.rules.entries()) {
    const label = `Rule ${index + 1}`;
    if (!raw || typeof raw !== 'object') return { error: `${label} is not valid` };
    const rule = raw as Record<string, unknown>;
    const name = typeof rule.name === 'string' ? rule.name.trim() : '';
    if (!name || name.length > 60) return { error: `${label}: name must be 1-60 characters` };
    const scenario = typeof rule.scenario === 'string' ? rule.scenario.trim() : '';
    if (!scenario || scenario.length > 100) return { error: `${label}: scenario must be 1-100 characters` };
    if (!Number.isInteger(rule.min_alerts) || (rule.min_alerts as number) < 2 || (rule.min_alerts as number) > 1000) {
      return { error: `${label}: min_alerts must be a whole number from 2 to 1000` };
    }
    if (!Number.isInteger(rule.window_minutes) || (rule.window_minutes as number) < 1 || (rule.window_minutes as number) > MAX_WINDOW_MINUTES) {
      return { error: `${label}: window_minutes must be a whole number from 1 to ${MAX_WINDOW_MINUTES}` };
    }
    const duration = typeof rule.duration === 'string' ? rule.duration.trim() : '';
    const durationMs = /^\d+[smhd]$/.test(duration) ? parseDurationMs(duration) : null;
    if (durationMs === null || durationMs <= 0 || durationMs > MAX_BAN_MS) return { error: `${label}: duration must look like 4h, 30m or 7d` };
    if (typeof rule.escalate !== 'boolean') return { error: `${label}: escalate must be true or false` };
    const id = typeof rule.id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(rule.id) ? rule.id : randomUUID();
    if (rules.some((existing) => existing.id === id)) return { error: `${label}: duplicate rule id` };
    rules.push({ id, name, scenario, min_alerts: rule.min_alerts as number, window_minutes: rule.window_minutes as number, duration, escalate: rule.escalate });
  }
  return { settings: { enabled: body.enabled, dry_run: body.dry_run, rules } };
}

export function loadAutoBanSettings(database: CrowdsecDatabase): AutoBanSettings {
  const row = database.db.query('SELECT value FROM auto_ban_settings WHERE id = 1').get() as { value: string } | null;
  if (!row) return { ...DEFAULT_AUTO_BAN_SETTINGS, rules: [] };
  try {
    const result = validateAutoBanSettings(JSON.parse(row.value));
    if ('settings' in result) return result.settings;
  } catch { /* Fall through to the safe default. */ }
  return { ...DEFAULT_AUTO_BAN_SETTINGS, rules: [] };
}

export function saveAutoBanSettings(database: CrowdsecDatabase, settings: AutoBanSettings): void {
  database.db.query('INSERT INTO auto_ban_settings (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value').run(JSON.stringify(settings));
}

export function listAutoBanLog(database: CrowdsecDatabase, limit = LOG_LIMIT): AutoBanLogEntry[] {
  return database.db.query('SELECT id, at, rule_id, rule_name, ip, action, duration, alerts, detail FROM auto_ban_log ORDER BY id DESC LIMIT ?').all(limit) as AutoBanLogEntry[];
}

export interface AutoBanCandidate {
  ip: string;
  alerts: number;
  duration: string;
  previous_bans: number;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Addresses that currently match a rule and are not already banned. */
export function findCandidates(database: CrowdsecDatabase, rule: AutoBanRule, now: number): AutoBanCandidate[] {
  const since = new Date(now - rule.window_minutes * 60_000).toISOString();
  const pattern = rule.scenario === '*' ? '%' : `%${escapeLike(rule.scenario.toLowerCase())}%`;
  const rows = database.db.query(`
    SELECT source_ip AS ip, COUNT(*) AS alerts FROM alerts
    WHERE simulated = 0 AND created_at >= ? AND source_ip IS NOT NULL AND source_ip <> ''
      AND LOWER(COALESCE(scenario, '')) LIKE ? ESCAPE '\\'
    GROUP BY source_ip HAVING COUNT(*) >= ?
    ORDER BY alerts DESC, ip LIMIT ${MAX_CANDIDATES_PER_RULE}
  `).all(since, pattern, rule.min_alerts) as Array<{ ip: string; alerts: number }>;
  const nowIso = new Date(now).toISOString();
  const banned = database.db.query(`SELECT 1 FROM decisions WHERE value = ? AND simulated = 0 AND type = 'ban' AND stop_at > ? LIMIT 1`);
  const candidates: AutoBanCandidate[] = [];
  for (const row of rows) {
    if (isIP(row.ip) === 0 || isPrivateAddress(row.ip) || banned.get(row.ip, nowIso)) continue;
    const history = rule.escalate ? checkOffender(database, row.ip, { now }) : null;
    const previous = history?.episodes ?? 0;
    candidates.push({ ip: row.ip, alerts: row.alerts, previous_bans: previous, duration: rule.escalate ? escalateDuration(previous, rule.duration) : rule.duration });
  }
  return candidates;
}

export interface AutoBanDeps {
  database: CrowdsecDatabase;
  /** `null` when the check could not be completed. */
  isAllowlisted: (ip: string) => Promise<boolean | null>;
  addBan: (ip: string, duration: string, reason: string) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

/** Evaluates every rule once. Dry-run only records what would have happened. */
export async function runAutoBan(deps: AutoBanDeps, settingsOverride?: AutoBanSettings): Promise<AutoBanLogEntry[]> {
  const settings = settingsOverride ?? loadAutoBanSettings(deps.database);
  if (!settings.enabled) return [];
  const now = deps.now ? deps.now() : Date.now();
  const written: AutoBanLogEntry[] = [];
  let actions = 0;
  const recent = deps.database.db.query('SELECT 1 FROM auto_ban_log WHERE rule_id = ? AND ip = ? AND at >= ? LIMIT 1');
  const insert = deps.database.db.query(`
    INSERT INTO auto_ban_log (at, rule_id, rule_name, ip, action, duration, alerts, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const record = (rule: AutoBanRule, candidate: AutoBanCandidate, action: AutoBanAction, detail: string | null) => {
    const at = new Date(now).toISOString();
    const result = insert.run(at, rule.id, rule.name, candidate.ip, action, candidate.duration, candidate.alerts, detail) as { lastInsertRowid: number | bigint };
    written.push({ id: Number(result.lastInsertRowid), at, rule_id: rule.id, rule_name: rule.name, ip: candidate.ip, action, duration: candidate.duration, alerts: candidate.alerts, detail });
  };

  for (const rule of settings.rules) {
    for (const candidate of findCandidates(deps.database, rule, now)) {
      if (actions >= MAX_ACTIONS_PER_RUN) return written;
      // One decision per rule and address per window, so a slow sync cannot ban twice and a dry run does not repeat itself.
      if (recent.get(rule.id, candidate.ip, new Date(now - rule.window_minutes * 60_000).toISOString())) continue;
      actions += 1;
      if (settings.dry_run) {
        record(rule, candidate, 'would_ban', null);
        deps.log?.(`[auto-ban] Dry run: rule "${rule.name}" would ban ${candidate.ip} for ${candidate.duration} (${candidate.alerts} alerts).`);
        continue;
      }
      const allowlisted = await deps.isAllowlisted(candidate.ip);
      if (allowlisted === null) {
        record(rule, candidate, 'failed', 'Allowlist check unavailable; nothing was banned');
        continue;
      }
      if (allowlisted) {
        record(rule, candidate, 'skipped_allowlisted', 'Address is allowlisted');
        continue;
      }
      try {
        await deps.addBan(candidate.ip, candidate.duration, `auto-ban: ${rule.name}`);
        record(rule, candidate, 'banned', null);
        deps.log?.(`[auto-ban] Rule "${rule.name}" banned ${candidate.ip} for ${candidate.duration} (${candidate.alerts} alerts).`);
      } catch (error) {
        record(rule, candidate, 'failed', error instanceof Error ? error.message.slice(0, 200) : 'Ban failed');
      }
    }
  }
  return written;
}

export function startAutoBanSchedule(deps: AutoBanDeps, intervalMs = 60_000): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    runAutoBan(deps).catch((error: unknown) => {
      console.error('[auto-ban] Run failed:', error instanceof Error ? error.message : error);
    }).finally(() => { running = false; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export function registerAutoBanRoutes(options: {
  app: Hono;
  basePath: string;
  database: CrowdsecDatabase;
  auth: DashboardAuth;
  writeDatabase: <T>(operation: () => T) => Promise<T>;
  /** Called after the settings were saved, so the schedule can start or stop. */
  onSettingsChanged?: () => void;
}): void {
  const { app, basePath, database, auth, writeDatabase, onSettingsChanged } = options;
  const root = `${basePath}/api/auto-ban`;

  app.get(root, auth.ensureAuth, (context) => context.json({ settings: loadAutoBanSettings(database), log: listAutoBanLog(database) }));

  app.put(root, auth.ensureAuth, async (context) => {
    if (!auth.getPermissions(context).can_manage_settings) return context.json({ error: 'Read-only mode is enabled', code: 'READ_ONLY' }, 403);
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON body' }, 400); }
    const result = validateAutoBanSettings(body);
    if ('error' in result) return context.json({ error: result.error }, 400);
    await writeDatabase(() => saveAutoBanSettings(database, result.settings));
    onSettingsChanged?.();
    console.log(`[auto-ban] Settings updated: ${result.settings.enabled ? (result.settings.dry_run ? 'enabled (dry run)' : 'enabled (live)') : 'disabled'}, ${result.settings.rules.length} rule(s).`);
    return context.json({ settings: result.settings });
  });

  // What the saved rules would match right now, without banning or logging anything.
  app.post(`${root}/preview`, auth.ensureAuth, (context) => {
    const settings = loadAutoBanSettings(database);
    const now = Date.now();
    return context.json({
      rules: settings.rules.map((rule) => ({ rule_id: rule.id, rule_name: rule.name, candidates: findCandidates(database, rule, now) })),
    });
  });
}
