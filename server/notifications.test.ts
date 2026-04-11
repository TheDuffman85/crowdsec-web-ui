import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import type { AlertRecord, UpdateCheckResponse } from '../shared/contracts';
import { CrowdsecDatabase } from './database';
import { createNotificationService } from './notifications';
import { createNotificationSecretStore } from './notifications/secret-store';

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
  const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-notifications-'));
  tempDirs.push(dir);
  return new CrowdsecDatabase({ dbPath: path.join(dir, 'test.db') });
}

function createAlert(id: number, createdAt: string, overrides: Partial<AlertRecord> = {}): AlertRecord {
  return {
    id,
    uuid: `alert-${id}`,
    created_at: createdAt,
    scenario: 'crowdsecurity/ssh-bf',
    message: 'Blocked ssh bruteforce',
    source: {
      ip: '1.2.3.4',
      value: '1.2.3.4',
    },
    target: 'ssh',
    events: [],
    decisions: [],
    simulated: false,
    ...overrides,
  };
}

function insertAlert(database: CrowdsecDatabase, alert: AlertRecord): void {
  database.insertAlert({
    $id: alert.id,
    $uuid: alert.uuid || `alert-${alert.id}`,
    $created_at: alert.created_at,
    $scenario: alert.scenario,
    $source_ip: alert.source?.ip || alert.source?.value || '',
    $message: alert.message || '',
    $raw_data: JSON.stringify(alert),
  });
}

function createService(options: {
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  updateChecker?: () => Promise<UpdateCheckResponse>;
} = {}) {
  const database = createTestDatabase();
  const service = createNotificationService({
    database,
    fetchImpl: options.fetchImpl,
    updateChecker: options.updateChecker,
    outboundGuard: {
      assertHostAllowed: async () => {},
      assertUrlAllowed: async () => {},
    },
    secretStore: createNotificationSecretStore(),
  });

  return { database, service };
}

