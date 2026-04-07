import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  addDecision,
  bulkDeleteAlerts,
  bulkDeleteDecisions,
  cleanupByIp,
  createNotificationChannel,
  createNotificationRule,
  deleteNotificationChannel,
  deleteNotificationRule,
  deleteAlert,
  deleteDecision,
  fetchAlert,
  fetchAlerts,
  fetchAlertsPaginated,
  fetchAlertsForStats,
  fetchConfig,
  fetchDashboardStats,
  fetchDecisions,
  fetchDecisionsPaginated,
  fetchDecisionsForStats,
  fetchNotifications,
  fetchNotificationSettings,
  markAllNotificationsRead,
  markNotificationRead,
  testNotificationChannel,
  updateNotificationChannel,
  updateNotificationRule,
} from './api';

function mockFetch(handler: typeof fetch): void {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: handler,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api helpers', () => {
  test('fetch helpers return parsed JSON', async () => {
    mockFetch(
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
    await expect(fetchDashboardStats({ simulation: 'live' })).resolves.toEqual([{ id: 1 }]);
    await expect(fetchConfig()).resolves.toEqual([{ id: 1 }]);
    await expect(fetchNotificationSettings()).resolves.toEqual([{ id: 1 }]);
    await expect(fetchNotifications()).resolves.toEqual([{ id: 1 }]);
  });

  test('paginated helpers include only populated filters', async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
      Response.json({ items: [], total: 0 }),
    );
    mockFetch(fetchMock);

    await expect(fetchAlertsPaginated(2, 25, { scenario: 'ssh', country: '' })).resolves.toEqual({ items: [], total: 0 });
    await expect(fetchDecisionsPaginated(3, 10, { ip: '1.2.3.4', target: '' })).resolves.toEqual({ items: [], total: 0 });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/alerts?page=2&page_size=25&scenario=ssh');
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('country=');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/decisions?page=3&page_size=10&ip=1.2.3.4');
    expect(String(fetchMock.mock.calls[1]?.[0])).not.toContain('target=');
  });

  test('fetchDashboardStats handles empty filters and explicit request init', async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
      Response.json({ totals: {} }),
    );
    mockFetch(fetchMock);

    await expect(fetchDashboardStats()).resolves.toEqual({ totals: {} });
    await expect(fetchDashboardStats({ simulation: '' }, { signal: AbortSignal.abort() })).resolves.toEqual({ totals: {} });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/dashboard/stats');
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('?');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/dashboard/stats');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
  });
  test('deduplicates simultaneous GET helper requests', async () => {
    let resolveFetch: (response: Response) => void = () => {};
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    mockFetch(fetchMock);

    const firstRequest = fetchConfig();
    const secondRequest = fetchConfig();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(Response.json({ ok: true }));
    await expect(Promise.all([firstRequest, secondRequest])).resolves.toEqual([{ ok: true }, { ok: true }]);
  });

  test('fetchAlert handles direct payloads and empty array payloads', async () => {
    mockFetch(
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

  test('removes failed GET requests from the in-flight cache', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    mockFetch(fetchMock);

    await expect(fetchConfig()).rejects.toThrow('Failed to fetch config');
    await expect(fetchConfig()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('delete and add helpers surface permission metadata on 403', async () => {
    mockFetch(vi.fn(async () => new Response('{}', { status: 403 })));

    await expect(deleteAlert(1)).rejects.toMatchObject({
      message: 'Permission denied.',
      helpText: 'Trusted IPs for Delete Operations',
    });

    await expect(deleteDecision(1)).rejects.toMatchObject({
      message: 'Permission denied.',
    });

    await expect(bulkDeleteAlerts([1, 2])).rejects.toMatchObject({
      message: 'Permission denied.',
    });

    await expect(bulkDeleteDecisions([1, 2])).rejects.toMatchObject({
      message: 'Permission denied.',
    });

    await expect(cleanupByIp('1.2.3.4')).rejects.toMatchObject({
      message: 'Permission denied.',
    });

    await expect(addDecision({ ip: '1.2.3.4' })).rejects.toMatchObject({
      message: 'Permission denied.',
      helpText: 'Trusted IPs for Write Operations',
    });
  });

  test('handles generic fetch failures and 204 deletes', async () => {
    mockFetch(
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
    mockFetch(
      vi.fn(async (_input, init) => {
        if (init?.method === 'DELETE') {
          return Response.json({ message: 'Deleted' });
        }

        return Response.json({ message: 'Created' });
      }),
    );

    await expect(deleteAlert(1)).resolves.toEqual({ message: 'Deleted' });
    await expect(deleteDecision(1)).resolves.toEqual({ message: 'Deleted' });
    await expect(bulkDeleteAlerts([1, 2])).resolves.toEqual({ message: 'Created' });
    await expect(bulkDeleteDecisions([1, 2])).resolves.toEqual({ message: 'Created' });
    await expect(cleanupByIp('1.2.3.4')).resolves.toEqual({ message: 'Created' });
    await expect(addDecision({ ip: '1.2.3.4' })).resolves.toEqual({ message: 'Created' });
    await expect(createNotificationChannel({ name: 'ntfy', type: 'ntfy', enabled: true, config: {} })).resolves.toEqual({ message: 'Created' });
    await expect(updateNotificationChannel('1', { name: 'ntfy', type: 'ntfy', enabled: true, config: {} })).resolves.toEqual({ message: 'Created' });
    await expect(createNotificationRule({ name: 'rule', type: 'alert-threshold', enabled: true, severity: 'warning', channel_ids: [], config: { window_minutes: 60, alert_threshold: 10 } })).resolves.toEqual({ message: 'Created' });
    await expect(updateNotificationRule('1', { name: 'rule', type: 'alert-threshold', enabled: true, severity: 'warning', channel_ids: [], config: { window_minutes: 60, alert_threshold: 10 } })).resolves.toEqual({ message: 'Created' });
  });

  test('throws the provided message for non-403 mutation failures', async () => {
    mockFetch(vi.fn(async () => new Response('{}', { status: 500 })));
    await expect(deleteAlert(1)).rejects.toThrow('Failed to delete alert');
  });

  test('notification mutations handle void responses and API errors', async () => {
    mockFetch(
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

  test('notification mutations handle 204 responses and default API errors', async () => {
    mockFetch(
      vi.fn(async (input) => {
        if (String(input).includes('/api/notification-rules/invalid-json')) {
          return new Response('not-json', { status: 400 });
        }
        if (String(input).includes('/api/notifications/no-message/read')) {
          return Response.json({ error: '' }, { status: 400 });
        }
        return new Response(null, { status: 204 });
      }),
    );

    await expect(deleteNotificationChannel('1')).resolves.toBeUndefined();
    await expect(deleteNotificationRule('invalid-json')).rejects.toThrow('Failed to delete notification rule');
    await expect(markNotificationRead('no-message')).rejects.toThrow('Failed to mark notification as read');
  });
});
