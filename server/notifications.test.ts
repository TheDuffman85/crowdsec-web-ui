import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import type { AlertDecision, AlertRecord, LapiStatus, UpdateCheckResponse } from '../shared/contracts';
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

function createDecision(id: string, createdAt: string, overrides: Partial<AlertDecision & Record<string, unknown>> = {}): AlertDecision & Record<string, unknown> {
  return {
    id,
    created_at: createdAt,
    stop_at: '2026-03-28T13:00:00.000Z',
    value: '1.2.3.4',
    type: 'ban',
    origin: 'crowdsec',
    scenario: 'crowdsecurity/ssh-bf',
    target: 'ssh',
    alert_id: 1,
    simulated: false,
    ...overrides,
  };
}

function insertDecision(database: CrowdsecDatabase, decision: AlertDecision & Record<string, unknown>): void {
  database.insertDecision({
    $id: String(decision.id),
    $uuid: String(decision.id),
    $alert_id: typeof decision.alert_id === 'string' || typeof decision.alert_id === 'number' ? decision.alert_id : 1,
    $created_at: String(decision.created_at || ''),
    $stop_at: String(decision.stop_at || ''),
    $value: typeof decision.value === 'string' ? decision.value : undefined,
    $type: typeof decision.type === 'string' ? decision.type : undefined,
    $origin: typeof decision.origin === 'string' ? decision.origin : undefined,
    $scenario: typeof decision.scenario === 'string' ? decision.scenario : undefined,
    $raw_data: JSON.stringify(decision),
  });
}

