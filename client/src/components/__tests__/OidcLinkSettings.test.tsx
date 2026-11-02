import { afterEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { OidcLinkSettings } from '../OidcLinkSettings';

vi.mock('../../lib/i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) => values ? `${key} ${JSON.stringify(values)}` : key,
  }),
}));

vi.mock('../../lib/dateTime', () => ({
  useDateTime: () => ({ formatDate: () => '2 Nov 2026' }),
}));

const UNLINKED = {
  available: true,
  canManage: true,
  username: 'admin',
  totpEnabled: true,
  passwordLoginDisabled: false,
  link: null,
  pending: null,
};

const LINKED = {
  ...UNLINKED,
  link: {
    issuer: 'https://auth.example.com/oidc',
    username: 'alice',
    role: 'read-only',
    method: 'verified',
    linkedAt: '2026-11-02T10:00:00.000Z',
    provider: 'current',
  },
};

const PENDING = {
  ...UNLINKED,
  pending: { id: 'attempt-1', issuer: 'https://auth.example.com/oidc', username: 'alice', role: 'admin', merge: { username: 'admin#oidc-1a2b3c4d5e' } },
};

type Handler = (url: string, init?: RequestInit) => Response | undefined;

function stubFetch(status: unknown, handler: Handler = () => undefined) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    return handler(url, init) ?? (url.endsWith('/api/auth/oidc/link') && (init?.method ?? 'GET') === 'GET'
      ? Response.json(status)
      : Response.json({ status: 'ok' }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function Location() {
  const { search } = useLocation();
  return <output data-testid="search">{search}</output>;
}

function renderSettings(search = '') {
  const showToast = vi.fn();
  const view = render(
    <MemoryRouter initialEntries={[`/settings${search}`]}>
      <OidcLinkSettings inputClass="input" labelClass="label" showToast={showToast} />
      <Location />
    </MemoryRouter>,
  );
  return { ...view, showToast };
}

describe('OidcLinkSettings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('stays hidden while linking is unavailable and nothing is linked', async () => {
    const fetchMock = stubFetch({ ...UNLINKED, available: false });
    renderSettings();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText('pages.settings.oidcLink.title')).not.toBeInTheDocument();
  });

  test('starts linking from a local session', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, origin: 'https://ui.example.com', assign });
    const fetchMock = stubFetch(UNLINKED, (url) => url.endsWith('/link/start')
      ? Response.json({ status: 'ok', redirectUrl: 'https://auth.example.com/authorize' })
      : undefined);
    renderSettings();

    await userEvent.click(await screen.findByRole('button', { name: 'pages.settings.oidcLink.link' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://auth.example.com/authorize'));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/auth/oidc/link/start'), { method: 'POST' });
  });

  test('shows a denied identity without a role', async () => {
    stubFetch({ ...LINKED, link: { ...LINKED.link, role: null } });
    renderSettings();

    expect(await screen.findByText(/pages\.settings\.oidcLink\.ssoAccess/)).toBeInTheDocument();
    expect(screen.queryByText(/pages\.settings\.userRoleReadOnly/)).not.toBeInTheDocument();
  });

  test('shows the identity, its access and the recovery path once linked', async () => {
    stubFetch(LINKED);
    renderSettings();

    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(screen.getByText('pages.settings.oidcLink.statusLinked')).toBeInTheDocument();
    expect(screen.getByText(/auth\.example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/pages\.settings\.userRoleReadOnly/)).toBeInTheDocument();
    expect(screen.getByText('pages.settings.oidcLink.recovery')).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', expect.stringContaining('/login?local=1'));
    expect(screen.getByRole('button', { name: 'pages.settings.oidcLink.unlink' })).toBeInTheDocument();
    expect(screen.queryByText('pages.settings.oidcLink.stale')).not.toBeInTheDocument();
  });

  test('warns about weak or unavailable local recovery', async () => {
    stubFetch({ ...LINKED, totpEnabled: false, passwordLoginDisabled: true });
    renderSettings();
    expect(await screen.findByText('pages.settings.oidcLink.totpWarning')).toBeInTheDocument();
    expect(screen.getByText('pages.settings.oidcLink.passwordLoginWarning')).toBeInTheDocument();
  });

  test('marks stale and unverified links', async () => {
    stubFetch({ ...LINKED, link: { ...LINKED.link, provider: 'changed', method: 'username' } });
    renderSettings();
    expect(await screen.findByText('pages.settings.oidcLink.statusStale')).toBeInTheDocument();
    expect(screen.getByText('pages.settings.oidcLink.stale')).toBeInTheDocument();
    expect(screen.getByText('pages.settings.oidcLink.unverified')).toBeInTheDocument();
  });

  test('an unreachable provider is not shown as a changed one', async () => {
    stubFetch({ ...LINKED, link: { ...LINKED.link, provider: 'unavailable' } });
    renderSettings();
    expect(await screen.findByText('pages.settings.oidcLink.statusUnavailable')).toBeInTheDocument();
    expect(screen.getByText('pages.settings.oidcLink.unavailable')).toBeInTheDocument();
    expect(screen.queryByText('pages.settings.oidcLink.stale')).not.toBeInTheDocument();
  });

  test('an SSO session sees the link but no controls or local warnings', async () => {
    stubFetch({ ...LINKED, canManage: false, totpEnabled: false });
    renderSettings();
    expect(await screen.findByText('pages.settings.oidcLink.ssoSessionHint')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'pages.settings.oidcLink.unlink' })).not.toBeInTheDocument();
    expect(screen.queryByText('pages.settings.oidcLink.totpWarning')).not.toBeInTheDocument();
  });

  test('confirms a returned identity with the password and authenticator code', async () => {
    const user = userEvent.setup();
    let status: unknown = PENDING;
    const fetchMock = stubFetch(null, (url, init) => {
      if (url.endsWith('/link/confirm')) {
        status = LINKED;
        return Response.json({ status: 'ok' });
      }
      return url.endsWith('/api/auth/oidc/link') && !init?.method ? Response.json(status) : undefined;
    });
    const { showToast } = renderSettings('?oidcLink=confirm');

    expect(await screen.findByText(/pages\.settings\.oidcLink\.confirmMessage/)).toHaveTextContent('alice');
    expect(screen.getByText(/pages\.settings\.oidcLink\.mergeWarning/)).toHaveTextContent('admin#oidc-1a2b3c4d5e');
    const submit = screen.getByRole('button', { name: 'pages.settings.oidcLink.confirm' });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText('pages.settings.currentPassword'), 'Password1');
    await user.type(screen.getByLabelText('pages.settings.authenticatorCode'), '123456');
    await user.click(submit);

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('pages.settings.oidcLink.linked', 'success'));
    const confirmCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/link/confirm'));
    expect(JSON.parse(String(confirmCall?.[1]?.body))).toEqual({ password: 'Password1', totpCode: '123456', confirmationId: 'attempt-1' });
    await waitFor(() => expect(screen.getByTestId('search')).toBeEmptyDOMElement());
    expect(screen.queryByText(/pages\.settings\.oidcLink\.confirmMessage/)).not.toBeInTheDocument();
    expect(await screen.findByText('pages.settings.oidcLink.statusLinked')).toBeInTheDocument();
  });

  test('keeps the form open with the error when the password is wrong, without ending the session', async () => {
    const user = userEvent.setup();
    const invalidated = vi.fn();
    window.addEventListener('crowdsec-auth-session-invalidated', invalidated);
    stubFetch(PENDING, (url) => url.endsWith('/link/confirm')
      ? Response.json({ error: 'Current password is incorrect' }, { status: 401 })
      : undefined);
    const { showToast } = renderSettings('?oidcLink=confirm');

    await user.type(await screen.findByLabelText('pages.settings.currentPassword'), 'Wrong-password1');
    await user.type(screen.getByLabelText('pages.settings.authenticatorCode'), '123456');
    await user.click(screen.getByRole('button', { name: 'pages.settings.oidcLink.confirm' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Current password is incorrect');
    expect(screen.getByLabelText('pages.settings.authenticatorCode')).toHaveValue('');
    expect(showToast).not.toHaveBeenCalled();
    expect(invalidated).not.toHaveBeenCalled();
    window.removeEventListener('crowdsec-auth-session-invalidated', invalidated);
  });

  test('closes the form and says why when another tab changed the attempt', async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(PENDING, (url) => url.endsWith('/link/confirm')
      ? Response.json({ error: 'This SSO link attempt changed. Start again.', code: 'OIDC_LINK_CHANGED' }, { status: 409 })
      : undefined);
    const { showToast } = renderSettings('?oidcLink=confirm');

    await user.type(await screen.findByLabelText('pages.settings.currentPassword'), 'Password1');
    await user.type(screen.getByLabelText('pages.settings.authenticatorCode'), '123456');
    const statusLoads = () => fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/api/auth/oidc/link') && !init?.method).length;
    const loadsBefore = statusLoads();
    await user.click(screen.getByRole('button', { name: 'pages.settings.oidcLink.confirm' }));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('pages.settings.oidcLink.errorChanged', 'danger'));
    await waitFor(() => expect(screen.getByTestId('search')).toBeEmptyDOMElement());
    expect(screen.queryByText(/pages\.settings\.oidcLink\.confirmMessage/)).not.toBeInTheDocument();
    await waitFor(() => expect(statusLoads()).toBe(loadsBefore + 1));
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  test('cancelling the confirmation clears the outcome', async () => {
    const user = userEvent.setup();
    stubFetch(PENDING);
    renderSettings('?oidcLink=confirm');

    await user.click(await screen.findByRole('button', { name: 'common.cancel' }));
    await waitFor(() => expect(screen.getByTestId('search')).toBeEmptyDOMElement());
    expect(screen.queryByText(/pages\.settings\.oidcLink\.confirmMessage/)).not.toBeInTheDocument();
  });

  test.each([
    ['denied', 'pages.settings.oidcLink.errorDenied'],
    ['taken', 'pages.settings.oidcLink.errorTaken'],
    ['disabled', 'pages.settings.oidcLink.errorDisabled'],
    ['failed', 'pages.settings.oidcLink.errorFailed'],
    ['session', 'pages.settings.oidcLink.errorSession'],
    // The link attempt expired before the browser came back.
    ['confirm', 'pages.settings.oidcLink.errorSession'],
  ])('reports the %s outcome and removes it from the URL', async (outcome, message) => {
    stubFetch(UNLINKED);
    const { showToast } = renderSettings(`?oidcLink=${outcome}&tab=account`);

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(message, 'danger'));
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('?tab=account'));
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  test('unlinks with the password and reloads the state', async () => {
    const user = userEvent.setup();
    let status: unknown = LINKED;
    const fetchMock = stubFetch(null, (url, init) => {
      if (url.endsWith('/api/auth/oidc/link') && init?.method === 'DELETE') {
        status = UNLINKED;
        return Response.json({ status: 'ok' });
      }
      return url.endsWith('/api/auth/oidc/link') ? Response.json(status) : undefined;
    });
    const { showToast } = renderSettings();

    await user.click(await screen.findByRole('button', { name: 'pages.settings.oidcLink.unlink' }));
    await user.type(screen.getByLabelText('pages.settings.currentPassword'), 'Password1');
    await user.type(screen.getByLabelText('pages.settings.authenticatorCode'), '123456');
    const buttons = screen.getAllByRole('button', { name: 'pages.settings.oidcLink.unlink' });
    await user.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('pages.settings.oidcLink.unlinked', 'success'));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
    expect(await screen.findByRole('button', { name: 'pages.settings.oidcLink.link' })).toBeInTheDocument();
  });
});
