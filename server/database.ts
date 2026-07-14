import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import type { AlertDecision, AlertRecord } from '../shared/contracts';
import { matchesIpSearchValue } from '../shared/search';
import { deriveAlertIndexValues, deriveAlertIndexValuesFromRecord, deriveDecisionIndexValues, deriveDecisionIndexValuesFromRecord } from './record-index';

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
  function?: (name: string, optionsOrFn: unknown, fn?: (...args: unknown[]) => unknown) => void;
};

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

const SYNC_SECONDARY_INDEX_NAMES = [
  'idx_alerts_created_at',
  'idx_alerts_country',
  'idx_alerts_scenario',
  'idx_alerts_as_name',
  'idx_alerts_target',
  'idx_alerts_source_ip',
  'idx_alerts_simulated',
  'idx_alerts_simulated_created_at',
  'idx_alerts_country_created_at',
  'idx_alerts_scenario_created_at',
  'idx_decisions_stop_at',
  'idx_decisions_alert_id',
  'idx_decisions_value',
  'idx_decisions_created_at',
  'idx_decisions_stop_alert_id',
  'idx_decisions_value_stop_at',
  'idx_decisions_country',
  'idx_decisions_scenario',
  'idx_decisions_as_name',
  'idx_decisions_target',
  'idx_decisions_simulated',
  'idx_decisions_simulated_created_at',
  'idx_decisions_alert_created_id',
  'idx_decisions_duplicate_active',
  'idx_decisions_duplicate_created_at',
  'idx_decisions_duplicate_primary',
] as const;

