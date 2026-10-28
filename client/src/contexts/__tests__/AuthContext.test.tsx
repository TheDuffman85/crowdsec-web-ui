import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { isOidcAutoLoginSuppressed, setOidcAutoLoginSuppressed } from '../../lib/oidcAutoLogin';
import { AuthProvider, useAuth } from '../AuthContext';

function LogoutButton() {
  const { logout } = useAuth();
  return <button type="button" onClick={() => void logout()}>Log out</button>;
}

function mockAuthApi(logoutPayload: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/api/auth/logout')) return Response.json(logoutPayload);
    return Response.json({ authEnabled: true, authenticated: true, user: { userId: 1, username: 'admin', role: 'admin' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('AuthProvider logout', () => {
  const assign = vi.fn();

  beforeEach(() => {
    assign.mockReset();
    vi.stubGlobal('location', { ...window.location, assign });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  test('redirects to the identity provider when logout returns a redirect URL', async () => {
    const fetchMock = mockAuthApi({ status: 'ok', redirectUrl: 'https://idp.example.com/end-session?client_id=crowdsec' });
    render(<AuthProvider><LogoutButton /></AuthProvider>);

    await userEvent.click(screen.getByRole('button', { name: 'Log out' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://idp.example.com/end-session?client_id=crowdsec'));
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/auth/status'))).toHaveLength(1);
    expect(isOidcAutoLoginSuppressed()).toBe(true);
  });

  test('re-enables auto-login once the user is signed in again', async () => {
    setOidcAutoLoginSuppressed(true);
    mockAuthApi({ status: 'ok' });
    render(<AuthProvider><LogoutButton /></AuthProvider>);

    await waitFor(() => expect(isOidcAutoLoginSuppressed()).toBe(false));
  });

  test('ignores non-http redirect URLs and refreshes the local session state', async () => {
    const fetchMock = mockAuthApi({ status: 'ok', redirectUrl: 'javascript:alert(1)' });
    render(<AuthProvider><LogoutButton /></AuthProvider>);

    await userEvent.click(screen.getByRole('button', { name: 'Log out' }));

    await waitFor(() => expect(
      fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/auth/status')),
    ).toHaveLength(2));
    expect(assign).not.toHaveBeenCalled();
  });
});
