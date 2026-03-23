import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  addDecision,
  createNotificationChannel,
  createNotificationRule,
  deleteNotificationChannel,
  deleteNotificationRule,
  deleteAlert,
  deleteDecision,
  fetchAlert,
  fetchAlerts,
  fetchAlertsForStats,
  fetchConfig,
  fetchDecisions,
  fetchDecisionsForStats,
  fetchNotifications,
  fetchNotificationSettings,
  markAllNotificationsRead,
  markNotificationRead,
  testNotificationChannel,
  updateNotificationChannel,
  updateNotificationRule,
} from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api helpers', () => {
  test('fetch helpers return parsed JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        if (String(input).endsWith('/api/alerts/1')) {
          return Response.json([{ id: 1 }]);
        }

        return Response.json([{ id: 1 }]);
      }),
    );

    await expect(fetchAlerts()).resolves.toEqual([{ id: 1 }]);
    await expect(fetchAlert(1)).resolves.toEqual({ id: 1 });
    await expect(fetchDecisions()).resolves.toEqual([{ id: 1 }]);
    await expect(fetchAlertsForStats()).resolves.toEqual([{ id: 1 }]);
    await expect(fetchDecisionsForStats()).resolves.toEqual([{ id: 1 }]);
    await expect(fetchConfig()).resolves.toEqual([{ id: 1 }]);
    await expect(fetchNotificationSettings()).resolves.toEqual([{ id: 1 }]);
    await expect(fetchNotifications()).resolves.toEqual([{ id: 1 }]);
  });

  test('fetchAlert handles direct payloads and empty array payloads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        if (String(input).endsWith('/api/alerts/direct')) {
          return Response.json({ id: 'direct' });
        }

        return Response.json([]);
      }),
    );

    await expect(fetchAlert('direct')).resolves.toEqual({ id: 'direct' });
    await expect(fetchAlert('empty')).rejects.toThrow('Failed to fetch alert');
  });

  test('delete and add helpers surface permission metadata on 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })));

    await expect(deleteAlert(1)).rejects.toMatchObject({
      message: 'Permission denied.',
      helpText: 'Trusted IPs for Delete Operations',
    });

    await expect(deleteDecision(1)).rejects.toMatchObject({
      message: 'Permission denied.',
    });

    await expect(addDecision({ ip: '1.2.3.4' })).rejects.toMatchObject({
      message: 'Permission denied.',
      helpText: 'Trusted IPs for Write Operations',
    });
  });

  test('handles generic fetch failures and 204 deletes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input, init) => {
        if (init?.method === 'DELETE') {
          return new Response(null, { status: 204 });
        }
        return new Response('{}', { status: 500 });
      }),
    );

    await expect(deleteAlert(1)).resolves.toBeNull();
    await expect(deleteDecision(1)).resolves.toBeNull();
    await expect(fetchAlerts()).rejects.toThrow('Failed to fetch alerts');
  });

  test('returns JSON payloads for successful mutations', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input, init) => {
        if (init?.method === 'DELETE') {
          return Response.json({ message: 'Deleted' });
        }

        return Response.json({ message: 'Created' });
      }),
    );

    await expect(deleteAlert(1)).resolves.toEqual({ message: 'Deleted' });
    await expect(deleteDecision(1)).resolves.toEqual({ message: 'Deleted' });
    await expect(addDecision({ ip: '1.2.3.4' })).resolves.toEqual({ message: 'Created' });
    await expect(createNotificationChannel({ name: 'ntfy', type: 'ntfy', enabled: true, config: {} })).resolves.toEqual({ message: 'Created' });
    await expect(updateNotificationChannel('1', { name: 'ntfy', type: 'ntfy', enabled: true, config: {} })).resolves.toEqual({ message: 'Created' });
    await expect(createNotificationRule({ name: 'rule', type: 'alert-threshold', enabled: true, severity: 'warning', cooldown_minutes: 60, channel_ids: [], config: { window_minutes: 60, alert_threshold: 10 } })).resolves.toEqual({ message: 'Created' });
    await expect(updateNotificationRule('1', { name: 'rule', type: 'alert-threshold', enabled: true, severity: 'warning', cooldown_minutes: 60, channel_ids: [], config: { window_minutes: 60, alert_threshold: 10 } })).resolves.toEqual({ message: 'Created' });
  });

  test('throws the provided message for non-403 mutation failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    await expect(deleteAlert(1)).rejects.toThrow('Failed to delete alert');
  });

  test('notification mutations handle void responses and API errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        if (String(input).includes('/api/notification-channels/boom')) {
          return Response.json({ error: 'boom' }, { status: 400 });
        }
        return Response.json({ success: true });
      }),
    );

    await expect(testNotificationChannel('1')).resolves.toBeUndefined();
    await expect(deleteNotificationChannel('1')).resolves.toBeUndefined();
    await expect(deleteNotificationRule('1')).resolves.toBeUndefined();
    await expect(markNotificationRead('1')).resolves.toBeUndefined();
    await expect(markAllNotificationsRead()).resolves.toBeUndefined();
    await expect(testNotificationChannel('boom')).rejects.toThrow('boom');
  });
});
