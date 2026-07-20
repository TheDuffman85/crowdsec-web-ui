import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import type { AlertDecision, AlertRecord } from '../shared/contracts';
import { matchesIpSearchValue } from '../shared/search';
import { deriveAlertIndexValues, deriveAlertIndexValuesFromRecord, deriveDecisionIndexValues, deriveDecisionIndexValuesFromRecord } from './record-index';
import {
  ALERT_RECORD_COLUMNS,
  DECISION_RECORD_COLUMNS,
  alertFromRow,
  alertMetadataFingerprint,
  parseAlertPayload,
  parseDecisionPayload,
  serializeAlertExtras,
  serializeAlertSourceExtras,
  serializeDecisionExtras,
  type NormalizedAlertRow,
  type NormalizedDecisionRow,
} from './normalized-record';
import { normalizeIsoTimestamp, normalizeTimestampJson } from './utils/date-time';

type SqliteStatement = {
  run: (...params: any[]) => { changes: number; lastInsertRowid?: number | bigint };
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
const DECISION_DUPLICATE_RANK_VERSION = '2';

const SYNC_SECONDARY_INDEX_NAMES = [
  'idx_alerts_created_at',
  'idx_alerts_country',
  'idx_alerts_region',
  'idx_alerts_city',
  'idx_alerts_scenario',
  'idx_alerts_as_name',
  'idx_alerts_target',
  'idx_alerts_source_ip',
  'idx_alerts_simulated',
  'idx_alerts_simulated_created_at',
  'idx_alerts_country_created_at',
  'idx_alerts_scenario_created_at',
  'idx_alerts_instance_created',
  'idx_decisions_stop_at',
  'idx_decisions_alert_summary',
  'idx_decisions_value',
  'idx_decisions_created_at',
  'idx_decisions_created_id_stop_at',
  'idx_decisions_stop_alert_id',
  'idx_decisions_value_stop_at',
  'idx_decisions_country',
  'idx_decisions_region',
  'idx_decisions_city',
  'idx_decisions_scenario',
  'idx_decisions_as_name',
  'idx_decisions_target',
  'idx_decisions_simulated',
  'idx_decisions_simulated_created_at',
  'idx_decisions_alert_created_id',
  'idx_decisions_duplicate_paging',
  'idx_decisions_duplicate_filters',
  'idx_decisions_duplicate_value_paging',
  'idx_decisions_duplicate_primary',
  'idx_decisions_instance_created',
  'idx_decisions_instance_duplicate_paging',
] as const;

const CREATE_SYNC_SECONDARY_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at);
  CREATE INDEX IF NOT EXISTS idx_alerts_country ON alerts(country);
  CREATE INDEX IF NOT EXISTS idx_alerts_region ON alerts(region);
  CREATE INDEX IF NOT EXISTS idx_alerts_city ON alerts(city);
  CREATE INDEX IF NOT EXISTS idx_alerts_scenario ON alerts(scenario);
  CREATE INDEX IF NOT EXISTS idx_alerts_as_name ON alerts(as_name);
  CREATE INDEX IF NOT EXISTS idx_alerts_target ON alerts(target);
  CREATE INDEX IF NOT EXISTS idx_alerts_source_ip ON alerts(source_ip);
  CREATE INDEX IF NOT EXISTS idx_alerts_simulated ON alerts(simulated);
  CREATE INDEX IF NOT EXISTS idx_alerts_simulated_created_at ON alerts(simulated, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_alerts_country_created_at ON alerts(country, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_alerts_scenario_created_at ON alerts(scenario, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_alerts_instance_created ON alerts(instance_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_decisions_stop_at ON decisions(stop_at);
  CREATE INDEX IF NOT EXISTS idx_decisions_alert_summary ON decisions(alert_id, origin, simulated, stop_at);
  CREATE INDEX IF NOT EXISTS idx_decisions_value ON decisions(value);
  CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions(created_at);
  CREATE INDEX IF NOT EXISTS idx_decisions_created_id_stop_at ON decisions(created_at DESC, id DESC, stop_at);
  CREATE INDEX IF NOT EXISTS idx_decisions_stop_alert_id ON decisions(stop_at, alert_id);
  CREATE INDEX IF NOT EXISTS idx_decisions_value_stop_at ON decisions(value, stop_at DESC);
  CREATE INDEX IF NOT EXISTS idx_decisions_country ON decisions(country);
  CREATE INDEX IF NOT EXISTS idx_decisions_region ON decisions(region);
  CREATE INDEX IF NOT EXISTS idx_decisions_city ON decisions(city);
  CREATE INDEX IF NOT EXISTS idx_decisions_scenario ON decisions(scenario);
  CREATE INDEX IF NOT EXISTS idx_decisions_as_name ON decisions(as_name);
  CREATE INDEX IF NOT EXISTS idx_decisions_target ON decisions(target);
  CREATE INDEX IF NOT EXISTS idx_decisions_simulated ON decisions(simulated);
  CREATE INDEX IF NOT EXISTS idx_decisions_simulated_created_at ON decisions(simulated, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_decisions_alert_created_id ON decisions(alert_id, created_at DESC, id DESC, stop_at);
  CREATE INDEX IF NOT EXISTS idx_decisions_duplicate_paging ON decisions(is_duplicate, created_at DESC, id DESC, stop_at);
  CREATE INDEX IF NOT EXISTS idx_decisions_duplicate_filters ON decisions(
    is_duplicate, stop_at, scenario, value, as_name, target, country, country_name,
    region, city, machine, origin, type, simulated, alert_id, created_at DESC, id DESC
  );
  CREATE INDEX IF NOT EXISTS idx_decisions_duplicate_value_paging ON decisions(
    value, is_duplicate, created_at DESC, id DESC, stop_at
  );
  CREATE INDEX IF NOT EXISTS idx_decisions_duplicate_primary ON decisions(value, simulated, stop_at DESC, id);
  CREATE INDEX IF NOT EXISTS idx_decisions_instance_created ON decisions(instance_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_decisions_instance_duplicate_paging ON decisions(
    instance_id, is_duplicate, created_at DESC, id DESC, stop_at
  );
`;

export interface AlertInsertParams {
  $id: string | number;
  $instance_id?: string;
  $uuid: string;
  $created_at: string;
  $scenario?: string;
  $source_ip?: string;
  $message: string;
  $raw_data?: string;
  $record?: AlertRecord;
}

export interface DecisionInsertParams {
  $id: string;
  $instance_id?: string;
  $uuid: string;
  $alert_id: string | number;
  $created_at: string;
  $stop_at: string;
  $value?: string;
  $type?: string;
  $origin?: string;
  $scenario?: string;
  $raw_data?: string;
  $record?: AlertDecision & Record<string, unknown>;
}

export interface DecisionUpdateParams {
  $id: string;
  $stop_at: string;
  $raw_data: string;
}

export interface SearchIndexRebuildScope {
  alertIds: Array<string | number>;
  decisionIds: Array<string | number>;
}

export interface DatabaseOptions {
  dbDir?: string;
  dbPath?: string;
  walEnabled?: boolean;
}

type RowWithRawData = { raw_data: string; created_at?: string; stop_at?: string; alert_id?: string | number | null };
export type AlertDataRow = NormalizedAlertRow;
export type DecisionDataRow = NormalizedDecisionRow;
export type AlertDecisionSnapshotRow = {
  raw_data: string;
  metadata_hash: string | null;
  decision_count: number;
  origins: string | null;
  simulated: number;
};
export type PendingAlertDeletionRow = {
  alert_id: string;
  decision_ids_json: string;
  requested_at: string;
  decisions_deleted_at: string | null;
  delete_after: string | null;
  completed_at: string | null;
  attempt_count: number;
  last_attempt_at: string | null;
  last_error: string | null;
};
type MetaRow = { value: string };
type CountRow = { count: number };
type IdRow = { id: string | number };
type DecisionDuplicateKeyRow = { value: string | null; simulated: number };
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
  private decisionDuplicateFlagsInitialized = false;
  private lastDecisionDuplicateRefreshAt: string | null = null;
  private ownsDecisionDuplicateDirtyMarker = false;
  private decisionDuplicateDirtyKeys = new Map<string, DecisionDuplicateKeyRow>();
  private alertDeletionTombstones = new Set<string>();

  private readonly insertAlertStatement: any;
  private readonly getAllAlertsStatement: any;
  private readonly getAlertsStatement: any;
  private readonly getAlertsBetweenStatement: any;
  private readonly getAlertIdsBetweenStatement: any;
  private readonly getAlertDecisionSnapshotStatement: any;
  private readonly updateAlertRawDataStatement: any;
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
  private readonly deleteDecisionSearchRowStatement: any | null;
  private readonly insertDecisionSearchIndexStatement: any | null;
  private readonly upsertDecisionSearchRowStatement: any | null;

  constructor(options: DatabaseOptions = {}) {
    const resolvedPath = resolveDatabasePath(options);
    this.dbPath = resolvedPath;
    this.db = openDatabase(resolvedPath, options.walEnabled ?? true);
    const freshDatabase = isDatabaseFresh(this.db);
    this.searchIndexAvailable = initSchema(this.db, freshDatabase);
    this.loadDecisionDuplicateRefreshState();
    this.refreshAlertDeletionTombstones();

    this.insertAlertStatement = this.db.query(`
      INSERT INTO alerts (
        id, instance_id, upstream_id, uuid, created_at, start_at, stop_at, scenario, record_scenario, reason,
        source_ip, source_value, source_scope, source_range, source_as_number, source_extra_data,
        message, machine_id, machine_alias, events_count, extra_data, metadata_hash, raw_data,
        latitude, longitude, country, country_name, region, city, as_name, target, machine, meta_search, origins, simulated, search_text
      )
      VALUES (
        $internal_id, $instance_id, $id, $uuid, $created_at, $start_at, $stop_at, $scenario, $record_scenario, $reason,
        $source_ip, $source_value, $source_scope, $source_range, $source_as_number, $source_extra_data,
        $message, $machine_id, $machine_alias, $events_count, $extra_data, $metadata_hash, NULL,
        $latitude, $longitude, $country, $country_name, $region, $city, $as_name, $target, $machine, $meta_search, $origins, $simulated, $search_text
      )
      ON CONFLICT(instance_id, upstream_id) DO UPDATE SET
        uuid = excluded.uuid,
        created_at = excluded.created_at,
        start_at = excluded.start_at,
        stop_at = excluded.stop_at,
        scenario = excluded.scenario,
        record_scenario = excluded.record_scenario,
        reason = excluded.reason,
        source_ip = excluded.source_ip,
        source_value = excluded.source_value,
        source_scope = excluded.source_scope,
        source_range = excluded.source_range,
        source_as_number = excluded.source_as_number,
        source_extra_data = excluded.source_extra_data,
        message = excluded.message,
        machine_id = excluded.machine_id,
        machine_alias = excluded.machine_alias,
        events_count = excluded.events_count,
        extra_data = excluded.extra_data,
        metadata_hash = excluded.metadata_hash,
        raw_data = NULL,
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        country = excluded.country,
        country_name = excluded.country_name,
        region = excluded.region,
        city = excluded.city,
        as_name = excluded.as_name,
        target = excluded.target,
        machine = excluded.machine,
        meta_search = excluded.meta_search,
        origins = excluded.origins,
        simulated = excluded.simulated,
        search_text = excluded.search_text
      WHERE alerts.uuid IS NOT excluded.uuid
        OR alerts.created_at IS NOT excluded.created_at
        OR alerts.start_at IS NOT excluded.start_at
        OR alerts.stop_at IS NOT excluded.stop_at
        OR alerts.scenario IS NOT excluded.scenario
        OR alerts.record_scenario IS NOT excluded.record_scenario
        OR alerts.reason IS NOT excluded.reason
        OR alerts.source_ip IS NOT excluded.source_ip
        OR alerts.source_value IS NOT excluded.source_value
        OR alerts.source_scope IS NOT excluded.source_scope
        OR alerts.source_range IS NOT excluded.source_range
        OR alerts.source_as_number IS NOT excluded.source_as_number
        OR alerts.source_extra_data IS NOT excluded.source_extra_data
        OR alerts.message IS NOT excluded.message
        OR alerts.machine_id IS NOT excluded.machine_id
        OR alerts.machine_alias IS NOT excluded.machine_alias
        OR alerts.events_count IS NOT excluded.events_count
        OR alerts.extra_data IS NOT excluded.extra_data
        OR alerts.metadata_hash IS NOT excluded.metadata_hash
        OR alerts.raw_data IS NOT NULL
        OR alerts.latitude IS NOT excluded.latitude
        OR alerts.longitude IS NOT excluded.longitude
        OR alerts.country IS NOT excluded.country
        OR alerts.country_name IS NOT excluded.country_name
        OR alerts.region IS NOT excluded.region
        OR alerts.city IS NOT excluded.city
        OR alerts.as_name IS NOT excluded.as_name
        OR alerts.target IS NOT excluded.target
        OR alerts.machine IS NOT excluded.machine
        OR alerts.meta_search IS NOT excluded.meta_search
        OR alerts.origins IS NOT excluded.origins
        OR alerts.simulated IS NOT excluded.simulated
        OR alerts.search_text IS NOT excluded.search_text
    `);

    this.getAllAlertsStatement = this.db.query(`
      SELECT ${ALERT_RECORD_COLUMNS} FROM alerts
      ORDER BY created_at DESC
    `);
    this.getAlertsStatement = this.db.query(`
      SELECT ${ALERT_RECORD_COLUMNS} FROM alerts
      WHERE created_at >= $since
      ORDER BY created_at DESC
    `);
    this.getAlertsBetweenStatement = this.db.query(`
      SELECT ${ALERT_RECORD_COLUMNS} FROM alerts
      WHERE created_at >= $start AND created_at < $end
      ORDER BY created_at DESC
    `);
    this.getAlertIdsBetweenStatement = this.db.query(`
      SELECT id FROM alerts
      WHERE created_at >= $start AND created_at < $end
    `);
    this.getAlertDecisionSnapshotStatement = this.db.query(`
      SELECT
        ${ALERT_RECORD_COLUMNS},
        alerts.origins,
        alerts.simulated,
        (
          SELECT COUNT(*)
          FROM decisions
          WHERE decisions.alert_id = alerts.id
        ) AS decision_count
      FROM alerts
      WHERE alerts.id = $id
    `);
    this.updateAlertRawDataStatement = this.db.query(`
      UPDATE alerts
      SET raw_data = NULL
      WHERE id = $id AND raw_data IS NOT NULL
    `);

    this.countAlertsStatement = this.db.query('SELECT COUNT(*) as count FROM alerts');
    this.countDecisionsStatement = this.db.query('SELECT COUNT(*) as count FROM decisions');

    this.insertDecisionStatement = this.db.query(`
      INSERT INTO decisions (
        id, instance_id, upstream_id, uuid, alert_id, alert_upstream_id, created_at, stop_at, value, type, origin, scenario, duration, scope, extra_data, raw_data,
        country, country_name, region, city, as_name, target, machine, simulated, search_text, is_duplicate
      )
      VALUES (
        $internal_id, $instance_id, $id, $uuid, $internal_alert_id, $alert_id, $created_at, $stop_at, $value, $type, $origin, $scenario, $duration, $scope, $extra_data, NULL,
        $country, $country_name, $region, $city, $as_name, $target, $machine, $simulated, $search_text, 0
      )
      ON CONFLICT(instance_id, upstream_id) DO UPDATE SET
        uuid = excluded.uuid,
        alert_id = excluded.alert_id,
        created_at = excluded.created_at,
        stop_at = excluded.stop_at,
        value = excluded.value,
        type = excluded.type,
        origin = excluded.origin,
        scenario = excluded.scenario,
        duration = excluded.duration,
        scope = excluded.scope,
        extra_data = excluded.extra_data,
        raw_data = NULL,
        country = excluded.country,
        country_name = excluded.country_name,
        region = excluded.region,
        city = excluded.city,
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
        OR decisions.duration IS NOT excluded.duration
        OR decisions.scope IS NOT excluded.scope
        OR decisions.extra_data IS NOT excluded.extra_data
        OR decisions.raw_data IS NOT NULL
        OR decisions.country IS NOT excluded.country
        OR decisions.country_name IS NOT excluded.country_name
        OR decisions.region IS NOT excluded.region
        OR decisions.city IS NOT excluded.city
        OR decisions.as_name IS NOT excluded.as_name
        OR decisions.target IS NOT excluded.target
        OR decisions.machine IS NOT excluded.machine
        OR decisions.simulated IS NOT excluded.simulated
        OR decisions.search_text IS NOT excluded.search_text
    `);

    this.updateDecisionStatement = this.db.query(`
      UPDATE decisions SET
        stop_at = $stop_at,
        duration = $duration,
        scope = $scope,
        extra_data = $extra_data,
        raw_data = NULL,
        country = $country,
        country_name = $country_name,
        region = $region,
        city = $city,
        as_name = $as_name,
        target = $target,
        machine = $machine,
        simulated = $simulated,
        search_text = $search_text
      WHERE id = $id
    `);

    this.getAllDecisionsStatement = this.db.query(`
      SELECT ${DECISION_RECORD_COLUMNS} FROM decisions
      ORDER BY stop_at DESC
    `);
    this.getActiveDecisionsStatement = this.db.query(`
      SELECT ${DECISION_RECORD_COLUMNS} FROM decisions
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
      SELECT ${DECISION_RECORD_COLUMNS} FROM decisions
      WHERE created_at >= $since OR stop_at > $now
      ORDER BY stop_at DESC
    `);

    this.deleteDecisionStatement = this.db.query('DELETE FROM decisions WHERE id = $id');
    this.getDecisionByIdStatement = this.db.query(`SELECT ${DECISION_RECORD_COLUMNS} FROM decisions WHERE id = $id`);
    this.getDecisionIdsByAlertIdStatement = this.db.query('SELECT id FROM decisions WHERE alert_id = $alert_id');
    this.getActiveDecisionByValueStatement = this.db.query(`
      SELECT ${DECISION_RECORD_COLUMNS} FROM decisions
      WHERE value = $value AND stop_at > $now AND id NOT LIKE 'dup\\_%' ESCAPE '\\'
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
      ? this.db.prepare(`
          DELETE FROM decisions_fts
          WHERE rowid = (
            SELECT fts_rowid
            FROM decision_fts_rows
            WHERE decision_id = ?
          )
        `)
      : null;
    this.deleteDecisionSearchRowStatement = this.searchIndexAvailable
      ? this.db.prepare('DELETE FROM decision_fts_rows WHERE decision_id = ?')
      : null;
    this.insertDecisionSearchIndexStatement = this.searchIndexAvailable
      ? this.db.prepare('INSERT INTO decisions_fts(decision_id, search_text) VALUES (?, ?)')
      : null;
    this.upsertDecisionSearchRowStatement = this.searchIndexAvailable
      ? this.db.prepare(`
          INSERT INTO decision_fts_rows (decision_id, fts_rowid)
          VALUES (?, ?)
          ON CONFLICT(decision_id) DO UPDATE SET fts_rowid = excluded.fts_rowid
        `)
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
    this.decisionDuplicateFlagsInitialized = false;
    this.lastDecisionDuplicateRefreshAt = null;
    this.ownsDecisionDuplicateDirtyMarker = false;
    this.decisionDuplicateDirtyKeys.clear();
    this.db.prepare(`
      DELETE FROM meta
      WHERE key IN (
        'decision_duplicate_refresh_at',
        'decision_duplicate_flags_dirty',
        'decision_duplicate_rank_version'
      )
    `).run();
    this.clearSearchIndexes();
  }

  beginDeferredSearchIndexUpdates(dropSecondaryIndexes = true, clearSearchIndexes = true): void {
    this.searchIndexUpdatesDeferred = true;
    if (this.searchIndexAvailable && clearSearchIndexes) this.clearSearchIndexes();
    if (dropSecondaryIndexes) {
      for (const indexName of SYNC_SECONDARY_INDEX_NAMES) {
        this.db.exec(`DROP INDEX IF EXISTS ${indexName}`);
      }
    }
  }

  rebuildSearchIndexes(scope?: SearchIndexRebuildScope): void {
    try {
      if (scope) {
        this.rebuildScopedSearchIndexes(scope);
      } else {
        this.db.exec(CREATE_SYNC_SECONDARY_INDEXES_SQL);
        if (this.searchIndexAvailable) {
          this.clearSearchIndexes();
          backfillSearchIndexes(this.db);
        }
      }
    } finally {
      this.searchIndexUpdatesDeferred = false;
    }
  }

  private rebuildScopedSearchIndexes(scope: SearchIndexRebuildScope): void {
    if (!this.searchIndexAvailable) return;

    const alertIds = Array.from(new Set(scope.alertIds.map(String)));
    const decisionIds = Array.from(new Set(scope.decisionIds.map(String)));
    const rebuild = this.db.transaction(() => {
      runChunkedIdMutation(this.db, 'DELETE FROM alerts_fts WHERE alert_id IN', alertIds);
      this.deleteDecisionSearchIndexes(decisionIds);

      for (let offset = 0; offset < alertIds.length; offset += 900) {
        const chunk = alertIds.slice(offset, offset + 900);
        if (chunk.length === 0) continue;
        const placeholders = chunk.map(() => '?').join(',');
        const rows = this.db.prepare(`
          SELECT id, search_text
          FROM alerts
          WHERE id IN (${placeholders})
            AND search_text IS NOT NULL
            AND search_text <> ''
        `).all(...chunk) as Array<{ id: string | number; search_text: string }>;
        for (const row of rows) {
          const numericId = Number(row.id);
          if (!Number.isSafeInteger(numericId) || numericId === 0) continue;
          this.insertAlertSearchIndexStatement?.run(numericId, String(row.id), row.search_text);
        }
      }

      for (let offset = 0; offset < decisionIds.length; offset += 900) {
        const chunk = decisionIds.slice(offset, offset + 900);
        if (chunk.length === 0) continue;
        const placeholders = chunk.map(() => '?').join(',');
        const rows = this.db.prepare(`
          SELECT id, search_text
          FROM decisions
          WHERE id IN (${placeholders})
            AND search_text IS NOT NULL
            AND search_text <> ''
        `).all(...chunk) as Array<{ id: string | number; search_text: string }>;
        for (const row of rows) {
          this.insertDecisionSearchIndexRow(String(row.id), row.search_text);
        }
      }
    });
    rebuild();
  }

  async rebuildSearchIndexesCooperative(yieldControl: () => Promise<void>, batchSize = 1_000): Promise<void> {
    if (!this.searchIndexAvailable) {
      return;
    }
    try {
      this.clearSearchIndexes();
      await backfillSearchIndexesCooperative(this.db, yieldControl, batchSize);
    } finally {
      this.searchIndexUpdatesDeferred = false;
    }
  }

  insertAlert(params: AlertInsertParams): boolean {
    const instanceId = params.$instance_id || 'default';
    const tombstoneId = `${instanceId}\u0000${params.$id}`;
    if (this.alertDeletionTombstones.has(tombstoneId) || (instanceId === 'default' && this.alertDeletionTombstones.has(String(params.$id)))) return false;
    const rawData = params.$raw_data || '{}';
    const alert = params.$record || parseAlertPayload(rawData);
    const source = alert?.source || null;
    const fallback = {
      createdAt: params.$created_at,
      scenario: params.$scenario,
      sourceIp: params.$source_ip,
      message: params.$message,
    };
    const index = params.$record
      ? deriveAlertIndexValuesFromRecord(params.$record, fallback)
      : deriveAlertIndexValues(rawData, fallback);
    const { $record, $raw_data: _rawData, ...dbParams } = params;
    const result = this.insertAlertStatement.run({
      ...dbParams,
      $id: String(params.$id),
      $instance_id: instanceId,
      $internal_id: this.resolveAlertInternalId(instanceId, params.$id),
      $created_at: index.historyAt,
      $start_at: normalizeOptionalTimestamp(alert?.start_at),
      $stop_at: normalizeOptionalTimestamp(alert?.stop_at),
      $record_scenario: readOptionalString(alert?.scenario),
      $reason: readOptionalString(alert?.reason),
      $source_value: readOptionalString(source?.value),
      $source_scope: readOptionalString(source?.scope),
      $source_range: readOptionalString(source?.range),
      $source_as_number: source?.as_number === undefined || source?.as_number === null ? null : String(source.as_number),
      $source_extra_data: serializeAlertSourceExtras(source),
      $machine_id: readOptionalString(alert?.machine_id),
      $machine_alias: readOptionalString(alert?.machine_alias),
      $events_count: typeof alert?.events_count === 'number' ? alert.events_count : null,
      $extra_data: serializeAlertExtras(alert),
      $metadata_hash: alertMetadataFingerprint(alert),
      $scenario: index.scenario ?? params.$scenario,
      $source_ip: index.sourceIp ?? params.$source_ip,
      $latitude: index.latitude,
      $longitude: index.longitude,
      $country: index.country,
      $country_name: index.countryName,
      $region: index.region,
      $city: index.city,
      $as_name: index.asName,
      $target: index.target,
      $machine: index.machine,
      $meta_search: index.metaSearch,
      $origins: index.origins,
      $simulated: index.simulated,
      $search_text: index.searchText,
    });
    if (result.changes > 0) {
      const internalId = this.resolveAlertInternalId(instanceId, params.$id);
      this.upsertAlertSearchIndex(internalId, index.searchText);
      return true;
    }
    return false;
  }

  getAllAlerts(): RowWithRawData[] {
    return alertRowsToLegacyPayloads(this.getAllAlertsStatement.all() as AlertDataRow[]);
  }

  getAlertsSince(since: string): RowWithRawData[] {
    return alertRowsToLegacyPayloads(this.getAlertsStatement.all({ $since: since }) as AlertDataRow[]);
  }

  getAlertsBetween(start: string, end: string): RowWithRawData[] {
    return alertRowsToLegacyPayloads(this.getAlertsBetweenStatement.all({ $start: start, $end: end }) as AlertDataRow[]);
  }

  getAlertDecisionSnapshot(id: string | number, instanceId?: string): AlertDecisionSnapshotRow | null {
    const internalId = instanceId ? this.getAlertInternalId(instanceId, id) : id;
    if (internalId === null) return null;
    const row = this.getAlertDecisionSnapshotStatement.get({ $id: internalId }) as (AlertDataRow & Omit<AlertDecisionSnapshotRow, 'raw_data'>) | null;
    return row ? {
      raw_data: JSON.stringify(alertFromRow(row)),
      metadata_hash: row.metadata_hash,
      decision_count: row.decision_count,
      origins: row.origins,
      simulated: row.simulated ? 1 : 0,
    } : null;
  }

  updateAlertRawData(id: string | number, _rawData?: string, instanceId?: string): boolean {
    const tombstoneId = instanceId ? `${instanceId}\u0000${id}` : String(id);
    if (this.alertDeletionTombstones.has(tombstoneId)) return false;
    const internalId = instanceId ? this.getAlertInternalId(instanceId, id) : id;
    if (internalId === null) return false;
    return this.updateAlertRawDataStatement.run({
      $id: internalId,
    }).changes > 0;
  }

  deleteAlertsMissingBetween(
    start: string,
    end: string,
    keepIds: Array<string | number>,
    instanceId?: string,
  ): { alerts: number; decisions: number } {
    const keepSet = new Set(keepIds.map(String));
    const rows = instanceId
      ? this.db.prepare(`
          SELECT id, COALESCE(upstream_id, CAST(id AS TEXT)) AS upstream_id
          FROM alerts
          WHERE instance_id = ? AND created_at >= ? AND created_at < ?
        `).all(instanceId, start, end) as Array<IdRow & { upstream_id: string }>
      : this.getAlertIdsBetweenStatement.all({ $start: start, $end: end }) as Array<IdRow & { upstream_id?: string }>;
    const staleIds = rows
      .filter((row) => !keepSet.has(String(row.upstream_id ?? row.id)))
      .map((row) => String(row.id));

    this.deleteDecisionSearchIndexesByAlertIds(staleIds);
    this.markDecisionDuplicateKeysByAlertIds(staleIds);
    const decisions = runChunkedIdMutation(this.db, 'DELETE FROM decisions WHERE alert_id IN', staleIds);
    const alerts = runChunkedIdMutation(this.db, 'DELETE FROM alerts WHERE id IN', staleIds);
    this.deleteAlertSearchIndexes(staleIds);
    return { alerts, decisions };
  }

  countAlerts(instanceId?: string): number {
    if (instanceId) {
      return (this.db.prepare('SELECT COUNT(*) as count FROM alerts WHERE instance_id = ?').get(instanceId) as CountRow).count;
    }
    return (this.countAlertsStatement.get() as CountRow).count;
  }

  countDecisions(instanceId?: string): number {
    if (instanceId) {
      return (this.db.prepare('SELECT COUNT(*) as count FROM decisions WHERE instance_id = ?').get(instanceId) as CountRow).count;
    }
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
    const instanceId = params.$instance_id || 'default';
    const tombstoneId = `${instanceId}\u0000${params.$alert_id}`;
    if (this.alertDeletionTombstones.has(tombstoneId) || (instanceId === 'default' && this.alertDeletionTombstones.has(String(params.$alert_id)))) return false;
    if (this.alertDeletionTombstones.has(String(params.$alert_id))) return false;
    const rawData = params.$raw_data || '{}';
    const decision = params.$record || parseDecisionPayload(rawData);
    const fallback = {
      value: params.$value,
      type: params.$type,
      origin: params.$origin,
      scenario: params.$scenario,
    };
    const index = decision
      ? deriveDecisionIndexValuesFromRecord(decision, fallback)
      : deriveDecisionIndexValues(rawData, fallback);
    const { $record, $raw_data: _rawData, ...dbParams } = params;
    const result = this.insertDecisionStatement.run({
      ...dbParams,
      $id: String(params.$id),
      $alert_id: String(params.$alert_id),
      $instance_id: instanceId,
      $internal_id: this.resolveDecisionInternalId(instanceId, params.$id),
      $internal_alert_id: this.resolveAlertInternalId(instanceId, params.$alert_id),
      $created_at: normalizeIsoTimestamp(params.$created_at),
      $stop_at: normalizeIsoTimestamp(params.$stop_at),
      $value: params.$value ?? readOptionalString(decision?.value),
      $type: params.$type ?? readOptionalString(decision?.type),
      $origin: params.$origin ?? readOptionalString(decision?.origin),
      $scenario: params.$scenario ?? readOptionalString(decision?.scenario),
      $duration: readOptionalString(decision?.duration),
      $scope: readOptionalString(decision?.scope),
      $extra_data: serializeDecisionExtras(decision),
      $country: index.country,
      $country_name: index.countryName,
      $region: index.region,
      $city: index.city,
      $as_name: index.asName,
      $target: index.target,
      $machine: index.machine,
      $simulated: index.simulated,
      $search_text: index.searchText,
    });
    if (result.changes > 0) {
      this.markDecisionDuplicateKey(params.$value ?? readOptionalString(decision?.value), index.simulated);
      this.upsertDecisionSearchIndex(this.resolveDecisionInternalId(instanceId, params.$id), index.searchText);
      return true;
    }
    return false;
  }

  private resolveAlertInternalId(instanceId: string, upstreamId: string | number): number {
    const existing = this.db.prepare('SELECT id FROM alerts WHERE instance_id = ? AND upstream_id = ?')
      .get(instanceId, String(upstreamId)) as { id: number } | undefined;
    if (existing) return Number(existing.id);
    const numeric = Number(upstreamId);
    const primaryId = this.getMeta('multi_instance_primary_id')?.value || 'default';
    const numericOwner = Number.isSafeInteger(numeric) && numeric > 0
      ? this.db.prepare('SELECT instance_id FROM alerts WHERE id = ?').get(numeric) as { instance_id: string } | undefined
      : undefined;
    if (instanceId === primaryId && Number.isSafeInteger(numeric) && numeric > 0 && !numericOwner) return numeric;
    const row = this.db.prepare('SELECT MIN(id) AS minimum FROM alerts').get() as { minimum: number | null };
    return row.minimum === null || row.minimum >= 0 ? -1 : row.minimum - 1;
  }

  private resolveDecisionInternalId(instanceId: string, upstreamId: string | number): string {
    const existing = this.db.prepare('SELECT id FROM decisions WHERE instance_id = ? AND upstream_id = ?')
      .get(instanceId, String(upstreamId)) as { id: string } | undefined;
    if (existing) return String(existing.id);
    const rawId = String(upstreamId);
    const primaryId = this.getMeta('multi_instance_primary_id')?.value || 'default';
    const owner = this.db.prepare('SELECT instance_id FROM decisions WHERE id = ?').get(rawId) as { instance_id: string } | undefined;
    return instanceId === primaryId && !owner ? rawId : `${instanceId}\u001f${rawId}`;
  }

  updateDecision(params: DecisionUpdateParams): void {
    const existing = this.getDecisionById(params.$id);
    if (existing) this.markDecisionDuplicateKey(existing.value, existing.simulated);
    const decision = parseDecisionPayload(params.$raw_data);
    const fallback = existing ? {
      value: existing.value,
      type: existing.type,
      origin: existing.origin,
      scenario: existing.scenario,
    } : {};
    const index = decision
      ? deriveDecisionIndexValuesFromRecord(decision, fallback)
      : deriveDecisionIndexValues(params.$raw_data, fallback);
    this.updateDecisionStatement.run({
      $id: params.$id,
      $stop_at: normalizeIsoTimestamp(params.$stop_at),
      $duration: readOptionalString(decision?.duration) ?? existing?.duration ?? null,
      $scope: readOptionalString(decision?.scope) ?? existing?.scope ?? null,
      $extra_data: serializeDecisionExtras(decision),
      $country: index.country,
      $country_name: index.countryName,
      $region: index.region,
      $city: index.city,
      $as_name: index.asName,
      $target: index.target,
      $machine: index.machine,
      $simulated: index.simulated,
      $search_text: index.searchText,
    });
    this.markDecisionDuplicateKey(existing?.value ?? readOptionalString(decision?.value), index.simulated);
    this.upsertDecisionSearchIndex(params.$id, index.searchText);
  }

  getAllDecisions(): DecisionDataRow[] {
    return this.getAllDecisionsStatement.all() as DecisionDataRow[];
  }

  getActiveDecisions(now: string): DecisionDataRow[] {
    return this.getActiveDecisionsStatement.all({ $now: now }) as DecisionDataRow[];
  }

  deleteActiveAlertsMissing(keepIds: Array<string | number>, now: string, since: string): { alerts: number; decisions: number } {
    const keepSet = new Set(keepIds.map(String));
    const rows = this.getActiveAlertIdsStatement.all({ $now: now, $since: since }) as IdRow[];
    const staleIds = rows
      .map((row) => String(row.id))
      .filter((id) => !keepSet.has(id));

    this.deleteDecisionSearchIndexesByAlertIds(staleIds);
    this.markDecisionDuplicateKeysByAlertIds(staleIds);
    const decisions = runChunkedIdMutation(this.db, 'DELETE FROM decisions WHERE alert_id IN', staleIds);
    const alerts = runChunkedIdMutation(this.db, 'DELETE FROM alerts WHERE id IN', staleIds);
    this.deleteAlertSearchIndexes(staleIds);
    return { alerts, decisions };
  }

  getDecisionsSince(since: string, now: string): DecisionDataRow[] {
    return this.getDecisionsSinceStatement.all({ $since: since, $now: now }) as DecisionDataRow[];
  }

  deleteOldDecisions(cutoff: string): number {
    const cleanup = this.db.transaction((threshold: string) => {
      if (!this.searchIndexUpdatesDeferred && this.searchIndexAvailable) {
        this.db.prepare(`
          DELETE FROM decisions_fts
          WHERE rowid IN (
            SELECT search_rows.fts_rowid
            FROM decision_fts_rows AS search_rows
            JOIN decisions ON decisions.id = search_rows.decision_id
            WHERE decisions.stop_at < ?
          )
        `).run(threshold);
        this.db.prepare(`
          DELETE FROM decision_fts_rows
          WHERE decision_id IN (
            SELECT id
            FROM decisions
            WHERE stop_at < ?
          )
        `).run(threshold);
      }

      return this.db.prepare('DELETE FROM decisions WHERE stop_at < ?').run(threshold).changes;
    });

    // Rows older than the retention cutoff have already expired, so removing
    // them cannot change duplicate ranking among active decisions.
    return cleanup(cutoff);
  }

  deleteDecision(id: string | number): void {
    const existing = this.getDecisionById(id);
    if (existing) this.markDecisionDuplicateKey(existing.value, existing.simulated);
    this.deleteDecisionStatement.run({ $id: String(id) });
    this.deleteDecisionSearchIndex(id);
  }

  deleteCachedAlerts(ids: Array<string | number>): { alerts: number; decisions: number } {
    const normalizedIds = ids.map(String);
    this.deleteDecisionSearchIndexesByAlertIds(normalizedIds);
    this.markDecisionDuplicateKeysByAlertIds(normalizedIds);
    const decisions = runChunkedIdMutation(this.db, 'DELETE FROM decisions WHERE alert_id IN', normalizedIds);
    const alerts = runChunkedIdMutation(this.db, 'DELETE FROM alerts WHERE id IN', normalizedIds);
    this.deleteAlertSearchIndexes(normalizedIds);
    return { alerts, decisions };
  }

  deleteCachedDecisions(ids: Array<string | number>): number {
    const normalizedIds = ids.map(String);
    this.markDecisionDuplicateKeysByIds(normalizedIds);
    const changes = runChunkedIdMutation(this.db, 'DELETE FROM decisions WHERE id IN', normalizedIds);
    this.deleteDecisionSearchIndexes(normalizedIds);
    return changes;
  }

  getDecisionById(id: string | number): DecisionDataRow | null {
    return (this.getDecisionByIdStatement.get({ $id: String(id) }) as DecisionDataRow | null) || null;
  }

  getAlertInternalId(instanceId: string, upstreamId: string | number): number | null {
    const row = this.db.prepare('SELECT id FROM alerts WHERE instance_id = ? AND upstream_id = ?')
      .get(instanceId, String(upstreamId)) as { id: number } | undefined;
    return row ? Number(row.id) : null;
  }

  getDecisionInternalId(instanceId: string, upstreamId: string | number): string | null {
    const row = this.db.prepare('SELECT id FROM decisions WHERE instance_id = ? AND upstream_id = ?')
      .get(instanceId, String(upstreamId)) as { id: string } | undefined;
    return row ? String(row.id) : null;
  }

  deleteAlertByInstanceId(instanceId: string, upstreamId: string | number): void {
    const internalId = this.getAlertInternalId(instanceId, upstreamId);
    if (internalId !== null) this.deleteCachedAlerts([internalId]);
  }

  deleteDecisionByInstanceId(instanceId: string, upstreamId: string | number): void {
    const internalId = this.getDecisionInternalId(instanceId, upstreamId);
    if (internalId !== null) this.deleteDecision(internalId);
  }

  getDecisionIdsByAlertId(alertId: string | number, instanceId?: string): string[] {
    const internalAlertId = instanceId ? this.getAlertInternalId(instanceId, alertId) : alertId;
    if (internalAlertId === null) return [];
    if (instanceId) {
      return (this.db.prepare(`
        SELECT COALESCE(upstream_id, CAST(id AS TEXT)) AS id
        FROM decisions
        WHERE instance_id = ? AND alert_id = ?
      `).all(instanceId, internalAlertId) as Array<{ id: string | number }>).map((row) => String(row.id));
    }
    return (this.getDecisionIdsByAlertIdStatement.all({ $alert_id: internalAlertId }) as Array<{ id: string | number }>)
      .map((row) => String(row.id));
  }

  getDecisionDataByAlertIds(alertIds: Array<string | number>): Map<string, DecisionDataRow[]> {
    const result = new Map<string, DecisionDataRow[]>();
    const uniqueIds = Array.from(new Set(alertIds.map(String)));
    for (let offset = 0; offset < uniqueIds.length; offset += 900) {
      const chunk = uniqueIds.slice(offset, offset + 900);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT ${DECISION_RECORD_COLUMNS}
        FROM decisions
        WHERE alert_id IN (${placeholders})
        ORDER BY created_at DESC, id DESC
      `).all(...chunk) as DecisionDataRow[];
      for (const row of rows) {
        const key = String(row.alert_id);
        const items = result.get(key);
        if (items) items.push(row);
        else result.set(key, [row]);
      }
    }
    return result;
  }

  deleteDecisionsByAlertIdExcept(alertId: string | number, keepIds: string[], instanceId?: string): number {
    const keepSet = new Set(keepIds.map(String));
    const internalAlertId = instanceId ? this.getAlertInternalId(instanceId, alertId) : alertId;
    if (internalAlertId === null) return 0;
    const rows = instanceId
      ? this.db.prepare(`
          SELECT id, COALESCE(upstream_id, CAST(id AS TEXT)) AS upstream_id
          FROM decisions
          WHERE instance_id = ? AND alert_id = ?
        `).all(instanceId, internalAlertId) as Array<{ id: string | number; upstream_id: string }>
      : this.getDecisionIdsByAlertIdStatement.all({ $alert_id: internalAlertId }) as Array<{ id: string | number; upstream_id?: string }>;
    const staleIds = rows
      .filter((row) => !keepSet.has(String(row.upstream_id ?? row.id)))
      .map((row) => String(row.id));

    if (staleIds.length === 0) {
      return 0;
    }

    this.markDecisionDuplicateKeysByIds(staleIds);
    let changes = 0;
    const chunkSize = 900;
    for (let offset = 0; offset < staleIds.length; offset += chunkSize) {
      const chunk = staleIds.slice(offset, offset + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const statement = this.db.prepare(`DELETE FROM decisions WHERE id IN (${placeholders})`);
      changes += statement.run(...chunk).changes;
      this.deleteDecisionSearchIndexes(chunk);
    }

    return changes;
  }

  getDecisionStopAtBatch(ids: string[], instanceId?: string): Map<string, string> {
    const result = new Map<string, string>();
    if (ids.length === 0) return result;

    const chunkSize = 900;
    for (let offset = 0; offset < ids.length; offset += chunkSize) {
      const chunk = ids.slice(offset, offset + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const statement = instanceId
        ? this.db.prepare(`
            SELECT COALESCE(upstream_id, CAST(id AS TEXT)) AS id, stop_at
            FROM decisions
            WHERE instance_id = ? AND upstream_id IN (${placeholders})
          `)
        : this.db.prepare(`SELECT id, stop_at FROM decisions WHERE id IN (${placeholders})`);
      const rows = statement.all(...(instanceId ? [instanceId, ...chunk] : chunk)) as Array<{ id: string; stop_at: string }>;
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
        SELECT ${DECISION_RECORD_COLUMNS}
        FROM decisions
        WHERE id IN (${placeholders})
      `).all(...chunk) as Array<DecisionDataRow & { id: string | number }>;
      for (const row of rows) {
        result.set(String(row.id), row);
      }
    }

    return result;
  }

  getActiveDecisionByValue(value: string, now: string): DecisionDataRow | null {
    return (this.getActiveDecisionByValueStatement.get({ $value: value, $now: now }) as DecisionDataRow | null) || null;
  }

  deleteAlert(id: string | number): void {
    this.deleteAlertStatement.run({ $id: id });
    this.deleteAlertSearchIndex(id);
  }

  queueAlertDeletion(alertId: string | number, decisionIds: string[], requestedAt: string): void {
    this.db.prepare(`
      INSERT INTO pending_alert_deletions (
        alert_id, decision_ids_json, requested_at, decisions_deleted_at,
        delete_after, completed_at, attempt_count, last_attempt_at, last_error
      ) VALUES (?, ?, ?, NULL, NULL, NULL, 0, NULL, NULL)
      ON CONFLICT(alert_id) DO NOTHING
    `).run(String(alertId), JSON.stringify(Array.from(new Set(decisionIds.map(String)))), requestedAt);
    this.alertDeletionTombstones.add(String(alertId));
  }

  refreshAlertDeletionTombstones(): void {
    const rows = this.db.prepare('SELECT alert_id FROM pending_alert_deletions').all() as Array<{ alert_id: string | number }>;
    this.alertDeletionTombstones = new Set(rows.map((row) => String(row.alert_id)));
  }

  getPendingAlertDeletions(): PendingAlertDeletionRow[] {
    return this.db.prepare(`
      SELECT alert_id, decision_ids_json, requested_at, decisions_deleted_at,
             delete_after, completed_at, attempt_count, last_attempt_at, last_error
      FROM pending_alert_deletions
      WHERE completed_at IS NULL
      ORDER BY requested_at, alert_id
    `).all() as PendingAlertDeletionRow[];
  }

  markAlertDeletionDecisionsExpired(alertId: string | number, deletedAt: string, deleteAfter: string): void {
    this.db.prepare(`
      UPDATE pending_alert_deletions
      SET decisions_deleted_at = ?, delete_after = ?,
          attempt_count = attempt_count + 1, last_attempt_at = ?, last_error = NULL
      WHERE alert_id = ? AND completed_at IS NULL
    `).run(deletedAt, deleteAfter, deletedAt, String(alertId));
  }

  recordAlertDeletionFailure(alertId: string | number, attemptedAt: string, error: string): void {
    this.db.prepare(`
      UPDATE pending_alert_deletions
      SET attempt_count = attempt_count + 1, last_attempt_at = ?, last_error = ?
      WHERE alert_id = ? AND completed_at IS NULL
    `).run(attemptedAt, error, String(alertId));
  }

  completeAlertDeletion(alertId: string | number, completedAt: string): void {
    this.db.prepare(`
      UPDATE pending_alert_deletions
      SET completed_at = ?, last_attempt_at = ?, last_error = NULL
      WHERE alert_id = ? AND completed_at IS NULL
    `).run(completedAt, completedAt, String(alertId));
  }

  purgeCompletedAlertDeletions(completedBefore: string): number {
    const changes = this.db.prepare(`
      DELETE FROM pending_alert_deletions
      WHERE completed_at IS NOT NULL AND completed_at < ?
    `).run(completedBefore).changes;
    if (changes > 0) this.refreshAlertDeletionTombstones();
    return changes;
  }

  getAlertDeletionTombstone(alertId: string | number): PendingAlertDeletionRow | null {
    return (this.db.prepare(`
      SELECT alert_id, decision_ids_json, requested_at, decisions_deleted_at,
             delete_after, completed_at, attempt_count, last_attempt_at, last_error
      FROM pending_alert_deletions
      WHERE alert_id = ?
    `).get(String(alertId)) as PendingAlertDeletionRow | null) || null;
  }

  deleteDecisionsByAlertId(alertId: string | number): void {
    this.deleteDecisionSearchIndexesByAlertIds([String(alertId)]);
    this.markDecisionDuplicateKeysByAlertIds([String(alertId)]);
    this.deleteDecisionsByAlertIdStatement.run({ $alert_id: alertId });
  }

  private loadDecisionDuplicateRefreshState(): void {
    const rows = this.db.prepare(`
      SELECT key, value
      FROM meta
      WHERE key IN (
        'decision_duplicate_refresh_at',
        'decision_duplicate_flags_dirty',
        'decision_duplicate_rank_version'
      )
    `).all() as Array<{ key: string; value: string }>;
    const state = new Map(rows.map((row) => [row.key, row.value]));
    const refreshAt = state.get('decision_duplicate_refresh_at') || null;
    const rankVersionMatches = state.get('decision_duplicate_rank_version') === DECISION_DUPLICATE_RANK_VERSION;
    const dirty = state.get('decision_duplicate_flags_dirty') === 'true' || !rankVersionMatches;
    this.lastDecisionDuplicateRefreshAt = refreshAt;
    this.decisionDuplicateFlagsInitialized = refreshAt !== null && !dirty;
    this.decisionDuplicateFlagsDirty = dirty || refreshAt === null;
    this.ownsDecisionDuplicateDirtyMarker = false;
  }

  private markDecisionDuplicateKey(value: string | null | undefined, simulated: number | boolean | null | undefined): void {
    if (!this.decisionDuplicateFlagsInitialized && this.decisionDuplicateDirtyKeys.size === 0) {
      this.loadDecisionDuplicateRefreshState();
    }
    const key: DecisionDuplicateKeyRow = {
      value: value ?? null,
      simulated: simulated ? 1 : 0,
    };
    this.decisionDuplicateDirtyKeys.set(
      `${key.simulated}\u0000${key.value === null ? '\u0001' : `\u0002${key.value}`}`,
      key,
    );
    if (!this.decisionDuplicateFlagsDirty) {
      this.db.prepare(`
        INSERT INTO meta(key, value)
        VALUES ('decision_duplicate_flags_dirty', 'true')
        ON CONFLICT(key) DO UPDATE SET value = 'true'
      `).run();
      this.ownsDecisionDuplicateDirtyMarker = true;
    }
    this.decisionDuplicateFlagsDirty = true;
  }

  private markDecisionDuplicateKeysByIds(ids: string[]): void {
    this.markDecisionDuplicateKeysForColumn('id', ids);
  }

  private markDecisionDuplicateKeysByAlertIds(alertIds: string[]): void {
    this.markDecisionDuplicateKeysForColumn('alert_id', alertIds);
  }

  private markDecisionDuplicateKeysForColumn(column: 'id' | 'alert_id', values: string[]): void {
    const uniqueValues = Array.from(new Set(values));
    for (let offset = 0; offset < uniqueValues.length; offset += 900) {
      const chunk = uniqueValues.slice(offset, offset + 900);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT DISTINCT value, simulated
        FROM decisions
        WHERE ${column} IN (${placeholders})
      `).all(...chunk) as DecisionDuplicateKeyRow[];
      for (const row of rows) this.markDecisionDuplicateKey(row.value, row.simulated);
    }
  }

  refreshDecisionDuplicateFlags(now: string, force = false): number {
    if (!this.decisionDuplicateFlagsInitialized && this.decisionDuplicateDirtyKeys.size === 0) {
      this.loadDecisionDuplicateRefreshState();
    }
    const mustRefreshAll = force
      || !this.decisionDuplicateFlagsInitialized
      || (this.decisionDuplicateFlagsDirty && !this.ownsDecisionDuplicateDirtyMarker && this.decisionDuplicateDirtyKeys.size === 0);
    if (mustRefreshAll) {
      const result = this.db.prepare(`
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY instance_id, value, simulated
            ORDER BY
              stop_at DESC,
              CASE WHEN id GLOB '[0-9]*' THEN CAST(id AS INTEGER) ELSE -1 END DESC,
              id DESC
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
      this.decisionDuplicateDirtyKeys.clear();
      this.decisionDuplicateFlagsDirty = false;
      this.decisionDuplicateFlagsInitialized = true;
      this.lastDecisionDuplicateRefreshAt = now;
      this.ownsDecisionDuplicateDirtyMarker = false;
      this.persistDecisionDuplicateRefreshState(now);
      return result.changes;
    }

    const dirtyKeys = Array.from(this.decisionDuplicateDirtyKeys.values());
    if (this.lastDecisionDuplicateRefreshAt) {
      dirtyKeys.push(...this.db.prepare(`
        SELECT DISTINCT value, simulated
        FROM decisions
        WHERE stop_at > ? AND stop_at <= ?
      `).all(this.lastDecisionDuplicateRefreshAt, now) as DecisionDuplicateKeyRow[]);
    }

    const uniqueKeys = new Map<string, DecisionDuplicateKeyRow>();
    for (const key of dirtyKeys) {
      uniqueKeys.set(
        `${key.simulated}\u0000${key.value === null ? '\u0001' : `\u0002${key.value}`}`,
        key,
      );
    }
    if (uniqueKeys.size === 0 && !this.decisionDuplicateFlagsDirty) {
      this.lastDecisionDuplicateRefreshAt = now;
      this.persistDecisionDuplicateRefreshState(now);
      return 0;
    }
    if (uniqueKeys.size === 0 && this.decisionDuplicateFlagsDirty) {
      return this.refreshDecisionDuplicateFlags(now, true);
    }

    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS decision_duplicate_refresh_keys (
        value TEXT NOT NULL,
        value_is_null INTEGER NOT NULL,
        simulated INTEGER NOT NULL,
        PRIMARY KEY (value, value_is_null, simulated)
      ) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS decision_duplicate_refresh_updates (
        id TEXT PRIMARY KEY,
        is_duplicate INTEGER NOT NULL
      ) WITHOUT ROWID;
      DELETE FROM decision_duplicate_refresh_keys;
      DELETE FROM decision_duplicate_refresh_updates;
    `);
    const insertKey = this.db.prepare(`
      INSERT OR IGNORE INTO decision_duplicate_refresh_keys(value, value_is_null, simulated)
      VALUES (?, ?, ?)
    `);
    const populateKeys = (keys: DecisionDuplicateKeyRow[]) => {
      for (const key of keys) insertKey.run(key.value ?? '', key.value === null ? 1 : 0, key.simulated);
    };

    const populateUpdates = this.db.prepare(`
      INSERT INTO decision_duplicate_refresh_updates(id, is_duplicate)
      WITH ranked AS (
        SELECT
          decisions.id,
          ROW_NUMBER() OVER (
            PARTITION BY decisions.instance_id, decisions.value, decisions.simulated
            ORDER BY
              decisions.stop_at DESC,
              CASE WHEN decisions.id GLOB '[0-9]*' THEN CAST(decisions.id AS INTEGER) ELSE -1 END DESC,
              decisions.id DESC
          ) AS duplicate_rank
        FROM decision_duplicate_refresh_keys AS dirty
        CROSS JOIN decisions INDEXED BY idx_decisions_duplicate_primary
          ON decisions.simulated = dirty.simulated
         AND (decisions.value = dirty.value OR (dirty.value_is_null = 1 AND decisions.value IS NULL))
        WHERE decisions.stop_at > ?
      )
      SELECT
        decisions.id,
        CASE WHEN ranked.duplicate_rank > 1 THEN 1 ELSE 0 END
      FROM decision_duplicate_refresh_keys AS dirty
      CROSS JOIN decisions INDEXED BY idx_decisions_duplicate_primary
        ON decisions.simulated = dirty.simulated
       AND (decisions.value = dirty.value OR (dirty.value_is_null = 1 AND decisions.value IS NULL))
      LEFT JOIN ranked ON ranked.id = decisions.id
    `);
    const updateFlags = this.db.prepare(`
      UPDATE decisions
      SET is_duplicate = (
        SELECT refresh.is_duplicate
        FROM decision_duplicate_refresh_updates AS refresh
        WHERE refresh.id = decisions.id
      )
      WHERE id IN (SELECT id FROM decision_duplicate_refresh_updates)
        AND is_duplicate <> (
          SELECT refresh.is_duplicate
          FROM decision_duplicate_refresh_updates AS refresh
          WHERE refresh.id = decisions.id
        )
    `);
    const clearKeys = this.db.prepare('DELETE FROM decision_duplicate_refresh_keys');
    const clearUpdates = this.db.prepare('DELETE FROM decision_duplicate_refresh_updates');
    const refreshDirtyKeys = this.db.transaction((keys: DecisionDuplicateKeyRow[]) => {
      populateKeys(keys);
      populateUpdates.run(now);
      const changes = updateFlags.run().changes;
      clearKeys.run();
      clearUpdates.run();
      return changes;
    });
    const changes = refreshDirtyKeys(Array.from(uniqueKeys.values()));
    this.decisionDuplicateDirtyKeys.clear();
    this.decisionDuplicateFlagsDirty = false;
    this.decisionDuplicateFlagsInitialized = true;
    this.lastDecisionDuplicateRefreshAt = now;
    this.ownsDecisionDuplicateDirtyMarker = false;
    this.persistDecisionDuplicateRefreshState(now);
    return changes;
  }

  private persistDecisionDuplicateRefreshState(now: string): void {
    const persist = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO meta(key, value)
        VALUES ('decision_duplicate_refresh_at', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(now);
      this.db.prepare(`
        INSERT INTO meta(key, value)
        VALUES ('decision_duplicate_flags_dirty', 'false')
        ON CONFLICT(key) DO UPDATE SET value = 'false'
      `).run();
      this.db.prepare(`
        INSERT INTO meta(key, value)
        VALUES ('decision_duplicate_rank_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(DECISION_DUPLICATE_RANK_VERSION);
    });
    persist();
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
    this.upsertNotificationChannelStatement.run({
      ...params,
      $created_at: normalizeIsoTimestamp(params.$created_at),
      $updated_at: normalizeIsoTimestamp(params.$updated_at),
    });
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
    this.upsertNotificationRuleStatement.run({
      ...params,
      $created_at: normalizeIsoTimestamp(params.$created_at),
      $updated_at: normalizeIsoTimestamp(params.$updated_at),
    });
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
    return this.insertNotificationStatement.run({
      ...params,
      $created_at: normalizeIsoTimestamp(params.$created_at),
      $updated_at: normalizeIsoTimestamp(params.$updated_at),
      $read_at: params.$read_at === null ? null : normalizeIsoTimestamp(params.$read_at),
      $metadata_json: normalizeTimestampJson(params.$metadata_json),
      $deliveries_json: normalizeTimestampJson(params.$deliveries_json),
    }).changes > 0;
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
    this.upsertNotificationIncidentStatement.run({
      ...params,
      $first_seen_at: normalizeIsoTimestamp(params.$first_seen_at),
      $last_seen_at: normalizeIsoTimestamp(params.$last_seen_at),
      $resolved_at: params.$resolved_at === null ? null : normalizeIsoTimestamp(params.$resolved_at),
    });
  }

  resolveNotificationIncident(ruleId: string, incidentKey: string, resolvedAt: string): boolean {
    const normalizedResolvedAt = normalizeIsoTimestamp(resolvedAt);
    return this.resolveNotificationIncidentStatement.run({
      $rule_id: ruleId,
      $incident_key: incidentKey,
      $resolved_at: normalizedResolvedAt,
      $last_seen_at: normalizedResolvedAt,
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
    const normalizedReadAt = normalizeIsoTimestamp(readAt);
    return this.markNotificationReadStatement.run({
      $id: id,
      $read_at: normalizedReadAt,
      $updated_at: normalizedReadAt,
    }).changes > 0;
  }

  markNotificationsRead(ids: string[], readAt: string): number {
    const normalizedReadAt = normalizeIsoTimestamp(readAt);
    return runChunkedIdMutation(
      this.db,
      'UPDATE notifications SET read_at = ?, updated_at = ? WHERE read_at IS NULL AND id IN',
      ids,
      [normalizedReadAt, normalizedReadAt],
    );
  }

  markAllNotificationsRead(readAt: string): number {
    const normalizedReadAt = normalizeIsoTimestamp(readAt);
    return this.markAllNotificationsReadStatement.run({
      $read_at: normalizedReadAt,
      $updated_at: normalizedReadAt,
    }).changes;
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
    this.upsertCveCacheEntryStatement.run({
      $id: id,
      $published_at: normalizeIsoTimestamp(publishedAt),
      $fetched_at: normalizeIsoTimestamp(fetchedAt),
    });
  }

  transaction<T>(callback: (value: T) => void): (value: T) => void {
    return this.db.transaction(callback);
  }

  private clearSearchIndexes(): void {
    if (!this.searchIndexAvailable) return;
    this.runSearchIndexStatement('DELETE FROM alerts_fts');
    this.runSearchIndexStatement('DELETE FROM decisions_fts');
    this.runSearchIndexStatement('DELETE FROM decision_fts_rows');
  }

  private upsertAlertSearchIndex(id: string | number, searchText: string): void {
    if (this.searchIndexUpdatesDeferred) return;
    if (!this.searchIndexAvailable || !this.deleteAlertSearchIndexStatement || !this.insertAlertSearchIndexStatement) return;
    const numericId = Number(id);
    if (!Number.isSafeInteger(numericId) || numericId === 0) return;
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
      this.deleteDecisionSearchIndex(id);
      this.insertDecisionSearchIndexRow(String(id), searchText);
    } catch {
      // Search indexing is an optimization; core table data remains authoritative.
    }
  }

  private insertDecisionSearchIndexRow(id: string, searchText: string): void {
    if (!this.insertDecisionSearchIndexStatement || !this.upsertDecisionSearchRowStatement) return;
    const result = this.insertDecisionSearchIndexStatement.run(id, searchText);
    if (result.lastInsertRowid === undefined) return;
    this.upsertDecisionSearchRowStatement.run(id, result.lastInsertRowid);
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
    if (!this.searchIndexAvailable || !this.deleteDecisionSearchIndexStatement || !this.deleteDecisionSearchRowStatement) return;
    try {
      this.deleteDecisionSearchIndexStatement.run(String(id));
      this.deleteDecisionSearchRowStatement.run(String(id));
    } catch {
      // Search indexing is an optimization; core table data remains authoritative.
    }
  }

  private deleteDecisionSearchIndexes(ids: string[]): void {
    if (!this.searchIndexAvailable || ids.length === 0) return;
    const chunkSize = 900;
    for (let offset = 0; offset < ids.length; offset += chunkSize) {
      const chunk = ids.slice(offset, offset + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      this.db.prepare(`
        DELETE FROM decisions_fts
        WHERE rowid IN (
          SELECT fts_rowid
          FROM decision_fts_rows
          WHERE decision_id IN (${placeholders})
        )
      `).run(...chunk);
      this.db.prepare(`DELETE FROM decision_fts_rows WHERE decision_id IN (${placeholders})`).run(...chunk);
    }
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

function openDatabase(dbPath: string, walEnabled: boolean): Database {
  try {
    return configureDatabase(createDatabase(dbPath), walEnabled);
  } catch (error: any) {
    if (dbPath.startsWith('/app/data') && error?.code === 'EACCES') {
      return configureDatabase(createDatabase('crowdsec.db'), walEnabled);
    }
    throw error;
  }
}

function configureDatabase(database: Database, walEnabled: boolean): Database {
  database.exec(`PRAGMA journal_mode = ${walEnabled ? 'WAL' : 'DELETE'}`);
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA synchronous = NORMAL');
  database.exec('PRAGMA cache_size = -32000');
  database.exec('PRAGMA temp_store = MEMORY');
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec('PRAGMA mmap_size = 268435456');
  registerDatabaseFunctions(database);
  return database;
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
      AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
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
      instance_id TEXT NOT NULL DEFAULT 'default',
      upstream_id TEXT,
      uuid TEXT,
      created_at TEXT NOT NULL,
      start_at TEXT,
      stop_at TEXT,
      scenario TEXT,
      record_scenario TEXT,
      reason TEXT,
      source_ip TEXT,
      source_value TEXT,
      source_scope TEXT,
      source_range TEXT,
      source_as_number TEXT,
      source_extra_data TEXT,
      message TEXT,
      machine_id TEXT,
      machine_alias TEXT,
      events_count INTEGER,
      extra_data TEXT,
      metadata_hash TEXT,
      raw_data TEXT,
      latitude REAL,
      longitude REAL,
      country TEXT,
      country_name TEXT,
      region TEXT,
      city TEXT,
      as_name TEXT,
      target TEXT,
      machine TEXT,
      meta_search TEXT,
      origins TEXT,
      simulated INTEGER NOT NULL DEFAULT 0,
      search_text TEXT
      , UNIQUE(instance_id, upstream_id)
      , UNIQUE(instance_id, uuid)
    );
  `;

  const createDecisionsTable = `
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL DEFAULT 'default',
      upstream_id TEXT,
      uuid TEXT,
      alert_id INTEGER,
      alert_upstream_id TEXT,
      created_at TEXT NOT NULL,
      stop_at TEXT NOT NULL,
      value TEXT,
      type TEXT,
      origin TEXT,
      scenario TEXT,
      duration TEXT,
      scope TEXT,
      extra_data TEXT,
      raw_data TEXT,
      country TEXT,
      country_name TEXT,
      region TEXT,
      city TEXT,
      as_name TEXT,
      target TEXT,
      machine TEXT,
      simulated INTEGER NOT NULL DEFAULT 0,
      search_text TEXT,
      is_duplicate INTEGER NOT NULL DEFAULT 0
      , UNIQUE(instance_id, upstream_id)
      , UNIQUE(instance_id, uuid)
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

  const createPendingAlertDeletionsTable = `
    CREATE TABLE IF NOT EXISTS pending_alert_deletions (
      alert_id TEXT PRIMARY KEY,
      decision_ids_json TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      decisions_deleted_at TEXT,
      delete_after TEXT,
      completed_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pending_alert_deletions_due
      ON pending_alert_deletions(completed_at, delete_after, requested_at);
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
  db.exec(createPendingAlertDeletionsTable);

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
        INSERT OR REPLACE INTO decisions (id, instance_id, upstream_id, uuid, alert_id, alert_upstream_id, created_at, stop_at, value, type, origin, scenario, raw_data)
        VALUES ($id, 'default', $id, $uuid, $alert_id, $alert_id, $created_at, $stop_at, $value, $type, $origin, $scenario, $raw_data)
      `);

      const restore = db.transaction((decisions: Array<Record<string, unknown>>) => {
        for (const decision of decisions) {
          (insertStatement as any).run({
            $id: String(decision.id),
            $uuid: decision.uuid,
            $alert_id: decision.alert_id,
            $created_at: normalizeIsoTimestamp(String(decision.created_at)),
            $stop_at: normalizeIsoTimestamp(String(decision.stop_at)),
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

  db.exec(`
    DROP TRIGGER IF EXISTS alerts_pending_deletion_insert_guard;
    DROP TRIGGER IF EXISTS alerts_pending_deletion_update_guard;
    DROP TRIGGER IF EXISTS decisions_pending_alert_deletion_insert_guard;
    DROP TRIGGER IF EXISTS decisions_pending_alert_deletion_update_guard;
  `);

  migrateTimestamps(db);
  migrateInstanceIdentityColumns(db);
  migrateRecordIndexColumns(db);
  migrateNormalizedDecisionPayloads(db);
  migrateNormalizedAlertPayloads(db);
  initDecisionDuplicateDirtyTracking(db);
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

function migrateInstanceIdentityColumns(db: Database): void {
  const alertColumns = new Set((db.query('PRAGMA table_info(alerts)').all() as Array<{ name: string }>).map((column) => column.name));
  const migratedAlerts = !alertColumns.has('instance_id') || !alertColumns.has('upstream_id');
  if (!alertColumns.has('instance_id')) db.exec("ALTER TABLE alerts ADD COLUMN instance_id TEXT NOT NULL DEFAULT 'default'");
  if (!alertColumns.has('upstream_id')) {
    db.exec('ALTER TABLE alerts ADD COLUMN upstream_id TEXT');
    db.exec('UPDATE alerts SET upstream_id = CAST(id AS TEXT) WHERE upstream_id IS NULL');
  }
  const decisionColumns = new Set((db.query('PRAGMA table_info(decisions)').all() as Array<{ name: string }>).map((column) => column.name));
  const migratedDecisions = !decisionColumns.has('instance_id') || !decisionColumns.has('upstream_id');
  if (!decisionColumns.has('instance_id')) db.exec("ALTER TABLE decisions ADD COLUMN instance_id TEXT NOT NULL DEFAULT 'default'");
  if (!decisionColumns.has('upstream_id')) {
    db.exec('ALTER TABLE decisions ADD COLUMN upstream_id TEXT');
    db.exec('UPDATE decisions SET upstream_id = CAST(id AS TEXT) WHERE upstream_id IS NULL');
  }
  if (!decisionColumns.has('alert_upstream_id')) {
    db.exec('ALTER TABLE decisions ADD COLUMN alert_upstream_id TEXT');
    db.exec('UPDATE decisions SET alert_upstream_id = CAST(alert_id AS TEXT) WHERE alert_upstream_id IS NULL');
  }
  const rebuiltAlerts = rebuildTableWithoutGlobalUuidConstraint(db, 'alerts');
  const rebuiltDecisions = rebuildTableWithoutGlobalUuidConstraint(db, 'decisions');
  if (migratedAlerts && !rebuiltAlerts) db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_instance_upstream ON alerts(instance_id, upstream_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_instance_uuid ON alerts(instance_id, uuid) WHERE uuid IS NOT NULL;
  `);
  if (migratedDecisions && !rebuiltDecisions) db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_instance_upstream ON decisions(instance_id, upstream_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_instance_uuid ON decisions(instance_id, uuid) WHERE uuid IS NOT NULL;
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alerts_instance_created ON alerts(instance_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_decisions_instance_created ON decisions(instance_id, created_at DESC, id DESC);
  `);
}

type InstanceIdentityTable = 'alerts' | 'decisions';

interface SqliteTableColumn {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function sqliteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function hasGlobalUuidConstraint(db: Database, table: InstanceIdentityTable): boolean {
  const indexes = db.query(`PRAGMA index_list(${sqliteString(table)})`).all() as Array<{ name: string; unique: number }>;
  return indexes.some((index) => {
    if (!index.unique) return false;
    const columns = db.query(`PRAGMA index_info(${sqliteString(index.name)})`).all() as Array<{ name: string }>;
    return columns.length === 1 && columns[0].name === 'uuid';
  });
}

function rebuildTableWithoutGlobalUuidConstraint(db: Database, table: InstanceIdentityTable): boolean {
  if (!hasGlobalUuidConstraint(db, table)) return false;

  const columns = db.query(`PRAGMA table_info(${sqliteString(table)})`).all() as SqliteTableColumn[];
  const tempTable = `${table}_instance_identity_migration`;
  const columnDefinitions = columns.map((column) => {
    const parts = [quoteIdentifier(column.name), column.type];
    if (column.pk) parts.push('PRIMARY KEY');
    if (column.notnull && !column.pk) parts.push('NOT NULL');
    if (column.dflt_value !== null) parts.push(`DEFAULT ${column.dflt_value}`);
    return parts.filter(Boolean).join(' ');
  });
  const columnNames = columns.map((column) => quoteIdentifier(column.name)).join(', ');

  const migrate = db.transaction(() => {
    db.exec(`
      DROP TABLE IF EXISTS ${quoteIdentifier(tempTable)};
      CREATE TABLE ${quoteIdentifier(tempTable)} (
        ${columnDefinitions.join(',\n        ')},
        UNIQUE(instance_id, upstream_id),
        UNIQUE(instance_id, uuid)
      );
      INSERT INTO ${quoteIdentifier(tempTable)} (${columnNames})
      SELECT ${columnNames} FROM ${quoteIdentifier(table)};
      DROP TABLE ${quoteIdentifier(table)};
      ALTER TABLE ${quoteIdentifier(tempTable)} RENAME TO ${quoteIdentifier(table)};
    `);
  });
  migrate();
  return true;
}


function initDecisionDuplicateDirtyTracking(db: Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS decisions_duplicate_dirty_insert;
    DROP TRIGGER IF EXISTS decisions_duplicate_dirty_delete;
    DROP TRIGGER IF EXISTS decisions_duplicate_dirty_update;
    DROP TABLE IF EXISTS decision_duplicate_dirty;
    DELETE FROM meta WHERE key = 'decision_duplicate_tracking_enabled';
  `);
}

const TIMESTAMP_MIGRATIONS = [
  { table: 'alerts', timestampColumns: ['created_at'], jsonColumns: ['raw_data'] },
  { table: 'decisions', timestampColumns: ['created_at', 'stop_at'], jsonColumns: ['raw_data'] },
  { table: 'auth_users', timestampColumns: ['created_at', 'updated_at'] },
  { table: 'webauthn_credentials', timestampColumns: ['created_at'] },
  { table: 'notification_channels', timestampColumns: ['created_at', 'updated_at'] },
  { table: 'notification_rules', timestampColumns: ['created_at', 'updated_at'] },
  {
    table: 'notifications',
    timestampColumns: ['created_at', 'updated_at', 'read_at'],
    jsonColumns: ['metadata_json', 'deliveries_json'],
  },
  {
    table: 'notification_incidents',
    timestampColumns: ['first_seen_at', 'last_seen_at', 'resolved_at'],
  },
  { table: 'cve_cache', timestampColumns: ['published_at', 'fetched_at'] },
] as const;

function migrateTimestamps(db: Database): void {
  const migrationKey = 'sync_timestamp_format_version';
  const currentVersion = db.query('SELECT value FROM meta WHERE key = ?').get(migrationKey) as MetaRow | null;
  if (currentVersion?.value === '2') return;

  const migrate = db.transaction(() => {
    for (const migration of TIMESTAMP_MIGRATIONS) {
      const timestampColumns = [...migration.timestampColumns];
      const jsonColumns = 'jsonColumns' in migration ? [...migration.jsonColumns] : [];
      const columns = [...timestampColumns, ...jsonColumns];
      const rows = db.query(`
        SELECT rowid AS migration_rowid, ${columns.join(', ')}
        FROM ${migration.table}
      `).all() as Array<Record<string, unknown>>;
      const update = db.query(`
        UPDATE ${migration.table}
        SET ${columns.map((column) => `${column} = $${column}`).join(', ')}
        WHERE rowid = $migration_rowid
      `);

      for (const row of rows) {
        let changed = false;
        const params: Record<string, unknown> = { $migration_rowid: row.migration_rowid };
        for (const column of timestampColumns) {
          const original = row[column];
          const normalized = typeof original === 'string' ? normalizeIsoTimestamp(original) : original;
          params[`$${column}`] = normalized;
          changed ||= normalized !== original;
        }
        for (const column of jsonColumns) {
          const original = row[column];
          const normalized = typeof original === 'string' ? normalizeTimestampJson(original) : original;
          params[`$${column}`] = normalized;
          changed ||= normalized !== original;
        }
        if (changed) {
          update.run(params);
        }
      }
    }
    db.query('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(migrationKey, '2');
  });
  migrate();
}

function migrateRecordIndexColumns(db: Database): void {
  const existingAlertColumns = new Set(
    (db.query('PRAGMA table_info(alerts)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  const shouldBackfillAlertLocations = !existingAlertColumns.has('latitude') || !existingAlertColumns.has('longitude');
  const shouldBackfillResolvedAlertLocations = !existingAlertColumns.has('region') || !existingAlertColumns.has('city');
  const existingDecisionColumns = new Set(
    (db.query('PRAGMA table_info(decisions)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  const shouldBackfillResolvedDecisionLocations = !existingDecisionColumns.has('region') || !existingDecisionColumns.has('city');

  ensureColumns(db, 'alerts', [
    ['start_at', 'TEXT'],
    ['stop_at', 'TEXT'],
    ['record_scenario', 'TEXT'],
    ['reason', 'TEXT'],
    ['source_value', 'TEXT'],
    ['source_scope', 'TEXT'],
    ['source_range', 'TEXT'],
    ['source_as_number', 'TEXT'],
    ['source_extra_data', 'TEXT'],
    ['machine_id', 'TEXT'],
    ['machine_alias', 'TEXT'],
    ['events_count', 'INTEGER'],
    ['extra_data', 'TEXT'],
    ['metadata_hash', 'TEXT'],
    ['latitude', 'REAL'],
    ['longitude', 'REAL'],
    ['country', 'TEXT'],
    ['country_name', 'TEXT'],
    ['region', 'TEXT'],
    ['city', 'TEXT'],
    ['as_name', 'TEXT'],
    ['target', 'TEXT'],
    ['machine', 'TEXT'],
    ['meta_search', 'TEXT'],
    ['origins', 'TEXT'],
    ['simulated', 'INTEGER NOT NULL DEFAULT 0'],
    ['search_text', 'TEXT'],
  ]);
  ensureColumns(db, 'decisions', [
    ['duration', 'TEXT'],
    ['scope', 'TEXT'],
    ['extra_data', 'TEXT'],
    ['country', 'TEXT'],
    ['country_name', 'TEXT'],
    ['region', 'TEXT'],
    ['city', 'TEXT'],
    ['as_name', 'TEXT'],
    ['target', 'TEXT'],
    ['machine', 'TEXT'],
    ['simulated', 'INTEGER NOT NULL DEFAULT 0'],
    ['search_text', 'TEXT'],
    ['is_duplicate', 'INTEGER NOT NULL DEFAULT 0'],
  ]);

  if (shouldBackfillAlertLocations) {
    backfillAlertLocationColumns(db);
  }
  if (shouldBackfillResolvedAlertLocations || shouldBackfillResolvedDecisionLocations) {
    backfillResolvedLocationColumns(db);
  }

  // Replaced by idx_decisions_alert_created_id, which also satisfies the
  // deterministic decision paging order and covers the history predicate.
  db.exec('DROP INDEX IF EXISTS idx_decisions_alert_created_at');
  // Replaced by a covering index so alert-list summaries do not have to read
  // every matching decision row or build a temporary GROUP BY table.
  db.exec('DROP INDEX IF EXISTS idx_decisions_alert_id');
  db.exec('DROP INDEX IF EXISTS idx_decisions_duplicate_created_at');
  db.exec('DROP INDEX IF EXISTS idx_decisions_duplicate_active');
  db.exec(CREATE_SYNC_SECONDARY_INDEXES_SQL);

  backfillRecordIndexes(db);
}

function migrateNormalizedDecisionPayloads(db: Database): void {
  const migrationKey = 'normalized_decision_payload_version';
  const currentVersion = db.query('SELECT value FROM meta WHERE key = ?').get(migrationKey) as MetaRow | null;
  const selectRows = db.query(`
    SELECT rowid AS migration_rowid, raw_data
    FROM decisions
    WHERE raw_data IS NOT NULL
    LIMIT 1000
  `);
  let rows = selectRows.all() as Array<{ migration_rowid: number; raw_data: string }>;
  if (currentVersion?.value === '1' && rows.length === 0) return;
  const update = db.query(`
    UPDATE decisions
    SET duration = COALESCE(duration, $duration),
        scope = COALESCE(scope, $scope),
        extra_data = $extra_data,
        raw_data = NULL
    WHERE rowid = $migration_rowid
  `);
  const migrateBatch = db.transaction((items: typeof rows) => {
    for (const row of items) {
      const decision = parseDecisionPayload(row.raw_data);
      update.run({
        $migration_rowid: row.migration_rowid,
        $duration: readOptionalString(decision?.duration),
        $scope: readOptionalString(decision?.scope),
        $extra_data: decision
          ? serializeDecisionExtras(decision)
          : JSON.stringify({ legacy_payload: row.raw_data }),
      });
    }
  });
  while (rows.length > 0) {
    migrateBatch(rows);
    rows = selectRows.all() as typeof rows;
  }
  db.query('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(migrationKey, '1');
}

function migrateNormalizedAlertPayloads(db: Database): void {
  const migrationKey = 'normalized_alert_payload_version';
  const currentVersion = db.query('SELECT value FROM meta WHERE key = ?').get(migrationKey) as MetaRow | null;
  const selectRows = db.query(`
    SELECT id, raw_data
    FROM alerts
    WHERE raw_data IS NOT NULL
    LIMIT 500
  `);
  let rows = selectRows.all() as Array<{ id: string | number; raw_data: string }>;
  if (currentVersion?.value === '1' && rows.length === 0) return;
  const update = db.query(`
    UPDATE alerts
    SET start_at = $start_at,
        stop_at = $stop_at,
        record_scenario = $record_scenario,
        reason = $reason,
        source_value = $source_value,
        source_scope = $source_scope,
        source_range = $source_range,
        source_as_number = $source_as_number,
        source_extra_data = $source_extra_data,
        machine_id = $machine_id,
        machine_alias = $machine_alias,
        events_count = $events_count,
        extra_data = $extra_data,
        metadata_hash = $metadata_hash,
        raw_data = NULL
    WHERE id = $id
  `);
  const migrateBatch = db.transaction((items: typeof rows) => {
    for (const row of items) {
      const alert = parseAlertPayload(row.raw_data);
      const source = alert?.source || null;
      update.run({
        $id: row.id,
        $start_at: normalizeOptionalTimestamp(alert?.start_at),
        $stop_at: normalizeOptionalTimestamp(alert?.stop_at),
        $record_scenario: readOptionalString(alert?.scenario),
        $reason: readOptionalString(alert?.reason),
        $source_value: readOptionalString(source?.value),
        $source_scope: readOptionalString(source?.scope),
        $source_range: readOptionalString(source?.range),
        $source_as_number: source?.as_number === undefined || source?.as_number === null ? null : String(source.as_number),
        $source_extra_data: serializeAlertSourceExtras(source),
        $machine_id: readOptionalString(alert?.machine_id),
        $machine_alias: readOptionalString(alert?.machine_alias),
        $events_count: typeof alert?.events_count === 'number' ? alert.events_count : null,
        $extra_data: alert
          ? serializeAlertExtras(alert)
          : JSON.stringify({ legacy_payload: row.raw_data }),
        $metadata_hash: alertMetadataFingerprint(alert),
      });
    }
  });
  while (rows.length > 0) {
    migrateBatch(rows);
    rows = selectRows.all() as typeof rows;
  }
  db.query('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(migrationKey, '1');
}

function backfillAlertLocationColumns(db: Database): void {
  db.exec(`
    UPDATE alerts
    SET latitude = CASE
          WHEN json_valid(raw_data)
            AND CAST(json_extract(raw_data, '$.source.latitude') AS REAL) BETWEEN -90 AND 90
          THEN CAST(json_extract(raw_data, '$.source.latitude') AS REAL)
          ELSE NULL
        END,
        longitude = CASE
          WHEN json_valid(raw_data)
            AND CAST(json_extract(raw_data, '$.source.longitude') AS REAL) BETWEEN -180 AND 180
          THEN CAST(json_extract(raw_data, '$.source.longitude') AS REAL)
          ELSE NULL
        END
  `);
}

function backfillResolvedLocationColumns(db: Database): void {
  db.exec(`
    UPDATE alerts
    SET region = CASE WHEN json_valid(raw_data) THEN json_extract(raw_data, '$.source.region') ELSE NULL END,
        city = CASE WHEN json_valid(raw_data) THEN json_extract(raw_data, '$.source.city') ELSE NULL END;
    UPDATE decisions
    SET region = CASE WHEN json_valid(raw_data) THEN json_extract(raw_data, '$.region') ELSE NULL END,
        city = CASE WHEN json_valid(raw_data) THEN json_extract(raw_data, '$.city') ELSE NULL END;
  `);
}

function ensureColumns(db: Database, tableName: string, columns: Array<[string, string]>): void {
  const existing = new Set((db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((column) => column.name));
  for (const [name, definition] of columns) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${name} ${definition}`);
    }
  }
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeOptionalTimestamp(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? normalizeIsoTimestamp(value) : null;
}

function alertRowsToLegacyPayloads(rows: AlertDataRow[]): RowWithRawData[] {
  return rows.map((row) => ({
    raw_data: JSON.stringify(alertFromRow(row)),
    created_at: row.created_at,
  }));
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
        latitude = $latitude,
        longitude = $longitude,
        country = $country,
        country_name = $country_name,
        region = $region,
        city = $city,
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
          $latitude: index.latitude,
          $longitude: index.longitude,
          $country: index.country,
          $country_name: index.countryName,
          $region: index.region,
          $city: index.city,
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
        region = $region,
        city = $city,
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
          $region: index.region,
          $city: index.city,
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
    dropLegacySearchIndexes(db);
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS alerts_fts USING fts5(
        alert_id UNINDEXED,
        search_text,
        tokenize = 'trigram'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
        decision_id UNINDEXED,
        search_text,
        tokenize = 'trigram'
      );
      CREATE TABLE IF NOT EXISTS decision_fts_rows (
        decision_id TEXT PRIMARY KEY,
        fts_rowid INTEGER NOT NULL UNIQUE
      );
    `);
    synchronizeDecisionSearchRows(db);
    return true;
  } catch (error) {
    console.warn('SQLite FTS5 is unavailable; falling back to LIKE search.', (error as Error).message);
    return false;
  }
}

function dropLegacySearchIndexes(db: Database): void {
  const definitions = db.query(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type = 'table' AND name IN ('alerts_fts', 'decisions_fts')
  `).all() as Array<{ name: string; sql?: string | null }>;
  if (definitions.length === 0 || definitions.every((definition) => /tokenize\s*=\s*['"]trigram['"]/i.test(definition.sql || ''))) {
    return;
  }

  db.exec(`
    DROP TABLE IF EXISTS alerts_fts;
    DROP TABLE IF EXISTS decisions_fts;
    DROP TABLE IF EXISTS decision_fts_rows;
  `);
}

function backfillSearchIndexes(db: Database): void {
  const alertCount = (db.query('SELECT COUNT(*) AS count FROM alerts_fts').get() as CountRow | null)?.count || 0;
  if (alertCount === 0) {
    db.exec(`
      INSERT INTO alerts_fts(rowid, alert_id, search_text)
      SELECT CAST(id AS INTEGER), CAST(id AS TEXT), search_text
      FROM alerts
      WHERE id <> 0
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
  synchronizeDecisionSearchRows(db);
}

function synchronizeDecisionSearchRows(db: Database): void {
  const searchCount = (db.query('SELECT COUNT(*) AS count FROM decisions_fts').get() as CountRow | null)?.count || 0;
  const mappingCount = (db.query('SELECT COUNT(*) AS count FROM decision_fts_rows').get() as CountRow | null)?.count || 0;
  if (searchCount === mappingCount) return;

  const synchronize = db.transaction(() => {
    db.exec('DELETE FROM decision_fts_rows');
    db.exec(`
      INSERT OR REPLACE INTO decision_fts_rows (decision_id, fts_rowid)
      SELECT CAST(decision_id AS TEXT), rowid
      FROM decisions_fts
    `);
  });
  synchronize();
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
    const insertMapping = db.prepare('INSERT OR REPLACE INTO decision_fts_rows(decision_id, fts_rowid) VALUES (?, ?)');
    for (const row of rows) {
      const result = insert.run(String(row.id), row.search_text);
      if (result.lastInsertRowid !== undefined) {
        insertMapping.run(String(row.id), result.lastInsertRowid);
      }
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
        $created_at: normalizeIsoTimestamp(String(rule.created_at)),
        $updated_at: normalizeIsoTimestamp(String(rule.updated_at)),
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
        $created_at: normalizeIsoTimestamp(String(notification.created_at)),
        $updated_at: normalizeIsoTimestamp(String(notification.updated_at)),
        $rule_id: String(notification.rule_id),
        $rule_name: String(notification.rule_name),
        $rule_type: String(notification.rule_type),
        $severity: String(notification.severity),
        $title: String(notification.title),
        $message: String(notification.message),
        $read_at: notification.read_at == null ? null : normalizeIsoTimestamp(String(notification.read_at)),
        $metadata_json: normalizeTimestampJson(String(notification.metadata_json || '{}')),
        $deliveries_json: normalizeTimestampJson(String(notification.deliveries_json || '[]')),
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
    const createdAt = normalizeIsoTimestamp(String(row.created_at || ''));
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
