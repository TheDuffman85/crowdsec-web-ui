import type {
  AddDecisionRequest,
  AlertRecord,
  ApiPermissionError,
  BulkDeleteRequest,
  BulkDeleteResult,
  CleanupByIpRequest,
  ConfigResponse,
  DashboardStatsResponse,
  DecisionListItem,
  NotificationChannel,
  NotificationListResponse,
  NotificationRule,
  NotificationSettingsResponse,
  PaginatedResponse,
  SlimAlert,
  StatsAlert,
  StatsDecision,
  UpsertNotificationChannelRequest,
  UpsertNotificationRuleRequest,
} from '../types';
import { apiUrl } from './basePath';

const inFlightGetRequests = new Map<string, Promise<unknown>>();

async function requestJson<T>(url: string, init: RequestInit | undefined, defaultMsg: string | undefined): Promise<T> {
    const response = await fetch(url, init);
    if (!response.ok) {
        throw new Error(defaultMsg || 'Request failed');
    }
    return response.json() as Promise<T>;
}

async function fetchJson<T>(input: string, init?: RequestInit, defaultMsg?: string): Promise<T> {
    const url = apiUrl(input);
    if (init === undefined) {
        const inFlightRequest = inFlightGetRequests.get(url);
        if (inFlightRequest) {
            return inFlightRequest as Promise<T>;
        }

        const request = requestJson<T>(url, init, defaultMsg).finally(() => {
            if (inFlightGetRequests.get(url) === request) {
                inFlightGetRequests.delete(url);
            }
        });
        inFlightGetRequests.set(url, request);
        return request;
    }

    return requestJson<T>(url, init, defaultMsg);
}

export async function fetchAlerts(): Promise<SlimAlert[]> {
    return fetchJson<SlimAlert[]>('/api/alerts', undefined, 'Failed to fetch alerts');
}

export async function fetchAlertsPaginated(
    page: number,
    pageSize = 50,
    filters?: Record<string, string>,
): Promise<PaginatedResponse<SlimAlert>> {
    const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    for (const [key, value] of Object.entries(filters ?? {})) {
        if (value) params.set(key, value);
    }
    return fetchJson<PaginatedResponse<SlimAlert>>(`/api/alerts?${params.toString()}`, undefined, 'Failed to fetch alerts');
}

export async function fetchAlert(id: string | number): Promise<AlertRecord> {
    const payload = await fetchJson<AlertRecord | AlertRecord[]>(`/api/alerts/${id}`, undefined, 'Failed to fetch alert');
    if (Array.isArray(payload)) {
        const alert = payload[0];
        if (!alert) {
            throw new Error('Failed to fetch alert');
        }
        return alert;
    }
    return payload;
}

export async function fetchDecisions(): Promise<DecisionListItem[]> {
    return fetchJson<DecisionListItem[]>('/api/decisions', undefined, 'Failed to fetch decisions');
}

export async function fetchDecisionsPaginated(
    page: number,
    pageSize = 50,
    filters?: Record<string, string>,
): Promise<PaginatedResponse<DecisionListItem>> {
    const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    for (const [key, value] of Object.entries(filters ?? {})) {
        if (value) params.set(key, value);
    }
    return fetchJson<PaginatedResponse<DecisionListItem>>(`/api/decisions?${params.toString()}`, undefined, 'Failed to fetch decisions');
}

// Helper to handle API errors with specific 403 guidance
function handleApiError(res: Response, defaultMsg: string, operationName = 'Delete Operations'): void {
    if (!res.ok) {
        if (res.status === 403) {
            const repoUrl = import.meta.env.VITE_REPO_URL || 'https://github.com/TheDuffman85/crowdsec-web-ui';
            const error = new Error('Permission denied.') as ApiPermissionError;
            error.helpLink = `${repoUrl}#trusted-ips-for-delete-operations-optional`;
            error.helpText = `Trusted IPs for ${operationName}`;
            throw error;
        }
        throw new Error(defaultMsg);
    }
}

export async function deleteAlert(id: string | number): Promise<unknown> {
  const res = await fetch(apiUrl(`/api/alerts/${id}`), { method: 'DELETE' });
  handleApiError(res, 'Failed to delete alert');
  if (res.status === 204) return null;
  return res.json();
}

async function postDestructiveJson<TResponse, TBody>(input: string, body: TBody, defaultMsg: string): Promise<TResponse> {
  const res = await fetch(apiUrl(input), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  handleApiError(res, defaultMsg);
  return res.json() as Promise<TResponse>;
}

export async function bulkDeleteAlerts(ids: BulkDeleteRequest['ids']): Promise<BulkDeleteResult> {
  return postDestructiveJson<BulkDeleteResult, BulkDeleteRequest>(
    '/api/alerts/bulk-delete',
    { ids },
    'Failed to delete selected alerts',
  );
}

export async function fetchDecisionsForStats(): Promise<StatsDecision[]> {
  return fetchJson<StatsDecision[]>('/api/stats/decisions', undefined, 'Failed to fetch decision statistics');
}

export async function fetchAlertsForStats(): Promise<StatsAlert[]> {
    return fetchJson<StatsAlert[]>('/api/stats/alerts', undefined, 'Failed to fetch alert statistics');
}

export async function fetchDashboardStats(
  filters?: Record<string, string>,
  init?: RequestInit,
): Promise<DashboardStatsResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return fetchJson<DashboardStatsResponse>(
    `/api/dashboard/stats${query ? `?${query}` : ''}`,
    init,
    'Failed to fetch dashboard statistics',
  );
}

