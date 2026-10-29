import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
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

export const RECENT_FILTER_LIMIT = 5;
const DEFAULT_DATA_DIR = '/app/data';
export const CACHE_DATABASE_FILE = 'cache.db';
export const STATE_DATABASE_FILE = 'state.db';
const LEGACY_DATABASE_FILE = 'crowdsec.db';
const STATE_SCHEMA = 'state';
export const INITIAL_OIDC_LOGOUT_VERSION = 1;
export const OIDC_END_SESSION_LEGACY_DEFAULT_KEY = 'auth_oidc_end_session_legacy_default';
// Settings that must survive losing cache.db. They are stored in state.db; every other
// meta key is cache bookkeeping that stays in cache.db.
/** Per-instance allowlist sync state: `<prefix><instance id>` holds JSON with the status and snapshot hash. */
export const ALLOWLIST_SYNC_META_PREFIX = 'allowlist_sync:';

const STATE_SETTING_KEYS = new Set([
  'notification_secret_key',
  'language',
  'metrics_sidebar_visible',
  'allowlists_sidebar_visible',
  'manual_decision_scenarios',
  'refresh_interval_ms',
  'manual_refresh_enabled',
]);
const STATE_SETTING_PREFIXES = ['auth_', 'branding_'];
const DECISION_DUPLICATE_RANK_VERSION = '2';
const DEFAULT_JOURNAL_SIZE_LIMIT_BYTES = 128 * 1024 * 1024;
const INCREMENTAL_VACUUM_META_KEY = 'sqlite_incremental_vacuum_at';
const SQLITE_RECLAIM_WARNING_MIN_BYTES = 128 * 1024 * 1024;
const SQLITE_RECLAIM_WARNING_MIN_RATIO = 0.25;
const SQLITE_MAINTENANCE_GUIDE_URL = 'https://github.com/TheDuffman85/crowdsec-web-ui#sqlite-database-maintenance';

