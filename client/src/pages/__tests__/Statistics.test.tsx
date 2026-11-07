import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Statistics } from '../Statistics';
import { StatisticsSettings } from '../../components/StatisticsSettings';
import { I18nContext, type I18nContextValue } from '../../lib/i18n';
import { fetchConfig } from '../../lib/api';
import { sessionFetch } from '../../lib/sessionFetch';
import en from '../../locales/en.json';
import type { ConfigResponse } from '../../types';
import { DEFAULT_STATISTICS_SETTINGS, type StatisticsConfiguration, type StatisticsResponse } from '../../../../shared/statistics';

vi.mock('../../lib/api', () => ({ fetchConfig: vi.fn() }));
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
    totals: { alerts: 12, events: 48, uniqueIPs: 1, bans: 2, decisions: 3, repeatAttackers: 1 },
    attackers: [{ value: '192.0.2.7', label: '192.0.2.7', alerts: 12, events: 48, uniqueIPs: 1, bans: 2, machines: 1, activeDays: 3, firstActivity: '2026-11-01T10:00:00Z', lastActivity: '2026-11-07T11:00:00Z', country: 'DE', asn: '42', network: 'Example', scenarios: [{ label: 'ssh', count: 12 }], targetedMachines: [{ value: '["default","m-1"]', label: 'Server one', count: 12 }] }],
    machines: [{ value: '["default","m-1"]', label: 'Server one', instance: 'default', machineId: 'm-1', alerts: 12, events: 48, uniqueIPs: 1, bans: 2, machines: 1, activeDays: 3, firstActivity: null, lastActivity: null, country: 'DE', asn: '42', network: 'Example', scenarios: [], targetedMachines: [] }],
    series: [{ date: '2026-10-09', alerts: null, decisions: null }], scenarios: [{ label: 'ssh', count: 12 }], countries: [], networks: [], decisionTypes: [], decisionOrigins: [], hours: Array<number>(24).fill(0), weekdays: Array<number>(7).fill(0), increases: [],
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
    expect(await screen.findByText('Top attacking IPs')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '192.0.2.7' })).toBeInTheDocument();
    expect(screen.getByText(/Counts reflect observed data/)).toBeInTheDocument();
    expect(screen.getByText(/complete preceding period/)).toBeInTheDocument();
    expect(sessionFetch).toHaveBeenCalledWith(expect.stringContaining('/api/statistics?'), expect.anything());
  });

  test('keeps ranking limits and attacker/machine filters in the URL and builds UTC investigation links', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '192.0.2.7' }));
    await screen.findByRole('link', { name: 'View available alerts' });
    expect(screen.getByTestId('location').textContent).toContain('ip=192.0.2.7');
    fireEvent.change(screen.getByRole('combobox', { name: 'Rankings' }), { target: { value: '50' } });
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('limit=50'));
    await screen.findByRole('button', { name: '192.0.2.7' });
    const link = screen.getByRole('link', { name: 'View available alerts' });
    const target = new URL(link.getAttribute('href')!, 'http://localhost');
    expect(target.pathname).toBe('/alerts');
    expect(target.searchParams.get('q')).toContain('date>=2026-10-09T00:00:00Z AND date<2026-11-08T00:00:00Z');
    expect(target.searchParams.get('q')).toContain('ip="192.0.2.7"');
    expect(target.searchParams.get('simulation')).toBe('live');
    fireEvent.click(screen.getAllByRole('button', { name: 'Server one' })[0]);
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('machine='));
  });

  test('shows disabled collection and API failures without inventing empty statistics', async () => {
    vi.mocked(fetchConfig).mockResolvedValue({ statistics: { ...configuration, settings: { ...configuration.settings, enabled: false } } } as ConfigResponse);
    vi.mocked(sessionFetch).mockResolvedValue(Response.json({ error: 'Unavailable' }, { status: 503 }));
    mount();
    expect(await screen.findByText(/Collection is disabled/)).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Statistics are unavailable');
    expect(screen.queryByText('Top attacking IPs')).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: 'Save statistics settings' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Settings saved.', 'success'));
    expect(sessionFetch).toHaveBeenCalledWith('/api/config/statistics', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ enabled: true, jobInterval: '30m', jobTimeBudget: '30s' }) }));
  });
});
