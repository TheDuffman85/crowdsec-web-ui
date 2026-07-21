import { describe, expect, test, vi } from 'vitest';
import type { LapiStatus } from '../../../shared/contracts';
import { createAlert, createDecision, createService, insertAlert, insertDecision } from './harness';

describe('notification delivery', () => {
  test('lists notifications with pagination metadata and supports bulk notification mutations', async () => {
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

    expect(await service.markNotificationsRead(['notif-1', 'notif-2'])).toBe(1);
    expect(await service.deleteNotification('notif-2')).toBe(true);
    expect(await service.deleteReadNotifications()).toBe(1);
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

    const channel = await service.createChannel({
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
      const channel = await service.createChannel({
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

      await service.createRule({
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

});
