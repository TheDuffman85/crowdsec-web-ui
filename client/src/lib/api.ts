import type {
  AddDecisionRequest,
  AlertRecord,
  ApiPermissionError,
  BulkDeleteRequest,
  BulkDeleteResult,
  CleanupByIpRequest,
  ConfigResponse,
  CrowdsecMetricsResponse,
  DashboardStatsResponse,
  DecisionListItem,
  FacetField,
  FacetResponse,
  InstanceEntityRef,
  MultiInstanceOperationResponse,
  NotificationChannel,
  NotificationListResponse,
  NotificationRule,
  NotificationSettingsResponse,
  PaginatedResponse,
  SlimAlert,
  StatsAlert,
  StatsDecision,
  UpdateMetricsSidebarPreferenceRequest,
  UpdateManualRefreshSettingRequest,
  UpsertNotificationChannelRequest,
  UpsertNotificationRuleRequest,
} from '../types';
import { apiUrl } from './basePath';

const inFlightGetRequests = new Map<string, Promise<unknown>>();
const recentGetResponses = new Map<string, { expiresAt: number; value: unknown }>();
let activeFetchImplementation: typeof fetch | null = null;
const RECENT_GET_CACHE_MS = 500;

function resetRequestCachesIfFetchChanged(): void {
    if (activeFetchImplementation === globalThis.fetch) {
        return;
    }
    activeFetchImplementation = globalThis.fetch;
    inFlightGetRequests.clear();
    recentGetResponses.clear();
}

function clearGetCaches(): void {
    inFlightGetRequests.clear();
    recentGetResponses.clear();
}

async function requestJson<T>(url: string, init: RequestInit | undefined, defaultMsg: string | undefined): Promise<T> {
    const response = await fetch(url, init);
    if (!response.ok) {
        throw new Error(defaultMsg || 'Request failed');
    }
    return response.json() as Promise<T>;
}

