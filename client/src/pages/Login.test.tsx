import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Login } from './Login';

const { loginMock, refreshMock, useAuthMock } = vi.hoisted(() => ({
  loginMock: vi.fn(),
  refreshMock: vi.fn(),
  useAuthMock: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: useAuthMock,
}));

describe('Login', () => {
  beforeEach(() => {
    loginMock.mockReset();
    refreshMock.mockReset();
    useAuthMock.mockReturnValue({
      authEnabled: true,
      setupRequired: false,
      authenticated: false,
      user: null,
      authMethod: null,
      oidcEnabled: false,
      passwordLoginDisabled: false,
      passkeysEnabled: false,
      hasPassword: true,
      totpEnabled: false,
      loading: false,
      refresh: refreshMock,
      login: loginMock,
      setup: vi.fn(),
      logout: vi.fn(),
    });
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

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'Secret123');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));
    await screen.findByLabelText('Authenticator code');

    await user.click(screen.getByRole('button', { name: 'Change' }));

    expect(screen.getByLabelText('Username')).toHaveValue('admin');
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.queryByLabelText('Authenticator code')).not.toBeInTheDocument();
  });
});
