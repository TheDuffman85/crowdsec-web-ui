import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { IpTimeline } from '../../tools/IpTimeline';

const mocks = vi.hoisted(() => ({ fetchIpTimeline: vi.fn(), fetchThreatScore: vi.fn() }));
vi.mock('../../../lib/insightsApi', () => ({ fetchIpTimeline: mocks.fetchIpTimeline, fetchThreatScore: mocks.fetchThreatScore }));

const timeline = (overrides = {}) => ({
  ip: '203.0.113.5',
  events: [
    { kind: 'audit', time: '2026-11-20T09:00:00.000Z', title: 'decision.add', instance: null, machine: null, detail: { user: 'tommy', outcome: 'success', reason: 'manual' } },
    { kind: 'note', time: '2026-11-19T12:00:00.000Z', title: 'alice', instance: null, machine: null, detail: { body: 'Known scanner' } },
    { kind: 'decision', time: '2026-11-19T10:00:00.000Z', title: 'ban', instance: 'default', machine: 'web-02', detail: { duration: '4h', until: '2026-11-19T14:00:00.000Z', origin: 'crowdsec' } },
    { kind: 'alert', time: '2026-11-18T10:00:00.000Z', title: 'crowdsecurity/ssh-bf', instance: 'default', machine: 'web-01', detail: { events: 6, simulated: false } },
  ],
  counts: { alert: 1, decision: 1, note: 1, audit: 1 }, machines: ['web-01', 'web-02'], instances: ['default'], truncated: false, audit_included: true,
  ...overrides,
});

const open = (path = '/tools/ip-timeline?ip=203.0.113.5') => render(<MemoryRouter initialEntries={[path]}><IpTimeline /></MemoryRouter>);

afterEach(() => vi.clearAllMocks());

describe('IpTimeline page', () => {
  test('shows every kind of event newest first with readable names', async () => {
    mocks.fetchIpTimeline.mockResolvedValue(timeline());
    mocks.fetchThreatScore.mockResolvedValue({ ip: '203.0.113.5', score: 71, level: 'high', reputation_available: false, factors: [] });
    open();
    const list = await screen.findByTestId('timeline-list');
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('data-kind'))).toEqual(['audit', 'note', 'decision', 'alert']);
    expect(items[0]).toHaveTextContent('Decision added');
    expect(items[0]).toHaveTextContent('By tommy, Success · manual');
    expect(items[1]).toHaveTextContent('Note by alice');
    expect(items[1]).toHaveTextContent('Known scanner');
    expect(items[2]).toHaveTextContent('Duration 4h');
    expect(items[3]).toHaveTextContent('crowdsecurity/ssh-bf');
    expect(items[3]).toHaveTextContent('web-01 · default');
    expect(await screen.findByTestId('threat-score')).toHaveTextContent('71');
    expect(mocks.fetchIpTimeline).toHaveBeenCalledWith('203.0.113.5');
  });

  test('filters by kind and machine', async () => {
    const user = userEvent.setup();
    mocks.fetchIpTimeline.mockResolvedValue(timeline());
    mocks.fetchThreatScore.mockResolvedValue(null);
    open();
    await screen.findByTestId('timeline-list');
    await user.click(screen.getByRole('checkbox', { name: /Notes/ }));
    expect(screen.queryByText('Known scanner')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Machine'), 'web-01');
    expect(within(screen.getByTestId('timeline-list')).getAllByRole('listitem')).toHaveLength(1);
    await user.click(screen.getByRole('checkbox', { name: /Alerts/ }));
    expect(screen.getByText('No events to show for this address.')).toBeInTheDocument();
  });

  test('hides the admin filter and explains why for non-admins', async () => {
    mocks.fetchIpTimeline.mockResolvedValue(timeline({ audit_included: false, truncated: true }));
    open();
    await screen.findByTestId('timeline-list');
    expect(screen.queryByRole('checkbox', { name: /Admin actions/ })).not.toBeInTheDocument();
    expect(screen.getByText('Admin actions are only shown to administrators.')).toBeInTheDocument();
    expect(screen.getByText('Showing the newest 4 events.')).toBeInTheDocument();
  });

  test('looks up an address from the form and rejects bad input', async () => {
    const user = userEvent.setup();
    mocks.fetchIpTimeline.mockResolvedValue(timeline());
    open('/tools/ip-timeline');
    expect(mocks.fetchIpTimeline).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('IP address'), 'not an ip');
    await user.click(screen.getByRole('button', { name: 'Show timeline' }));
    expect(await screen.findByText('Enter a single IPv4 or IPv6 address.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('IP address'));
    await user.type(screen.getByLabelText('IP address'), '203.0.113.5');
    await user.click(screen.getByRole('button', { name: 'Show timeline' }));
    await waitFor(() => expect(mocks.fetchIpTimeline).toHaveBeenCalledWith('203.0.113.5'));
  });

  test('shows load errors', async () => {
    mocks.fetchIpTimeline.mockRejectedValue(new Error('boom'));
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });
});
