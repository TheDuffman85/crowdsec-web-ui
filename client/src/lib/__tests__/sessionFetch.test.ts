import { afterEach, describe, expect, test, vi } from 'vitest';
import { AUTH_SESSION_INVALIDATED_EVENT, sessionFetch } from '../sessionFetch';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sessionFetch', () => {
  test('announces an unauthorized protected request', async () => {
    const listener = vi.fn();
    window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Unauthorized' }, { status: 401 })));

    await sessionFetch('/api/config');

    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);
  });

  test('does not invalidate the session for an expected credential error', async () => {
    const listener = vi.fn();
    window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      { error: 'Current password is incorrect' },
      { status: 401 },
    )));

    await sessionFetch('/api/auth/change-password', { method: 'POST' }, {
      ignoredUnauthorizedErrors: ['Current password is incorrect'],
    });

    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);
  });
});
