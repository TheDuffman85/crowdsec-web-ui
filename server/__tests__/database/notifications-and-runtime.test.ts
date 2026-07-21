import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { tmpdir } from 'os';
import { CrowdsecDatabase } from '../../database';
import { decisionFromRow } from '../../normalized-record';
import { createLegacyDatabase, createTestDatabase, createTestDatabasePath, tempDirs } from './harness';

describe('CrowdsecDatabase notifications and runtime', () => {
  test('stores notification channels, rules, notifications, and cve cache', () => {
    const db = createTestDatabase();

    db.upsertNotificationChannel({
      $id: 'channel-1',
      $created_at: '2025-01-01T00:00:00.000Z',
      $updated_at: '2025-01-01T00:00:00.000Z',
      $name: 'ntfy main',
      $type: 'ntfy',
      $enabled: 1,
      $config_json: JSON.stringify({ topic: 'crowdsec' }),
    });

    db.upsertNotificationRule({
      $id: 'rule-1',
      $created_at: '2025-01-01T00:00:00.000Z',
      $updated_at: '2025-01-01T00:00:00.000Z',
      $name: 'Alert threshold',
      $type: 'alert-threshold',
      $enabled: 1,
      $severity: 'warning',
      $channel_ids_json: JSON.stringify(['channel-1']),
      $config_json: JSON.stringify({ window_minutes: 60, alert_threshold: 10 }),
    });

    const inserted = db.insertNotification({
      $id: 'notif-1',
      $created_at: '2025-01-01T00:00:00.000Z',
      $updated_at: '2025-01-01T00:00:00.000Z',
      $rule_id: 'rule-1',
      $rule_name: 'Alert threshold',
      $rule_type: 'alert-threshold',
      $severity: 'warning',
      $title: 'Threshold exceeded',
      $message: '10 alerts matched.',
      $read_at: null,
      $metadata_json: JSON.stringify({ matched_alerts: 10 }),
      $deliveries_json: JSON.stringify([{ channel_name: 'ntfy main', status: 'delivered' }]),
      $dedupe_key: 'rule-1:bucket',
    });
    expect(inserted).toBe(true);
    expect(db.insertNotification({
      $id: 'notif-2',
      $created_at: '2025-01-01T02:00:00.000Z',
      $updated_at: '2025-01-01T02:00:00.000Z',
      $rule_id: 'rule-1',
      $rule_name: 'Alert threshold',
      $rule_type: 'alert-threshold',
      $severity: 'warning',
      $title: 'Threshold exceeded',
      $message: '10 alerts matched.',
      $read_at: null,
      $metadata_json: JSON.stringify({ matched_alerts: 10 }),
      $deliveries_json: JSON.stringify([]),
      $dedupe_key: 'rule-1:bucket',
    })).toBe(true);

    db.upsertNotificationIncident({
      $rule_id: 'rule-1',
      $incident_key: 'threshold:active',
      $first_seen_at: '2025-01-01T00:00:00.000Z',
      $last_seen_at: '2025-01-01T00:00:00.000Z',
      $resolved_at: null,
    });

    db.upsertCveCacheEntry('CVE-2025-1234', '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z');

    expect(db.listNotificationChannels()).toHaveLength(1);
    expect(db.listNotificationRules()).toHaveLength(1);
    expect(db.listNotifications()).toHaveLength(2);
    expect(db.listNotificationsPage(1, 1)).toHaveLength(1);
    expect(db.countNotifications()).toBe(2);
    expect(db.listNotificationIds()).toEqual(['notif-2', 'notif-1']);
    expect(db.countUnreadNotifications()).toBe(2);
    expect(db.listNotificationIncidentsByRule('rule-1')).toEqual([
      expect.objectContaining({
        rule_id: 'rule-1',
        incident_key: 'threshold:active',
        first_seen_at: '2025-01-01T00:00:00.000Z',
        last_seen_at: '2025-01-01T00:00:00.000Z',
        resolved_at: null,
      }),
    ]);
    expect(db.getCveCacheEntry('CVE-2025-1234')?.published_at).toBe('2025-01-01T00:00:00.000Z');

    expect(db.markNotificationRead('notif-1', '2025-01-01T01:00:00.000Z')).toBe(true);
    expect(db.countUnreadNotifications()).toBe(1);
    expect(db.markNotificationsRead(['notif-2'], '2025-01-01T02:00:00.000Z')).toBe(1);
    expect(db.countUnreadNotifications()).toBe(0);
    expect(db.markAllNotificationsRead('2025-01-01T03:00:00.000Z')).toBe(0);
    expect(db.deleteNotification('notif-1')).toBe(true);
    expect(db.deleteNotifications(['notif-2'])).toBe(1);
    expect(db.countNotifications()).toBe(0);
    expect(db.resolveNotificationIncident('rule-1', 'threshold:active', '2025-01-01T04:00:00.000Z')).toBe(true);
    expect(db.listNotificationIncidentsByRule('rule-1')[0]).toEqual(expect.objectContaining({
      resolved_at: '2025-01-01T04:00:00.000Z',
      last_seen_at: '2025-01-01T04:00:00.000Z',
    }));

    db.deleteNotificationRule('rule-1');
    db.deleteNotificationChannel('channel-1');
    expect(db.listNotificationRules()).toHaveLength(0);
    expect(db.listNotificationChannels()).toHaveLength(0);

    db.close();
  });

  test('normalizes every timestamp-bearing notification write', () => {
    const db = createTestDatabase();

    db.upsertNotificationChannel({
      $id: 'channel-offset',
      $created_at: '2025-01-01T00:00:00Z',
      $updated_at: '2024-12-31T20:00:01-04:00',
      $name: 'Offset channel',
      $type: 'ntfy',
      $enabled: 1,
      $config_json: '{}',
    });
    db.upsertNotificationRule({
      $id: 'rule-offset',
      $created_at: '2025-01-01T00:00:00Z',
      $updated_at: '2024-12-31T20:00:01-04:00',
      $name: 'Offset rule',
      $type: 'alert-threshold',
      $enabled: 1,
      $severity: 'warning',
      $channel_ids_json: '[]',
      $config_json: '{}',
    });
    db.insertNotification({
      $id: 'notification-offset',
      $created_at: '2025-01-01T00:00:00Z',
      $updated_at: '2024-12-31T20:00:01-04:00',
      $rule_id: 'rule-offset',
      $rule_name: 'Offset rule',
      $rule_type: 'alert-threshold',
      $severity: 'warning',
      $title: 'Offset notification',
      $message: 'Offset notification',
      $read_at: null,
      $metadata_json: JSON.stringify({ created_at: '2024-12-31T20:00:00-04:00' }),
      $deliveries_json: JSON.stringify([{ attempted_at: '2025-01-01T00:00:02Z' }]),
      $dedupe_key: 'notification-offset',
    });
    db.upsertNotificationIncident({
      $rule_id: 'rule-offset',
      $incident_key: 'incident-offset',
      $first_seen_at: '2025-01-01T00:00:00Z',
      $last_seen_at: '2024-12-31T20:00:01-04:00',
      $resolved_at: null,
    });
    db.upsertCveCacheEntry('CVE-2025-9999', '2025-01-01T00:00:00Z', '2024-12-31T20:00:01-04:00');
    db.markNotificationRead('notification-offset', '2024-12-31T20:00:03-04:00');
    db.resolveNotificationIncident('rule-offset', 'incident-offset', '2025-01-01T00:00:04Z');

    expect(db.getNotificationChannelById('channel-offset')).toEqual(expect.objectContaining({
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:01.000Z',
    }));
    expect(db.getNotificationRuleById('rule-offset')).toEqual(expect.objectContaining({
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:01.000Z',
    }));
    expect(db.listNotifications()[0]).toEqual(expect.objectContaining({
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:03.000Z',
      read_at: '2025-01-01T00:00:03.000Z',
      metadata_json: JSON.stringify({ created_at: '2025-01-01T00:00:00.000Z' }),
      deliveries_json: JSON.stringify([{ attempted_at: '2025-01-01T00:00:02.000Z' }]),
    }));
    expect(db.listNotificationIncidentsByRule('rule-offset')).toEqual([
      expect.objectContaining({
        first_seen_at: '2025-01-01T00:00:00.000Z',
        last_seen_at: '2025-01-01T00:00:04.000Z',
        resolved_at: '2025-01-01T00:00:04.000Z',
      }),
    ]);
    expect(db.getCveCacheEntry('CVE-2025-9999')).toEqual(expect.objectContaining({
      published_at: '2025-01-01T00:00:00.000Z',
      fetched_at: '2025-01-01T00:00:01.000Z',
    }));

    db.close();
  });

  test('checkpoints WAL data on close so settings survive container recreation', () => {
    const dbPath = createTestDatabasePath();
    const db = new CrowdsecDatabase({ dbPath });

    db.upsertNotificationChannel({
      $id: 'channel-persisted',
      $created_at: '2026-05-14T15:00:00.000Z',
      $updated_at: '2026-05-14T15:00:00.000Z',
      $name: 'Persisted ntfy',
      $type: 'ntfy',
      $enabled: 1,
      $config_json: JSON.stringify({ topic: 'crowdsec' }),
    });

    db.close();

    const walPath = `${dbPath}-wal`;
    if (existsSync(walPath)) {
      expect(statSync(walPath).size).toBe(0);
    }

    const reopened = new CrowdsecDatabase({ dbPath });
    expect(reopened.listNotificationChannels()).toEqual([
      expect.objectContaining({
        id: 'channel-persisted',
        name: 'Persisted ntfy',
      }),
    ]);
    reopened.close();
  });

  test('can disable WAL and persists the rollback journal mode', () => {
    const dbPath = createTestDatabasePath();
    const walDatabase = new CrowdsecDatabase({ dbPath });
    expect(walDatabase.db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    walDatabase.close();

    const rollbackDatabase = new CrowdsecDatabase({ dbPath, walEnabled: false });
    expect(rollbackDatabase.db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    rollbackDatabase.close();

    const reopened = new Database(dbPath);
    expect(reopened.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    reopened.close();
  });

  test('docker entrypoint preserves SQLite WAL files for restart recovery', () => {
    const entrypoint = readFileSync(path.resolve(process.cwd(), 'docker-entrypoint.sh'), 'utf8');

    expect(entrypoint).not.toContain('rm -f /app/data/crowdsec.db-wal');
    expect(entrypoint).not.toContain('rm -f /app/data/crowdsec.db-shm');
  });

  test('load-test Docker image keeps synthetic data away from the regular database', () => {
    const dockerfile = readFileSync(path.resolve(process.cwd(), 'Dockerfile'), 'utf8');
    const entrypoint = readFileSync(path.resolve(process.cwd(), 'docker-loadtest-entrypoint.sh'), 'utf8');
    const loadTestServer = readFileSync(path.resolve(process.cwd(), 'scripts/load-test-server.ts'), 'utf8');

    expect(dockerfile).toContain('FROM runner AS loadtest');
    expect(dockerfile).toContain('ENV LOADTEST_DB_DIR="/tmp/crowdsec-web-ui-load-test"');
    expect(entrypoint).toContain('export LOADTEST_DB_DIR');
    expect(entrypoint).not.toContain('export DB_DIR=');
    expect(entrypoint).not.toContain('${DB_DIR:-');
    expect(entrypoint).not.toContain('chown -R node:node /app/data');
    expect(loadTestServer).toContain('CONFIG_STORAGE_DATA_DIR: dbDir');
  });

  test('load-test Docker entrypoint applies a selected profile and keeps environment overrides', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-loadtest-entrypoint-'));
    tempDirs.push(dir);
    const binDir = path.join(dir, 'bin');
    const dbDir = path.join(dir, 'db');
    const mkdirResult = spawnSync('/bin/mkdir', ['-p', binDir]);
    expect(mkdirResult.status).toBe(0);

    const nodeStub = path.join(binDir, 'node');
    const gosuStub = path.join(binDir, 'gosu');
    const chownStub = path.join(binDir, 'chown');
    writeFileSync(nodeStub, '#!/bin/sh\nexit 0\n', 'utf8');
    writeFileSync(gosuStub, '#!/bin/sh\nshift\nexec "$@"\n', 'utf8');
    writeFileSync(chownStub, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(nodeStub, 0o755);
    chmodSync(gosuStub, 0o755);
    chmodSync(chownStub, 0o755);

    const result = spawnSync(
      '/bin/bash',
      [path.resolve(process.cwd(), 'docker-loadtest-entrypoint.sh'), '/usr/bin/env'],
      {
        encoding: 'utf8',
        env: {
          PATH: `${binDir}:/usr/bin:/bin`,
          LOADTEST_PROFILE: 'blocklist',
          LOADTEST_PROFILE_DIR: path.resolve(process.cwd(), 'scripts/load-test-profiles'),
          LOADTEST_DB_DIR: dbDir,
          LOADTEST_ALERTS: '42',
        },
      },
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const environment = new Set(result.stdout.trim().split('\n'));
    expect(environment).toContain('LOADTEST_PROFILE=blocklist');
    expect(environment).toContain('LOADTEST_ALERTS=42');
    expect(environment).toContain('LOADTEST_DECISIONS=410463');
    expect(environment).toContain('LOADTEST_SEED=1337');
    expect(environment).toContain(`LOADTEST_DB_DIR=${dbDir}`);
    expect([...environment].some((entry) => entry.startsWith('DB_DIR='))).toBe(false);
  });

  test('migrates legacy notification rules, notifications, and seeds incidents from history', () => {
    const dbPath = createTestDatabasePath();
    const legacy = createLegacyDatabase(dbPath);

    legacy.exec(`
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
    `);

    legacy.query(`
      INSERT INTO notification_rules (
        id, created_at, updated_at, name, type, enabled, severity, cooldown_minutes, channel_ids_json, config_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'rule-legacy',
      '2025-01-01T00:00:00.000Z',
      '2025-01-01T00:00:00.000Z',
      'Legacy threshold',
      'alert-threshold',
      1,
      'warning',
      60,
      '[]',
      JSON.stringify({ window_minutes: 60, alert_threshold: 10 }),
    );
    legacy.query(`
      INSERT INTO notifications (
        id, created_at, updated_at, rule_id, rule_name, rule_type, severity, title, message, read_at, metadata_json, deliveries_json, dedupe_key
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'notif-legacy',
      '2025-01-01T00:00:00.000Z',
      '2025-01-01T00:00:00.000Z',
      'rule-legacy',
      'Legacy threshold',
      'alert-threshold',
      'warning',
      'Threshold exceeded',
      '10 alerts matched.',
      null,
      JSON.stringify({ matched_alerts: 10 }),
      JSON.stringify([]),
      'rule-legacy:threshold:28928160',
    );
    legacy.close();

    const db = new CrowdsecDatabase({ dbPath });

    expect(db.listNotificationRules()).toEqual([
      expect.objectContaining({
        id: 'rule-legacy',
        name: 'Legacy threshold',
        severity: 'warning',
      }),
    ]);
    expect(db.listNotificationIncidentsByRule('rule-legacy')).toEqual([
      expect.objectContaining({
        rule_id: 'rule-legacy',
        incident_key: 'threshold:active',
        resolved_at: null,
      }),
    ]);

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
      $dedupe_key: 'threshold:active',
    })).toBe(true);
    expect(db.listNotifications()).toHaveLength(2);

    db.close();
  });
});
