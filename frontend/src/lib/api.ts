import type {
  AddDecisionRequest,
  AlertRecord,
  ApiPermissionError,
  ConfigResponse,
  DecisionListItem,
  SlimAlert,
  StatsAlert,
  StatsDecision,
} from '../types';
import { apiUrl } from './basePath';

async function fetchJson<T>(input: string, init?: RequestInit, defaultMsg?: string): Promise<T> {
    const response = await fetch(apiUrl(input), init);
    if (!response.ok) {
        throw new Error(defaultMsg || 'Request failed');
    }
    return response.json() as Promise<T>;
}

export async function fetchAlerts(): Promise<SlimAlert[]> {
    return fetchJson<SlimAlert[]>('/api/alerts', undefined, 'Failed to fetch alerts');
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

export async function fetchDecisionsForStats(): Promise<StatsDecision[]> {
    return fetchJson<StatsDecision[]>('/api/stats/decisions', undefined, 'Failed to fetch decision statistics');
}

export async function fetchAlertsForStats(): Promise<StatsAlert[]> {
    return fetchJson<StatsAlert[]>('/api/stats/alerts', undefined, 'Failed to fetch alert statistics');
}

export async function deleteDecision(id: string | number): Promise<unknown> {
    const res = await fetch(apiUrl(`/api/decisions/${id}`), { method: 'DELETE' });
    handleApiError(res, 'Failed to delete decision');
    if (res.status === 204) return null;
    return res.json();
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
