import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Statistics } from '../Statistics';
import { StatisticsSettings } from '../../components/StatisticsSettings';
import { I18nContext, type I18nContextValue } from '../../lib/i18n';
import { addDecision, addDecisions, checkAllowlist, fetchConfig } from '../../lib/api';
import { sessionFetch } from '../../lib/sessionFetch';
import en from '../../locales/en.json';
import type { ConfigResponse } from '../../types';
import { DEFAULT_STATISTICS_SETTINGS, type StatisticsConfiguration, type StatisticsResponse } from '../../../../shared/statistics';

vi.mock('../../lib/api', () => ({ fetchConfig: vi.fn(), addDecision: vi.fn(), addDecisions: vi.fn(), checkAllowlist: vi.fn() }));
vi.mock('../../lib/sessionFetch', () => ({ sessionFetch: vi.fn() }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null, Legend: () => null, Line: () => null, Bar: () => null,
}));
const i18n: I18nContextValue = { language: 'en', preference: 'en', browserLanguage: 'en', setLanguagePreference: () => {}, t: (key, values = {}) => Object.entries(values).reduce((message, [name, value]) => message.replaceAll(`{${name}}`, String(value)), (en as Record<string, string>)[key] || key) };
const configuration: StatisticsConfiguration = { settings: { ...DEFAULT_STATISTICS_SETTINGS, enabled: true }, managed: {}, status: { running: false, lastSuccess: '2026-11-07T12:00:00Z', backlog: 0, backfillPending: false, error: null, revision: 1 } };
function payload(): StatisticsResponse {
  return {
    filters: { from: '2026-10-09', to: '2026-11-07', instance: 'all', simulation: 'live', limit: 10 }, revision: 1, configuration,
    coverage: { from: '2026-11-01T00:00:00Z', through: '2026-11-07T12:00:00Z', partial: true, comparisonPartial: true },
    totals: { alerts: 12, events: 48, uniqueIPs: 1, bans: 2, decisions: 3, repeatAttackers: 1, bannedIPs: 1, returnedAfterBan: 0, newIPs: null },
    previousTotals: null,
    attackers: [{ value: '192.0.2.7', label: '192.0.2.7', alerts: 12, events: 48, uniqueIPs: 1, bans: 2, machines: 1, activeDays: 3, firstActivity: '2026-11-01T10:00:00Z', lastActivity: '2026-11-07T11:00:00Z', country: 'DE', asn: '42', network: 'Example', scenarios: [{ label: 'ssh', count: 12 }], targetedMachines: [{ value: '["default","m-1"]', label: 'Server one', count: 12 }] }],
    machines: [{ value: '["default","m-1"]', label: 'Server one', instance: 'default', machineId: 'm-1', alerts: 12, events: 48, uniqueIPs: 1, bans: 2, machines: 1, activeDays: 3, firstActivity: null, lastActivity: null, country: 'DE', asn: '42', network: 'Example', scenarios: [], targetedMachines: [] }],
    series: [{ date: '2026-10-09', alerts: null, decisions: null }], granularity: 'day', scenarios: [{ label: 'ssh', count: 12, uniqueIPs: 1, machines: 1, bans: 2, bannedIPs: 1, previous: null }], countries: [], networks: [], decisionTypes: [], decisionOrigins: [], increases: [], quietMachines: [],
  };
}
function Location() { const location = useLocation(); return <output data-testid="location">{location.pathname}{location.search}</output>; }
function mount(content = <Statistics />, url = '/statistics?from=2026-10-09&to=2026-11-07') {
  return render(<I18nContext.Provider value={i18n}><MemoryRouter initialEntries={[url]}>{content}<Location /></MemoryRouter></I18nContext.Provider>);
}
beforeEach(() => {
  vi.mocked(fetchConfig).mockResolvedValue({ statistics: configuration, lookback_days: 7, instances: [{ id: 'default', name: 'Production' }] } as ConfigResponse);
  vi.mocked(sessionFetch).mockImplementation(async () => Response.json(payload()));
});
afterEach(() => { vi.clearAllMocks(); localStorage.clear(); });

