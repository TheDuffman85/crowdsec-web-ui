import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Tools } from '../../Tools';
import { GeoBlocking } from '../../tools/GeoBlocking';
import { Blocklists } from '../../tools/Blocklists';
import { RepeatOffenders } from '../../tools/RepeatOffenders';
import { Hosts } from '../../tools/Hosts';
import { Wallboard, WALLBOARD_POLL_MS } from '../../tools/Wallboard';
import { Report } from '../../tools/Report';
import { AutoBan } from '../../tools/AutoBan';
import { impactOf } from '../../../lib/geoBlocking';
import { recentMonths } from '../../../lib/reportPeriods';

const mocks = vi.hoisted(() => ({
  addDecisions: vi.fn(),
  fetchConfig: vi.fn(),
  fetchGeoBlocking: vi.fn(),
  fetchBlocklists: vi.fn(),
  fetchRepeatOffenders: vi.fn(),
  fetchThreatScores: vi.fn(async () => []),
  fetchHosts: vi.fn(),
  fetchHostDetail: vi.fn(),
  fetchLiveFeed: vi.fn(),
  fetchReport: vi.fn(),
  downloadReportPdf: vi.fn(),
  fetchAutoBan: vi.fn(),
  saveAutoBan: vi.fn(),
  previewAutoBan: vi.fn(),
  addToast: vi.fn(),
  refreshSignal: 0,
}));

vi.mock('../../../lib/api', () => ({ addDecisions: mocks.addDecisions, fetchConfig: mocks.fetchConfig }));
vi.mock('../../../lib/insightsApi', () => ({
  fetchGeoBlocking: mocks.fetchGeoBlocking,
  fetchBlocklists: mocks.fetchBlocklists,
  fetchRepeatOffenders: mocks.fetchRepeatOffenders,
  fetchThreatScores: mocks.fetchThreatScores,
  fetchHosts: mocks.fetchHosts,
  fetchHostDetail: mocks.fetchHostDetail,
  fetchLiveFeed: mocks.fetchLiveFeed,
  fetchReport: mocks.fetchReport,
  downloadReportPdf: mocks.downloadReportPdf,
  fetchAutoBan: mocks.fetchAutoBan,
  saveAutoBan: mocks.saveAutoBan,
  previewAutoBan: mocks.previewAutoBan,
}));
vi.mock('../../../contexts/useToast', () => ({ useOptionalToast: () => ({ addToast: mocks.addToast }) }));
vi.mock('../../../contexts/useRefresh', () => ({ useRefresh: () => ({ refreshSignal: mocks.refreshSignal }) }));

function renderAt(ui: React.ReactElement, path = '/') {
  return render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>);
}

beforeEach(() => {
  mocks.fetchConfig.mockResolvedValue({ permissions: { mode: 'admin', can_manage_enforcement: true, can_manage_settings: true } });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mocks.refreshSignal = 0;
});

describe('Tools hub', () => {
  test('links to every tool', () => {
    renderAt(<Tools />);
    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual([
      '/tools/geo-blocking', '/tools/attack-map', '/tools/asn', '/tools/ip-timeline', '/tools/auto-ban', '/tools/repeat-offenders', '/tools/blocklists',
      '/tools/hosts', '/tools/wallboard', '/tools/hub', '/tools/audit-log', '/tools/report',
    ]);
  });
});

