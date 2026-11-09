import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18next from 'i18next';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { I18nProvider } from '../../lib/I18nProvider';
import { LANGUAGE_SETTING_KEY } from '../../lib/i18n';
import { hasOidcAutoLoginRetried, setOidcAutoLoginRetried, setOidcAutoLoginSuppressed } from '../../lib/oidcAutoLogin';
import { Login } from '../Login';

const { loginMock, refreshMock, useAuthMock } = vi.hoisted(() => ({
  loginMock: vi.fn(),
  refreshMock: vi.fn(),
  useAuthMock: vi.fn(),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: useAuthMock,
}));

vi.mock('../../lib/api', () => ({
  updateLanguagePreference: vi.fn(async (language: string) => ({ success: true, language })),
}));

function createAuthState(overrides: Record<string, unknown> = {}) {
  return {
    authEnabled: true,
    setupRequired: false,
    authenticated: false,
    user: null,
    authMethod: null,
    oidcEnabled: false,
    oidcAutoLogin: false,
    passwordLoginDisabled: false,
    passkeysEnabled: false,
    hasPassword: true,
    totpEnabled: false,
    loading: false,
    refresh: refreshMock,
    login: loginMock,
    setup: vi.fn(),
    logout: vi.fn(),
    ...overrides,
  };
}

