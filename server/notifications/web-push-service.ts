import type { CrowdsecDatabase } from '../database';
import type { NotificationSecretStore } from './secret-store';
import {
  generateVapidKeys, isValidVapidKeys, sendPush, type PushMessage, type PushSubscriptionKeys, type VapidKeys,
} from './web-push';

const VAPID_SETTING = 'webpush_vapid';
const MAX_SUBSCRIPTIONS = 200;

export interface StoredSubscription extends PushSubscriptionKeys {
  username: string;
  user_agent: string | null;
  created_at: string;
  last_success_at: string | null;
}

export interface PushDeliveryResult {
  total: number;
  sent: number;
  failed: number;
  removed: number;
}

export interface WebPushDelivery {
  subscriptionCount(): number;
  sendAll(message: PushMessage, fetchImpl: (url: string, init: RequestInit) => Promise<Response>, subject: string): Promise<PushDeliveryResult>;
}

export interface WebPushService extends WebPushDelivery {
  /** The key browsers subscribe with. Creates the key pair on first use. */
  publicKey(): string;
  addSubscription(subscription: PushSubscriptionKeys, owner: { username: string; userAgent?: string | null }): Promise<void>;
  removeSubscription(endpoint: string): Promise<boolean>;
  hasSubscription(endpoint: string): boolean;
}

/**
 * Keeps the VAPID key pair and the browser subscriptions. The private key
 * stays in the state database (encrypted when a notification secret key is
 * set) and is never returned by an API or written to a log.
 */
export function createWebPushService(options: {
  database: CrowdsecDatabase;
  secretStore: NotificationSecretStore;
  /** Runs a database write the way the rest of the application does, away from the sync worker's writes. */
  write?: <T>(operation: () => T) => Promise<T>;
}): WebPushService {
  const { database, secretStore } = options;
  const write = options.write ?? (async <T,>(operation: () => T) => operation());
  let cached: VapidKeys | null = null;

  function loadKeys(): VapidKeys {
    if (cached) return cached;
    const stored = database.getMeta(VAPID_SETTING)?.value;
    if (stored) {
      try {
        const parsed = secretStore.parseConfig(stored).config;
        if (isValidVapidKeys(parsed)) {
          cached = parsed;
          return parsed;
        }
      } catch {
        // An unreadable or damaged key is replaced below; subscriptions made with it stop working, so they are dropped.
      }
      database.db.query('DELETE FROM push_subscriptions').run();
    }
    const keys = generateVapidKeys();
    database.setMeta(VAPID_SETTING, secretStore.serializeConfig({ ...keys }, secretStore.hasKey()));
    cached = keys;
    return keys;
  }

  const list = (): StoredSubscription[] => database.db.query(
    'SELECT endpoint, p256dh, auth, username, user_agent, created_at, last_success_at FROM push_subscriptions ORDER BY created_at',
  ).all() as StoredSubscription[];

  return {
    publicKey: () => loadKeys().publicKey,
    addSubscription: (subscription, owner) => write(() => {
      const existing = database.db.query('SELECT 1 AS found FROM push_subscriptions WHERE endpoint = ?').get(subscription.endpoint);
      if (!existing) {
        const count = (database.db.query('SELECT COUNT(*) AS count FROM push_subscriptions').get() as { count: number }).count;
        if (count >= MAX_SUBSCRIPTIONS) throw new Error('Too many browsers are subscribed to Web Push');
      }
      database.db.query(`
        INSERT INTO push_subscriptions (endpoint, p256dh, auth, username, user_agent, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, username = excluded.username, user_agent = excluded.user_agent
      `).run(subscription.endpoint, subscription.p256dh, subscription.auth, owner.username, owner.userAgent?.slice(0, 200) ?? null, new Date().toISOString());
    }),
    removeSubscription: (endpoint) => write(() => database.db.query('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes > 0),
    hasSubscription: (endpoint) => Boolean(database.db.query('SELECT 1 AS found FROM push_subscriptions WHERE endpoint = ?').get(endpoint)),
    subscriptionCount: () => (database.db.query('SELECT COUNT(*) AS count FROM push_subscriptions').get() as { count: number }).count,
    async sendAll(message, fetchImpl, subject) {
      const keys = loadKeys();
      const subscriptions = list();
      const result: PushDeliveryResult = { total: subscriptions.length, sent: 0, failed: 0, removed: 0 };
      await Promise.all(subscriptions.map(async (subscription) => {
        try {
          const outcome = await sendPush(subscription, message, { keys, subject, fetchImpl });
          if (outcome.ok) {
            result.sent += 1;
            await write(() => database.db.query('UPDATE push_subscriptions SET last_success_at = ? WHERE endpoint = ?').run(new Date().toISOString(), subscription.endpoint));
          } else if (outcome.gone) {
            result.removed += 1;
            await write(() => database.db.query('DELETE FROM push_subscriptions WHERE endpoint = ?').run(subscription.endpoint));
          } else {
            result.failed += 1;
          }
        } catch {
          // The endpoint was refused by the outbound guard or unreachable.
          result.failed += 1;
        }
      }));
      return result;
    },
  };
}
