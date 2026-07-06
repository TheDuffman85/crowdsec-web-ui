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

type RowWithRawData = { raw_data: string; created_at?: string; stop_at?: string; alert_id?: string | number | null };
type MetaRow = { value: string };
type CountRow = { count: number };
type IdRow = { id: string | number };
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

export interface AuthUserRow {
  id: number;
  username: string;
  password_hash: string | null;
  totp_secret: string | null;
  totp_enabled: number;
  role: 'admin' | 'read-only';
  auth_provider: 'password' | 'oidc';
  created_at: string;
  updated_at: string;
}

export interface WebAuthnCredentialRow {
  id: number;
  user_id: number;
  credential_id: string;
  public_key: string;
  sign_count: number;
  transports: string | null;
  name: string | null;
  created_at: string;
}

export class CrowdsecDatabase {
  public readonly db: Database;

  private readonly insertAlertStatement: any;
  private readonly getAllAlertsStatement: any;
  private readonly getAlertsStatement: any;
  private readonly getAlertsBetweenStatement: any;
  private readonly getAlertIdsBetweenStatement: any;
  private readonly countAlertsStatement: any;
  private readonly countDecisionsStatement: any;
  private readonly deleteOldAlertsStatement: any;
  private readonly insertDecisionStatement: any;
  private readonly updateDecisionStatement: any;
  private readonly getAllDecisionsStatement: any;
  private readonly getActiveDecisionsStatement: any;
  private readonly getActiveAlertIdsStatement: any;
  private readonly getDecisionsSinceStatement: any;
  private readonly deleteOldDecisionsStatement: any;
  private readonly deleteDecisionStatement: any;
  private readonly getDecisionByIdStatement: any;
  private readonly getDecisionIdsByAlertIdStatement: any;
  private readonly getActiveDecisionByValueStatement: any;
  private readonly deleteAlertStatement: any;
  private readonly deleteDecisionsByAlertIdStatement: any;
  private readonly getMetaStatement: any;
  private readonly setMetaStatement: any;
  private readonly countAuthUsersStatement: any;
  private readonly createAuthUserStatement: any;
  private readonly getAuthUserByIdStatement: any;
  private readonly getAuthUserByUsernameStatement: any;
  private readonly updateAuthUserPasswordStatement: any;
  private readonly updateAuthUserTotpStatement: any;
  private readonly upsertOidcUserStatement: any;
  private readonly listWebAuthnCredentialsByUserStatement: any;
  private readonly countWebAuthnCredentialsStatement: any;
  private readonly createWebAuthnCredentialStatement: any;
  private readonly getWebAuthnCredentialByCredentialIdStatement: any;
  private readonly updateWebAuthnCredentialCounterStatement: any;
  private readonly renameWebAuthnCredentialStatement: any;
  private readonly deleteWebAuthnCredentialStatement: any;
  private readonly listNotificationChannelsStatement: any;
  private readonly getNotificationChannelByIdStatement: any;
  private readonly upsertNotificationChannelStatement: any;
  private readonly deleteNotificationChannelStatement: any;
  private readonly listNotificationRulesStatement: any;
  private readonly getNotificationRuleByIdStatement: any;
  private readonly upsertNotificationRuleStatement: any;
  private readonly deleteNotificationRuleStatement: any;
  private readonly listNotificationsPageStatement: any;
  private readonly countNotificationsStatement: any;
  private readonly listNotificationIdsStatement: any;
  private readonly insertNotificationStatement: any;
  private readonly listNotificationIncidentsByRuleStatement: any;
  private readonly upsertNotificationIncidentStatement: any;
  private readonly resolveNotificationIncidentStatement: any;
  private readonly deleteNotificationIncidentsByRuleStatement: any;
  private readonly deleteNotificationStatement: any;
  private readonly markNotificationReadStatement: any;
  private readonly markAllNotificationsReadStatement: any;
  private readonly deleteReadNotificationsStatement: any;
  private readonly countUnreadNotificationsStatement: any;
  private readonly getCveCacheEntryStatement: any;
  private readonly upsertCveCacheEntryStatement: any;

