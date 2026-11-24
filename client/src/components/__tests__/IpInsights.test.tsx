import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EscalationHint } from '../EscalationHint';
import { IpInsights } from '../IpInsights';
import { IpIntelPanel } from '../IpIntelPanel';
import { NotesPanel } from '../NotesPanel';
import { RepeatOffenderBanner } from '../RepeatOffenderBanner';

const note = (overrides: Record<string, unknown> = {}) => ({
  id: 'n1', subject_type: 'ip', subject: '203.0.113.9', author_id: 1, author_name: 'alice', body: 'Known scanner',
  created_at: '2026-11-20T10:00:00.000Z', updated_at: '2026-11-20T10:00:00.000Z', can_edit: true, can_delete: true, ...overrides,
});
const offenderCheck = {
  ip: '203.0.113.9', previous_bans: 3, repeat_offender: true,
  offender: { ip: '203.0.113.9', episodes: 3, first_ban_at: '2026-11-01T00:00:00.000Z', last_ban_end: '2026-11-19T00:00:00.000Z', banned_now: false, scenarios: [], country: 'DE', suggested_duration: '32h' },
};
const intel = {
  ip: '203.0.113.9', cached: false,
  whois: { status: 'ok', data: { name: 'EXAMPLE-NET', handle: null, country: 'US', type: null, start_address: '203.0.113.0', end_address: '203.0.113.255', registered_at: null, last_changed_at: null } },
  abuseipdb: { status: 'not_configured' },
  shodan: { status: 'error', error: 'rate limit reached' },
};

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('NotesPanel', () => {
  test('lists notes, adds, edits and deletes them', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return json(note({ id: 'n2', body: 'Second' }), 201);
      if (init?.method === 'PATCH') return json(note({ body: 'Reworded', updated_at: '2026-11-20T11:00:00.000Z' }));
      if (init?.method === 'DELETE') return json({ success: true });
      return json({ notes: [note()] });
    });
    render(<NotesPanel type="ip" subject="203.0.113.9" title="Notes on 203.0.113.9" />);

    expect(await screen.findByText('Known scanner')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toContain('/api/notes?type=ip&subject=203.0.113.9');

    fireEvent.change(screen.getByPlaceholderText('Add a note for your team'), { target: { value: 'Second' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(await screen.findByText('Second')).toBeInTheDocument();
    expect(JSON.parse(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')![1].body)).toEqual({ subject_type: 'ip', subject: '203.0.113.9', body: 'Second' });

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit note' })[0]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit note' }), { target: { value: 'Reworded' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Edit note' })).not.toBeInTheDocument());
    expect(screen.getByText('Reworded')).toBeInTheDocument();
    expect(screen.getByText(/edited/)).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete note' })[1]);
    await waitFor(() => expect(screen.queryByText('Second')).not.toBeInTheDocument());
  });

  test('hides edit for other authors and delete when not allowed', async () => {
    fetchMock.mockResolvedValue(json({ notes: [note({ can_edit: false, can_delete: false })] }));
    render(<NotesPanel type="alert" subject="42" title="Notes on this alert" />);
    await screen.findByText('Known scanner');
    expect(screen.queryByRole('button', { name: 'Edit note' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete note' })).not.toBeInTheDocument();
  });

  test('shows server errors and the empty state', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? json({ error: 'Note limit reached for this item' }, 409) : json({ notes: [] })));
    render(<NotesPanel type="ip" subject="203.0.113.9" title="Notes" />);
    expect(await screen.findByText('No notes yet.')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Add a note for your team'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Note limit reached for this item');
  });
});

describe('RepeatOffenderBanner', () => {
  test('appears only for repeat offenders', async () => {
    fetchMock.mockResolvedValue(json(offenderCheck));
    const { unmount } = render(<RepeatOffenderBanner ip="203.0.113.9" />);
    expect(await screen.findByTestId('repeat-offender-banner')).toHaveTextContent('banned 3 separate times');
    expect(screen.getByTestId('repeat-offender-banner')).toHaveTextContent('32h');
    unmount();

    fetchMock.mockResolvedValue(json({ ip: '203.0.113.9', previous_bans: 0, repeat_offender: false, offender: null }));
    render(<RepeatOffenderBanner ip="203.0.113.9" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('repeat-offender-banner')).not.toBeInTheDocument();
  });
});

describe('EscalationHint', () => {
  test('suggests the escalated duration and applies it on request', async () => {
    fetchMock.mockResolvedValue(json(offenderCheck));
    const onApply = vi.fn();
    render(<EscalationHint ip="203.0.113.9" currentDuration="4h" onApply={onApply} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use 32h' }));
    expect(onApply).toHaveBeenCalledWith('32h');
  });

  test('stays quiet for ranges, unknown addresses and failed lookups', async () => {
    const { rerender, container } = render(<EscalationHint ip="203.0.113.0/24" currentDuration="4h" onApply={vi.fn()} />);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRejectedValue(new Error('offline'));
    rerender(<EscalationHint ip="203.0.113.9" currentDuration="4h" onApply={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

describe('IpIntelPanel', () => {
  test('sends nothing until the button is pressed, then shows each source state', async () => {
    fetchMock.mockResolvedValue(json(intel));
    render(<IpIntelPanel ip="203.0.113.9" />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Nothing is sent until you press the button/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByText('EXAMPLE-NET')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toContain('/api/ip-intel?ip=203.0.113.9');
    expect(screen.getByTestId('intel-AbuseIPDB')).toHaveTextContent('Set ABUSEIPDB_API_KEY');
    expect(screen.getByTestId('intel-Shodan')).toHaveTextContent('Unavailable: rate limit reached');
    expect(screen.getByRole('button', { name: 'Look up again' })).toBeInTheDocument();
  });

  test('shows the server message when the lookup is refused', async () => {
    fetchMock.mockResolvedValue(json({ error: 'Too many lookups, try again in a minute' }, 429));
    render(<IpIntelPanel ip="203.0.113.9" />);
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many lookups');
  });
});

describe('IpInsights', () => {
  test('skips IP sections for aggregate sources and renders nothing without anything to show', () => {
    fetchMock.mockResolvedValue(json({ notes: [] }));
    const { container, rerender } = render(<IpInsights ip={null} alertId={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<IpInsights ip="Ip:1.2.3.4/24" alertId={7} />);
    expect(screen.queryByTestId('ip-intel-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('notes-alert')).toBeInTheDocument();
  });

  test('shows IP and alert sections for a single address', async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).includes('/api/threat-score')
      ? json({ ip: '203.0.113.9', score: 64, level: 'high', reputation_available: false, factors: [] })
      : json({ notes: [], ...offenderCheck })));
    render(<MemoryRouter><IpInsights ip="203.0.113.9" alertId={7} /></MemoryRouter>);
    expect(screen.getByTestId('ip-intel-panel')).toBeInTheDocument();
    expect(screen.getByTestId('notes-ip')).toBeInTheDocument();
    expect(screen.getByTestId('notes-alert')).toBeInTheDocument();
    await screen.findByTestId('repeat-offender-banner');
    expect(await screen.findByTestId('threat-score')).toHaveTextContent('64');
    expect(screen.getByRole('link', { name: 'Open timeline' })).toHaveAttribute('href', '/tools/ip-timeline?ip=203.0.113.9');
  });
});
