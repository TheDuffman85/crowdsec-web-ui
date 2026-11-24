import { afterEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import {
  readBearerToken,
  registerStatusRoutes,
  summarizeStatus,
  tokensMatch,
  type StatusDataSource,
  type StatusInstance,
} from '../../app/status-routes';
import { CrowdsecDatabase } from '../../database';
import path from 'path';
import { createController, sampleAlert, seedAlert, tempDir } from './harness';

const TOKEN = 'a-very-long-status-token';
const NOW = Date.parse('2026-11-20T12:00:00.000Z');

const connected = (id: string): StatusInstance => ({
  id, name: id.toUpperCase(), status: { isConnected: true, lastCheck: '2026-11-20T11:59:00.000Z', lastError: null, offline_since: null },
});
const offline = (id: string): StatusInstance => ({
  id, name: id.toUpperCase(), status: { isConnected: false, lastCheck: '2026-11-20T11:59:00.000Z', lastError: 'refused', offline_since: '2026-11-20T11:00:00.000Z' },
});

function build(instances: StatusInstance[], overrides: Partial<StatusDataSource> = {}, token: string | null = TOKEN) {
  const app = new Hono();
  const data: StatusDataSource = {
    instances: () => instances,
    countAlertsSince: vi.fn(() => 42),
    countActiveDecisions: vi.fn(() => 7),
    cacheReady: () => true,
    lastUpdate: () => '2026-11-20T11:58:00.000Z',
    version: '2026.11.12',
    now: () => NOW,
    ...overrides,
  };
  const registered = registerStatusRoutes({ app, basePath: '/crowdsec', token: token ?? undefined, data });
  return { app, data, registered };
}

const request = (app: Hono, headers: Record<string, string> = {}, path = '/crowdsec/api/status') =>
  app.request(`http://localhost${path}`, { headers });

describe('status helpers', () => {
  test('summarises instance health', () => {
    expect(summarizeStatus([], true)).toBe('down');
    expect(summarizeStatus([offline('a')], true)).toBe('down');
    expect(summarizeStatus([connected('a'), offline('b')], true)).toBe('degraded');
    expect(summarizeStatus([connected('a')], false)).toBe('degraded');
    expect(summarizeStatus([connected('a'), connected('b')], true)).toBe('ok');
  });

  test('parses bearer tokens and compares them in constant time', () => {
    expect(readBearerToken('Bearer abc')).toBe('abc');
    expect(readBearerToken('bearer   abc  ')).toBe('abc');
    expect(readBearerToken('Basic abc')).toBeNull();
    expect(readBearerToken(undefined)).toBeNull();
    expect(tokensMatch('abc', 'abc')).toBe(true);
    expect(tokensMatch('abc', 'abd')).toBe(false);
    expect(tokensMatch('abc', 'abcd')).toBe(false);
  });
});

describe('status endpoint', () => {
  afterEach(() => vi.restoreAllMocks());

  test('is not registered without a token or with a short one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const missing = build([connected('a')], {}, null);
    expect(missing.registered).toBe(false);
    expect((await request(missing.app)).status).toBe(404);

    const short = build([connected('a')], {}, 'too-short');
    expect(short.registered).toBe(false);
    expect((await request(short.app, { Authorization: 'Bearer too-short' })).status).toBe(404);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('shorter than 16'));
  });

  test('rejects missing, wrong and query-string tokens without touching the data', async () => {
    const { app, data } = build([connected('a')]);
    for (const response of [
      await request(app),
      await request(app, { Authorization: 'Bearer wrong-token-value-1' }),
      await request(app, { Authorization: `Basic ${TOKEN}` }),
      await request(app, {}, `/crowdsec/api/status?token=${TOKEN}`),
    ]) {
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
    }
    expect(data.countAlertsSince).not.toHaveBeenCalled();
  });

  test('returns a compact summary for a valid token', async () => {
    const { app, data } = build([connected('a'), connected('b')]);
    const response = await request(app, { Authorization: `Bearer ${TOKEN}` });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      version: '2026.11.12',
      cache_ready: true,
      last_update: '2026-11-20T11:58:00.000Z',
      instances: [
        { id: 'a', name: 'A', connected: true, last_check: '2026-11-20T11:59:00.000Z', offline_since: null },
        { id: 'b', name: 'B', connected: true, last_check: '2026-11-20T11:59:00.000Z', offline_since: null },
      ],
      alerts_last_24h: 42,
      active_decisions: 7,
    });
    expect(data.countAlertsSince).toHaveBeenCalledWith('2026-11-19T12:00:00.000Z');
    expect(data.countActiveDecisions).toHaveBeenCalledWith('2026-11-20T12:00:00.000Z');
  });

  test('answers 503 when every LAPI is offline so plain HTTP monitors can alert', async () => {
    const { app } = build([offline('a')]);
    const response = await request(app, { Authorization: `Bearer ${TOKEN}` });
    expect(response.status).toBe(503);
    expect((await response.json() as { status: string }).status).toBe('down');
  });

  test('stays 200 but reports degraded when only some instances are down', async () => {
    const { app } = build([connected('a'), offline('b')]);
    const response = await request(app, { Authorization: `Bearer ${TOKEN}` });
    expect(response.status).toBe(200);
    expect((await response.json() as { status: string }).status).toBe('degraded');
  });
});

describe('status endpoint in the full application', () => {
  afterEach(() => {
    delete process.env.STATUS_API_TOKEN;
  });

  test('bypasses dashboard sign-in but still requires the token, and counts only live records', async () => {
    process.env.STATUS_API_TOKEN = TOKEN;
    const database = new CrowdsecDatabase({ cachePath: path.join(tempDir, 'test.db') });
    seedAlert(database, sampleAlert({ id: 1, uuid: 'status-live', created_at: new Date().toISOString() }));
    seedAlert(database, sampleAlert({ id: 2, uuid: 'status-old', created_at: new Date(Date.now() - 3 * 86_400_000).toISOString(), decisions: [] }));
    const { controller } = createController({
      database,
      env: { AUTH_ENABLED: 'true' },
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
    });

    expect((await controller.fetch(new Request('http://localhost/crowdsec/api/config'))).status).toBe(401);
    expect((await controller.fetch(new Request('http://localhost/crowdsec/api/status'))).status).toBe(401);

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/status', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }));
    expect([200, 503]).toContain(response.status);
    const body = await response.json() as { alerts_last_24h: number; active_decisions: number; instances: unknown[] };
    expect(body.alerts_last_24h).toBe(1);
    expect(body.active_decisions).toBe(1);
    expect(body.instances).toHaveLength(1);
  });
});
