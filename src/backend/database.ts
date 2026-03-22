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

export class CrowdsecDatabase {
  public readonly db: Database;

  private readonly insertAlertStatement: any;
  private readonly getAlertsStatement: any;
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

  db.exec(createAlertsTable);
  db.exec(createMetaTable);

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
