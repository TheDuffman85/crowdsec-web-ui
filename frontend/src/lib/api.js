export async function fetchAlerts() {
    const res = await fetch('/api/alerts');
    if (!res.ok) throw new Error('Failed to fetch alerts');
    return res.json();
}

export async function fetchDecisions() {
    const res = await fetch('/api/decisions');
    if (!res.ok) throw new Error('Failed to fetch decisions');
    return res.json();
}

export async function deleteDecision(id) {
    const res = await fetch(`/api/decisions/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete decision');
    return res.json();
}