async function fetchJson<T>(input: string, init?: RequestInit, defaultMsg?: string): Promise<T> {
    resetRequestCachesIfFetchChanged();
    const url = apiUrl(input);
    if (init === undefined) {
        const recentResponse = recentGetResponses.get(url);
        if (recentResponse && recentResponse.expiresAt > Date.now()) {
            return recentResponse.value as T;
        }
        if (recentResponse) {
            recentGetResponses.delete(url);
        }

        const inFlightRequest = inFlightGetRequests.get(url);
        if (inFlightRequest) {
            return inFlightRequest as Promise<T>;
        }

        const request = requestJson<T>(url, init, defaultMsg).then((value) => {
            recentGetResponses.set(url, {
                expiresAt: Date.now() + RECENT_GET_CACHE_MS,
                value,
            });
            return value;
        }).finally(() => {
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
    const params = new URLSearchParams({
        page: String(page),
        page_size: String(pageSize),
        include_decisions: 'false',
    });
    for (const [key, value] of Object.entries(filters ?? {})) {
        if (value) params.set(key, value);
    }
    return fetchJson<PaginatedResponse<SlimAlert>>(`/api/alerts?${params.toString()}`, undefined, 'Failed to fetch alerts');
}

export async function fetchAlert(id: string | number, instanceId?: string): Promise<AlertRecord> {
    const path = instanceId
        ? `/api/instances/${encodeURIComponent(instanceId)}/alerts/${encodeURIComponent(String(id))}`
        : `/api/alerts/${encodeURIComponent(String(id))}?include_decisions=false`;
    const payload = await fetchJson<AlertRecord | AlertRecord[]>(path, undefined, 'Failed to fetch alert');
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

export async function fetchFacet(
    page: 'alerts' | 'decisions',
    field: FacetField,
    filters?: Record<string, string>,
    options: { search?: string; offset?: number; limit?: number; signal?: AbortSignal } = {},
): Promise<FacetResponse> {
    const params = new URLSearchParams({
        field,
        offset: String(options.offset ?? 0),
        limit: String(options.limit ?? 10),
    });
    if (options.search) params.set('search', options.search);
    for (const [key, value] of Object.entries(filters ?? {})) {
        if (value) params.set(key, value);
    }
    return fetchJson<FacetResponse>(
        `/api/${page}/facets?${params.toString()}`,
        { signal: options.signal },
        `Failed to fetch ${page} facets`,
    );
}

async function parseErrorPayload(res: Response): Promise<{ error?: string; code?: string }> {
    try {
        return await res.clone().json() as { error?: string; code?: string };
    } catch {
        return {};
    }
}

// Helper to handle API errors with specific 403 guidance
async function handleApiError(res: Response, defaultMsg: string, operationName = 'Delete Operations'): Promise<void> {
    if (!res.ok) {
        if (res.status === 403) {
            const payload = await parseErrorPayload(res);
            if (payload.code === 'READ_ONLY') {
                throw new Error(payload.error || 'Read-only mode is enabled');
            }

            const repoUrl = import.meta.env.VITE_REPO_URL || 'https://github.com/TheDuffman85/crowdsec-web-ui';
            const error = new Error('Permission denied.') as ApiPermissionError;
            error.helpLink = `${repoUrl}#trusted-ips-for-delete-operations-optional`;
            error.helpText = `Trusted IPs for ${operationName}`;
            throw error;
        }
        throw new Error(defaultMsg);
    }
}

export async function deleteAlert(id: string | number, instanceId?: string): Promise<BulkDeleteResult | null> {
  const path = instanceId
    ? `/api/instances/${encodeURIComponent(instanceId)}/alerts/${encodeURIComponent(String(id))}`
    : `/api/alerts/${encodeURIComponent(String(id))}`;
  const res = await fetch(apiUrl(path), { method: 'DELETE' });
  await handleApiError(res, 'Failed to delete alert');
  clearGetCaches();
  if (res.status === 204) return null;
  return res.json() as Promise<BulkDeleteResult>;
}

async function postDestructiveJson<TResponse, TBody>(input: string, body: TBody, defaultMsg: string): Promise<TResponse> {
  const res = await fetch(apiUrl(input), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await handleApiError(res, defaultMsg);
  const payload = await res.json() as TResponse;
  clearGetCaches();
  return payload;
}

export async function bulkDeleteAlerts(refsOrIds: InstanceEntityRef[] | Array<string | number>): Promise<BulkDeleteResult> {
  const usesRefs = typeof refsOrIds[0] === 'object';
  return postDestructiveJson<BulkDeleteResult, BulkDeleteRequest>(
    '/api/alerts/bulk-delete',
    usesRefs ? { refs: refsOrIds as InstanceEntityRef[] } : { ids: refsOrIds as Array<string | number> },
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

export async function deleteDecision(id: string | number, instanceId?: string): Promise<unknown> {
  const path = instanceId
    ? `/api/instances/${encodeURIComponent(instanceId)}/decisions/${encodeURIComponent(String(id))}`
    : `/api/decisions/${encodeURIComponent(String(id))}`;
  const res = await fetch(apiUrl(path), { method: 'DELETE' });
  await handleApiError(res, 'Failed to delete decision');
  clearGetCaches();
  if (res.status === 204) return null;
  return res.json();
}

export async function bulkDeleteDecisions(refsOrIds: InstanceEntityRef[] | Array<string | number>): Promise<BulkDeleteResult> {
  const usesRefs = typeof refsOrIds[0] === 'object';
  return postDestructiveJson<BulkDeleteResult, BulkDeleteRequest>(
    '/api/decisions/bulk-delete',
    usesRefs ? { refs: refsOrIds as InstanceEntityRef[] } : { ids: refsOrIds as Array<string | number> },
    'Failed to delete selected decisions',
  );
}

export async function cleanupByIp(request: CleanupByIpRequest | string): Promise<BulkDeleteResult> {
  const data: CleanupByIpRequest = typeof request === 'string' ? { ip: request } : request;
  const payload = await postDestructiveJson<BulkDeleteResult | MultiInstanceOperationResponse, CleanupByIpRequest>(
    '/api/cleanup/by-ip',
    data,
    'Failed to delete entries for this IP',
  );
  if (!('results' in payload)) return payload;
  const combined: BulkDeleteResult = {
    requested_alerts: 0,
    requested_decisions: 0,
    deleted_alerts: 0,
    deleted_decisions: 0,
    failed: [],
    ip: data.ip,
    instance_results: payload.results,
  };
  for (const operation of payload.results) {
    if (!operation.success) {
      combined.failed.push({ kind: 'alert', id: data.ip, error: `${operation.instance_name}: ${operation.error || 'Failed'}` });
      continue;
    }
    const result = operation.result as BulkDeleteResult | undefined;
    if (!result) continue;
    combined.requested_alerts += result.requested_alerts;
    combined.requested_decisions += result.requested_decisions;
    combined.deleted_alerts += result.deleted_alerts;
    combined.deleted_decisions += result.deleted_decisions;
    combined.failed.push(...result.failed.map((failure) => ({
      ...failure,
      error: `${operation.instance_name}: ${failure.error}`,
    })));
  }
  return combined;
}

export async function addDecision(data: AddDecisionRequest): Promise<unknown> {
    const res = await fetch(apiUrl('/api/decisions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    const payload = await res.clone().json().catch(() => null) as MultiInstanceOperationResponse | unknown;
    if (!res.ok && (!payload || typeof payload !== 'object' || !('results' in payload))) {
        await handleApiError(res, 'Failed to add decision', 'Write Operations');
    }
    clearGetCaches();
    return payload;
}

export async function fetchConfig(): Promise<ConfigResponse> {
    return fetchJson<ConfigResponse>('/api/config', undefined, 'Failed to fetch config');
}

export async function fetchCrowdsecMetrics(instanceId?: string, endpointId?: string): Promise<CrowdsecMetricsResponse> {
    const path = instanceId && endpointId
        ? `/api/instances/${encodeURIComponent(instanceId)}/metrics/${encodeURIComponent(endpointId)}`
        : '/api/metrics/crowdsec';
    return fetchJson<CrowdsecMetricsResponse>(path, undefined, 'Failed to fetch CrowdSec metrics');
}

export async function updateMetricsSidebarPreference(data: UpdateMetricsSidebarPreferenceRequest): Promise<{
    success: boolean;
    metrics_sidebar_visible: boolean;
}> {
    return sendJson('/api/config/metrics-sidebar', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    }, 'Failed to update metrics sidebar preference');
}

export async function updateManualRefreshSetting(data: UpdateManualRefreshSettingRequest): Promise<{
    success: boolean;
    manual_refresh_enabled: boolean;
}> {
    return sendJson('/api/config/manual-refresh', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    }, 'Failed to update manual refresh setting');
}

export async function updateLanguagePreference(language: string): Promise<{
    success: boolean;
    language: string;
}> {
    return sendJson('/api/config/language', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language }),
    }, 'Failed to update language preference');
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
        clearGetCaches();
        return null as T;
    }

    const payload = await response.json() as T;
    clearGetCaches();
    return payload;
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
