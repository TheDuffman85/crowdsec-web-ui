import { installControlledIntersectionObserver, setRefreshSignalMock } from './harness';
import { describe, expect, test, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import * as api from '../../../lib/api';
import { compileAlertSearch } from '../../../../../shared/search';
import { Alerts } from '../../Alerts';
import { QUICK_FILTERS_STORAGE_KEY } from '../../../lib/quickFilters';
import type { AlertSession, AlertSessionsResponse } from '../../../types';

function session(overrides: Partial<AlertSession> & { ip?: string } = {}): AlertSession {
  const { ip = '45.138.12.51', ...rest } = overrides;
  return {
    key: `default\u00000\u0000${ip}\u00002026-11-01T13:41:00.000Z`,
    alert_count: 38,
    first_seen: '2026-11-01T13:41:00.000Z',
    last_seen: '2026-11-01T13:41:53.000Z',
    scenario_groups: [
      {
        kind: 'waf',
        scenario_count: 4,
        alert_count: 33,
        scenarios: [
          { scenario: 'crowdsecurity/vpatch-git-config', count: 17 },
          { scenario: 'crowdsecurity/vpatch-env-access', count: 15 },
          { scenario: 'crowdsecurity/vpatch-laravel', count: 1 },
        ],
      },
      {
        kind: 'crowdsec',
        scenario_count: 1,
        alert_count: 5,
        scenarios: [{ scenario: 'crowdsecurity/appsec-vpatch', count: 5 }],
      },
    ],
    scenario_count: 5,
    targets: [{ value: 'example.com', count: 30 }, { value: 'www.example.com', count: 8 }],
    target_count: 2,
    decision_summary_partial: false,
    decision_alert_ids: ['900', '899'],
    latest: {
      id: 900,
      created_at: '2026-11-01T13:41:53.000Z',
      scenario: 'crowdsecurity/vpatch-git-config',
      source: { ip, value: ip, cn: 'LT', as_name: 'Tc Datacenter' },
      target: 'example.com',
      meta_search: '',
      decisions: [],
      decision_summary: { origins: [], active_count: 3, expired_count: 2, simulated_active_count: 0, simulated_expired_count: 0 },
      simulated: false,
    },
    ...rest,
  };
}

function sessionsResponse(
  data: AlertSession[],
  pagination: Partial<AlertSessionsResponse['pagination']> = {},
): AlertSessionsResponse {
  return {
    data,
    pagination: { page: 1, page_size: 50, has_more: false, total_alerts: 38, unfiltered_total_alerts: 38, ...pagination },
  };
}

// The default mock applies the search to its own rows, which belong to no session.
function mockExpandedAlerts() {
  vi.mocked(api.fetchAlertsPaginated).mockResolvedValue({
    data: [{ ...session().latest, id: 1, source: { ip: '1.2.3.4', value: '1.2.3.4' } }],
    pagination: { page: 1, page_size: 50, total: 1, total_pages: 1, unfiltered_total: 1 },
    selectable_ids: [],
  });
}

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location-search">{location.search}</output>
      <button type="button" onClick={() => navigate(-1)}>Browser back</button>
    </>
  );
}

function renderAlerts(initialEntry = '/alerts') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Alerts />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function currentParams(): URLSearchParams {
  return new URLSearchParams(screen.getByTestId('location-search').textContent || '');
}

