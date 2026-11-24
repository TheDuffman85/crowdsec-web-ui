import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  applyHubProfile, checkHubServer, fetchHub, fetchHubServers, reloadCrowdsec, removeHubServer, runHubAction, startHubPairing,
} from '../insightsApi';

const mocks = vi.hoisted(() => ({ sessionFetch: vi.fn() }));
vi.mock('../sessionFetch', () => ({ sessionFetch: mocks.sessionFetch }));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const lastCall = (index = 0) => mocks.sessionFetch.mock.calls[index]! as [string | URL, { method?: string; body?: string } | undefined];

afterEach(() => vi.clearAllMocks());

describe('hub API client', () => {
  test('reads the hub status of the default server or a chosen one', async () => {
    mocks.sessionFetch.mockImplementation(async () => json({ pending_reload: false }));
    await expect(fetchHub()).resolves.toEqual({ pending_reload: false });
    expect(String(lastCall()[0])).toMatch(/\/api\/hub$/);
    await fetchHub('m-rmm-1');
    expect(String(lastCall(1)[0])).toMatch(/\/api\/hub\?server=m-rmm-1$/);
    mocks.sessionFetch.mockImplementation(async () => json({ error: 'nope' }, 500));
    await expect(fetchHub()).rejects.toThrow('nope');
  });

  test('reads the server list', async () => {
    mocks.sessionFetch.mockImplementation(async () => json({ servers: [], can_manage: true }));
    await expect(fetchHubServers()).resolves.toMatchObject({ can_manage: true });
    expect(String(lastCall()[0])).toMatch(/\/api\/hub\/servers$/);
  });

  test('always confirms the operation it sends and names the servers', async () => {
    mocks.sessionFetch.mockImplementation(async () => json({ ok: true, results: [{ server: 'env', name: 'Loki', ok: true, output: 'done' }] }));
    await expect(runHubAction({ action: 'remove', type: 'scenarios', name: 'a/b' }, ['env', 'm-x'])).resolves.toMatchObject({ ok: true });
    const [url, init] = lastCall();
    expect(String(url)).toMatch(/\/api\/hub\/action$/);
    expect(JSON.parse(init!.body!)).toEqual({ action: 'remove', type: 'scenarios', name: 'a/b', servers: ['env', 'm-x'], confirm: true });
    mocks.sessionFetch.mockImplementation(async () => json({ ok: true, results: [] }));
    await reloadCrowdsec(['env']);
    expect(String(lastCall(1)[0])).toMatch(/\/api\/hub\/reload$/);
    expect(JSON.parse(lastCall(1)[1]!.body!)).toEqual({ servers: ['env'], confirm: true });
    await applyHubProfile('web', ['env']);
    expect(String(lastCall(2)[0])).toMatch(/\/api\/hub\/profile$/);
    expect(JSON.parse(lastCall(2)[1]!.body!)).toEqual({ profile: 'web', servers: ['env'], confirm: true });
  });

  test('turns failures into per-server results or errors', async () => {
    mocks.sessionFetch.mockImplementation(async () => json({ ok: false, results: [{ server: 'env', name: 'Loki', ok: false, output: 'boom' }] }, 502));
    await expect(runHubAction({ action: 'update' }, ['env'])).resolves.toMatchObject({ ok: false, results: [{ output: 'boom' }] });
    mocks.sessionFetch.mockImplementation(async () => json({ error: 'Administrator access required' }, 403));
    await expect(runHubAction({ action: 'update' }, ['env'])).rejects.toThrow('Administrator access required');
    mocks.sessionFetch.mockImplementation(async () => new Response('not json', { status: 500 }));
    await expect(reloadCrowdsec(['env'])).rejects.toThrow('The hub request failed');
  });

  test('creates, checks and removes servers', async () => {
    mocks.sessionFetch.mockImplementation(async () => json({ command: 'curl x | sudo bash', token_expires_at: '2026-01-01T00:00:00Z', uninstall_command: 'u', server: {} }, 201));
    await startHubPairing({ machine: 'RMM', name: 'Remote', from: '10.0.0.2', profile: 'linux', applyProfile: true });
    expect(JSON.parse(lastCall()[1]!.body!)).toEqual({ machine: 'RMM', name: 'Remote', from: '10.0.0.2', profile: 'linux', apply_profile: true });
    await startHubPairing({ machine: 'RMM' });
    expect(JSON.parse(lastCall(1)[1]!.body!)).toEqual({ machine: 'RMM' });
    await startHubPairing({ machine: 'RMM', applyProfile: true });
    expect(JSON.parse(lastCall(2)[1]!.body!)).toEqual({ machine: 'RMM' });
    mocks.sessionFetch.mockImplementation(async () => json({ ok: true, uninstall_command: 'u' }));
    await removeHubServer('m-a/b');
    expect(String(lastCall(3)[0])).toMatch(/\/api\/hub\/servers\/m-a%2Fb$/);
    expect(lastCall(3)[1]?.method).toBe('DELETE');
    mocks.sessionFetch.mockImplementation(async () => json({ ok: true, error: null, server: {} }));
    await checkHubServer('m-a');
    expect(String(lastCall(4)[0])).toMatch(/\/api\/hub\/servers\/m-a\/check$/);
    mocks.sessionFetch.mockImplementation(async () => json({ error: 'Already set up' }, 409));
    await expect(startHubPairing({ machine: 'RMM' })).rejects.toThrow('Already set up');
  });
});
