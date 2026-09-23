import { useEffect } from 'react';
import { compileAlertSearch, compileDecisionSearch } from '../../../shared/search';
import { useAuth } from '../contexts/AuthContext';
import { apiUrl } from './basePath';
import { sessionFetch } from './sessionFetch';

export type FilterPage = 'alerts' | 'decisions' | 'dashboard';

export interface SavedFilter {
  id: string;
  name: string;
  query: string;
  created_at: string;
  updated_at: string;
}

export interface RecentFilter {
  query: string;
  used_at: string;
}

export interface FilterLists {
  saved: SavedFilter[];
  recent: RecentFilter[];
  shared: boolean;
}

const SEARCH_FEATURES = { machineEnabled: true, originEnabled: true };

export function filterValidForPage(query: string, page: FilterPage): boolean {
  if (!query.trim()) return false;
  if (page === 'alerts') return compileAlertSearch(query, SEARCH_FEATURES).ok;
  if (page === 'decisions') return compileDecisionSearch(query, SEARCH_FEATURES).ok;
  return compileAlertSearch(query, SEARCH_FEATURES).ok && compileDecisionSearch(query, SEARCH_FEATURES).ok;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await sessionFetch(apiUrl(`/api/search-filters${path}`), init);
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || 'Failed to update filters');
  }
  return response.json() as Promise<T>;
}

const jsonHeaders = { 'Content-Type': 'application/json' };

export const fetchFilterLists = () => request<FilterLists>('');
export const createSavedFilter = (name: string, query: string) => request<SavedFilter>('/saved', {
  method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name, query }),
});
export const renameSavedFilter = (id: string, name: string) => request<SavedFilter>(`/saved/${encodeURIComponent(id)}`, {
  method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ name }),
});
export const deleteSavedFilter = (id: string) => request<{ success: boolean }>(`/saved/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const recordRecentFilter = (query: string) => request<{ recent: RecentFilter[] }>('/recent', {
  method: 'POST', headers: jsonHeaders, body: JSON.stringify({ query }),
});
export const clearRecentFilters = () => request<{ success: boolean }>('/recent', { method: 'DELETE' });

export function useRecentFilter(query: string, page: FilterPage, quickFiltersOpen = false): void {
  const { authEnabled, loading, user } = useAuth();
  const owner = authEnabled ? user?.userId : 0;
  useEffect(() => {
    const trimmed = query.trim();
    if (loading || owner === undefined || quickFiltersOpen || !filterValidForPage(trimmed, page)) return;
    const timeout = window.setTimeout(() => {
      void recordRecentFilter(trimmed).catch(() => {
        // Recent history is a convenience; a failed write must not interrupt search.
      });
    }, 1500);
    return () => window.clearTimeout(timeout);
  }, [loading, owner, page, query, quickFiltersOpen]);
}
