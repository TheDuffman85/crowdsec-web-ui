import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { parseHubCatalog } from '../../hub/catalog';
import { buildVerb, createHubExecutor, parseHubExecutorConfig, type HubOperation, type HubRunner } from '../../hub/executor';
import { HUB_EXEC_SCRIPT, HUB_INSTALL_TEMPLATE, HUB_UNINSTALL_SCRIPT } from '../../hub/scripts.generated';
import { createAuthSessionCookie, createController, sampleAlert, seedAlert } from './harness';

const LIST = JSON.stringify({
  scenarios: [
    { name: 'crowdsecurity/ssh-bf', local_version: '0.3', description: 'Detect ssh bruteforce', status: 'enabled' },
    { name: 'crowdsecurity/http-probing', local_version: '', description: 'Probing', status: 'disabled,update-available' },
    { name: 'crowdsecurity/old', local_version: '0.1', description: 'Old', status: 'enabled,update-available' },
  ],
  collections: [{ name: 'crowdsecurity/linux', local_version: '0.2', status: 'enabled,tainted' }],
  parsers: [{ name: 'locke/local-trusted-whitelist', local_version: '', status: 'enabled,local' }],
  postoverflows: [],
  'appsec-rules': [{ name: 'ignored', status: 'enabled' }],
});

function fakeRunner(responses: Record<string, { code?: number; stdout?: string; stderr?: string }> = {}) {
  const calls: string[] = [];
  const runner: HubRunner = async (file, args) => {
    const verb = file === 'ssh' ? args.at(-1)! : args.join(' ');
    calls.push(verb);
    const response = responses[verb] ?? (verb === 'hub-list' ? { stdout: LIST } : { stdout: 'ok' });
    return { code: response.code ?? 0, stdout: response.stdout ?? '', stderr: response.stderr ?? '' };
  };
  return { runner, calls };
}

const commandConfig = { transport: 'command' as const, command: ['/usr/bin/hub-exec'], timeoutMs: 1000 };

