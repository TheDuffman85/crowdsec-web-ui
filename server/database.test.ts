import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { CrowdsecDatabase } from './database';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createTestDatabase(): CrowdsecDatabase {
  const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-'));
  tempDirs.push(dir);
  return new CrowdsecDatabase({ dbPath: path.join(dir, 'test.db') });
}

function createTestDatabasePath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-'));
  tempDirs.push(dir);
  return path.join(dir, 'test.db');
}

function createLegacyDatabase(dbPath: string): { exec: (sql: string) => unknown; close: () => void; query: (sql: string) => { run: (...params: any[]) => unknown }; prepare: (sql: string) => { run: (...params: any[]) => unknown } } {
  const database = new Database(dbPath) as {
    exec: (sql: string) => unknown;
    close: () => void;
    prepare: (sql: string) => { run: (...params: any[]) => unknown };
    query: (sql: string) => { run: (...params: any[]) => unknown };
  };
  database.query = (sql: string) => {
    const statement = database.prepare(sql);
    return {
      run: (...params: any[]) => statement.run(...params.map((value) => {
        if (!value || Array.isArray(value) || typeof value !== 'object') {
          return value;
        }
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key.replace(/^[$:@]/, ''), entry]),
        );
      })),
    };
  };
  return database;
}

describe('CrowdsecDatabase', () => {
  test('stores alerts, decisions, and metadata', () => {
    const db = createTestDatabase();

    db.insertAlert({
      $id: 1,
      $uuid: 'alert-1',
      $created_at: '2025-01-01T00:00:00.000Z',
      $scenario: 'crowdsecurity/ssh-bf',
      $source_ip: '1.2.3.4',
      $message: 'alert',
      $raw_data: JSON.stringify({ id: 1 }),
    });

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
      $raw_data: JSON.stringify({ id: 10, value: '1.2.3.4', stop_at: '2030-01-01T00:00:00.000Z' }),
    });

    db.setMeta('refresh_interval_ms', '5000');

    expect(db.countAlerts()).toBe(1);
    expect(db.getAlertsSince('2024-12-31T00:00:00.000Z')).toHaveLength(1);
    expect(db.getActiveDecisions('2025-01-01T00:00:00.000Z')).toHaveLength(1);
    expect(db.getDecisionById('10')?.stop_at).toBe('2030-01-01T00:00:00.000Z');
    expect(db.getDecisionStopAtBatch(['10', 'missing'])).toEqual(
      new Map([['10', '2030-01-01T00:00:00.000Z']]),
    );
    expect(db.getMeta('refresh_interval_ms')?.value).toBe('5000');
    expect(db.getAlertsBetween('2024-12-31T00:00:00.000Z', '2025-01-02T00:00:00.000Z')).toHaveLength(1);

    db.deleteDecision('10');
    db.deleteAlert(1);
    expect(db.getActiveDecisions('2025-01-01T00:00:00.000Z')).toHaveLength(0);
    expect(db.countAlerts()).toBe(0);

    db.close();
  });

  test('transaction helper batches work', () => {
    const db = createTestDatabase();
    const insertMany = db.transaction<Array<number>>((ids) => {
      for (const id of ids) {
        db.insertAlert({
          $id: id,
          $uuid: `alert-${id}`,
          $created_at: '2025-01-01T00:00:00.000Z',
          $scenario: 'scenario',
          $source_ip: '1.2.3.4',
          $message: 'alert',
          $raw_data: JSON.stringify({ id }),
        });
      }
    });

    insertMany([1, 2, 3]);
    expect(db.countAlerts()).toBe(3);
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
