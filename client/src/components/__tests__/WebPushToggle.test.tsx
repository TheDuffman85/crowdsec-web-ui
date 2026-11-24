import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WebPushToggle } from '../WebPushToggle';

const mocks = vi.hoisted(() => ({ pushSupport: vi.fn(), fetchPushStatus: vi.fn(), enablePush: vi.fn(), disablePush: vi.fn() }));
vi.mock('../../lib/webPush', () => mocks);

const status = (overrides = {}) => ({ status: { public_key: 'KEY', subscriptions: 1, subscribed: false }, permission: 'default', browserSubscribed: false, ...overrides });

afterEach(() => vi.clearAllMocks());

describe('WebPushToggle', () => {
  test('explains that HTTPS is needed and when push is unsupported', () => {
    mocks.pushSupport.mockReturnValue('insecure');
    const view = render(<WebPushToggle />);
    expect(screen.getByRole('note')).toHaveTextContent('only works when this page is opened over HTTPS');
    expect(mocks.fetchPushStatus).not.toHaveBeenCalled();
    mocks.pushSupport.mockReturnValue('unsupported');
    view.rerender(<WebPushToggle />);
    expect(screen.getByRole('note')).toHaveTextContent('does not support Web Push');
  });

  test('turns push on for this browser and refreshes the count', async () => {
    const user = userEvent.setup();
    mocks.pushSupport.mockReturnValue('ok');
    mocks.fetchPushStatus.mockResolvedValueOnce(status()).mockResolvedValueOnce(status({ browserSubscribed: true, status: { public_key: 'KEY', subscriptions: 2, subscribed: true } }));
    render(<WebPushToggle />);
    expect(await screen.findByText('Browsers subscribed: 1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Turn on for this browser' }));
    expect(mocks.enablePush).toHaveBeenCalledWith('KEY');
    expect(await screen.findByText('Browsers subscribed: 2')).toBeInTheDocument();
    mocks.fetchPushStatus.mockResolvedValueOnce(status());
    await user.click(screen.getByRole('button', { name: 'Turn off for this browser' }));
    expect(mocks.disablePush).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Turn on for this browser' })).toBeEnabled());
  });

  test('reports a refused permission, a blocked site and failures', async () => {
    const user = userEvent.setup();
    mocks.pushSupport.mockReturnValue('ok');
    mocks.fetchPushStatus.mockResolvedValue(status());
    mocks.enablePush.mockRejectedValueOnce(new Error('permission-denied'));
    render(<WebPushToggle />);
    await user.click(await screen.findByRole('button', { name: 'Turn on for this browser' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Permission was not granted');
    mocks.enablePush.mockRejectedValueOnce(new Error('Server said no'));
    await user.click(screen.getByRole('button', { name: 'Turn on for this browser' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Server said no'));
  });

  test('disables the button when notifications are blocked and shows load errors', async () => {
    mocks.pushSupport.mockReturnValue('ok');
    mocks.fetchPushStatus.mockResolvedValueOnce(status({ permission: 'denied' }));
    const view = render(<WebPushToggle />);
    expect(await screen.findByText(/blocked for this site/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn on for this browser' })).toBeDisabled();
    view.unmount();
    mocks.fetchPushStatus.mockRejectedValueOnce(new Error('boom'));
    render(<WebPushToggle />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });
});