  constructor(options: DatabaseOptions = {}) {
    const resolvedPath = resolveDatabasePath(options);
    this.db = openDatabase(resolvedPath);
    const freshDatabase = isDatabaseFresh(this.db);
    initSchema(this.db, freshDatabase);

    this.insertAlertStatement = this.db.query(`
      INSERT OR REPLACE INTO alerts (id, uuid, created_at, scenario, source_ip, message, raw_data)
      VALUES ($id, $uuid, $created_at, $scenario, $source_ip, $message, $raw_data)
    `);

    this.getAllAlertsStatement = this.db.query(`
      SELECT raw_data FROM alerts
      ORDER BY created_at DESC
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
    this.getAlertIdsBetweenStatement = this.db.query(`
      SELECT id FROM alerts
      WHERE created_at >= $start AND created_at < $end
    `);

    this.countAlertsStatement = this.db.query('SELECT COUNT(*) as count FROM alerts');
    this.countDecisionsStatement = this.db.query('SELECT COUNT(*) as count FROM decisions');
    this.deleteOldAlertsStatement = this.db.query('DELETE FROM alerts WHERE created_at < $cutoff');

    this.insertDecisionStatement = this.db.query(`
      INSERT OR REPLACE INTO decisions (id, uuid, alert_id, created_at, stop_at, value, type, origin, scenario, raw_data)
      VALUES ($id, $uuid, $alert_id, $created_at, $stop_at, $value, $type, $origin, $scenario, $raw_data)
    `);

    this.updateDecisionStatement = this.db.query(`
      UPDATE decisions SET stop_at = $stop_at, raw_data = $raw_data
      WHERE id = $id
    `);

    this.getAllDecisionsStatement = this.db.query(`
      SELECT raw_data, created_at, stop_at, alert_id FROM decisions
      ORDER BY stop_at DESC
    `);
    this.getActiveDecisionsStatement = this.db.query(`
      SELECT raw_data, created_at, alert_id FROM decisions
      WHERE stop_at > $now
      ORDER BY stop_at DESC
    `);
    this.getActiveAlertIdsStatement = this.db.query(`
      SELECT DISTINCT decisions.alert_id AS id
      FROM decisions
      INNER JOIN alerts ON alerts.id = decisions.alert_id
      WHERE decisions.stop_at > $now
        AND decisions.alert_id IS NOT NULL
        AND alerts.created_at >= $since
    `);

    this.getDecisionsSinceStatement = this.db.query(`
      SELECT raw_data, created_at, alert_id FROM decisions
      WHERE created_at >= $since OR stop_at > $now
      ORDER BY stop_at DESC
    `);

    this.deleteOldDecisionsStatement = this.db.query('DELETE FROM decisions WHERE stop_at < $cutoff');
    this.deleteDecisionStatement = this.db.query('DELETE FROM decisions WHERE id = $id');
    this.getDecisionByIdStatement = this.db.query('SELECT raw_data, stop_at FROM decisions WHERE id = $id');
    this.getDecisionIdsByAlertIdStatement = this.db.query('SELECT id FROM decisions WHERE alert_id = $alert_id');
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
    this.countAuthUsersStatement = this.db.query('SELECT COUNT(*) as count FROM auth_users');
    this.createAuthUserStatement = this.db.query(`
      INSERT INTO auth_users (username, password_hash, role, auth_provider, created_at, updated_at)
      VALUES ($username, $password_hash, $role, $auth_provider, $created_at, $updated_at)
    `);
    this.getAuthUserByIdStatement = this.db.query('SELECT * FROM auth_users WHERE id = $id');
    this.getAuthUserByUsernameStatement = this.db.query('SELECT * FROM auth_users WHERE username = $username');
    this.updateAuthUserPasswordStatement = this.db.query(`
      UPDATE auth_users
      SET password_hash = $password_hash, updated_at = $updated_at
      WHERE id = $id
    `);
    this.updateAuthUserTotpStatement = this.db.query(`
      UPDATE auth_users
      SET totp_secret = $totp_secret, totp_enabled = $totp_enabled, updated_at = $updated_at
      WHERE id = $id
    `);
    this.upsertOidcUserStatement = this.db.query(`
      INSERT INTO auth_users (username, password_hash, role, auth_provider, created_at, updated_at)
      VALUES ($username, NULL, $role, 'oidc', $created_at, $updated_at)
      ON CONFLICT(username) DO UPDATE SET
        role = excluded.role,
        auth_provider = 'oidc',
        updated_at = excluded.updated_at
    `);
    this.listWebAuthnCredentialsByUserStatement = this.db.query(`
      SELECT * FROM webauthn_credentials
      WHERE user_id = $user_id
      ORDER BY created_at DESC
    `);
    this.countWebAuthnCredentialsStatement = this.db.query('SELECT COUNT(*) as count FROM webauthn_credentials');
    this.createWebAuthnCredentialStatement = this.db.query(`
      INSERT INTO webauthn_credentials (user_id, credential_id, public_key, sign_count, transports, name, created_at)
      VALUES ($user_id, $credential_id, $public_key, $sign_count, $transports, $name, $created_at)
    `);
    this.getWebAuthnCredentialByCredentialIdStatement = this.db.query('SELECT * FROM webauthn_credentials WHERE credential_id = $credential_id');
    this.updateWebAuthnCredentialCounterStatement = this.db.query(`
      UPDATE webauthn_credentials
      SET sign_count = $sign_count
      WHERE id = $id
    `);
    this.renameWebAuthnCredentialStatement = this.db.query(`
      UPDATE webauthn_credentials
      SET name = $name
      WHERE id = $id AND user_id = $user_id
    `);
    this.deleteWebAuthnCredentialStatement = this.db.query('DELETE FROM webauthn_credentials WHERE id = $id AND user_id = $user_id');
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
    this.listNotificationsPageStatement = this.db.query(`
      SELECT id, created_at, updated_at, rule_id, rule_name, rule_type, severity, title, message, read_at, metadata_json, deliveries_json, dedupe_key
      FROM notifications
      ORDER BY created_at DESC
      LIMIT $limit OFFSET $offset
    `);
    this.countNotificationsStatement = this.db.query('SELECT COUNT(*) as count FROM notifications');
    this.listNotificationIdsStatement = this.db.query(`
      SELECT id
      FROM notifications
      ORDER BY created_at DESC
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
    this.deleteNotificationStatement = this.db.query('DELETE FROM notifications WHERE id = $id');
    this.markNotificationReadStatement = this.db.query('UPDATE notifications SET read_at = $read_at, updated_at = $updated_at WHERE id = $id');
    this.markAllNotificationsReadStatement = this.db.query(`
      UPDATE notifications
      SET read_at = $read_at, updated_at = $updated_at
      WHERE read_at IS NULL
    `);
    this.deleteReadNotificationsStatement = this.db.query('DELETE FROM notifications WHERE read_at IS NOT NULL');
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
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      this.db.close();
    }
  }

