import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SessionsSettings } from '../SessionsSettings';

const session = (overrides: Record<string, unknown> = {}) => ({
  id: 's1', user_id: 1, username: 'alice', method: 'password', created_at: '2026-11-19T10:00:00.000Z',
  last_seen_at: '2026-11-20T09:00:00.000Z', expires_at: '2026-12-19T10:00:00.000Z', ip: '203.0.113.7', user_agent: 'Phone Browser', current: false, ...overrides,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

describe('SessionsSettings', () => {
  test('lists sessions with device details and marks the current one', async () => {
    fetchMock.mockResolvedValue(json({ sessions: [session({ current: true }), session({ id: 's2', method: 'oidc', user_agent: null, ip: null })] }));
    render(<SessionsSettings canManage={false} showToast={vi.fn()} />);
    expect(await screen.findByText('Phone Browser · 203.0.113.7')).toBeInTheDocument();
    expect(screen.getByText('This session')).toBeInTheDocument();
    expect(screen.getByText('Unknown device')).toBeInTheDocument();
    expect(screen.getByText('SSO')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'End the session of alice' })).toHaveLength(2);
    expect(screen.getByText('Sign out')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/auth\/sessions$/);
  });

  test('administrators request every session and can end one', async () => {
    const showToast = vi.fn();
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === 'DELETE' ? json({ success: true }) : json({ sessions: [session({ username: 'bob' })] })));
    render(<SessionsSettings canManage showToast={showToast} />);
    fireEvent.click(await screen.findByRole('button', { name: 'End the session of bob' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Session ended.', 'success'));
    expect(fetchMock.mock.calls[0][0]).toContain('/api/auth/sessions?all=1');
    expect(fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE')![0]).toContain('/api/auth/sessions/s1');
    expect(fetchMock.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2);
  });

  test('shows the server message when ending a session is refused', async () => {
    const showToast = vi.fn();
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === 'DELETE' ? json({ error: 'Administrator access required' }, 403) : json({ sessions: [session()] })));
    render(<SessionsSettings canManage={false} showToast={showToast} />);
    fireEvent.click(await screen.findByRole('button', { name: 'End the session of alice' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Administrator access required', 'danger'));
  });

  test('says so when there is nothing to show or loading fails', async () => {
    fetchMock.mockResolvedValue(json({ error: 'nope' }, 500));
    const showToast = vi.fn();
    render(<SessionsSettings canManage={false} showToast={showToast} />);
    expect(await screen.findByText('No active sessions.')).toBeInTheDocument();
    expect(showToast).toHaveBeenCalledWith('Could not load sessions.', 'danger');
  });
});
