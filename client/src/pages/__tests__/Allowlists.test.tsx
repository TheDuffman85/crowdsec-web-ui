import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { Allowlists } from '../Allowlists';
import type { AllowlistCheckResponse, AllowlistEntriesResponse, AllowlistEntry, AllowlistsResponse, AllowlistSummary } from '../../types';

const { fetchAllowlistsMock, fetchAllowlistEntriesMock, checkAllowlistMock } = vi.hoisted(() => ({
  fetchAllowlistsMock: vi.fn(),
  fetchAllowlistEntriesMock: vi.fn(),
  checkAllowlistMock: vi.fn(),
}));

vi.mock('../../contexts/useRefresh', () => ({
  useRefresh: () => ({ refreshSignal: 0, setLastUpdated: vi.fn() }),
}));

vi.mock('../../lib/api', () => ({
  fetchAllowlists: fetchAllowlistsMock,
  fetchAllowlistEntries: fetchAllowlistEntriesMock,
  checkAllowlist: checkAllowlistMock,
}));

function summary(name: string, overrides: Partial<AllowlistSummary> = {}): AllowlistSummary {
  return { name, console_managed: false, instance_ids: ['main'], entry_count: 0, matching_entries: 0, ...overrides };
}

function entriesPage(allowlist: AllowlistSummary, data: AllowlistEntry[], page = 1, total = data.length): AllowlistEntriesResponse {
  return {
    allowlist,
    data,
    pagination: { page, page_size: 50, total, total_pages: Math.ceil(total / 50), unfiltered_total: allowlist.entry_count },
  };
}

