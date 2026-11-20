import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { Allowlists } from '../Allowlists';
import type {
  AllowlistCheckResponse,
  AllowlistEntriesResponse,
  AllowlistEntry,
  AllowlistInstanceStatus,
  AllowlistOperationResponse,
  AllowlistsResponse,
  AllowlistSummary,
} from '../../types';

const {
  fetchAllowlistsMock,
  fetchAllowlistEntriesMock,
  checkAllowlistMock,
  fetchConfigMock,
  createAllowlistMock,
  deleteAllowlistMock,
  addAllowlistEntriesMock,
  removeAllowlistEntriesMock,
} = vi.hoisted(() => ({
  fetchAllowlistsMock: vi.fn(),
  fetchAllowlistEntriesMock: vi.fn(),
  checkAllowlistMock: vi.fn(),
  fetchConfigMock: vi.fn(),
  createAllowlistMock: vi.fn(),
  deleteAllowlistMock: vi.fn(),
  addAllowlistEntriesMock: vi.fn(),
  removeAllowlistEntriesMock: vi.fn(),
}));

vi.mock('../../contexts/useRefresh', () => ({
  useRefresh: () => ({ refreshSignal: 0, setLastUpdated: vi.fn() }),
}));

vi.mock('../../lib/api', () => ({
  fetchAllowlists: fetchAllowlistsMock,
  fetchAllowlistEntries: fetchAllowlistEntriesMock,
  checkAllowlist: checkAllowlistMock,
  fetchConfig: fetchConfigMock,
  createAllowlist: createAllowlistMock,
  deleteAllowlist: deleteAllowlistMock,
  addAllowlistEntries: addAllowlistEntriesMock,
  removeAllowlistEntries: removeAllowlistEntriesMock,
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
    instances: [{ instance_id: instanceId, instance_name: instanceId, status: 'available', management: 'unsupported' }],
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

const singleInstance = [{ instance_id: 'main', instance_name: 'Main', status: 'available' as const, management: 'unsupported' as const }];

const accepted = (...names: string[]): AllowlistOperationResponse => ({
  results: names.map((name) => ({ instance_id: name.toLowerCase(), instance_name: name, success: true })),
  succeeded: names.length,
  failed: 0,
});

beforeEach(() => {
  fetchAllowlistsMock.mockReset();
  fetchAllowlistEntriesMock.mockReset();
  checkAllowlistMock.mockReset();
  fetchConfigMock.mockReset().mockResolvedValue({ permissions: { can_manage_enforcement: true } });
  createAllowlistMock.mockReset();
  deleteAllowlistMock.mockReset();
  addAllowlistEntriesMock.mockReset();
  removeAllowlistEntriesMock.mockReset();
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
        { instance_id: 'east', instance_name: 'East', instance_icon: '🟦', status: 'available', management: 'unsupported' },
        { instance_id: 'west', instance_name: 'West', instance_icon: '🟩', status: 'available', management: 'unsupported' },
        { instance_id: 'old', instance_name: 'Old', status: 'unsupported', management: 'unsupported' },
        { instance_id: 'down', instance_name: 'Down', status: 'unavailable', management: 'unknown', error: 'Request timeout' },
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
      instances: [{ instance_id: 'main', instance_name: 'Main', status: 'unsupported', management: 'unsupported' }],
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
        { instance_id: 'east', instance_name: 'East', instance_icon: '🟦', status: 'available', management: 'unsupported' },
        { instance_id: 'west', instance_name: 'West', status: 'available', management: 'unsupported' },
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

describe('allowlist management', () => {
  const manageable: AllowlistInstanceStatus[] = [{ instance_id: 'main', instance_name: 'Main', status: 'available', management: 'available' }];
  const office = summary('office', { entry_count: 1, matching_entries: 1 });

  function serve(instances: AllowlistInstanceStatus[], allowlists: AllowlistSummary[]) {
    fetchAllowlistsMock.mockResolvedValue({ partial: false, instances, allowlists });
    fetchAllowlistEntriesMock.mockImplementation(async (name: string) => (
      entriesPage(allowlists.find((allowlist) => allowlist.name === name)!, [entry('10.0.0.0/8', { description: 'VPN' })])
    ));
  }

  test('stays read-only when LAPI has no write routes, the user may not change enforcement, or the Console manages the list', async () => {
    serve(singleInstance, [office]);
    const legacy = renderAllowlists();
    await screen.findByText('10.0.0.0/8');
    expect(screen.getByText(/This page is read-only/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New allowlist' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add entries' })).not.toBeInTheDocument();
    legacy.unmount();

    serve(manageable, [office]);
    fetchConfigMock.mockResolvedValue({ permissions: { can_manage_enforcement: false } });
    const readOnlyUser = renderAllowlists();
    await screen.findByText('10.0.0.0/8');
    await waitFor(() => expect(fetchConfigMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'New allowlist' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove 10.0.0.0/8' })).not.toBeInTheDocument();
    readOnlyUser.unmount();

    fetchConfigMock.mockResolvedValue({ permissions: { can_manage_enforcement: true } });
    serve(manageable, [summary('console', { console_managed: true, entry_count: 1, matching_entries: 1 })]);
    renderAllowlists();
    expect(await screen.findByRole('button', { name: 'New allowlist' })).toBeInTheDocument();
    expect(screen.getByText(/managed by the CrowdSec Console can only be changed there/)).toBeInTheDocument();
    await screen.findByText('10.0.0.0/8');
    expect(screen.queryByRole('button', { name: 'Add entries' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete allowlist' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove 10.0.0.0/8' })).not.toBeInTheDocument();
  });

  test('creates an allowlist and selects it', async () => {
    serve(manageable, [office]);
    createAllowlistMock.mockResolvedValue(accepted('Main'));
    renderAllowlists('/allowlists?instance=main');

    await userEvent.click(await screen.findByRole('button', { name: 'New allowlist' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Create' })).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), ' partners ');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Description' }), 'Partner networks');
    const loads = fetchAllowlistsMock.mock.calls.length;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(createAllowlistMock).toHaveBeenCalledExactlyOnceWith('main', { name: 'partners', description: 'Partner networks' });
    expect(fetchAllowlistsMock.mock.calls.length).toBeGreaterThan(loads);
    expect(screen.getByTestId('location')).toHaveTextContent('allowlist=partners');
  });

  test('adds entries with an optional description and duration and reloads them', async () => {
    serve(manageable, [office]);
    addAllowlistEntriesMock.mockResolvedValue(accepted('Main'));
    renderAllowlists();

    await userEvent.click(await screen.findByRole('button', { name: 'Add entries' }));
    const dialog = screen.getByRole('dialog', { name: 'Add entries to office' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'IP address or range' }), '192.0.2.1, 198.51.100.0/24{Enter}192.0.2.1');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Expires after' }), '4h');
    const loads = fetchAllowlistEntriesMock.mock.calls.length;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add entries' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(addAllowlistEntriesMock).toHaveBeenCalledExactlyOnceWith('office', 'all', { values: ['192.0.2.1', '198.51.100.0/24'], duration: '4h' });
    await waitFor(() => expect(fetchAllowlistEntriesMock.mock.calls.length).toBeGreaterThan(loads));
  });

  test('asks before removing an entry and before deleting the allowlist', async () => {
    serve(manageable, [office]);
    removeAllowlistEntriesMock.mockResolvedValue(accepted('Main'));
    deleteAllowlistMock.mockResolvedValue(accepted('Main'));
    renderAllowlists();

    await userEvent.click(await screen.findByRole('button', { name: 'Remove 10.0.0.0/8' }));
    let dialog = screen.getByRole('dialog', { name: 'Remove entry' });
    expect(dialog).toHaveTextContent('Remove 10.0.0.0/8 from office? This action cannot be undone.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(removeAllowlistEntriesMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Remove 10.0.0.0/8' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(removeAllowlistEntriesMock).toHaveBeenCalledExactlyOnceWith('office', 'all', ['10.0.0.0/8']);

    await userEvent.click(await screen.findByRole('button', { name: 'Delete allowlist' }));
    dialog = screen.getByRole('dialog', { name: 'Delete allowlist' });
    expect(dialog).toHaveTextContent('Delete the allowlist office and all its entries?');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(deleteAllowlistMock).toHaveBeenCalledExactlyOnceWith('office', 'all');
  });

  test('keeps the dialog open and explains a change that LAPI or the Web UI refused', async () => {
    serve(manageable, [office]);
    addAllowlistEntriesMock.mockResolvedValueOnce({
      results: [{ instance_id: 'main', instance_name: 'Main', success: false, error: 'access forbidden from this IP (172.18.0.5)', code: 'UNTRUSTED_IP' }],
      succeeded: 0,
      failed: 1,
    });
    renderAllowlists();

    await userEvent.click(await screen.findByRole('button', { name: 'Add entries' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'IP address or range' }), '192.0.2.1');
    const loads = fetchAllowlistsMock.mock.calls.length;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add entries' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('access forbidden from this IP (172.18.0.5)');
    expect(within(alert).getByRole('link', { name: 'Learn more' })).toHaveAttribute('href', expect.stringContaining('#trusted-ips-for-delete-operations-optional'));
    // Nothing changed, so nothing is read again.
    expect(fetchAllowlistsMock.mock.calls.length).toBe(loads);

    addAllowlistEntriesMock.mockRejectedValueOnce(new Error('Invalid IP address or range: example.com'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add entries' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Invalid IP address or range: example.com');
    expect(within(dialog).queryByRole('link')).not.toBeInTheDocument();
  });

  test('names the instances that will get a new allowlist, reloads after a partial success, and warns about untrusted ones', async () => {
    serve([
      { instance_id: 'east', instance_name: 'East', status: 'available', management: 'available' },
      { instance_id: 'west', instance_name: 'West', status: 'available', management: 'available' },
      { instance_id: 'north', instance_name: 'North', status: 'available', management: 'forbidden' },
      { instance_id: 'old', instance_name: 'Old', status: 'available', management: 'unsupported' },
    ], [summary('office', { instance_ids: ['east', 'west'], entry_count: 1, matching_entries: 1 })]);
    createAllowlistMock.mockResolvedValue({
      results: [
        { instance_id: 'east', instance_name: 'East', success: true },
        { instance_id: 'west', instance_name: 'West', success: false, error: "allowlist 'partners' already exists" },
      ],
      succeeded: 1,
      failed: 1,
    });
    renderAllowlists();

    const warning = await screen.findByText(/refuses them on: North\./);
    expect(within(warning.parentElement!).getByRole('link', { name: 'Learn more' })).toHaveAttribute('href', expect.stringContaining('#trusted-ips'));
    await userEvent.click(screen.getByRole('button', { name: 'New allowlist' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Will be created on: East, West');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'partners');
    const loads = fetchAllowlistsMock.mock.calls.length;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent("West: allowlist 'partners' already exists");
    expect(fetchAllowlistsMock.mock.calls.length).toBeGreaterThan(loads);
  });
});