describe('hub executor', () => {
  test.each<[HubOperation, string | null]>([
    [{ action: 'list' }, 'hub-list'],
    [{ action: 'update' }, 'hub-update'],
    [{ action: 'upgrade-all' }, 'upgrade-all'],
    [{ action: 'reload' }, 'reload'],
    [{ action: 'install', type: 'scenarios', name: 'crowdsecurity/ssh-bf' }, 'install scenarios crowdsecurity/ssh-bf'],
    [{ action: 'remove', type: 'collections', name: 'linux' }, 'remove collections linux'],
    [{ action: 'install', type: 'scenarios', name: 'a; rm -rf /' }, null],
    [{ action: 'install', type: 'scenarios', name: '../etc/passwd' }, null],
    [{ action: 'install', type: 'scenarios', name: '-flag' }, null],
    [{ action: 'install', type: 'scenarios', name: 'a/b/c' }, null],
    [{ action: 'install', type: 'appsec-rules' as never, name: 'x/y' }, null],
    [{ action: 'wipe' } as never, null],
  ])('maps %j to %s', (operation, expected) => {
    expect(buildVerb(operation)).toBe(expected);
  });

  test('builds a pinned ssh call and a command call without a shell', async () => {
    const seen: Array<{ file: string; args: string[] }> = [];
    const runner: HubRunner = async (file, args) => { seen.push({ file, args }); return { code: 0, stdout: '', stderr: '' }; };
    const parsed = parseHubExecutorConfig({ HUB_EXECUTOR: 'ssh', HUB_SSH_HOST: '192.168.0.155', HUB_SSH_USER: 'roffo', HUB_SSH_KEY_FILE: '/k', HUB_SSH_KNOWN_HOSTS_FILE: '/kh' });
    expect(parsed.error).toBeUndefined();
    await createHubExecutor(parsed.config, runner).run({ action: 'install', type: 'scenarios', name: 'crowdsecurity/ssh-bf' });
    expect(seen[0]!.file).toBe('ssh');
    expect(seen[0]!.args).toEqual(expect.arrayContaining(['StrictHostKeyChecking=yes', 'BatchMode=yes', 'UserKnownHostsFile=/kh', 'roffo@192.168.0.155']));
    expect(seen[0]!.args.at(-1)).toBe('install scenarios crowdsecurity/ssh-bf');
    await createHubExecutor(commandConfig, runner).run({ action: 'reload' });
    expect(seen[1]).toEqual({ file: '/usr/bin/hub-exec', args: ['reload'] });
  });

  test('refuses disallowed operations and runs one at a time', async () => {
    const executor = createHubExecutor(commandConfig, fakeRunner().runner);
    await expect(executor.run({ action: 'install', type: 'scenarios', name: '$(id)' })).rejects.toThrow('not allowed');
    expect(createHubExecutor({ transport: 'disabled' }).enabled).toBe(false);
    let active = 0;
    let peak = 0;
    const slow: HubRunner = async () => { active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 10)); active -= 1; return { code: 0, stdout: '', stderr: '' }; };
    const queued = createHubExecutor(commandConfig, slow);
    await Promise.all([queued.run({ action: 'update' }), queued.run({ action: 'update' }), queued.run({ action: 'list' })]);
    expect(peak).toBe(1);
  });

  test('config is disabled by default and explains invalid settings', () => {
    expect(parseHubExecutorConfig({}).config.transport).toBe('disabled');
    expect(parseHubExecutorConfig({ HUB_EXECUTOR: 'ssh' }).error).toMatch(/HUB_SSH_HOST/);
    expect(parseHubExecutorConfig({ HUB_EXECUTOR: 'ssh', HUB_SSH_HOST: 'a b', HUB_SSH_KEY_FILE: '/k', HUB_SSH_KNOWN_HOSTS_FILE: '/kh' }).error).toMatch(/host/);
    expect(parseHubExecutorConfig({ HUB_EXECUTOR: 'ssh', HUB_SSH_HOST: 'h', HUB_SSH_USER: 'a;b', HUB_SSH_KEY_FILE: '/k', HUB_SSH_KNOWN_HOSTS_FILE: '/kh' }).error).toMatch(/user/);
    expect(parseHubExecutorConfig({ HUB_EXECUTOR: 'command' }).error).toMatch(/HUB_EXEC_COMMAND/);
    expect(parseHubExecutorConfig({ HUB_EXECUTOR: 'bogus' }).error).toMatch(/Unknown/);
    expect(parseHubExecutorConfig({ HUB_EXECUTOR: 'command', HUB_EXEC_COMMAND: 'sudo /x', HUB_EXEC_TIMEOUT_MS: '5000' }).config).toMatchObject({ transport: 'command', command: ['sudo', '/x'], timeoutMs: 5000 });
  });
});

describe('hub catalog', () => {
  test('keeps the four managed types and reads the status flags', () => {
    const catalog = parseHubCatalog(LIST);
    expect(Object.keys(catalog)).toEqual(['scenarios', 'collections', 'parsers', 'postoverflows']);
    expect(catalog.scenarios.map((item) => [item.name, item.installed, item.upgradable])).toEqual([
      ['crowdsecurity/http-probing', false, false], ['crowdsecurity/old', true, true], ['crowdsecurity/ssh-bf', true, false],
    ]);
    expect(catalog.collections[0]).toMatchObject({ installed: true, tainted: true });
    expect(catalog.parsers[0]).toMatchObject({ installed: true, local: true });
    expect(() => parseHubCatalog('[]')).toThrow();
  });
});