const CREATE_SYNC_SECONDARY_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at);
  CREATE INDEX IF NOT EXISTS idx_alerts_country ON alerts(country);
  CREATE INDEX IF NOT EXISTS idx_alerts_scenario ON alerts(scenario);
  CREATE INDEX IF NOT EXISTS idx_alerts_as_name ON alerts(as_name);
  CREATE INDEX IF NOT EXISTS idx_alerts_target ON alerts(target);
  CREATE INDEX IF NOT EXISTS idx_alerts_source_ip ON alerts(source_ip);
  CREATE INDEX IF NOT EXISTS idx_alerts_simulated ON alerts(simulated);
  CREATE INDEX IF NOT EXISTS idx_alerts_simulated_created_at ON alerts(simulated, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_alerts_country_created_at ON alerts(country, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_alerts_scenario_created_at ON alerts(scenario, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_decisions_stop_at ON decisions(stop_at);
  CREATE INDEX IF NOT EXISTS idx_decisions_alert_id ON decisions(alert_id);
  CREATE INDEX IF NOT EXISTS idx_decisions_value ON decisions(value);
  CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions(created_at);
  CREATE INDEX IF NOT EXISTS idx_decisions_stop_alert_id ON decisions(stop_at, alert_id);
  CREATE INDEX IF NOT EXISTS idx_decisions_value_stop_at ON decisions(value, stop_at DESC);
  CREATE INDEX IF NOT EXISTS idx_decisions_country ON decisions(country);
  CREATE INDEX IF NOT EXISTS idx_decisions_scenario ON decisions(scenario);
  CREATE INDEX IF NOT EXISTS idx_decisions_as_name ON decisions(as_name);
  CREATE INDEX IF NOT EXISTS idx_decisions_target ON decisions(target);
  CREATE INDEX IF NOT EXISTS idx_decisions_simulated ON decisions(simulated);
  CREATE INDEX IF NOT EXISTS idx_decisions_simulated_created_at ON decisions(simulated, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_decisions_alert_created_id ON decisions(alert_id, created_at DESC, id DESC, stop_at);
  CREATE INDEX IF NOT EXISTS idx_decisions_duplicate_active ON decisions(is_duplicate, stop_at, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_decisions_duplicate_created_at ON decisions(is_duplicate, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_decisions_duplicate_primary ON decisions(value, simulated, stop_at DESC, id);
`;

export interface AlertInsertParams {
  $id: string | number;
  $uuid: string;
  $created_at: string;
  $scenario?: string;
  $source_ip?: string;
  $message: string;
  $raw_data: string;
  $record?: AlertRecord;
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
  $record?: AlertDecision & Record<string, unknown>;
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
export type DecisionDataRow = { raw_data: string; stop_at: string; alert_id?: string | number | null };
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
  totp_last_step: number | null;
  role: 'admin' | 'read-only';
  auth_provider: 'password' | 'oidc';
  oidc_issuer: string | null;
  oidc_subject: string | null;
  session_version: number;
  created_at: string;
  updated_at: string;
}

export interface OidcUserUpsertParams {
  username: string;
  role: 'admin' | 'read-only';
  issuer: string;
  subject: string;
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
  public readonly dbPath: string;
  public readonly searchIndexAvailable: boolean;
  private searchIndexUpdatesDeferred = false;
  private decisionDuplicateFlagsDirty = true;

  private readonly insertAlertStatement: any;
  private readonly getAllAlertsStatement: any;
  private readonly getAlertsStatement: any;
  private readonly getAlertsBetweenStatement: any;
  private readonly getAlertIdsBetweenStatement: any;
  private readonly countAlertsStatement: any;
  private readonly countDecisionsStatement: any;
  private readonly insertDecisionStatement: any;
  private readonly updateDecisionStatement: any;
  private readonly getAllDecisionsStatement: any;
  private readonly getActiveDecisionsStatement: any;
  private readonly getActiveAlertIdsStatement: any;
  private readonly getDecisionsSinceStatement: any;
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
  private readonly getAuthUserByOidcIdentityStatement: any;
  private readonly updateAuthUserPasswordStatement: any;
  private readonly updateAuthUserTotpStatement: any;
  private readonly updateAuthUserTotpLastStepStatement: any;
  private readonly createOidcUserStatement: any;
  private readonly updateOidcUserStatement: any;
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
  private readonly deleteAlertSearchIndexStatement: any | null;
  private readonly insertAlertSearchIndexStatement: any | null;
  private readonly deleteDecisionSearchIndexStatement: any | null;
  private readonly insertDecisionSearchIndexStatement: any | null;

  constructor(options: DatabaseOptions = {}) {
    const resolvedPath = resolveDatabasePath(options);
    this.dbPath = resolvedPath;
    this.db = openDatabase(resolvedPath);
    const freshDatabase = isDatabaseFresh(this.db);
    this.searchIndexAvailable = initSchema(this.db, freshDatabase);

    this.insertAlertStatement = this.db.query(`
      INSERT INTO alerts (
        id, uuid, created_at, scenario, source_ip, message, raw_data,
        country, country_name, as_name, target, machine, meta_search, origins, simulated, search_text
      )
      VALUES (
        $id, $uuid, $created_at, $scenario, $source_ip, $message, $raw_data,
        $country, $country_name, $as_name, $target, $machine, $meta_search, $origins, $simulated, $search_text
      )
      ON CONFLICT(id) DO UPDATE SET
        uuid = excluded.uuid,
        created_at = excluded.created_at,
        scenario = excluded.scenario,
        source_ip = excluded.source_ip,
        message = excluded.message,
        raw_data = excluded.raw_data,
        country = excluded.country,
        country_name = excluded.country_name,
        as_name = excluded.as_name,
        target = excluded.target,
        machine = excluded.machine,
        meta_search = excluded.meta_search,
        origins = excluded.origins,
        simulated = excluded.simulated,
        search_text = excluded.search_text
      WHERE alerts.uuid IS NOT excluded.uuid
        OR alerts.created_at IS NOT excluded.created_at
        OR alerts.scenario IS NOT excluded.scenario
        OR alerts.source_ip IS NOT excluded.source_ip
        OR alerts.message IS NOT excluded.message
        OR alerts.raw_data IS NOT excluded.raw_data
        OR alerts.country IS NOT excluded.country
        OR alerts.country_name IS NOT excluded.country_name
        OR alerts.as_name IS NOT excluded.as_name
        OR alerts.target IS NOT excluded.target
        OR alerts.machine IS NOT excluded.machine
        OR alerts.meta_search IS NOT excluded.meta_search
        OR alerts.origins IS NOT excluded.origins
        OR alerts.simulated IS NOT excluded.simulated
        OR alerts.search_text IS NOT excluded.search_text
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

    this.insertDecisionStatement = this.db.query(`
      INSERT INTO decisions (
        id, uuid, alert_id, created_at, stop_at, value, type, origin, scenario, raw_data,
        country, country_name, as_name, target, machine, simulated, search_text, is_duplicate
      )
      VALUES (
        $id, $uuid, $alert_id, $created_at, $stop_at, $value, $type, $origin, $scenario, $raw_data,
        $country, $country_name, $as_name, $target, $machine, $simulated, $search_text, 0
      )
      ON CONFLICT(id) DO UPDATE SET
        uuid = excluded.uuid,
        alert_id = excluded.alert_id,
        created_at = excluded.created_at,
        stop_at = excluded.stop_at,
        value = excluded.value,
        type = excluded.type,
        origin = excluded.origin,
        scenario = excluded.scenario,
        raw_data = excluded.raw_data,
        country = excluded.country,
        country_name = excluded.country_name,
        as_name = excluded.as_name,
        target = excluded.target,
        machine = excluded.machine,
        simulated = excluded.simulated,
        search_text = excluded.search_text,
        is_duplicate = 0
      WHERE decisions.uuid IS NOT excluded.uuid
        OR decisions.alert_id IS NOT excluded.alert_id
        OR decisions.created_at IS NOT excluded.created_at
        OR decisions.stop_at IS NOT excluded.stop_at
        OR decisions.value IS NOT excluded.value
        OR decisions.type IS NOT excluded.type
        OR decisions.origin IS NOT excluded.origin
        OR decisions.scenario IS NOT excluded.scenario
        OR decisions.raw_data IS NOT excluded.raw_data
        OR decisions.country IS NOT excluded.country
        OR decisions.country_name IS NOT excluded.country_name
        OR decisions.as_name IS NOT excluded.as_name
        OR decisions.target IS NOT excluded.target
        OR decisions.machine IS NOT excluded.machine
        OR decisions.simulated IS NOT excluded.simulated
        OR decisions.search_text IS NOT excluded.search_text
    `);

    this.updateDecisionStatement = this.db.query(`
      UPDATE decisions SET
        stop_at = $stop_at,
        raw_data = $raw_data,
        country = $country,
        country_name = $country_name,
        as_name = $as_name,
        target = $target,
        machine = $machine,
        simulated = $simulated,
        search_text = $search_text
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
      SELECT DISTINCT active.alert_id AS id
      FROM decisions AS active INDEXED BY idx_decisions_stop_alert_id
      WHERE active.stop_at > $now
        AND active.alert_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM alerts
          WHERE alerts.id = active.alert_id
            AND alerts.created_at >= $since
        )
    `);

    this.getDecisionsSinceStatement = this.db.query(`
      SELECT raw_data, created_at, alert_id FROM decisions
      WHERE created_at >= $since OR stop_at > $now
      ORDER BY stop_at DESC
    `);

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
    this.getAuthUserByOidcIdentityStatement = this.db.query(`
      SELECT * FROM auth_users
      WHERE oidc_issuer = $oidc_issuer AND oidc_subject = $oidc_subject
    `);
    this.updateAuthUserPasswordStatement = this.db.query(`
      UPDATE auth_users
      SET password_hash = $password_hash,
          session_version = session_version + 1,
          updated_at = $updated_at
      WHERE id = $id
    `);
    this.updateAuthUserTotpStatement = this.db.query(`
      UPDATE auth_users
      SET totp_secret = $totp_secret, totp_enabled = $totp_enabled, totp_last_step = $totp_last_step, updated_at = $updated_at
      WHERE id = $id
    `);
    this.updateAuthUserTotpLastStepStatement = this.db.query(`
      UPDATE auth_users
      SET totp_last_step = $totp_last_step, updated_at = $updated_at
      WHERE id = $id AND (totp_last_step IS NULL OR totp_last_step < $totp_last_step)
    `);
    this.createOidcUserStatement = this.db.query(`
      INSERT INTO auth_users (
        username, password_hash, role, auth_provider, oidc_issuer, oidc_subject, created_at, updated_at
      )
      VALUES ($username, NULL, $role, 'oidc', $oidc_issuer, $oidc_subject, $created_at, $updated_at)
    `);
    this.updateOidcUserStatement = this.db.query(`
      UPDATE auth_users
      SET username = $username,
          role = $role,
          auth_provider = 'oidc',
          oidc_issuer = $oidc_issuer,
          oidc_subject = $oidc_subject,
          session_version = CASE WHEN role IS NOT $role THEN session_version + 1 ELSE session_version END,
          updated_at = $updated_at
      WHERE id = $id
    `);
    this.listWebAuthnCredentialsByUserStatement = this.db.query(`
      SELECT * FROM webauthn_credentials
      WHERE user_id = $user_id
      ORDER BY created_at DESC
    `);
    this.countWebAuthnCredentialsStatement = this.db.query(`
      SELECT COUNT(*) as count
      FROM webauthn_credentials credentials
      JOIN auth_users users ON users.id = credentials.user_id
      WHERE users.auth_provider <> 'oidc' OR users.password_hash IS NOT NULL
    `);
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
    this.deleteAlertSearchIndexStatement = this.searchIndexAvailable
      ? this.db.prepare('DELETE FROM alerts_fts WHERE alert_id = ?')
      : null;
    this.insertAlertSearchIndexStatement = this.searchIndexAvailable
      ? this.db.prepare('INSERT INTO alerts_fts(rowid, alert_id, search_text) VALUES (?, ?, ?)')
      : null;
    this.deleteDecisionSearchIndexStatement = this.searchIndexAvailable
      ? this.db.prepare('DELETE FROM decisions_fts WHERE decision_id = ?')
      : null;
    this.insertDecisionSearchIndexStatement = this.searchIndexAvailable
      ? this.db.prepare('INSERT INTO decisions_fts(decision_id, search_text) VALUES (?, ?)')
      : null;
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
    this.decisionDuplicateFlagsDirty = true;
    this.clearSearchIndexes();
  }

  beginDeferredSearchIndexUpdates(): void {
    this.searchIndexUpdatesDeferred = true;
    if (this.searchIndexAvailable) this.clearSearchIndexes();
    for (const indexName of SYNC_SECONDARY_INDEX_NAMES) {
      this.db.exec(`DROP INDEX IF EXISTS ${indexName}`);
    }
  }

  rebuildSearchIndexes(): void {
    try {
      this.db.exec(CREATE_SYNC_SECONDARY_INDEXES_SQL);
      if (this.searchIndexAvailable) {
        this.clearSearchIndexes();
        backfillSearchIndexes(this.db);
      }
    } finally {
      this.searchIndexUpdatesDeferred = false;
    }
  }

  async rebuildSearchIndexesCooperative(yieldControl: () => Promise<void>, batchSize = 1_000): Promise<void> {
    if (!this.searchIndexAvailable) return;
    try {
      this.clearSearchIndexes();
      await backfillSearchIndexesCooperative(this.db, yieldControl, batchSize);
    } finally {
      this.searchIndexUpdatesDeferred = false;
    }
  }

  insertAlert(params: AlertInsertParams): boolean {
    const fallback = {
      createdAt: params.$created_at,
      scenario: params.$scenario,
      sourceIp: params.$source_ip,
      message: params.$message,
    };
    const index = params.$record
      ? deriveAlertIndexValuesFromRecord(params.$record, fallback)
      : deriveAlertIndexValues(params.$raw_data, fallback);
    const { $record, ...dbParams } = params;
    const result = this.insertAlertStatement.run({
      ...dbParams,
      $created_at: index.historyAt,
      $scenario: index.scenario ?? params.$scenario,
      $source_ip: index.sourceIp ?? params.$source_ip,
      $country: index.country,
      $country_name: index.countryName,
      $as_name: index.asName,
      $target: index.target,
      $machine: index.machine,
      $meta_search: index.metaSearch,
      $origins: index.origins,
      $simulated: index.simulated,
      $search_text: index.searchText,
    });
    if (result.changes > 0) {
      this.upsertAlertSearchIndex(params.$id, index.searchText);
      return true;
    }
    return false;
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

    this.deleteDecisionSearchIndexesByAlertIds(staleIds);
    const decisions = runChunkedIdMutation(this.db, 'DELETE FROM decisions WHERE alert_id IN', staleIds);
    const alerts = runChunkedIdMutation(this.db, 'DELETE FROM alerts WHERE id IN', staleIds);
    if (decisions > 0) this.decisionDuplicateFlagsDirty = true;
    this.deleteAlertSearchIndexes(staleIds);
    return { alerts, decisions };
  }

  countAlerts(): number {
    return (this.countAlertsStatement.get() as CountRow).count;
  }

  countDecisions(): number {
    return (this.countDecisionsStatement.get() as CountRow).count;
  }

  deleteOldAlerts(cutoff: string): number {
    let changes = 0;
    const selectOldAlerts = this.db.prepare('SELECT id FROM alerts WHERE created_at < ? LIMIT 900');
    while (true) {
      const ids = (selectOldAlerts.all(cutoff) as IdRow[]).map((row) => String(row.id));
      if (ids.length === 0) break;
      changes += runChunkedIdMutation(this.db, 'DELETE FROM alerts WHERE id IN', ids);
      this.deleteAlertSearchIndexes(ids);
    }
    return changes;
  }

  insertDecision(params: DecisionInsertParams): boolean {
    const fallback = {
      value: params.$value,
      type: params.$type,
      origin: params.$origin,
      scenario: params.$scenario,
    };
    const index = params.$record
      ? deriveDecisionIndexValuesFromRecord(params.$record, fallback)
      : deriveDecisionIndexValues(params.$raw_data, fallback);
    const { $record, ...dbParams } = params;
    const result = this.insertDecisionStatement.run({
      ...dbParams,
      $country: index.country,
      $country_name: index.countryName,
      $as_name: index.asName,
      $target: index.target,
      $machine: index.machine,
      $simulated: index.simulated,
      $search_text: index.searchText,
    });
    if (result.changes > 0) {
      this.decisionDuplicateFlagsDirty = true;
      this.upsertDecisionSearchIndex(params.$id, index.searchText);
      return true;
    }
    return false;
  }

  updateDecision(params: DecisionUpdateParams): void {
    const existing = this.getDecisionById(params.$id);
    let fallback: { value?: string | null; type?: string | null; origin?: string | null; scenario?: string | null } = {};
    if (existing?.raw_data) {
      try {
        const parsed = JSON.parse(existing.raw_data) as Record<string, unknown>;
        fallback = {
          value: typeof parsed.value === 'string' ? parsed.value : null,
          type: typeof parsed.type === 'string' ? parsed.type : null,
          origin: typeof parsed.origin === 'string' ? parsed.origin : null,
          scenario: typeof parsed.scenario === 'string' ? parsed.scenario : null,
        };
      } catch {
        fallback = {};
      }
    }
    const index = deriveDecisionIndexValues(params.$raw_data, fallback);
    this.updateDecisionStatement.run({
      ...params,
      $country: index.country,
      $country_name: index.countryName,
      $as_name: index.asName,
      $target: index.target,
      $machine: index.machine,
      $simulated: index.simulated,
      $search_text: index.searchText,
    });
    this.decisionDuplicateFlagsDirty = true;
    this.upsertDecisionSearchIndex(params.$id, index.searchText);
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

    this.deleteDecisionSearchIndexesByAlertIds(staleIds);
    const decisions = runChunkedIdMutation(this.db, 'DELETE FROM decisions WHERE alert_id IN', staleIds);
    const alerts = runChunkedIdMutation(this.db, 'DELETE FROM alerts WHERE id IN', staleIds);
    if (decisions > 0) this.decisionDuplicateFlagsDirty = true;
    this.deleteAlertSearchIndexes(staleIds);
    return { alerts, decisions };
  }

  getDecisionsSince(since: string, now: string): RowWithRawData[] {
    return this.getDecisionsSinceStatement.all({ $since: since, $now: now }) as RowWithRawData[];
  }

  deleteOldDecisions(cutoff: string): number {
    let changes = 0;
    const selectOldDecisions = this.db.prepare('SELECT id FROM decisions WHERE stop_at < ? LIMIT 900');
    while (true) {
      const ids = (selectOldDecisions.all(cutoff) as IdRow[]).map((row) => String(row.id));
      if (ids.length === 0) break;
      changes += runChunkedIdMutation(this.db, 'DELETE FROM decisions WHERE id IN', ids);
      this.deleteDecisionSearchIndexes(ids);
    }
    if (changes > 0) this.decisionDuplicateFlagsDirty = true;
    return changes;
  }

  deleteDecision(id: string | number): void {
    this.deleteDecisionStatement.run({ $id: String(id) });
    this.decisionDuplicateFlagsDirty = true;
    this.deleteDecisionSearchIndex(id);
  }

  deleteCachedAlerts(ids: Array<string | number>): { alerts: number; decisions: number } {
    const normalizedIds = ids.map(String);
    this.deleteDecisionSearchIndexesByAlertIds(normalizedIds);
    const decisions = runChunkedIdMutation(this.db, 'DELETE FROM decisions WHERE alert_id IN', normalizedIds);
    const alerts = runChunkedIdMutation(this.db, 'DELETE FROM alerts WHERE id IN', normalizedIds);
    if (decisions > 0) this.decisionDuplicateFlagsDirty = true;
    this.deleteAlertSearchIndexes(normalizedIds);
    return { alerts, decisions };
  }

  deleteCachedDecisions(ids: Array<string | number>): number {
    const normalizedIds = ids.map(String);
    const changes = runChunkedIdMutation(this.db, 'DELETE FROM decisions WHERE id IN', normalizedIds);
    if (changes > 0) this.decisionDuplicateFlagsDirty = true;
    this.deleteDecisionSearchIndexes(normalizedIds);
    return changes;
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
      this.deleteDecisionSearchIndexes(chunk);
    }

    if (changes > 0) this.decisionDuplicateFlagsDirty = true;
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

  getDecisionDataBatch(ids: string[]): Map<string, DecisionDataRow> {
    const result = new Map<string, DecisionDataRow>();
    if (ids.length === 0) return result;

    const uniqueIds = Array.from(new Set(ids));
    const chunkSize = 900;
    for (let offset = 0; offset < uniqueIds.length; offset += chunkSize) {
      const chunk = uniqueIds.slice(offset, offset + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT id, raw_data, stop_at, alert_id
        FROM decisions
        WHERE id IN (${placeholders})
      `).all(...chunk) as Array<DecisionDataRow & { id: string | number }>;
      for (const row of rows) {
        result.set(String(row.id), {
          raw_data: row.raw_data,
          stop_at: row.stop_at,
          alert_id: row.alert_id,
        });
      }
    }

    return result;
  }

  getActiveDecisionByValue(value: string, now: string): { raw_data: string; stop_at: string } | null {
    return (this.getActiveDecisionByValueStatement.get({ $value: value, $now: now }) as { raw_data: string; stop_at: string } | null) || null;
  }

  deleteAlert(id: string | number): void {
    this.deleteAlertStatement.run({ $id: id });
    this.deleteAlertSearchIndex(id);
  }

  deleteDecisionsByAlertId(alertId: string | number): void {
    this.deleteDecisionSearchIndexesByAlertIds([String(alertId)]);
    const result = this.deleteDecisionsByAlertIdStatement.run({ $alert_id: alertId });
    if (result.changes > 0) this.decisionDuplicateFlagsDirty = true;
  }

  refreshDecisionDuplicateFlags(now: string, force = false): number {
    if (!force && !this.decisionDuplicateFlagsDirty) return 0;

    const result = this.db.prepare(`
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(value, ''), simulated
            ORDER BY
              stop_at DESC,
              CASE WHEN id GLOB '[0-9]*' THEN CAST(id AS INTEGER) ELSE 9223372036854775807 END ASC
          ) AS duplicate_rank
        FROM decisions
        WHERE stop_at > ?
      ), desired AS (
        SELECT
          decisions.id,
          CASE WHEN ranked.duplicate_rank > 1 THEN 1 ELSE 0 END AS is_duplicate
        FROM decisions
        LEFT JOIN ranked ON ranked.id = decisions.id
      )
      UPDATE decisions
      SET is_duplicate = desired.is_duplicate
      FROM desired
      WHERE decisions.id = desired.id
        AND decisions.is_duplicate <> desired.is_duplicate
    `).run(now);
    this.decisionDuplicateFlagsDirty = false;
    return result.changes;
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
      $totp_last_step: null,
      $updated_at: new Date().toISOString(),
    }).changes > 0;
  }

  updateAuthUserTotpLastStep(id: number, lastStep: number): boolean {
    return this.updateAuthUserTotpLastStepStatement.run({
      $id: id,
      $totp_last_step: lastStep,
      $updated_at: new Date().toISOString(),
    }).changes > 0;
  }

  upsertOidcUser(params: OidcUserUpsertParams): AuthUserRow {
    const now = new Date().toISOString();
    let user = this.getAuthUserByOidcIdentityStatement.get({
      $oidc_issuer: params.issuer,
      $oidc_subject: params.subject,
    }) as AuthUserRow | null;

    // Claim a pre-migration OIDC row on its first login. Never claim a row that
    // still has a local password, because older releases could merge an OIDC
    // identity into a local account when their usernames matched.
    if (!user) {
      const legacy = this.getAuthUserByUsername(params.username);
      if (legacy?.auth_provider === 'oidc' && !legacy.oidc_subject && !legacy.password_hash) {
        user = legacy;
      }
    }

    const usernameOwner = this.getAuthUserByUsername(params.username);
    const identitySuffix = crypto
      .createHash('sha256')
      .update(`${params.issuer}\n${params.subject}`, 'utf8')
      .digest('hex')
      .slice(0, 10);
    const storedUsername = !usernameOwner || usernameOwner.id === user?.id
      ? params.username
      : `${params.username}#oidc-${identitySuffix}`;

    if (!user) {
      const result = this.createOidcUserStatement.run({
        $username: storedUsername,
        $role: params.role,
        $oidc_issuer: params.issuer,
        $oidc_subject: params.subject,
        $created_at: now,
        $updated_at: now,
      }) as { lastInsertRowid?: number | bigint };
      return this.getAuthUserById(Number(result.lastInsertRowid))!;
    }

    this.updateOidcUserStatement.run({
      $id: user.id,
      $username: storedUsername,
      $role: params.role,
      $oidc_issuer: params.issuer,
      $oidc_subject: params.subject,
      $updated_at: now,
    });
    return this.getAuthUserById(user.id)!;
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

  private clearSearchIndexes(): void {
    if (!this.searchIndexAvailable) return;
    this.runSearchIndexStatement('DELETE FROM alerts_fts');
    this.runSearchIndexStatement('DELETE FROM decisions_fts');
  }

  private upsertAlertSearchIndex(id: string | number, searchText: string): void {
    if (this.searchIndexUpdatesDeferred) return;
    if (!this.searchIndexAvailable || !this.deleteAlertSearchIndexStatement || !this.insertAlertSearchIndexStatement) return;
    const numericId = Number(id);
    if (!Number.isSafeInteger(numericId) || numericId < 1) return;
    try {
      this.deleteAlertSearchIndexStatement.run(String(id));
      this.insertAlertSearchIndexStatement.run(numericId, String(id), searchText);
    } catch {
      // Search indexing is an optimization; core table data remains authoritative.
    }
  }

  private upsertDecisionSearchIndex(id: string | number, searchText: string): void {
    if (this.searchIndexUpdatesDeferred) return;
    if (!this.searchIndexAvailable || !this.deleteDecisionSearchIndexStatement || !this.insertDecisionSearchIndexStatement) return;
    try {
      this.deleteDecisionSearchIndexStatement.run(String(id));
      this.insertDecisionSearchIndexStatement.run(String(id), searchText);
    } catch {
      // Search indexing is an optimization; core table data remains authoritative.
    }
  }

  private deleteAlertSearchIndex(id: string | number): void {
    if (this.searchIndexUpdatesDeferred) return;
    if (!this.searchIndexAvailable || !this.deleteAlertSearchIndexStatement) return;
    try {
      this.deleteAlertSearchIndexStatement.run(String(id));
    } catch {
      // Search indexing is an optimization; core table data remains authoritative.
    }
  }

  private deleteAlertSearchIndexes(ids: string[]): void {
    if (this.searchIndexUpdatesDeferred) return;
    if (!this.searchIndexAvailable || ids.length === 0) return;
    runChunkedIdMutation(this.db, 'DELETE FROM alerts_fts WHERE alert_id IN', ids);
  }

  private deleteDecisionSearchIndex(id: string | number): void {
    if (this.searchIndexUpdatesDeferred) return;
    if (!this.searchIndexAvailable || !this.deleteDecisionSearchIndexStatement) return;
    try {
      this.deleteDecisionSearchIndexStatement.run(String(id));
    } catch {
      // Search indexing is an optimization; core table data remains authoritative.
    }
  }

  private deleteDecisionSearchIndexes(ids: string[]): void {
    if (this.searchIndexUpdatesDeferred) return;
    if (!this.searchIndexAvailable || ids.length === 0) return;
    runChunkedIdMutation(this.db, 'DELETE FROM decisions_fts WHERE decision_id IN', ids);
  }

  private deleteDecisionSearchIndexesByAlertIds(alertIds: string[]): void {
    if (this.searchIndexUpdatesDeferred) return;
    if (!this.searchIndexAvailable || alertIds.length === 0) return;
    const decisionIds: string[] = [];
    const chunkSize = 900;
    for (let offset = 0; offset < alertIds.length; offset += chunkSize) {
      const chunk = alertIds.slice(offset, offset + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(`SELECT id FROM decisions WHERE alert_id IN (${placeholders})`).all(...chunk) as Array<{ id: string | number }>;
      decisionIds.push(...rows.map((row) => String(row.id)));
    }
    this.deleteDecisionSearchIndexes(decisionIds);
  }

  private runSearchIndexStatement(sql: string, ...params: unknown[]): void {
    try {
      this.db.prepare(sql).run(...params);
    } catch {
      // Search indexing is an optimization; core table data remains authoritative.
    }
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
    registerDatabaseFunctions(database);
    return database;
  } catch (error: any) {
    if (dbPath.startsWith('/app/data') && error?.code === 'EACCES') {
      return createDatabase('crowdsec.db');
    }
    throw error;
  }
}

function registerDatabaseFunctions(database: Database): void {
  try {
    database.function?.('matches_ip_search_value', { deterministic: true }, (candidate: unknown, value: unknown) =>
      matchesIpSearchValue(candidate as string | number | null | undefined, String(value ?? '')) ? 1 : 0,
    );
  } catch {
    // Older better-sqlite3 builds may not expose custom functions; SQL callers also keep LIKE fallbacks.
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

function initSchema(db: Database, freshDatabase: boolean): boolean {
  const createAlertsTable = `
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY,
      uuid TEXT UNIQUE,
      created_at TEXT NOT NULL,
      scenario TEXT,
      source_ip TEXT,
      message TEXT,
      raw_data TEXT,
      country TEXT,
      country_name TEXT,
      as_name TEXT,
      target TEXT,
      machine TEXT,
      meta_search TEXT,
      origins TEXT,
      simulated INTEGER NOT NULL DEFAULT 0,
      search_text TEXT
    );
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
      raw_data TEXT,
      country TEXT,
      country_name TEXT,
      as_name TEXT,
      target TEXT,
      machine TEXT,
      simulated INTEGER NOT NULL DEFAULT 0,
      search_text TEXT,
      is_duplicate INTEGER NOT NULL DEFAULT 0
    );
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
      totp_last_step INTEGER,
      role TEXT NOT NULL DEFAULT 'admin',
      auth_provider TEXT NOT NULL DEFAULT 'password',
      oidc_issuer TEXT,
      oidc_subject TEXT,
      session_version INTEGER NOT NULL DEFAULT 1,
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

  migrateRecordIndexColumns(db);
  migrateNotificationRulesTable(db, createNotificationRulesTable);
  migrateNotificationsTable(db, createNotificationsTable);
  migrateAuthUsersTable(db);
  db.exec(createNotificationIncidentsTable);
  seedNotificationIncidentsFromHistoryIfEmpty(db);
  const searchIndexAvailable = initSearchIndexes(db);
  if (searchIndexAvailable) {
    backfillSearchIndexes(db);
  }
  return searchIndexAvailable;
}

function migrateRecordIndexColumns(db: Database): void {
  ensureColumns(db, 'alerts', [
    ['country', 'TEXT'],
    ['country_name', 'TEXT'],
    ['as_name', 'TEXT'],
    ['target', 'TEXT'],
    ['machine', 'TEXT'],
    ['meta_search', 'TEXT'],
    ['origins', 'TEXT'],
    ['simulated', 'INTEGER NOT NULL DEFAULT 0'],
    ['search_text', 'TEXT'],
  ]);
  ensureColumns(db, 'decisions', [
    ['country', 'TEXT'],
    ['country_name', 'TEXT'],
    ['as_name', 'TEXT'],
    ['target', 'TEXT'],
    ['machine', 'TEXT'],
    ['simulated', 'INTEGER NOT NULL DEFAULT 0'],
    ['search_text', 'TEXT'],
    ['is_duplicate', 'INTEGER NOT NULL DEFAULT 0'],
  ]);

  // Replaced by idx_decisions_alert_created_id, which also satisfies the
  // deterministic decision paging order and covers the history predicate.
  db.exec('DROP INDEX IF EXISTS idx_decisions_alert_created_at');
  db.exec(CREATE_SYNC_SECONDARY_INDEXES_SQL);

  backfillRecordIndexes(db);
}

function ensureColumns(db: Database, tableName: string, columns: Array<[string, string]>): void {
  const existing = new Set((db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((column) => column.name));
  for (const [name, definition] of columns) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${name} ${definition}`);
    }
  }
}

function backfillRecordIndexes(db: Database): void {
  const alertRowsStatement = db.query(`
    SELECT id, created_at, scenario, source_ip, message, raw_data
    FROM alerts
    WHERE search_text IS NULL
    LIMIT 500
  `);
  const updateAlertStatement = db.query(`
    UPDATE alerts
    SET created_at = $created_at,
        scenario = $scenario,
        source_ip = $source_ip,
        country = $country,
        country_name = $country_name,
        as_name = $as_name,
        target = $target,
        machine = $machine,
        meta_search = $meta_search,
        origins = $origins,
        simulated = $simulated,
        search_text = $search_text
    WHERE id = $id
  `);

  while (true) {
    const rows = alertRowsStatement.all() as Array<{
      id: string | number;
      created_at: string;
      scenario?: string | null;
      source_ip?: string | null;
      message?: string | null;
      raw_data: string;
    }>;
    if (rows.length === 0) break;

    const updateAlerts = db.transaction((items: typeof rows) => {
      for (const row of items) {
        const index = deriveAlertIndexValues(row.raw_data, {
          createdAt: row.created_at,
          scenario: row.scenario,
          sourceIp: row.source_ip,
          message: row.message,
        });
        updateAlertStatement.run({
          $id: row.id,
          $created_at: index.historyAt,
          $scenario: index.scenario ?? row.scenario,
          $source_ip: index.sourceIp ?? row.source_ip,
          $country: index.country,
          $country_name: index.countryName,
          $as_name: index.asName,
          $target: index.target,
          $machine: index.machine,
          $meta_search: index.metaSearch,
          $origins: index.origins,
          $simulated: index.simulated,
          $search_text: index.searchText,
        });
      }
    });
    updateAlerts(rows);
  }

  const decisionRowsStatement = db.query(`
    SELECT id, value, type, origin, scenario, raw_data
    FROM decisions
    WHERE search_text IS NULL
    LIMIT 500
  `);
  const updateDecisionStatement = db.query(`
    UPDATE decisions
    SET country = $country,
        country_name = $country_name,
        as_name = $as_name,
        target = $target,
        machine = $machine,
        simulated = $simulated,
        search_text = $search_text
    WHERE id = $id
  `);

  while (true) {
    const rows = decisionRowsStatement.all() as Array<{
      id: string;
      value?: string | null;
      type?: string | null;
      origin?: string | null;
      scenario?: string | null;
      raw_data: string;
    }>;
    if (rows.length === 0) break;

    const updateDecisions = db.transaction((items: typeof rows) => {
      for (const row of items) {
        const index = deriveDecisionIndexValues(row.raw_data, {
          value: row.value,
          type: row.type,
          origin: row.origin,
          scenario: row.scenario,
        });
        updateDecisionStatement.run({
          $id: row.id,
          $country: index.country,
          $country_name: index.countryName,
          $as_name: index.asName,
          $target: index.target,
          $machine: index.machine,
          $simulated: index.simulated,
          $search_text: index.searchText,
        });
      }
    });
    updateDecisions(rows);
  }
}

function initSearchIndexes(db: Database): boolean {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS alerts_fts USING fts5(
        alert_id UNINDEXED,
        search_text,
        tokenize = 'unicode61'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
        decision_id UNINDEXED,
        search_text,
        tokenize = 'unicode61'
      );
    `);
    return true;
  } catch (error) {
    console.warn('SQLite FTS5 is unavailable; falling back to LIKE search.', (error as Error).message);
    return false;
  }
}

function backfillSearchIndexes(db: Database): void {
  const alertCount = (db.query('SELECT COUNT(*) AS count FROM alerts_fts').get() as CountRow | null)?.count || 0;
  if (alertCount === 0) {
    db.exec(`
      INSERT INTO alerts_fts(rowid, alert_id, search_text)
      SELECT CAST(id AS INTEGER), CAST(id AS TEXT), search_text
      FROM alerts
      WHERE CAST(id AS TEXT) GLOB '[0-9]*'
        AND CAST(id AS TEXT) NOT GLOB '*[^0-9]*'
        AND CAST(id AS INTEGER) > 0
        AND search_text IS NOT NULL
        AND search_text <> ''
    `);
  }

  const decisionCount = (db.query('SELECT COUNT(*) AS count FROM decisions_fts').get() as CountRow | null)?.count || 0;
  if (decisionCount === 0) {
    db.exec(`
      INSERT INTO decisions_fts(decision_id, search_text)
      SELECT CAST(id AS TEXT), search_text
      FROM decisions
      WHERE search_text IS NOT NULL
        AND search_text <> ''
    `);
  }
}

async function backfillSearchIndexesCooperative(db: Database, yieldControl: () => Promise<void>, batchSize: number): Promise<void> {
  let lastAlertId = 0;
  const selectAlerts = db.query(`
    SELECT id, search_text
    FROM alerts
    WHERE id > ?
      AND search_text IS NOT NULL
      AND search_text <> ''
    ORDER BY id
    LIMIT ?
  `);
  const insertAlerts = db.transaction((rows: Array<{ id: number; search_text: string }>) => {
    const insert = db.prepare('INSERT INTO alerts_fts(rowid, alert_id, search_text) VALUES (?, ?, ?)');
    for (const row of rows) {
      insert.run(row.id, String(row.id), row.search_text);
    }
  });

  while (true) {
    const rows = selectAlerts.all(lastAlertId, batchSize) as Array<{ id: number; search_text: string }>;
    if (rows.length === 0) {
      break;
    }
    insertAlerts(rows);
    lastAlertId = rows[rows.length - 1].id;
    await yieldControl();
  }

  let lastDecisionRowId = 0;
  const selectDecisions = db.query(`
    SELECT rowid, id, search_text
    FROM decisions
    WHERE rowid > ?
      AND search_text IS NOT NULL
      AND search_text <> ''
    ORDER BY rowid
    LIMIT ?
  `);
  const insertDecisions = db.transaction((rows: Array<{ id: string; rowid: number; search_text: string }>) => {
    const insert = db.prepare('INSERT INTO decisions_fts(decision_id, search_text) VALUES (?, ?)');
    for (const row of rows) {
      insert.run(String(row.id), row.search_text);
    }
  });

  while (true) {
    const rows = selectDecisions.all(lastDecisionRowId, batchSize) as Array<{ id: string; rowid: number; search_text: string }>;
    if (rows.length === 0) {
      break;
    }
    insertDecisions(rows);
    lastDecisionRowId = rows[rows.length - 1].rowid;
    await yieldControl();
  }
}

function migrateAuthUsersTable(db: Database): void {
  const columns = db.query('PRAGMA table_info(auth_users)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'totp_secret')) {
    db.exec('ALTER TABLE auth_users ADD COLUMN totp_secret TEXT');
  }
  if (!columns.some((column) => column.name === 'totp_enabled')) {
    db.exec('ALTER TABLE auth_users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.some((column) => column.name === 'totp_last_step')) {
    db.exec('ALTER TABLE auth_users ADD COLUMN totp_last_step INTEGER');
  }
  if (!columns.some((column) => column.name === 'oidc_issuer')) {
    db.exec('ALTER TABLE auth_users ADD COLUMN oidc_issuer TEXT');
  }
  if (!columns.some((column) => column.name === 'oidc_subject')) {
    db.exec('ALTER TABLE auth_users ADD COLUMN oidc_subject TEXT');
  }
  if (!columns.some((column) => column.name === 'session_version')) {
    db.exec('ALTER TABLE auth_users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1');
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_oidc_identity
    ON auth_users(oidc_issuer, oidc_subject)
    WHERE oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL
  `);
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
