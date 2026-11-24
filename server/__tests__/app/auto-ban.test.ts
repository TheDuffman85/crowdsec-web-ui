import { describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_AUTO_BAN_SETTINGS,
  findCandidates,
  listAutoBanLog,
  loadAutoBanSettings,
  runAutoBan,
  saveAutoBanSettings,
  validateAutoBanSettings,
  type AutoBanRule,
  type AutoBanSettings,
} from '../../app/auto-ban';
import { createAuthSessionCookie, createController, sampleAlert, seedAlert } from './harness';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const rule: AutoBanRule = { id: 'r1', name: 'SSH brute force', scenario: 'ssh', min_alerts: 3, window_minutes: 60, duration: '4h', escalate: false };

let nextId = 5000;
function seed(database: Parameters<typeof seedAlert>[0], ip: string, minutes: number, scenario = 'crowdsecurity/ssh-bf', decisions: Array<{ stop: string; type?: string }> = []) {
  const id = nextId++;
  seedAlert(database, sampleAlert({
    id, uuid: `ab-${id}`, created_at: minutesAgo(minutes), scenario, source: { ip, value: ip, cn: 'DE' },
    decisions: decisions.map((decision, index) => ({
      id: id * 10 + index, type: decision.type ?? 'ban', value: ip, duration: '4h', created_at: minutesAgo(minutes),
      stop_at: decision.stop, origin: 'crowdsec', simulated: false,
    })),
  }));
}

function setup() {
  const { controller } = createController();
  return controller.database;
}

