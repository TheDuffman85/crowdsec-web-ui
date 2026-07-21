import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { tmpdir } from 'os';
import { CrowdsecDatabase } from '../../database';
import { decisionFromRow } from '../../normalized-record';
import { createLegacyDatabase, createTestDatabase, createTestDatabasePath, tempDirs } from './harness';

describe('CrowdsecDatabase auth and migrations', () => {
  test('fresh databases default dashboard auth on', () => {
    const db = createTestDatabase();

    expect(db.isAuthMigrationDefaultDisabled()).toBe(false);

    db.close();
  });

  test('binds OIDC users to issuer and subject without merging local usernames', () => {
    const db = createTestDatabase();
    const localUserId = db.createAuthUser({
      username: 'operator',
      passwordHash: 'local-password-hash',
      role: 'admin',
      authProvider: 'password',
    });

    const oidcUser = db.upsertOidcUser({
      username: 'operator',
      role: 'read-only',
      issuer: 'https://idp.example.com',
      subject: 'subject-1',
    });
    expect(oidcUser.id).not.toBe(localUserId);
    expect(oidcUser.username).toMatch(/^operator#oidc-/);
    expect(oidcUser.oidc_issuer).toBe('https://idp.example.com');
    expect(oidcUser.oidc_subject).toBe('subject-1');
    expect(db.getAuthUserById(localUserId)).toMatchObject({
      username: 'operator',
      auth_provider: 'password',
      password_hash: 'local-password-hash',
      role: 'admin',
    });

    const renamedOidcUser = db.upsertOidcUser({
      username: 'renamed-operator',
      role: 'admin',
      issuer: 'https://idp.example.com',
      subject: 'subject-1',
    });
    expect(renamedOidcUser.id).toBe(oidcUser.id);
    expect(renamedOidcUser.username).toBe('renamed-operator');
    expect(renamedOidcUser.session_version).toBe(oidcUser.session_version + 1);

    db.close();
  });

  test('migrates legacy OIDC users in place on their next login', () => {
    const db = createTestDatabase();
    const legacyId = db.createAuthUser({
      username: 'legacy-oidc',
      passwordHash: null,
      role: 'read-only',
      authProvider: 'oidc',
    });

    const migrated = db.upsertOidcUser({
      username: 'legacy-oidc',
      role: 'read-only',
      issuer: 'https://idp.example.com',
      subject: 'legacy-subject',
    });
    expect(migrated.id).toBe(legacyId);
    expect(migrated).toMatchObject({
      oidc_issuer: 'https://idp.example.com',
      oidc_subject: 'legacy-subject',
    });

    db.close();
  });

  test('existing databases are migrated with dashboard auth disabled by default', () => {
    const dbPath = createTestDatabasePath();
    const legacy = createLegacyDatabase(dbPath);
    legacy.exec(`
      CREATE TABLE alerts (
        id INTEGER PRIMARY KEY,
        uuid TEXT UNIQUE,
        created_at TEXT NOT NULL,
        scenario TEXT,
        source_ip TEXT,
        message TEXT,
        raw_data TEXT
      )
    `);
    legacy.close();

    const db = new CrowdsecDatabase({ dbPath });

    expect(db.isAuthMigrationDefaultDisabled()).toBe(true);

    db.close();
  });

  test('migrates legacy decision tables before creating duplicate indexes', () => {
    const dbPath = createTestDatabasePath();
    const legacy = createLegacyDatabase(dbPath);
    legacy.exec(`
      CREATE TABLE alerts (
        id INTEGER PRIMARY KEY,
        uuid TEXT UNIQUE,
        created_at TEXT NOT NULL,
        scenario TEXT,
        source_ip TEXT,
        message TEXT,
        raw_data TEXT
      );
      CREATE TABLE decisions (
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
      CREATE INDEX idx_decisions_alert_created_at ON decisions(alert_id, created_at DESC);
      INSERT INTO decisions (
        id, uuid, alert_id, created_at, stop_at, value, type, origin, scenario, raw_data
      )
      VALUES (
        '10',
        'decision-10',
        1,
        '2026-01-01T00:00:00.000Z',
        '2030-01-01T00:00:00.000Z',
        '1.2.3.4',
        'ban',
        'cscli',
        'crowdsecurity/ssh-bf',
        '{"id":10,"value":"1.2.3.4","stop_at":"2030-01-01T00:00:00.000Z"}'
      );
    `);
    legacy.close();

    const db = new CrowdsecDatabase({ dbPath });
    const columns = db.db.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>;
    const indexes = db.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'decisions'
    `).all() as Array<{ name: string }>;
    const row = db.db.prepare('SELECT is_duplicate FROM decisions WHERE id = ?').get('10') as { is_duplicate: number };

    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(['is_duplicate', 'search_text', 'simulated']));
    expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      'idx_decisions_alert_created_id',
      'idx_decisions_duplicate_paging',
      'idx_decisions_duplicate_filters',
      'idx_decisions_duplicate_value_paging',
      'idx_decisions_duplicate_primary',
    ]));
    expect(indexes.map((index) => index.name)).not.toContain('idx_decisions_alert_created_at');
    expect(row.is_duplicate).toBe(0);
    expect(db.getDecisionById('10')?.stop_at).toBe('2030-01-01T00:00:00.000Z');

    db.close();
  });

  test('adds and backfills source coordinates for legacy alerts', () => {
    const dbPath = createTestDatabasePath();
    const legacy = createLegacyDatabase(dbPath);
    legacy.exec(`
      CREATE TABLE alerts (
        id INTEGER PRIMARY KEY,
        uuid TEXT UNIQUE,
        created_at TEXT NOT NULL,
        scenario TEXT,
        source_ip TEXT,
        message TEXT,
        raw_data TEXT
      );
      INSERT INTO alerts (id, uuid, created_at, scenario, source_ip, message, raw_data)
      VALUES (
        1,
        'alert-1',
        '2026-01-01T00:00:00.000Z',
        'crowdsecurity/ssh-bf',
        '1.2.3.4',
        'alert',
        '{"id":1,"source":{"latitude":"52.52","longitude":13.405}}'
      );
    `);
    legacy.close();

    const db = new CrowdsecDatabase({ dbPath });
    const columns = db.db.prepare('PRAGMA table_info(alerts)').all() as Array<{ name: string }>;
    const location = db.db.prepare('SELECT latitude, longitude FROM alerts WHERE id = 1').get();

    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(['latitude', 'longitude']));
    expect(location).toEqual({ latitude: 52.52, longitude: 13.405 });

    db.close();
  });

  test('migrates existing auth users with TOTP replay tracking', () => {
    const dbPath = createTestDatabasePath();
    const legacy = createLegacyDatabase(dbPath);
    legacy.exec(`
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
      )
    `);
    legacy.query(`
      INSERT INTO auth_users (username, password_hash, totp_secret, totp_enabled, role, auth_provider, created_at, updated_at)
      VALUES ($username, $password_hash, $totp_secret, $totp_enabled, $role, $auth_provider, $created_at, $updated_at)
    `).run({
      $username: 'admin',
      $password_hash: 'hash',
      $totp_secret: 'secret',
      $totp_enabled: 1,
      $role: 'admin',
      $auth_provider: 'password',
      $created_at: '2026-01-01T00:00:00.000Z',
      $updated_at: '2026-01-01T00:00:00.000Z',
    });
    legacy.close();

    const db = new CrowdsecDatabase({ dbPath });

    expect(db.getAuthUserByUsername('admin')?.totp_last_step).toBeNull();
    expect(db.updateAuthUserTotpLastStep(1, 12345)).toBe(true);
    expect(db.getAuthUserByUsername('admin')?.totp_last_step).toBe(12345);
    expect(db.updateAuthUserTotpLastStep(1, 12345)).toBe(false);
    expect(db.updateAuthUserTotpLastStep(1, 12344)).toBe(false);
    expect(db.getAuthUserByUsername('admin')?.totp_last_step).toBe(12345);

    db.close();
  });

  test('deleteDecisionsByAlertIdExcept removes stale decisions while preserving kept and unrelated rows', () => {
    const db = createTestDatabase();

    db.insertDecision({
      $id: '10',
      $uuid: '10',
      $alert_id: 1,
      $created_at: '2025-01-01T00:00:00.000Z',
      $stop_at: '2030-01-01T00:00:00.000Z',
      $value: '1.2.3.4',
      $type: 'ban',
      $origin: 'manual',
      $scenario: 'crowdsecurity/ssh-bf',
      $raw_data: JSON.stringify({ id: 10, alert_id: 1 }),
    });
    db.insertDecision({
      $id: '11',
      $uuid: '11',
      $alert_id: 1,
      $created_at: '2025-01-01T00:01:00.000Z',
      $stop_at: '2030-01-01T00:01:00.000Z',
      $value: '1.2.3.5',
      $type: 'ban',
      $origin: 'manual',
      $scenario: 'crowdsecurity/ssh-bf',
      $raw_data: JSON.stringify({ id: 11, alert_id: 1 }),
    });
    db.insertDecision({
      $id: '12',
      $uuid: '12',
      $alert_id: 1,
      $created_at: '2025-01-01T00:02:00.000Z',
      $stop_at: '2030-01-01T00:02:00.000Z',
      $value: '1.2.3.6',
      $type: 'ban',
      $origin: 'manual',
      $scenario: 'crowdsecurity/ssh-bf',
      $raw_data: JSON.stringify({ id: 12, alert_id: 1 }),
    });
    db.insertDecision({
      $id: '20',
      $uuid: '20',
      $alert_id: 2,
      $created_at: '2025-01-01T00:03:00.000Z',
      $stop_at: '2030-01-01T00:03:00.000Z',
      $value: '5.6.7.8',
      $type: 'ban',
      $origin: 'manual',
      $scenario: 'crowdsecurity/http-probing',
      $raw_data: JSON.stringify({ id: 20, alert_id: 2 }),
    });

    expect(db.deleteDecisionsByAlertIdExcept(1, ['10', '12'])).toBe(1);
    expect(db.getDecisionById('10')).not.toBeNull();
    expect(db.getDecisionById('11')).toBeNull();
    expect(db.getDecisionById('12')).not.toBeNull();
    expect(db.getDecisionById('20')).not.toBeNull();

    expect(db.deleteDecisionsByAlertIdExcept(1, [])).toBe(2);
    expect(db.getDecisionById('10')).toBeNull();
    expect(db.getDecisionById('12')).toBeNull();
    expect(db.getDecisionById('20')).not.toBeNull();

    db.close();
  });

  test('deleteAlertsMissingBetween removes stale alerts and linked decisions only inside the window', () => {
    const db = createTestDatabase();

    for (const alert of [
      { id: 1, createdAt: '2025-01-01T00:00:00.000Z' },
      { id: 2, createdAt: '2025-01-01T00:01:00.000Z' },
      { id: 3, createdAt: '2025-01-01T03:00:00.000Z' },
    ]) {
      db.insertAlert({
        $id: alert.id,
        $uuid: `alert-${alert.id}`,
        $created_at: alert.createdAt,
        $scenario: 'scenario',
        $source_ip: '1.2.3.4',
        $message: 'alert',
        $raw_data: JSON.stringify({ id: alert.id }),
      });
      db.insertDecision({
        $id: String(alert.id * 10),
        $uuid: String(alert.id * 10),
        $alert_id: alert.id,
        $created_at: alert.createdAt,
        $stop_at: '2030-01-01T00:00:00.000Z',
        $value: '1.2.3.4',
        $type: 'ban',
        $origin: 'manual',
        $scenario: 'scenario',
        $raw_data: JSON.stringify({ id: alert.id * 10, alert_id: alert.id }),
      });
    }

    expect(db.deleteAlertsMissingBetween(
      '2025-01-01T00:00:00.000Z',
      '2025-01-01T02:00:00.000Z',
      ['1'],
    )).toEqual({ alerts: 1, decisions: 1 });

    expect(db.getAlertsBetween('2025-01-01T00:00:00.000Z', '2025-01-01T02:00:00.000Z')).toHaveLength(1);
    expect(db.getAlertsSince('2025-01-01T00:00:00.000Z')).toHaveLength(2);
    expect(db.getDecisionById('10')).not.toBeNull();
    expect(db.getDecisionById('20')).toBeNull();
    expect(db.getDecisionById('30')).not.toBeNull();

    db.close();
  });

  test('deleteActiveAlertsMissing removes only active cached alerts absent from keep ids', () => {
    const db = createTestDatabase();

    for (const alert of [
      { id: 1, createdAt: '2025-01-01T00:00:00.000Z', stopAt: '2030-01-01T00:00:00.000Z' },
      { id: 2, createdAt: '2025-01-01T00:00:00.000Z', stopAt: '2030-01-01T00:00:00.000Z' },
      { id: 3, createdAt: '2025-01-01T00:00:00.000Z', stopAt: '2020-01-01T00:00:00.000Z' },
      { id: 4, createdAt: '2024-01-01T00:00:00.000Z', stopAt: '2030-01-01T00:00:00.000Z' },
    ]) {
      db.insertAlert({
        $id: alert.id,
        $uuid: `active-alert-${alert.id}`,
        $created_at: alert.createdAt,
        $scenario: 'scenario',
        $source_ip: '1.2.3.4',
        $message: 'alert',
        $raw_data: JSON.stringify({ id: alert.id }),
      });
      db.insertDecision({
        $id: String(alert.id * 10),
        $uuid: String(alert.id * 10),
        $alert_id: alert.id,
        $created_at: '2025-01-01T00:00:00.000Z',
        $stop_at: alert.stopAt,
        $value: '1.2.3.4',
        $type: 'ban',
        $origin: 'manual',
        $scenario: 'scenario',
        $raw_data: JSON.stringify({ id: alert.id * 10, alert_id: alert.id }),
      });
    }

    expect(db.deleteActiveAlertsMissing(['1'], '2025-01-01T00:00:00.000Z', '2024-12-31T00:00:00.000Z')).toEqual({ alerts: 1, decisions: 1 });
    expect(db.getAlertsSince('2024-01-01T00:00:00.000Z')).toHaveLength(3);
    expect(db.getDecisionById('10')).not.toBeNull();
    expect(db.getDecisionById('20')).toBeNull();
    expect(db.getDecisionById('30')).not.toBeNull();
    expect(db.getDecisionById('40')).not.toBeNull();

    db.close();
  });

});