describe('GeoBlocking', () => {
  const summary = {
    hours: 168,
    total_alerts: 100,
    countries: [
      { code: 'CN', alerts: 40, unique_ips: 10, blocked: false },
      { code: 'RU', alerts: 10, unique_ips: 4, blocked: false },
      { code: 'KP', alerts: 0, unique_ips: 0, blocked: true },
    ],
    blocked_countries: ['KP'],
  };

  test('computes impact', () => {
    expect(impactOf(summary, new Set(['CN', 'RU']))).toEqual({ alerts: 50, uniqueIps: 14, share: 50 });
    expect(impactOf({ ...summary, total_alerts: 0 }, new Set(['CN'])).share).toBe(0);
  });

  test('previews impact and blocks selected countries', async () => {
    const user = userEvent.setup();
    mocks.fetchGeoBlocking.mockResolvedValue(summary);
    mocks.addDecisions.mockResolvedValue({ added: ['CN'], allowlisted: [], results: [] });
    renderAt(<GeoBlocking />);
    await screen.findByText('China');

    expect(screen.getByLabelText('Select North Korea')).toBeDisabled();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Select China'));
    expect(screen.getByTestId('geo-impact')).toHaveTextContent('1 selected: 40 alerts (40% of the total) from 10 unique IPs');
    await user.type(screen.getByLabelText('Reason'), 'scanner traffic');
    await user.click(screen.getByRole('button', { name: 'Block 1 countries' }));

    await waitFor(() => expect(mocks.addDecisions).toHaveBeenCalledWith({
      values: ['CN'], value_scope: 'country', duration: '720h', reason: 'scanner traffic', type: 'ban',
    }));
    expect(mocks.addToast).toHaveBeenCalledWith('Blocked 1 countries', 'success');
  });

  test('filters the list and shows load errors', async () => {
    const user = userEvent.setup();
    mocks.fetchGeoBlocking.mockResolvedValueOnce(summary);
    renderAt(<GeoBlocking />);
    await screen.findByText('China');
    await user.type(screen.getByLabelText('Filter countries'), 'rus');
    expect(screen.queryByText('China')).not.toBeInTheDocument();
    expect(screen.getByText('Russia')).toBeInTheDocument();
    mocks.fetchGeoBlocking.mockRejectedValueOnce(new Error('boom'));
    await user.selectOptions(screen.getByLabelText('Time range'), '24');
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });

  test('disables blocking without permission', async () => {
    mocks.fetchConfig.mockResolvedValue({ permissions: { mode: 'read-only', can_manage_enforcement: false } });
    mocks.fetchGeoBlocking.mockResolvedValue(summary);
    renderAt(<GeoBlocking />);
    await screen.findByText('China');
    await waitFor(() => expect(screen.getByLabelText('Select China')).toBeDisabled());
    expect(screen.getByText('You do not have permission to add decisions.')).toBeInTheDocument();
  });
});

describe('Blocklists', () => {
  test('groups origins and explains why it is read-only', async () => {
    mocks.fetchBlocklists.mockResolvedValue({
      manageable: false,
      origins: [
        { origin: 'CAPI', kind: 'community', active: 900, total: 1000, unique_values: 900, lists: [{ name: 'crowdsecurity/community-blocklist', active: 900, total: 1000, unique_values: 900 }] },
        { origin: 'crowdsec', kind: 'local', active: 3, total: 9, unique_values: 3, lists: [] },
      ],
    });
    renderAt(<Blocklists />);
    expect(await screen.findByText('CAPI')).toBeInTheDocument();
    expect(screen.getByText('Community')).toBeInTheDocument();
    expect(screen.getByText('crowdsecurity/community-blocklist')).toBeInTheDocument();
    expect(screen.getByText(/does not let the Local API subscribe/)).toBeInTheDocument();
  });

  test('shows an error', async () => {
    mocks.fetchBlocklists.mockRejectedValue(new Error('nope'));
    renderAt(<Blocklists />);
    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
  });
});

describe('RepeatOffenders', () => {
  test('lists offenders and the empty state', async () => {
    mocks.fetchRepeatOffenders.mockResolvedValueOnce([
      { ip: '203.0.113.5', episodes: 3, first_ban_at: '2026-10-01T00:00:00Z', last_ban_end: '2026-11-01T00:00:00Z', banned_now: true, scenarios: ['ssh-bf', 'http-probing'], country: 'DE', suggested_duration: '32h' },
    ]);
    const first = renderAt(<RepeatOffenders />);
    expect(await screen.findByRole('link', { name: '203.0.113.5' })).toHaveAttribute('href', '/alerts?q=203.0.113.5');
    expect(screen.getByText('Banned now')).toBeInTheDocument();
    expect(screen.getByText('32h')).toBeInTheDocument();
    first.unmount();
    mocks.fetchRepeatOffenders.mockResolvedValueOnce([]);
    renderAt(<RepeatOffenders />);
    expect(await screen.findByText('No repeat offenders found.')).toBeInTheDocument();
  });
});

describe('Hosts', () => {
  const host = { machine: 'web-1', alerts_total: 50, alerts_24h: 5, alerts_7d: 20, last_alert_at: '2026-11-20T10:00:00Z' };

  test('shows the host list and loads a detail view', async () => {
    const user = userEvent.setup();
    mocks.fetchHosts.mockResolvedValue([host, { ...host, machine: 'db-1', alerts_24h: 0 }]);
    mocks.fetchHostDetail.mockResolvedValue({
      ...host,
      active_decisions: 7,
      daily: Array.from({ length: 14 }, (_, index) => ({ date: `2026-11-${String(index + 1).padStart(2, '0')}`, count: index })),
      top_scenarios: [{ name: 'ssh-bf', count: 9 }],
      top_sources: [{ name: '203.0.113.1', count: 4 }],
      top_countries: [{ name: 'DE', count: 4 }],
      top_targets: [],
      recent_alerts: [{ id: 1, created_at: '2026-11-20T09:00:00Z', scenario: 'ssh-bf', source_ip: '203.0.113.1', country: 'DE', target: null }],
    });
    renderAt(<Hosts />);
    expect(await screen.findByText('Pick a host to see its details.')).toBeInTheDocument();
    expect(screen.getByText('Quiet')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /web-1/ }));
    expect(await screen.findByText('Top scenarios')).toBeInTheDocument();
    expect(mocks.fetchHostDetail).toHaveBeenCalledWith('web-1');
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '203.0.113.1' })).toBeInTheDocument();
  });

  test('empty state', async () => {
    mocks.fetchHosts.mockResolvedValue([]);
    renderAt(<Hosts />);
    expect(await screen.findByText('No hosts have reported alerts yet.')).toBeInTheDocument();
  });
});

