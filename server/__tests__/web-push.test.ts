import crypto from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import {
  encryptPayload, generateVapidKeys, isValidSubscription, isValidVapidKeys, sendPush, vapidAuthorization,
} from '../notifications/web-push';

const b64u = (value: string) => Buffer.from(value, 'base64url');

// Appendix A of RFC 8291.
const RFC = {
  plaintext: b64u('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
};

function subscription() {
  const browser = crypto.createECDH('prime256v1');
  browser.generateKeys();
  const auth = crypto.randomBytes(16);
  return { browser, auth, keys: { endpoint: 'https://push.example.com/send/abc', p256dh: browser.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}

/** What a browser does with a push message, for checking the round trip. */
function decrypt(body: Buffer, browser: crypto.ECDH, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idLength = body[20]!;
  const serverPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);
  const shared = browser.computeSecret(serverPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), browser.getPublicKey(), serverPublic]), 32));
  const key = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  expect(padded.at(-1)).toBe(2);
  return padded.subarray(0, -1);
}

describe('VAPID keys', () => {
  test('are generated as a valid pair and checked', () => {
    const keys = generateVapidKeys();
    expect(b64u(keys.publicKey)).toHaveLength(65);
    expect(b64u(keys.privateKey)).toHaveLength(32);
    expect(isValidVapidKeys(keys)).toBe(true);
    expect(isValidVapidKeys({ ...keys, publicKey: generateVapidKeys().publicKey })).toBe(false);
    expect(isValidVapidKeys({ publicKey: 'x', privateKey: 'y' })).toBe(false);
    expect(isValidVapidKeys(null)).toBe(false);
    expect(generateVapidKeys().privateKey).not.toBe(keys.privateKey);
  });

  test('sign a JWT that verifies with the public key and names the push service origin', () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:admin@example.com', 1_700_000_000_000);
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header)!;
    expect(match[4]).toBe(keys.publicKey);
    expect(JSON.parse(b64u(match[1]!).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(b64u(match[2]!).toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_700_043_200, sub: 'mailto:admin@example.com' });
    const publicKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(keys.publicKey).subarray(1, 33).toString('base64url'), y: b64u(keys.publicKey).subarray(33).toString('base64url') }, format: 'jwk' });
    expect(crypto.verify('sha256', Buffer.from(`${match[1]}.${match[2]}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, b64u(match[3]!))).toBe(true);
  });
});

describe('payload encryption', () => {
  test('matches the RFC 8291 test vector', () => {
    const ephemeral = crypto.createECDH('prime256v1');
    ephemeral.setPrivateKey(b64u(RFC.asPrivate));
    const body = encryptPayload(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.auth }, { ephemeral, salt: b64u(RFC.salt) });
    expect(body.toString('hex')).toBe(Buffer.concat([b64u(RFC.header), b64u(RFC.ciphertext)]).toString('hex'));
  });

  test('round-trips for a browser holding the matching key and rejects oversized messages', () => {
    const { browser, auth, keys } = subscription();
    const message = Buffer.from(JSON.stringify({ title: 'Ban', body: 'ünïcode ✓' }));
    expect(decrypt(encryptPayload(message, keys), browser, auth).toString()).toBe(message.toString());
    expect(encryptPayload(message, keys).equals(encryptPayload(message, keys))).toBe(false);
    expect(() => encryptPayload(Buffer.alloc(4079), keys)).toThrow('too large');
    expect(() => encryptPayload(Buffer.alloc(4078), keys)).not.toThrow();
  });
});

describe('subscription validation', () => {
  test('accepts a real subscription and rejects the rest', () => {
    const { keys } = subscription();
    expect(isValidSubscription(keys)).toBe(true);
    expect(isValidSubscription({ ...keys, endpoint: 'http://push.example.com/x' })).toBe(false);
    expect(isValidSubscription({ ...keys, endpoint: 'not a url' })).toBe(false);
    expect(isValidSubscription({ ...keys, endpoint: `https://x.example/${'a'.repeat(2100)}` })).toBe(false);
    expect(isValidSubscription({ ...keys, auth: 'short' })).toBe(false);
    expect(isValidSubscription({ ...keys, p256dh: keys.auth })).toBe(false);
    expect(isValidSubscription(null)).toBe(false);
    expect(isValidSubscription({ endpoint: 1 })).toBe(false);
  });
});

describe('sendPush', () => {
  test('posts an encrypted body with VAPID headers and reports gone subscriptions', async () => {
    const { browser, auth, keys } = subscription();
    const vapid = generateVapidKeys();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    const result = await sendPush(keys, { title: 'Alert', body: 'ssh-bf from 203.0.113.5', severity: 'critical', url: '/alerts' }, { keys: vapid, subject: 'mailto:a@example.com', fetchImpl });
    expect(result).toEqual({ ok: true, status: 201, gone: false });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(keys.endpoint);
    const headers = init.headers as Record<string, string>;
    expect(headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', TTL: '3600', Urgency: 'high' });
    expect(headers.Authorization).toContain(`k=${vapid.publicKey}`);
    expect(JSON.parse(decrypt(Buffer.from(init.body as Uint8Array), browser, auth).toString())).toMatchObject({ title: 'Alert', url: '/alerts' });
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 410 }));
    expect(await sendPush(keys, { title: 'x', body: 'y' }, { keys: vapid, subject: 's', fetchImpl })).toMatchObject({ gone: true, ok: false });
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 500 }));
    expect(await sendPush(keys, { title: 'x', body: 'y' }, { keys: vapid, subject: 's', fetchImpl })).toEqual({ ok: false, status: 500, gone: false });
    expect((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].headers).toMatchObject({ Urgency: 'normal' });
  });
});