describe('Statistics page', () => {
  test('shows rankings, missing coverage and unavailable comparison without treating gaps as zeros', async () => {
    mount();
    expect(await screen.findByText('Top IPs')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '192.0.2.7' })).toBeInTheDocument();
    // Like on the Alerts page, the ban action has its own column.
    const topIps = screen.getByRole('button', { name: '192.0.2.7' }).closest('table')!;
    expect(within(topIps).getByRole('columnheader', { name: 'Actions' })).toBeInTheDocument();
    expect(within(topIps).getByRole('button', { name: 'Ban' }).closest('td')).toBe(within(topIps).getAllByRole('cell').at(-1));
    // With one instance, Top Machines does not name it, like the rest of the app.
    expect(screen.queryByText('Production')).not.toBeInTheDocument();
    expect(screen.getByText(/Counts reflect observed data/)).toBeInTheDocument();
    expect(screen.getByText(/complete preceding period/)).toBeInTheDocument();
    expect(sessionFetch).toHaveBeenCalledWith(expect.stringContaining('/api/statistics?'), expect.anything());
  });

  test('keeps ranking limits and attacker/machine filters in the URL and builds UTC investigation links', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '192.0.2.7' }));
    await screen.findByRole('link', { name: 'View Alerts' });
    expect(screen.getByTestId('location').textContent).toContain('ip=192.0.2.7');
    fireEvent.change(screen.getByRole('combobox', { name: 'Rankings' }), { target: { value: '50' } });
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('limit=50'));
    await screen.findByRole('button', { name: '192.0.2.7' });
    const link = screen.getByRole('link', { name: 'View Alerts' });
    const target = new URL(link.getAttribute('href')!, 'http://localhost');
    expect(target.pathname).toBe('/alerts');
    expect(target.searchParams.get('q')).toContain('date>=2026-10-09T00:00:00Z AND date<2026-11-08T00:00:00Z');
    expect(target.searchParams.get('q')).toContain('ip="192.0.2.7"');
    expect(target.searchParams.get('simulation')).toBe('live');
    fireEvent.click(screen.getAllByRole('button', { name: 'Server one' })[0]);
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('machine='));
  });

  test('turns the statistics into findings and compares tiles only with a complete preceding period', async () => {
    const data = payload();
    const web = '["default","m-2"]';
    vi.mocked(sessionFetch).mockImplementation(async () => Response.json({
      ...data,
      coverage: { ...data.coverage, partial: false, comparisonPartial: false },
      totals: { ...data.totals, alerts: 200, uniqueIPs: 40, bannedIPs: 30, returnedAfterBan: 4, newIPs: 25 },
      previousTotals: { alerts: 100, bans: 2, decisions: 3, uniqueIPs: 40, bannedIPs: 20, repeatAttackers: 1 },
      scenarios: [
        { label: 'crowdsecurity/http-probing', count: 150, uniqueIPs: 30, machines: 2, bans: 0, bannedIPs: 0, previous: 0 },
        { label: 'crowdsecurity/ssh-bf', count: 50, uniqueIPs: 10, machines: 1, bans: 30, bannedIPs: 10, previous: 50 },
      ],
      networks: [{ label: 'Example Cloud', count: 120, uniqueIPs: 25 }],
      quietMachines: [{ value: web, label: 'Web', previous: 80 }],
      increases: [{ value: '["default","m-1"]', label: 'Server one', current: 60, previous: 10, change: 50 }],
    } satisfies StatisticsResponse));
    mount();
    expect(await screen.findByText(/Web raised no alerts in this period, after 80/)).toBeInTheDocument();
    expect(screen.getByText(/crowdsecurity\/http-probing raised 150 alerts from 30 IPs without a single ban/)).toBeInTheDocument();
    expect(screen.getByText(/4 IPs attacked again on a later day after being banned/)).toBeInTheDocument();
    expect(screen.getByText(/Server one received 60 alerts, up from 10/)).toBeInTheDocument();
    expect(screen.getByText(/New attack type: crowdsecurity\/http-probing/)).toBeInTheDocument();
    expect(screen.getByText(/Example Cloud accounts for 60% of all alerts, from 25 IPs/)).toBeInTheDocument();
    // Alerts doubled; ban coverage rose from 50% to 75%.
    expect(screen.getByText('+100%')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('+25 pp')).toBeInTheDocument();
    expect(screen.getByText('25 not seen before')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Web/ })).toBeDisabled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Show scenario' })[0]);
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('scenario=crowdsecurity%2Fhttp-probing'));
    const link = await screen.findByRole('link', { name: 'View Alerts' });
    expect(new URL(link.getAttribute('href')!, 'http://localhost').searchParams.get('q')).toContain('scenario="crowdsecurity/http-probing"');
    expect(String(vi.mocked(sessionFetch).mock.calls.at(-1)?.[0])).toContain('scenario=crowdsecurity%2Fhttp-probing');
  });

  test('expands findings into loaded details and bans from them with the decision dialog', async () => {
    const data = payload();
    const detailUrls: string[] = [];
    vi.mocked(checkAllowlist).mockResolvedValue({ results: [] } as never);
    vi.mocked(addDecision).mockResolvedValue({ results: [{ instance_id: 'default', instance_name: 'Production', success: true }] } as never);
    vi.mocked(sessionFetch).mockImplementation(async (url) => {
      if (String(url).includes('/api/statistics/details')) {
        detailUrls.push(String(url));
        const query = new URLSearchParams(String(url).split('?')[1]);
        if (query.get('kind') === 'returned') return Response.json({ kind: 'returned', ips: [{ ip: '203.0.113.9', alerts: 7, bans: 1, machines: 1, activeDays: 3, country: 'DE', asn: '42', network: 'Example', lastActivity: '2026-11-06T10:00:00Z', firstBan: '2026-11-02', bannedBefore: false }], total: 1 });
        return Response.json({ kind: 'ips', ranges: [{ range: '198.51.100.0/24', ips: 6, alerts: 40 }], rangeTotal: 1, ips: [], total: 0 });
      }
      return Response.json({
        ...data,
        totals: { ...data.totals, alerts: 200, returnedAfterBan: 1 },
        scenarios: [{ label: 'crowdsecurity/vpatch-env-access', count: 709, uniqueIPs: 93, machines: 1, bans: 0, bannedIPs: 0, previous: null }],
        networks: [{ label: 'Example Cloud', count: 120, uniqueIPs: 25 }],
      } satisfies StatisticsResponse);
    });
    mount();
    // AppSec blocks in-band, so it is not reported as a missing remediation.
    expect(await screen.findByText(/crowdsecurity\/vpatch-env-access \(AppSec\) blocked 709 requests from 93 IPs/)).toBeInTheDocument();
    expect(screen.queryByText(/without a single ban/)).not.toBeInTheDocument();

    const returned = screen.getByText(/1 IPs attacked again/).closest('li')!;
    fireEvent.click(within(returned).getByRole('button', { name: 'Show details' }));
    expect(await within(returned).findByText('203.0.113.9')).toBeInTheDocument();
    expect(within(returned).getByRole('link', { name: 'Learn more' })).toHaveAttribute('href', expect.stringContaining('#duration_expr'));
    // The preceding period is incomplete, so earlier bans are not searched.
    expect(new URLSearchParams(detailUrls[0].split('?')[1]).get('history')).toBeNull();
    fireEvent.click(within(returned).getByRole('button', { name: 'Ban' }));
    expect(await screen.findByLabelText('Duration')).toHaveValue('7d');
    expect(screen.getByLabelText('IP / Range')).toHaveValue('203.0.113.9');
    fireEvent.click(screen.getByRole('button', { name: 'Add Decision' }));
    expect(await within(returned).findByText('Decision added')).toBeInTheDocument();
    expect(addDecision).toHaveBeenCalledWith(expect.objectContaining({ ip: '203.0.113.9', duration: '7d', reason: 'Returned after ban' }));

    const network = screen.getByText(/Example Cloud accounts for 60%/).closest('li')!;
    fireEvent.click(within(network).getByRole('button', { name: 'Show details' }));
    fireEvent.click(await within(network).findByRole('button', { name: 'Block range' }));
    expect(await screen.findByLabelText('IP / Range')).toHaveValue('198.51.100.0/24');
    expect(screen.getByLabelText('Duration')).toHaveValue('24h');
    expect(new URLSearchParams(detailUrls.at(-1)!.split('?')[1]).get('network')).toBe('Example Cloud');
  });

  test('bans every listed IP of a finding at once and offers to bypass the allowlist for skipped ones', async () => {
    const data = payload();
    const ip = (value: string) => ({ ip: value, alerts: 7, bans: 1, machines: 1, activeDays: 3, country: 'DE', asn: '42', network: 'Example', lastActivity: '2026-11-06T10:00:00Z', firstBan: '2026-11-02', bannedBefore: false });
    const results = [{ instance_id: 'default', instance_name: 'Production', success: true }];
    vi.mocked(addDecisions)
      .mockResolvedValueOnce({ added: ['203.0.113.9', '203.0.113.11'], allowlisted: [{ value: '203.0.113.10', allowlisted: [{ instance_id: 'default', instance_name: 'Production', reason: 'office' }] }], results, succeeded: 1, failed: 0 })
      .mockResolvedValueOnce({ added: ['203.0.113.10'], allowlisted: [], results, succeeded: 1, failed: 0 });
    vi.mocked(sessionFetch).mockImplementation(async (url) => {
      if (String(url).includes('/api/statistics/details')) {
        // 30 matches: the first request lists 25, "Show more" asks for the rest.
        const size = Number(new URLSearchParams(String(url).split('?')[1]).get('size'));
        if (size !== 25) return Response.json({ kind: 'returned', ips: Array.from({ length: 30 }, (_, index) => ip(`203.0.113.${index + 9}`)), total: 30 });
        return Response.json({ kind: 'returned', ips: [ip('203.0.113.9'), ip('203.0.113.10'), ip('203.0.113.11')], total: 30 });
      }
      return Response.json({ ...data, totals: { ...data.totals, returnedAfterBan: 3 } } satisfies StatisticsResponse);
    });
    mount();
    const returned = (await screen.findByText(/3 IPs attacked again/)).closest('li')!;
    fireEvent.click(within(returned).getByRole('button', { name: 'Show details' }));
    expect(await within(returned).findByText('Showing 3 of 30')).toBeInTheDocument();
    fireEvent.click(await within(returned).findByRole('button', { name: 'Ban all (3)' }));
    expect(await screen.findByText('Values (3)')).toBeInTheDocument();
    expect(screen.getByLabelText('Duration')).toHaveValue('7d');
    fireEvent.click(screen.getByRole('button', { name: 'Add 3 Decisions' }));

    expect(await screen.findByText('1 allowlisted values were skipped')).toBeInTheDocument();
    expect(addDecisions).toHaveBeenCalledWith(expect.objectContaining({ values: ['203.0.113.9', '203.0.113.10', '203.0.113.11'], duration: '7d', reason: 'Returned after ban' }));
    expect(screen.getByText('Added decisions for 2 values.')).toBeInTheDocument();
    expect(within(returned).getAllByText('Decision added')).toHaveLength(2);
    const submit = screen.getByRole('button', { name: 'Add 1 Decisions' });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Bypass allowlist'));
    fireEvent.click(submit);
    await waitFor(() => expect(screen.queryByText('Values (1)')).not.toBeInTheDocument());
    expect(addDecisions).toHaveBeenLastCalledWith(expect.objectContaining({ values: ['203.0.113.10'], bypass_allowlist: true }));
    expect(within(returned).getAllByText('Decision added')).toHaveLength(3);
    expect(within(returned).queryByRole('button', { name: /Ban all/ })).not.toBeInTheDocument();

    fireEvent.click(within(returned).getByRole('button', { name: 'Show 25 more' }));
    expect(await within(returned).findByRole('button', { name: 'Ban all (27)' })).toBeInTheDocument();
    expect(within(returned).queryByText(/^Showing/)).not.toBeInTheDocument();
  });

  test('compares machine activity with the preceding period as bars on one scale', async () => {
    const data = payload();
    vi.mocked(fetchConfig).mockResolvedValue({ statistics: configuration, lookback_days: 7, instances: [{ id: 'default', name: 'Production' }, { id: 'edge', name: 'Edge' }] } as ConfigResponse);
    vi.mocked(sessionFetch).mockImplementation(async () => Response.json({
      ...data,
      coverage: { ...data.coverage, comparisonPartial: false },
      previousTotals: { alerts: 600, bans: 2, decisions: 3, uniqueIPs: 1, bannedIPs: 1, repeatAttackers: 1 },
      increases: [{ value: '["edge","proxy-02"]', label: 'proxy-02', current: 1896, previous: 366, change: 1530 }],
      quietMachines: [{ value: '["default","dev-bastion"]', label: 'dev-bastion', previous: 120 }],
    } satisfies StatisticsResponse));
    mount();
    const increase = await screen.findByRole('button', { name: /^proxy-02: 366 alerts in the preceding period, 1\D?896 in the selected period$/ });
    expect(within(increase).getByText('+418%')).toBeInTheDocument();
    expect(within(increase).getByText('Edge')).toBeInTheDocument();
    expect(within(increase).getByText(/^1\D?896 alerts$/)).toBeInTheDocument();
    const quiet = screen.getByRole('button', { name: 'dev-bastion: 120 alerts in the preceding period, 0 in the selected period' });
    expect(quiet).toBeDisabled();
    expect(within(quiet).getByText('−100%')).toBeInTheDocument();
    expect(screen.getByText('Preceding period')).toBeInTheDocument();
  });

  test('does not compare or report period changes without a complete preceding period', async () => {
    mount();
    expect(await screen.findByText('No notable findings for this period.')).toBeInTheDocument();
    expect(screen.queryByText(/vs. preceding period/)).not.toBeInTheDocument();
  });

  test('shows disabled collection and API failures without inventing empty statistics', async () => {
    vi.mocked(fetchConfig).mockResolvedValue({ statistics: { ...configuration, settings: { ...configuration.settings, enabled: false } } } as ConfigResponse);
    vi.mocked(sessionFetch).mockResolvedValue(Response.json({ error: 'Unavailable' }, { status: 503 }));
    mount();
    expect(await screen.findByText(/Collection is disabled/)).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Statistics are unavailable');
    expect(screen.queryByText('Top IPs')).not.toBeInTheDocument();
  });
});

