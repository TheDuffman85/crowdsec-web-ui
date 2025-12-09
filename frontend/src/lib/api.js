export async function fetchAlerts() {
    const res = await fetch('/api/alerts');
    if (!res.ok) throw new Error('Failed to fetch alerts');
    return res.json();
}

export async function fetchAlert(id) {
    const res = await fetch(`/api/alerts/${id}`);
    if (!res.ok) throw new Error('Failed to fetch alert');
    return res.json();
}

export async function fetchDecisions() {
    const res = await fetch('/api/decisions');
    if (!res.ok) throw new Error('Failed to fetch decisions');
    return res.json();
}

export async function fetchDecisionsForStats() {
    const res = await fetch('/api/stats/decisions');
    if (!res.ok) throw new Error('Failed to fetch decision statistics');
    return res.json();
}

export async function deleteDecision(id) {
    const res = await fetch(`/api/decisions/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete decision');
    return res.json();
}

export async function addDecision(data) {
    const res = await fetch('/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error('Failed to add decision');
    return res.json();
}

export async function fetchConfig() {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error('Failed to fetch config');
    return res.json();
}
