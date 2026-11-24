import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { disablePush, enablePush, fetchPushStatus, pushSupport, urlBase64ToBytes } from '../webPush';

const mocks = vi.hoisted(() => ({ sessionFetch: vi.fn() }));
vi.mock('../sessionFetch', () => ({ sessionFetch: mocks.sessionFetch }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function installBrowser(options: { secure?: boolean; permission?: NotificationPermission; subscription?: Partial<PushSubscription> | null } = {}) {
  const subscription = options.subscription === undefined ? null : options.subscription;
  const pushManager = {
    getSubscription: vi.fn(async () => subscription),
    subscribe: vi.fn(async () => ({ endpoint: 'https://push.example.com/new', toJSON: () => ({ endpoint: 'https://push.example.com/new', keys: { p256dh: 'p', auth: 'a' } }), unsubscribe: vi.fn() })),
  };
  const registration = { pushManager };
  vi.stubGlobal('Notification', Object.assign(function Notification() {}, { permission: options.permission ?? 'default', requestPermission: vi.fn(async () => options.permission ?? 'granted') }));
  Object.defineProperty(window, 'isSecureContext', { value: options.secure ?? true, configurable: true });
  Object.defineProperty(window, 'PushManager', { value: function PushManager() {}, configurable: true });
  Object.defineProperty(navigator, 'serviceWorker', { value: { getRegistration: vi.fn(async () => registration), ready: Promise.resolve(registration) }, configurable: true });
  return { pushManager, registration };
}

beforeEach(() => mocks.sessionFetch.mockReset());
afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).PushManager;
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
});

describe('pushSupport', () => {
  test('reports whether push can work here', () => {
    expect(pushSupport()).toBe('unsupported');
    installBrowser({ secure: true });
    expect(pushSupport()).toBe('ok');
    installBrowser({ secure: false });
    expect(pushSupport()).toBe('insecure');
  });
});

describe('urlBase64ToBytes', () => {
  test('decodes unpadded base64url', () => {
    expect([...urlBase64ToBytes('AQID_w')]).toEqual([1, 2, 3, 255]);
    expect(urlBase64ToBytes('')).toHaveLength(0);
  });
});

describe('push calls', () => {
  test('reads the status and whether this browser is subscribed', async () => {
    installBrowser({ subscription: { endpoint: 'https://push.example.com/me' }, permission: 'granted' });
    mocks.sessionFetch.mockResolvedValue(json({ public_key: 'KEY', subscriptions: 2, subscribed: true }));
    const result = await fetchPushStatus();
    expect(result).toEqual({ status: { public_key: 'KEY', subscriptions: 2, subscribed: true }, permission: 'granted', browserSubscribed: true });
    expect(String(mocks.sessionFetch.mock.calls[0]![0])).toContain('/api/push/status?endpoint=https%3A%2F%2Fpush.example.com%2Fme');
  });

  test('treats a browser the server does not know as not subscribed', async () => {
    installBrowser({ subscription: { endpoint: 'https://push.example.com/me' } });
    mocks.sessionFetch.mockResolvedValue(json({ public_key: 'KEY', subscriptions: 0, subscribed: false }));
    expect((await fetchPushStatus()).browserSubscribed).toBe(false);
  });

  test('surfaces server errors', async () => {
    installBrowser();
    mocks.sessionFetch.mockResolvedValue(json({ error: 'Administrator access required' }, 403));
    await expect(fetchPushStatus()).rejects.toThrow('Administrator access required');
    mocks.sessionFetch.mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(fetchPushStatus()).rejects.toThrow('Failed to load the Web Push status');
  });

  test('subscribes with the server key and sends the subscription', async () => {
    const { pushManager } = installBrowser();
    mocks.sessionFetch.mockResolvedValue(json({ success: true }, 201));
    await enablePush('AQID_w');
    const options = (pushManager.subscribe.mock.calls as unknown as unknown[][])[0]![0] as { userVisibleOnly: boolean; applicationServerKey: Uint8Array };
    expect(options.userVisibleOnly).toBe(true);
    expect([...options.applicationServerKey]).toEqual([1, 2, 3, 255]);
    const [, init] = mocks.sessionFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ endpoint: 'https://push.example.com/new', keys: { p256dh: 'p', auth: 'a' } });
  });

  test('reuses an existing subscription and stops when permission is refused', async () => {
    const existing = { endpoint: 'https://push.example.com/old', toJSON: () => ({ endpoint: 'https://push.example.com/old', keys: { p256dh: 'p', auth: 'a' } }) };
    const { pushManager } = installBrowser({ subscription: existing });
    mocks.sessionFetch.mockResolvedValue(json({ success: true }, 201));
    await enablePush('AQID');
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    installBrowser({ permission: 'denied' });
    await expect(enablePush('AQID')).rejects.toThrow('permission-denied');
  });

  test('unsubscribes on the server and in the browser', async () => {
    const unsubscribe = vi.fn(async () => true);
    installBrowser({ subscription: { endpoint: 'https://push.example.com/me', unsubscribe } });
    mocks.sessionFetch.mockResolvedValue(json({ success: true, removed: true }));
    await disablePush();
    expect(JSON.parse(String((mocks.sessionFetch.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ endpoint: 'https://push.example.com/me' });
    expect(unsubscribe).toHaveBeenCalled();
    installBrowser({ subscription: null });
    mocks.sessionFetch.mockClear();
    await disablePush();
    expect(mocks.sessionFetch).not.toHaveBeenCalled();
  });
});