  clearSyncData(): void {
    this.db.exec('DELETE FROM alerts');
    this.db.exec('DELETE FROM decisions');
  }

  insertAlert(params: AlertInsertParams): void {
    this.insertAlertStatement.run(params);
  }

  getAllAlerts(): RowWithRawData[] {
    return this.getAllAlertsStatement.all() as RowWithRawData[];
  }

  getAlertsSince(since: string): RowWithRawData[] {
    return this.getAlertsStatement.all({ $since: since }) as RowWithRawData[];
  }

  getAlertsBetween(start: string, end: string): RowWithRawData[] {
    return this.getAlertsBetweenStatement.all({ $start: start, $end: end }) as RowWithRawData[];
  }

  deleteAlertsMissingBetween(start: string, end: string, keepIds: Array<string | number>): { alerts: number; decisions: number } {
    const keepSet = new Set(keepIds.map(String));
    const rows = this.getAlertIdsBetweenStatement.all({ $start: start, $end: end }) as IdRow[];
    const staleIds = rows
      .map((row) => String(row.id))
      .filter((id) => !keepSet.has(id));

    const decisions = runChunkedIdMutation(this.db, 'DELETE FROM decisions WHERE alert_id IN', staleIds);
    const alerts = runChunkedIdMutation(this.db, 'DELETE FROM alerts WHERE id IN', staleIds);
    return { alerts, decisions };
  }