describe('Login', () => {
  beforeEach(() => {
    loginMock.mockReset();
    refreshMock.mockReset();
    useAuthMock.mockReturnValue(createAuthState());
  });

  afterEach(async () => {
    cleanup();
    localStorage.clear();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    await i18next.changeLanguage('en');
  });

  function renderWithAutoLogin(overrides: Record<string, unknown> = {}, initialEntry = '/login') {
    const replace = vi.fn();
    vi.stubGlobal('location', { ...window.location, replace });
    useAuthMock.mockReturnValue(createAuthState({
      oidcEnabled: true,
      oidcAutoLogin: true,
      passwordLoginDisabled: true,
      ...overrides,
    }));
    render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Login />
      </MemoryRouter>,
    );
    return replace;
  }

  test('redirects to the identity provider when auto-login is active', async () => {
    const replace = renderWithAutoLogin();

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/api/auth/oidc/login'));
    expect(screen.getByRole('status')).toHaveTextContent('Redirecting to single sign-on…');
    expect(screen.getByRole('link', { name: 'Continue with SSO' })).toBeInTheDocument();
  });

  test('stays on the login page when auto-login is inactive', async () => {
    const replace = renderWithAutoLogin({ oidcAutoLogin: false });

    expect(await screen.findByRole('link', { name: 'Continue with SSO' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  test('stays on the login page when opened with ?local=1', async () => {
    const replace = renderWithAutoLogin({}, '/login?local=1');

    expect(await screen.findByRole('link', { name: 'Continue with SSO' })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  test('stays on the login page right after a logout', async () => {
    setOidcAutoLoginSuppressed(true);
    const replace = renderWithAutoLogin();

    expect(await screen.findByRole('link', { name: 'Continue with SSO' })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  test('starts an expired SSO sign-in again once', async () => {
    const replace = renderWithAutoLogin({}, '/login?oidcError=expired');

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/api/auth/oidc/login'));
    expect(hasOidcAutoLoginRetried()).toBe(true);
  });

  test('does not start an expired SSO sign-in again when the retry cannot be stored', async () => {
    const storage = window.sessionStorage;
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => storage.getItem(key),
      setItem: () => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      },
      removeItem: (key: string) => storage.removeItem(key),
      clear: () => storage.clear(),
    });
    const replace = renderWithAutoLogin({}, '/login?oidcError=expired');

    expect(await screen.findByText('Your sign-in session expired. Please sign in again.')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  test('stops after an expired SSO sign-in that was already started again', async () => {
    setOidcAutoLoginRetried(true);
    const replace = renderWithAutoLogin({}, '/login?oidcError=expired');

    expect(await screen.findByText('Your sign-in session expired. Please sign in again.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue with SSO' })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  test.each([
    ['failed', 'Single sign-on failed. Please try again or contact your administrator.'],
    ['denied', 'Your account is not allowed to sign in to this dashboard.'],
  ])('shows a %s SSO sign-in without starting it again', async (reason, message) => {
    const replace = renderWithAutoLogin({}, `/login?oidcError=${reason}`);

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue with SSO' })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  test('shows an expired SSO sign-in when auto-login is inactive', async () => {
    const replace = renderWithAutoLogin({ oidcAutoLogin: false, passwordLoginDisabled: false }, '/login?oidcError=expired');

    expect(await screen.findByText('Your sign-in session expired. Please sign in again.')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    expect(hasOidcAutoLoginRetried()).toBe(false);
  });

  test('uses the stored language preference for login copy', async () => {
    localStorage.setItem(LANGUAGE_SETTING_KEY, 'de');

    const { unmount } = render(
      <I18nProvider>
        <MemoryRouter>
          <Login />
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'Willkommen zurück' })).toBeInTheDocument();
    expect(screen.getByText('Melde dich bei CrowdSec Web UI an')).toBeInTheDocument();
    expect(screen.getByLabelText('Benutzername')).toBeInTheDocument();
    expect(screen.getByLabelText('Passwort')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anmelden' })).toBeInTheDocument();

    unmount();
    await i18next.changeLanguage('en');
  });

  test('hides credentials while prompting for TOTP and submits the accepted credentials with the code', async () => {
    const user = userEvent.setup();
    loginMock
      .mockRejectedValueOnce(Object.assign(new Error('Authenticator code required'), { requiresTotp: true }))
      .mockResolvedValueOnce(undefined);

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'Secret123');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    await screen.findByLabelText('Authenticator code');
    expect(screen.getByText('Authenticator code required')).toHaveClass('text-amber-100');
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Authenticator code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    await waitFor(() => expect(loginMock).toHaveBeenLastCalledWith('admin', 'Secret123', '123456'));
  });

  test('uses app validation instead of native browser validation for empty credentials', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    const submitButton = screen.getByRole('button', { name: 'Sign In' });
    expect(submitButton.closest('form')).toHaveAttribute('novalidate');

    await user.click(submitButton);

    expect(await screen.findByText('Enter your username and password.')).toHaveClass('text-red-200');
    expect(loginMock).not.toHaveBeenCalled();
  });

  test('shows app validation for non-numeric TOTP codes', async () => {
    const user = userEvent.setup();
    loginMock.mockRejectedValueOnce(Object.assign(new Error('Authenticator code required'), { requiresTotp: true }));

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'Secret123');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));
    await screen.findByLabelText('Authenticator code');

    await user.type(screen.getByLabelText('Authenticator code'), 'sf');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    expect(await screen.findByText('Authenticator code can only contain digits and spaces.')).toHaveClass('text-red-200');
    expect(loginMock).toHaveBeenCalledTimes(1);
  });

  test('shows invalid TOTP attempts as errors', async () => {
    const user = userEvent.setup();
    loginMock
      .mockRejectedValueOnce(Object.assign(new Error('Authenticator code required'), { requiresTotp: true }))
      .mockRejectedValueOnce(Object.assign(new Error('Invalid authenticator code'), { requiresTotp: true }));

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'Secret123');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));
    await screen.findByLabelText('Authenticator code');

    await user.type(screen.getByLabelText('Authenticator code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    expect(await screen.findByText('Invalid authenticator code')).toHaveClass('text-red-200');
  });

  test('can reset from the TOTP prompt back to password login', async () => {
    const user = userEvent.setup();
    loginMock.mockRejectedValueOnce(Object.assign(new Error('Authenticator code required'), { requiresTotp: true }));
    useAuthMock.mockReturnValue({
      authEnabled: true,
      setupRequired: false,
      authenticated: false,
      user: null,
      authMethod: null,
      oidcEnabled: true,
      passwordLoginDisabled: false,
      passkeysEnabled: true,
      hasPassword: true,
      totpEnabled: false,
      loading: false,
      refresh: refreshMock,
      login: loginMock,
      setup: vi.fn(),
      logout: vi.fn(),
    });

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Sign In with Passkey' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue with SSO' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'Secret123');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));
    await screen.findByLabelText('Authenticator code');
    expect(screen.queryByRole('button', { name: 'Sign In with Passkey' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Continue with SSO' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Change' }));

    expect(screen.getByLabelText('Username')).toHaveValue('admin');
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.queryByLabelText('Authenticator code')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign In with Passkey' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue with SSO' })).toBeInTheDocument();
  });
});