describe('validateAutoBanSettings', () => {
  const valid = { enabled: true, dry_run: true, rules: [{ name: 'x', scenario: 'ssh', min_alerts: 5, window_minutes: 30, duration: '1d', escalate: true }] };

  test('accepts a valid payload and assigns ids', () => {
    const result = validateAutoBanSettings(valid);
    expect('settings' in result && result.settings.rules[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test.each([
    [{ ...valid, enabled: 'yes' }, 'enabled'],
    [{ ...valid, dry_run: undefined }, 'dry_run'],
    [{ ...valid, rules: 'x' }, 'rules'],
    [{ ...valid, rules: [{ ...valid.rules[0], name: '' }] }, 'name'],
    [{ ...valid, rules: [{ ...valid.rules[0], scenario: ' ' }] }, 'scenario'],
    [{ ...valid, rules: [{ ...valid.rules[0], min_alerts: 1 }] }, 'min_alerts'],
    [{ ...valid, rules: [{ ...valid.rules[0], window_minutes: 0 }] }, 'window_minutes'],
    [{ ...valid, rules: [{ ...valid.rules[0], duration: 'forever' }] }, 'duration'],
    [{ ...valid, rules: [{ ...valid.rules[0], duration: '99999d' }] }, 'duration'],
    [{ ...valid, rules: [{ ...valid.rules[0], escalate: 1 }] }, 'escalate'],
    [{ ...valid, rules: Array.from({ length: 21 }, () => valid.rules[0]) }, 'At most'],
    [{ ...valid, rules: [{ ...valid.rules[0], id: 'a' }, { ...valid.rules[0], id: 'a' }] }, 'duplicate'],
    [null, 'object'],
  ])('rejects %j', (input, fragment) => {
    const result = validateAutoBanSettings(input);
    expect('error' in result && result.error).toContain(fragment);
  });
});

describe('settings storage', () => {
  test('defaults to disabled dry run and round-trips', () => {
    const database = setup();
    expect(loadAutoBanSettings(database)).toEqual(DEFAULT_AUTO_BAN_SETTINGS);
    const settings: AutoBanSettings = { enabled: true, dry_run: false, rules: [rule] };
    saveAutoBanSettings(database, settings);
    expect(loadAutoBanSettings(database)).toEqual(settings);
  });

  test('falls back to the safe default for damaged data', () => {
    const database = setup();
    database.db.query("INSERT INTO auto_ban_settings (id, value) VALUES (1, 'not json')").run();
    expect(loadAutoBanSettings(database)).toEqual(DEFAULT_AUTO_BAN_SETTINGS);
  });
});

describe('findCandidates', () => {
  test('matches on count, window and scenario text', () => {
    const database = setup();
    for (const minutes of [5, 10, 15]) seed(database, '203.0.113.1', minutes);
    for (const minutes of [5, 10]) seed(database, '203.0.113.2', minutes);
    for (const minutes of [5, 90, 120]) seed(database, '203.0.113.3', minutes);
    for (const minutes of [5, 10, 15]) seed(database, '203.0.113.4', minutes, 'crowdsecurity/http-probing');
    expect(findCandidates(database, rule, NOW)).toEqual([{ ip: '203.0.113.1', alerts: 3, duration: '4h', previous_bans: 0 }]);
    expect(findCandidates(database, { ...rule, scenario: '*', min_alerts: 3 }, NOW).map((c) => c.ip)).toEqual(['203.0.113.1', '203.0.113.4']);
  });

  test('treats LIKE wildcards in the scenario text literally', () => {
    const database = setup();
    for (const minutes of [5, 10, 15]) seed(database, '203.0.113.1', minutes);
    expect(findCandidates(database, { ...rule, scenario: 's%f' }, NOW)).toEqual([]);
    expect(findCandidates(database, { ...rule, scenario: 'ssh_bf' }, NOW)).toEqual([]);
  });

  test('skips private addresses and addresses that are already banned', () => {
    const database = setup();
    for (const minutes of [5, 10, 15]) seed(database, '192.168.1.5', minutes);
    for (const minutes of [5, 10, 15]) seed(database, '203.0.113.7', minutes, 'crowdsecurity/ssh-bf', [{ stop: new Date(NOW + 3_600_000).toISOString() }]);
    for (const minutes of [5, 10, 15]) seed(database, '203.0.113.8', minutes, 'crowdsecurity/ssh-bf', [{ stop: minutesAgo(1) }]);
    expect(findCandidates(database, rule, NOW).map((c) => c.ip)).toEqual(['203.0.113.8']);
  });

  test('escalates the duration for repeat offenders', () => {
    const database = setup();
    for (const minutes of [5, 10, 15]) seed(database, '203.0.113.9', minutes, 'crowdsecurity/ssh-bf', [{ stop: minutesAgo(2) }]);
    const [candidate] = findCandidates(database, { ...rule, escalate: true }, NOW);
    expect(candidate!.previous_bans).toBeGreaterThan(0);
    expect(candidate!.duration).not.toBe('4h');
  });
});

describe('runAutoBan', () => {
  function deps(database: ReturnType<typeof setup>, overrides: Partial<Parameters<typeof runAutoBan>[0]> = {}) {
    return {
      database,
      now: () => NOW,
      isAllowlisted: vi.fn(async () => false as boolean | null),
      addBan: vi.fn(async () => undefined),
      ...overrides,
    };
  }
  function seedMatch(database: ReturnType<typeof setup>, ip = '203.0.113.1') {
    for (const minutes of [5, 10, 15]) seed(database, ip, minutes);
  }

  test('does nothing while disabled', async () => {
    const database = setup();
    seedMatch(database);
    const d = deps(database);
    expect(await runAutoBan(d, { enabled: false, dry_run: false, rules: [rule] })).toEqual([]);
    expect(d.addBan).not.toHaveBeenCalled();
  });

  test('dry run only records what would happen, once per window', async () => {
    const database = setup();
    seedMatch(database);
    const d = deps(database);
    const settings = { enabled: true, dry_run: true, rules: [rule] };
    const first = await runAutoBan(d, settings);
    expect(first.map((entry) => [entry.ip, entry.action, entry.duration, entry.alerts])).toEqual([['203.0.113.1', 'would_ban', '4h', 3]]);
    expect(await runAutoBan(d, settings)).toEqual([]);
    expect(d.addBan).not.toHaveBeenCalled();
    expect(d.isAllowlisted).not.toHaveBeenCalled();
    expect(listAutoBanLog(database)).toHaveLength(1);
  });

  test('live run bans, with a reason naming the rule', async () => {
    const database = setup();
    seedMatch(database);
    const d = deps(database);
    const result = await runAutoBan(d, { enabled: true, dry_run: false, rules: [rule] });
    expect(result[0]!.action).toBe('banned');
    expect(d.addBan).toHaveBeenCalledWith('203.0.113.1', '4h', 'auto-ban: SSH brute force');
  });

  test('never bans allowlisted addresses or when the check is unavailable', async () => {
    const database = setup();
    seedMatch(database, '203.0.113.1');
    seedMatch(database, '203.0.113.2');
    const d = deps(database, { isAllowlisted: vi.fn(async (ip: string) => (ip === '203.0.113.1' ? true : null)) });
    const result = await runAutoBan(d, { enabled: true, dry_run: false, rules: [rule] });
    expect(result.map((entry) => [entry.ip, entry.action]).sort()).toEqual([['203.0.113.1', 'skipped_allowlisted'], ['203.0.113.2', 'failed']]);
    expect(d.addBan).not.toHaveBeenCalled();
  });

  test('records a failed ban without throwing', async () => {
    const database = setup();
    seedMatch(database);
    const d = deps(database, { addBan: vi.fn(async () => { throw new Error('LAPI down'); }) });
    const result = await runAutoBan(d, { enabled: true, dry_run: false, rules: [rule] });
    expect(result[0]).toMatchObject({ action: 'failed', detail: 'LAPI down' });
  });

  test('caps the number of actions in one run', async () => {
    const database = setup();
    for (let i = 1; i <= 30; i += 1) seedMatch(database, `203.0.113.${i}`);
    const d = deps(database);
    const result = await runAutoBan(d, { enabled: true, dry_run: true, rules: [rule] });
    expect(result).toHaveLength(25);
  });
});

describe('auto-ban API', () => {
  const root = 'http://localhost/crowdsec/api/auto-ban';
  const settings = { enabled: true, dry_run: true, rules: [{ name: 'x', scenario: 'ssh', min_alerts: 3, window_minutes: 60, duration: '4h', escalate: false }] };

  async function call(controller: ReturnType<typeof createController>['controller'], path: string, options: { method?: string; cookie?: string; body?: unknown } = {}) {
    return await controller.fetch(new Request(`${root}${path}`, {
      method: options.method ?? 'GET',
      headers: { ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    }));
  }

  test('only administrators can change the rules', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
    const adminId = controller.database.createAuthUser({ username: 'admin', passwordHash: 'hash', role: 'admin', authProvider: 'password' });
    const viewerId = controller.database.createAuthUser({ username: 'viewer', passwordHash: 'hash', role: 'read-only', authProvider: 'password' });
    const admin = createAuthSessionCookie(controller.database, { userId: adminId, username: 'admin', role: 'admin', authMethod: 'password' });
    const viewer = createAuthSessionCookie(controller.database, { userId: viewerId, username: 'viewer', role: 'read-only', authMethod: 'password' });

    expect((await call(controller, '')).status).toBe(401);
    expect((await call(controller, '', { method: 'PUT', cookie: viewer, body: settings })).status).toBe(403);
    expect((await call(controller, '', { method: 'PUT', cookie: admin, body: { ...settings, rules: 'x' } })).status).toBe(400);

    const saved = await call(controller, '', { method: 'PUT', cookie: admin, body: settings });
    expect(saved.status).toBe(200);
    const read = await (await call(controller, '', { cookie: viewer })).json() as { settings: AutoBanSettings; log: unknown[] };
    expect(read.settings.enabled).toBe(true);
    expect(read.settings.rules[0]!.id).toBeTruthy();
    expect(read.log).toEqual([]);
  });

  test('preview lists current matches without logging', async () => {
    const { controller } = createController();
    const base = Date.now();
    for (const minutes of [1, 2, 3]) {
      const id = nextId++;
      seedAlert(controller.database, sampleAlert({ id, uuid: `pv-${id}`, created_at: new Date(base - minutes * 60_000).toISOString(), scenario: 'crowdsecurity/ssh-bf', source: { ip: '203.0.113.50', value: '203.0.113.50', cn: 'DE' }, decisions: [] }));
    }
    await call(controller, '', { method: 'PUT', body: settings });
    const response = await call(controller, '/preview', { method: 'POST' });
    const body = await response.json() as { rules: Array<{ candidates: Array<{ ip: string }> }> };
    expect(body.rules[0]!.candidates.map((c) => c.ip)).toEqual(['203.0.113.50']);
    expect(listAutoBanLog(controller.database)).toEqual([]);
  });
});