  countAlerts(): number {
    return (this.countAlertsStatement.get() as CountRow).count;
  }

  countDecisions(): number {
    return (this.countDecisionsStatement.get() as CountRow).count;
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

  getAllDecisions(): RowWithRawData[] {
    return this.getAllDecisionsStatement.all() as RowWithRawData[];
  }

  getActiveDecisions(now: string): RowWithRawData[] {
    return this.getActiveDecisionsStatement.all({ $now: now }) as RowWithRawData[];
  }

  deleteActiveAlertsMissing(keepIds: Array<string | number>, now: string, since: string): { alerts: number; decisions: number } {
    const keepSet = new Set(keepIds.map(String));
    const rows = this.getActiveAlertIdsStatement.all({ $now: now, $since: since }) as IdRow[];
    const staleIds = rows
      .map((row) => String(row.id))
      .filter((id) => !keepSet.has(id));

    const decisions = runChunkedIdMutation(this.db, 'DELETE FROM decisions WHERE alert_id IN', staleIds);
    const alerts = runChunkedIdMutation(this.db, 'DELETE FROM alerts WHERE id IN', staleIds);
    return { alerts, decisions };
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

  deleteCachedAlerts(ids: Array<string | number>): { alerts: number; decisions: number } {
    const normalizedIds = ids.map(String);
    const decisions = runChunkedIdMutation(this.db, 'DELETE FROM decisions WHERE alert_id IN', normalizedIds);
    const alerts = runChunkedIdMutation(this.db, 'DELETE FROM alerts WHERE id IN', normalizedIds);
    return { alerts, decisions };
  }

  deleteCachedDecisions(ids: Array<string | number>): number {
    return runChunkedIdMutation(this.db, 'DELETE FROM decisions WHERE id IN', ids.map(String));
  }

  getDecisionById(id: string | number): { raw_data: string; stop_at: string } | null {
    return (this.getDecisionByIdStatement.get({ $id: String(id) }) as { raw_data: string; stop_at: string } | null) || null;
  }

  deleteDecisionsByAlertIdExcept(alertId: string | number, keepIds: string[]): number {
    const keepSet = new Set(keepIds.map(String));
    const rows = this.getDecisionIdsByAlertIdStatement.all({ $alert_id: alertId }) as Array<{ id: string | number }>;
    const staleIds = rows
      .map((row) => String(row.id))
      .filter((id) => !keepSet.has(id));

    if (staleIds.length === 0) {
      return 0;
    }

    let changes = 0;
    const chunkSize = 900;
    for (let offset = 0; offset < staleIds.length; offset += chunkSize) {
      const chunk = staleIds.slice(offset, offset + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const statement = this.db.prepare(`DELETE FROM decisions WHERE id IN (${placeholders})`);
      changes += statement.run(...chunk).changes;
    }

    return changes;
  }

  getDecisionStopAtBatch(ids: string[]): Map<string, string> {
    const result = new Map<string, string>();
    if (ids.length === 0) return result;

    const chunkSize = 900;
    for (let offset = 0; offset < ids.length; offset += chunkSize) {
      const chunk = ids.slice(offset, offset + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const statement = this.db.prepare(`SELECT id, stop_at FROM decisions WHERE id IN (${placeholders})`);
      const rows = statement.all(...chunk) as Array<{ id: string; stop_at: string }>;
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

  isAuthMigrationDefaultDisabled(): boolean {
    return this.getMeta('auth_existing_install_default_disabled')?.value === 'true';
  }

  countAuthUsers(): number {
    return (this.countAuthUsersStatement.get() as CountRow).count;
  }

  createAuthUser(params: {
    username: string;
    passwordHash: string | null;
    role: 'admin' | 'read-only';
    authProvider: 'password' | 'oidc';
  }): number {
    const now = new Date().toISOString();
    const result = this.createAuthUserStatement.run({
      $username: params.username,
      $password_hash: params.passwordHash,
      $role: params.role,
      $auth_provider: params.authProvider,
      $created_at: now,
      $updated_at: now,
    }) as { lastInsertRowid?: number | bigint };
    return Number(result.lastInsertRowid);
  }

  getAuthUserById(id: number): AuthUserRow | null {
    return (this.getAuthUserByIdStatement.get({ $id: id }) as AuthUserRow | null) || null;
  }

  getAuthUserByUsername(username: string): AuthUserRow | null {
    return (this.getAuthUserByUsernameStatement.get({ $username: username }) as AuthUserRow | null) || null;
  }

  updateAuthUserPassword(id: number, passwordHash: string): boolean {
    return this.updateAuthUserPasswordStatement.run({
      $id: id,
      $password_hash: passwordHash,
      $updated_at: new Date().toISOString(),
    }).changes > 0;
  }

  updateAuthUserTotp(id: number, secret: string | null, enabled: boolean): boolean {
    return this.updateAuthUserTotpStatement.run({
      $id: id,
      $totp_secret: secret,
      $totp_enabled: enabled ? 1 : 0,
      $updated_at: new Date().toISOString(),
    }).changes > 0;
  }

  upsertOidcUser(username: string, role: 'admin' | 'read-only'): AuthUserRow {
    const now = new Date().toISOString();
    this.upsertOidcUserStatement.run({
      $username: username,
      $role: role,
      $created_at: now,
      $updated_at: now,
    });
    return this.getAuthUserByUsername(username)!;
  }

  listWebAuthnCredentialsByUser(userId: number): WebAuthnCredentialRow[] {
    return this.listWebAuthnCredentialsByUserStatement.all({ $user_id: userId }) as WebAuthnCredentialRow[];
  }

  countWebAuthnCredentials(): number {
    return (this.countWebAuthnCredentialsStatement.get() as CountRow).count;
  }

  createWebAuthnCredential(params: {
    userId: number;
    credentialId: string;
    publicKey: string;
    signCount: number;
    transports: string | null;
    name: string | null;
  }): number {
    const result = this.createWebAuthnCredentialStatement.run({
      $user_id: params.userId,
      $credential_id: params.credentialId,
      $public_key: params.publicKey,
      $sign_count: params.signCount,
      $transports: params.transports,
      $name: params.name,
      $created_at: new Date().toISOString(),
    }) as { lastInsertRowid?: number | bigint };
    return Number(result.lastInsertRowid);
  }

  getWebAuthnCredentialByCredentialId(credentialId: string): WebAuthnCredentialRow | null {
    return (this.getWebAuthnCredentialByCredentialIdStatement.get({ $credential_id: credentialId }) as WebAuthnCredentialRow | null) || null;
  }

  updateWebAuthnCredentialCounter(id: number, signCount: number): void {
    this.updateWebAuthnCredentialCounterStatement.run({ $id: id, $sign_count: signCount });
  }

  renameWebAuthnCredential(id: number, userId: number, name: string | null): boolean {
    return this.renameWebAuthnCredentialStatement.run({ $id: id, $user_id: userId, $name: name }).changes > 0;
  }

  deleteWebAuthnCredential(id: number, userId: number): boolean {
    return this.deleteWebAuthnCredentialStatement.run({ $id: id, $user_id: userId }).changes > 0;
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

  listNotificationsPage(page: number, pageSize: number): JsonRow[] {
    const safePage = Math.max(1, page);
    const safePageSize = Math.max(1, pageSize);
    return this.listNotificationsPageStatement.all({
      $limit: safePageSize,
      $offset: (safePage - 1) * safePageSize,
    }) as JsonRow[];
  }

  listNotifications(limit = 100): JsonRow[] {
    return this.listNotificationsPage(1, limit);
  }

  countNotifications(): number {
    return (this.countNotificationsStatement.get() as CountRow).count;
  }

  listNotificationIds(): string[] {
    return (this.listNotificationIdsStatement.all() as Array<{ id: string }>).map((row) => String(row.id));
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

  deleteNotification(id: string): boolean {
    return this.deleteNotificationStatement.run({ $id: id }).changes > 0;
  }

  deleteNotifications(ids: string[]): number {
    return runChunkedIdMutation(this.db, 'DELETE FROM notifications WHERE id IN', ids);
  }

  markNotificationRead(id: string, readAt: string): boolean {
    return this.markNotificationReadStatement.run({ $id: id, $read_at: readAt, $updated_at: readAt }).changes > 0;
  }

  markNotificationsRead(ids: string[], readAt: string): number {
    return runChunkedIdMutation(
      this.db,
      'UPDATE notifications SET read_at = ?, updated_at = ? WHERE read_at IS NULL AND id IN',
      ids,
      [readAt, readAt],
    );
  }

  markAllNotificationsRead(readAt: string): number {
    return this.markAllNotificationsReadStatement.run({ $read_at: readAt, $updated_at: readAt }).changes;
  }

  deleteReadNotifications(): number {
    return this.deleteReadNotificationsStatement.run().changes;
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

function runChunkedIdMutation(db: Database, statementPrefix: string, ids: string[], leadingParams: unknown[] = []): number {
  if (ids.length === 0) {
    return 0;
  }

  let changes = 0;
  const chunkSize = 900;
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    const chunk = ids.slice(offset, offset + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    const statement = db.prepare(`${statementPrefix} (${placeholders})`);
    changes += statement.run(...leadingParams, ...chunk).changes;
  }

  return changes;
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
    database.exec('PRAGMA foreign_keys = ON');
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

function isDatabaseFresh(db: Database): boolean {
  const row = db.query(`
    SELECT COUNT(*) AS count
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
  `).get() as CountRow;
  return row.count === 0;
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

function initSchema(db: Database, freshDatabase: boolean): void {
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

  const createAuthUsersTable = `
    CREATE TABLE IF NOT EXISTS auth_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      totp_secret TEXT,
      totp_enabled INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT 'admin',
      auth_provider TEXT NOT NULL DEFAULT 'password',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_users_username ON auth_users(username);
  `;

  const createWebAuthnCredentialsTable = `
    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      credential_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      sign_count INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      name TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user_id ON webauthn_credentials(user_id);
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
  db.exec(`
    INSERT OR IGNORE INTO meta (key, value)
    VALUES ('auth_existing_install_default_disabled', '${freshDatabase ? 'false' : 'true'}')
  `);
  db.exec(createAuthUsersTable);
  db.exec(createWebAuthnCredentialsTable);
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
  migrateAuthUsersTable(db);
  db.exec(createNotificationIncidentsTable);
  seedNotificationIncidentsFromHistoryIfEmpty(db);
}

function migrateAuthUsersTable(db: Database): void {
  const columns = db.query('PRAGMA table_info(auth_users)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'totp_secret')) {
    db.exec('ALTER TABLE auth_users ADD COLUMN totp_secret TEXT');
  }
  if (!columns.some((column) => column.name === 'totp_enabled')) {
    db.exec('ALTER TABLE auth_users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0');
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
  if (ruleType === 'lapi-availability') {
    return normalized.startsWith('lapi-availability:') ? normalized : null;
  }

  return normalized || null;
}