describe('hub API', () => {
  const root = 'http://localhost/crowdsec/api/hub';

  function setup(responses: Parameters<typeof fakeRunner>[0] = {}, enabled = true) {
    const { runner, calls } = fakeRunner(responses);
    const hubEnv = enabled ? { HUB_EXECUTOR: 'command', HUB_EXEC_COMMAND: '/usr/bin/hub-exec' } : {};
    const { controller } = createController({ env: { AUTH_ENABLED: 'true' }, hubEnv, hubRunner: runner });
    const database = controller.database;
    const adminId = database.createAuthUser({ username: 'admin', passwordHash: 'hash', role: 'admin', authProvider: 'password' });
    const viewerId = database.createAuthUser({ username: 'viewer', passwordHash: 'hash', role: 'read-only', authProvider: 'password' });
    const admin = createAuthSessionCookie(database, { userId: adminId, username: 'admin', role: 'admin', authMethod: 'password' });
    const viewer = createAuthSessionCookie(database, { userId: viewerId, username: 'viewer', role: 'read-only', authMethod: 'password' });
    seedAlert(database, sampleAlert({ id: 9001, uuid: 'hub-1', scenario: 'crowdsecurity/ssh-bf', simulated: false } as never));
    seedAlert(database, sampleAlert({ id: 9002, uuid: 'hub-2', scenario: 'crowdsecurity/gone', simulated: false } as never));
    const post = (suffix: string, body: unknown, cookie?: string) => controller.fetch(new Request(`${root}${suffix}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
    }));
    const get = (cookie?: string) => controller.fetch(new Request(root, { headers: cookie ? { cookie } : {} }));
    const audit = () => database.db.query("SELECT action, outcome, target FROM audit_events WHERE action LIKE 'hub.%' ORDER BY id").all() as Array<{ action: string; outcome: string; target: string | null }>;
    return { calls, admin, viewer, post, get, audit, database };
  }

  test('requires a session and shows the catalog to every signed-in user', async () => {
    const { get, viewer, admin } = setup();
    expect((await get()).status).toBe(401);
    const status = await (await get(viewer)).json() as any;
    expect(status.can_manage).toBe(false);
    expect(status.executor).toMatchObject({ state: 'ready', config_error: null });
    expect(status.server).toMatchObject({ id: 'env', status: 'paired', transport: 'command' });
    expect(status.catalog.scenarios).toHaveLength(3);
    expect(status.seen_scenarios).toEqual(expect.arrayContaining([
      { name: 'crowdsecurity/ssh-bf', alerts: 1, installed: true }, { name: 'crowdsecurity/gone', alerts: 1, installed: false },
    ]));
    expect((await (await get(admin)).json() as any).can_manage).toBe(true);
  });

  test('without an executor it stays read-only and reports the scenarios that raised alerts', async () => {
    const { get, post, admin, calls } = setup({}, false);
    const status = await (await get(admin)).json() as any;
    expect(status.executor.state).toBe('disabled');
    expect(status.catalog).toBeNull();
    expect(status.seen_scenarios.every((row: { installed: unknown }) => row.installed === null)).toBe(true);
    expect((await post('/action', { action: 'install', type: 'scenarios', name: 'a/b', confirm: true }, admin)).status).toBe(400);
    expect((await post('/reload', { confirm: true }, admin)).status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('changes need an administrator, a valid item and an explicit confirmation, and are audited', async () => {
    const { post, admin, viewer, calls, audit, get } = setup();
    const item = { action: 'install', type: 'scenarios', name: 'crowdsecurity/http-probing' };
    expect((await post('/action', { ...item, confirm: true })).status).toBe(401);
    expect((await post('/action', { ...item, confirm: true }, viewer)).status).toBe(403);
    expect((await post('/reload', { confirm: true }, viewer)).status).toBe(403);
    expect((await post('/action', { ...item, confirm: false }, admin)).status).toBe(400);
    expect((await post('/action', { ...item, name: 'x; id', confirm: true }, admin)).status).toBe(400);
    expect((await post('/action', { ...item, type: 'appsec-rules', confirm: true }, admin)).status).toBe(400);
    expect((await post('/action', { action: 'format', confirm: true }, admin)).status).toBe(400);
    expect((await post('/action', { action: 'update' }, admin)).status).toBe(400);
    expect(calls).toEqual([]);

    expect((await get(admin)).status).toBe(200);
    expect((await (await get(admin)).json() as any).pending_reload).toBe(false);
    const done = await post('/action', { ...item, confirm: true }, admin);
    expect(await done.json()).toEqual({ ok: true, results: [{ server: 'env', name: expect.any(String), ok: true, output: 'ok', pending_reload: true }] });
    expect(calls).toEqual(['hub-list', 'install scenarios crowdsecurity/http-probing']);
    expect((await (await get(admin)).json() as any).pending_reload).toBe(true);
    expect(audit()).toEqual([{ action: 'hub.install', outcome: 'success', target: 'scenarios/crowdsecurity/http-probing' }]);
  });

  test('a reload is only run when confirmed and clears the pending flag', async () => {
    const { post, admin, calls, audit, get } = setup();
    await post('/action', { action: 'upgrade-all', confirm: true }, admin);
    expect((await (await get(admin)).json() as any).pending_reload).toBe(true);
    expect((await post('/reload', {}, admin)).status).toBe(400);
    expect(calls).not.toContain('reload');
    expect(await (await post('/reload', { confirm: true }, admin)).json()).toMatchObject({ ok: true, results: [{ ok: true, pending_reload: false }] });
    expect((await (await get(admin)).json() as any).pending_reload).toBe(false);
    expect(calls).toContain('reload');
    expect(audit().map((row) => row.action)).toEqual(['hub.upgrade-all', 'hub.reload']);
  });

  test('a failed command is reported, audited as a failure and leaves the reload flag alone', async () => {
    const { post, admin, audit, get } = setup({ 'remove scenarios crowdsecurity/ssh-bf': { code: 1, stderr: 'boom' } });
    const response = await post('/action', { action: 'remove', type: 'scenarios', name: 'crowdsecurity/ssh-bf', confirm: true }, admin);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, results: [{ ok: false, output: 'boom', pending_reload: false }] });
    expect(audit()).toEqual([{ action: 'hub.remove', outcome: 'failure', target: 'scenarios/crowdsecurity/ssh-bf' }]);
    expect((await (await get(admin)).json() as any).pending_reload).toBe(false);
  });

  test('local files are not removed from the hub page', async () => {
    const { post, admin, get, calls } = setup();
    await get(admin);
    const response = await post('/action', { action: 'remove', type: 'parsers', name: 'locke/local-trusted-whitelist', confirm: true }, admin);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, results: [{ ok: false, output: expect.stringContaining('local item') }] });
    expect(calls).toEqual(['hub-list']);
  });

  test('reports an executor failure when the catalog cannot be read', async () => {
    const { get, admin } = setup({ 'hub-list': { code: 255, stderr: 'ssh: connection refused' } });
    const status = await (await get(admin)).json() as any;
    expect(status.catalog).toBeNull();
    expect(status.catalog_error).toContain('connection refused');
  });
});

describe('scripts/hub-exec.sh', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

  function run(request: string, mode: 'ssh' | 'args' = 'ssh') {
    dir = mkdtempSync(path.join(os.tmpdir(), 'hub-exec-'));
    const log = path.join(dir, 'docker.log');
    const docker = path.join(dir, 'docker');
    writeFileSync(docker, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`);
    chmodSync(docker, 0o755);
    const script = path.resolve(__dirname, '../../../scripts/hub-exec.sh');
    const env = { PATH: `${dir}:/usr/bin:/bin`, ...(mode === 'ssh' ? { SSH_ORIGINAL_COMMAND: request } : {}) };
    const result = spawnSync('bash', [script, ...(mode === 'args' ? request.split(' ') : [])], { env, encoding: 'utf8' });
    let called = '';
    try { called = readFileSync(log, 'utf8').trim(); } catch { /* nothing was run */ }
    return { status: result.status, called, stderr: result.stderr };
  }

  test('bash is available', () => { expect(execFileSync('bash', ['-c', 'echo ok']).toString().trim()).toBe('ok'); });

  test.each([
    ['hub-list', 'exec crowdsec cscli hub list -a -o json'],
    ['hub-update', 'exec crowdsec cscli hub update'],
    ['upgrade-all', 'exec crowdsec cscli hub upgrade'],
    ['install scenarios crowdsecurity/ssh-bf', 'exec crowdsec cscli scenarios install crowdsecurity/ssh-bf'],
    ['remove collections linux', 'exec crowdsec cscli collections remove linux'],
    ['upgrade postoverflows crowdsecurity/rdns', 'exec crowdsec cscli postoverflows upgrade crowdsecurity/rdns'],
    ['reload', 'kill --signal=SIGHUP crowdsec'],
  ])('allows %s', (request, expected) => {
    expect(run(request)).toMatchObject({ status: 0, called: expected });
    expect(run(request, 'args')).toMatchObject({ status: 0, called: expected });
  });

  test.each([
    '', 'bash', 'hub-list extra', 'reload now', 'install scenarios', 'install scenarios a b', 'install bouncers x/y', 'install scenarios ../x',
    'install scenarios x;id', 'install scenarios $(id)', 'install scenarios x|y', 'install scenarios `id`', 'install scenarios a/b/c', 'remove scenarios -rf',
    'decisions delete --all', 'machines delete x', 'exec crowdsec sh', 'install scenarios x\nreload',
  ])('denies %j', (request) => {
    const result = run(request);
    expect(result.status).toBe(126);
    expect(result.called).toBe('');
  });
});

describe('scripts/hub-exec.sh native mode', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

  function run(request: string, conf = 'MODE=native\nCSCLI=/usr/bin/cscli\nSYSTEMCTL=/bin/systemctl\nUSER=cshub\nCREATED_USER=1\n') {
    dir = mkdtempSync(path.join(os.tmpdir(), 'hub-exec-native-'));
    const log = path.join(dir, 'calls.log');
    for (const name of ['sudo', 'docker']) {
      writeFileSync(path.join(dir, name), `#!/bin/sh\nprintf '${name} %s\\n' "$*" >> "${log}"\n`);
      chmodSync(path.join(dir, name), 0o755);
    }
    const confFile = path.join(dir, 'hub-exec.conf');
    writeFileSync(confFile, conf);
    const script = path.resolve(__dirname, '../../../scripts/hub-exec.sh');
    const result = spawnSync('bash', [script], { env: { PATH: `${dir}:/usr/bin:/bin`, HUB_EXEC_CONF: confFile, SSH_ORIGINAL_COMMAND: request }, encoding: 'utf8' });
    let called = '';
    try { called = readFileSync(log, 'utf8').trim(); } catch { /* nothing was run */ }
    return { status: result.status, called };
  }

  test.each([
    ['hub-list', 'sudo -n /usr/bin/cscli hub list -a -o json'],
    ['hub-update', 'sudo -n /usr/bin/cscli hub update'],
    ['upgrade-all', 'sudo -n /usr/bin/cscli hub upgrade'],
    ['install collections crowdsecurity/nginx', 'sudo -n /usr/bin/cscli collections install crowdsecurity/nginx'],
    ['remove scenarios crowdsecurity/ssh-bf', 'sudo -n /usr/bin/cscli scenarios remove crowdsecurity/ssh-bf'],
    ['reload', 'sudo -n /bin/systemctl reload crowdsec'],
  ])('runs %s through sudo and never docker', (request, expected) => {
    expect(run(request)).toEqual({ status: 0, called: expected });
  });

  test.each(['hub-list extra', 'install scenarios ../x', 'install scenarios $(id)', 'install bouncers x/y', 'shell', 'reload now', 'remove scenarios -f'])('still denies %j', (request) => {
    expect(run(request)).toEqual({ status: 126, called: '' });
  });

  test('ignores settings it does not recognise or that look unsafe', () => {
    const result = run('hub-list', 'MODE=native\nCSCLI=/usr/bin/cscli; id\nBOGUS=1\n');
    expect(result).toEqual({ status: 0, called: 'sudo -n /usr/bin/cscli hub list -a -o json' });
    expect(run('hub-list', 'MODE=weird\nCONTAINER=a b\n')).toEqual({ status: 0, called: 'docker exec crowdsec cscli hub list -a -o json' });
  });
});

describe('hub shell scripts', () => {
  const root = path.resolve(__dirname, '../../..');

  test('the copies served by the server match scripts/ (run `node scripts/sync-hub-scripts.mjs` after editing them)', () => {
    expect(HUB_EXEC_SCRIPT).toBe(readFileSync(path.join(root, 'scripts/hub-exec.sh'), 'utf8'));
    expect(HUB_UNINSTALL_SCRIPT).toBe(readFileSync(path.join(root, 'scripts/hub-uninstall.sh'), 'utf8'));
    expect(HUB_INSTALL_TEMPLATE).toBe(readFileSync(path.join(root, 'scripts/hub-install.sh'), 'utf8'));
  });
});
