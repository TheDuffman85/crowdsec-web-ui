import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { filterValidForPage, useRecentFilter } from '../savedFilters';

function Probe({ query, quickFiltersOpen = false }: { query: string; quickFiltersOpen?: boolean }) {
  useRecentFilter(query, 'alerts', quickFiltersOpen);
  return null;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('saved filter compatibility and recent recording', () => {
  test('checks the syntax supported by each view', () => {
    expect(filterValidForPage('kind=waf AND country=DE AND NOT target:(foo OR bar)', 'alerts')).toBe(true);
    expect(filterValidForPage('action=ban', 'alerts')).toBe(false);
    expect(filterValidForPage('action=ban', 'decisions')).toBe(true);
    expect(filterValidForPage('action=ban', 'dashboard')).toBe(false);
  });

  test('waits for Quick Filters to close and records only the final query', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ recent: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const view = render(<Probe query="country=DE" />);
    await act(async () => { vi.advanceTimersByTime(1000); });
    view.rerender(<Probe query="country=DE" quickFiltersOpen />);
    await act(async () => { vi.advanceTimersByTime(2000); });
    view.rerender(<Probe query="country=US" quickFiltersOpen />);
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(fetchMock).not.toHaveBeenCalled();
    view.rerender(<Probe query="country=US" />);
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ body: JSON.stringify({ query: 'country=US' }) });
  });

  test('records a stable bookmarked query and cancels superseded queries', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ recent: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const view = render(<Probe query="country=DE" />);
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(fetchMock).not.toHaveBeenCalled();
    view.rerender(<Probe query="country=US" />);
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ body: JSON.stringify({ query: 'country=US' }) });
    view.rerender(<Probe query="origin:(manual OR" />);
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