function createService(options: {
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  updateChecker?: () => Promise<UpdateCheckResponse>;
  getLapiStatus?: () => LapiStatus;
  debugPayloads?: boolean;
} = {}) {
  const database = createTestDatabase();
  const service = createNotificationService({
    database,
    fetchImpl: options.fetchImpl,
    updateChecker: options.updateChecker,
    getLapiStatus: options.getLapiStatus,
    outboundGuard: {
      assertHostAllowed: async () => {},
      assertUrlAllowed: async () => {},
    },
    secretStore: createNotificationSecretStore(),
    debugPayloads: options.debugPayloads,
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

  test('test webhooks render synthetic non-null rule fields', async () => {
    const sentBodies: string[] = [];
    const { database, service } = createService({
      fetchImpl: async (_input, init) => {
        sentBodies.push(String(init?.body || ''));
        return Response.json({ ok: true });
      },
    });

    const channel = service.createChannel({
      name: 'Fluxer webhook',
      type: 'webhook',
      enabled: true,
      config: {
        url: 'https://example.com/webhook',
        method: 'POST',
        body: {
          mode: 'json',
          template: '{"rule":{{event.rule_nameJson}},"rule_type":{{event.rule_typeJson}}}',
        },
        retryAttempts: 0,
      },
    });

    await service.testChannel(channel.id);

    expect(sentBodies).toHaveLength(1);
    expect(JSON.parse(sentBodies[0] || '{}')).toEqual({
      rule: 'Test notification',
      rule_type: 'test',
    });

    database.close();
  });

  test('failed webhook deliveries store response snippets and log debug payloads when enabled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { database, service } = createService({
      debugPayloads: true,
      fetchImpl: async () => new Response('{"error":"Rule must not be null"}', { status: 400 }),
    });

    try {
      const channel = service.createChannel({
        name: 'Fluxer webhook',
        type: 'webhook',
        enabled: true,
        config: {
          url: 'https://example.com/webhook',
          method: 'POST',
          body: {
            mode: 'json',
            template: '{"title":{{event.titleJson}},"rule":{{event.rule_nameJson}}}',
          },
          retryAttempts: 0,
        },
      });

      service.createRule({
        name: 'Threshold',
        type: 'alert-threshold',
        enabled: true,
        severity: 'warning',
        channel_ids: [channel.id],
        config: {
          window_minutes: 60,
          alert_threshold: 1,
          filters: {},
        },
      });
      insertAlert(database, createAlert(1, '2026-03-28T11:55:00.000Z'));

      await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));

      const notification = service.listNotifications().data[0];
      expect(notification?.deliveries[0]).toEqual(expect.objectContaining({
        status: 'failed',
        error: 'Webhook request failed with status 400: {"error":"Rule must not be null"}',
      }));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Notification delivery failed for rule "Threshold" (alert-threshold) to "Fluxer webhook" (webhook)'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('status=400'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('response="{\"error\":\"Rule must not be null\"}"'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('request_body="{\"title\":\"Threshold: threshold exceeded\",\"rule\":\"Threshold\"}"'));
    } finally {
      warn.mockRestore();
      database.close();
    }
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

  test('uses the explicit server language for notification content', async () => {
    const { database, service } = createService();
    database.setMeta('language', 'de');
    service.createRule({
      name: 'Schwelle',
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

    expect(service.listNotifications().data[0]).toEqual(expect.objectContaining({
      title: 'Schwelle: Schwellenwert überschritten',
      message: '1 Alarme wurden in den letzten 60 Minuten gefunden und überschreiten den Schwellenwert von 1.',
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

  test('IP ban rules notify once per active ban decision with decision metadata', async () => {
    const { database, service } = createService();
    const rule = service.createRule({
      name: 'Ban watch',
      type: 'ip-ban',
      enabled: true,
      severity: 'critical',
      channel_ids: [],
      config: {
        window_minutes: 60,
        filters: {},
      },
    });

    insertDecision(database, createDecision('decision-1', '2026-03-28T11:55:00.000Z', {
      value: '10.20.30.40',
      origin: 'manual',
      alert_id: 123,
    }));

    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));
    await service.evaluateRules(new Date('2026-03-28T12:05:00.000Z'));

    expect(service.listNotifications().data).toEqual([
      expect.objectContaining({
        rule_type: 'ip-ban',
        severity: 'critical',
        title: 'Ban watch: IP banned',
        message: '10.20.30.40 was banned by crowdsecurity/ssh-bf until 2026-03-28T13:00:00.000Z.',
        metadata: expect.objectContaining({
          decision_id: 'decision-1',
          value: '10.20.30.40',
          type: 'ban',
          origin: 'manual',
          scenario: 'crowdsecurity/ssh-bf',
          target: 'ssh',
          alert_id: 123,
          created_at: '2026-03-28T11:55:00.000Z',
          stop_at: '2026-03-28T13:00:00.000Z',
        }),
      }),
    ]);
    expect(database.listNotificationIncidentsByRule(rule.id)).toEqual([
      expect.objectContaining({
        incident_key: 'ip-ban:10.20.30.40:manual:crowdsecurity%2Fssh-bf:ssh',
        first_seen_at: '2026-03-28T11:55:00.000Z',
        resolved_at: null,
      }),
    ]);

    await service.evaluateRules(new Date('2026-03-28T13:01:00.000Z'));
    expect(database.listNotificationIncidentsByRule(rule.id)[0]).toEqual(expect.objectContaining({
      resolved_at: '2026-03-28T13:01:00.000Z',
    }));

    database.close();
  });

  test('IP ban rules do not refire when the same ban is resynced with volatile ids and timestamps', async () => {
    const { database, service } = createService();
    service.createRule({
      name: 'Stable bans',
      type: 'ip-ban',
      enabled: true,
      severity: 'warning',
      channel_ids: [],
      config: {
        window_minutes: 60,
        filters: {},
      },
    });

    insertDecision(database, createDecision('decision-a', '2026-03-28T11:55:00.000Z', {
      value: '1.2.3.4',
      stop_at: '2026-03-28T13:00:00.000Z',
    }));
    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));

    database.deleteDecision('decision-a');
    insertDecision(database, createDecision('decision-b', '2026-03-28T11:56:00.000Z', {
      value: '1.2.3.4',
      stop_at: '2026-03-28T13:01:00.000Z',
    }));
    await service.evaluateRules(new Date('2026-03-28T12:05:00.000Z'));

    expect(service.listNotifications().data).toHaveLength(1);

    database.close();
  });

  test('IP ban rules collapse duplicate active decisions in the same evaluation', async () => {
    const { database, service } = createService();
    service.createRule({
      name: 'Duplicate bans',
      type: 'ip-ban',
      enabled: true,
      severity: 'warning',
      channel_ids: [],
      config: {
        window_minutes: 60,
        filters: {},
      },
    });

    insertDecision(database, createDecision('decision-a', '2026-03-28T11:55:00.000Z', {
      value: '3.4.5.6',
      stop_at: '2026-03-28T13:00:00.000Z',
    }));
    insertDecision(database, createDecision('decision-b', '2026-03-28T11:56:00.000Z', {
      value: '3.4.5.6',
      stop_at: '2026-03-28T13:01:00.000Z',
    }));

    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));

    expect(service.listNotifications().data).toHaveLength(1);

    database.close();
  });

  test('IP ban rules resolve when an active decision is deleted from the cache', async () => {
    const { database, service } = createService();
    const rule = service.createRule({
      name: 'Deleted bans',
      type: 'ip-ban',
      enabled: true,
      severity: 'warning',
      channel_ids: [],
      config: {
        window_minutes: 60,
        filters: {},
      },
    });

    insertDecision(database, createDecision('decision-a', '2026-03-28T11:55:00.000Z', {
      value: '2.3.4.5',
      stop_at: '2026-03-28T13:00:00.000Z',
    }));
    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));

    database.deleteDecision('decision-a');
    await service.evaluateRules(new Date('2026-03-28T12:05:00.000Z'));

    expect(database.listNotificationIncidentsByRule(rule.id)[0]).toEqual(expect.objectContaining({
      incident_key: 'ip-ban:2.3.4.5:crowdsec:crowdsecurity%2Fssh-bf:ssh',
      resolved_at: '2026-03-28T12:05:00.000Z',
    }));

    database.close();
  });

  test('IP ban rules respect window, decision type, simulation, scenario, target, exact IP, and CIDR filters', async () => {
    const { database, service } = createService();
    service.createRule({
      name: 'Filtered bans',
      type: 'ip-ban',
      enabled: true,
      severity: 'warning',
      channel_ids: [],
      config: {
        window_minutes: 30,
        filters: {
          scenario: 'ssh',
          target: 'ssh',
          include_simulated: true,
          values: ['203.0.113.10', '10.0.0.0/24', '2001:db8::/32'],
        },
      },
    });

    insertDecision(database, createDecision('exact', '2026-03-28T11:50:00.000Z', { value: '203.0.113.10' }));
    insertDecision(database, createDecision('cidr-v4', '2026-03-28T11:51:00.000Z', { value: '10.0.0.42' }));
    insertDecision(database, createDecision('cidr-v6', '2026-03-28T11:52:00.000Z', { value: '2001:db8::42', simulated: true }));
    insertDecision(database, createDecision('captcha', '2026-03-28T11:53:00.000Z', { value: '10.0.0.43', type: 'captcha' }));
    insertDecision(database, createDecision('outside-cidr', '2026-03-28T11:54:00.000Z', { value: '10.0.1.42' }));
    insertDecision(database, createDecision('wrong-scenario', '2026-03-28T11:55:00.000Z', { value: '10.0.0.44', scenario: 'crowdsecurity/http-probing' }));
    insertDecision(database, createDecision('wrong-target', '2026-03-28T11:56:00.000Z', { value: '10.0.0.45', target: 'http' }));
    insertDecision(database, createDecision('old-ban', '2026-03-28T11:20:00.000Z', { value: '10.0.0.46' }));

    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));

    expect(service.listNotifications().data.map((notification) => notification.metadata.decision_id).sort()).toEqual([
      'cidr-v4',
      'cidr-v6',
      'exact',
    ]);

    database.close();
  });

  test('new alert or decision rules notify once per matching record with event details', async () => {
    const { database, service } = createService();
    service.createRule({
      name: 'New security activity',
      type: 'new-alert-decision',
      enabled: true,
      severity: 'info',
      channel_ids: [],
      config: {
        window_minutes: 5,
        event_type: 'both',
        filters: {
          scenario: 'ssh',
          target: 'ssh',
          values: ['10.0.0.0/24'],
        },
      },
    });

    insertAlert(database, createAlert(10, '2026-03-28T11:58:00.000Z', {
      source: { ip: '10.0.0.10' },
      events_count: 4,
      machine_alias: 'gateway',
    }));
    insertAlert(database, createAlert(11, '2026-03-28T11:59:00.000Z', {
      source: { ip: '192.0.2.10' },
    }));
    insertDecision(database, createDecision('decision-10', '2026-03-28T11:59:00.000Z', {
      value: '10.0.0.20',
    }));
    insertDecision(database, createDecision('decision-simulated', '2026-03-28T11:59:30.000Z', {
      value: '10.0.0.21',
      simulated: true,
    }));

    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));
    await service.evaluateRules(new Date('2026-03-28T12:01:00.000Z'));

    const notifications = service.listNotifications().data;
    expect(notifications).toHaveLength(2);
    expect(notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule_type: 'new-alert-decision',
        title: 'New security activity: new alert',
        message: expect.stringContaining('Alert #10'),
        metadata: expect.objectContaining({
          event_type: 'alert',
          alert_id: '10',
          source: '10.0.0.10',
          machine: 'gateway',
          events_count: 4,
        }),
      }),
      expect.objectContaining({
        rule_type: 'new-alert-decision',
        title: 'New security activity: new decision',
        message: expect.stringContaining('Decision #decision-10'),
        metadata: expect.objectContaining({
          event_type: 'decision',
          decision_id: 'decision-10',
          value: '10.0.0.20',
          type: 'ban',
        }),
      }),
    ]));

    for (const eventType of ['alert', 'decision'] as const) {
      service.createRule({
        name: `${eventType}-only`,
        type: 'new-alert-decision',
        enabled: true,
        severity: 'info',
        channel_ids: [],
        config: {
          window_minutes: 5,
          event_type: eventType,
          filters: { values: ['10.0.0.0/24'] },
        },
      });
    }

    await service.evaluateRules(new Date('2026-03-28T12:02:00.000Z'));
    expect(service.listNotifications().data.filter((item) => item.rule_name === 'alert-only')).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ event_type: 'alert' }) }),
    ]);
    expect(service.listNotifications().data.filter((item) => item.rule_name === 'decision-only')).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ event_type: 'decision' }) }),
    ]);

    database.close();
  });

  test('IP ban rules reject invalid IP and range filter values', () => {
    const { database, service } = createService();

    expect(() => service.createRule({
      name: 'Invalid bans',
      type: 'ip-ban',
      enabled: true,
      severity: 'warning',
      channel_ids: [],
      config: {
        window_minutes: 60,
        filters: {
          values: ['not-an-ip'],
        },
      },
    })).toThrow('Invalid IP/range filter value: not-an-ip');

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

  test('lapi availability rules wait for the threshold, dedupe outages, and resolve silently by default', async () => {
    let lapiStatus: LapiStatus = {
      isConnected: false,
      lastCheck: '2026-03-28T12:00:00.000Z',
      lastError: 'Connection refused',
      offline_since: '2026-03-28T11:59:10.000Z',
    };
    const { database, service } = createService({
      getLapiStatus: () => lapiStatus,
    });

    const rule = service.createRule({
      name: 'LAPI health',
      type: 'lapi-availability',
      enabled: true,
      severity: 'critical',
      channel_ids: [],
      config: {
        outage_threshold_seconds: 60,
        notify_on_recovery: false,
      },
    });

    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));
    expect(service.listNotifications().data).toHaveLength(0);

    lapiStatus = {
      ...lapiStatus,
      lastCheck: '2026-03-28T12:00:10.000Z',
    };
    await service.evaluateRules(new Date('2026-03-28T12:00:10.000Z'));
    expect(service.listNotifications().data).toEqual([
      expect.objectContaining({
        rule_type: 'lapi-availability',
        severity: 'critical',
        title: 'LAPI health: LAPI unavailable',
        metadata: expect.objectContaining({
          offline_since: '2026-03-28T11:59:10.000Z',
          last_error: 'Connection refused',
          outage_threshold_seconds: 60,
          outage_duration_seconds: 60,
        }),
      }),
    ]);
    expect(database.listNotificationIncidentsByRule(rule.id)).toEqual([
      expect.objectContaining({
        incident_key: 'lapi-availability:offline',
        first_seen_at: '2026-03-28T11:59:10.000Z',
        resolved_at: null,
      }),
    ]);

    lapiStatus = {
      ...lapiStatus,
      lastCheck: '2026-03-28T12:01:10.000Z',
    };
    await service.evaluateRules(new Date('2026-03-28T12:01:10.000Z'));
    expect(service.listNotifications().data).toHaveLength(1);

    lapiStatus = {
      isConnected: true,
      lastCheck: '2026-03-28T12:01:20.000Z',
      lastError: null,
      offline_since: null,
    };
    await service.evaluateRules(new Date('2026-03-28T12:01:20.000Z'));
    expect(service.listNotifications().data).toHaveLength(1);
    expect(database.listNotificationIncidentsByRule(rule.id)).toEqual([
      expect.objectContaining({
        incident_key: 'lapi-availability:offline',
        resolved_at: '2026-03-28T12:01:20.000Z',
      }),
    ]);

    lapiStatus = {
      isConnected: false,
      lastCheck: '2026-03-28T12:05:10.000Z',
      lastError: 'Connection refused',
      offline_since: '2026-03-28T12:04:00.000Z',
    };
    await service.evaluateRules(new Date('2026-03-28T12:05:10.000Z'));
    expect(service.listNotifications().data).toHaveLength(2);
    expect(service.listNotifications().data[0]).toEqual(expect.objectContaining({
      rule_type: 'lapi-availability',
      title: 'LAPI health: LAPI unavailable',
      metadata: expect.objectContaining({
        offline_since: '2026-03-28T12:04:00.000Z',
        outage_duration_seconds: 70,
      }),
    }));

    database.close();
  });

  test('lapi availability rules emit a single info recovery notification when enabled', async () => {
    let lapiStatus: LapiStatus = {
      isConnected: false,
      lastCheck: '2026-03-28T12:10:00.000Z',
      lastError: 'timeout',
      offline_since: '2026-03-28T12:08:30.000Z',
    };
    const { database, service } = createService({
      getLapiStatus: () => lapiStatus,
    });

    service.createRule({
      name: 'LAPI health',
      type: 'lapi-availability',
      enabled: true,
      severity: 'critical',
      channel_ids: [],
      config: {
        outage_threshold_seconds: 60,
        notify_on_recovery: true,
      },
    });

    await service.evaluateRules(new Date('2026-03-28T12:10:00.000Z'));

    lapiStatus = {
      isConnected: true,
      lastCheck: '2026-03-28T12:11:00.000Z',
      lastError: null,
      offline_since: null,
    };
    await service.evaluateRules(new Date('2026-03-28T12:11:00.000Z'));
    await service.evaluateRules(new Date('2026-03-28T12:11:30.000Z'));

    expect(service.listNotifications().data).toHaveLength(2);
    expect(service.listNotifications().data[0]).toEqual(expect.objectContaining({
      rule_type: 'lapi-availability',
      severity: 'info',
      title: 'LAPI health: LAPI recovered',
      metadata: expect.objectContaining({
        offline_since: '2026-03-28T12:08:30.000Z',
        recovered_at: '2026-03-28T12:11:00.000Z',
        outage_duration_seconds: 150,
      }),
    }));
    expect(service.listNotifications().data[1]).toEqual(expect.objectContaining({
      severity: 'critical',
      title: 'LAPI health: LAPI unavailable',
    }));

    database.close();
  });
});
