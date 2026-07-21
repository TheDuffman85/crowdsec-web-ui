import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { LapiClient, type LapiRequestInit } from '../../lapi';

const passwordAuth = {
  mode: 'password',
  user: 'watcher',
  password: 'secret',
} as const;

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;
const originalUndiciDispatcher = getGlobalDispatcher();

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
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  setGlobalDispatcher(originalUndiciDispatcher);

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('LapiClient', () => {
  test('default fetch implementation uses the userland undici dispatcher', async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent
      .get('http://crowdsec:8080')
      .intercept({
        path: '/v1/watchers/login',
        method: 'POST',
      })
      .reply(200, { code: 200, token: 'token-userland-undici' }, {
        headers: { 'content-type': 'application/json' },
      });

    let globalFetchCalled = false;
    setGlobalDispatcher(mockAgent);
    globalThis.fetch = (async () => {
      globalFetchCalled = true;
      throw new Error('global fetch should not be used for LAPI requests');
    }) as typeof fetch;

    try {
      const client = new LapiClient({
        crowdsecUrl: 'http://crowdsec:8080',
        auth: passwordAuth,
        simulationsEnabled: true,
        lookbackPeriod: '1h',
        version: '1.0.0',
      });

      await expect(client.login()).resolves.toBe(true);
      expect(globalFetchCalled).toBe(false);
      mockAgent.assertNoPendingInterceptors();
    } finally {
      globalThis.fetch = originalFetch;
      setGlobalDispatcher(originalUndiciDispatcher);
      await mockAgent.close();
    }
  });

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
    expect(client.getStatus().offline_since).toBeNull();
  });

  test('tracks offline_since across consecutive failures and clears it on success', () => {
    const client = new LapiClient({
      crowdsecUrl: 'http://crowdsec:8080',
      auth: passwordAuth,
      simulationsEnabled: true,
      lookbackPeriod: '1h',
      version: '1.0.0',
      fetchImpl: async () => Response.json({}),
    });

    client.updateStatus(false, { message: 'Connection refused' });
    const firstFailure = client.getStatus();
    expect(firstFailure.isConnected).toBe(false);
    expect(firstFailure.offline_since).not.toBeNull();
    expect(firstFailure.lastError).toBe('Connection refused');

    client.updateStatus(false, { message: 'Still down' });
    const secondFailure = client.getStatus();
    expect(secondFailure.offline_since).toBe(firstFailure.offline_since);
    expect(secondFailure.lastError).toBe('Still down');

    client.updateStatus(true);
    expect(client.getStatus()).toEqual(expect.objectContaining({
      isConnected: true,
      lastError: null,
      offline_since: null,
    }));
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

  test('keeps the request timeout active while reading the response body', async () => {
    const client = new LapiClient({
      crowdsecUrl: 'http://crowdsec:8080',
      auth: passwordAuth,
      simulationsEnabled: true,
      lookbackPeriod: '1h',
      version: '1.0.0',
      fetchImpl: async (_input, init) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"alerts":'));
            init?.signal?.addEventListener('abort', () => {
              controller.error(new DOMException('Aborted', 'AbortError'));
            });
          },
        });
        return new Response(body, { headers: { 'content-type': 'application/json' } });
      },
    });

    await expect(client.fetchLapi('/v1/alerts', { timeout: 1 })).rejects.toMatchObject({
      message: 'Request timeout',
      code: 'ETIMEDOUT',
    });
  });

  test('uses the configured default request timeout', async () => {
    const client = new LapiClient({
      crowdsecUrl: 'http://crowdsec:8080',
      auth: passwordAuth,
      simulationsEnabled: true,
      lookbackPeriod: '1h',
      requestTimeoutMs: 1,
      version: '1.0.0',
      fetchImpl: async (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    });

    await expect(client.fetchLapi('/v1/alerts')).rejects.toMatchObject({
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

    expect(calls.some((call) => call.url.includes('/v1/alerts?since=1h&limit=0&simulated=true&include_capi=false') && !call.url.includes('scope='))).toBe(true);
    expect(calls.some((call) => call.url.includes('/v1/alerts?since=1h&limit=0&simulated=true&include_capi=false&scope=ip'))).toBe(true);
    expect(calls.some((call) => call.url.includes('/v1/alerts?since=1h&limit=0&simulated=true&include_capi=false&scope=range'))).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/v1/alerts/42') && call.method === 'GET')).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/v1/alerts') && call.method === 'POST')).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/v1/decisions/10') && call.method === 'DELETE')).toBe(true);
  });

  test('sends machine heartbeats with the stored watcher token', async () => {
    const calls: Array<{ url: string; method: string; authorization?: string }> = [];
    const client = new LapiClient({
      crowdsecUrl: 'http://crowdsec:8080',
      auth: passwordAuth,
      simulationsEnabled: true,
      lookbackPeriod: '1h',
      version: '1.0.0',
      fetchImpl: async (input, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        calls.push({
          url: String(input),
          method: init?.method || 'GET',
          authorization: headers?.Authorization,
        });

        if (String(input).endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'heartbeat-token' });
        }

        return Response.json({});
      },
    });

    await client.login();
    await client.heartbeat();

    expect(calls).toEqual([
      expect.objectContaining({
        url: 'http://crowdsec:8080/v1/watchers/login',
        method: 'POST',
      }),
      {
        url: 'http://crowdsec:8080/v1/heartbeat',
        method: 'GET',
        authorization: 'Bearer heartbeat-token',
      },
    ]);
    expect(client.getStatus().isConnected).toBe(true);
  });

  test('sends usage metrics with machine OS details', async () => {
    const calls: Array<{ url: string; method: string; authorization?: string; body?: unknown }> = [];
    const client = new LapiClient({
      crowdsecUrl: 'http://crowdsec:8080',
      auth: passwordAuth,
      simulationsEnabled: true,
      lookbackPeriod: '1h',
      version: '1.2.3',
      machineInfo: {
        os: {
          name: 'debian (docker)',
          family: 'debian',
          version: '12.13',
        },
      },
      fetchImpl: async (input, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        calls.push({
          url: String(input),
          method: init?.method || 'GET',
          authorization: headers?.Authorization,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });

        if (String(input).endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'metrics-token' });
        }

        return Response.json({ ok: true }, { status: String(input).endsWith('/v1/usage-metrics') ? 201 : 200 });
      },
    });

    await client.login();
    await client.sendUsageMetrics();

    expect(calls[1]).toEqual({
      url: 'http://crowdsec:8080/v1/usage-metrics',
      method: 'POST',
      authorization: 'Bearer metrics-token',
      body: {
        log_processors: [
          {
            version: '1.2.3',
            os: {
              name: 'debian (docker)',
              family: 'debian',
              version: '12.13',
            },
            utc_startup_timestamp: expect.any(Number),
            metrics: [],
            feature_flags: [],
            datasources: {},
            hub_items: {},
          },
        ],
      },
    });
  });

  test('throws when all alert scope requests fail', async () => {
    const client = new LapiClient({
      crowdsecUrl: 'http://crowdsec:8080',
      auth: passwordAuth,
      simulationsEnabled: true,
      lookbackPeriod: '1h',
      version: '1.0.0',
      fetchImpl: async () => {
        throw new Error('fetch failed');
      },
    });

    await expect(client.fetchAlerts()).rejects.toThrow('fetch failed');
  });

  test('returns merged alerts when at least one scope succeeds', async () => {
    const calls: string[] = [];
    const client = new LapiClient({
      crowdsecUrl: 'http://crowdsec:8080',
      auth: passwordAuth,
      simulationsEnabled: true,
      lookbackPeriod: '1h',
      version: '1.0.0',
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes('scope=ip')) {
          throw new Error('ip scope failed');
        }
        return Response.json([{ id: 42 }]);
      },
    });

    await expect(client.fetchAlerts()).resolves.toEqual([{ id: 42 }]);
    expect(calls.some((url) => !url.includes('scope='))).toBe(true);
    expect(calls.some((url) => url.includes('scope=ip'))).toBe(true);
    expect(calls.some((url) => url.includes('scope=range'))).toBe(true);
  });

  test('throws on partial scope failure when complete alert results are required', async () => {
    const client = new LapiClient({
      crowdsecUrl: 'http://crowdsec:8080',
      auth: passwordAuth,
      simulationsEnabled: true,
      lookbackPeriod: '1h',
      version: '1.0.0',
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('scope=ip')) {
          throw new Error('ip scope failed');
        }
        return Response.json([{ id: 42 }]);
      },
    });

    await expect(client.fetchAlerts(null, null, { requireAllScopes: true })).rejects.toThrow('ip scope failed');
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
    expect(calls).toHaveLength(3);
    const requestParams = calls.map((call) => new URL(call).searchParams);
    expect(requestParams.map((value) => value.get('scope'))).toEqual([null, 'ip', 'range']);
    expect(calls[0]).toContain('/v1/alerts?since=1h&limit=0');
    expect(calls[1]).toContain('/v1/alerts?since=1h&limit=0');
    expect(calls[2]).toContain('/v1/alerts?since=1h&limit=0');
    expect(calls.every((call) => call.includes('include_capi=false'))).toBe(true);
    expect(calls.every((call) => !call.includes('simulated=true'))).toBe(true);
  });

  test('queries unscoped, ip, and range alerts when explicit non-CAPI filters are provided', async () => {
    const calls: string[] = [];
    const client = new LapiClient({
      crowdsecUrl: 'http://crowdsec:8080',
      auth: passwordAuth,
      simulationsEnabled: true,
      lookbackPeriod: '1h',
      version: '1.0.0',
      fetchImpl: async (input) => {
        calls.push(String(input));
        const url = String(input);
        if (!url.includes('scope=')) {
          return Response.json([{ id: 9 }]);
        }
        if (url.includes('scope=ip')) {
          return Response.json([{ id: 9 }, { id: 10 }]);
        }
        return Response.json([{ id: 11 }]);
      },
    });

    await expect(
      client.fetchAlerts('30m', '10m', {
        origin: 'crowdsec',
        scenario: 'manual/web-ui',
      }),
    ).resolves.toEqual([{ id: 9 }, { id: 10 }, { id: 11 }]);
    expect(calls).toHaveLength(3);
    const params = calls.map((call) => new URL(call).searchParams);
    expect(params.map((value) => value.get('scope'))).toEqual([null, 'ip', 'range']);
    expect(params.every((value) => value.get('since') === '30m')).toBe(true);
    expect(params.every((value) => value.get('until') === '10m')).toBe(true);
    expect(params.every((value) => value.get('origin') === 'crowdsec')).toBe(true);
    expect(params.every((value) => value.get('scenario') === 'manual/web-ui')).toBe(true);
  });

  test('recalculates relative window boundaries for each sequential alert scope', async () => {
    const calls: string[] = [];
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const client = new LapiClient({
      crowdsecUrl: 'http://crowdsec:8080',
      auth: passwordAuth,
      simulationsEnabled: false,
      lookbackPeriod: '1h',
      version: '1.0.0',
      fetchImpl: async (input) => {
        calls.push(String(input));
        now += 2_000;
        return Response.json([]);
      },
    });

    await expect(client.fetchAlerts('unused', 'unused', {
      relativeWindow: {
        startMs: 940_000,
        endMs: 970_000,
        paddingMs: 5_000,
      },
    })).resolves.toEqual([]);

    const params = calls.map((call) => new URL(call).searchParams);
    expect(params.map((value) => value.get('since'))).toEqual(['0h1m5s', '0h1m7s', '0h1m9s']);
    expect(params.map((value) => value.get('until'))).toEqual(['0h0m25s', '0h0m27s', '0h0m29s']);
  });

  test('uses an unscoped alert query for CAPI origins', async () => {
    const calls: string[] = [];
    const client = new LapiClient({
      crowdsecUrl: 'http://crowdsec:8080',
      auth: passwordAuth,
      simulationsEnabled: false,
      lookbackPeriod: '1h',
      version: '1.0.0',
      fetchImpl: async (input) => {
        calls.push(String(input));
        return Response.json([{ id: 5 }]);
      },
    });

    await expect(client.fetchAlerts('24h', null, { origin: 'CAPI' })).resolves.toEqual([{ id: 5 }]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/v1/alerts?since=24h&limit=0&origin=CAPI&include_capi=true');
    expect(calls[0]).not.toContain('scope=');
  });

  test('uses an unscoped alert query for lists origins', async () => {
    const calls: string[] = [];
    const client = new LapiClient({
      crowdsecUrl: 'http://crowdsec:8080',
      auth: passwordAuth,
      simulationsEnabled: false,
      lookbackPeriod: '1h',
      version: '1.0.0',
      fetchImpl: async (input) => {
        calls.push(String(input));
        return Response.json([{ id: 6 }]);
      },
    });

    await expect(client.fetchAlerts('24h', null, { origin: 'lists' })).resolves.toEqual([{ id: 6 }]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/v1/alerts?since=24h&limit=0&origin=lists&include_capi=false');
    expect(calls[0]).not.toContain('scope=');
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
