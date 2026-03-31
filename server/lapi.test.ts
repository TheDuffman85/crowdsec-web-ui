import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LapiClient, type LapiRequestInit } from './lapi';

const passwordAuth = {
  mode: 'password',
  user: 'watcher',
  password: 'secret',
} as const;

const tempDirs: string[] = [];

function createMtlsAuth() {
  const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-lapi-'));
  tempDirs.push(dir);
  const certPath = path.join(dir, 'agent.pem');
  const keyPath = path.join(dir, 'agent-key.pem');
  const caCertPath = path.join(dir, 'ca.pem');
  writeFileSync(certPath, 'test-cert');
  writeFileSync(keyPath, 'test-key');
  writeFileSync(caCertPath, 'test-ca');
  return {
    mode: 'mtls',
    certPath,
    keyPath,
    caCertPath,
  } as const;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('LapiClient', () => {
  test('logs in and stores a token', async () => {
    const client = new LapiClient({
      crowdsecUrl: 'http://crowdsec:8080',
      auth: passwordAuth,
      simulationsEnabled: true,
      lookbackPeriod: '1h',
      version: '1.0.0',
      fetchImpl: async () =>
        Response.json({
          code: 200,
          token: 'token-123',
        }),
    });

    await expect(client.login()).resolves.toBe(true);
    expect(client.hasToken()).toBe(true);
    expect(client.getStatus().isConnected).toBe(true);
  });

  test('retries once on 401 after re-authentication', async () => {
    const calls: string[] = [];
    const client = new LapiClient({
      crowdsecUrl: 'http://crowdsec:8080',
      auth: passwordAuth,
      simulationsEnabled: true,
      lookbackPeriod: '1h',
      version: '1.0.0',
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push(`${init?.method || 'GET'} ${url}`);

        if (url.endsWith('/v1/alerts') && calls.length === 1) {
          return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
        }

        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token-456' });
        }

        return Response.json({ ok: true });
      },
    });

    const result = await client.fetchLapi('/v1/alerts');
    expect(result.data).toEqual({ ok: true });
    expect(calls).toEqual([
      'GET http://crowdsec:8080/v1/alerts',
      'POST http://crowdsec:8080/v1/watchers/login',
      'GET http://crowdsec:8080/v1/alerts',
    ]);
  });

  test('turns aborted requests into timeout errors', async () => {
    const client = new LapiClient({
      crowdsecUrl: 'http://crowdsec:8080',
      auth: passwordAuth,
      simulationsEnabled: true,
      lookbackPeriod: '1h',
      version: '1.0.0',
      fetchImpl: async (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    });

    await expect(client.fetchLapi('/v1/alerts', { timeout: 1 })).rejects.toMatchObject({
      message: 'Request timeout',
      code: 'ETIMEDOUT',
    });
  });

  test('supports alert and decision helper methods', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = new LapiClient({
      crowdsecUrl: 'http://crowdsec:8080',
      auth: passwordAuth,
      simulationsEnabled: true,
      lookbackPeriod: '1h',
      version: '1.0.0',
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push({
          url,
          method: init?.method || 'GET',
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });

        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token-789' });
        }

        if (url.includes('/v1/alerts?')) {
          return Response.json([{ id: 1 }]);
        }

        if (url.endsWith('/v1/alerts/42')) {
          return Response.json({ id: 42 });
        }

        return Response.json({ ok: true });
      },
    });

    expect(client.hasAuthConfig()).toBe(true);
    client.clearToken();
    expect(client.hasToken()).toBe(false);
    await client.login();

    await expect(client.fetchAlerts()).resolves.toEqual([{ id: 1 }]);
    await expect(client.getAlertById(42)).resolves.toEqual({ id: 42 });
    await expect(client.addDecision('1.2.3.4', 'ban', '4h', 'manual')).resolves.toEqual({ ok: true });
    await expect(client.deleteDecision(10)).resolves.toEqual({ ok: true });
    await expect(client.deleteAlert(42)).resolves.toEqual({ id: 42 });

    expect(calls.some((call) => call.url.includes('/v1/alerts?since=1h&limit=0&simulated=true&scope=ip'))).toBe(true);
    expect(calls.some((call) => call.url.includes('/v1/alerts?since=1h&limit=0&simulated=true&scope=range'))).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/v1/alerts/42') && call.method === 'GET')).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/v1/alerts') && call.method === 'POST')).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/v1/decisions/10') && call.method === 'DELETE')).toBe(true);
  });

  test('does not request simulated alerts when simulations are disabled', async () => {
    const calls: string[] = [];
    const client = new LapiClient({
      crowdsecUrl: 'http://crowdsec:8080',
      auth: passwordAuth,
      simulationsEnabled: false,
      lookbackPeriod: '1h',
      version: '1.0.0',
      fetchImpl: async (input) => {
        calls.push(String(input));
        return Response.json([]);
      },
    });

    await expect(client.fetchAlerts()).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('/v1/alerts?since=1h&limit=0');
    expect(calls[1]).toContain('/v1/alerts?since=1h&limit=0');
    expect(calls.every((call) => !call.includes('simulated=true'))).toBe(true);
  });

  test('queries ip and range scopes separately and appends filters to both alert queries', async () => {
    const calls: string[] = [];
    const client = new LapiClient({
      crowdsecUrl: 'http://crowdsec:8080',
      auth: passwordAuth,
      simulationsEnabled: true,
      lookbackPeriod: '1h',
      version: '1.0.0',
      fetchImpl: async (input) => {
        calls.push(String(input));
        return Response.json([]);
      },
    });

    await expect(
      client.fetchAlerts('30m', '10m', true, {
        origin: 'crowdsec',
        scenario: 'manual/web-ui',
      }),
    ).resolves.toEqual([]);

    expect(calls).toHaveLength(2);
    expect(calls.some((call) => call.includes('/v1/alerts?since=30m&limit=0&until=10m&simulated=true&has_active_decision=true&origin=crowdsec&scenario=manual%2Fweb-ui&scope=ip'))).toBe(true);
    expect(calls.some((call) => call.includes('/v1/alerts?since=30m&limit=0&until=10m&simulated=true&has_active_decision=true&origin=crowdsec&scenario=manual%2Fweb-ui&scope=range'))).toBe(true);
  });

  test('logs in with mTLS and attaches TLS options to login and subsequent requests', async () => {
    const mtlsAuth = createMtlsAuth();
    const calls: Array<{
      url: string;
      method: string;
      body?: unknown;
      headers?: RequestInit['headers'];
      dispatcher?: unknown;
    }> = [];
    const client = new LapiClient({
      crowdsecUrl: 'https://crowdsec:8080',
      auth: mtlsAuth,
      simulationsEnabled: true,
      lookbackPeriod: '1h',
      version: '1.0.0',
      fetchImpl: async (input, init) => {
        const requestInit = init as LapiRequestInit | undefined;
        const url = String(input);
        calls.push({
          url,
          method: requestInit?.method || 'GET',
          body: requestInit?.body ? JSON.parse(String(requestInit.body)) : undefined,
          headers: requestInit?.headers,
          dispatcher: requestInit?.dispatcher,
        });

        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token-mtls' });
        }

        return Response.json({ ok: true });
      },
    });

    await expect(client.login()).resolves.toBe(true);
    await expect(client.fetchLapi('/v1/alerts')).resolves.toMatchObject({ data: { ok: true } });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      url: 'https://crowdsec:8080/v1/watchers/login',
      method: 'POST',
      body: { scenarios: ['manual/web-ui'] },
      dispatcher: expect.anything(),
    });
    expect(calls[1]?.dispatcher).toBeTruthy();

    const authHeaders = new Headers(calls[1]?.headers);
    expect(authHeaders.get('authorization')).toBe('Bearer token-mtls');
  });

  test('retries with mTLS auth after a 401 and keeps TLS settings on both requests', async () => {
    const mtlsAuth = createMtlsAuth();
    const calls: Array<{ url: string; dispatcher?: unknown }> = [];
    const client = new LapiClient({
      crowdsecUrl: 'https://crowdsec:8080',
      auth: mtlsAuth,
      simulationsEnabled: true,
      lookbackPeriod: '1h',
      version: '1.0.0',
      fetchImpl: async (input, init) => {
        const requestInit = init as LapiRequestInit | undefined;
        const url = String(input);
        calls.push({ url, dispatcher: requestInit?.dispatcher });

        if (url.endsWith('/v1/alerts') && calls.length === 1) {
          return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
        }

        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token-456' });
        }

        return Response.json({ ok: true });
      },
    });

    const result = await client.fetchLapi('/v1/alerts');
    expect(result.data).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.dispatcher)).toBe(true);
  });
});
