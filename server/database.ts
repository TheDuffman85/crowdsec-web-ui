import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';

type SqliteStatement = {
  run: (...params: any[]) => { changes: number };
  get: (...params: any[]) => unknown;
  all: (...params: any[]) => unknown[];
};

type Database = {
  exec: (sql: string) => void;
  close: () => void;
  prepare: (sql: string) => SqliteStatement;
  transaction: <T extends (...args: any[]) => any>(callback: T) => T;
  query: (sql: string) => SqliteStatement;
};

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface AlertInsertParams {
  $id: string | number;
  $uuid: string;
  $created_at: string;
  $scenario?: string;
  $source_ip?: string;
  $source_cn?: string;
  $source_as_name?: string;
  $source_scope?: string;
  $source_range?: string;
  $target?: string;
  $simulated?: number;
  $machine_id?: string;
  $message: string;
  $raw_data: string;
}

export interface DecisionInsertParams {
  $id: string;
  $uuid: string;
  $alert_id: string | number;
  $created_at: string;
  $stop_at: string;
  $value?: string;
  $type?: string;
  $origin?: string;
  $scenario?: string;
  $target?: string;
  $simulated?: number;
  $raw_data: string;
}

export interface StatsAlertRow {
  created_at: string;
  scenario: string | null;
  source_ip: string | null;
  source_cn: string | null;
  source_as_name: string | null;
  source_scope: string | null;
  source_range: string | null;
  target: string | null;
  simulated: number;
  machine_id: string | null;
}

export interface StatsDecisionRow {
  id: string;
  created_at: string;
  scenario: string | null;
  value: string | null;
  stop_at: string;
  target: string | null;
  simulated: number;
}

export interface DecisionUpdateParams {
  $id: string;
  $stop_at: string;
  $raw_data: string;
}

export interface AlertSearchFilters {
  q?: string;
  ip?: string;
  scenario?: string;
  country?: string;
  as_name?: string;
  target?: string;
  dateStart?: string;
  dateEnd?: string;
  simulated?: boolean;
}

export interface DecisionSearchFilters {
  q?: string;
  ip?: string;
  scenario?: string;
  type?: string;
  origin?: string;
  dateStart?: string;
  dateEnd?: string;
  simulated?: boolean;
}

export interface DashboardStatsFilters {
  country?: string;
  scenario?: string;
  as_name?: string;
  ip?: string;
  target?: string;
  simulated?: boolean;
}

export interface DashboardStatsResult {
  totals: {
    alerts: number;
    decisions: number;
    simulated_alerts: number;
  };
  time_series: {
    granularity: 'hour' | 'day';
    alert_buckets: Array<{ date: string; count: number }>;
    decision_buckets: Array<{ date: string; count: number }>;
    simulated_alert_buckets: Array<{ date: string; count: number }>;
    simulated_decision_buckets: Array<{ date: string; count: number }>;
  };
  top_countries: Array<{ code: string; count: number; simulated_count: number; live_count: number }>;
  top_scenarios: Array<{ name: string; count: number }>;
  top_as: Array<{ name: string; count: number }>;
  top_targets: Array<{ name: string; count: number }>;
  top_ips: Array<{ ip: string; count: number }>;
}

export interface DatabaseOptions {
  dbDir?: string;
  dbPath?: string;
}

type RowWithRawData = { raw_data: string; created_at?: string; stop_at?: string };
type MetaRow = { value: string };
type CountRow = { count: number };
type JsonRow = {
  id: string;
  created_at: string;
  updated_at: string;
  name?: string;
  type?: string;
  enabled?: number;
  config_json?: string;
  severity?: string;
  channel_ids_json?: string;
  rule_id?: string;
  rule_name?: string;
  rule_type?: string;
  title?: string;
  message?: string;
  read_at?: string | null;
  metadata_json?: string;
  deliveries_json?: string;
  dedupe_key?: string;
  incident_key?: string;
  first_seen_at?: string;
  last_seen_at?: string;
  resolved_at?: string | null;
  published_at?: string;
  fetched_at?: string;
};

export class CrowdsecDatabase {
  public readonly db: Database;

  private readonly insertAlertStatement: any;
  private readonly getAlertsStatement: any;
  private readonly getAlertsBetweenStatement: any;
  private readonly countAlertsStatement: any;
  private readonly deleteOldAlertsStatement: any;
  private readonly getAlertStatsSinceStatement: any;
  private readonly getAlertsSincePaginatedStatement: any;
  private readonly countAlertsSinceStatement: any;
  private readonly insertDecisionStatement: any;
  private readonly getDecisionStatsSinceStatement: any;
  private readonly getActiveDecisionsPaginatedStatement: any;
  private readonly countActiveDecisionsStatement: any;
  private readonly updateDecisionStatement: any;
  private readonly getActiveDecisionsStatement: any;
  private readonly getDecisionsSinceStatement: any;
  private readonly deleteOldDecisionsStatement: any;
  private readonly deleteDecisionStatement: any;
  private readonly getDecisionByIdStatement: any;
  private readonly getActiveDecisionByValueStatement: any;
  private readonly deleteAlertStatement: any;
  private readonly deleteDecisionsByAlertIdStatement: any;
  private readonly getMetaStatement: any;
  private readonly setMetaStatement: any;
  private readonly listNotificationChannelsStatement: any;
  private readonly getNotificationChannelByIdStatement: any;
  private readonly upsertNotificationChannelStatement: any;
  private readonly deleteNotificationChannelStatement: any;
  private readonly listNotificationRulesStatement: any;
  private readonly getNotificationRuleByIdStatement: any;
  private readonly upsertNotificationRuleStatement: any;
  private readonly deleteNotificationRuleStatement: any;
  private readonly listNotificationsStatement: any;
  private readonly insertNotificationStatement: any;
  private readonly listNotificationIncidentsByRuleStatement: any;
  private readonly upsertNotificationIncidentStatement: any;
  private readonly resolveNotificationIncidentStatement: any;
  private readonly deleteNotificationIncidentsByRuleStatement: any;
  private readonly markNotificationReadStatement: any;
  private readonly markAllNotificationsReadStatement: any;
  private readonly countUnreadNotificationsStatement: any;
  private readonly getCveCacheEntryStatement: any;
  private readonly upsertCveCacheEntryStatement: any;

