import { describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { CrowdsecDatabase } from '../../database';
import { createLegacyDatabase, tempDirs } from './harness';

function createDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-'));
  tempDirs.push(dir);
  return dir;
}

function createLegacyInstall(dataDir: string): void {
  const legacy = createLegacyDatabase(path.join(dataDir, 'crowdsec.db'));
  legacy.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE alerts (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, raw_data TEXT);
    CREATE TABLE auth_users (
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
    CREATE TABLE webauthn_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      credential_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      sign_count INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      name TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE notification_channels (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL
    );
    CREATE TABLE notification_rules (
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
    CREATE TABLE notifications (
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
    CREATE TABLE pending_alert_deletions (
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
    CREATE TABLE recent_search_filters (
      owner_id INTEGER NOT NULL,
      query TEXT NOT NULL,
      used_at_ms INTEGER NOT NULL,
      PRIMARY KEY(owner_id, query)
    );

    INSERT INTO meta (key, value) VALUES
      ('auth_session_secret', 'session-secret'),
      ('auth_oidc_client_id', 'web-ui'),
      ('notification_secret_key', 'notification-key'),
      ('branding_app_name', 'Edge WAF'),
      ('language', 'de'),
      ('refresh_interval_ms', '30000'),
      ('dashboard_change_epoch', '7'),
      ('sync_timestamp_format_version', '2');
    INSERT INTO alerts (id, created_at, raw_data) VALUES (1, '2026-01-01T00:00:00.000Z', '{}');
    INSERT INTO auth_users (id, username, password_hash, totp_secret, totp_enabled, role, auth_provider, created_at, updated_at)
      VALUES (7, 'admin', 'hash', 'secret', 1, 'admin', 'password', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00-01:00');
    INSERT INTO webauthn_credentials (user_id, credential_id, public_key, created_at)
      VALUES (7, 'credential-1', 'public-key', '2026-01-02T00:00:00.000Z');
    INSERT INTO notification_channels (id, created_at, updated_at, name, type, enabled, config_json)
      VALUES ('channel-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'Ops', 'webhook', 1, '{"url":"https://example.test"}');
    INSERT INTO notification_rules (id, created_at, updated_at, name, type, enabled, severity, cooldown_minutes, channel_ids_json, config_json)
      VALUES ('rule-legacy', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', 'Legacy threshold', 'alert-threshold', 1, 'warning', 60, '["channel-1"]', '{"window_minutes":60,"alert_threshold":10}');
    INSERT INTO pending_alert_deletions (alert_id, decision_ids_json, requested_at, attempt_count, last_error)
      VALUES ('default' || char(0) || '101', '["5001"]', '2026-01-03T00:00:00.000Z', 2, 'LAPI unavailable');
    INSERT INTO notifications (id, created_at, updated_at, rule_id, rule_name, rule_type, severity, title, message, read_at, metadata_json, deliveries_json, dedupe_key)
      VALUES ('notif-legacy', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 'rule-legacy', 'Legacy threshold', 'alert-threshold', 'warning',
        'Threshold exceeded', '10 alerts matched.', NULL, '{"matched_alerts":10}', '[{"attempted_at":"2024-12-31T19:00:00-05:00"}]',
        'rule-legacy:threshold:28928160');
  `);
  for (let index = 0; index < 7; index += 1) {
    legacy.prepare('INSERT INTO recent_search_filters (owner_id, query, used_at_ms) VALUES (?, ?, ?)').run(7, `country=DE AND ip:192.0.2.${index}`, index);
  }
  legacy.close();
}

describe('CrowdsecDatabase storage layout', () => {
  test('migrates durable data from crowdsec.db into a fresh state.db and starts with an empty cache', () => {
    const dataDir = createDataDir();
    createLegacyInstall(dataDir);

    const db = new CrowdsecDatabase({ dataDir });

    expect(db.cachePath).toBe(path.join(dataDir, 'cache.db'));
    expect(db.statePath).toBe(path.join(dataDir, 'state.db'));
    for (const suffix of ['', '-wal', '-shm']) {
      expect(existsSync(path.join(dataDir, `crowdsec.db${suffix}`))).toBe(false);
    }
    expect(existsSync(path.join(dataDir, 'state.db.tmp'))).toBe(false);

    expect(db.countAlerts()).toBe(0);
    expect(db.getMeta('dashboard_change_epoch')?.value).toBe('1');
    expect(db.getMeta('sync_timestamp_format_version')).toBeNull();

    expect(db.isAuthMigrationDefaultDisabled()).toBe(true);
    expect(db.getMeta('auth_session_secret')?.value).toBe('session-secret');
    expect(db.getMeta('auth_oidc_client_id')?.value).toBe('web-ui');
    expect(db.getMeta('notification_secret_key')?.value).toBe('notification-key');
    expect(db.getMeta('branding_app_name')?.value).toBe('Edge WAF');
    expect(db.getMeta('language')?.value).toBe('de');
    expect(db.getMeta('refresh_interval_ms')?.value).toBe('30000');

    const user = db.getAuthUserByUsername('admin');
    expect(user).toMatchObject({
      id: 7,
      totp_secret: 'secret',
      totp_enabled: 1,
      totp_last_step: null,
      session_version: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T02:00:00.000Z',
    });
    expect(db.updateAuthUserTotpLastStep(7, 12345)).toBe(true);
    expect(db.updateAuthUserTotpLastStep(7, 12345)).toBe(false);
    expect(db.listWebAuthnCredentialsByUser(7)).toEqual([expect.objectContaining({ credential_id: 'credential-1' })]);
    expect(db.createAuthUser({ username: 'second', passwordHash: 'hash', role: 'admin', authProvider: 'password' })).toBe(8);

    expect(db.listNotificationChannels()).toEqual([expect.objectContaining({ id: 'channel-1', name: 'Ops' })]);
    expect(db.listNotificationRules()).toEqual([
      expect.objectContaining({ id: 'rule-legacy', name: 'Legacy threshold', severity: 'warning' }),
    ]);
    expect(db.listNotifications()).toEqual([expect.objectContaining({
      id: 'notif-legacy',
      created_at: '2025-01-01T00:00:00.000Z',
      deliveries_json: JSON.stringify([{ attempted_at: '2025-01-01T00:00:00.000Z' }]),
    })]);
    expect(db.listNotificationIncidentsByRule('rule-legacy')).toEqual([
      expect.objectContaining({ incident_key: 'threshold:active', resolved_at: null }),
    ]);
    // The legacy table had a unique dedupe key; the new schema allows repeated incidents.
    expect(db.insertNotification({
      $id: 'notif-legacy-2',
      $created_at: '2025-01-01T05:00:00.000Z',
      $updated_at: '2025-01-01T05:00:00.000Z',
      $rule_id: 'rule-legacy',
      $rule_name: 'Legacy threshold',
      $rule_type: 'alert-threshold',
      $severity: 'warning',
      $title: 'Threshold exceeded again',
      $message: '11 alerts matched.',
      $read_at: null,
      $metadata_json: JSON.stringify({ matched_alerts: 11 }),
      $deliveries_json: JSON.stringify([]),
      $dedupe_key: 'rule-legacy:threshold:28928160',
    })).toBe(true);

    expect(db.getPendingAlertDeletions()).toEqual([expect.objectContaining({
      alert_id: 'default\u0000101',
      decision_ids_json: '["5001"]',
      attempt_count: 2,
      last_error: 'LAPI unavailable',
    })]);
    expect(db.insertAlert({ $id: 101, $uuid: 'alert-101', $created_at: '2026-01-03T00:00:00.000Z', $message: 'deleted' })).toBe(false);

    expect(db.db.prepare('SELECT query FROM recent_search_filters WHERE owner_id = 7 ORDER BY used_at_ms DESC').all()).toEqual(
      [6, 5, 4, 3, 2].map((index) => ({ query: `country=DE AND ip:192.0.2.${index}` })),
    );
    db.close();
  });

  test('restarts an interrupted migration and leaves an existing state.db untouched', () => {
    const dataDir = createDataDir();
    createLegacyInstall(dataDir);
    writeFileSync(path.join(dataDir, 'state.db.tmp'), 'partial');

    let db = new CrowdsecDatabase({ dataDir });
    expect(db.getAuthUserByUsername('admin')?.id).toBe(7);
    db.close();
    expect(existsSync(path.join(dataDir, 'state.db.tmp'))).toBe(false);

    createLegacyInstall(dataDir);
    db = new CrowdsecDatabase({ dataDir });
    expect(db.listNotificationIncidentsByRule('rule-legacy')).toHaveLength(1);
    db.close();
    expect(existsSync(path.join(dataDir, 'crowdsec.db'))).toBe(true);
  });

  test('enables dashboard auth by default only on new installations', () => {
    const db = new CrowdsecDatabase({ dataDir: createDataDir() });
    expect(db.isAuthMigrationDefaultDisabled()).toBe(false);
    db.close();
  });

  test('keeps durable data and queued deletions when the cache database is lost', () => {
    const dataDir = createDataDir();
    const cacheDir = path.join(createDataDir(), 'cache');
    let db = new CrowdsecDatabase({ dataDir, cacheDir });
    expect(db.cachePath).toBe(path.join(cacheDir, 'cache.db'));
    expect(db.statePath).toBe(path.join(dataDir, 'state.db'));
    db.createAuthUser({ username: 'admin', passwordHash: 'hash', role: 'admin', authProvider: 'password' });
    db.setMeta('language', 'fr');
    db.setMeta('dashboard_change_floor', '42');
    db.queueAlertDeletion('default\u0000101', ['5001'], '2026-01-03T00:00:00.000Z');
    db.close();

    rmSync(cacheDir, { recursive: true, force: true });

    db = new CrowdsecDatabase({ dataDir, cacheDir });
    expect(db.getPendingAlertDeletions()).toEqual([expect.objectContaining({ alert_id: 'default\u0000101' })]);
    const syncWorker = new CrowdsecDatabase({ cachePath: db.cachePath, statePath: null });
    expect(syncWorker.insertAlert({ $id: 101, $uuid: 'alert-101', $created_at: '2026-01-03T00:00:00.000Z', $message: 'deleted' })).toBe(false);
    syncWorker.close();
    expect(db.countAuthUsers()).toBe(1);
    expect(db.getMeta('language')?.value).toBe('fr');
    expect(db.getMeta('dashboard_change_floor')?.value).toBe('0');
    expect(db.isAuthMigrationDefaultDisabled()).toBe(false);
    db.close();
  });

  test('uses WAL only for the cache and a rollback journal for the state database', () => {
    const dataDir = createDataDir();
    let db = new CrowdsecDatabase({ dataDir });
    expect(db.db.prepare('PRAGMA main.journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.db.prepare('PRAGMA state.journal_mode').get()).toEqual({ journal_mode: 'delete' });
    db.close();

    db = new CrowdsecDatabase({ dataDir, walEnabled: false });
    expect(db.db.prepare('PRAGMA main.journal_mode').get()).toEqual({ journal_mode: 'delete' });
    expect(db.db.prepare('PRAGMA state.journal_mode').get()).toEqual({ journal_mode: 'delete' });
    db.close();
  });

  test('cache-only connections reject durable settings', () => {
    const dataDir = createDataDir();
    const main = new CrowdsecDatabase({ dataDir });
    const cacheOnly = new CrowdsecDatabase({ cachePath: main.cachePath, statePath: null });

    cacheOnly.setMeta('dashboard_change_floor', '5');
    expect(main.getMeta('dashboard_change_floor')?.value).toBe('5');
    expect(() => cacheOnly.getMeta('language')).toThrow('The state database is not attached to this connection');
    expect(() => cacheOnly.countAuthUsers()).toThrow('The state database is not attached to this connection');

    cacheOnly.close();
    main.close();
  });
});
