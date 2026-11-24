import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { generateInstallScript, installCommand } from '../../hub/install-script';
import { HUB_EXEC_SCRIPT } from '../../hub/scripts.generated';
import { generateSshKeyPair } from '../../hub/ssh-key';
import type { HubRunner } from '../../hub/executor';
import { ENV_SERVER_ID, HubRegistry, HubRegistryError, hashToken, MAX_SCRIPT_DOWNLOADS } from '../../hub/registry';
import { CrowdsecDatabase } from '../../database';
import { createAuthSessionCookie, createController, sampleAlert, seedAlert, tempDir } from './harness';

const LIST = JSON.stringify({
  scenarios: [{ name: 'crowdsecurity/ssh-bf', local_version: '0.3', description: 'ssh', status: 'enabled' }],
  collections: [{ name: 'crowdsecurity/nginx', local_version: '', status: 'disabled' }],
  parsers: [], postoverflows: [],
});

const REPORT = {
  address: '192.168.0.50', port: 22, user: 'cshub', mode: 'docker',
  host_keys: [`ssh-ed25519 ${Buffer.alloc(32, 7).toString('base64')}`],
};

// Set SHELLCHECK_BIN to use a shellcheck that is not on the PATH; the test is skipped when there is none.
const shellcheckBin = process.env.SHELLCHECK_BIN || 'shellcheck';
const hasShellcheck = spawnSync(shellcheckBin, ['--version']).status === 0;

function target(file: string, args: string[]): string {
  return file === 'ssh' ? (args.find((arg) => arg.includes('@'))?.split('@')[1] ?? 'ssh') : 'local';
}

/** Records every call as "<server>: <verb>" and lets a test fail chosen servers. */
function fakeRunner(failing: Record<string, { code: number; stderr: string }> = {}) {
  const calls: string[] = [];
  const invocations: Array<{ file: string; args: string[] }> = [];
  const runner: HubRunner = async (file, args) => {
    const server = target(file, args);
    const verb = file === 'ssh' ? args.at(-1)! : args.join(' ');
    calls.push(`${server}: ${verb}`);
    invocations.push({ file, args });
    const failure = failing[server];
    if (failure) return { code: failure.code, stdout: '', stderr: failure.stderr };
    return { code: 0, stdout: verb === 'hub-list' ? LIST : 'ok', stderr: '' };
  };
  return { runner, calls, invocations, failing };
}

