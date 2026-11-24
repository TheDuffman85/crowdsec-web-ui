import { apiUrl } from './basePath';
import { sessionFetch } from './sessionFetch';

export type PushSupport = 'ok' | 'insecure' | 'unsupported';

export interface PushStatus {
  public_key: string;
  subscriptions: number;
  subscribed: boolean;
}

/** Push needs a secure context (HTTPS or localhost), a service worker and the Push API. */
export function pushSupport(): PushSupport {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return window?.isSecureContext === false ? 'insecure' : 'unsupported';
  }
  return window.isSecureContext ? 'ok' : 'insecure';
}

/** The browser wants the server key as bytes. */
export function urlBase64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || fallback);
  }
  return response.json() as Promise<T>;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration();
  return registration ? registration.pushManager.getSubscription() : null;
}

export async function fetchPushStatus(): Promise<{ status: PushStatus; permission: NotificationPermission; browserSubscribed: boolean }> {
  const subscription = await currentSubscription();
  const query = subscription ? `?${new URLSearchParams({ endpoint: subscription.endpoint })}` : '';
  const status = await readJson<PushStatus>(await sessionFetch(apiUrl(`/api/push/status${query}`)), 'Failed to load the Web Push status');
  return { status, permission: Notification.permission, browserSubscribed: Boolean(subscription) && status.subscribed };
}

/** Asks for permission, subscribes this browser and tells the server about it. */
export async function enablePush(publicKey: string): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('permission-denied');
  const registration = await navigator.serviceWorker.ready;
  const subscription = (await registration.pushManager.getSubscription())
    ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(publicKey) });
  const json = subscription.toJSON();
  await readJson(await sessionFetch(apiUrl('/api/push/subscribe'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
  }), 'Failed to turn on Web Push');
}

export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await readJson(await sessionFetch(apiUrl('/api/push/unsubscribe'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }), 'Failed to turn off Web Push');
  await subscription.unsubscribe();
}