describe('Wallboard', () => {
  const snapshot = {
    server_time: '2026-11-20T12:00:00Z',
    alerts: [{ id: 1, created_at: '2026-11-20T11:59:00Z', scenario: 'ssh-bf', source_ip: '203.0.113.9', country: 'CN', as_name: null, latitude: null, longitude: null, target: null, machine: 'web-1' }],
    last_hour: 12,
    last_24h: 340,
    top_countries: [{ name: 'CN', count: 200 }],
    top_scenarios: [{ name: 'ssh-bf', count: 150 }],
  };

  test('renders counters, then polls and reloads on a push refresh', async () => {
    vi.useFakeTimers();
    mocks.fetchLiveFeed.mockResolvedValue(snapshot);
    const view = renderAt(<Wallboard />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText('340')).toBeInTheDocument();
    expect(within(screen.getByTestId('wallboard-alerts')).getByText('203.0.113.9')).toBeInTheDocument();
    expect(mocks.fetchLiveFeed).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(WALLBOARD_POLL_MS); });
    expect(mocks.fetchLiveFeed).toHaveBeenCalledTimes(2);

    mocks.refreshSignal = 1;
    view.rerender(<MemoryRouter><Wallboard /></MemoryRouter>);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mocks.fetchLiveFeed).toHaveBeenCalledTimes(3);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(WALLBOARD_POLL_MS * 2); });
    expect(mocks.fetchLiveFeed).toHaveBeenCalledTimes(3);
  });

  test('keeps the last data visible when a poll fails', async () => {
    vi.useFakeTimers();
    mocks.fetchLiveFeed.mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error('offline'));
    renderAt(<Wallboard />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await act(async () => { await vi.advanceTimersByTimeAsync(WALLBOARD_POLL_MS); });
    expect(screen.getByRole('alert')).toHaveTextContent('offline');
    expect(screen.getByText('340')).toBeInTheDocument();
  });

  test('toggles fullscreen', async () => {
    const user = userEvent.setup();
    mocks.fetchLiveFeed.mockResolvedValue(snapshot);
    const request = vi.fn().mockResolvedValue(undefined);
    renderAt(<Wallboard />);
    await screen.findByText('340');
    const frame = screen.getByTestId('wallboard-alerts').closest('div[class*="space-y-4"]') as HTMLElement;
    frame.requestFullscreen = request;
    await user.click(screen.getByRole('button', { name: 'Fullscreen' }));
    expect(request).toHaveBeenCalled();
  });
});

describe('Report', () => {
  const report = {
    period: { from: '2026-10-21T00:00:00Z', to: '2026-11-20T00:00:00Z', label: 'Last 30 days' },
    generated_at: '2026-11-20T12:00:00Z',
    total_alerts: 321, unique_sources: 45, decisions_created: 12, active_decisions: 8, repeat_offenders: 2,
    daily: [{ date: '2026-11-19', count: 5 }, { date: '2026-11-20', count: 9 }],
    top_scenarios: [{ name: 'ssh-bf', count: 100 }], top_countries: [], top_sources: [], top_machines: [],
  };

  test('lists recent months, newest first', () => {
    expect(recentMonths(new Date('2026-11-20T00:00:00Z')).slice(0, 3)).toEqual(['2026-10', '2026-09', '2026-08']);
    expect(recentMonths(new Date('2026-01-05T00:00:00Z'))[0]).toBe('2025-12');
    expect(recentMonths()).toHaveLength(12);
  });

  test('shows figures, switches period and downloads', async () => {
    const user = userEvent.setup();
    mocks.fetchReport.mockResolvedValue(report);
    mocks.downloadReportPdf.mockResolvedValue(undefined);
    renderAt(<Report />);
    expect(await screen.findByText('321')).toBeInTheDocument();
    expect(mocks.fetchReport).toHaveBeenLastCalledWith({ days: 30 });
    await user.selectOptions(screen.getByLabelText('Period'), 'd:7');
    await waitFor(() => expect(mocks.fetchReport).toHaveBeenLastCalledWith({ days: 7 }));
    const month = recentMonths()[0]!;
    await user.selectOptions(screen.getByLabelText('Period'), `m:${month}`);
    await waitFor(() => expect(mocks.fetchReport).toHaveBeenLastCalledWith({ month }));
    await user.click(screen.getByRole('button', { name: 'Download PDF' }));
    expect(mocks.downloadReportPdf).toHaveBeenCalledWith({ month });
  });

  test('reports a failed download', async () => {
    const user = userEvent.setup();
    mocks.fetchReport.mockResolvedValue(report);
    mocks.downloadReportPdf.mockRejectedValue(new Error('no pdf'));
    renderAt(<Report />);
    await screen.findByText('321');
    await user.click(screen.getByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith('no pdf', 'danger'));
  });
});