describe('notification incident deduplication', () => {
  test('lists notifications with pagination metadata and supports bulk notification mutations', () => {
    const { database, service } = createService();

    database.insertNotification({
      $id: 'notif-1',
      $created_at: '2026-03-28T12:00:00.000Z',
      $updated_at: '2026-03-28T12:00:00.000Z',
      $rule_id: 'rule-1',
      $rule_name: 'Threshold',
      $rule_type: 'alert-threshold',
      $severity: 'warning',
      $title: 'Threshold breached',
      $message: 'Alert volume is elevated',
      $read_at: null,
      $metadata_json: JSON.stringify({}),
      $deliveries_json: JSON.stringify([]),
      $dedupe_key: 'notif-1',
    });
    database.insertNotification({
      $id: 'notif-2',
      $created_at: '2026-03-28T12:05:00.000Z',
      $updated_at: '2026-03-28T12:05:00.000Z',
      $rule_id: 'rule-1',
      $rule_name: 'Threshold',
      $rule_type: 'alert-threshold',
      $severity: 'info',
      $title: 'Read notification',
      $message: 'Already handled',
      $read_at: '2026-03-28T12:06:00.000Z',
      $metadata_json: JSON.stringify({}),
      $deliveries_json: JSON.stringify([]),
      $dedupe_key: 'notif-2',
    });

    expect(service.listNotifications(1, 1)).toEqual(expect.objectContaining({
      data: [expect.objectContaining({ id: 'notif-2' })],
      pagination: expect.objectContaining({ page: 1, page_size: 1, total: 2, total_pages: 2 }),
      selectable_ids: ['notif-2', 'notif-1'],
      unread_count: 1,
    }));

    expect(service.markNotificationsRead(['notif-1', 'notif-2'])).toBe(1);
    expect(service.deleteNotification('notif-2')).toBe(true);
    expect(service.deleteReadNotifications()).toBe(1);
    expect(service.listNotifications().data).toEqual([]);

    database.close();
  });

  test('threshold rules fire once while active, resolve, and fire again after re-breach', async () => {
    const { database, service } = createService();
    const rule = service.createRule({
      name: 'Threshold',
      type: 'alert-threshold',
      enabled: true,
      severity: 'warning',
      channel_ids: [],
      config: {
        window_minutes: 60,
        alert_threshold: 1,
        filters: {},
      },
    });

    insertAlert(database, createAlert(1, '2026-03-28T11:55:00.000Z'));

    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));
    expect(service.listNotifications().data).toHaveLength(1);
    expect(database.listNotificationIncidentsByRule(rule.id)).toEqual([
      expect.objectContaining({
        incident_key: 'threshold:active',
        resolved_at: null,
      }),
    ]);

    await service.evaluateRules(new Date('2026-03-28T12:30:00.000Z'));
    expect(service.listNotifications().data).toHaveLength(1);

    await service.evaluateRules(new Date('2026-03-28T14:00:00.000Z'));
    expect(database.listNotificationIncidentsByRule(rule.id)[0]).toEqual(expect.objectContaining({
      incident_key: 'threshold:active',
      resolved_at: '2026-03-28T14:00:00.000Z',
    }));

    insertAlert(database, createAlert(2, '2026-03-28T14:05:00.000Z'));
    await service.evaluateRules(new Date('2026-03-28T14:06:00.000Z'));

    expect(service.listNotifications().data).toHaveLength(2);
    expect(database.listNotificationIncidentsByRule(rule.id)[0]).toEqual(expect.objectContaining({
      incident_key: 'threshold:active',
      first_seen_at: '2026-03-28T14:06:00.000Z',
      resolved_at: null,
    }));

    database.close();
  });

  test('spike rules stay deduplicated while active, then fire again after clearing', async () => {
    const { database, service } = createService();
    const rule = service.createRule({
      name: 'Spike',
      type: 'alert-spike',
      enabled: true,
      severity: 'critical',
      channel_ids: [],
      config: {
        window_minutes: 60,
        percent_increase: 100,
        minimum_current_alerts: 2,
        filters: {},
      },
    });

    insertAlert(database, createAlert(1, '2026-03-28T10:30:00.000Z'));
    insertAlert(database, createAlert(2, '2026-03-28T11:10:00.000Z'));
    insertAlert(database, createAlert(3, '2026-03-28T11:20:00.000Z'));
    insertAlert(database, createAlert(4, '2026-03-28T11:30:00.000Z'));

    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));
    await service.evaluateRules(new Date('2026-03-28T12:05:00.000Z'));
    expect(service.listNotifications().data).toHaveLength(1);

    await service.evaluateRules(new Date('2026-03-28T14:30:00.000Z'));
    expect(database.listNotificationIncidentsByRule(rule.id)[0]).toEqual(expect.objectContaining({
      incident_key: 'spike:active',
      resolved_at: '2026-03-28T14:30:00.000Z',
    }));

    insertAlert(database, createAlert(5, '2026-03-28T15:10:00.000Z'));
    insertAlert(database, createAlert(6, '2026-03-28T16:10:00.000Z'));
    insertAlert(database, createAlert(7, '2026-03-28T16:20:00.000Z'));
    insertAlert(database, createAlert(8, '2026-03-28T16:30:00.000Z'));

    await service.evaluateRules(new Date('2026-03-28T17:00:00.000Z'));
    expect(service.listNotifications().data).toHaveLength(2);

    database.close();
  });

  test('new CVE rules create one incident per CVE and do not re-fire while still active', async () => {
    const publishedAt: Record<string, string> = {
      'CVE-2026-1111': '2026-03-20T00:00:00.000Z',
      'CVE-2026-2222': '2026-03-22T00:00:00.000Z',
    };
    const { database, service } = createService({
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        const cveId = url.searchParams.get('cveId') || '';
        return Response.json({
          vulnerabilities: [
            {
              cve: {
                published: publishedAt[cveId],
              },
            },
          ],
        });
      },
    });

    const rule = service.createRule({
      name: 'Recent CVEs',
      type: 'new-cve',
      enabled: true,
      severity: 'warning',
      channel_ids: [],
      config: {
        max_cve_age_days: 30,
        filters: {},
      },
    });

    insertAlert(database, createAlert(1, '2026-03-28T10:00:00.000Z', { message: 'Matched CVE-2026-1111' }));
    insertAlert(database, createAlert(2, '2026-03-28T10:05:00.000Z', { message: 'Matched CVE-2026-2222' }));

    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));
    expect(service.listNotifications().data).toHaveLength(2);
    expect(database.listNotificationIncidentsByRule(rule.id)).toEqual([
      expect.objectContaining({ incident_key: 'cve:CVE-2026-1111', resolved_at: null }),
      expect.objectContaining({ incident_key: 'cve:CVE-2026-2222', resolved_at: null }),
    ]);

    await service.evaluateRules(new Date('2026-03-28T13:00:00.000Z'));
    expect(service.listNotifications().data).toHaveLength(2);

    database.close();
  });

  test('application update rules do not re-fire for the same version and create a new incident for a newer version', async () => {
    let remoteVersion = '2.0.0';
    const { database, service } = createService({
      updateChecker: async () => ({
        update_available: true,
        local_version: '1.0.0',
        remote_version: remoteVersion,
      }),
    });

    const rule = service.createRule({
      name: 'App updates',
      type: 'application-update',
      enabled: true,
      severity: 'info',
      channel_ids: [],
      config: {},
    });

    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));
    await service.evaluateRules(new Date('2026-03-28T12:30:00.000Z'));
    expect(service.listNotifications().data).toHaveLength(1);
    expect(database.listNotificationIncidentsByRule(rule.id)).toEqual([
      expect.objectContaining({ incident_key: 'application-update:2.0.0', resolved_at: null }),
    ]);

    remoteVersion = '2.1.0';
    await service.evaluateRules(new Date('2026-03-28T13:00:00.000Z'));
    expect(service.listNotifications().data).toHaveLength(2);
    expect(database.listNotificationIncidentsByRule(rule.id)).toEqual([
      expect.objectContaining({ incident_key: 'application-update:2.0.0', resolved_at: '2026-03-28T13:00:00.000Z' }),
      expect.objectContaining({ incident_key: 'application-update:2.1.0', resolved_at: null }),
    ]);

    database.close();
  });
});
