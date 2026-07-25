import { afterEach, describe, expect, test } from 'vitest';
import {
  QUICK_FILTERS_STORAGE_KEY,
  emptyStoredQuickFilters,
  getStoredQuickFilterSelection,
  loadStoredQuickFilters,
  mergeStoredQuickFiltersIntoQuery,
  saveStoredQuickFilters,
  setStoredQuickFilterSelection,
  syncStoredQuickFiltersFromSearch,
} from '../quickFilters';
import { compileAlertSearch, compileDecisionSearch } from '../../../../shared/search';

describe('persisted quick filters', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  test('normalizes malformed browser storage', () => {
    window.localStorage.setItem(QUICK_FILTERS_STORAGE_KEY, JSON.stringify({
      selections: {
        country: { included: ['DE', 'DE', 42], excluded: ['DE', 'US'] },
        unknown: { included: ['value'], excluded: [] },
      },
      dateRange: { start: 42, end: '2026-03-24T12:00' },
    }));

    expect(loadStoredQuickFilters()).toEqual({
      selections: {
        country: { included: ['DE'], excluded: ['US'] },
      },
      dateRange: { start: '', end: '2026-03-24T12:00' },
    });
  });

  test('hydrates only filters applicable to the requested page', () => {
    let filters = emptyStoredQuickFilters();
    filters = setStoredQuickFilterSelection(filters, 'country', {
      included: ['DE'],
      excluded: [],
    });
    filters = setStoredQuickFilterSelection(filters, 'action', {
      included: ['ban'],
      excluded: [],
    });
    filters = {
      ...filters,
      dateRange: { start: '2026-03-24T10:00', end: '' },
    };

    expect(mergeStoredQuickFiltersIntoQuery('alerts', 'ssh', filters)).toBe(
      'ssh AND country:DE AND date>=2026-03-24T10:00',
    );
    expect(mergeStoredQuickFiltersIntoQuery('decisions', 'ssh', filters)).toBe(
      'ssh AND country:DE AND action:ban AND date>=2026-03-24T10:00',
    );
  });

  test('lets an explicit URL filter win over the persisted value', () => {
    const filters = setStoredQuickFilterSelection(emptyStoredQuickFilters(), 'country', {
      included: ['FR'],
      excluded: [],
    });

    expect(mergeStoredQuickFiltersIntoQuery('alerts', 'country:DE', filters)).toBe('country:DE');
  });

  test('syncing one page preserves filters exclusive to the other page', () => {
    let filters = setStoredQuickFilterSelection(emptyStoredQuickFilters(), 'action', {
      included: ['ban'],
      excluded: [],
    });
    const compiled = compileAlertSearch('country:DE');
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    filters = syncStoredQuickFiltersFromSearch(
      filters,
      'alerts',
      compiled.ast,
      { start: '', end: '' },
    );
    saveStoredQuickFilters(filters);

    expect(getStoredQuickFilterSelection(loadStoredQuickFilters(), 'action')).toEqual({
      included: ['ban'],
      excluded: [],
    });
    const decisionSearch = compileDecisionSearch(
      mergeStoredQuickFiltersIntoQuery('decisions', '', loadStoredQuickFilters()),
    );
    expect(decisionSearch.ok).toBe(true);
  });
});
