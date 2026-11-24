import type { Hono } from 'hono';
import type { DashboardAuth } from '../app-auth';
import type { CrowdsecDatabase } from '../database';
import type { AuditEntry } from '../audit-log';

/** Oldest entries are dropped beyond this, so the table cannot grow without bound. */
export const AUDIT_EVENT_LIMIT = 50_000;
const PRUNE_EVERY = 200;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const REDUNDANT_KEYS = new Set(['time', 'user', 'role', 'action', 'outcome']);

export interface StoredAuditEvent {
  id: number;
  time: string;
  user: string;
  role: string | null;
  action: string;
  outcome: string;
  /** What the action was about: an address, a user, or a short summary of IDs. */
  target: string | null;
  details: Record<string, unknown>;
}

export interface AuditEventFilters {
  user?: string;
  action?: string;
  outcome?: string;
  /** Matches the target or the reason text. */
  q?: string;
  /** Inclusive ISO timestamps. */
  from?: string;
  to?: string;
  /** Exact target, used by the per-address timeline. */
  target?: string;
}

function summarise(values: unknown[], singular: string, plural: string): string | null {
  if (values.length === 0) return null;
  return values.length === 1 ? `${singular} ${String(values[0])}`.trim() : `${values.length} ${plural}`;
}

/** The address, account or entity an audit entry concerns, for filtering and display. */
export function auditTarget(entry: AuditEntry): string | null {
  if (typeof entry.ip === 'string' && entry.ip) return entry.ip;
  if (typeof entry.target_username === 'string' && entry.target_username) return entry.target_username;
  if (typeof entry.push_service === 'string' && entry.push_service) return entry.push_service;
  if (typeof entry.hub_item === 'string' && entry.hub_item) return entry.hub_item;
  if (typeof entry.hub_server === 'string' && entry.hub_server) return entry.hub_server;
  if (Array.isArray(entry.values) && entry.values.length > 0) return summarise(entry.values, '', 'values');
  if (Array.isArray(entry.alert_ids)) return summarise(entry.alert_ids, 'alert', 'alerts');
  if (Array.isArray(entry.decision_ids)) return summarise(entry.decision_ids, 'decision', 'decisions');
  return null;
}

export function insertAuditEvent(database: CrowdsecDatabase, entry: AuditEntry): void {
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!REDUNDANT_KEYS.has(key)) details[key] = value;
  }
  const result = database.db.query(`
    INSERT INTO audit_events (time, user, role, action, outcome, target, details) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(entry.time, entry.user, entry.role ?? null, entry.action, entry.outcome, auditTarget(entry), JSON.stringify(details)) as { lastInsertRowid: number | bigint };
  if (Number(result.lastInsertRowid) % PRUNE_EVERY === 0) {
    database.db.query(`
      DELETE FROM audit_events WHERE id <= (SELECT id FROM audit_events ORDER BY id DESC LIMIT 1 OFFSET ?)
    `).run(AUDIT_EVENT_LIMIT);
  }
}

function like(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function where(filters: AuditEventFilters): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filters.user) { clauses.push('user = ?'); params.push(filters.user); }
  if (filters.action) { clauses.push('action = ?'); params.push(filters.action); }
  if (filters.outcome) { clauses.push('outcome = ?'); params.push(filters.outcome); }
  if (filters.target) { clauses.push('target = ?'); params.push(filters.target); }
  if (filters.from) { clauses.push('time >= ?'); params.push(filters.from); }
  if (filters.to) { clauses.push('time <= ?'); params.push(filters.to); }
  if (filters.q) {
    clauses.push(`(target LIKE ? ESCAPE '\\' OR details LIKE ? ESCAPE '\\')`);
    params.push(like(filters.q), like(filters.q));
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

interface Row {
  id: number; time: string; user: string; role: string | null; action: string; outcome: string; target: string | null; details: string;
}

function parseRow(row: Row): StoredAuditEvent {
  let details: Record<string, unknown> = {};
  try { details = JSON.parse(row.details) as Record<string, unknown>; } catch { /* Keep an empty record. */ }
  return { ...row, details };
}

export function queryAuditEvents(
  database: CrowdsecDatabase,
  filters: AuditEventFilters,
  page: number,
  pageSize: number,
): { data: StoredAuditEvent[]; total: number } {
  const { sql, params } = where(filters);
  const total = (database.db.query(`SELECT COUNT(*) AS count FROM audit_events ${sql}`).get(...params) as { count: number }).count;
  const rows = database.db.query(`
    SELECT id, time, user, role, action, outcome, target, details FROM audit_events ${sql} ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize) as Row[];
  return { data: rows.map(parseRow), total };
}

export function auditFacets(database: CrowdsecDatabase): { users: string[]; actions: string[] } {
  const column = (name: 'user' | 'action') => (database.db.query(`SELECT DISTINCT ${name} AS value FROM audit_events ORDER BY value`).all() as Array<{ value: string }>).map((row) => row.value);
  return { users: column('user'), actions: column('action') };
}

function intParam(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

function dateParam(value: string | undefined, endOfDay: boolean): string | undefined {
  if (!value) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function registerAuditEventRoutes(options: { app: Hono; basePath: string; database: CrowdsecDatabase; auth: DashboardAuth }): void {
  const { app, basePath, database, auth } = options;
  // The log names every user and address, so only people who may manage settings can read it.
  app.get(`${basePath}/api/audit-log`, auth.ensureAuth, (context) => {
    if (!auth.getPermissions(context).can_manage_settings) return context.json({ error: 'Administrator access required', code: 'FORBIDDEN' }, 403);
    const query = (name: string) => context.req.query(name)?.trim() || undefined;
    const filters: AuditEventFilters = {
      user: query('user'), action: query('action'), outcome: query('outcome'), q: query('q')?.slice(0, 200), target: query('target'),
      from: dateParam(query('from'), false), to: dateParam(query('to'), true),
    };
    const page = intParam(query('page'), 1, 1, 100_000);
    const pageSize = intParam(query('page_size'), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const { data, total } = queryAuditEvents(database, filters, page, pageSize);
    return context.json({
      data,
      pagination: { page, page_size: pageSize, total, total_pages: Math.max(1, Math.ceil(total / pageSize)) },
      ...(page === 1 ? auditFacets(database) : {}),
    });
  });
}
