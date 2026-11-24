import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AsnView } from '../../tools/AsnView';

const mocks = vi.hoisted(() => ({ fetchAsns: vi.fn(), fetchAsnDetail: vi.fn(), fetchThreatScores: vi.fn(), fetchConfig: vi.fn() }));
vi.mock('../../../lib/insightsApi', () => ({ fetchAsns: mocks.fetchAsns, fetchAsnDetail: mocks.fetchAsnDetail, fetchThreatScores: mocks.fetchThreatScores }));
vi.mock('../../../lib/api', () => ({ fetchConfig: mocks.fetchConfig }));
vi.mock('../../../components/AddDecisionModal', () => ({
  AddDecisionModal: ({ initialDecision, onClose }: { initialDecision: { ip: string; duration: string; reason: string }; onClose: () => void }) => (
    <div role="dialog">Ban {initialDecision.ip} for {initialDecision.duration}: {initialDecision.reason}<button type="button" onClick={onClose}>Close</button></div>
  ),
}));

const list = {
  days: 30, unknown_alerts: 12,
  asns: [
    { asn: '64500', name: 'Example Hosting', alerts: 40, unique_ips: 2, last_seen: '2026-11-19T10:00:00.000Z', countries: [{ code: 'NL', count: 40 }], scenarios: [{ name: 'crowdsecurity/ssh-bf', count: 30 }], ranges: [] },
    { asn: '64501', name: null, alerts: 3, unique_ips: 1, last_seen: '2026-11-18T10:00:00.000Z', countries: [], scenarios: [], ranges: [] },
  ],
};
const detail = {
  asn: '64500', name: 'Example Hosting', alerts: 40, unique_ips: 2, truncated: false,
  ips: [
    { ip: '203.0.113.1', alerts: 30, last_seen: '2026-11-19T10:00:00.000Z', country: 'NL', scenarios: ['crowdsecurity/ssh-bf'], banned_now: true },
    { ip: '203.0.113.2', alerts: 10, last_seen: '2026-11-18T10:00:00.000Z', country: 'NL', scenarios: [], banned_now: false },
  ],
  ranges: [{ range: '203.0.113.0/24', count: 40 }], scenarios: [],
};

const open = () => render(<MemoryRouter><AsnView /></MemoryRouter>);

beforeEach(() => {
  mocks.fetchAsns.mockResolvedValue(list);
  mocks.fetchAsnDetail.mockResolvedValue(detail);
  mocks.fetchThreatScores.mockResolvedValue([{ ip: '203.0.113.1', score: 88, level: 'critical', reputation_available: false, factors: [] }]);
  mocks.fetchConfig.mockResolvedValue({ instances: [{ id: 'default', name: 'Default' }], permissions: { mode: 'admin', can_manage_enforcement: true } });
});
afterEach(() => vi.clearAllMocks());

describe('AsnView', () => {
  test('lists networks and filters them', async () => {
    const user = userEvent.setup();
    open();
    const table = await screen.findByTestId('asn-table');
    expect(within(table).getByText('Example Hosting')).toBeInTheDocument();
    expect(within(table).getByText('Unnamed network')).toBeInTheDocument();
    expect(screen.getByText('12 alerts have no known network and are not listed.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Filter'), 'as64501');
    expect(within(table).queryByText('Example Hosting')).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText('Filter'));
    await user.type(screen.getByLabelText('Filter'), 'zzz');
    expect(screen.getByText('No network matches this filter.')).toBeInTheDocument();
  });

  test('drills into addresses with threat scores and timeline links', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Show addresses for AS64500' }));
    const panel = await screen.findByTestId('asn-detail-64500');
    expect(mocks.fetchAsnDetail).toHaveBeenCalledWith('64500', 30);
    expect(within(panel).getByText('203.0.113.1')).toBeInTheDocument();
    expect(within(panel).getByText('Banned now')).toBeInTheDocument();
    expect(await within(panel).findByTestId('threat-score')).toHaveTextContent('88');
    expect(within(panel).getAllByRole('link', { name: 'Open timeline' })[0]).toHaveAttribute('href', '/tools/ip-timeline?ip=203.0.113.1');
    expect(mocks.fetchThreatScores).toHaveBeenCalledWith(['203.0.113.1', '203.0.113.2']);
    await user.click(screen.getByRole('button', { name: 'Show addresses for AS64500' }));
    expect(screen.queryByTestId('asn-detail-64500')).not.toBeInTheDocument();
  });

  test('offers to ban a range through the existing decision dialog', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Show addresses for AS64500' }));
    await user.click(await screen.findByRole('button', { name: 'Ban range 203.0.113.0/24' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Ban 203.0.113.0/24 for 24h: AS64500 Example Hosting');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('hides banning for read-only users and reloads for another period', async () => {
    const user = userEvent.setup();
    mocks.fetchConfig.mockResolvedValue({ instances: [], permissions: { mode: 'read-only', can_manage_enforcement: false } });
    open();
    await user.click(await screen.findByRole('button', { name: 'Show addresses for AS64500' }));
    await screen.findByTestId('asn-detail-64500');
    expect(screen.queryByRole('button', { name: /Ban range/ })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Period'), '90');
    await waitFor(() => expect(mocks.fetchAsns).toHaveBeenLastCalledWith(90));
  });

  test('shows empty and error states', async () => {
    mocks.fetchAsns.mockResolvedValueOnce({ asns: [], unknown_alerts: 0, days: 30 });
    const view = open();
    expect(await screen.findByText('No alerts with a known network in this period.')).toBeInTheDocument();
    view.unmount();
    mocks.fetchAsns.mockRejectedValueOnce(new Error('boom'));
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });
});