describe('Statistics selection', () => {
  const lastQuery = () => new URLSearchParams(String(vi.mocked(sessionFetch).mock.calls.at(-1)?.[0]).split('?')[1]);

  test('remembers a preset by name, mode and ranking limit across visits', async () => {
    const first = mount(<Statistics />, '/statistics');
    fireEvent.click(await screen.findByRole('button', { name: 'Last 7 days' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('range=7'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Mode' }), { target: { value: 'all' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Rankings' }), { target: { value: '20' } });
    await waitFor(() => expect(JSON.parse(localStorage.getItem('statistics_selection')!)).toEqual({ preset: '7', simulation: 'all', limit: '20' }));
    first.unmount();

    vi.mocked(sessionFetch).mockClear();
    mount(<Statistics />, '/statistics');
    expect(await screen.findByRole('button', { name: 'Last 7 days' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(sessionFetch).toHaveBeenCalled());
    const today = new Date().toISOString().slice(0, 10);
    expect(lastQuery().get('to')).toBe(today);
    expect(lastQuery().get('from')).toBe(new Date(Date.parse(today) - 6 * 86_400_000).toISOString().slice(0, 10));
    expect(lastQuery().get('simulation')).toBe('all');
    expect(lastQuery().get('limit')).toBe('20');
  });

  test('offers only presets that fit the retention', async () => {
    mount(<Statistics />, '/statistics');
    expect(await screen.findByRole('button', { name: 'Last 90 days' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Last 365 days' })).not.toBeInTheDocument();
  });

  test('restores a custom date range and lets the URL override it', async () => {
    localStorage.setItem('statistics_selection', JSON.stringify({ from: '2026-09-01', to: '2026-09-15', simulation: 'simulated', limit: '50' }));
    const first = mount(<Statistics />, '/statistics');
    await waitFor(() => expect(sessionFetch).toHaveBeenCalled());
    expect(lastQuery().get('from')).toBe('2026-09-01');
    expect(lastQuery().get('to')).toBe('2026-09-15');
    expect(lastQuery().get('simulation')).toBe('simulated');
    expect(screen.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'false');
    first.unmount();

    vi.mocked(sessionFetch).mockClear();
    mount(<Statistics />, '/statistics?from=2026-10-01&to=2026-10-02');
    await waitFor(() => expect(sessionFetch).toHaveBeenCalled());
    expect(lastQuery().get('from')).toBe('2026-10-01');
    expect(lastQuery().get('limit')).toBe('50');
    await waitFor(() => expect(JSON.parse(localStorage.getItem('statistics_selection')!)).toMatchObject({ from: '2026-10-01', to: '2026-10-02' }));
  });

  test('ignores invalid stored values', async () => {
    localStorage.setItem('statistics_selection', JSON.stringify({ preset: 'forever', from: 'yesterday', simulation: 'maybe', limit: '7' }));
    mount(<Statistics />, '/statistics');
    expect(await screen.findByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(sessionFetch).toHaveBeenCalled());
    expect(lastQuery().get('simulation')).toBe('live');
    expect(lastQuery().get('limit')).toBe('10');
  });

  test('retries a failed request from the error message', async () => {
    vi.mocked(sessionFetch).mockResolvedValueOnce(Response.json({ error: 'Unavailable' }, { status: 503 }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: '192.0.2.7' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Statistics settings', () => {
  test('locks managed controls and saves editable settings through the API', async () => {
    const managed = { ...configuration, managed: { retentionDays: { path: 'statistics.retentionDays', env: 'CONFIG_STATISTICS_RETENTION_DAYS' } } };
    vi.mocked(sessionFetch).mockResolvedValue(Response.json({ success: true, statistics: managed }));
    const showToast = vi.fn();
    mount(<StatisticsSettings initial={managed} inputClass="" labelClass="" showToast={showToast} renderManagedLock={(source) => source ? <span>{source.env}</span> : null} />);
    const retention = await screen.findByRole('spinbutton', { name: /Retention/ });
    expect(retention).toBeDisabled();
    expect(screen.getByText(/CONFIG_STATISTICS_RETENTION_DAYS/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: /Job interval/ }), { target: { value: '30m' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Settings saved.', 'success'));
    expect(sessionFetch).toHaveBeenCalledWith('/api/config/statistics', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ enabled: true, jobInterval: '30m', jobTimeBudget: '30s' }) }));
  });
});