describe('Alerts page grouped sessions', () => {
  test('keeps the raw list by default and does not request sessions', async () => {
    renderAlerts();

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());

    expect(api.fetchAlertSessionsPaginated).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Grouped by IP' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('columnheader', { name: 'Session' })).not.toBeInTheDocument();
  });

  test('toggles to sessions, remembers the choice, and stops requesting the raw list', async () => {
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session()]));
    renderAlerts();
    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    vi.mocked(api.fetchAlertsPaginated).mockClear();

    await userEvent.click(screen.getByRole('button', { name: 'Grouped by IP' }));

    expect(await screen.findByText('38 alert(s) over <1m')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Grouped by IP' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('1.2.3.4')).not.toBeInTheDocument();
    expect(api.fetchAlertsPaginated).not.toHaveBeenCalled();
    expect(currentParams().get('group')).toBe('ip');
    expect(window.localStorage.getItem('crowdsec-web-ui:alerts-grouped-by-ip')).toBe('true');
  });

  test('shows the session start in the same format as the Time column', async () => {
    window.localStorage.setItem('crowdsec-web-ui:alerts-grouped-by-ip', 'true');
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session()]));

    renderAlerts();

    const row = (await screen.findByText('38 alert(s) over <1m')).closest('tr')!;
    expect(within(row).getByText('Started')).toBeInTheDocument();
    expect(within(row).getAllByText(/^[A-Z][a-z]{2} \d{1,2}, 2026$/)).toHaveLength(2);
  });

  test('uses the stored choice when the URL does not ask for a view', async () => {
    window.localStorage.setItem('crowdsec-web-ui:alerts-grouped-by-ip', 'true');
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session()]));

    renderAlerts();

    expect(await screen.findByText('38 alert(s) over <1m')).toBeInTheDocument();
  });

  test('lets the URL override the stored choice', async () => {
    window.localStorage.setItem('crowdsec-web-ui:alerts-grouped-by-ip', 'true');

    renderAlerts('/alerts?group=none');

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    expect(api.fetchAlertSessionsPaginated).not.toHaveBeenCalled();
  });

  test('shows session totals and scenarios by kind', async () => {
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session()]));

    renderAlerts('/alerts?group=ip');

    const row = (await screen.findByText('38 alert(s) over <1m')).closest('tr')!;
    expect(screen.getByRole('columnheader', { name: 'Session' })).toBeInTheDocument();
    expect(within(row).getByText('waf')).toBeInTheDocument();
    expect(within(row).getByText('crowdsec')).toBeInTheDocument();
    expect(within(row).getByText('17x')).toBeInTheDocument();
    expect(within(row).getByText('+1 more')).toBeInTheDocument();
    expect(within(row).getByText('Active: 3')).toBeInTheDocument();
    expect(within(row).getByText('Inactive: 2')).toBeInTheDocument();
    expect(screen.getByTestId('alerts-summary')).toHaveTextContent('Showing 1 sessions from 38 alerts');
  });

  describe('expanding the scenarios of a kind', () => {
    const scenarios = ['git-config', 'env-access', 'laravel', 'wordpress', 'drupal'].map((name, index) => ({
      scenario: `crowdsecurity/vpatch-${name}`,
      count: 5 - index,
    }));

    function sessionWithScenarios(scenarioCount: number) {
      return session({
        scenario_groups: [{ kind: 'waf', scenario_count: scenarioCount, alert_count: 15, scenarios }],
      });
    }

    test('shows the remaining scenarios without another request or opening the session', async () => {
      vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([sessionWithScenarios(5)]));
      renderAlerts('/alerts?group=ip');
      const row = (await screen.findByText('38 alert(s) over <1m')).closest('tr')!;
      vi.mocked(api.fetchAlertsPaginated).mockClear();
      vi.mocked(api.fetchAlertSessionsPaginated).mockClear();
      expect(within(row).queryByText('1x')).not.toBeInTheDocument();

      await userEvent.click(within(row).getByRole('button', { name: '+2 more' }));

      expect(within(row).getByText('1x')).toBeInTheDocument();
      expect(within(row).queryByText('+2 more')).not.toBeInTheDocument();
      expect(within(row).getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('button', { name: 'Expand session 45.138.12.51' })).toHaveAttribute('aria-expanded', 'false');
      expect(api.fetchAlertsPaginated).not.toHaveBeenCalled();
      expect(api.fetchAlertSessionsPaginated).not.toHaveBeenCalled();

      await userEvent.click(within(row).getByRole('button', { name: 'Show fewer' }));

      expect(within(row).queryByText('1x')).not.toBeInTheDocument();
      expect(within(row).getByRole('button', { name: '+2 more' })).toHaveAttribute('aria-expanded', 'false');
    });

    test('keeps counting the scenarios the server left out once open', async () => {
      vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([sessionWithScenarios(8)]));
      renderAlerts('/alerts?group=ip');
      const row = (await screen.findByText('38 alert(s) over <1m')).closest('tr')!;

      await userEvent.click(within(row).getByRole('button', { name: '+5 more' }));

      expect(within(row).getByText('1x')).toBeInTheDocument();
      expect(within(row).getByText('+3 more')).toBeInTheDocument();
      expect(within(row).queryByRole('button', { name: '+3 more' })).not.toBeInTheDocument();
    });

    test('offers no toggle when every scenario already fits', async () => {
      vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([
        session({ scenario_groups: [{ kind: 'waf', scenario_count: 3, alert_count: 12, scenarios: scenarios.slice(0, 3) }] }),
      ]));
      renderAlerts('/alerts?group=ip');
      const row = (await screen.findByText('38 alert(s) over <1m')).closest('tr')!;

      expect(within(row).getByText('5x')).toBeInTheDocument();
      expect(within(row).queryByRole('button', { name: /more$/ })).not.toBeInTheDocument();
    });
  });

  test('marks decision totals that only cover part of a large session', async () => {
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([
      session({ alert_count: 5000, decision_summary_partial: true }),
    ]));

    renderAlerts('/alerts?group=ip');

    expect(await screen.findByText('Active: 3+')).toBeInTheDocument();
  });

  test('links the decision counts of a session to the decisions of its alerts', async () => {
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session()]));
    renderAlerts(`/alerts?group=ip&q=${encodeURIComponent('kind=waf')}`);
    await screen.findByText('38 alert(s) over <1m');

    const activeParams = new URL(screen.getByRole('link', { name: 'Active: 3' }).getAttribute('href')!, 'http://localhost').searchParams;
    const inactiveParams = new URL(screen.getByRole('link', { name: 'Inactive: 2' }).getAttribute('href')!, 'http://localhost').searchParams;

    expect(activeParams.get('alert_id')).toBe('900,899');
    expect(activeParams.has('q')).toBe(false);
    expect(activeParams.has('include_expired')).toBe(false);
    expect(inactiveParams.get('alert_id')).toBe('900,899');
    expect(inactiveParams.get('include_expired')).toBe('true');

    await userEvent.click(screen.getByRole('link', { name: 'Active: 3' }));

    expect(currentParams().get('alert_id')).toBe('900,899');
  });

  test('deletes every alert of the selected sessions', async () => {
    const single = session({ ip: '2.2.2.2', alert_count: 1, latest: { ...session().latest, id: 950, source: { ip: '2.2.2.2' } } });
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session(), single]));
    for (const [page, id] of [[1, 900], [2, 899]]) {
      vi.mocked(api.fetchAlertsPaginated).mockResolvedValueOnce({
        data: [{ ...session().latest, id }],
        pagination: { page, page_size: 200, total: 2, total_pages: 2, unfiltered_total: 2 },
        selectable_ids: [],
      });
    }
    renderAlerts('/alerts?group=ip');
    await screen.findByText('38 alert(s) over <1m');
    vi.mocked(api.fetchAlertsPaginated).mockClear();
    expect(screen.getByRole('button', { name: 'Delete selected' })).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select session 45.138.12.51' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select session 2.2.2.2' }));
    expect(api.fetchAlertsPaginated).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete selected' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('delete 39 selected alert(s)');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(api.bulkDeleteAlerts).toHaveBeenCalledWith(['900', '899', '950']));
    expect(api.fetchAlertsPaginated).toHaveBeenCalledTimes(2);
    const filters = vi.mocked(api.fetchAlertsPaginated).mock.lastCall?.[2];
    expect(filters?.q).toContain('ip=45.138.12.51');
    expect(filters?.q).toContain('date>=2026-11-01T13:41:00.000Z');
    expect(filters?.q).toContain('date<=2026-11-01T13:41:53.000Z');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  test('keeps the current search when deleting a session', async () => {
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session()]));
    vi.mocked(api.fetchAlertsPaginated).mockResolvedValueOnce({
      data: [{ ...session().latest, id: 900 }],
      pagination: { page: 1, page_size: 200, total: 1, total_pages: 1, unfiltered_total: 1 },
      selectable_ids: [],
    });
    renderAlerts(`/alerts?group=ip&q=${encodeURIComponent('kind=waf')}`);
    await screen.findByText('38 alert(s) over <1m');

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select session 45.138.12.51' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete selected' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(api.bulkDeleteAlerts).toHaveBeenCalled());
    expect(vi.mocked(api.fetchAlertsPaginated).mock.lastCall?.[2]?.q).toContain('kind=waf');
  });

  test('offers deleting by IP and the whole session on a multi-alert session', async () => {
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session()]));

    renderAlerts('/alerts?group=ip');

    const row = (await screen.findByText('38 alert(s) over <1m')).closest('tr')!;
    expect(within(row).getByRole('button', { name: /^Delete.*45\.138\.12\.51/ })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Delete Session' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Delete Alert' })).not.toBeInTheDocument();
  });

  test('keeps the single-alert delete on a single-alert session', async () => {
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session({ alert_count: 1 })]));

    renderAlerts('/alerts?group=ip');

    const row = (await screen.findByText('45.138.12.51')).closest('tr')!;
    expect(within(row).getByRole('button', { name: 'Delete Alert' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Delete Session' })).not.toBeInTheDocument();
  });

  test('leaves the session cell of a single-alert session empty', async () => {
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session({ alert_count: 1 })]));

    renderAlerts('/alerts?group=ip');

    const row = (await screen.findByText('45.138.12.51')).closest('tr')!;
    expect(row.children[1]).toBeEmptyDOMElement();
    expect(within(row).queryByText(/alert\(s\) over/)).not.toBeInTheDocument();
    expect(within(row).queryByText(/^Started/)).not.toBeInTheDocument();
  });

  test('deletes every alert of a session from its row and keeps other rows selected', async () => {
    const other = session({ ip: '2.2.2.2', key: 'other-session' });
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session(), other]));
    vi.mocked(api.fetchAlertsPaginated).mockResolvedValueOnce({
      data: [{ ...session().latest, id: 900 }, { ...session().latest, id: 899 }],
      pagination: { page: 1, page_size: 200, total: 2, total_pages: 1, unfiltered_total: 2 },
      selectable_ids: [],
    });
    renderAlerts('/alerts?group=ip');
    const rows = await screen.findAllByText('38 alert(s) over <1m');
    vi.mocked(api.fetchAlertsPaginated).mockClear();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select session 2.2.2.2' }));

    await userEvent.click(within(rows[0].closest('tr')!).getByRole('button', { name: 'Delete Session' }));

    const dialog = await screen.findByRole('dialog');
    expect(api.fetchAlertsPaginated).not.toHaveBeenCalled();
    expect(dialog).toHaveTextContent('Delete Session?');
    expect(dialog).toHaveTextContent('delete all 38 alert(s) in the session from 45.138.12.51');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(api.bulkDeleteAlerts).toHaveBeenCalledWith(['900', '899']));
    expect(vi.mocked(api.fetchAlertsPaginated).mock.lastCall?.[2]?.q).toContain('ip=45.138.12.51');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('checkbox', { name: 'Select session 2.2.2.2' })).toBeChecked();
  });

  test('reports a failed session delete in the dialog', async () => {
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session()]));
    vi.mocked(api.fetchAlertsPaginated).mockRejectedValueOnce({});
    renderAlerts('/alerts?group=ip');
    const row = (await screen.findByText('38 alert(s) over <1m')).closest('tr')!;

    await userEvent.click(within(row).getByRole('button', { name: 'Delete Session' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await within(dialog).findByText('Failed to delete session. Please try again.');
    expect(api.bulkDeleteAlerts).not.toHaveBeenCalled();
  });

  function pageOfAlerts(ids: number[], page: number, totalPages: number, total: number) {
    return {
      data: ids.map((id) => ({ ...session().latest, id })),
      pagination: { page, page_size: 200, total, total_pages: totalPages, unfiltered_total: total },
      selectable_ids: [],
    };
  }

  function mockSessionAlerts(total: number) {
    const totalPages = Math.ceil(total / 200);
    vi.mocked(api.fetchAlertsPaginated).mockImplementation(async (page) => pageOfAlerts(
      Array.from({ length: Math.min(200, total - (page - 1) * 200) }, (_, index) => (page - 1) * 200 + index + 1),
      page,
      totalPages,
      total,
    ));
  }

  async function confirmSessionDelete() {
    const row = (await screen.findByText('38 alert(s) over <1m')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Delete Session' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    return dialog;
  }

  test('splits a large session delete into several requests', async () => {
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session()]));
    mockSessionAlerts(4100);
    renderAlerts('/alerts?group=ip');

    await confirmSessionDelete();

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const chunks = vi.mocked(api.bulkDeleteAlerts).mock.calls.map(([ids]) => ids as string[]);
    expect(chunks.map((ids) => ids.length)).toEqual([2000, 2000, 100]);
    expect(new Set(chunks.flat()).size).toBe(4100);
  });

  test('reports the unsent alerts when a later delete request fails', async () => {
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session()]));
    mockSessionAlerts(4100);
    vi.mocked(api.bulkDeleteAlerts)
      .mockResolvedValueOnce({ requested_alerts: 2000, requested_decisions: 0, deleted_alerts: 2000, deleted_decisions: 0, failed: [] })
      .mockRejectedValueOnce(new Error('Network down'));
    renderAlerts('/alerts?group=ip');

    await confirmSessionDelete();

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.bulkDeleteAlerts).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(/2000.*2100/)).toBeInTheDocument();
  });

  test('keeps the dialog open when the first delete request fails', async () => {
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session()]));
    mockSessionAlerts(4100);
    vi.mocked(api.bulkDeleteAlerts).mockRejectedValueOnce({});
    renderAlerts('/alerts?group=ip');

    const dialog = await confirmSessionDelete();

    await within(dialog).findByText('Failed to delete session. Please try again.');
    expect(api.bulkDeleteAlerts).toHaveBeenCalledTimes(1);
  });

  test('refreshes without a delete request when a session is already gone', async () => {
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session()]));
    vi.mocked(api.fetchAlertsPaginated).mockResolvedValueOnce(pageOfAlerts([], 1, 0, 0));
    renderAlerts('/alerts?group=ip');
    const row = (await screen.findByText('38 alert(s) over <1m')).closest('tr')!;
    vi.mocked(api.fetchAlertSessionsPaginated).mockClear();
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([]));
    // A reload within 250ms of the previous one is skipped.
    await new Promise((resolve) => setTimeout(resolve, 260));

    await userEvent.click(within(row).getByRole('button', { name: 'Delete Session' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.bulkDeleteAlerts).not.toHaveBeenCalled();
    expect(api.fetchAlertSessionsPaginated).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText('38 alert(s) over <1m')).not.toBeInTheDocument());
  });

  test('pins the actions column and tightens the cells only while grouped', async () => {
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session()]));
    mockExpandedAlerts();
    renderAlerts('/alerts?group=ip');

    const row = (await screen.findByText('38 alert(s) over <1m')).closest('tr')!;
    expect(row.lastElementChild).toHaveClass('lg:sticky', 'lg:end-0');
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toHaveClass('lg:sticky', 'lg:end-0');
    expect(screen.getByRole('table')).toHaveClass('[&_td]:px-3', '[&_td]:align-top');

    await userEvent.click(screen.getByRole('button', { name: 'Grouped by IP' }));

    await screen.findByText('1.2.3.4');
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toHaveClass('lg:sticky', 'lg:end-0');
    expect(screen.getByRole('table')).not.toHaveClass('[&_td]:px-3');
    expect(screen.getByRole('table')).not.toHaveClass('[&_td]:align-top');
  });

  test('stacks each scenario below its kind instead of sharing a line', async () => {
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session()]));

    renderAlerts('/alerts?group=ip');

    const row = (await screen.findByText('38 alert(s) over <1m')).closest('tr')!;
    const kind = within(row).getByText('waf');
    const scenario = within(row).getByText('17x').parentElement!;
    expect(kind.tagName).toBe('DIV');
    expect(kind.parentElement).toBe(scenario.parentElement);
    expect(kind).not.toContainElement(scenario);
    expect(kind.parentElement).not.toHaveClass('flex');
  });

  test.each([
    ['IPv4', '45.138.12.51'],
    ['IPv6', '2602:80d:1008::c1'],
  ])('expands the raw alerts of a session by %s without changing the page filters', async (_label, ip) => {
    mockExpandedAlerts();
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session({ ip })]));
    renderAlerts('/alerts?group=ip');
    await screen.findByText('38 alert(s) over <1m');
    const storedFilters = window.localStorage.getItem(QUICK_FILTERS_STORAGE_KEY);
    const search = screen.getByTestId('location-search').textContent;
    vi.mocked(api.fetchAlertsPaginated).mockClear();
    vi.mocked(api.fetchAlertSessionsPaginated).mockClear();

    await userEvent.click(screen.getByText('38 alert(s) over <1m'));

    expect(await screen.findByText('1.2.3.4')).toBeInTheDocument();
    expect(screen.getByText('38 alert(s) over <1m')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Collapse session ${ip}` })).toHaveAttribute('aria-expanded', 'true');
    expect(api.fetchAlertsPaginated).toHaveBeenCalledTimes(1);
    const [page, pageSize, filters] = vi.mocked(api.fetchAlertsPaginated).mock.lastCall!;
    const query = filters?.q || '';
    expect([page, pageSize]).toEqual([1, 50]);
    expect(query).toMatch(new RegExp(`ip="?${ip}"?( |$)`));
    expect(query).toContain('date>=2026-11-01T13:41:00.000Z');
    expect(query).toContain('date<=2026-11-01T13:41:53.000Z');
    expect(query).toContain('sim=live');
    expect(compileAlertSearch(query, { machineEnabled: true, originEnabled: true }).ok).toBe(true);
    expect(screen.getByTestId('location-search').textContent).toBe(search);
    expect(window.localStorage.getItem(QUICK_FILTERS_STORAGE_KEY)).toBe(storedFilters);
    expect(api.fetchAlertSessionsPaginated).not.toHaveBeenCalled();
  });

  test('collapses an expanded session without another request', async () => {
    mockExpandedAlerts();
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session()]));
    renderAlerts('/alerts?group=ip');
    await userEvent.click(await screen.findByRole('button', { name: 'Expand session 45.138.12.51' }));
    await screen.findByText('1.2.3.4');
    vi.mocked(api.fetchAlertsPaginated).mockClear();

    await userEvent.click(screen.getByRole('button', { name: 'Collapse session 45.138.12.51' }));

    expect(screen.queryByText('1.2.3.4')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand session 45.138.12.51' })).toHaveAttribute('aria-expanded', 'false');
    expect(api.fetchAlertsPaginated).not.toHaveBeenCalled();
  });

  test('keeps existing filters when expanding a session', async () => {
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session()]));
    renderAlerts(`/alerts?group=ip&q=${encodeURIComponent('kind=waf')}`);
    await screen.findByText('38 alert(s) over <1m');
    vi.mocked(api.fetchAlertsPaginated).mockClear();

    await userEvent.click(screen.getByText('38 alert(s) over <1m'));

    await waitFor(() => expect(api.fetchAlertsPaginated).toHaveBeenCalled());
    expect(vi.mocked(api.fetchAlertsPaginated).mock.lastCall?.[2]?.q).toContain('kind=waf');
    expect(currentParams().get('q')).toBe('kind=waf');
  });

  test('loads more alerts of a session on request and skips rows that shifted between pages', async () => {
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session()]));
    renderAlerts('/alerts?group=ip');
    await screen.findByText('38 alert(s) over <1m');
    const alert = (id: number) => ({ ...session().latest, id, source: { ip: `10.0.0.${id}` } });
    vi.mocked(api.fetchAlertsPaginated).mockClear();
    vi.mocked(api.fetchAlertsPaginated)
      .mockResolvedValueOnce({
        data: [alert(3), alert(2)],
        pagination: { page: 1, page_size: 50, total: 4, total_pages: 2, unfiltered_total: 4 },
        selectable_ids: [],
      })
      .mockResolvedValueOnce({
        data: [alert(2), alert(1)],
        pagination: { page: 2, page_size: 50, total: 4, total_pages: 2, unfiltered_total: 4 },
        selectable_ids: [],
      });

    await userEvent.click(screen.getByText('38 alert(s) over <1m'));
    await userEvent.click(await screen.findByRole('button', { name: 'Show more (2 remaining)' }));

    await screen.findByText('10.0.0.1');
    expect(screen.getAllByText('10.0.0.2')).toHaveLength(1);
    expect(vi.mocked(api.fetchAlertsPaginated).mock.lastCall?.slice(0, 2)).toEqual([2, 50]);
    expect(screen.getByRole('button', { name: 'Show more (1 remaining)' })).toBeInTheDocument();
  });

  test('opens the details of an expanded alert and deletes only that alert', async () => {
    mockExpandedAlerts();
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session()]));
    renderAlerts('/alerts?group=ip');
    await userEvent.click(await screen.findByText('38 alert(s) over <1m'));
    const row = (await screen.findByText('1.2.3.4')).closest('tr')!;

    expect(within(row).getByRole('button', { name: 'Delete Alert' })).toBeInTheDocument();
    expect(within(row).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(row.lastElementChild).toHaveClass('lg:sticky', 'lg:end-0');

    await userEvent.click(within(row).getByText('1.2.3.4'));

    await waitFor(() => expect(api.fetchAlert).toHaveBeenCalledWith(1, undefined));
    expect(screen.getByText('38 alert(s) over <1m')).toBeInTheDocument();
  });

  test('reports a failed session load in the table and retries it', async () => {
    mockExpandedAlerts();
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session()]));
    renderAlerts('/alerts?group=ip');
    await screen.findByText('38 alert(s) over <1m');
    vi.mocked(api.fetchAlertsPaginated).mockRejectedValueOnce(new Error('offline'));

    await userEvent.click(screen.getByText('38 alert(s) over <1m'));
    expect(await screen.findByText('Failed to load the alerts of this session.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('1.2.3.4')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load the alerts of this session.')).not.toBeInTheDocument();
  });

  describe('refreshing expanded sessions', () => {
    const other = session({ ip: '2.2.2.2', key: 'other-session' });

    async function renderWithTwoExpandedSessions() {
      mockExpandedAlerts();
      vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session(), other]));
      const { rerender } = renderAlerts('/alerts?group=ip');
      await userEvent.click(await screen.findByRole('button', { name: 'Expand session 45.138.12.51' }));
      await userEvent.click(screen.getByRole('button', { name: 'Expand session 2.2.2.2' }));
      await waitFor(() => expect(screen.getAllByText('1.2.3.4')).toHaveLength(2));
      vi.mocked(api.fetchAlertsPaginated).mockClear();
      vi.mocked(api.fetchAlertSessionsPaginated).mockClear();
      return async () => {
        setRefreshSignalMock(1);
        rerender(
          <MemoryRouter initialEntries={['/alerts?group=ip']}>
            <Alerts />
            <LocationProbe />
          </MemoryRouter>,
        );
        await waitFor(() => expect(api.fetchAlertSessionsPaginated).toHaveBeenCalled());
      };
    }

    test('sends no alert requests while the sessions are unchanged', async () => {
      const refresh = await renderWithTwoExpandedSessions();

      await refresh();
      await act(async () => { await Promise.resolve(); });

      expect(api.fetchAlertsPaginated).not.toHaveBeenCalled();
      expect(screen.getAllByText('1.2.3.4')).toHaveLength(2);
    });

    test('reads only the session that changed', async () => {
      const refresh = await renderWithTwoExpandedSessions();
      vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([
        session({ alert_count: 40, last_seen: '2026-11-01T13:45:00.000Z' }),
        other,
      ]));

      await refresh();

      await waitFor(() => expect(api.fetchAlertsPaginated).toHaveBeenCalledTimes(1));
      const filters = vi.mocked(api.fetchAlertsPaginated).mock.lastCall?.[2];
      expect(filters?.q).toContain('ip=45.138.12.51');
      expect(filters?.q).toContain('date<=2026-11-01T13:45:00.000Z');
      expect(screen.getByRole('button', { name: 'Collapse session 2.2.2.2' })).toBeInTheDocument();
    });
  });

  test('closes an expanded session once the refreshed list no longer has it', async () => {
    mockExpandedAlerts();
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session()]));
    const { rerender } = renderAlerts('/alerts?group=ip');
    await userEvent.click(await screen.findByText('38 alert(s) over <1m'));
    await screen.findByText('1.2.3.4');

    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session({ alert_count: 1, latest: { ...session().latest, source: { ip: '45.138.12.51' } } })]));
    setRefreshSignalMock(1);
    rerender(
      <MemoryRouter initialEntries={['/alerts?group=ip']}>
        <Alerts />
        <LocationProbe />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.queryByText('1.2.3.4')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /(Expand|Collapse) session/ })).not.toBeInTheDocument();
  });

  test('hides the refreshing indicator when a view switch replaces a running refresh', async () => {
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session()]));
    const { rerender } = renderAlerts('/alerts?group=ip');
    await screen.findByText('38 alert(s) over <1m');

    vi.mocked(api.fetchAlertSessionsPaginated).mockImplementation(() => new Promise(() => undefined));
    setRefreshSignalMock(1);
    rerender(
      <MemoryRouter initialEntries={['/alerts?group=ip']}>
        <Alerts />
        <LocationProbe />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Refreshing...')).toHaveClass('opacity-100'));

    await userEvent.click(screen.getByRole('button', { name: 'Grouped by IP' }));

    await screen.findByText('1.2.3.4');
    await waitFor(() => expect(screen.getByText('Refreshing...')).toHaveClass('opacity-0'));
  });

  test('opens the details of a single-alert session without changing the view', async () => {
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session({ alert_count: 1 })]));
    renderAlerts('/alerts?group=ip');

    await userEvent.click(await screen.findByText('45.138.12.51'));

    await waitFor(() => expect(api.fetchAlert).toHaveBeenCalledWith(900, undefined));
    expect(currentParams().get('group')).toBe('ip');
    expect(screen.queryByRole('button', { name: /Expand session/ })).not.toBeInTheDocument();
  });

  test('shows an open-ended count and loads the next page while more sessions exist', async () => {
    const triggerIntersection = installControlledIntersectionObserver();
    const first = session({ ip: '1.1.1.1' });
    const second = session({ ip: '2.2.2.2' });
    vi.mocked(api.fetchAlertSessionsPaginated).mockImplementation(async (page) => (page === 1
      ? sessionsResponse([first], { has_more: true })
      // The first row shifted onto page 2 between the two requests.
      : sessionsResponse([first, second], { page: 2 })));
    renderAlerts('/alerts?group=ip');

    await screen.findByText('1.1.1.1');
    expect(screen.getByTestId('alerts-summary')).toHaveTextContent('Showing 1+ sessions from 38 alerts');

    await act(async () => { triggerIntersection(); });

    await screen.findByText('2.2.2.2');
    expect(screen.getAllByText('1.1.1.1')).toHaveLength(1);
    expect(screen.getByTestId('alerts-summary')).toHaveTextContent('Showing 2 sessions from 38 alerts');
  });

  test('passes the active filters to the session request', async () => {
    renderAlerts(`/alerts?group=ip&q=${encodeURIComponent('kind=waf')}`);

    await waitFor(() => expect(api.fetchAlertSessionsPaginated).toHaveBeenCalled());
    expect(vi.mocked(api.fetchAlertSessionsPaginated).mock.lastCall?.[2]).toMatchObject({ q: 'kind=waf', instance: 'all' });
  });

  test('refreshes loaded sessions in place', async () => {
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session()]));
    const { rerender } = renderAlerts('/alerts?group=ip');
    await screen.findByText('38 alert(s) over <1m');

    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session({ alert_count: 40 })]));
    setRefreshSignalMock(1);
    rerender(
      <MemoryRouter initialEntries={['/alerts?group=ip']}>
        <Alerts />
        <LocationProbe />
      </MemoryRouter>,
    );

    expect(await screen.findByText('40 alert(s) over <1m')).toBeInTheDocument();
    expect(screen.queryByText('38 alert(s) over <1m')).not.toBeInTheDocument();
  });

  test('returns to the raw list when grouping is turned off', async () => {
    vi.mocked(api.fetchAlertSessionsPaginated).mockResolvedValue(sessionsResponse([session()]));
    renderAlerts('/alerts?group=ip');
    await screen.findByText('38 alert(s) over <1m');

    await userEvent.click(screen.getByRole('button', { name: 'Grouped by IP' }));

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    expect(screen.queryByText('38 alert(s) over <1m')).not.toBeInTheDocument();
    expect(currentParams().get('group')).toBe('none');
    expect(window.localStorage.getItem('crowdsec-web-ui:alerts-grouped-by-ip')).toBe('false');
  });
});
