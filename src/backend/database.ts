import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

export interface AlertInsertParams {
  $id: string | number;
  $uuid: string;
  $created_at: string;
  $scenario?: string;
  $source_ip?: string;
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
  $raw_data: string;
}

export interface DecisionUpdateParams {
  $id: string;
  $stop_at: string;
  $raw_data: string;
}

export interface DatabaseOptions {
  dbDir?: string;
  dbPath?: string;
}

type RowWithRawData = { raw_data: string; created_at?: string; stop_at?: string };
type MetaRow = { value: string };
type CountRow = { count: number };
type JsonRow = { id: string; created_at: string; updated_at: string; name?: string; type?: string; enabled?: number; config_json?: string; severity?: string; cooldown_minutes?: number; channel_ids_json?: string; rule_id?: string; rule_name?: string; rule_type?: string; title?: string; message?: string; read_at?: string | null; metadata_json?: string; deliveries_json?: string; dedupe_key?: string; published_at?: string; fetched_at?: string };

export class CrowdsecDatabase {
  public readonly db: Database;

  private readonly insertAlertStatement: any;
  private readonly getAlertsStatement: any;
  private readonly getAlertsBetweenStatement: any;
  private readonly countAlertsStatement: any;
  private readonly deleteOldAlertsStatement: any;
  private readonly insertDecisionStatement: any;
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
  private readonly getLatestNotificationForRuleStatement: any;
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
      INSERT OR REPLACE INTO alerts (id, uuid, created_at, scenario, source_ip, message, raw_data)
      VALUES ($id, $uuid, $created_at, $scenario, $source_ip, $message, $raw_data)
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

    this.insertDecisionStatement = this.db.query(`
      INSERT OR REPLACE INTO decisions (id, uuid, alert_id, created_at, stop_at, value, type, origin, scenario, raw_data)
      VALUES ($id, $uuid, $alert_id, $created_at, $stop_at, $value, $type, $origin, $scenario, $raw_data)
    `);

    this.updateDecisionStatement = this.db.query(`
      UPDATE decisions SET stop_at = $stop_at, raw_data = $raw_data
      WHERE id = $id
    `);

    this.getActiveDecisionsStatement = this.db.query(`
      SELECT raw_data, created_at FROM decisions
      WHERE stop_at > $now
      ORDER BY stop_at DESC
    `);

    this.getDecisionsSinceStatement = this.db.query(`
      SELECT raw_data, created_at FROM decisions
      WHERE created_at >= $since OR stop_at > $now
      ORDER BY stop_at DESC
    `);

    this.deleteOldDecisionsStatement = this.db.query('DELETE FROM decisions WHERE stop_at < $cutoff');
    this.deleteDecisionStatement = this.db.query('DELETE FROM decisions WHERE id = $id');
    this.getDecisionByIdStatement = this.db.query('SELECT raw_data, stop_at FROM decisions WHERE id = $id');
    this.getActiveDecisionByValueStatement = this.db.query(`
      SELECT raw_data, stop_at FROM decisions
      WHERE value = $value AND stop_at > $now AND id NOT LIKE 'dup_%'
      ORDER BY stop_at DESC
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
      SELECT id, created_at, updated_at, name, type, enabled, severity, cooldown_minutes, channel_ids_json, config_json
      FROM notification_rules
      ORDER BY created_at DESC
    `);
    this.getNotificationRuleByIdStatement = this.db.query(`
      SELECT id, created_at, updated_at, name, type, enabled, severity, cooldown_minutes, channel_ids_json, config_json
      FROM notification_rules
      WHERE id = $id
    `);
    this.upsertNotificationRuleStatement = this.db.query(`
      INSERT OR REPLACE INTO notification_rules (
        id, created_at, updated_at, name, type, enabled, severity, cooldown_minutes, channel_ids_json, config_json
      )
      VALUES ($id, $created_at, $updated_at, $name, $type, $enabled, $severity, $cooldown_minutes, $channel_ids_json, $config_json)
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
    this.getLatestNotificationForRuleStatement = this.db.query(`
      SELECT id, created_at, updated_at, rule_id, rule_name, rule_type, severity, title, message, read_at, metadata_json, deliveries_json, dedupe_key
      FROM notifications
      WHERE rule_id = $rule_id
      ORDER BY created_at DESC
      LIMIT 1
    `);
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
    $cooldown_minutes: number;
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

  getLatestNotificationForRule(ruleId: string): JsonRow | null {
    return (this.getLatestNotificationForRuleStatement.get({ $rule_id: ruleId }) as JsonRow | null) || null;
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
      dbPath = path.join(import.meta.dir, '../../crowdsec.db');
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
    const database = new Database(dbPath);
    database.exec('PRAGMA journal_mode = WAL');
    return database;
  } catch (error: any) {
    if (dbPath.startsWith('/app/data') && error?.code === 'EACCES') {
      return new Database('crowdsec.db');
    }
    throw error;
  }
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
      cooldown_minutes INTEGER NOT NULL DEFAULT 60,
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
      dedupe_key TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_read_at ON notifications(read_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_rule_id ON notifications(rule_id);
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
}