describe('hub registry', () => {
  let dir = '';
  let database: CrowdsecDatabase | null = null;
  afterEach(() => { database?.close(); database = null; if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

  function create(options: { now?: () => number; ttl?: number } = {}) {
    dir = mkdtempSync(path.join(os.tmpdir(), 'hub-registry-'));
    database = new CrowdsecDatabase({ cachePath: path.join(dir, 'cache.db') });
    const registry = new HubRegistry({ database, keysDir: path.join(dir, 'keys'), now: options.now, pairingTtlMs: options.ttl });
    return { registry, database };
  }

  const pairingInput = { machine: 'Roftwares-WP01', instanceId: 'main', profile: null, applyProfile: false, appFrom: null, createdBy: 'admin' };

  test('turns the single HUB_* settings into one registry entry and keeps it in step with the environment', () => {
    const { registry } = create();
    const ssh = { transport: 'ssh' as const, host: '10.0.0.5', user: 'roffo', port: 155, keyFile: '/k', knownHostsFile: '/kh', timeoutMs: 1000 };
    const first = registry.syncEnvironment(ssh, { instanceId: 'main', name: 'Loki' })!;
    expect(first).toMatchObject({ id: ENV_SERVER_ID, source: 'env', status: 'paired', host: '10.0.0.5', port: 155, ssh_user: 'roffo', key_ref: '/k', known_hosts_ref: '/kh', name: 'Loki' });
    registry.setPendingReload(ENV_SERVER_ID, true);
    registry.syncEnvironment({ ...ssh, host: '10.0.0.6' }, { instanceId: 'main', name: 'Loki' });
    expect(registry.list()).toHaveLength(1);
    expect(registry.get(ENV_SERVER_ID)).toMatchObject({ host: '10.0.0.6', pending_reload: true });
    expect(registry.executorFor(ENV_SERVER_ID)?.config).toMatchObject({ transport: 'ssh', host: '10.0.0.6', port: 155 });
    registry.syncEnvironment({ transport: 'command', command: ['/usr/bin/hub-exec'], timeoutMs: 1000 }, { instanceId: 'main', name: 'Loki' });
    expect(registry.get(ENV_SERVER_ID)).toMatchObject({ transport: 'command', command: '/usr/bin/hub-exec', host: null });
    expect(registry.syncEnvironment({ transport: 'disabled' }, { instanceId: 'main', name: 'Loki' })).toBeNull();
    expect(registry.list()).toEqual([]);
    expect(registry.executorFor(ENV_SERVER_ID)).toBeNull();
  });

  test('lists machines as detected until they have an entry, and never makes an executor for them', () => {
    const { registry } = create();
    expect(registry.detectMachines(['RMM', 'Roftwares-WP01', ' RMM ', ''])).toEqual(['RMM', 'Roftwares-WP01']);
    registry.createPairing(pairingInput);
    expect(registry.detectMachines(['RMM', 'Roftwares-WP01'])).toEqual(['RMM']);
    expect(registry.executorFor('m-unknown')).toBeNull();
  });

  test('a pending server has no executor until pairing completes', () => {
    const { registry } = create();
    const { record, token } = registry.createPairing(pairingInput);
    expect(record.status).toBe('pending');
    expect(registry.executorFor(record.id)).toBeNull();
    registry.completePairing(token, REPORT, '192.168.0.50');
    expect(registry.executorFor(record.id)?.config).toMatchObject({ transport: 'ssh', host: '192.168.0.50', user: 'cshub', port: 22 });
  });

  test('keeps the private key in a mode 600 file, the token only as a hash, and a usable key pair', () => {
    const { registry, database: db } = create();
    const { record, token, publicKey } = registry.createPairing(pairingInput);
    expect(statSync(record.key_ref!).mode & 0o777).toBe(0o600);
    expect(readFileSync(record.key_ref!, 'utf8')).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----/);
    const stored = db.db.query('SELECT token_hash FROM hub_pairing_tokens').all() as Array<{ token_hash: string }>;
    expect(stored).toEqual([{ token_hash: hashToken(token) }]);
    const everything = JSON.stringify([db.db.query('SELECT * FROM hub_pairing_tokens').all(), db.db.query('SELECT * FROM hub_executors').all()]);
    expect(everything).not.toContain(token);
    expect(publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ crowdsec-web-ui-hub$/);
    expect(record.public_key).toBe(publicKey);
  });

  test.skipIf(spawnSync('ssh-keygen', ['-V']).error !== undefined && !existsSync('/usr/bin/ssh-keygen'))('the generated private key is a real OpenSSH key that matches its public key', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'hub-key-'));
    const pair = generateSshKeyPair('crowdsec-web-ui-hub');
    const file = path.join(dir, 'key');
    writeFileSync(file, pair.privateKey, { mode: 0o600 });
    const derived = spawnSync('ssh-keygen', ['-y', '-f', file], { encoding: 'utf8' });
    expect(derived.status).toBe(0);
    expect(derived.stdout.trim().split(' ').slice(0, 2)).toEqual(pair.publicKey.split(' ').slice(0, 2));
  });

  test('a token expires, so neither the script nor the report is accepted afterwards', () => {
    let now = Date.parse('2026-11-20T10:00:00Z');
    const { registry } = create({ now: () => now, ttl: 10 * 60_000 });
    const { record, token, expiresAt } = registry.createPairing(pairingInput);
    expect(expiresAt).toBe(now + 10 * 60_000);
    expect(registry.pairingExpiry(record.id)).toBe(expiresAt);
    expect(registry.claimScriptDownload(token).id).toBe(record.id);
    now += 10 * 60_000;
    expect(() => registry.claimScriptDownload(token)).toThrowError(expect.objectContaining({ code: 'TOKEN_EXPIRED', status: 410 }));
    expect(() => registry.completePairing(token, REPORT, null)).toThrowError(expect.objectContaining({ code: 'TOKEN_EXPIRED' }));
    expect(registry.get(record.id)).toMatchObject({ status: 'pending', host: null });
  });

  test('a token completes pairing exactly once', () => {
    const { registry } = create();
    const { record, token } = registry.createPairing(pairingInput);
    const paired = registry.completePairing(token, REPORT, '192.168.0.50');
    expect(paired).toMatchObject({ status: 'paired', host: '192.168.0.50', port: 22, ssh_user: 'cshub', mode: 'docker', paired_from: '192.168.0.50' });
    expect(readFileSync(paired.known_hosts_ref!, 'utf8')).toBe(`192.168.0.50 ${REPORT.host_keys[0]}\n`);
    expect(() => registry.completePairing(token, REPORT, null)).toThrowError(expect.objectContaining({ code: 'TOKEN_USED', status: 410 }));
    expect(() => registry.claimScriptDownload(token)).toThrowError(expect.objectContaining({ code: 'TOKEN_USED' }));
    expect(() => registry.completePairing('not-a-real-token-at-all', REPORT, null)).toThrowError(expect.objectContaining({ code: 'TOKEN_UNKNOWN', status: 404 }));
    expect(registry.get(record.id)?.status).toBe('paired');
  });

  test('an invalid report does not spend the token, and a non-default port is pinned in known_hosts form', () => {
    const { registry } = create();
    const { token } = registry.createPairing(pairingInput);
    for (const bad of [
      { ...REPORT, address: 'a b' }, { ...REPORT, port: 0 }, { ...REPORT, user: 'root;id' }, { ...REPORT, mode: 'weird' },
      { ...REPORT, host_keys: [] }, { ...REPORT, host_keys: ['ssh-ed25519 short'] }, { ...REPORT, host_keys: ['ssh-ed25519 AAAAAAAAAAAAAAAAAAAAAAAAAA\nevil'] }, null,
    ]) {
      expect(() => registry.completePairing(token, bad as never, null)).toThrowError(expect.objectContaining({ code: 'REPORT_INVALID', status: 400 }));
    }
    const paired = registry.completePairing(token, { ...REPORT, port: 2222, mode: 'native' }, null);
    expect(readFileSync(paired.known_hosts_ref!, 'utf8')).toBe(`[192.168.0.50]:2222 ${REPORT.host_keys[0]}\n`);
    expect(paired.mode).toBe('native');
  });

  test('the install script can only be fetched a few times', () => {
    const { registry } = create();
    const { token } = registry.createPairing(pairingInput);
    for (let index = 0; index < MAX_SCRIPT_DOWNLOADS; index += 1) registry.claimScriptDownload(token);
    expect(() => registry.claimScriptDownload(token)).toThrowError(expect.objectContaining({ code: 'TOKEN_DOWNLOADS' }));
  });

  test('a paired machine must be removed before it is paired again; a pending one gets a new key and token', () => {
    const { registry } = create();
    const first = registry.createPairing(pairingInput);
    const second = registry.createPairing(pairingInput);
    expect(second.record.id).toBe(first.record.id);
    expect(second.publicKey).not.toBe(first.publicKey);
    expect(() => registry.claimScriptDownload(first.token)).toThrowError(HubRegistryError);
    registry.completePairing(second.token, REPORT, null);
    expect(() => registry.createPairing(pairingInput)).toThrowError(expect.objectContaining({ code: 'ALREADY_PAIRED', status: 409 }));
    expect(() => registry.createPairing({ ...pairingInput, machine: '' })).toThrowError(expect.objectContaining({ code: 'INVALID_MACHINE' }));
  });

  test('removing a server deletes its keys and tokens, but a server from the environment cannot be removed', () => {
    const { registry, database: db } = create();
    const { record, token } = registry.createPairing(pairingInput);
    const paired = registry.completePairing(token, REPORT, null);
    expect(existsSync(paired.key_ref!)).toBe(true);
    registry.remove(record.id);
    expect(existsSync(paired.key_ref!)).toBe(false);
    expect(existsSync(paired.known_hosts_ref!)).toBe(false);
    expect(registry.get(record.id)).toBeNull();
    expect((db.db.query('SELECT COUNT(*) AS n FROM hub_pairing_tokens').get() as { n: number }).n).toBe(0);
    expect(registry.detectMachines(['Roftwares-WP01'])).toEqual(['Roftwares-WP01']);
    registry.syncEnvironment({ transport: 'command', command: ['x'], timeoutMs: 1 }, { instanceId: 'main', name: 'Loki' });
    expect(() => registry.remove(ENV_SERVER_ID)).toThrowError(expect.objectContaining({ code: 'ENV_SERVER' }));
    expect(() => registry.remove('nope')).toThrowError(expect.objectContaining({ code: 'SERVER_UNKNOWN' }));
  });

  test('records the outcome of a connection check', () => {
    const { registry } = create();
    const { record, token } = registry.createPairing(pairingInput);
    registry.recordCheck(record.id, null);
    expect(registry.get(record.id)?.status).toBe('pending');
    registry.completePairing(token, REPORT, null);
    registry.recordCheck(record.id, 'connection refused');
    expect(registry.get(record.id)).toMatchObject({ status: 'error', last_error: 'connection refused' });
    registry.recordCheck(record.id, null);
    expect(registry.get(record.id)).toMatchObject({ status: 'paired', last_error: null });
    expect(registry.get(record.id)?.last_check_at).not.toBeNull();
  });
});