const SYNC_SECONDARY_INDEX_NAMES = [
  'idx_alerts_created_at',
  'idx_alerts_country',
  'idx_alerts_region',
  'idx_alerts_city',
  'idx_alerts_scenario',
  'idx_alerts_kind',
  'idx_alerts_as_name',
  'idx_alerts_target',
  'idx_alerts_source_ip',
  'idx_alerts_simulated',
  'idx_alerts_simulated_created_at',
  'idx_alerts_country_created_at',
  'idx_alerts_scenario_created_at',
  'idx_alerts_filters',
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
  CREATE INDEX IF NOT EXISTS idx_alerts_kind ON alerts(kind, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_alerts_as_name ON alerts(as_name);
  CREATE INDEX IF NOT EXISTS idx_alerts_target ON alerts(target);
  CREATE INDEX IF NOT EXISTS idx_alerts_source_ip ON alerts(source_ip);
  CREATE INDEX IF NOT EXISTS idx_alerts_simulated ON alerts(simulated);
  CREATE INDEX IF NOT EXISTS idx_alerts_simulated_created_at ON alerts(simulated, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_alerts_country_created_at ON alerts(country, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_alerts_scenario_created_at ON alerts(scenario, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_alerts_filters ON alerts(
    instance_id, country, scenario, kind, as_name, source_ip, target, country_name,
    region, city, machine, origins, message, upstream_id, simulated, created_at DESC, id DESC
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_instance_created ON alerts(instance_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_decisions_stop_at ON decisions(stop_at);
  CREATE INDEX IF NOT EXISTS idx_decisions_alert_summary ON decisions(alert_id, origin, simulated, stop_at);
  CREATE INDEX IF NOT EXISTS idx_decisions_value ON decisions(value);
  CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions(created_at);
  CREATE INDEX IF NOT EXISTS idx_decisions_created_id_stop_at ON decisions(created_at DESC, id DESC, stop_at);
  CREATE INDEX IF NOT EXISTS idx_decisions_stop_alert_id ON decisions(stop_at, alert_id, instance_id);
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
    is_duplicate, instance_id, stop_at, scenario, value, as_name, target, country, country_name,
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

export interface CachedAllowlistItem {
  value: string;
  description?: string;
  created_at?: string;
  /** Null when the entry never expires. */
  expiration: string | null;
}

export interface CachedAllowlist {
  name: string;
  allowlist_id?: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
  console_managed: boolean;
  items: CachedAllowlistItem[];
}

export interface SearchIndexRebuildScope {
  alertIds: Array<string | number>;
  decisionIds: Array<string | number>;
}

export interface DatabaseOptions {
  /** Directory of state.db, and of a legacy crowdsec.db to migrate. */
  dataDir?: string;
  /** Directory of cache.db; defaults to dataDir. */
  cacheDir?: string;
  /** Explicit cache.db path. state.db then defaults to the same directory and no migration runs. */
  cachePath?: string;
  /** Explicit state.db path, or null for a connection that only uses the cache. */
  statePath?: string | null;
  /** Journal mode of cache.db; state.db always uses a rollback journal. */
  walEnabled?: boolean;
  incrementalVacuumEnabled?: boolean;
  journalSizeLimitBytes?: number;
}

export interface SqliteStorageStats {
  autoVacuum: number;
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  reclaimableBytes: number;
  freeRatio: number;
  journalMode: string;
}

export interface IncrementalVacuumOptions {
  now: number;
  minFreeRatio: number;
  minFreeBytes: number;
  maxPages: number;
  cooldownMs: number;
}

export interface IncrementalVacuumResult {
  performed: boolean;
  reason: 'completed' | 'disabled' | 'below-threshold' | 'cooldown';
  before: SqliteStorageStats;
  after: SqliteStorageStats;
}

export function isStateSettingKey(key: string): boolean {
  return STATE_SETTING_KEYS.has(key) || STATE_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function getSqliteMaintenanceWarning(storage: SqliteStorageStats): string | null {
  if (
    storage.autoVacuum !== 0
    || storage.freeRatio < SQLITE_RECLAIM_WARNING_MIN_RATIO
    || storage.reclaimableBytes < SQLITE_RECLAIM_WARNING_MIN_BYTES
  ) return null;
  const size = storage.reclaimableBytes >= 1024 ** 3
    ? `${(storage.reclaimableBytes / 1024 ** 3).toFixed(1).replace(/\.0$/, '')} GiB`
    : `${Math.round(storage.reclaimableBytes / 1024 ** 2)} MiB`;
  return `SQLite can reclaim ~${size}. Stop the app and delete cache.db to rebuild it with incremental vacuum: ${SQLITE_MAINTENANCE_GUIDE_URL}`;
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
  public readonly cachePath: string;
  public readonly statePath: string | null;
  public readonly wasFresh: boolean;
  public readonly searchIndexAvailable: boolean;
  private searchIndexUpdatesDeferred = false;
  private dashboardChangeTrackingDeferred = false;
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
  private readonly getSettingStatement: any;
  private readonly setSettingStatement: any;
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
  private readonly revokeOidcUserSessionsStatement: any;
  private readonly insertRevokedOidcSessionStatement: any;
  private readonly pruneRevokedOidcSessionsStatement: any;
  private readonly getRevokedOidcSessionStatement: any;
  private readonly insertProcessedOidcLogoutStatement: any;
  private readonly pruneProcessedOidcLogoutsStatement: any;
  private readonly bumpOidcLogoutVersionStatement: any;
  private readonly getOidcLogoutVersionStatement: any;
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
  private readonly deleteNotificationByRuleAndDedupeKeyStatement: any;
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
    const paths = resolveDatabasePaths(options);
    if (paths.legacyPath && paths.statePath) migrateLegacyDatabase(paths.legacyPath, paths.statePath);
    this.cachePath = paths.cachePath;
    this.statePath = paths.statePath;
    const opened = openDatabase(
      this.cachePath,
      options.walEnabled ?? true,
      options.journalSizeLimitBytes ?? DEFAULT_JOURNAL_SIZE_LIMIT_BYTES,
      options.incrementalVacuumEnabled ?? true,
    );
    this.db = opened.database;
    this.wasFresh = opened.wasFresh;
    this.searchIndexAvailable = initCacheSchema(this.db);
    if (this.statePath) {
      attachStateDatabase(this.db, this.statePath);
      restoreAlertDeletionTombstones(this.db);
    }
    this.loadDecisionDuplicateRefreshState();
    this.refreshAlertDeletionTombstones();

    this.insertAlertStatement = this.db.query(`
      INSERT INTO alerts (
        id, instance_id, upstream_id, uuid, created_at, start_at, stop_at, scenario, record_scenario, kind, reason,
        source_ip, source_value, source_scope, source_range, source_as_number, source_extra_data,
        message, machine_id, machine_alias, events_count, extra_data, metadata_hash, raw_data,
        latitude, longitude, country, country_name, region, city, as_name, target, machine, meta_search, origins, simulated, search_text
      )
      VALUES (
        $internal_id, $instance_id, $id, $uuid, $created_at, $start_at, $stop_at, $scenario, $record_scenario, $kind, $reason,
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
        kind = excluded.kind,
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
        OR alerts.kind IS NOT excluded.kind
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
      FROM decisions AS active
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
    this.getSettingStatement = this.stateQuery('SELECT value FROM settings WHERE key = ?');
    this.setSettingStatement = this.stateQuery('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    this.countAuthUsersStatement = this.stateQuery('SELECT COUNT(*) as count FROM auth_users');
    this.createAuthUserStatement = this.stateQuery(`
      INSERT INTO auth_users (username, password_hash, role, auth_provider, created_at, updated_at)
      VALUES ($username, $password_hash, $role, $auth_provider, $created_at, $updated_at)
    `);
    this.getAuthUserByIdStatement = this.stateQuery('SELECT * FROM auth_users WHERE id = $id');
    this.getAuthUserByUsernameStatement = this.stateQuery('SELECT * FROM auth_users WHERE username = $username');
    this.getAuthUserByOidcIdentityStatement = this.stateQuery(`
      SELECT * FROM auth_users
      WHERE oidc_issuer = $oidc_issuer AND oidc_subject = $oidc_subject
    `);
    this.updateAuthUserPasswordStatement = this.stateQuery(`
      UPDATE auth_users
      SET password_hash = $password_hash,
          session_version = session_version + 1,
          updated_at = $updated_at
      WHERE id = $id
    `);
    this.updateAuthUserTotpStatement = this.stateQuery(`
      UPDATE auth_users
      SET totp_secret = $totp_secret, totp_enabled = $totp_enabled, totp_last_step = $totp_last_step, updated_at = $updated_at
      WHERE id = $id
    `);
    this.updateAuthUserTotpLastStepStatement = this.stateQuery(`
      UPDATE auth_users
      SET totp_last_step = $totp_last_step, updated_at = $updated_at
      WHERE id = $id AND (totp_last_step IS NULL OR totp_last_step < $totp_last_step)
    `);
    this.createOidcUserStatement = this.stateQuery(`
      INSERT INTO auth_users (
        username, password_hash, role, auth_provider, oidc_issuer, oidc_subject, created_at, updated_at
      )
      VALUES ($username, NULL, $role, 'oidc', $oidc_issuer, $oidc_subject, $created_at, $updated_at)
    `);
    this.updateOidcUserStatement = this.stateQuery(`
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
    this.revokeOidcUserSessionsStatement = this.stateQuery(`
      UPDATE auth_users
      SET session_version = session_version + 1,
          updated_at = $updated_at
      WHERE oidc_issuer = $oidc_issuer AND oidc_subject = $oidc_subject
    `);
    this.insertRevokedOidcSessionStatement = this.stateQuery(`
      INSERT OR REPLACE INTO oidc_revoked_sessions (issuer, session_id, expires_at)
      VALUES ($issuer, $session_id, $expires_at)
    `);
    this.pruneRevokedOidcSessionsStatement = this.stateQuery('DELETE FROM oidc_revoked_sessions WHERE expires_at <= $now');
    this.getRevokedOidcSessionStatement = this.stateQuery(`
      SELECT 1 FROM oidc_revoked_sessions
      WHERE issuer = $issuer AND session_id = $session_id AND expires_at > $now
    `);
    this.insertProcessedOidcLogoutStatement = this.stateQuery(`
      INSERT OR IGNORE INTO oidc_processed_logouts (issuer, token_id, expires_at)
      VALUES ($issuer, $token_id, $expires_at)
    `);
    this.pruneProcessedOidcLogoutsStatement = this.stateQuery('DELETE FROM oidc_processed_logouts WHERE expires_at <= $now');
    this.bumpOidcLogoutVersionStatement = this.stateQuery(`
      INSERT INTO oidc_logout_versions (issuer, subject, version)
      SELECT $issuer, $subject, ${INITIAL_OIDC_LOGOUT_VERSION + 1}
      WHERE EXISTS (SELECT 1 FROM auth_users WHERE oidc_issuer = $issuer AND oidc_subject = $subject)
      ON CONFLICT (issuer, subject) DO UPDATE SET version = version + 1
    `);
    this.getOidcLogoutVersionStatement = this.stateQuery(`
      SELECT version FROM oidc_logout_versions WHERE issuer = $issuer AND subject = $subject
    `);
    this.listWebAuthnCredentialsByUserStatement = this.stateQuery(`
      SELECT * FROM webauthn_credentials
      WHERE user_id = $user_id
      ORDER BY created_at DESC
    `);
    this.countWebAuthnCredentialsStatement = this.stateQuery(`
      SELECT COUNT(*) as count
      FROM webauthn_credentials credentials
      JOIN auth_users users ON users.id = credentials.user_id
      WHERE users.auth_provider <> 'oidc' OR users.password_hash IS NOT NULL
    `);
    this.createWebAuthnCredentialStatement = this.stateQuery(`
      INSERT INTO webauthn_credentials (user_id, credential_id, public_key, sign_count, transports, name, created_at)
      VALUES ($user_id, $credential_id, $public_key, $sign_count, $transports, $name, $created_at)
    `);
    this.getWebAuthnCredentialByCredentialIdStatement = this.stateQuery('SELECT * FROM webauthn_credentials WHERE credential_id = $credential_id');
    this.updateWebAuthnCredentialCounterStatement = this.stateQuery(`
      UPDATE webauthn_credentials
      SET sign_count = $sign_count
      WHERE id = $id
    `);
    this.renameWebAuthnCredentialStatement = this.stateQuery(`
      UPDATE webauthn_credentials
      SET name = $name
      WHERE id = $id AND user_id = $user_id
    `);
    this.deleteWebAuthnCredentialStatement = this.stateQuery('DELETE FROM webauthn_credentials WHERE id = $id AND user_id = $user_id');
    this.listNotificationChannelsStatement = this.stateQuery(`
      SELECT id, created_at, updated_at, name, type, enabled, config_json
      FROM notification_channels
      ORDER BY created_at DESC
    `);
    this.getNotificationChannelByIdStatement = this.stateQuery(`
      SELECT id, created_at, updated_at, name, type, enabled, config_json
      FROM notification_channels
      WHERE id = $id
    `);
    this.upsertNotificationChannelStatement = this.stateQuery(`
      INSERT OR REPLACE INTO notification_channels (id, created_at, updated_at, name, type, enabled, config_json)
      VALUES ($id, $created_at, $updated_at, $name, $type, $enabled, $config_json)
    `);
    this.deleteNotificationChannelStatement = this.stateQuery('DELETE FROM notification_channels WHERE id = $id');
    this.listNotificationRulesStatement = this.stateQuery(`
      SELECT id, created_at, updated_at, name, type, enabled, severity, channel_ids_json, config_json
      FROM notification_rules
      ORDER BY created_at DESC
    `);
    this.getNotificationRuleByIdStatement = this.stateQuery(`
      SELECT id, created_at, updated_at, name, type, enabled, severity, channel_ids_json, config_json
      FROM notification_rules
      WHERE id = $id
    `);
    this.upsertNotificationRuleStatement = this.stateQuery(`
      INSERT OR REPLACE INTO notification_rules (
        id, created_at, updated_at, name, type, enabled, severity, channel_ids_json, config_json
      )
      VALUES ($id, $created_at, $updated_at, $name, $type, $enabled, $severity, $channel_ids_json, $config_json)
    `);
    this.deleteNotificationRuleStatement = this.stateQuery('DELETE FROM notification_rules WHERE id = $id');
    this.listNotificationsPageStatement = this.stateQuery(`
      SELECT id, created_at, updated_at, rule_id, rule_name, rule_type, severity, title, message, read_at, metadata_json, deliveries_json, dedupe_key
      FROM notifications
      ORDER BY created_at DESC
      LIMIT $limit OFFSET $offset
    `);
    this.countNotificationsStatement = this.stateQuery('SELECT COUNT(*) as count FROM notifications');
    this.listNotificationIdsStatement = this.stateQuery(`
      SELECT id
      FROM notifications
      ORDER BY created_at DESC
    `);
    this.insertNotificationStatement = this.stateQuery(`
      INSERT OR IGNORE INTO notifications (
        id, created_at, updated_at, rule_id, rule_name, rule_type, severity, title, message, read_at, metadata_json, deliveries_json, dedupe_key
      )
      VALUES (
        $id, $created_at, $updated_at, $rule_id, $rule_name, $rule_type, $severity, $title, $message, $read_at, $metadata_json, $deliveries_json, $dedupe_key
      )
    `);
    this.listNotificationIncidentsByRuleStatement = this.stateQuery(`
      SELECT rule_id, incident_key, first_seen_at, last_seen_at, resolved_at
      FROM notification_incidents
      WHERE rule_id = $rule_id
      ORDER BY incident_key ASC
    `);
    this.upsertNotificationIncidentStatement = this.stateQuery(`
      INSERT OR REPLACE INTO notification_incidents (rule_id, incident_key, first_seen_at, last_seen_at, resolved_at)
      VALUES ($rule_id, $incident_key, $first_seen_at, $last_seen_at, $resolved_at)
    `);
    this.resolveNotificationIncidentStatement = this.stateQuery(`
      UPDATE notification_incidents
      SET resolved_at = $resolved_at, last_seen_at = $last_seen_at
      WHERE rule_id = $rule_id AND incident_key = $incident_key AND resolved_at IS NULL
    `);
    this.deleteNotificationIncidentsByRuleStatement = this.stateQuery('DELETE FROM notification_incidents WHERE rule_id = $rule_id');
    this.deleteNotificationStatement = this.stateQuery('DELETE FROM notifications WHERE id = $id');
    this.deleteNotificationByRuleAndDedupeKeyStatement = this.stateQuery(`
      DELETE FROM notifications
      WHERE rule_id = $rule_id AND dedupe_key = $dedupe_key
    `);
    this.markNotificationReadStatement = this.stateQuery('UPDATE notifications SET read_at = $read_at, updated_at = $updated_at WHERE id = $id');
    this.markAllNotificationsReadStatement = this.stateQuery(`
      UPDATE notifications
      SET read_at = $read_at, updated_at = $updated_at
      WHERE read_at IS NULL
    `);
    this.deleteReadNotificationsStatement = this.stateQuery('DELETE FROM notifications WHERE read_at IS NOT NULL');
    this.countUnreadNotificationsStatement = this.stateQuery('SELECT COUNT(*) as count FROM notifications WHERE read_at IS NULL');
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

  getStorageStats(): SqliteStorageStats {
    const pageSize = pragmaNumber(this.db, 'page_size');
    const pageCount = pragmaNumber(this.db, 'page_count');
    const freelistCount = pragmaNumber(this.db, 'freelist_count');
    return {
      autoVacuum: pragmaNumber(this.db, 'auto_vacuum'),
      pageSize,
      pageCount,
      freelistCount,
      reclaimableBytes: freelistCount * pageSize,
      freeRatio: pageCount > 0 ? freelistCount / pageCount : 0,
      journalMode: pragmaString(this.db, 'journal_mode'),
    };
  }

  runIncrementalVacuum(options: IncrementalVacuumOptions): IncrementalVacuumResult {
    const before = this.getStorageStats();
    if (before.autoVacuum !== 2) {
      return { performed: false, reason: 'disabled', before, after: before };
    }
    if (before.freeRatio < options.minFreeRatio || before.reclaimableBytes < options.minFreeBytes) {
      return { performed: false, reason: 'below-threshold', before, after: before };
    }

    const lastRun = Date.parse(this.getMeta(INCREMENTAL_VACUUM_META_KEY)?.value || '');
    if (Number.isFinite(lastRun) && options.now - lastRun < options.cooldownMs) {
      return { performed: false, reason: 'cooldown', before, after: before };
    }

    const maxPages = Math.max(1, Math.floor(options.maxPages));
    this.db.exec(`PRAGMA incremental_vacuum(${maxPages})`);
    this.setMeta(INCREMENTAL_VACUUM_META_KEY, new Date(options.now).toISOString());
    return { performed: true, reason: 'completed', before, after: this.getStorageStats() };
  }

  clearSyncData(): void {
    const dashboardTrackingEnabled = this.getMeta('dashboard_change_tracking_enabled')?.value !== 'false';
    if (dashboardTrackingEnabled) this.setMeta('dashboard_change_tracking_enabled', 'false');
    try {
      this.db.exec('DELETE FROM alerts');
      this.db.exec('DELETE FROM decisions');
      this.db.exec('DELETE FROM allowlists');
      this.db.exec('DELETE FROM allowlist_items');
      this.db.exec(`DELETE FROM meta WHERE key LIKE '${ALLOWLIST_SYNC_META_PREFIX}%'`);
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
    } finally {
      if (dashboardTrackingEnabled) {
        this.resetDashboardRecordChanges();
        this.setMeta('dashboard_change_tracking_enabled', 'true');
      } else {
        this.db.exec('DELETE FROM dashboard_record_changes');
      }
    }
  }

  beginDeferredSearchIndexUpdates(dropSecondaryIndexes = true, clearSearchIndexes = true): void {
    this.searchIndexUpdatesDeferred = true;
    if (dropSecondaryIndexes) {
      const deferDashboardChanges = this.db.transaction(() => {
        this.db.prepare(`
          INSERT INTO meta(key, value)
          VALUES ('dashboard_change_tracking_enabled', 'false')
          ON CONFLICT(key) DO UPDATE SET value = 'false'
        `).run();
        this.db.prepare(`
          INSERT INTO meta(key, value)
          VALUES ('dashboard_change_epoch', '2')
          ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
        `).run();
        this.db.prepare(`
          INSERT INTO meta(key, value)
          VALUES ('dashboard_change_floor', '0')
          ON CONFLICT(key) DO UPDATE SET value = '0'
        `).run();
        this.db.exec('DELETE FROM dashboard_record_changes');
      });
      deferDashboardChanges();
      this.dashboardChangeTrackingDeferred = true;
    }
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
      if (this.dashboardChangeTrackingDeferred) {
        const publishDashboardChanges = this.db.transaction(() => {
          this.db.prepare(`
            INSERT INTO meta(key, value)
            VALUES ('dashboard_change_epoch', '2')
            ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
          `).run();
          this.db.prepare(`
            INSERT INTO meta(key, value)
            VALUES ('dashboard_change_floor', '0')
            ON CONFLICT(key) DO UPDATE SET value = '0'
          `).run();
          this.db.exec('DELETE FROM dashboard_record_changes');
          this.db.prepare(`
            INSERT INTO meta(key, value)
            VALUES ('dashboard_change_tracking_enabled', 'true')
            ON CONFLICT(key) DO UPDATE SET value = 'true'
          `).run();
        });
        publishDashboardChanges();
        this.dashboardChangeTrackingDeferred = false;
      }
    }
  }

  pruneDashboardRecordChanges(changeEpoch: number, throughRevision: number): void {
    const currentEpoch = Number(this.getMeta('dashboard_change_epoch')?.value || 0);
    if (currentEpoch !== changeEpoch || !Number.isFinite(throughRevision) || throughRevision <= 0) return;
    this.runNonBlockingDashboardMaintenance(() => {
      const prune = this.db.transaction(() => {
        this.db.prepare(`
          INSERT INTO meta(key, value)
          VALUES ('dashboard_change_floor', ?)
          ON CONFLICT(key) DO UPDATE SET value = MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER))
        `).run(String(throughRevision));
        this.db.prepare('DELETE FROM dashboard_record_changes WHERE revision <= ?').run(throughRevision);
      });
      prune();
    });
  }

  countDashboardRecordChanges(): number {
    return Number((
      this.db.prepare('SELECT COUNT(*) AS count FROM dashboard_record_changes').get() as CountRow
    ).count) || 0;
  }

  resetDashboardRecordChanges(): void {
    this.runNonBlockingDashboardMaintenance(() => {
      const reset = this.db.transaction(() => {
        this.db.prepare(`
          INSERT INTO meta(key, value)
          VALUES ('dashboard_change_epoch', '2')
          ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
        `).run();
        this.db.prepare(`
          INSERT INTO meta(key, value)
          VALUES ('dashboard_change_floor', '0')
          ON CONFLICT(key) DO UPDATE SET value = '0'
        `).run();
        this.db.exec('DELETE FROM dashboard_record_changes');
      });
      reset();
    });
  }

  private runNonBlockingDashboardMaintenance(action: () => void): void {
    const row = this.db.prepare('PRAGMA busy_timeout').get() as { timeout?: number } | undefined;
    const busyTimeout = Math.max(0, Number(row?.timeout) || 0);
    this.db.exec('PRAGMA busy_timeout = 0');
    try {
      action();
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      if (!message.includes('database is locked') && !message.includes('database is busy')) throw error;
    } finally {
      this.db.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
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
      $kind: index.kind,
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

  deleteOldAlerts(cutoff: string, limit = Infinity): number {
    let changes = 0;
    let remaining = limit;
    const selectOldAlerts = this.db.prepare('SELECT id FROM alerts WHERE created_at < ? LIMIT ?');
    while (remaining > 0) {
      const ids = (selectOldAlerts.all(cutoff, Math.min(900, remaining)) as IdRow[]).map((row) => String(row.id));
      if (ids.length === 0) break;
      remaining -= ids.length;
      changes += runChunkedIdMutation(this.db, 'DELETE FROM alerts WHERE id IN', ids);
      this.deleteAlertSearchIndexes(ids);
    }
    return changes;
  }

  insertDecision(params: DecisionInsertParams): boolean {
    const instanceId = params.$instance_id || 'default';
    const tombstoneId = `${instanceId}\u0000${params.$alert_id}`;
    if (this.alertDeletionTombstones.has(tombstoneId) || (instanceId === 'default' && this.alertDeletionTombstones.has(String(params.$alert_id)))) return false;
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

  deleteOldDecisions(cutoff: string, limit?: number): number {
    if (limit !== undefined) {
      const deleteBatch = this.db.transaction((threshold: string) => {
        const ids = (
          this.db.prepare('SELECT id FROM decisions WHERE stop_at < ? LIMIT ?').all(threshold, limit) as IdRow[]
        ).map((row) => String(row.id));
        if (!this.searchIndexUpdatesDeferred) this.deleteDecisionSearchIndexes(ids);
        return runChunkedIdMutation(this.db, 'DELETE FROM decisions WHERE id IN', ids);
      });
      return deleteBatch(cutoff);
    }

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

  /**
   * Makes one instance's cached allowlists match a complete LAPI snapshot,
   * writing only rows that were added, changed, or removed, and stores the
   * instance's sync state with them. A null snapshot only updates the state.
   */
  replaceAllowlists(instanceId: string, allowlists: CachedAllowlist[] | null, syncState: string): { changed: boolean } {
    let changed = false;
    const replace = this.db.transaction(() => {
      this.setMeta(`${ALLOWLIST_SYNC_META_PREFIX}${instanceId}`, syncState);
      if (!allowlists) return;
      const cachedLists = new Map((this.db.prepare(`
        SELECT name, allowlist_id, description, created_at, updated_at, console_managed
        FROM allowlists WHERE instance_id = ?
      `).all(instanceId) as Array<Record<string, string | number | null>>).map((row) => [String(row.name), row]));
      const upsertList = this.db.prepare(`
        INSERT INTO allowlists (instance_id, name, allowlist_id, description, created_at, updated_at, console_managed)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(instance_id, name) DO UPDATE SET
          allowlist_id = excluded.allowlist_id,
          description = excluded.description,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          console_managed = excluded.console_managed
      `);
      for (const allowlist of allowlists) {
        const values = [
          allowlist.allowlist_id ?? null,
          allowlist.description ?? null,
          allowlist.created_at ?? null,
          allowlist.updated_at ?? null,
          allowlist.console_managed ? 1 : 0,
        ];
        const cached = cachedLists.get(allowlist.name);
        cachedLists.delete(allowlist.name);
        if (cached && [cached.allowlist_id, cached.description, cached.created_at, cached.updated_at, cached.console_managed]
          .every((value, index) => value === values[index])) continue;
        upsertList.run(instanceId, allowlist.name, ...values);
        changed = true;
      }
      const deleteList = this.db.prepare('DELETE FROM allowlists WHERE instance_id = ? AND name = ?');
      const deleteListItems = this.db.prepare('DELETE FROM allowlist_items WHERE instance_id = ? AND allowlist_name = ?');
      for (const name of cachedLists.keys()) {
        deleteList.run(instanceId, name);
        deleteListItems.run(instanceId, name);
        changed = true;
      }

      const cachedItems = new Map<string, Record<string, string | null>>();
      for (const row of this.db.prepare(`
        SELECT allowlist_name, value, description, created_at, expiration
        FROM allowlist_items WHERE instance_id = ?
      `).all(instanceId) as Array<Record<string, string | null>>) {
        cachedItems.set(`${row.allowlist_name}\u0000${row.value}`, row);
      }
      const upsertItem = this.db.prepare(`
        INSERT INTO allowlist_items (instance_id, allowlist_name, value, description, created_at, expiration)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(instance_id, allowlist_name, value) DO UPDATE SET
          description = excluded.description,
          created_at = excluded.created_at,
          expiration = excluded.expiration
      `);
      for (const allowlist of allowlists) {
        for (const item of allowlist.items) {
          const key = `${allowlist.name}\u0000${item.value}`;
          const values = [item.description ?? null, item.created_at ?? null, item.expiration];
          const cached = cachedItems.get(key);
          cachedItems.delete(key);
          if (cached && cached.description === values[0] && cached.created_at === values[1] && cached.expiration === values[2]) continue;
          upsertItem.run(instanceId, allowlist.name, item.value, ...values);
          changed = true;
        }
      }
      const deleteItem = this.db.prepare('DELETE FROM allowlist_items WHERE instance_id = ? AND allowlist_name = ? AND value = ?');
      for (const row of cachedItems.values()) {
        deleteItem.run(instanceId, row.allowlist_name, row.value);
        changed = true;
      }
    });
    replace();
    return { changed };
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
    this.db.prepare('INSERT OR IGNORE INTO alert_deletion_tombstones (alert_id) VALUES (?)').run(String(alertId));
    this.alertDeletionTombstones.add(String(alertId));
  }

  // The deletion queue lives in state.db; the sync worker only sees cache.db, so the
  // queued alert IDs are mirrored into alert_deletion_tombstones to keep sync from restoring them.
  refreshAlertDeletionTombstones(): void {
    const rows = this.db.prepare('SELECT alert_id FROM alert_deletion_tombstones').all() as Array<{ alert_id: string }>;
    this.alertDeletionTombstones = new Set(rows.map((row) => row.alert_id));
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

  expireAlertDeletion(alertId: string | number, completedAt: string, error: string): void {
    this.db.prepare(`
      UPDATE pending_alert_deletions
      SET completed_at = ?, last_attempt_at = ?, last_error = ?
      WHERE alert_id = ? AND completed_at IS NULL
    `).run(completedAt, completedAt, error, String(alertId));
  }

  purgeCompletedAlertDeletions(completedBefore: string): number {
    const changes = this.db.prepare(`
      DELETE FROM pending_alert_deletions
      WHERE completed_at IS NOT NULL AND completed_at < ?
    `).run(completedBefore).changes;
    if (changes > 0) {
      this.db.exec('DELETE FROM alert_deletion_tombstones WHERE alert_id NOT IN (SELECT alert_id FROM pending_alert_deletions)');
      this.refreshAlertDeletionTombstones();
    }
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
    // Fresh bulk imports drop every secondary index. Build only the narrow
    // ranking index immediately before this pass instead of maintaining it
    // across every imported row.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_decisions_duplicate_primary
      ON decisions(value, simulated, stop_at DESC, id)
    `);
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
    const statement = isStateSettingKey(key) ? this.getSettingStatement : this.getMetaStatement;
    return (statement.get(key) as MetaRow | null) || null;
  }

  setMeta(key: string, value: string): void {
    const statement = isStateSettingKey(key) ? this.setSettingStatement : this.setMetaStatement;
    statement.run(key, value);
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

  /** Atomically records a logout event and revokes its sessions, so retries cannot revoke later sign-ins. */
  applyOidcLogout(params: {
    issuer: string;
    subject?: string;
    sessionId?: string;
    tokenId: string;
    tokenExpiresAt: number;
    sessionExpiresAt: number;
  }): void {
    this.db.transaction(() => {
      this.pruneProcessedOidcLogoutsStatement.run({ $now: Math.floor(Date.now() / 1000) });
      const inserted = this.insertProcessedOidcLogoutStatement.run({
        $issuer: params.issuer,
        $token_id: params.tokenId,
        $expires_at: params.tokenExpiresAt,
      });
      if (!inserted.changes) return;

      // sid narrows the logout even when the provider also supplies sub. Sessions that carry
      // no sid cannot be matched to the provider session, so those of the named user end too.
      if (params.sessionId) {
        this.revokeOidcSession(params.issuer, params.sessionId, params.sessionExpiresAt);
        if (params.subject) this.bumpOidcLogoutVersion(params.issuer, params.subject);
      } else if (params.subject) {
        this.revokeOidcUserSessions(params.issuer, params.subject);
      } else {
        throw new Error('OIDC logout requires a subject or session ID');
      }
    })();
  }

  /** Ends every dashboard session of an OIDC identity by bumping its session version. */
  revokeOidcUserSessions(issuer: string, subject: string): boolean {
    return this.revokeOidcUserSessionsStatement.run({
      $oidc_issuer: issuer,
      $oidc_subject: subject,
      $updated_at: new Date().toISOString(),
    }).changes > 0;
  }

  /** Records a provider session ID as logged out until the dashboard sessions bound to it have expired. */
  revokeOidcSession(issuer: string, sessionId: string, expiresAt: number): void {
    this.pruneRevokedOidcSessionsStatement.run({ $now: Math.floor(Date.now() / 1000) });
    this.insertRevokedOidcSessionStatement.run({ $issuer: issuer, $session_id: sessionId, $expires_at: expiresAt });
  }

  /** Ends the OIDC sessions of an identity that are not bound to a provider session ID. */
  bumpOidcLogoutVersion(issuer: string, subject: string): void {
    this.bumpOidcLogoutVersionStatement.run({ $issuer: issuer, $subject: subject });
  }

  /** Version that new sessions without a provider session ID are bound to; absent rows are the initial version. */
  getOidcLogoutVersion(issuer: string, subject: string): number {
    const row = this.getOidcLogoutVersionStatement.get({ $issuer: issuer, $subject: subject }) as { version: number } | null;
    return row?.version ?? INITIAL_OIDC_LOGOUT_VERSION;
  }

  isOidcSessionRevoked(issuer: string, sessionId: string): boolean {
    return Boolean(this.getRevokedOidcSessionStatement.get({
      $issuer: issuer,
      $session_id: sessionId,
      $now: Math.floor(Date.now() / 1000),
    }));
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

  deleteNotificationByRuleAndDedupeKey(ruleId: string, dedupeKey: string): boolean {
    return this.deleteNotificationByRuleAndDedupeKeyStatement.run({
      $rule_id: ruleId,
      $dedupe_key: dedupeKey,
    }).changes > 0;
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

  private stateQuery(sql: string): SqliteStatement {
    if (this.statePath) return this.db.query(sql);
    const unavailable = () => {
      throw new Error('The state database is not attached to this connection');
    };
    return { run: unavailable, get: unavailable, all: unavailable };
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

interface DatabasePaths {
  cachePath: string;
  statePath: string | null;
  legacyPath: string | null;
}

function resolveDatabasePaths(options: DatabaseOptions): DatabasePaths {
  if (options.cachePath) {
    ensureDirectory(path.dirname(options.cachePath));
    return {
      cachePath: options.cachePath,
      statePath: options.statePath === undefined
        ? path.join(path.dirname(options.cachePath), STATE_DATABASE_FILE)
        : options.statePath,
      legacyPath: null,
    };
  }

  const dataDir = resolveDataDirectory(options.dataDir || DEFAULT_DATA_DIR);
  const cacheDir = options.cacheDir ? resolveDataDirectory(options.cacheDir) : dataDir;
  return {
    cachePath: path.join(cacheDir, CACHE_DATABASE_FILE),
    statePath: options.statePath === undefined ? path.join(dataDir, STATE_DATABASE_FILE) : options.statePath,
    legacyPath: path.join(dataDir, LEGACY_DATABASE_FILE),
  };
}

function resolveDataDirectory(dirPath: string): string {
  try {
    ensureDirectory(dirPath);
    return dirPath;
  } catch (error) {
    if (dirPath !== DEFAULT_DATA_DIR) throw error;
    // Local runs outside the container cannot create /app/data; use ./data like the config file does.
    const fallback = path.resolve(process.cwd(), 'data');
    ensureDirectory(fallback);
    return fallback;
  }
}

function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function openDatabase(
  dbPath: string,
  walEnabled: boolean,
  journalSizeLimitBytes: number,
  incrementalVacuumEnabled: boolean,
): { database: Database; wasFresh: boolean } {
  return prepareDatabase(createDatabase(dbPath), walEnabled, journalSizeLimitBytes, incrementalVacuumEnabled);
}

// The state database is small and rarely written. A rollback journal keeps it usable on
// network filesystems and leaves a single file to back up, independent of storage.walEnabled.
function attachStateDatabase(db: Database, statePath: string): void {
  ensureDirectory(path.dirname(statePath));
  db.prepare(`ATTACH DATABASE ? AS ${STATE_SCHEMA}`).run(statePath);
  const fresh = isDatabaseFresh(db, STATE_SCHEMA);
  db.exec(`PRAGMA ${STATE_SCHEMA}.journal_mode = DELETE`);
  db.exec(`PRAGMA ${STATE_SCHEMA}.synchronous = FULL`);
  initStateSchema(db, STATE_SCHEMA, fresh);
}

// Rebuilds the cache-side mirror of the deletion queue, for example after cache.db was lost.
function restoreAlertDeletionTombstones(db: Database): void {
  db.transaction(() => {
    db.exec(`
      DELETE FROM main.alert_deletion_tombstones;
      INSERT INTO main.alert_deletion_tombstones (alert_id)
      SELECT alert_id FROM ${STATE_SCHEMA}.pending_alert_deletions;
    `);
  })();
}

function prepareDatabase(
  database: Database,
  walEnabled: boolean,
  journalSizeLimitBytes: number,
  incrementalVacuumEnabled: boolean,
): { database: Database; wasFresh: boolean } {
  const wasFresh = isDatabaseFresh(database);
  if (wasFresh && incrementalVacuumEnabled) database.exec('PRAGMA auto_vacuum = INCREMENTAL');
  return {
    database: configureDatabase(database, walEnabled, journalSizeLimitBytes),
    wasFresh,
  };
}

function configureDatabase(database: Database, walEnabled: boolean, journalSizeLimitBytes: number): Database {
  database.exec(`PRAGMA journal_mode = ${walEnabled ? 'WAL' : 'DELETE'}`);
  if (walEnabled) {
    const limit = Number.isSafeInteger(journalSizeLimitBytes) && journalSizeLimitBytes >= -1
      ? journalSizeLimitBytes
      : DEFAULT_JOURNAL_SIZE_LIMIT_BYTES;
    database.exec(`PRAGMA journal_size_limit = ${limit}`);
  }
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA synchronous = NORMAL');
  database.exec('PRAGMA cache_size = -32000');
  database.exec('PRAGMA temp_store = MEMORY');
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec('PRAGMA mmap_size = 268435456');
  registerDatabaseFunctions(database);
  return database;
}

function pragmaNumber(database: Database, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : 0;
  return Number(value) || 0;
}

function pragmaString(database: Database, name: string): string {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : '';
  return String(value || '').toLowerCase();
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

function isDatabaseFresh(db: Database, schema = 'main'): boolean {
  const row = db.query(`
    SELECT COUNT(*) AS count
    FROM ${schema}.sqlite_master
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

function initCacheSchema(db: Database): boolean {
  db.exec(`
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
      kind TEXT,
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
      search_text TEXT,
      UNIQUE(instance_id, upstream_id),
      UNIQUE(instance_id, uuid)
    );

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
      is_duplicate INTEGER NOT NULL DEFAULT 0,
      UNIQUE(instance_id, upstream_id),
      UNIQUE(instance_id, uuid)
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS cve_cache (
      id TEXT PRIMARY KEY,
      published_at TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alert_deletion_tombstones (
      alert_id TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS allowlists (
      instance_id TEXT NOT NULL,
      name TEXT NOT NULL,
      allowlist_id TEXT,
      description TEXT,
      created_at TEXT,
      updated_at TEXT,
      console_managed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (instance_id, name)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS allowlist_items (
      instance_id TEXT NOT NULL,
      allowlist_name TEXT NOT NULL,
      value TEXT NOT NULL,
      description TEXT,
      created_at TEXT,
      expiration TEXT,
      PRIMARY KEY (instance_id, allowlist_name, value)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_allowlist_items_name_created
      ON allowlist_items(allowlist_name, created_at DESC, value);
  `);
  // A refresh drops the secondary indexes while it bulk-loads and recreates them afterwards.
  // Recreate them here too in case the previous process stopped in between.
  db.exec(CREATE_SYNC_SECONDARY_INDEXES_SQL);
  initDashboardChangeTracking(db);
  const searchIndexAvailable = initSearchIndexes(db);
  if (searchIndexAvailable) {
    backfillSearchIndexes(db);
  }
  return searchIndexAvailable;
}

function initStateSchema(db: Database, schema: string, fresh: boolean): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${schema}.settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS ${schema}.auth_users (
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
    CREATE INDEX IF NOT EXISTS ${schema}.idx_auth_users_username ON auth_users(username);
    CREATE UNIQUE INDEX IF NOT EXISTS ${schema}.idx_auth_users_oidc_identity
      ON auth_users(oidc_issuer, oidc_subject)
      WHERE oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL;

    CREATE TABLE IF NOT EXISTS ${schema}.webauthn_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      credential_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      sign_count INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      name TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ${schema}.idx_webauthn_credentials_user_id ON webauthn_credentials(user_id);

    CREATE TABLE IF NOT EXISTS ${schema}.oidc_revoked_sessions (
      issuer TEXT NOT NULL,
      session_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (issuer, session_id)
    );

    CREATE TABLE IF NOT EXISTS ${schema}.oidc_processed_logouts (
      issuer TEXT NOT NULL,
      token_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (issuer, token_id)
    );
    CREATE INDEX IF NOT EXISTS ${schema}.idx_oidc_processed_logouts_expiry ON oidc_processed_logouts(expires_at);

    CREATE TABLE IF NOT EXISTS ${schema}.oidc_logout_versions (
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      version INTEGER NOT NULL,
      PRIMARY KEY (issuer, subject)
    );

    CREATE TABLE IF NOT EXISTS ${schema}.notification_channels (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ${schema}.notification_rules (
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

    CREATE TABLE IF NOT EXISTS ${schema}.notifications (
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
    CREATE INDEX IF NOT EXISTS ${schema}.idx_notifications_created_at ON notifications(created_at);
    CREATE INDEX IF NOT EXISTS ${schema}.idx_notifications_read_at ON notifications(read_at);
    CREATE INDEX IF NOT EXISTS ${schema}.idx_notifications_rule_id ON notifications(rule_id);

    CREATE TABLE IF NOT EXISTS ${schema}.notification_incidents (
      rule_id TEXT NOT NULL,
      incident_key TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      resolved_at TEXT,
      PRIMARY KEY (rule_id, incident_key)
    );
    CREATE INDEX IF NOT EXISTS ${schema}.idx_notification_incidents_rule_id ON notification_incidents(rule_id);
    CREATE INDEX IF NOT EXISTS ${schema}.idx_notification_incidents_resolved_at ON notification_incidents(resolved_at);

    CREATE TABLE IF NOT EXISTS ${schema}.saved_search_filters (
      id TEXT PRIMARY KEY,
      owner_id INTEGER NOT NULL,
      name TEXT NOT NULL COLLATE NOCASE,
      query TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_id, name)
    );
    CREATE INDEX IF NOT EXISTS ${schema}.idx_saved_search_filters_owner
      ON saved_search_filters(owner_id, name);

    CREATE TABLE IF NOT EXISTS ${schema}.recent_search_filters (
      owner_id INTEGER NOT NULL,
      query TEXT NOT NULL,
      used_at_ms INTEGER NOT NULL,
      PRIMARY KEY(owner_id, query)
    );
    CREATE INDEX IF NOT EXISTS ${schema}.idx_recent_search_filters_owner_used
      ON recent_search_filters(owner_id, used_at_ms DESC);

    CREATE TABLE IF NOT EXISTS ${schema}.pending_alert_deletions (
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
    CREATE INDEX IF NOT EXISTS ${schema}.idx_pending_alert_deletions_due
      ON pending_alert_deletions(completed_at, delete_after, requested_at);
  `);
  // Only new installations enable authentication by default; migrated ones keep their previous state.
  db.prepare(`INSERT OR IGNORE INTO ${schema}.settings (key, value) VALUES ('auth_existing_install_default_disabled', ?)`)
    .run(fresh ? 'false' : 'true');
  // Existing installations are resolved on startup, once the effective OIDC configuration is known.
  db.prepare(`INSERT OR IGNORE INTO ${schema}.settings (key, value) VALUES ('${OIDC_END_SESSION_LEGACY_DEFAULT_KEY}', ?)`)
    .run(fresh ? 'false' : 'pending');
}

// Before the split, everything lived in crowdsec.db. Its durable data, including queued
// alert deletions, is copied into a new state.db; cached alerts and decisions are left
// behind because the next sync rebuilds them.
// state.db is written under a temporary name and renamed when complete, so an interrupted
// migration starts over on the next startup.
function migrateLegacyDatabase(legacyPath: string, statePath: string): void {
  const tempPath = `${statePath}.tmp`;
  removeDatabaseFiles(tempPath);
  if (fs.existsSync(statePath) || !fs.existsSync(legacyPath)) return;

  console.log(`Migrating durable data from ${legacyPath} to ${statePath}...`);
  const legacy = createDatabase(legacyPath);
  try {
    const target = createDatabase(tempPath);
    try {
      target.exec('PRAGMA journal_mode = DELETE');
      target.exec('PRAGMA synchronous = FULL');
      initStateSchema(target, 'main', false);
      target.transaction(() => importLegacyState(legacy, target))();
    } finally {
      target.close();
    }
  } finally {
    legacy.close();
  }
  fs.renameSync(tempPath, statePath);
  try {
    removeDatabaseFiles(legacyPath);
  } catch (error) {
    console.warn(`Migrated durable data to ${statePath}, but could not remove ${legacyPath}: ${(error as Error).message}`);
    return;
  }
  console.log(`Migrated durable data to ${statePath} and removed ${legacyPath}. Cached alerts and decisions are rebuilt by the next sync.`);
}

const LEGACY_STATE_TABLES = [
  'auth_users',
  'webauthn_credentials',
  'notification_channels',
  'notification_rules',
  'notifications',
  'notification_incidents',
  'saved_search_filters',
  'recent_search_filters',
  'pending_alert_deletions',
] as const;

// Older versions stored some timestamps in non-ISO formats.
const LEGACY_TIMESTAMP_COLUMNS = new Set(['created_at', 'updated_at', 'read_at', 'first_seen_at', 'last_seen_at', 'resolved_at']);
const LEGACY_TIMESTAMP_JSON_COLUMNS = new Set(['metadata_json', 'deliveries_json']);

function importLegacyState(legacy: Database, target: Database): void {
  for (const table of LEGACY_STATE_TABLES) {
    const legacyColumns = tableColumns(legacy, table);
    if (legacyColumns.length === 0) continue;
    // Copy the columns both schemas share; columns that older versions lacked keep their defaults.
    const columns = tableColumns(target, table).filter((column) => legacyColumns.includes(column));
    const insert = target.prepare(`
      INSERT OR REPLACE INTO ${table} (${columns.join(', ')})
      VALUES (${columns.map(() => '?').join(', ')})
    `);
    const rows = legacy.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      insert.run(...columns.map((column) => normalizeLegacyValue(column, row[column])));
    }
  }

  if (tableColumns(legacy, 'meta').length > 0) {
    const insertSetting = target.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    const rows = legacy.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string | null }>;
    for (const row of rows) {
      if (isStateSettingKey(row.key)) insertSetting.run(row.key, row.value);
    }
  }

  target.exec(`
    DELETE FROM recent_search_filters WHERE rowid IN (
      SELECT rowid FROM (
        SELECT rowid, ROW_NUMBER() OVER (
          PARTITION BY owner_id ORDER BY used_at_ms DESC, rowid DESC
        ) AS position
        FROM recent_search_filters
      ) WHERE position > ${RECENT_FILTER_LIMIT}
    );
  `);
  seedNotificationIncidentsFromHistoryIfEmpty(target);
}

function tableColumns(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

function normalizeLegacyValue(column: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (LEGACY_TIMESTAMP_COLUMNS.has(column)) return normalizeIsoTimestamp(value);
  if (LEGACY_TIMESTAMP_JSON_COLUMNS.has(column)) return normalizeTimestampJson(value);
  return value;
}

function removeDatabaseFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

function initDashboardChangeTracking(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_record_changes (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL CHECK(table_name IN ('alerts', 'decisions')),
      record_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dashboard_record_changes_record
      ON dashboard_record_changes(table_name, record_id, revision DESC);
    INSERT OR IGNORE INTO meta(key, value) VALUES ('dashboard_change_epoch', '1');
    INSERT OR IGNORE INTO meta(key, value) VALUES ('dashboard_change_floor', '0');
    INSERT OR IGNORE INTO meta(key, value) VALUES ('dashboard_change_tracking_enabled', 'true');

    CREATE TRIGGER IF NOT EXISTS dashboard_alert_insert
    AFTER INSERT ON alerts
    WHEN COALESCE((SELECT value FROM meta WHERE key = 'dashboard_change_tracking_enabled'), 'true') = 'true'
    BEGIN
      INSERT INTO dashboard_record_changes(table_name, record_id)
      VALUES ('alerts', CAST(NEW.id AS TEXT));
    END;
    CREATE TRIGGER IF NOT EXISTS dashboard_alert_update
    AFTER UPDATE ON alerts
    WHEN COALESCE((SELECT value FROM meta WHERE key = 'dashboard_change_tracking_enabled'), 'true') = 'true'
      AND (
        OLD.instance_id IS NOT NEW.instance_id OR OLD.upstream_id IS NOT NEW.upstream_id
        OR OLD.created_at IS NOT NEW.created_at OR OLD.country IS NOT NEW.country
        OR OLD.region IS NOT NEW.region OR OLD.city IS NOT NEW.city
        OR OLD.scenario IS NOT NEW.scenario OR OLD.kind IS NOT NEW.kind
        OR OLD.as_name IS NOT NEW.as_name
        OR OLD.source_ip IS NOT NEW.source_ip OR OLD.source_value IS NOT NEW.source_value
        OR OLD.source_range IS NOT NEW.source_range OR OLD.latitude IS NOT NEW.latitude
        OR OLD.longitude IS NOT NEW.longitude OR OLD.target IS NOT NEW.target
        OR OLD.machine_id IS NOT NEW.machine_id OR OLD.machine_alias IS NOT NEW.machine_alias
        OR OLD.machine IS NOT NEW.machine OR OLD.origins IS NOT NEW.origins
        OR OLD.simulated IS NOT NEW.simulated OR OLD.extra_data IS NOT NEW.extra_data
      )
    BEGIN
      INSERT INTO dashboard_record_changes(table_name, record_id)
      VALUES ('alerts', CAST(NEW.id AS TEXT));
    END;
    CREATE TRIGGER IF NOT EXISTS dashboard_alert_delete
    AFTER DELETE ON alerts
    WHEN COALESCE((SELECT value FROM meta WHERE key = 'dashboard_change_tracking_enabled'), 'true') = 'true'
    BEGIN
      INSERT INTO dashboard_record_changes(table_name, record_id)
      VALUES ('alerts', CAST(OLD.id AS TEXT));
    END;
    CREATE TRIGGER IF NOT EXISTS dashboard_decision_insert
    AFTER INSERT ON decisions
    WHEN COALESCE((SELECT value FROM meta WHERE key = 'dashboard_change_tracking_enabled'), 'true') = 'true'
    BEGIN
      INSERT INTO dashboard_record_changes(table_name, record_id)
      VALUES ('decisions', CAST(NEW.id AS TEXT));
    END;
    CREATE TRIGGER IF NOT EXISTS dashboard_decision_update
    AFTER UPDATE ON decisions
    WHEN COALESCE((SELECT value FROM meta WHERE key = 'dashboard_change_tracking_enabled'), 'true') = 'true'
      AND (
        OLD.instance_id IS NOT NEW.instance_id OR OLD.upstream_id IS NOT NEW.upstream_id
        OR OLD.alert_upstream_id IS NOT NEW.alert_upstream_id
        OR OLD.created_at IS NOT NEW.created_at OR OLD.stop_at IS NOT NEW.stop_at
        OR OLD.value IS NOT NEW.value OR OLD.country IS NOT NEW.country
        OR OLD.region IS NOT NEW.region OR OLD.city IS NOT NEW.city
        OR OLD.scenario IS NOT NEW.scenario OR OLD.as_name IS NOT NEW.as_name
        OR OLD.target IS NOT NEW.target OR OLD.type IS NOT NEW.type
        OR OLD.origin IS NOT NEW.origin OR OLD.machine IS NOT NEW.machine
        OR OLD.duration IS NOT NEW.duration OR OLD.is_duplicate IS NOT NEW.is_duplicate
        OR OLD.simulated IS NOT NEW.simulated OR OLD.extra_data IS NOT NEW.extra_data
      )
    BEGIN
      INSERT INTO dashboard_record_changes(table_name, record_id)
      VALUES ('decisions', CAST(NEW.id AS TEXT));
    END;
    CREATE TRIGGER IF NOT EXISTS dashboard_decision_delete
    AFTER DELETE ON decisions
    WHEN COALESCE((SELECT value FROM meta WHERE key = 'dashboard_change_tracking_enabled'), 'true') = 'true'
    BEGIN
      INSERT INTO dashboard_record_changes(table_name, record_id)
      VALUES ('decisions', CAST(OLD.id AS TEXT));
    END;
  `);
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

function initSearchIndexes(db: Database): boolean {
  try {
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
  if (ruleType === 'crowdsec-update') {
    return normalized.startsWith('crowdsec-update:') ? normalized : null;
  }
  if (ruleType === 'lapi-availability') {
    return normalized.startsWith('lapi-availability:') ? normalized : null;
  }

  return normalized || null;
}
