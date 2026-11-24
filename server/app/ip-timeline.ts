import { isIP } from 'node:net';
import type { Hono } from 'hono';
import type { DashboardAuth } from '../app-auth';
import type { CrowdsecDatabase } from '../database';
import { queryAuditEvents } from './audit-events';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export type TimelineKind = 'alert' | 'decision' | 'note' | 'audit';

export interface TimelineEvent {
  kind: TimelineKind;
  time: string;
  /** Short machine-readable label: the scenario, decision type, note author or audit action. */
  title: string;
  /** Where it happened, when known. */
  instance: string | null;
  machine: string | null;
  detail: Record<string, string | number | boolean | null>;
}

export interface IpTimeline {
  ip: string;
  events: TimelineEvent[];
  counts: Record<TimelineKind, number>;
  machines: string[];
  instances: string[];
  truncated: boolean;
  /** False for people who may not read the audit log. */
  audit_included: boolean;
}

/** Everything the dashboard knows about one address, merged and ordered newest first. */
export function buildIpTimeline(
  database: CrowdsecDatabase,
  ip: string,
  options: { includeAudit: boolean; limit?: number },
): IpTimeline {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const events: TimelineEvent[] = [];

  const alerts = database.db.query(`
    SELECT id, instance_id, created_at, scenario, machine_id, machine_alias, machine, events_count, simulated, country, as_name
    FROM alerts WHERE source_ip = ? ORDER BY created_at DESC LIMIT ?
  `).all(ip, MAX_LIMIT) as Array<Record<string, any>>;
  for (const row of alerts) {
    events.push({
      kind: 'alert', time: row.created_at, title: row.scenario ?? '', instance: row.instance_id,
      machine: row.machine_alias || row.machine || row.machine_id || null,
      detail: { id: row.id, events: row.events_count ?? 0, simulated: Boolean(row.simulated), country: row.country ?? null, as_name: row.as_name ?? null },
    });
  }

  const decisions = database.db.query(`
    SELECT id, instance_id, alert_id, created_at, stop_at, type, origin, scenario, duration, machine, simulated
    FROM decisions WHERE value = ? ORDER BY created_at DESC LIMIT ?
  `).all(ip, MAX_LIMIT) as Array<Record<string, any>>;
  for (const row of decisions) {
    events.push({
      kind: 'decision', time: row.created_at, title: row.type ?? 'ban', instance: row.instance_id, machine: row.machine || null,
      detail: { id: row.id, alert_id: row.alert_id ?? null, until: row.stop_at, duration: row.duration ?? null, origin: row.origin ?? null, scenario: row.scenario ?? null, simulated: Boolean(row.simulated) },
    });
  }

  const notes = database.db.query(`
    SELECT id, author_name, body, created_at FROM entity_notes WHERE subject_type = 'ip' AND subject = ? ORDER BY created_at DESC LIMIT ?
  `).all(ip, MAX_LIMIT) as Array<Record<string, any>>;
  for (const row of notes) {
    events.push({ kind: 'note', time: row.created_at, title: row.author_name, instance: null, machine: null, detail: { id: row.id, body: row.body } });
  }

  if (options.includeAudit) {
    for (const row of queryAuditEvents(database, { target: ip }, 1, MAX_LIMIT).data) {
      events.push({
        kind: 'audit', time: row.time, title: row.action, instance: null, machine: null,
        detail: { id: row.id, user: row.user, outcome: row.outcome, reason: typeof row.details.reason === 'string' ? row.details.reason : null },
      });
    }
  }

  events.sort((left, right) => (left.time < right.time ? 1 : left.time > right.time ? -1 : 0));
  const counts: Record<TimelineKind, number> = { alert: 0, decision: 0, note: 0, audit: 0 };
  for (const event of events) counts[event.kind] += 1;
  const unique = (values: Array<string | null>) => [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
  return {
    ip,
    events: events.slice(0, limit),
    counts,
    machines: unique(events.map((event) => event.machine)),
    instances: unique(events.map((event) => event.instance)),
    truncated: events.length > limit,
    audit_included: options.includeAudit,
  };
}

export function registerIpTimelineRoutes(options: { app: Hono; basePath: string; database: CrowdsecDatabase; auth: DashboardAuth }): void {
  const { app, basePath, database, auth } = options;
  app.get(`${basePath}/api/ip-timeline`, auth.ensureAuth, (context) => {
    const ip = context.req.query('ip')?.trim().toLowerCase() ?? '';
    if (isIP(ip) === 0) return context.json({ error: 'A valid IP address is required' }, 400);
    const parsed = Number.parseInt(context.req.query('limit') ?? '', 10);
    return context.json(buildIpTimeline(database, ip, {
      includeAudit: auth.getPermissions(context).can_manage_settings,
      limit: Number.isFinite(parsed) ? parsed : undefined,
    }));
  });
}
