import { afterEach, describe, expect, test } from 'bun:test';
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
      $cooldown_minutes: 60,
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
      $deliveries_json: JSON.stringify([]),
      $dedupe_key: 'rule-1:bucket',
    })).toBe(false);

    db.upsertCveCacheEntry('CVE-2025-1234', '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z');

    expect(db.listNotificationChannels()).toHaveLength(1);
    expect(db.listNotificationRules()).toHaveLength(1);
    expect(db.listNotifications()).toHaveLength(1);
    expect(db.countUnreadNotifications()).toBe(1);
    expect(db.getLatestNotificationForRule('rule-1')?.title).toBe('Threshold exceeded');
    expect(db.getCveCacheEntry('CVE-2025-1234')?.published_at).toBe('2025-01-01T00:00:00.000Z');

    expect(db.markNotificationRead('notif-1', '2025-01-01T01:00:00.000Z')).toBe(true);
    expect(db.countUnreadNotifications()).toBe(0);
    expect(db.markAllNotificationsRead('2025-01-01T02:00:00.000Z')).toBe(0);

    db.deleteNotificationRule('rule-1');
    db.deleteNotificationChannel('channel-1');
    expect(db.listNotificationRules()).toHaveLength(0);
    expect(db.listNotificationChannels()).toHaveLength(0);

    db.close();
  });
});
