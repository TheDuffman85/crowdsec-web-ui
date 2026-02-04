import { apiUrl } from './basePath';

export async function fetchAlerts() {
    const res = await fetch(apiUrl('/api/alerts'));
    if (!res.ok) throw new Error('Failed to fetch alerts');
    return res.json();
}

export async function fetchAlert(id) {
    const res = await fetch(apiUrl(`/api/alerts/${id}`));
    if (!res.ok) throw new Error('Failed to fetch alert');
    return res.json();
}

export async function fetchDecisions() {
    const res = await fetch(apiUrl('/api/decisions'));
    if (!res.ok) throw new Error('Failed to fetch decisions');
    return res.json();
}

// Helper to handle API errors with specific 403 guidance
function handleApiError(res, defaultMsg, operationName = 'Delete Operations') {
    if (!res.ok) {
        if (res.status === 403) {
            const repoUrl = import.meta.env.VITE_REPO_URL || 'https://github.com/TheDuffman85/crowdsec-web-ui';
            const error = new Error('Permission denied.');
            error.helpLink = `${repoUrl}#trusted-ips-for-delete-operations-optional`;
            error.helpText = `Trusted IPs for ${operationName}`;
            throw error;
        }
        throw new Error(defaultMsg);
    }
}

export async function deleteAlert(id) {
    const res = await fetch(apiUrl(`/api/alerts/${id}`), { method: 'DELETE' });
    handleApiError(res, 'Failed to delete alert');
    if (res.status === 204) return null;
    return res.json();
}

export async function fetchDecisionsForStats() {
    const res = await fetch(apiUrl('/api/stats/decisions'));
    if (!res.ok) throw new Error('Failed to fetch decision statistics');
    return res.json();
}

export async function fetchAlertsForStats() {
    const res = await fetch(apiUrl('/api/stats/alerts'));
    if (!res.ok) throw new Error('Failed to fetch alert statistics');
    return res.json();
}

export async function deleteDecision(id) {
    const res = await fetch(apiUrl(`/api/decisions/${id}`), { method: 'DELETE' });
    handleApiError(res, 'Failed to delete decision');
    if (res.status === 204) return null;
    return res.json();
}

export async function addDecision(data) {
    const res = await fetch(apiUrl('/api/decisions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    handleApiError(res, 'Failed to add decision', 'Write Operations');
    return res.json();
}

export async function fetchConfig() {
    const res = await fetch(apiUrl('/api/config'));
    if (!res.ok) throw new Error('Failed to fetch config');
    return res.json();
}