  constructor(options: DatabaseOptions = {}) {
    const resolvedPath = resolveDatabasePath(options);
    this.db = openDatabase(resolvedPath);
    initSchema(this.db);

    this.insertAlertStatement = this.db.query(`
      INSERT OR REPLACE INTO alerts (id, uuid, created_at, scenario, source_ip, source_cn, source_as_name, source_scope, source_range, target, simulated, machine_id, message, raw_data)
      VALUES ($id, $uuid, $created_at, $scenario, $source_ip, $source_cn, $source_as_name, $source_scope, $source_range, $target, $simulated, $machine_id, $message, $raw_data)
    `);

    this.getAlertsStatement = this.db.query(`
      SELECT raw_data FROM alerts
      WHERE created_at >= $since
      ORDER BY created_at DESC
    `);
    this.getAlertsBetweenStatement = this.db.query(`
      SELECT raw_data FROM alerts
      WHERE created_at >= $start AND created_at < $end
      ORDER BY created_at DESC
    `);

    this.countAlertsStatement = this.db.query('SELECT COUNT(*) as count FROM alerts');
    this.deleteOldAlertsStatement = this.db.query('DELETE FROM alerts WHERE created_at < $cutoff');

    this.getAlertStatsSinceStatement = this.db.query(`
      SELECT created_at, scenario, source_ip, source_cn, source_as_name, source_scope, source_range, target, simulated, machine_id
      FROM alerts
      WHERE created_at >= $since
      ORDER BY created_at DESC
    `);

    this.getAlertsSincePaginatedStatement = this.db.query(`
      SELECT raw_data FROM alerts
      WHERE created_at >= $since
      ORDER BY created_at DESC
      LIMIT $limit OFFSET $offset
    `);

    this.countAlertsSinceStatement = this.db.query(`
      SELECT COUNT(*) as count FROM alerts
      WHERE created_at >= $since
    `);

    this.insertDecisionStatement = this.db.query(`
      INSERT OR REPLACE INTO decisions (id, uuid, alert_id, created_at, stop_at, value, type, origin, scenario, target, simulated, raw_data)
      VALUES ($id, $uuid, $alert_id, $created_at, $stop_at, $value, $type, $origin, $scenario, $target, $simulated, $raw_data)
    `);

    this.getDecisionStatsSinceStatement = this.db.query(`
      SELECT id, created_at, scenario, value, stop_at, target, simulated
      FROM decisions
      WHERE created_at >= $since OR stop_at > $now
      ORDER BY created_at DESC
    `);

    this.getActiveDecisionsPaginatedStatement = this.db.query(`
      SELECT raw_data, created_at FROM decisions
      WHERE stop_at > $now
      ORDER BY created_at DESC
      LIMIT $limit OFFSET $offset
    `);

    this.countActiveDecisionsStatement = this.db.query(`
      SELECT COUNT(*) as count FROM decisions
      WHERE stop_at > $now
    `);

    this.updateDecisionStatement = this.db.query(`
      UPDATE decisions SET stop_at = $stop_at, raw_data = $raw_data
      WHERE id = $id
    `);

    this.getActiveDecisionsStatement = this.db.query(`
      SELECT raw_data, created_at FROM decisions
      WHERE stop_at > $now
      ORDER BY created_at DESC
    `);

    this.getDecisionsSinceStatement = this.db.query(`
      SELECT raw_data, created_at FROM decisions
      WHERE created_at >= $since OR stop_at > $now
      ORDER BY created_at DESC
    `);

    this.deleteOldDecisionsStatement = this.db.query('DELETE FROM decisions WHERE stop_at < $cutoff');
    this.deleteDecisionStatement = this.db.query('DELETE FROM decisions WHERE id = $id');
    this.getDecisionByIdStatement = this.db.query('SELECT raw_data, stop_at FROM decisions WHERE id = $id');
    this.getActiveDecisionByValueStatement = this.db.query(`
      SELECT raw_data, stop_at FROM decisions
      WHERE value = $value AND stop_at > $now AND id NOT LIKE 'dup_%'
      ORDER BY created_at DESC
      LIMIT 1
    `);
    this.deleteAlertStatement = this.db.query('DELETE FROM alerts WHERE id = $id');
    this.deleteDecisionsByAlertIdStatement = this.db.query('DELETE FROM decisions WHERE alert_id = $alert_id');
    this.getMetaStatement = this.db.query('SELECT value FROM meta WHERE key = ?');
    this.setMetaStatement = this.db.query('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    this.listNotificationChannelsStatement = this.db.query(`
      SELECT id, created_at, updated_at, name, type, enabled, config_json
      FROM notification_channels
      ORDER BY created_at DESC
    `);
    this.getNotificationChannelByIdStatement = this.db.query(`
      SELECT id, created_at, updated_at, name, type, enabled, config_json
      FROM notification_channels
      WHERE id = $id
    `);
    this.upsertNotificationChannelStatement = this.db.query(`
      INSERT OR REPLACE INTO notification_channels (id, created_at, updated_at, name, type, enabled, config_json)
      VALUES ($id, $created_at, $updated_at, $name, $type, $enabled, $config_json)
    `);
    this.deleteNotificationChannelStatement = this.db.query('DELETE FROM notification_channels WHERE id = $id');
    this.listNotificationRulesStatement = this.db.query(`
      SELECT id, created_at, updated_at, name, type, enabled, severity, channel_ids_json, config_json
      FROM notification_rules
      ORDER BY created_at DESC
    `);
    this.getNotificationRuleByIdStatement = this.db.query(`
      SELECT id, created_at, updated_at, name, type, enabled, severity, channel_ids_json, config_json
      FROM notification_rules
      WHERE id = $id
    `);
    this.upsertNotificationRuleStatement = this.db.query(`
      INSERT OR REPLACE INTO notification_rules (
        id, created_at, updated_at, name, type, enabled, severity, channel_ids_json, config_json
      )
      VALUES ($id, $created_at, $updated_at, $name, $type, $enabled, $severity, $channel_ids_json, $config_json)
    `);
    this.deleteNotificationRuleStatement = this.db.query('DELETE FROM notification_rules WHERE id = $id');
    this.listNotificationsStatement = this.db.query(`
      SELECT id, created_at, updated_at, rule_id, rule_name, rule_type, severity, title, message, read_at, metadata_json, deliveries_json, dedupe_key
      FROM notifications
      ORDER BY created_at DESC
      LIMIT $limit
    `);
    this.insertNotificationStatement = this.db.query(`
      INSERT OR IGNORE INTO notifications (
        id, created_at, updated_at, rule_id, rule_name, rule_type, severity, title, message, read_at, metadata_json, deliveries_json, dedupe_key
      )
      VALUES (
        $id, $created_at, $updated_at, $rule_id, $rule_name, $rule_type, $severity, $title, $message, $read_at, $metadata_json, $deliveries_json, $dedupe_key
      )
    `);
    this.listNotificationIncidentsByRuleStatement = this.db.query(`
      SELECT rule_id, incident_key, first_seen_at, last_seen_at, resolved_at
      FROM notification_incidents
      WHERE rule_id = $rule_id
      ORDER BY incident_key ASC
    `);
    this.upsertNotificationIncidentStatement = this.db.query(`
      INSERT OR REPLACE INTO notification_incidents (rule_id, incident_key, first_seen_at, last_seen_at, resolved_at)
      VALUES ($rule_id, $incident_key, $first_seen_at, $last_seen_at, $resolved_at)
    `);
    this.resolveNotificationIncidentStatement = this.db.query(`
      UPDATE notification_incidents
      SET resolved_at = $resolved_at, last_seen_at = $last_seen_at
      WHERE rule_id = $rule_id AND incident_key = $incident_key AND resolved_at IS NULL
    `);
    this.deleteNotificationIncidentsByRuleStatement = this.db.query('DELETE FROM notification_incidents WHERE rule_id = $rule_id');
    this.markNotificationReadStatement = this.db.query('UPDATE notifications SET read_at = $read_at, updated_at = $updated_at WHERE id = $id');
    this.markAllNotificationsReadStatement = this.db.query(`
      UPDATE notifications
      SET read_at = $read_at, updated_at = $updated_at
      WHERE read_at IS NULL
    `);
    this.countUnreadNotificationsStatement = this.db.query('SELECT COUNT(*) as count FROM notifications WHERE read_at IS NULL');
    this.getCveCacheEntryStatement = this.db.query(`
      SELECT id, published_at, fetched_at
      FROM cve_cache
      WHERE id = $id
    `);
    this.upsertCveCacheEntryStatement = this.db.query(`
      INSERT OR REPLACE INTO cve_cache (id, published_at, fetched_at)
      VALUES ($id, $published_at, $fetched_at)
    `);
  }

  close(): void {
    this.db.close();
  }

  clearSyncData(): void {
    this.db.exec('DELETE FROM alerts');
    this.db.exec('DELETE FROM decisions');
  }

  insertAlert(params: AlertInsertParams): void {
    this.insertAlertStatement.run(params);
  }

  getAlertsSince(since: string): RowWithRawData[] {
    return this.getAlertsStatement.all({ $since: since }) as RowWithRawData[];
  }

  getAlertsBetween(start: string, end: string): RowWithRawData[] {
    return this.getAlertsBetweenStatement.all({ $start: start, $end: end }) as RowWithRawData[];
  }

  countAlerts(): number {
    return (this.countAlertsStatement.get() as CountRow).count;
  }

  deleteOldAlerts(cutoff: string): number {
    return this.deleteOldAlertsStatement.run({ $cutoff: cutoff }).changes;
  }

  getAlertStatsSince(since: string): StatsAlertRow[] {
    return this.getAlertStatsSinceStatement.all({ $since: since }) as StatsAlertRow[];
  }

  getDecisionStatsSince(since: string, now: string): StatsDecisionRow[] {
    return this.getDecisionStatsSinceStatement.all({ $since: since, $now: now }) as StatsDecisionRow[];
  }

  getAlertsSincePaginated(since: string, limit: number, offset: number): RowWithRawData[] {
    return this.getAlertsSincePaginatedStatement.all({ $since: since, $limit: limit, $offset: offset }) as RowWithRawData[];
  }

  countAlertsSince(since: string): number {
    return (this.countAlertsSinceStatement.get({ $since: since }) as CountRow).count;
  }

  searchAlertsPaginated(since: string, filters: AlertSearchFilters, limit: number, offset: number): RowWithRawData[] {
    const { sql, params } = this.buildAlertSearchQuery(since, filters, false);
    const stmt = this.db.prepare(`${sql} ORDER BY created_at DESC LIMIT ? OFFSET ?`);
    return stmt.all(...params, limit, offset) as RowWithRawData[];
  }

  countSearchAlerts(since: string, filters: AlertSearchFilters): number {
    const { sql, params } = this.buildAlertSearchQuery(since, filters, true);
    const stmt = this.db.prepare(sql);
    return (stmt.get(...params) as CountRow).count;
  }

  private buildAlertSearchQuery(since: string, filters: AlertSearchFilters, countOnly: boolean): { sql: string; params: unknown[] } {
    const conditions: string[] = ['created_at >= ?'];
    const params: unknown[] = [since];

    if (filters.q) {
      const like = `%${filters.q}%`;
      conditions.push(`(scenario LIKE ? OR source_ip LIKE ? OR source_cn LIKE ? OR source_as_name LIKE ? OR target LIKE ? OR message LIKE ? OR machine_id LIKE ?)`);
      params.push(like, like, like, like, like, like, like);
    }
    if (filters.ip) {
      conditions.push('source_ip LIKE ?');
      params.push(`%${filters.ip}%`);
    }
    if (filters.scenario) {
      conditions.push('scenario LIKE ?');
      params.push(`%${filters.scenario}%`);
    }
    if (filters.country) {
      conditions.push('source_cn LIKE ?');
      params.push(`%${filters.country}%`);
    }
    if (filters.as_name) {
      conditions.push('source_as_name LIKE ?');
      params.push(`%${filters.as_name}%`);
    }
    if (filters.target) {
      conditions.push('target LIKE ?');
      params.push(`%${filters.target}%`);
    }
    if (filters.dateStart) {
      conditions.push('created_at >= ?');
      params.push(filters.dateStart);
    }
    if (filters.dateEnd) {
      conditions.push('created_at <= ?');
      params.push(filters.dateEnd);
    }
    if (filters.simulated !== undefined) {
      conditions.push('simulated = ?');
      params.push(filters.simulated ? 1 : 0);
    }

    const where = conditions.join(' AND ');
    const select = countOnly ? 'SELECT COUNT(*) as count' : 'SELECT raw_data';
    return { sql: `${select} FROM alerts WHERE ${where}`, params };
  }

  getActiveDecisionsPaginated(now: string, limit: number, offset: number): RowWithRawData[] {
    return this.getActiveDecisionsPaginatedStatement.all({ $now: now, $limit: limit, $offset: offset }) as RowWithRawData[];
  }

  countActiveDecisions(now: string): number {
    return (this.countActiveDecisionsStatement.get({ $now: now }) as CountRow).count;
  }

  searchDecisionsPaginated(now: string, filters: DecisionSearchFilters, limit: number, offset: number): RowWithRawData[] {
    const { sql, params } = this.buildDecisionSearchQuery(now, filters, false);
    const stmt = this.db.prepare(`${sql} ORDER BY created_at DESC LIMIT ? OFFSET ?`);
    return stmt.all(...params, limit, offset) as RowWithRawData[];
  }

  countSearchDecisions(now: string, filters: DecisionSearchFilters): number {
    const { sql, params } = this.buildDecisionSearchQuery(now, filters, true);
    const stmt = this.db.prepare(sql);
    return (stmt.get(...params) as CountRow).count;
  }

  private buildDecisionSearchQuery(now: string, filters: DecisionSearchFilters, countOnly: boolean): { sql: string; params: unknown[] } {
    const conditions: string[] = ['stop_at > ?'];
    const params: unknown[] = [now];

    if (filters.q) {
      const like = `%${filters.q}%`;
      conditions.push(`(value LIKE ? OR scenario LIKE ? OR type LIKE ? OR origin LIKE ? OR target LIKE ?)`);
      params.push(like, like, like, like, like);
    }
    if (filters.ip) {
      conditions.push('value LIKE ?');
      params.push(`%${filters.ip}%`);
    }
    if (filters.scenario) {
      conditions.push('scenario LIKE ?');
      params.push(`%${filters.scenario}%`);
    }
    if (filters.type) {
      conditions.push('type LIKE ?');
      params.push(`%${filters.type}%`);
    }
    if (filters.origin) {
      conditions.push('origin LIKE ?');
      params.push(`%${filters.origin}%`);
    }
    if (filters.dateStart) {
      conditions.push('created_at >= ?');
      params.push(filters.dateStart);
    }
    if (filters.dateEnd) {
      conditions.push('created_at <= ?');
      params.push(filters.dateEnd);
    }
    if (filters.simulated !== undefined) {
      conditions.push('simulated = ?');
      params.push(filters.simulated ? 1 : 0);
    }

    const where = conditions.join(' AND ');
    const select = countOnly ? 'SELECT COUNT(*) as count' : 'SELECT raw_data, created_at';
    return { sql: `${select} FROM decisions WHERE ${where}`, params };
  }

  insertDecision(params: DecisionInsertParams): void {
    this.insertDecisionStatement.run(params);
  }

  updateDecision(params: DecisionUpdateParams): void {
    this.updateDecisionStatement.run(params);
  }

  getActiveDecisions(now: string): RowWithRawData[] {
    return this.getActiveDecisionsStatement.all({ $now: now }) as RowWithRawData[];
  }

  getDecisionsSince(since: string, now: string): RowWithRawData[] {
    return this.getDecisionsSinceStatement.all({ $since: since, $now: now }) as RowWithRawData[];
  }

  deleteOldDecisions(cutoff: string): number {
    return this.deleteOldDecisionsStatement.run({ $cutoff: cutoff }).changes;
  }

  deleteDecision(id: string | number): void {
    this.deleteDecisionStatement.run({ $id: String(id) });
  }

  getDecisionById(id: string | number): { raw_data: string; stop_at: string } | null {
    return (this.getDecisionByIdStatement.get({ $id: String(id) }) as { raw_data: string; stop_at: string } | null) || null;
  }

  getDecisionStopAtBatch(ids: string[]): Map<string, string> {
    const result = new Map<string, string>();
    if (ids.length === 0) return result;

    const CHUNK_SIZE = 900;
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const stmt = this.db.prepare(
        `SELECT id, stop_at FROM decisions WHERE id IN (${placeholders})`
      );
      const rows = stmt.all(...chunk) as Array<{ id: string; stop_at: string }>;
      for (const row of rows) {
        result.set(String(row.id), row.stop_at);
      }
    }
    return result;
  }

  getActiveDecisionByValue(value: string, now: string): { raw_data: string; stop_at: string } | null {
    return (this.getActiveDecisionByValueStatement.get({ $value: value, $now: now }) as { raw_data: string; stop_at: string } | null) || null;
  }

  deleteAlert(id: string | number): void {
    this.deleteAlertStatement.run({ $id: id });
  }

  deleteDecisionsByAlertId(alertId: string | number): void {
    this.deleteDecisionsByAlertIdStatement.run({ $alert_id: alertId });
  }

  getMeta(key: string): MetaRow | null {
    return (this.getMetaStatement.get(key) as MetaRow | null) || null;
  }

  setMeta(key: string, value: string): void {
    this.setMetaStatement.run(key, value);
  }

  listNotificationChannels(): JsonRow[] {
    return this.listNotificationChannelsStatement.all() as JsonRow[];
  }

  getNotificationChannelById(id: string): JsonRow | null {
    return (this.getNotificationChannelByIdStatement.get({ $id: id }) as JsonRow | null) || null;
  }

  upsertNotificationChannel(params: {
    $id: string;
    $created_at: string;
    $updated_at: string;
    $name: string;
    $type: string;
    $enabled: number;
    $config_json: string;
  }): void {
    this.upsertNotificationChannelStatement.run(params);
  }

  deleteNotificationChannel(id: string): void {
    this.deleteNotificationChannelStatement.run({ $id: id });
  }

  listNotificationRules(): JsonRow[] {
    return this.listNotificationRulesStatement.all() as JsonRow[];
  }

  getNotificationRuleById(id: string): JsonRow | null {
    return (this.getNotificationRuleByIdStatement.get({ $id: id }) as JsonRow | null) || null;
  }

  upsertNotificationRule(params: {
    $id: string;
    $created_at: string;
    $updated_at: string;
    $name: string;
    $type: string;
    $enabled: number;
    $severity: string;
    $channel_ids_json: string;
    $config_json: string;
  }): void {
    this.upsertNotificationRuleStatement.run(params);
  }

  deleteNotificationRule(id: string): void {
    this.deleteNotificationRuleStatement.run({ $id: id });
  }

  listNotifications(limit = 100): JsonRow[] {
    return this.listNotificationsStatement.all({ $limit: limit }) as JsonRow[];
  }

  insertNotification(params: {
    $id: string;
    $created_at: string;
    $updated_at: string;
    $rule_id: string;
    $rule_name: string;
    $rule_type: string;
    $severity: string;
    $title: string;
    $message: string;
    $read_at: string | null;
    $metadata_json: string;
    $deliveries_json: string;
    $dedupe_key: string;
  }): boolean {
    return this.insertNotificationStatement.run(params).changes > 0;
  }

  listNotificationIncidentsByRule(ruleId: string): JsonRow[] {
    return this.listNotificationIncidentsByRuleStatement.all({ $rule_id: ruleId }) as JsonRow[];
  }

  upsertNotificationIncident(params: {
    $rule_id: string;
    $incident_key: string;
    $first_seen_at: string;
    $last_seen_at: string;
    $resolved_at: string | null;
  }): void {
    this.upsertNotificationIncidentStatement.run(params);
  }

  resolveNotificationIncident(ruleId: string, incidentKey: string, resolvedAt: string): boolean {
    return this.resolveNotificationIncidentStatement.run({
      $rule_id: ruleId,
      $incident_key: incidentKey,
      $resolved_at: resolvedAt,
      $last_seen_at: resolvedAt,
    }).changes > 0;
  }

  deleteNotificationIncidentsByRule(ruleId: string): void {
    this.deleteNotificationIncidentsByRuleStatement.run({ $rule_id: ruleId });
  }

  markNotificationRead(id: string, readAt: string): boolean {
    return this.markNotificationReadStatement.run({ $id: id, $read_at: readAt, $updated_at: readAt }).changes > 0;
  }

  markAllNotificationsRead(readAt: string): number {
    return this.markAllNotificationsReadStatement.run({ $read_at: readAt, $updated_at: readAt }).changes;
  }

  countUnreadNotifications(): number {
    return (this.countUnreadNotificationsStatement.get() as CountRow).count;
  }

  getCveCacheEntry(id: string): JsonRow | null {
    return (this.getCveCacheEntryStatement.get({ $id: id }) as JsonRow | null) || null;
  }

  upsertCveCacheEntry(id: string, publishedAt: string, fetchedAt: string): void {
    this.upsertCveCacheEntryStatement.run({ $id: id, $published_at: publishedAt, $fetched_at: fetchedAt });
  }

  transaction<T>(callback: (value: T) => void): (value: T) => void {
    return this.db.transaction(callback);
  }

  getDashboardStats(
    since: string,
    now: string,
    granularity: 'hour' | 'day',
    filters?: DashboardStatsFilters,
  ): DashboardStatsResult {
    const dateFmt = granularity === 'hour'
      ? "strftime('%Y-%m-%dT%H', created_at)"
      : "strftime('%Y-%m-%d', created_at)";

    // Build dynamic WHERE clauses for alerts based on filters
    const alertConditions: string[] = ['created_at >= ?'];
    const alertParams: unknown[] = [since];

    if (filters?.country) {
      alertConditions.push('source_cn = ?');
      alertParams.push(filters.country);
    }
    if (filters?.scenario) {
      alertConditions.push('scenario = ?');
      alertParams.push(filters.scenario);
    }
    if (filters?.as_name) {
      alertConditions.push('source_as_name = ?');
      alertParams.push(filters.as_name);
    }
    if (filters?.ip) {
      alertConditions.push('source_ip = ?');
      alertParams.push(filters.ip);
    }
    if (filters?.target) {
      alertConditions.push('target = ?');
      alertParams.push(filters.target);
    }
    if (filters?.simulated !== undefined) {
      alertConditions.push('simulated = ?');
      alertParams.push(filters.simulated ? 1 : 0);
    }

    const alertWhere = alertConditions.join(' AND ');

    // Total counts
    const alertTotals = this.db.prepare(
      `SELECT COUNT(*) as total, SUM(CASE WHEN simulated = 1 THEN 1 ELSE 0 END) as simulated FROM alerts WHERE ${alertWhere}`
    ).get(...alertParams) as { total: number; simulated: number | null };

    const decisionTotal = this.db.prepare(
      'SELECT COUNT(*) as total FROM decisions WHERE stop_at > ?'
    ).get(now) as { total: number };

    // Time series - alerts (live only)
    const alertBuckets = this.db.prepare(
      `SELECT ${dateFmt} as date, COUNT(*) as count FROM alerts WHERE ${alertWhere} AND simulated = 0 GROUP BY ${dateFmt} ORDER BY date`
    ).all(...alertParams) as Array<{ date: string; count: number }>;

    // Time series - simulated alerts
    const simulatedAlertBuckets = this.db.prepare(
      `SELECT ${dateFmt} as date, COUNT(*) as count FROM alerts WHERE ${alertWhere} AND simulated = 1 GROUP BY ${dateFmt} ORDER BY date`
    ).all(...alertParams) as Array<{ date: string; count: number }>;

    // Time series - decisions (live only)
    const decisionBuckets = this.db.prepare(
      `SELECT ${dateFmt} as date, COUNT(*) as count FROM decisions WHERE created_at >= ? AND stop_at > ? AND simulated = 0 GROUP BY ${dateFmt} ORDER BY date`
    ).all(since, now) as Array<{ date: string; count: number }>;

    // Time series - simulated decisions
    const simulatedDecisionBuckets = this.db.prepare(
      `SELECT ${dateFmt} as date, COUNT(*) as count FROM decisions WHERE created_at >= ? AND stop_at > ? AND simulated = 1 GROUP BY ${dateFmt} ORDER BY date`
    ).all(since, now) as Array<{ date: string; count: number }>;

    // Top 10 aggregations
    const topCountries = this.db.prepare(
      `SELECT source_cn as code, COUNT(*) as count,
        SUM(CASE WHEN simulated = 1 THEN 1 ELSE 0 END) as simulated_count,
        SUM(CASE WHEN simulated = 0 THEN 1 ELSE 0 END) as live_count
       FROM alerts WHERE ${alertWhere} AND source_cn IS NOT NULL AND source_cn != ''
       GROUP BY source_cn ORDER BY count DESC LIMIT 10`
    ).all(...alertParams) as Array<{ code: string; count: number; simulated_count: number; live_count: number }>;

    const topScenarios = this.db.prepare(
      `SELECT scenario as name, COUNT(*) as count FROM alerts WHERE ${alertWhere} AND scenario IS NOT NULL GROUP BY scenario ORDER BY count DESC LIMIT 10`
    ).all(...alertParams) as Array<{ name: string; count: number }>;

    const topAS = this.db.prepare(
      `SELECT source_as_name as name, COUNT(*) as count FROM alerts WHERE ${alertWhere} AND source_as_name IS NOT NULL AND source_as_name != '' GROUP BY source_as_name ORDER BY count DESC LIMIT 10`
    ).all(...alertParams) as Array<{ name: string; count: number }>;

    const topTargets = this.db.prepare(
      `SELECT target as name, COUNT(*) as count FROM alerts WHERE ${alertWhere} AND target IS NOT NULL AND target != '' GROUP BY target ORDER BY count DESC LIMIT 10`
    ).all(...alertParams) as Array<{ name: string; count: number }>;

    const topIPs = this.db.prepare(
      `SELECT source_ip as ip, COUNT(*) as count FROM alerts WHERE ${alertWhere} AND source_ip IS NOT NULL GROUP BY source_ip ORDER BY count DESC LIMIT 10`
    ).all(...alertParams) as Array<{ ip: string; count: number }>;

    return {
      totals: {
        alerts: alertTotals.total,
        decisions: decisionTotal.total,
        simulated_alerts: alertTotals.simulated ?? 0,
      },
      time_series: {
        granularity,
        alert_buckets: alertBuckets,
        decision_buckets: decisionBuckets,
        simulated_alert_buckets: simulatedAlertBuckets,
        simulated_decision_buckets: simulatedDecisionBuckets,
      },
      top_countries: topCountries,
      top_scenarios: topScenarios,
      top_as: topAS,
      top_targets: topTargets,
      top_ips: topIPs,
    };
  }

  getAllCountriesAggregated(since: string, filters?: DashboardStatsFilters): Array<{ code: string; count: number; simulated_count: number; live_count: number }> {
    const conditions: string[] = ['created_at >= ?'];
    const params: unknown[] = [since];

    if (filters?.country) {
      conditions.push('source_cn = ?');
      params.push(filters.country);
    }
    if (filters?.scenario) {
      conditions.push('scenario = ?');
      params.push(filters.scenario);
    }
    if (filters?.as_name) {
      conditions.push('source_as_name = ?');
      params.push(filters.as_name);
    }
    if (filters?.ip) {
      conditions.push('source_ip = ?');
      params.push(filters.ip);
    }
    if (filters?.target) {
      conditions.push('target = ?');
      params.push(filters.target);
    }
    if (filters?.simulated !== undefined) {
      conditions.push('simulated = ?');
      params.push(filters.simulated ? 1 : 0);
    }

    const where = conditions.join(' AND ');
    return this.db.prepare(
      `SELECT source_cn as code, COUNT(*) as count,
        SUM(CASE WHEN simulated = 1 THEN 1 ELSE 0 END) as simulated_count,
        SUM(CASE WHEN simulated = 0 THEN 1 ELSE 0 END) as live_count
       FROM alerts WHERE ${where} AND source_cn IS NOT NULL AND source_cn != ''
       GROUP BY source_cn ORDER BY count DESC`
    ).all(...params) as Array<{ code: string; count: number; simulated_count: number; live_count: number }>;
  }
}

function resolveDatabasePath(options: DatabaseOptions): string {
  if (options.dbPath) {
    ensureDirectory(path.dirname(options.dbPath));
    return options.dbPath;
  }

  const dbDir = options.dbDir || '/app/data';
  let dbPath = path.join(dbDir, 'crowdsec.db');

  if (!fs.existsSync(dbDir)) {
    try {
      fs.mkdirSync(dbDir, { recursive: true });
    } catch (error) {
      dbPath = path.join(MODULE_DIR, '../../crowdsec.db');
    }
  }

  return dbPath;
}

function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function openDatabase(dbPath: string): Database {
  try {
    const database = createDatabase(dbPath);
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA synchronous = NORMAL');
    database.exec('PRAGMA cache_size = -32000');
    database.exec('PRAGMA temp_store = MEMORY');
    database.exec('PRAGMA busy_timeout = 5000');
    database.exec('PRAGMA mmap_size = 268435456');
    return database;
  } catch (error: any) {
    if (dbPath.startsWith('/app/data') && error?.code === 'EACCES') {
      return createDatabase('crowdsec.db');
    }
    throw error;
  }
}

function createDatabase(dbPath: string): Database {
  const database = new BetterSqlite3(dbPath) as Database;
  database.query = (sql: string) => {
    const statement = database.prepare(sql);
    return {
      run: (...params: any[]) => (statement.run as any)(...params.map(normalizeBindingValue)),
      get: (...params: any[]) => (statement.get as any)(...params.map(normalizeBindingValue)),
      all: (...params: any[]) => (statement.all as any)(...params.map(normalizeBindingValue)),
    };
  };
  return database;
}

function normalizeBindingValue(value: unknown): unknown {
  if (!value || Array.isArray(value) || Buffer.isBuffer(value) || value instanceof Date || typeof value !== 'object') {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    normalized[key.replace(/^[$:@]/, '')] = entry;
  }
  return normalized;
}

function initSchema(db: Database): void {
  const createAlertsTable = `
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY,
      uuid TEXT UNIQUE,
      created_at TEXT NOT NULL,
      scenario TEXT,
      source_ip TEXT,
      message TEXT,
      raw_data TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at);
  `;

  const createDecisionsTable = `
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      uuid TEXT UNIQUE,
      alert_id INTEGER,
      created_at TEXT NOT NULL,
      stop_at TEXT NOT NULL,
      value TEXT,
      type TEXT,
      origin TEXT,
      scenario TEXT,
      raw_data TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_stop_at ON decisions(stop_at);
    CREATE INDEX IF NOT EXISTS idx_decisions_alert_id ON decisions(alert_id);
    CREATE INDEX IF NOT EXISTS idx_decisions_value ON decisions(value);
    CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions(created_at);
    CREATE INDEX IF NOT EXISTS idx_decisions_value_stop_at ON decisions(value, stop_at DESC);
  `;

  const createMetaTable = `
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `;

  const createNotificationChannelsTable = `
    CREATE TABLE IF NOT EXISTS notification_channels (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL
    );
  `;

  const createNotificationRulesTable = `
    CREATE TABLE IF NOT EXISTS notification_rules (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      severity TEXT NOT NULL,
      channel_ids_json TEXT NOT NULL,
      config_json TEXT NOT NULL
    );
  `;

  const createNotificationsTable = `
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      rule_name TEXT NOT NULL,
      rule_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      read_at TEXT,
      metadata_json TEXT NOT NULL,
      deliveries_json TEXT NOT NULL,
      dedupe_key TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_read_at ON notifications(read_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_rule_id ON notifications(rule_id);
  `;

  const createNotificationIncidentsTable = `
    CREATE TABLE IF NOT EXISTS notification_incidents (
      rule_id TEXT NOT NULL,
      incident_key TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      resolved_at TEXT,
      PRIMARY KEY (rule_id, incident_key)
    );
    CREATE INDEX IF NOT EXISTS idx_notification_incidents_rule_id ON notification_incidents(rule_id);
    CREATE INDEX IF NOT EXISTS idx_notification_incidents_resolved_at ON notification_incidents(resolved_at);
  `;

  const createCveCacheTable = `
    CREATE TABLE IF NOT EXISTS cve_cache (
      id TEXT PRIMARY KEY,
      published_at TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
  `;

  db.exec(createAlertsTable);
  db.exec(createMetaTable);
  db.exec(createNotificationChannelsTable);
  db.exec(createNotificationRulesTable);
  db.exec(createNotificationsTable);
  db.exec(createNotificationIncidentsTable);
  db.exec(createCveCacheTable);

  const tableInfo = db.query('PRAGMA table_info(decisions)').all() as Array<{ name: string; type: string }>;
  const idColumn = tableInfo.find((column) => column.name === 'id');

  if (idColumn && idColumn.type.toUpperCase() === 'INTEGER') {
    const existingDecisions = db.query('SELECT * FROM decisions').all() as Array<Record<string, unknown>>;

    db.exec('DROP INDEX IF EXISTS idx_decisions_stop_at');
    db.exec('DROP INDEX IF EXISTS idx_decisions_alert_id');
    db.exec('DROP TABLE IF EXISTS decisions');
    db.exec(createDecisionsTable);

    if (existingDecisions.length > 0) {
      const insertStatement = db.query(`
        INSERT OR REPLACE INTO decisions (id, uuid, alert_id, created_at, stop_at, value, type, origin, scenario, raw_data)
        VALUES ($id, $uuid, $alert_id, $created_at, $stop_at, $value, $type, $origin, $scenario, $raw_data)
      `);

      const restore = db.transaction((decisions: Array<Record<string, unknown>>) => {
        for (const decision of decisions) {
          (insertStatement as any).run({
            $id: String(decision.id),
            $uuid: decision.uuid,
            $alert_id: decision.alert_id,
            $created_at: decision.created_at,
            $stop_at: decision.stop_at,
            $value: decision.value,
            $type: decision.type,
            $origin: decision.origin,
            $scenario: decision.scenario,
            $raw_data: decision.raw_data,
          });
        }
      });

      restore(existingDecisions);
    }
  } else {
    db.exec(createDecisionsTable);
  }

  migrateNotificationRulesTable(db, createNotificationRulesTable);
  migrateNotificationsTable(db, createNotificationsTable);
  db.exec(createNotificationIncidentsTable);
  seedNotificationIncidentsFromHistoryIfEmpty(db);
  migrateStatsColumns(db);
}

function migrateStatsColumns(db: Database): void {
  const alertCols = db.query('PRAGMA table_info(alerts)').all() as Array<{ name: string }>;
  const alertColNames = new Set(alertCols.map((c) => c.name));

  if (!alertColNames.has('source_cn')) {
    db.exec('ALTER TABLE alerts ADD COLUMN source_cn TEXT');
    db.exec('ALTER TABLE alerts ADD COLUMN source_as_name TEXT');
    db.exec('ALTER TABLE alerts ADD COLUMN source_scope TEXT');
    db.exec('ALTER TABLE alerts ADD COLUMN source_range TEXT');
    db.exec('ALTER TABLE alerts ADD COLUMN target TEXT');
    db.exec('ALTER TABLE alerts ADD COLUMN simulated INTEGER DEFAULT 0');
  }

  if (!alertColNames.has('machine_id')) {
    db.exec('ALTER TABLE alerts ADD COLUMN machine_id TEXT');
  }

  const decisionCols = db.query('PRAGMA table_info(decisions)').all() as Array<{ name: string }>;
  const decisionColNames = new Set(decisionCols.map((c) => c.name));

  if (!decisionColNames.has('target')) {
    db.exec('ALTER TABLE decisions ADD COLUMN target TEXT');
    db.exec('ALTER TABLE decisions ADD COLUMN simulated INTEGER DEFAULT 0');
  }
}

function migrateNotificationRulesTable(db: Database, createNotificationRulesTable: string): void {
  const columns = db.query('PRAGMA table_info(notification_rules)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'cooldown_minutes')) {
    return;
  }

  const existingRules = db.query(`
    SELECT id, created_at, updated_at, name, type, enabled, severity, channel_ids_json, config_json
    FROM notification_rules
  `).all() as Array<Record<string, unknown>>;

  db.exec('DROP TABLE IF EXISTS notification_rules');
  db.exec(createNotificationRulesTable);

  if (existingRules.length === 0) {
    return;
  }

  const insertStatement = db.query(`
    INSERT OR REPLACE INTO notification_rules (
      id, created_at, updated_at, name, type, enabled, severity, channel_ids_json, config_json
    )
    VALUES ($id, $created_at, $updated_at, $name, $type, $enabled, $severity, $channel_ids_json, $config_json)
  `);

  const restore = db.transaction((rules: Array<Record<string, unknown>>) => {
    for (const rule of rules) {
      (insertStatement as any).run({
        $id: String(rule.id),
        $created_at: String(rule.created_at),
        $updated_at: String(rule.updated_at),
        $name: String(rule.name),
        $type: String(rule.type),
        $enabled: Number(rule.enabled) === 1 ? 1 : 0,
        $severity: String(rule.severity),
        $channel_ids_json: String(rule.channel_ids_json || '[]'),
        $config_json: String(rule.config_json || '{}'),
      });
    }
  });

  restore(existingRules);
}

function migrateNotificationsTable(db: Database, createNotificationsTable: string): void {
  const sqlRow = db.query(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = 'notifications'
  `).get() as { sql?: string } | null;
  const tableSql = String(sqlRow?.sql || '');
  if (!tableSql.includes('dedupe_key TEXT NOT NULL UNIQUE')) {
    return;
  }

  const existingNotifications = db.query(`
    SELECT id, created_at, updated_at, rule_id, rule_name, rule_type, severity, title, message, read_at, metadata_json, deliveries_json, dedupe_key
    FROM notifications
    ORDER BY created_at ASC
  `).all() as Array<Record<string, unknown>>;

  db.exec('DROP INDEX IF EXISTS idx_notifications_created_at');
  db.exec('DROP INDEX IF EXISTS idx_notifications_read_at');
  db.exec('DROP INDEX IF EXISTS idx_notifications_rule_id');
  db.exec('DROP TABLE IF EXISTS notifications');
  db.exec(createNotificationsTable);

  if (existingNotifications.length === 0) {
    return;
  }

  const insertStatement = db.query(`
    INSERT OR REPLACE INTO notifications (
      id, created_at, updated_at, rule_id, rule_name, rule_type, severity, title, message, read_at, metadata_json, deliveries_json, dedupe_key
    )
    VALUES (
      $id, $created_at, $updated_at, $rule_id, $rule_name, $rule_type, $severity, $title, $message, $read_at, $metadata_json, $deliveries_json, $dedupe_key
    )
  `);

  const restore = db.transaction((notifications: Array<Record<string, unknown>>) => {
    for (const notification of notifications) {
      (insertStatement as any).run({
        $id: String(notification.id),
        $created_at: String(notification.created_at),
        $updated_at: String(notification.updated_at),
        $rule_id: String(notification.rule_id),
        $rule_name: String(notification.rule_name),
        $rule_type: String(notification.rule_type),
        $severity: String(notification.severity),
        $title: String(notification.title),
        $message: String(notification.message),
        $read_at: notification.read_at == null ? null : String(notification.read_at),
        $metadata_json: String(notification.metadata_json || '{}'),
        $deliveries_json: String(notification.deliveries_json || '[]'),
        $dedupe_key: String(notification.dedupe_key || ''),
      });
    }
  });

  restore(existingNotifications);
}

function seedNotificationIncidentsFromHistoryIfEmpty(db: Database): void {
  const countRow = db.query('SELECT COUNT(*) as count FROM notification_incidents').get() as CountRow | null;
  if ((countRow?.count || 0) > 0) {
    return;
  }

  const rows = db.query(`
    SELECT rule_id, rule_type, dedupe_key, created_at
    FROM notifications
    ORDER BY created_at DESC
  `).all() as Array<{ rule_id?: string; rule_type?: string; dedupe_key?: string; created_at?: string }>;

  if (rows.length === 0) {
    return;
  }

  const latestByIncident = new Map<string, { ruleId: string; incidentKey: string; createdAt: string }>();
  for (const row of rows) {
    const ruleId = String(row.rule_id || '');
    const ruleType = String(row.rule_type || '');
    const incidentKey = normalizeIncidentKeyForSeed(ruleId, ruleType, String(row.dedupe_key || ''));
    const createdAt = String(row.created_at || '');
    if (!ruleId || !incidentKey || !createdAt) {
      continue;
    }

    const compositeKey = `${ruleId}\u0000${incidentKey}`;
    if (!latestByIncident.has(compositeKey)) {
      latestByIncident.set(compositeKey, { ruleId, incidentKey, createdAt });
    }
  }

  if (latestByIncident.size === 0) {
    return;
  }

  const insertStatement = db.query(`
    INSERT OR REPLACE INTO notification_incidents (rule_id, incident_key, first_seen_at, last_seen_at, resolved_at)
    VALUES ($rule_id, $incident_key, $first_seen_at, $last_seen_at, $resolved_at)
  `);

  const restore = db.transaction((entries: Array<{ ruleId: string; incidentKey: string; createdAt: string }>) => {
    for (const entry of entries) {
      (insertStatement as any).run({
        $rule_id: entry.ruleId,
        $incident_key: entry.incidentKey,
        $first_seen_at: entry.createdAt,
        $last_seen_at: entry.createdAt,
        $resolved_at: null,
      });
    }
  });

  restore([...latestByIncident.values()]);
}

function normalizeIncidentKeyForSeed(ruleId: string, ruleType: string, dedupeKey: string): string | null {
  if (!dedupeKey) {
    return null;
  }

  const scopedPrefix = `${ruleId}:`;
  const normalized = dedupeKey.startsWith(scopedPrefix)
    ? dedupeKey.slice(scopedPrefix.length)
    : dedupeKey;

  if (ruleType === 'alert-threshold') {
    return normalized.startsWith('threshold:') ? 'threshold:active' : null;
  }
  if (ruleType === 'alert-spike') {
    return normalized.startsWith('spike:') ? 'spike:active' : null;
  }
  if (ruleType === 'new-cve') {
    return normalized.startsWith('cve:') ? normalized : null;
  }
  if (ruleType === 'application-update') {
    return normalized.startsWith('application-update:') ? normalized : null;
  }

  return normalized || null;
}