export async function deleteDecision(id: string | number): Promise<unknown> {
  const res = await fetch(apiUrl(`/api/decisions/${id}`), { method: 'DELETE' });
  handleApiError(res, 'Failed to delete decision');
  if (res.status === 204) return null;
  return res.json();
}

export async function bulkDeleteDecisions(ids: BulkDeleteRequest['ids']): Promise<BulkDeleteResult> {
  return postDestructiveJson<BulkDeleteResult, BulkDeleteRequest>(
    '/api/decisions/bulk-delete',
    { ids },
    'Failed to delete selected decisions',
  );
}

export async function cleanupByIp(ip: CleanupByIpRequest['ip']): Promise<BulkDeleteResult> {
  return postDestructiveJson<BulkDeleteResult, CleanupByIpRequest>(
    '/api/cleanup/by-ip',
    { ip },
    'Failed to delete entries for this IP',
  );
}

export async function addDecision(data: AddDecisionRequest): Promise<unknown> {
    const res = await fetch(apiUrl('/api/decisions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    handleApiError(res, 'Failed to add decision', 'Write Operations');
    return res.json();
}

export async function fetchConfig(): Promise<ConfigResponse> {
    return fetchJson<ConfigResponse>('/api/config', undefined, 'Failed to fetch config');
}

async function sendJson<T>(input: string, init: RequestInit, defaultMsg: string): Promise<T> {
    const response = await fetch(apiUrl(input), init);
    if (!response.ok) {
        let errorMessage = defaultMsg;
        try {
            const payload = await response.json() as { error?: string };
            if (typeof payload.error === 'string' && payload.error) {
                errorMessage = payload.error;
            }
        } catch {
            // Ignore JSON parse issues and use the default message.
        }
        throw new Error(errorMessage);
    }

    if (response.status === 204) {
        return null as T;
    }

    return response.json() as Promise<T>;
}

export async function fetchNotificationSettings(): Promise<NotificationSettingsResponse> {
    return fetchJson<NotificationSettingsResponse>('/api/notifications/settings', undefined, 'Failed to fetch notification settings');
}

export async function fetchNotifications(limit = 100): Promise<NotificationListResponse> {
    return fetchNotificationsPaginated(1, limit);
}

export async function fetchNotificationsPaginated(
    page = 1,
    pageSize = 50,
): Promise<NotificationListResponse> {
    const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    return fetchJson<NotificationListResponse>(`/api/notifications?${params.toString()}`, undefined, 'Failed to fetch notifications');
}

export async function createNotificationChannel(data: UpsertNotificationChannelRequest): Promise<NotificationChannel> {
    return sendJson<NotificationChannel>('/api/notification-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    }, 'Failed to create notification channel');
}

export async function updateNotificationChannel(id: string, data: UpsertNotificationChannelRequest): Promise<NotificationChannel> {
    return sendJson<NotificationChannel>(`/api/notification-channels/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    }, 'Failed to update notification channel');
}

export async function deleteNotificationChannel(id: string): Promise<void> {
    await sendJson(`/api/notification-channels/${id}`, { method: 'DELETE' }, 'Failed to delete notification channel');
}

export async function testNotificationChannel(id: string): Promise<void> {
    await sendJson(`/api/notification-channels/${id}/test`, { method: 'POST' }, 'Failed to send test notification');
}

export async function createNotificationRule(data: UpsertNotificationRuleRequest): Promise<NotificationRule> {
    return sendJson<NotificationRule>('/api/notification-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    }, 'Failed to create notification rule');
}

export async function updateNotificationRule(id: string, data: UpsertNotificationRuleRequest): Promise<NotificationRule> {
    return sendJson<NotificationRule>(`/api/notification-rules/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    }, 'Failed to update notification rule');
}

export async function deleteNotificationRule(id: string): Promise<void> {
    await sendJson(`/api/notification-rules/${id}`, { method: 'DELETE' }, 'Failed to delete notification rule');
}

export async function markNotificationRead(id: string): Promise<void> {
    await sendJson(`/api/notifications/${id}/read`, { method: 'POST' }, 'Failed to mark notification as read');
}

export async function markNotificationsRead(ids: BulkDeleteRequest['ids']): Promise<void> {
    await sendJson('/api/notifications/bulk-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
    }, 'Failed to mark selected notifications as read');
}

export async function deleteNotification(id: string): Promise<void> {
    await sendJson(`/api/notifications/${id}`, { method: 'DELETE' }, 'Failed to delete notification');
}

export async function bulkDeleteNotifications(ids: BulkDeleteRequest['ids']): Promise<void> {
    await sendJson('/api/notifications/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
    }, 'Failed to delete selected notifications');
}

export async function deleteReadNotifications(): Promise<void> {
    await sendJson('/api/notifications/delete-read', { method: 'POST' }, 'Failed to delete read notifications');
}
