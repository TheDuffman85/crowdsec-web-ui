import { createDeferred, flushAlertSearchDebounce, installControlledIntersectionObserver, setRefreshSignalMock, toPaginatedAlerts } from './harness';
import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../../../lib/api';
import { compileAlertSearch } from '../../../../../shared/search';
import { Alerts } from '../../Alerts';
import { type PaginatedResponse, type SlimAlert } from '../../../types';

async function expandAlertSearch() {
  const toggle = screen.getByRole('button', { name: 'Expand search' });
  await userEvent.click(toggle);
  const input = await screen.findByPlaceholderText('Filter alerts...');
  expect(input).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Search syntax help' })).toBeInTheDocument();
  const collapseButton = screen.getByRole('button', { name: 'Collapse search' });
  expect(collapseButton).toHaveAttribute('aria-expanded', 'true');
  expect(collapseButton).toHaveClass('border-r-0');
  expect(collapseButton.nextElementSibling).toContainElement(input);
  expect(input.parentElement).toHaveClass('rounded-l-none');
  expect(input.parentElement?.querySelector('.lucide-search')).toBeNull();
  return input;
}

describe('Alerts page search and pagination', () => {
  test('supports advanced field search and shows the active search badge', async () => {
    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());

    const searchButton = screen.getByRole('button', { name: 'Expand search' });
    const filtersButton = screen.getByRole('button', { name: 'Filters' });
    const columnsButton = screen.getByRole('button', { name: 'Choose alert table columns' });
    expect(Array.from(columnsButton.parentElement!.children).slice(0, 3)).toEqual([
      columnsButton,
      filtersButton,
      searchButton.parentElement!.parentElement!,
    ]);
    expect(screen.queryByPlaceholderText('Filter alerts...')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Search syntax help' })).not.toBeInTheDocument();
    await expandAlertSearch();
    await userEvent.click(screen.getByRole('button', { name: 'Collapse search' }));
    expect(screen.queryByPlaceholderText('Filter alerts...')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Search syntax help' })).not.toBeInTheDocument();
    const input = await expandAlertSearch();
    await userEvent.type(input, 'country:germany');

    await waitFor(() => expect(screen.getByText('country:germany')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText('5.6.7.8')).not.toBeInTheDocument());

    const highlightLayer = document.querySelector('[data-search-highlight-layer="true"]');
    expect(highlightLayer?.querySelector('[data-search-highlight-kind="field"]')).toHaveTextContent('country');
    expect(highlightLayer?.querySelector('[data-search-highlight-kind="comparator"]')).toHaveTextContent(':');
  });

  test('applies an initial advanced search URL query on the first alert load', async () => {
    const fetchAlertsPaginatedMock = vi.mocked(api.fetchAlertsPaginated);
    fetchAlertsPaginatedMock.mockClear();

    render(
      <MemoryRouter initialEntries={['/alerts?q=country:germany']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(fetchAlertsPaginatedMock).toHaveBeenCalled());
    expect(fetchAlertsPaginatedMock.mock.calls[0]?.[2]).toMatchObject({ q: 'country:germany' });
    await expandAlertSearch();
    await waitFor(() => expect(screen.getByPlaceholderText('Filter alerts...')).toHaveValue('country:germany'));
    await waitFor(() => expect(screen.queryByText('5.6.7.8')).not.toBeInTheDocument());
  });

  test('supports date comparisons in advanced alert search', async () => {
    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());

    const input = await expandAlertSearch();
    await userEvent.type(input, 'date>=2026-03-24');

    await waitFor(() => expect(screen.getByText('date>=2026-03-24')).toBeInTheDocument());
    expect(screen.queryByText(/Search syntax error/i)).not.toBeInTheDocument();
  });

  test('uses advanced-search date-time comparisons from quick filters', async () => {
    const fetchAlertsPaginatedMock = vi.mocked(api.fetchAlertsPaginated);
    fetchAlertsPaginatedMock.mockClear();

    render(
      <MemoryRouter initialEntries={['/alerts?q=country:DE']}>
        <Alerts />
      </MemoryRouter>,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Filters' }));
    await userEvent.click(screen.getByRole('button', { name: 'Date and time' }));
    fireEvent.change(screen.getByLabelText('From'), {
      target: { value: '2026-03-24T10:30' },
    });
    fireEvent.change(screen.getByLabelText('To'), {
      target: { value: '2026-03-24T12:45' },
    });

    await waitFor(() => expect(fetchAlertsPaginatedMock.mock.calls.at(-1)?.[2]?.q).toBe(
      'country:DE AND date>=2026-03-24T10:00 AND date<=2026-03-24T12:00',
    ));
    await expandAlertSearch();
    expect(screen.getByPlaceholderText('Filter alerts...')).toHaveValue(
      'country:DE AND date>=2026-03-24T10:00 AND date<=2026-03-24T12:00',
    );
  });

  test('offers quick filters for every visible filterable alert column', async () => {
    window.localStorage.setItem('crowdsec-web-ui:table-column-preferences', JSON.stringify({
      alerts: ['id', 'instance', 'region', 'city', 'machine', 'origin', 'decisions'],
    }));
    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Filters' }));
    const drawer = screen.getByRole('dialog', { name: 'Quick filters' });
    const expectedSections = ['ID', 'Instance', 'Region', 'City', 'Machine', 'Origin', 'Decisions', 'Target'];
    for (const name of expectedSections) {
      expect(within(drawer).getByRole('button', { name })).toBeInTheDocument();
    }
    const sectionNames = within(drawer).getAllByRole('button')
      .map((button) => button.textContent?.trim())
      .filter((name): name is string => Boolean(name && expectedSections.includes(name)));
    expect(sectionNames).toEqual(expectedSections);
    expect(within(drawer).queryByRole('button', { name: 'Date and time' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Target' })).not.toBeInTheDocument();
  });

  test('opens the alert search syntax help modal', async () => {
    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    await expandAlertSearch();
    const helpButton = screen.getByRole('button', { name: 'Search syntax help' });
    await userEvent.click(helpButton);

    expect(screen.getByRole('dialog', { name: 'Alert Search Syntax' })).toBeInTheDocument();
    expect(screen.getByText('date>=2026-03-23 AND date<2026-03-24')).toBeInTheDocument();
    expect(screen.getByText('ip:1.2.3.4 AND target:ssh')).toBeInTheDocument();
    expect(screen.queryByText(/origin:\(/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/machine:/i)).not.toBeInTheDocument();
  });

  test('clicking an alert syntax example fills the search input', async () => {
    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    await expandAlertSearch();
    await userEvent.click(screen.getByRole('button', { name: 'Search syntax help' }));
    await userEvent.click(screen.getByRole('button', { name: /country:germany ssh/i }));

    await waitFor(() => expect(screen.getByPlaceholderText('Filter alerts...')).toHaveValue('country:Germany ssh'));
  });

  test('clicking alert fields and operators inserts snippets into the search input', async () => {
    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    await expandAlertSearch();
    await userEvent.click(screen.getByRole('button', { name: 'Search syntax help' }));
    await userEvent.click(screen.getByRole('button', { name: 'Insert field date' }));
    await userEvent.click(screen.getByRole('button', { name: 'Search syntax help' }));
    await userEvent.click(screen.getByRole('button', { name: /^>=/ }));

    const input = screen.getByPlaceholderText('Filter alerts...');
    expect(input).toHaveValue('date>=');

    await userEvent.type(input, '2026-03-24');

    await waitFor(() => expect(screen.getByPlaceholderText('Filter alerts...')).toHaveValue('date>=2026-03-24'));
    await waitFor(() => expect(screen.getByText('date>=2026-03-24')).toBeInTheDocument());
  });

  test('alert snippet insertion ignores stale input selections while the modal has focus', async () => {
    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());

    await expandAlertSearch();
    fireEvent.click(screen.getByRole('button', { name: 'Search syntax help' }));
    fireEvent.click(screen.getByRole('button', { name: 'Insert field date' }));

    const input = screen.getByPlaceholderText('Filter alerts...') as HTMLInputElement;
    expect(input).toHaveValue('date');

    fireEvent.click(screen.getByRole('button', { name: 'Search syntax help' }));
    fireEvent.click(screen.getByRole('button', { name: /^>=/ }));

    expect(input).toHaveValue('date>=');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(input).toHaveValue('date>=');
  });

  test('reset all filters clears an advanced alert query without restoring it', async () => {
    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());

    const input = await expandAlertSearch();
    fireEvent.change(input, { target: { value: 'country:germany AND target:ssh' } });
    await flushAlertSearchDebounce();

    await waitFor(() => expect(screen.queryByText('5.6.7.8')).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Reset all filters' }));

    await waitFor(() => expect(screen.getByPlaceholderText('Filter alerts...')).toHaveValue(''));
    await waitFor(() => expect(screen.getByText('5.6.7.8')).toBeInTheDocument());
  });

  test('keeps the alerts table mounted while debounced search is loading and keeps the summary mounted', async () => {
    const user = userEvent.setup();
    const alerts: SlimAlert[] = [
      {
        id: 1,
        created_at: '2026-03-23T10:00:00.000Z',
        scenario: 'crowdsecurity/ssh-bf',
        source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
        target: 'ssh',
        meta_search: 'ssh',
        decisions: [],
      },
      {
        id: 2,
        created_at: '2026-03-23T11:00:00.000Z',
        scenario: 'crowdsecurity/nginx-bf',
        source: { ip: '5.6.7.8', value: '5.6.7.8', cn: 'US', as_name: 'AWS' },
        target: 'nginx',
        meta_search: 'aws',
        decisions: [],
      },
    ];
    const deferred = createDeferred<PaginatedResponse<SlimAlert>>();

    vi.mocked(api.fetchAlertsPaginated).mockImplementation((page, pageSize, filters) => {
      if (filters?.q === 'aws') {
        return deferred.promise;
      }

      return Promise.resolve(toPaginatedAlerts(alerts, page, pageSize, alerts.length));
    });

    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    const summary = screen.getByTestId('alerts-summary');
    expect(summary).toHaveTextContent('Showing 2 of 2 alerts');

    const input = await expandAlertSearch();
    await user.clear(input);
    await user.type(input, 'aws');

    expect(summary).toBeInTheDocument();
    expect(screen.getByText('1.2.3.4')).toBeInTheDocument();
    expect(screen.queryByText('Loading alerts...')).not.toBeInTheDocument();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    expect(screen.getByText('1.2.3.4')).toBeInTheDocument();
    expect(screen.queryByText('Loading alerts...')).not.toBeInTheDocument();

    deferred.resolve(toPaginatedAlerts([alerts[1]], 1, 50, alerts.length));

    await waitFor(() => expect(screen.queryByText('1.2.3.4')).not.toBeInTheDocument());
    expect(screen.getByText('5.6.7.8')).toBeInTheDocument();
    expect(summary).toHaveTextContent('Showing 1 of 1 alerts (2 total before filters)');
  });

  test('renders and filters range-only alerts by CIDR source value', async () => {
    vi.mocked(api.fetchConfig).mockResolvedValue({
      lookback_period: '1h',
      lookback_hours: 1,
      lookback_days: 1,
      refresh_interval: 30000,
      current_interval_name: '30s',
      lapi_status: { isConnected: true, lastCheck: null, lastError: null, offline_since: null },
      sync_status: { isSyncing: false, progress: 100, message: 'done', startedAt: null, completedAt: null },
      simulations_enabled: true,
      machine_features_enabled: false,
      origin_features_enabled: false,
    });
    vi.mocked(api.fetchAlertsPaginated).mockImplementation(async (page, pageSize, filters) => {
      const rangeAlerts: SlimAlert[] = [
        {
          id: 1,
          created_at: '2026-03-23T10:00:00.000Z',
          scenario: 'crowdsecurity/ssh-bf',
          source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
          target: 'ssh',
          meta_search: 'ssh',
          decisions: [{ id: 10, value: '1.2.3.4', type: 'ban', origin: 'manual', simulated: false, expired: false }],
        },
        {
          id: 2,
          created_at: '2026-03-23T11:00:00.000Z',
          scenario: 'crowdsecurity/nginx-bf',
          source: { ip: '5.6.7.8', value: '5.6.7.8', cn: 'US', as_name: 'AWS' },
          target: 'nginx',
          meta_search: 'nginx',
          decisions: [{ id: 20, value: '5.6.7.8', type: 'ban', origin: 'CAPI', simulated: false, expired: false }],
        },
        {
          id: 14302,
          created_at: '2026-03-24T19:47:52.000Z',
          scenario: 'manual/web-ui',
          source: { range: '192.168.5.0/24', cn: 'Unknown', as_name: 'Local Network' },
          target: 'manual',
          meta_search: '192.168.5.0/24 localhost',
          decisions: [{ id: 14302, value: '192.168.5.0/24', type: 'ban', origin: 'cscli', simulated: false, expired: false }],
        },
      ];
      const compiledSearch = filters?.q
        ? compileAlertSearch(filters.q, { machineEnabled: true, originEnabled: true })
        : null;
      const filteredAlerts = compiledSearch?.ok
        ? rangeAlerts.filter(compiledSearch.predicate)
        : rangeAlerts;
      return toPaginatedAlerts(filteredAlerts, page, pageSize, rangeAlerts.length);
    });

    render(
      <MemoryRouter initialEntries={['/alerts?q=ip:192.168.5.0/24']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Showing 1 of 1 alerts (3 total before filters)')).toBeInTheDocument());
    expect(screen.getByRole('columnheader', { name: 'IP / Range' })).toBeInTheDocument();
    expect(screen.getByText('192.168.5.0/24')).toBeInTheDocument();
    expect(screen.queryByText('1.2.3.4')).not.toBeInTheDocument();
  });

  test('shows loaded alert count when server filters still have more pages', async () => {
    const filteredAlerts = Array.from({ length: 55 }, (_, index) => ({
      id: index + 1,
      created_at: `2026-03-24T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
      scenario: 'filtered/scenario',
      source: { ip: `10.0.0.${index + 1}`, value: `10.0.0.${index + 1}`, cn: 'DE', as_name: 'Hetzner' },
      target: 'ssh',
      meta_search: 'filtered',
      decisions: [],
    }));
    vi.mocked(api.fetchAlertsPaginated).mockImplementation(async (page, pageSize) =>
      toPaginatedAlerts(filteredAlerts, page, pageSize, 60),
    );

    render(
      <MemoryRouter initialEntries={['/alerts?q=scenario:filtered/scenario']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Showing 50 of 55 alerts (60 total before filters)')).toBeInTheDocument());
    expect(screen.queryByText('10.0.0.55')).not.toBeInTheDocument();
  });

  test('loads the first alert page once when StrictMode replays mount effects', async () => {
    const alerts = [
      {
        id: 1,
        created_at: '2026-03-23T10:00:00.000Z',
        scenario: 'crowdsecurity/ssh-bf',
        source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
        target: 'ssh',
        meta_search: 'ssh',
        decisions: [],
      },
    ];
    const fetchAlertsPaginatedMock = vi.mocked(api.fetchAlertsPaginated).mockImplementation(async (page, pageSize) =>
      toPaginatedAlerts(alerts, page, pageSize, alerts.length),
    );
    fetchAlertsPaginatedMock.mockClear();

    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/alerts']}>
          <Alerts />
        </MemoryRouter>
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    expect(fetchAlertsPaginatedMock.mock.calls.filter(([page]) => page === 1)).toHaveLength(1);
  });

  test('auto-refresh preserves the already loaded alert pages', async () => {
    const triggerIntersection = installControlledIntersectionObserver();
    const pagedAlerts = Array.from({ length: 120 }, (_, index) => ({
      id: index + 1,
      created_at: `2026-03-24T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
      scenario: 'paged/scenario',
      source: { ip: `10.1.0.${index + 1}`, value: `10.1.0.${index + 1}`, cn: 'DE', as_name: 'Hetzner' },
      target: 'ssh',
      meta_search: 'paged',
      decisions: [],
    }));
    const fetchAlertsPaginatedMock = vi.mocked(api.fetchAlertsPaginated).mockImplementation(async (page, pageSize) =>
      toPaginatedAlerts(pagedAlerts, page, pageSize, pagedAlerts.length),
    );

    const { rerender } = render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Showing 50 of 120 alerts')).toBeInTheDocument());

    await act(async () => {
      triggerIntersection();
    });

    await waitFor(() => expect(screen.getByText('Showing 100 of 120 alerts')).toBeInTheDocument());
    expect(screen.getByText('10.1.0.100')).toBeInTheDocument();

    const callCountBeforeRefresh = fetchAlertsPaginatedMock.mock.calls.length;
    setRefreshSignalMock(1);

    rerender(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(fetchAlertsPaginatedMock.mock.calls.length).toBe(callCountBeforeRefresh + 1));
    expect(fetchAlertsPaginatedMock.mock.calls[callCountBeforeRefresh]?.slice(0, 2)).toEqual([1, 100]);
    expect(screen.getByText('Showing 100 of 120 alerts')).toBeInTheDocument();
    expect(screen.getByText('10.1.0.100')).toBeInTheDocument();
    expect(screen.queryByText('10.1.0.101')).not.toBeInTheDocument();
  });
});
