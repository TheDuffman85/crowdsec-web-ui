import crypto from 'node:crypto';

/*
 * Web Push without third-party packages: VAPID (RFC 8292) for identifying this
 * server and aes128gcm content encryption (RFC 8291) for the message. Only
 * Node's crypto is used, so the browser's push service never sees the text.
 */

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url. Browsers need it to subscribe. */
  publicKey: string;
  /** Raw P-256 private scalar, base64url. Never log or return it. */
  privateKey: string;
}

export interface PushSubscriptionKeys {
  endpoint: string;
  /** The browser's public key, base64url. */
  p256dh: string;
  /** The subscription's auth secret, base64url. */
  auth: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Same tag replaces an earlier notification instead of stacking. */
  tag?: string;
  /** Path to open on click, relative to the app. */
  url?: string;
  severity?: 'info' | 'warning' | 'critical';
}

const RECORD_SIZE = 4096;
const MAX_PAYLOAD_BYTES = RECORD_SIZE - 17 - 1;
const JWT_LIFETIME_SECONDS = 12 * 3600;

const b64u = (buffer: Buffer): string => buffer.toString('base64url');
const fromB64u = (value: string): Buffer => Buffer.from(value, 'base64url');

export function generateVapidKeys(): VapidKeys {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

export function isValidVapidKeys(keys: unknown): keys is VapidKeys {
  if (!keys || typeof keys !== 'object') return false;
  const { publicKey, privateKey } = keys as Partial<VapidKeys>;
  if (typeof publicKey !== 'string' || typeof privateKey !== 'string') return false;
  try {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(fromB64u(privateKey));
    return b64u(ecdh.getPublicKey()) === publicKey;
  } catch {
    return false;
  }
}

/** A push endpoint must be an https URL on a public host (the outbound guard checks the address). */
export function isValidSubscription(value: unknown): value is PushSubscriptionKeys {
  if (!value || typeof value !== 'object') return false;
  const { endpoint, p256dh, auth } = value as Partial<PushSubscriptionKeys>;
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || typeof p256dh !== 'string' || typeof auth !== 'string') return false;
  try {
    if (new URL(endpoint).protocol !== 'https:') return false;
    return fromB64u(p256dh).length === 65 && fromB64u(p256dh)[0] === 0x04 && fromB64u(auth).length === 16;
  } catch {
    return false;
  }
}

function privateKeyObject(keys: VapidKeys): crypto.KeyObject {
  const publicKey = fromB64u(keys.publicKey);
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(publicKey.subarray(1, 33)), y: b64u(publicKey.subarray(33, 65)) },
    format: 'jwk',
  });
}

/** The `Authorization` header value that identifies this server to the push service. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + JWT_LIFETIME_SECONDS,
    sub: subject,
  })));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: privateKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

/** Encrypts a message for one subscription (RFC 8291). `ephemeral` and `salt` are only for tests. */
export function encryptPayload(
  plaintext: Buffer,
  subscription: Pick<PushSubscriptionKeys, 'p256dh' | 'auth'>,
  options: { ephemeral?: crypto.ECDH; salt?: Buffer } = {},
): Buffer {
  if (plaintext.length > MAX_PAYLOAD_BYTES) throw new Error('Push message is too large');
  const userPublic = fromB64u(subscription.p256dh);
  const authSecret = fromB64u(subscription.auth);
  const ephemeral = options.ephemeral ?? (() => { const key = crypto.createECDH('prime256v1'); key.generateKeys(); return key; })();
  const serverPublic = ephemeral.getPublicKey();
  const salt = options.salt ?? crypto.randomBytes(16);

  const sharedSecret = ephemeral.computeSecret(userPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), userPublic, serverPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const contentKey = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = crypto.createCipheriv('aes-128-gcm', contentKey, nonce);
  // 0x02 marks the last (here the only) record.
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(serverPublic.length, 20);
  return Buffer.concat([header, serverPublic, encrypted]);
}

export interface PushResult {
  /** The subscription is gone for good and should be forgotten. */
  gone: boolean;
  ok: boolean;
  status: number;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Sends one message. `fetchImpl` must be the outbound-guarded fetch. */
export async function sendPush(
  subscription: PushSubscriptionKeys,
  message: PushMessage,
  options: { keys: VapidKeys; subject: string; fetchImpl: FetchLike; ttlSeconds?: number; now?: number },
): Promise<PushResult> {
  const body = encryptPayload(Buffer.from(JSON.stringify(message)), subscription);
  const response = await options.fetchImpl(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuthorization(subscription.endpoint, options.keys, options.subject, options.now),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(options.ttlSeconds ?? 3600),
      Urgency: message.severity === 'critical' ? 'high' : 'normal',
    },
    body: new Uint8Array(body),
  });
  return { ok: response.ok, status: response.status, gone: response.status === 404 || response.status === 410 };
}