describe('AutoBan', () => {
  const rule = { id: 'r1', name: 'SSH', scenario: 'ssh', min_alerts: 5, window_minutes: 60, duration: '4h', escalate: true };

  test('is off by default and saves edited rules', async () => {
    const user = userEvent.setup();
    mocks.fetchAutoBan.mockResolvedValue({ settings: { enabled: false, dry_run: true, rules: [] }, log: [] });
    mocks.saveAutoBan.mockImplementation(async (settings) => settings);
    renderAt(<AutoBan />);
    expect(await screen.findByText('Off')).toBeInTheDocument();
    expect(screen.getByLabelText('Dry run: record matches without banning')).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    await user.type(screen.getByLabelText('Name'), 'Scanners');
    await user.click(screen.getByLabelText('Enable auto-ban rules'));
    expect(screen.getByText('Dry run', { selector: 'span' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.saveAutoBan).toHaveBeenCalledWith({
      enabled: true, dry_run: true,
      rules: [{ name: 'Scanners', scenario: 'ssh', min_alerts: 5, window_minutes: 60, duration: '4h', escalate: true }],
    }));
    expect(mocks.addToast).toHaveBeenCalledWith('Auto-ban rules saved', 'success');
  });

  test('asks before going live and respects a refusal', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mocks.fetchAutoBan.mockResolvedValue({ settings: { enabled: true, dry_run: true, rules: [rule] }, log: [] });
    renderAt(<AutoBan />);
    await screen.findByText('Rule 1');
    await user.click(screen.getByLabelText('Dry run: record matches without banning'));
    expect(screen.getByText('Live')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(confirm).toHaveBeenCalled();
    expect(mocks.saveAutoBan).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    mocks.saveAutoBan.mockImplementation(async (settings) => settings);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.saveAutoBan).toHaveBeenCalled());
    confirm.mockRestore();
  });

  test('removes a rule, shows preview and log', async () => {
    const user = userEvent.setup();
    mocks.fetchAutoBan.mockResolvedValue({
      settings: { enabled: true, dry_run: true, rules: [rule] },
      log: [{ id: 1, at: '2026-11-20T10:00:00Z', rule_id: 'r1', rule_name: 'SSH', ip: '203.0.113.1', action: 'would_ban', duration: '4h', alerts: 6, detail: null }],
    });
    mocks.previewAutoBan.mockResolvedValue([{ rule_id: 'r1', rule_name: 'SSH', candidates: [{ ip: '203.0.113.2', alerts: 7, duration: '8h', previous_bans: 1 }] }]);
    renderAt(<AutoBan />);
    expect(await screen.findByText('Would ban')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show current matches' }));
    expect(await screen.findByText('203.0.113.2: 7 alerts, would ban for 8h')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove rule 1' }));
    expect(screen.getByText('No rules yet.')).toBeInTheDocument();
  });

  test('locks the form for read-only users', async () => {
    mocks.fetchConfig.mockResolvedValue({ permissions: { mode: 'read-only', can_manage_enforcement: false, can_manage_settings: false } });
    mocks.fetchAutoBan.mockResolvedValue({ settings: { enabled: false, dry_run: true, rules: [rule] }, log: [] });
    renderAt(<AutoBan />);
    await screen.findByText('Rule 1');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
    expect(screen.getByText('Only administrators can change these rules.')).toBeInTheDocument();
  });

  test('shows a save failure', async () => {
    const user = userEvent.setup();
    mocks.fetchAutoBan.mockResolvedValue({ settings: { enabled: false, dry_run: true, rules: [] }, log: [] });
    mocks.saveAutoBan.mockRejectedValue(new Error('Rule 1: duration must look like 4h, 30m or 7d'));
    renderAt(<AutoBan />);
    await screen.findByText('Off');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith('Rule 1: duration must look like 4h, 30m or 7d', 'danger'));
  });
});
