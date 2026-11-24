import crypto from 'node:crypto';
import type { NotificationChannel } from '../../../shared/contracts';
import { describe, expect, test, vi } from 'vitest';
import { getNotificationProvider } from '../../notifications/providers';
import { createNotificationSecretStore } from '../../notifications/secret-store';
import { createWebPushService } from '../../notifications/web-push-service';
import { isValidVapidKeys } from '../../notifications/web-push';
import { createAuthSessionCookie, createController } from './harness';

function browser() {
  const key = crypto.createECDH('prime256v1');
  key.generateKeys();
  return { endpoint: `https://push.example.com/send/${crypto.randomBytes(6).toString('hex')}`, keys: { p256dh: key.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
}

describe('web push service', () => {
  test('creates the VAPID pair once, keeps it, and encrypts it when a secret key is set', () => {
    const { controller } = createController();
    const database = controller.database;
    database.db.query('DELETE FROM settings WHERE key = ?').run('webpush_vapid');
    const service = createWebPushService({ database, secretStore: createNotificationSecretStore('secret') });
    const key = service.publicKey();
    const stored = database.getMeta('webpush_vapid')!.value!;
    expect(stored.startsWith('enc:v1:')).toBe(true);
    expect(stored).not.toContain(key);
    expect(createWebPushService({ database, secretStore: createNotificationSecretStore('secret') }).publicKey()).toBe(key);
    // Without the secret key the stored pair cannot be read, so a new one replaces it and old subscriptions are dropped.
    database.db.query('INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth, username, created_at) VALUES (?, ?, ?, ?, ?)').run('https://x.example/1', 'a', 'b', 'u', 'now');
    const fresh = createWebPushService({ database, secretStore: createNotificationSecretStore(undefined) });
    expect(fresh.publicKey()).not.toBe(key);
    expect(fresh.subscriptionCount()).toBe(0);
    const plain = JSON.parse(database.getMeta('webpush_vapid')!.value!) as unknown;
    expect(isValidVapidKeys(plain)).toBe(true);
  });

  test('stores subscriptions, caps them, delivers to all and prunes expired ones', async () => {
    const { controller } = createController();
    const database = controller.database;
    database.db.query('DELETE FROM push_subscriptions').run();
    const service = createWebPushService({ database, secretStore: createNotificationSecretStore('k') });
    const first = browser();
    const second = browser();
    const third = browser();
    for (const entry of [first, second, third]) await service.addSubscription({ endpoint: entry.endpoint, ...entry.keys }, { username: 'admin', userAgent: 'UA' });
    await service.addSubscription({ endpoint: first.endpoint, ...first.keys }, { username: 'other' });
    expect(service.subscriptionCount()).toBe(3);
    expect(service.hasSubscription(first.endpoint)).toBe(true);

    const fetchImpl = vi.fn(async (url: string) => new Response(null, { status: url === second.endpoint ? 410 : url === third.endpoint ? 500 : 201 }));
    const result = await service.sendAll({ title: 't', body: 'b' }, fetchImpl, 'mailto:a@example.com');
    expect(result).toEqual({ total: 3, sent: 1, failed: 1, removed: 1 });
    expect(service.hasSubscription(second.endpoint)).toBe(false);
    expect(database.db.query('SELECT last_success_at FROM push_subscriptions WHERE endpoint = ?').get(first.endpoint)).toMatchObject({ last_success_at: expect.any(String) });
    fetchImpl.mockRejectedValueOnce(new Error('blocked'));
    expect((await service.sendAll({ title: 't', body: 'b' }, fetchImpl, 's')).failed).toBeGreaterThanOrEqual(1);

    expect(await service.removeSubscription(first.endpoint)).toBe(true);
    expect(await service.removeSubscription(first.endpoint)).toBe(false);

    database.db.query('DELETE FROM push_subscriptions').run();
    for (let index = 0; index < 200; index += 1) await service.addSubscription({ endpoint: `https://push.example.com/${index}`, ...first.keys }, { username: 'a' });
    await expect(service.addSubscription({ endpoint: 'https://push.example.com/overflow', ...first.keys }, { username: 'a' })).rejects.toThrow('Too many');
  });
});

describe('webpush channel provider', () => {
  const provider = getNotificationProvider('webpush');
  const payload = {
    title: 'New alert', message: 'ssh-bf\nfrom 203.0.113.5', severity: 'critical' as const, metadata: { event_type: 'decision' }, sent_at: 'now', channel_id: 'c', channel_name: 'Push',
    channel_type: 'webpush' as const, rule_id: null, rule_name: null, rule_type: 'test' as const, app_name: 'App',
  };
  const channel = { id: 'c', name: 'Push', type: 'webpush', config: { webpushSubject: '' } } as unknown as NotificationChannel;
  const context = (webPush: unknown, extra: Record<string, unknown> = {}) => ({
    fetchImpl: vi.fn(), assertHostAllowed: vi.fn(), assertUrlAllowed: vi.fn(async () => {}), webPush, ...extra,
  }) as never;

  test('validates the contact and keeps no secrets', () => {
    expect(provider.validateConfig({ webpushSubject: '' })).toBeNull();
    expect(provider.validateConfig({ webpushSubject: 'mailto:ops@example.com' })).toBeNull();
    expect(provider.validateConfig({ webpushSubject: 'https://soc.example.com' })).toBeNull();
    expect(provider.validateConfig({ webpushSubject: 'http://soc.example.com' })).toMatch(/mailto/);
    expect(provider.validateConfig({ webpushSubject: 'ops' })).toMatch(/mailto/);
    expect(provider.validateConfig({ webpushSubject: `mailto:${'a'.repeat(300)}@x.io` })).toMatch(/200/);
    expect(provider.getConfiguredSecrets({})).toEqual([]);
    expect(provider.normalizeConfig({ subject: ' mailto:a@b.c ' }, { webpushSubject: 'old' })).toEqual({ webpushSubject: 'mailto:a@b.c' });
    expect(provider.normalizeConfig({}, { webpushSubject: 'mailto:keep@b.c' })).toEqual({ webpushSubject: 'mailto:keep@b.c' });
    expect(provider.maskConfig({ webpushSubject: 'x' })).toEqual({ webpushSubject: 'x' });
  });

  test('sends a short message with the right page and subject', async () => {
    const sendAll = vi.fn(async () => ({ total: 2, sent: 2, failed: 0, removed: 0 }));
    await provider.send(channel, payload, context({ subscriptionCount: () => 2, sendAll }, { hostname: 'sec.example.com' }));
    expect(sendAll).toHaveBeenCalledWith({ title: 'New alert', body: 'ssh-bf from 203.0.113.5', severity: 'critical', url: '/decisions' }, expect.any(Function), 'https://sec.example.com');
    await provider.send({ ...channel, config: { webpushSubject: 'mailto:ops@example.com' } }, { ...payload, metadata: {} }, context({ subscriptionCount: () => 1, sendAll }));
    expect(sendAll).toHaveBeenLastCalledWith(expect.objectContaining({ url: '/alerts' }), expect.any(Function), 'mailto:ops@example.com');
    // Every request goes through the outbound guard.
    const ctx = context({ subscriptionCount: () => 1, sendAll: async (_m: unknown, fetchImpl: (url: string, init: RequestInit) => Promise<Response>) => { await fetchImpl('https://push.example.com/x', {}); return { total: 1, sent: 1, failed: 0, removed: 0 }; } }) as { assertUrlAllowed: ReturnType<typeof vi.fn>; fetchImpl: ReturnType<typeof vi.fn> };
    ctx.fetchImpl.mockResolvedValue(new Response(null, { status: 201 }));
    await provider.send(channel, payload, ctx as never);
    expect(ctx.assertUrlAllowed).toHaveBeenCalledWith('https://push.example.com/x', 'Web Push endpoint');
  });

  test('fails clearly when nothing can be delivered', async () => {
    await expect(provider.send(channel, payload, context(undefined))).rejects.toThrow('not available');
    await expect(provider.send(channel, payload, context({ subscriptionCount: () => 0, sendAll: vi.fn() }))).rejects.toThrow('No browsers are subscribed');
    await expect(provider.send(channel, payload, context({ subscriptionCount: () => 1, sendAll: async () => ({ total: 1, sent: 0, failed: 1, removed: 0 }) }))).rejects.toMatchObject({ retriable: true });
    await expect(provider.send(channel, payload, context({ subscriptionCount: () => 1, sendAll: async () => ({ total: 1, sent: 0, failed: 0, removed: 1 }) }))).rejects.toMatchObject({ retriable: false });
  });
});

describe('push API', () => {
  const root = 'http://localhost/crowdsec/api/push';
  async function setup() {
    const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
    const adminId = controller.database.createAuthUser({ username: 'admin', passwordHash: 'h', role: 'admin', authProvider: 'password' });
    const viewerId = controller.database.createAuthUser({ username: 'viewer', passwordHash: 'h', role: 'read-only', authProvider: 'password' });
    const admin = createAuthSessionCookie(controller.database, { userId: adminId, username: 'admin', role: 'admin', authMethod: 'password' });
    const viewer = createAuthSessionCookie(controller.database, { userId: viewerId, username: 'viewer', role: 'read-only', authMethod: 'password' });
    const call = (path: string, cookie?: string, body?: unknown) => controller.fetch(new Request(`${root}${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    }));
    return { controller, admin, viewer, call };
  }

  test('is for administrators only', async () => {
    const { admin, viewer, call } = await setup();
    const entry = browser();
    expect((await call('/status')).status).toBe(401);
    expect((await call('/status', viewer)).status).toBe(403);
    expect((await call('/subscribe', viewer, { endpoint: entry.endpoint, keys: entry.keys })).status).toBe(403);
    expect((await call('/unsubscribe', viewer, { endpoint: entry.endpoint })).status).toBe(403);
    expect((await call('/status', admin)).status).toBe(200);
  });

  test('subscribes, reports status without leaking the private key, and unsubscribes', async () => {
    const { admin, call } = await setup();
    const entry = browser();
    const status = await (await call(`/status?endpoint=${encodeURIComponent(entry.endpoint)}`, admin)).json() as Record<string, unknown>;
    expect(status).toMatchObject({ subscribed: false, subscriptions: 0 });
    expect(Object.keys(status).sort()).toEqual(['public_key', 'subscribed', 'subscriptions']);
    expect(String(status.public_key)).toHaveLength(87);
    expect(JSON.stringify(status)).not.toMatch(/private/i);

    expect((await call('/subscribe', admin, { endpoint: 'http://insecure.example/x', keys: entry.keys })).status).toBe(400);
    expect((await call('/subscribe', admin, { endpoint: entry.endpoint })).status).toBe(400);
    const created = await call('/subscribe', admin, { endpoint: entry.endpoint, keys: entry.keys });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ subscriptions: 1 });
    expect(await (await call(`/status?endpoint=${encodeURIComponent(entry.endpoint)}`, admin)).json()).toMatchObject({ subscribed: true });

    expect((await call('/unsubscribe', admin, {})).status).toBe(400);
    expect(await (await call('/unsubscribe', admin, { endpoint: entry.endpoint })).json()).toMatchObject({ removed: true, subscriptions: 0 });
    expect(await (await call('/unsubscribe', admin, { endpoint: entry.endpoint })).json()).toMatchObject({ removed: false });
  });
});

describe('PWA files', () => {
  test('serves the service worker uncached, the offline page and an installable manifest', async () => {
    const { controller } = createController();
    const worker = await controller.fetch(new Request('http://localhost/crowdsec/sw.js'));
    expect(worker.status).toBe(200);
    expect(worker.headers.get('cache-control')).toBe('no-cache');
    expect(worker.headers.get('content-type')).toContain('javascript');
    expect((await controller.fetch(new Request('http://localhost/crowdsec/offline.html'))).status).toBe(200);
    const manifest = await (await controller.fetch(new Request('http://localhost/crowdsec/site.webmanifest'))).json() as { scope: string; id: string; shortcuts: Array<{ url: string }>; display: string };
    expect(manifest).toMatchObject({ scope: '/crowdsec/', id: '/crowdsec/', display: 'standalone' });
    expect(manifest.shortcuts.map((shortcut) => shortcut.url)).toEqual(['/crowdsec/alerts', '/crowdsec/decisions', '/crowdsec/tools/wallboard']);
  });
});