describe('install.sh generation', () => {
  const pair = generateSshKeyPair('crowdsec-web-ui-hub');
  const options = { baseUrl: 'https://sec.example.org/crowdsec', token: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', publicKey: pair.publicKey, appFrom: '192.168.0.200' };
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

  function save(script: string): string {
    dir = mkdtempSync(path.join(os.tmpdir(), 'hub-install-'));
    const file = path.join(dir, 'install.sh');
    writeFileSync(file, script, { mode: 0o755 });
    return file;
  }

  test('fills in every placeholder and embeds the exact wrapper', () => {
    const script = generateInstallScript(options);
    expect(script).not.toMatch(/__[A-Z_]+__/);
    expect(script).toContain(`BASE_URL='${options.baseUrl}'`);
    expect(script).toContain(`PUBLIC_KEY='${pair.publicKey}'`);
    expect(script).toContain(`DEFAULT_FROM='192.168.0.200'`);
    const wrapper = script.split("<<'HUB_EXEC_EOF'\n")[1]!.split('\nHUB_EXEC_EOF')[0]!;
    expect(`${wrapper}\n`).toBe(HUB_EXEC_SCRIPT);
  });

  test('limits the key to the wrapper, the app address, no tty and no forwarding', () => {
    const script = generateInstallScript(options);
    expect(script).toContain('command=\\"$LIB_DIR/hub-exec.sh\\",from=\\"$app_from\\",restrict,no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding');
    expect(script).toContain('useradd --system');
    expect(script).toContain("usermod --password '*'");
    expect(script).toContain('/api/hub/pair/$TOKEN/complete');
    expect(script).toContain('uninstall.sh');
    expect(script).toContain('visudo -cf');
  });

  test('refuses values that could change the script', () => {
    expect(() => generateInstallScript({ ...options, baseUrl: "http://x'; id; '" })).toThrow();
    expect(() => generateInstallScript({ ...options, baseUrl: 'ftp://host' })).toThrow();
    expect(() => generateInstallScript({ ...options, token: "abc'; id" })).toThrow();
    expect(() => generateInstallScript({ ...options, publicKey: 'ssh-ed25519 AAAA key\nreboot' })).toThrow();
    expect(() => generateInstallScript({ ...options, publicKey: "ssh-rsa AAAA x" })).toThrow();
    expect(() => generateInstallScript({ ...options, appFrom: '1.2.3.4"; id; "' })).toThrow();
    expect(installCommand('http://app:3000', 'tok')).toBe('curl -fsSL http://app:3000/api/hub/pair/tok/install.sh | sudo bash');
  });

  test('is valid bash and a dry run changes nothing', () => {
    const file = save(generateInstallScript(options));
    expect(spawnSync('bash', ['-n', file]).status).toBe(0);
    const result = spawnSync('bash', [file, '--dry-run'], { encoding: 'utf8', env: { PATH: process.env.PATH, HUB_MODE: 'docker', HUB_HOST: '192.168.0.50' } });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Dry run finished; nothing was changed');
    expect(result.stdout).toContain('+ useradd --system');
    expect(result.stdout).toContain('from="192.168.0.200",restrict,no-pty,no-port-forwarding');
    expect(result.stdout).toContain('"address":"192.168.0.50"');
    expect(existsSync('/usr/local/lib/crowdsec-hub/hub-exec.sh')).toBe(false);
  });

  test('native dry run writes a sudo rule that only lists hub commands', () => {
    const file = save(generateInstallScript(options));
    const result = spawnSync('bash', [file, '--dry-run'], { encoding: 'utf8', env: { PATH: process.env.PATH, HUB_MODE: 'native', HUB_HOST: '10.1.1.1', APP_FROM: '10.1.1.0/24' } });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('write /etc/sudoers.d/crowdsec-hub');
    expect(result.stdout).toContain('from="10.1.1.0/24"');
    expect(result.stdout).toContain('"mode":"native"');
  });

  test('refuses a bad address override and needs root for a real run', () => {
    const file = save(generateInstallScript({ ...options, appFrom: '' }));
    const bad = spawnSync('bash', [file, '--dry-run'], { encoding: 'utf8', env: { PATH: process.env.PATH, HUB_MODE: 'docker', APP_FROM: 'x;id' } });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('APP_FROM must be');
    if (process.getuid?.() !== 0) {
      const real = spawnSync('bash', [file], { encoding: 'utf8', env: { PATH: process.env.PATH } });
      expect(real.status).toBe(1);
      expect(real.stderr).toContain('run this as root');
    }
  });

  test.skipIf(!hasShellcheck)('passes shellcheck, including the generated script', () => {
    const root = path.resolve(__dirname, '../../..');
    const files = ['hub-install.sh', 'hub-exec.sh', 'hub-uninstall.sh'].map((name) => path.join(root, 'scripts', name));
    files.push(save(generateInstallScript(options)));
    const result = spawnSync(shellcheckBin, files, { encoding: 'utf8' });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });
});

describe('hub servers API', () => {
  const root = 'http://localhost/crowdsec/api/hub';

  function setup(options: { env?: Record<string, string> } = {}) {
    const fake = fakeRunner();
    const { controller } = createController({ env: { AUTH_ENABLED: 'true' }, hubEnv: options.env ?? {}, hubRunner: fake.runner });
    const database = controller.database;
    const adminId = database.createAuthUser({ username: 'admin', passwordHash: 'hash', role: 'admin', authProvider: 'password' });
    const viewerId = database.createAuthUser({ username: 'viewer', passwordHash: 'hash', role: 'read-only', authProvider: 'password' });
    const admin = createAuthSessionCookie(database, { userId: adminId, username: 'admin', role: 'admin', authMethod: 'password' });
    const viewer = createAuthSessionCookie(database, { userId: viewerId, username: 'viewer', role: 'read-only', authMethod: 'password' });
    for (const [id, machine] of [[9101, 'RMM'], [9102, 'Roftwares-WP01'], [9103, 'NT-APP01']] as const) {
      seedAlert(database, sampleAlert({ id, uuid: `m-${id}`, machine_id: machine, scenario: 'crowdsecurity/ssh-bf', simulated: false } as never));
    }
    const request = (method: string, suffix: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}) => controller.fetch(new Request(`${root}${suffix}`, {
      method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }));
    const audit = () => database.db.query("SELECT user, action, outcome, target, details FROM audit_events WHERE action LIKE 'hub.%' ORDER BY id").all() as Array<{ user: string; action: string; outcome: string; target: string | null; details: string }>;
    return { controller, database, admin, viewer, request, audit, ...fake };
  }

  /** Pairs a machine through the same steps the installer takes, without running anything on a real server. */
  async function pair(env: ReturnType<typeof setup>, machine: string, report: Record<string, unknown> = REPORT, body: Record<string, unknown> = {}) {
    const created = await env.request('POST', '/servers/pair', { machine, ...body }, env.admin);
    expect(created.status).toBe(201);
    const payload = await created.json() as { command: string; server: { id: string } };
    const token = payload.command.match(/pair\/([^/]+)\/install\.sh/)![1]!;
    const completed = await env.request('POST', `/pair/${token}/complete`, report);
    expect(completed.status).toBe(200);
    await env.controller.hubSettled();
    return { id: payload.server.id, token };
  }

  const ENV = { HUB_EXECUTOR: 'command', HUB_EXEC_COMMAND: '/usr/bin/hub-exec' };

  test('lists the env server as paired and every other CrowdSec machine as detected, without contacting any of them', async () => {
    const env = setup({ env: ENV });
    expect((await env.request('GET', '/servers')).status).toBe(401);
    const body = await (await env.request('GET', '/servers', undefined, env.viewer)).json() as any;
    expect(body.can_manage).toBe(false);
    expect(body.servers.map((server: any) => [server.name, server.status, server.id])).toEqual([
      ['CrowdSec', 'paired', 'env'], ['NT-APP01', 'detected', null], ['RMM', 'detected', null], ['Roftwares-WP01', 'detected', null],
    ]);
    expect(body.profiles.map((profile: any) => profile.id)).toEqual(['web', 'linux']);
    expect(env.calls).toEqual([]);
  });

  test('with no environment settings nothing is paired and nothing is contacted', async () => {
    const env = setup();
    const body = await (await env.request('GET', '/servers', undefined, env.admin)).json() as any;
    expect(body.servers.every((server: any) => server.status === 'detected')).toBe(true);
    const status = await (await env.request('GET', '', undefined, env.admin)).json() as any;
    expect(status).toMatchObject({ server: null, executor: { state: 'disabled' }, catalog: null });
    expect(env.calls).toEqual([]);
  });

  test('pairing needs an administrator and validates its input', async () => {
    const env = setup();
    expect((await env.request('POST', '/servers/pair', { machine: 'RMM' })).status).toBe(401);
    expect((await env.request('POST', '/servers/pair', { machine: 'RMM' }, env.viewer)).status).toBe(403);
    expect((await env.request('POST', '/servers/pair', {}, env.admin)).status).toBe(400);
    expect((await env.request('POST', '/servers/pair', { machine: 'RMM', profile: 'nope' }, env.admin)).status).toBe(400);
    expect((await env.request('POST', '/servers/pair', { machine: 'RMM', from: '1.2.3.4; id' }, env.admin)).status).toBe(400);
    expect((await env.request('DELETE', '/servers/m-x', undefined, env.viewer)).status).toBe(403);
    expect(env.calls).toEqual([]);
  });

  test('generates a one-line command, serves the script without a session, and audits each step', async () => {
    const env = setup();
    const created = await env.request('POST', '/servers/pair', { machine: 'Roftwares-WP01', from: '192.168.0.200' }, env.admin, { host: 'app.lan:3000' });
    const payload = await created.json() as any;
    expect(payload.command).toMatch(/^curl -fsSL http:\/\/app\.lan:3000\/crowdsec\/api\/hub\/pair\/[A-Za-z0-9_-]{43}\/install\.sh \| sudo bash$/);
    expect(payload.uninstall_command).toBe('sudo /usr/local/lib/crowdsec-hub/uninstall.sh');
    expect(payload.server).toMatchObject({ status: 'pending', machine: 'Roftwares-WP01', pairing_expired: false });
    const token = payload.command.match(/pair\/([^/]+)\//)[1] as string;
    expect(JSON.stringify(env.audit())).not.toContain(token);

    const script = await env.request('GET', `/pair/${token}/install.sh`, undefined, undefined, { host: 'app.lan:3000' });
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('text/x-shellscript');
    const text = await script.text();
    expect(text).toContain("BASE_URL='http://app.lan:3000/crowdsec'");
    expect(text).toContain("DEFAULT_FROM='192.168.0.200'");
    expect(text).toContain(env.controller.hubRegistry.list()[0]!.public_key!);
    expect(text).not.toContain('PRIVATE KEY');

    expect((await env.request('GET', '/pair/not-a-valid-token-0123456789/install.sh')).status).toBe(404);
    expect((await env.request('POST', '/pair/not-a-valid-token-0123456789/complete', REPORT)).status).toBe(404);
    const audited = env.audit();
    expect(audited.map((row) => [row.user, row.action, row.outcome])).toEqual([
      ['admin', 'hub.pair-token', 'success'], ['pairing-token', 'hub.pair-script', 'success'],
      ['pairing-token', 'hub.pair-script', 'failure'], ['pairing-token', 'hub.pair', 'failure'],
    ]);
  });

  test('a token completes pairing once; the connection is then checked and nothing else is installed', async () => {
    const env = setup();
    const { id, token } = await pair(env, 'Roftwares-WP01');
    const again = await env.request('POST', `/pair/${token}/complete`, REPORT);
    expect(again.status).toBe(410);
    expect((await again.json() as any).code).toBe('TOKEN_USED');
    expect((await env.request('GET', `/pair/${token}/install.sh`)).status).toBe(410);

    const server = (await (await env.request('GET', '/servers', undefined, env.admin)).json() as any).servers.find((row: any) => row.id === id);
    expect(server).toMatchObject({ status: 'paired', host: '192.168.0.50', ssh_user: 'cshub', mode: 'docker', last_error: null });
    expect(server.host_key_fingerprint).toMatch(/^SHA256:/);
    expect(server.last_check_at).not.toBeNull();
    // Only the read-only listing ran: profiles are off unless asked for.
    expect(env.calls).toEqual(['192.168.0.50: hub-list']);
    const ssh = env.invocations[0]!;
    expect(ssh.file).toBe('ssh');
    expect(ssh.args).toEqual(expect.arrayContaining(['StrictHostKeyChecking=yes', 'BatchMode=yes', 'cshub@192.168.0.50']));
    expect(ssh.args[ssh.args.indexOf('-i') + 1]).toBe(env.controller.hubRegistry.get(id)!.key_ref);
    expect(env.audit().map((row) => row.action)).toEqual(['hub.pair-token', 'hub.pair', 'hub.check', 'hub.pair', 'hub.pair-script']);
  });

  test('an expired token is refused and audited', async () => {
    const env = setup();
    const created = await (await env.request('POST', '/servers/pair', { machine: 'RMM' }, env.admin)).json() as any;
    const token = created.command.match(/pair\/([^/]+)\//)[1] as string;
    env.database.db.query('UPDATE hub_pairing_tokens SET expires_at = ?').run(Date.now() - 1000);
    const response = await env.request('POST', `/pair/${token}/complete`, REPORT);
    expect(response.status).toBe(410);
    expect((await response.json() as any).code).toBe('TOKEN_EXPIRED');
    expect((await env.request('GET', `/pair/${token}/install.sh`)).status).toBe(410);
    const list = await (await env.request('GET', '/servers', undefined, env.admin)).json() as any;
    expect(list.servers.find((row: any) => row.machine === 'RMM')).toMatchObject({ status: 'pending', pairing_expired: true });
    expect(env.audit().at(-1)).toMatchObject({ action: 'hub.pair-script', outcome: 'failure' });
  });

  test('a profile is applied after pairing only when it was asked for', async () => {
    const env = setup();
    await pair(env, 'RMM', REPORT, { profile: 'linux' });
    expect(env.calls).toEqual(['192.168.0.50: hub-list']);
    expect(env.controller.hubRegistry.list()[0]).toMatchObject({ profile: 'linux', apply_profile: false, pending_reload: false });

    await pair(env, 'NT-APP01', { ...REPORT, address: '192.168.0.51' }, { profile: 'linux', apply_profile: true });
    expect(env.calls.slice(1)).toEqual([
      '192.168.0.51: hub-list', '192.168.0.51: install collections crowdsecurity/linux', '192.168.0.51: install collections crowdsecurity/sshd',
    ]);
    expect(env.audit().map((row) => row.action).slice(-6)).toEqual(['hub.pair-token', 'hub.pair', 'hub.check', 'hub.install', 'hub.install', 'hub.profile']);
    // Installing is not enough for CrowdSec to use it: the reload still waits for a confirmation.
    expect(env.calls).not.toContain('192.168.0.51: reload');
    expect(env.controller.hubRegistry.list().find((record) => record.machine === 'NT-APP01')!.pending_reload).toBe(true);
  });

  test('removes a server, deleting its keys, and refuses to remove the env server', async () => {
    const env = setup({ env: ENV });
    const { id } = await pair(env, 'Roftwares-WP01');
    const record = env.controller.hubRegistry.get(id)!;
    const removed = await env.request('DELETE', `/servers/${id}`, undefined, env.admin);
    expect(removed.status).toBe(200);
    expect((await removed.json() as any).uninstall_command).toContain('uninstall.sh');
    expect(existsSync(record.key_ref!)).toBe(false);
    expect((await env.request('DELETE', `/servers/${id}`, undefined, env.admin)).status).toBe(404);
    expect((await env.request('DELETE', '/servers/env', undefined, env.admin)).status).toBe(409);
    expect(env.audit().map((row) => row.action)).toContain('hub.unpair');
  });

  test('checks one server on demand and shows its error', async () => {
    const env = setup();
    const { id } = await pair(env, 'RMM');
    env.failing['192.168.0.50'] = { code: 255, stderr: 'Host key verification failed.' };
    const response = await env.request('POST', `/servers/${id}/check`, undefined, env.admin);
    expect(response.status).toBe(502);
    expect((await response.json() as any).server).toMatchObject({ status: 'error', last_error: 'Host key verification failed.' });
    expect((await env.request('POST', '/servers/m-nope/check', undefined, env.admin)).status).toBe(404);
  });

  describe('fan-out to several servers', () => {
    async function twoServers() {
      const env = setup({ env: ENV });
      const first = await pair(env, 'RMM', { ...REPORT, address: '10.0.0.1' });
      const second = await pair(env, 'Roftwares-WP01', { ...REPORT, address: '10.0.0.2' });
      env.calls.length = 0;
      return { env, ids: ['env', first.id, second.id] };
    }
    const item = { action: 'install', type: 'collections', name: 'crowdsecurity/nginx', confirm: true };

    test('runs the change on every chosen server and reports each one', async () => {
      const { env, ids } = await twoServers();
      const response = await env.request('POST', '/action', { ...item, servers: ids }, env.admin);
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.ok).toBe(true);
      expect(body.results.map((row: any) => [row.server, row.ok, row.pending_reload])).toEqual(ids.map((id) => [id, true, true]));
      expect(env.calls.sort()).toEqual([
        '10.0.0.1: install collections crowdsecurity/nginx', '10.0.0.2: install collections crowdsecurity/nginx', 'local: install collections crowdsecurity/nginx',
      ].sort());
      expect(env.audit().filter((row) => row.action === 'hub.install')).toHaveLength(3);
    });

    test('one failing server does not stop the others, and only the others are marked for a reload', async () => {
      const { env, ids } = await twoServers();
      // 10.0.0.1 goes down after pairing.
      env.failing['10.0.0.1'] = { code: 255, stderr: 'ssh: connect to host 10.0.0.1 port 22: Connection refused' };
      const response = await env.request('POST', '/action', { ...item, servers: ids }, env.admin);
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.ok).toBe(false);
      expect(body.results.map((row: any) => [row.server, row.ok])).toEqual([['env', true], [ids[1], false], [ids[2], true]]);
      expect(body.results[1].output).toContain('Connection refused');
      expect(body.results[1].pending_reload).toBe(false);
      expect(env.calls).toHaveLength(3);
      const rows = env.audit().filter((row) => row.action === 'hub.install');
      expect(rows.map((row) => row.outcome).sort()).toEqual(['failure', 'success', 'success']);
    });

    test('reloads only the servers that are confirmed, each on its own', async () => {
      const { env, ids } = await twoServers();
      await env.request('POST', '/action', { ...item, servers: ids }, env.admin);
      env.calls.length = 0;
      expect((await env.request('POST', '/reload', { servers: [ids[1]] }, env.admin)).status).toBe(400);
      expect(env.calls).toEqual([]);
      const response = await env.request('POST', '/reload', { servers: [ids[1]], confirm: true }, env.admin);
      expect(response.status).toBe(200);
      expect(env.calls).toEqual(['10.0.0.1: reload']);
      const pending = Object.fromEntries(env.controller.hubRegistry.list().map((record) => [record.id, record.pending_reload]));
      expect(pending).toEqual({ env: true, [ids[1]!]: false, [ids[2]!]: true });
    });

    test('every server failing is a 502; unknown and pending servers are reported, not contacted', async () => {
      const env = setup({ env: ENV });
      const pending = await (await env.request('POST', '/servers/pair', { machine: 'NT-APP01' }, env.admin)).json() as any;
      env.calls.length = 0;
      const response = await env.request('POST', '/action', { ...item, servers: ['m-missing', pending.server.id] }, env.admin);
      expect(response.status).toBe(502);
      const body = await response.json() as any;
      expect(body.results.map((row: any) => row.ok)).toEqual([false, false]);
      expect(env.calls).toEqual([]);
      expect((await env.request('POST', '/action', { ...item, servers: [] }, env.admin)).status).toBe(400);
      expect((await env.request('POST', '/action', { ...item, servers: Array.from({ length: 51 }, (_, index) => `s${index}`) }, env.admin)).status).toBe(400);
    });

    test('applies a profile to several servers, one result each', async () => {
      const { env, ids } = await twoServers();
      expect((await env.request('POST', '/profile', { profile: 'web', servers: ids }, env.admin)).status).toBe(400);
      expect((await env.request('POST', '/profile', { profile: 'nope', servers: ids, confirm: true }, env.viewer)).status).toBe(403);
      const response = await env.request('POST', '/profile', { profile: 'web', servers: ids, confirm: true }, env.admin);
      const body = await response.json() as any;
      expect(body.results).toHaveLength(3);
      expect(body.results[0].output).toContain('ok: crowdsecurity/nginx');
      expect(env.calls.filter((call) => call.startsWith('10.0.0.1:'))).toEqual([
        '10.0.0.1: install collections crowdsecurity/nginx', '10.0.0.1: install collections crowdsecurity/traefik',
        '10.0.0.1: install collections crowdsecurity/wordpress', '10.0.0.1: install collections crowdsecurity/base-http-scenarios',
      ]);
    });
  });

  test('the catalog is read per server and a failed read marks that server as errored', async () => {
    const env = setup({ env: ENV });
    const down = await pair(env, 'RMM', { ...REPORT, address: '10.0.0.9' });
    const okServer = await pair(env, 'NT-APP01', { ...REPORT, address: '10.0.0.8' });
    env.failing['10.0.0.9'] = { code: 255, stderr: 'ssh: no route' };
    // The catalog is cached for a minute; a check forces a fresh read.
    expect((await env.request('POST', `/servers/${down.id}/check`, undefined, env.admin)).status).toBe(502);
    const good = await (await env.request('GET', `?server=${okServer.id}`, undefined, env.viewer)).json() as any;
    expect(good.catalog.scenarios).toHaveLength(1);
    expect(good.server).toMatchObject({ id: okServer.id, status: 'paired' });
    const bad = await (await env.request('GET', `?server=${down.id}`, undefined, env.viewer)).json() as any;
    expect(bad.catalog).toBeNull();
    expect(bad.catalog_error).toContain('no route');
    expect(bad.server.status).toBe('error');
    expect((await env.request('GET', '?server=m-none', undefined, env.viewer)).status).toBe(404);
    // A pending server is shown but never contacted.
    const pending = await (await env.request('POST', '/servers/pair', { machine: 'Other' }, env.admin)).json() as any;
    env.calls.length = 0;
    const status = await (await env.request('GET', `?server=${pending.server.id}`, undefined, env.viewer)).json() as any;
    expect(status).toMatchObject({ executor: { state: 'disabled' }, catalog: null, server: { status: 'pending' } });
    expect(env.calls).toEqual([]);
  });

  test('reads the seen scenarios of the chosen machine only', async () => {
    const env = setup({ env: ENV });
    seedAlert(env.database, sampleAlert({ id: 9201, uuid: 'x-1', machine_id: 'RMM', scenario: 'crowdsecurity/only-rmm', simulated: false } as never));
    const { id } = await pair(env, 'RMM');
    const status = await (await env.request('GET', `?server=${id}`, undefined, env.admin)).json() as any;
    expect(status.seen_scenarios.map((row: any) => row.name).sort()).toEqual(['crowdsecurity/only-rmm', 'crowdsecurity/ssh-bf']);
    const envStatus = await (await env.request('GET', '?server=env', undefined, env.admin)).json() as any;
    expect(envStatus.seen_scenarios.length).toBeGreaterThanOrEqual(2);
  });

  test('settings that came from the environment keep working after a restart', () => {
    const env = setup({ env: { HUB_EXECUTOR: 'ssh', HUB_SSH_HOST: '192.168.0.155', HUB_SSH_PORT: '155', HUB_SSH_USER: 'roffo', HUB_SSH_KEY_FILE: '/k', HUB_SSH_KNOWN_HOSTS_FILE: '/kh', HUB_EXECUTOR_NAME: 'Loki' } });
    expect(env.controller.hubRegistry.get('env')).toMatchObject({ name: 'Loki', host: '192.168.0.155', port: 155, ssh_user: 'roffo', status: 'paired', source: 'env' });

  });
});