const entry = (value: string, overrides: Partial<AllowlistEntry> = {}): AllowlistEntry => ({
  value,
  expiration: null,
  instance_ids: ['main'],
  ...overrides,
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

function renderAllowlists(path = '/allowlists') {
  return render(<MemoryRouter initialEntries={[path]}><Allowlists /><LocationProbe /><ScopeNavigation /></MemoryRouter>);
}

function ScopeNavigation() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/allowlists?instance=west')}>Switch to West</button>;
}

function scopedResponse(instanceId: string): AllowlistsResponse {
  return {
    partial: false,
    instances: [{ instance_id: instanceId, instance_name: instanceId, status: 'available' }],
    allowlists: [summary(`${instanceId}-only`, { instance_ids: [instanceId] })],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const allowlistedCheck: AllowlistCheckResponse = {
  value: '10.0.0.1',
  allowlisted: true,
  results: [{ instance_id: 'east', instance_name: 'East', status: 'available', allowlisted: true }],
};

const singleInstance = [{ instance_id: 'main', instance_name: 'Main', status: 'available' as const }];

beforeEach(() => {
  fetchAllowlistsMock.mockReset();
  fetchAllowlistEntriesMock.mockReset();
  checkAllowlistMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Allowlists page', () => {
  test('clears check results when switching instances', async () => {
    fetchAllowlistsMock.mockImplementation(async (scope: string) => scopedResponse(scope));
    fetchAllowlistEntriesMock.mockResolvedValue(entriesPage(summary('empty'), []));
    checkAllowlistMock.mockResolvedValue(allowlistedCheck);
    renderAllowlists('/allowlists?instance=east');

    await screen.findByRole('button', { name: /east-only/ });
    await userEvent.type(screen.getByRole('textbox', { name: 'IP address or range' }), '10.0.0.1');
    await userEvent.click(screen.getByRole('button', { name: 'Check' }));
    await screen.findByText('10.0.0.1 is allowlisted');
    await userEvent.click(screen.getByRole('button', { name: 'Switch to West' }));

    await screen.findByRole('button', { name: /west-only/ });
    expect(screen.queryByRole('list', { name: 'Allowlist check results' })).not.toBeInTheDocument();
  });

  test.each(['success', 'failure'])('ignores a pending check %s after switching instances', async (outcome) => {
    const pending = deferred<AllowlistCheckResponse>();
    fetchAllowlistsMock.mockImplementation(async (scope: string) => scopedResponse(scope));
    fetchAllowlistEntriesMock.mockResolvedValue(entriesPage(summary('empty'), []));
    checkAllowlistMock.mockReturnValue(pending.promise);
    renderAllowlists('/allowlists?instance=east');

    await screen.findByRole('button', { name: /east-only/ });
    await userEvent.type(screen.getByRole('textbox', { name: 'IP address or range' }), '10.0.0.1');
    await userEvent.click(screen.getByRole('button', { name: 'Check' }));
    await userEvent.click(screen.getByRole('button', { name: 'Switch to West' }));
    await screen.findByRole('button', { name: /west-only/ });
    await act(async () => {
      if (outcome === 'success') pending.resolve(allowlistedCheck);
      else pending.reject(new Error('East unavailable'));
    });

    expect(screen.queryByRole('list', { name: 'Allowlist check results' })).not.toBeInTheDocument();
    expect(screen.queryByText('The check failed. Enter a valid IP address or range.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check' })).toBeInTheDocument();
  });

  test.each(['success', 'failure'])('ignores a late list %s from the previous instance', async (outcome) => {
    const east = deferred<AllowlistsResponse>();
    fetchAllowlistsMock.mockImplementation((scope: string) => scope === 'east' ? east.promise : Promise.resolve(scopedResponse(scope)));
    fetchAllowlistEntriesMock.mockResolvedValue(entriesPage(summary('empty'), []));
    renderAllowlists('/allowlists?instance=east');

    await waitFor(() => expect(fetchAllowlistsMock).toHaveBeenCalledWith('east', ''));
    await userEvent.click(screen.getByRole('button', { name: 'Switch to West' }));
    await screen.findByRole('button', { name: /west-only/ });
    await act(async () => {
      if (outcome === 'success') east.resolve(scopedResponse('east'));
      else east.reject(new Error('East unavailable'));
    });

    expect(screen.getByRole('button', { name: /west-only/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /east-only/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Failed to load allowlists.')).not.toBeInTheDocument();
  });

  test('ignores a late list response for an older filter', async () => {
    const olderFilter = deferred<AllowlistsResponse>();
    fetchAllowlistsMock.mockImplementation((_scope: string, query: string) => query === 'old'
      ? olderFilter.promise
      : Promise.resolve({ partial: false, instances: singleInstance, allowlists: [summary(query || 'initial')] }));
    fetchAllowlistEntriesMock.mockResolvedValue(entriesPage(summary('empty'), []));
    renderAllowlists();

    await screen.findByRole('button', { name: /initial/ });
    await userEvent.type(screen.getByRole('searchbox'), 'old');
    await waitFor(() => expect(fetchAllowlistsMock).toHaveBeenCalledWith('all', 'old'));
    await userEvent.clear(screen.getByRole('searchbox'));
    await userEvent.type(screen.getByRole('searchbox'), 'new');
    await screen.findByRole('button', { name: /new/ });
    await act(async () => {
      olderFilter.resolve({ partial: false, instances: singleInstance, allowlists: [summary('old')] });
    });

    expect(screen.getByRole('button', { name: /new/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /old/ })).not.toBeInTheDocument();
  });

  test('lists allowlists and shows the entries of the selected one', async () => {
    const office = summary('office', { description: 'Office network', entry_count: 2, matching_entries: 2 });
    const monitoring = summary('monitoring', { console_managed: true, entry_count: 0 });
    fetchAllowlistsMock.mockResolvedValue({ partial: false, instances: singleInstance, allowlists: [monitoring, office] } satisfies AllowlistsResponse);
    fetchAllowlistEntriesMock.mockImplementation(async (name: string) => name === 'office'
      ? entriesPage(office, [entry('10.0.0.0/8', { description: 'VPN' }), entry('192.0.2.10', { expiration: '2026-12-01T00:00:00.000Z' })])
      : entriesPage(monitoring, []));
    renderAllowlists();

    expect(await screen.findByText('This allowlist has no active entries.')).toBeInTheDocument();
    expect(fetchAllowlistsMock).toHaveBeenCalledWith('all', '');
    expect(fetchAllowlistEntriesMock).toHaveBeenCalledWith('monitoring', 'all', 1, 50, '');
    expect(screen.getAllByText('Console managed').length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: /office/ }));
    expect(await screen.findByText('10.0.0.0/8')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /office/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('location')).toHaveTextContent('allowlist=office');
    expect(screen.getByText('VPN')).toBeInTheDocument();
    expect(screen.getByText('Never')).toBeInTheDocument();
    expect(screen.getByText('Showing 2 of 2 entries')).toBeInTheDocument();
    expect(screen.queryByText('Instances')).not.toBeInTheDocument();
  });

  test('loads further entry pages from the server while scrolling', async () => {
    const callbacks: IntersectionObserverCallback[] = [];
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    });
    const big = summary('big', { entry_count: 60, matching_entries: 60 });
    fetchAllowlistsMock.mockResolvedValue({ partial: false, instances: singleInstance, allowlists: [big] } satisfies AllowlistsResponse);
    fetchAllowlistEntriesMock.mockImplementation(async (_name: string, _scope: string, page: number) => entriesPage(
      big,
      Array.from({ length: page === 1 ? 50 : 10 }, (_, index) => entry(`10.0.${page}.${index}`)),
      page,
      60,
    ));
    renderAllowlists('/allowlists?allowlist=big');

    expect(await screen.findByText('Showing 50 of 60 entries')).toBeInTheDocument();
    act(() => {
      callbacks.at(-1)!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    expect(await screen.findByText('Showing 60 of 60 entries')).toBeInTheDocument();
    expect(fetchAllowlistEntriesMock).toHaveBeenLastCalledWith('big', 'all', 2, 50, '');
    expect(screen.getByText('10.0.2.9')).toBeInTheDocument();
  });

  test('filters allowlists and entries on the server', async () => {
    const office = summary('office', { entry_count: 100, matching_entries: 100 });
    fetchAllowlistsMock.mockImplementation(async (_scope: string, query: string) => ({
      partial: false,
      instances: singleInstance,
      allowlists: query === 'nothing' ? [] : [{ ...office, matching_entries: query ? 1 : 100 }],
    }));
    fetchAllowlistEntriesMock.mockImplementation(async (_name: string, _scope: string, _page: number, _size: number, query: string) => (
      entriesPage(office, query ? [entry('192.0.2.10')] : [entry('10.0.0.1')])
    ));
    renderAllowlists();

    expect(await screen.findByText('10.0.0.1')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('searchbox'), '192.0.2');
    expect(await screen.findByText('192.0.2.10')).toBeInTheDocument();
    expect(screen.getByText('1 of 100 entries match')).toBeInTheDocument();
    expect(fetchAllowlistsMock).toHaveBeenLastCalledWith('all', '192.0.2');
    expect(fetchAllowlistEntriesMock).toHaveBeenLastCalledWith('office', 'all', 1, 50, '192.0.2');

    await userEvent.clear(screen.getByRole('searchbox'));
    await userEvent.type(screen.getByRole('searchbox'), 'nothing');
    expect(await screen.findByText('No allowlists or entries match the filter.')).toBeInTheDocument();
  });

  test('shows instance names and icons for each entry and reports unsupported or unreachable instances', async () => {
    const office = summary('office', { instance_ids: ['east', 'west'], entry_count: 2, matching_entries: 2 });
    fetchAllowlistsMock.mockResolvedValue({
      partial: true,
      instances: [
        { instance_id: 'east', instance_name: 'East', instance_icon: '🟦', status: 'available' },
        { instance_id: 'west', instance_name: 'West', instance_icon: '🟩', status: 'available' },
        { instance_id: 'old', instance_name: 'Old', status: 'unsupported' },
        { instance_id: 'down', instance_name: 'Down', status: 'unavailable', error: 'Request timeout' },
      ],
      allowlists: [office],
    } satisfies AllowlistsResponse);
    fetchAllowlistEntriesMock.mockResolvedValue(entriesPage(office, [
      entry('10.0.0.0/8', { instance_ids: ['east', 'west'] }),
      entry('192.0.2.10', { instance_ids: ['east'] }),
    ]));
    renderAllowlists('/allowlists?instance=all');

    const sharedEntry = within((await screen.findByText('10.0.0.0/8')).closest('li')!);
    expect(sharedEntry.getByText('East')).toBeInTheDocument();
    expect(sharedEntry.getByText('🟦')).toBeInTheDocument();
    expect(sharedEntry.getByText('West')).toBeInTheDocument();
    expect(sharedEntry.getByText('🟩')).toBeInTheDocument();
    const eastEntry = within(screen.getByText('192.0.2.10').closest('li')!);
    expect(eastEntry.getByText('East')).toBeInTheDocument();
    expect(eastEntry.getByText('🟦')).toBeInTheDocument();
    expect(eastEntry.queryByText('West')).not.toBeInTheDocument();
    expect(screen.queryByText(/Missing on/)).not.toBeInTheDocument();
    expect(screen.getByText('Allowlists require CrowdSec 1.6.5 or later and are not available on: Old')).toBeInTheDocument();
    expect(screen.getByText('Could not read allowlists from Down.')).toBeInTheDocument();
    expect(screen.getByText('Request timeout')).toBeInTheDocument();
  });

  test('explains when the only LAPI does not support allowlists', async () => {
    fetchAllowlistsMock.mockResolvedValue({
      partial: false,
      instances: [{ instance_id: 'main', instance_name: 'Main', status: 'unsupported' }],
      allowlists: [],
    } satisfies AllowlistsResponse);
    renderAllowlists();

    expect(await screen.findByText('This CrowdSec LAPI does not support allowlists. They require CrowdSec 1.6.5 or later.')).toBeInTheDocument();
    expect(screen.queryByText('No allowlists are configured.')).not.toBeInTheDocument();
  });

  test('shows an empty state and retries after a failed load', async () => {
    fetchAllowlistsMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ partial: false, instances: singleInstance, allowlists: [] });
    renderAllowlists('/allowlists?instance=main');

    expect(await screen.findByText('Failed to load allowlists.')).toBeInTheDocument();
    expect(fetchAllowlistsMock).toHaveBeenCalledWith('main', '');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No allowlists are configured.')).toBeInTheDocument();
  });

  test('retries a failed entry page', async () => {
    const office = summary('office', { entry_count: 1, matching_entries: 1 });
    fetchAllowlistsMock.mockResolvedValue({ partial: false, instances: singleInstance, allowlists: [office] });
    fetchAllowlistEntriesMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(entriesPage(office, [entry('10.0.0.1')]));
    renderAllowlists();

    expect(await screen.findByText('Failed to load the allowlist entries.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('10.0.0.1')).toBeInTheDocument();
  });

  test('checks an IP or range against the selected scope', async () => {
    fetchAllowlistsMock.mockResolvedValue({
      partial: false,
      instances: [
        { instance_id: 'east', instance_name: 'East', instance_icon: '🟦', status: 'available' },
        { instance_id: 'west', instance_name: 'West', status: 'available' },
      ],
      allowlists: [],
    } satisfies AllowlistsResponse);
    checkAllowlistMock
      .mockResolvedValueOnce({
        value: '10.1.2.3',
        allowlisted: true,
        results: [
          { instance_id: 'east', instance_name: 'East', instance_icon: '🟦', status: 'available', allowlisted: true, reason: '10.0.0.0/8 from office (VPN)' },
          { instance_id: 'west', instance_name: 'West', status: 'unavailable', allowlisted: false, error: 'Request timeout' },
        ],
      })
      .mockRejectedValueOnce(new Error('Failed to check allowlists'));
    renderAllowlists();
    await waitFor(() => expect(fetchAllowlistsMock).toHaveBeenCalled());

    const input = screen.getByRole('textbox', { name: 'IP address or range' });
    await userEvent.type(input, ' 10.1.2.3 ');
    await userEvent.click(screen.getByRole('button', { name: 'Check' }));

    const results = await screen.findByRole('list', { name: 'Allowlist check results' });
    expect(checkAllowlistMock).toHaveBeenCalledWith('10.1.2.3', 'all');
    expect(within(results).getByText('10.1.2.3 is allowlisted')).toBeInTheDocument();
    expect(within(results).getByText('10.0.0.0/8 from office (VPN)')).toBeInTheDocument();
    expect(within(results).getByText('🟦')).toBeInTheDocument();
    expect(within(results).getByText('Unavailable')).toBeInTheDocument();
    expect(within(results).getByText('West')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('The check failed. Enter a valid IP address or range.')).toBeInTheDocument();
  });
});
