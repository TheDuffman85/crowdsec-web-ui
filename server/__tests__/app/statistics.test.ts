import Database from 'better-sqlite3';
import { CrowdsecDatabase } from '../../database';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createController, destroyTempDir, sampleAlert, seedAlert, tempDir } from './harness';

const controllers: ReturnType<typeof createController>['controller'][] = [];
const start = (options: Parameters<typeof createController>[0] = {}) => {
  const result = createController({ initialCacheState: { isInitialized: true, isComplete: true }, ...options }); controllers.push(result.controller); return result;
};
const request = (url: string, body?: unknown) => new Request(`http://localhost/crowdsec/api/${url}`, body === undefined ? undefined : { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
afterEach(() => {
  for (const controller of controllers.splice(0)) { controller.stopBackgroundTasks(); controller.database.close(); }
  destroyTempDir();
});

describe('statistics API and worker lifecycle', () => {
  test('collects by default on new installations, as an editable setting', async () => {
    const { controller } = start();
    expect((await (await controller.fetch(request('config'))).json()).statistics).toMatchObject({ settings: { enabled: true }, managed: {} });
    expect((await controller.fetch(request('config/statistics', { enabled: false }))).status).toBe(200);
    expect(controller.statistics.configuration().settings.enabled).toBe(false);
  });

  test('stays opt-in for existing installations without creating a statistics database or doing request-triggered aggregation', async () => {
    // A state database from a version before statistics has no installation marker.
    const existing = new CrowdsecDatabase({ cachePath: path.join(tempDir, 'test.db') });
    existing.db.prepare("DELETE FROM state.settings WHERE key = 'statistics_existing_install_default_disabled'").run();
    existing.close();
    const { controller, database } = start();
    expect((await (await controller.fetch(request('config'))).json()).statistics.settings.enabled).toBe(false);
    expect((await controller.fetch(request('statistics'))).status).toBe(503);
    expect(existsSync(path.join(path.dirname(database.statePath!), 'statistics.db'))).toBe(false);
  });

  test('enables at runtime, backfills through real worker processes, and persists after cache reset', async () => {
    const { controller, database, fetchCalls } = start();
    seedAlert(database, sampleAlert({ machine_id: 'm-1', machine_alias: 'Server one' }));
    const lapiCalls = fetchCalls.filter((call) => call.url.includes('/v1/alerts')).length;
    expect((await controller.fetch(request('config/statistics', { enabled: true }))).status).toBe(200);
    await controller.statistics.run();
    expect(controller.statistics.configuration().status.error).toBeNull();
    const response = await controller.fetch(request('statistics'));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.totals).toMatchObject({ alerts: 1, uniqueIPs: 1, bans: 1, decisions: 1 });
    expect(data.machines[0]).toMatchObject({ label: 'Server one', alerts: 1, bans: 1 });
    expect(data.scenarios[0]).toMatchObject({ count: 1, uniqueIPs: 1, bans: 1, bannedIPs: 1 });
    const scenarioResponse = await controller.fetch(request(`statistics?scenario=${encodeURIComponent(data.scenarios[0].label)}`));
    expect((await scenarioResponse.json()).totals.alerts).toBe(1);
    expect((await (await controller.fetch(request('statistics?scenario=other'))).json()).totals.alerts).toBe(0);
    const ips = await (await controller.fetch(request('statistics/details?kind=ips'))).json();
    expect(ips).toMatchObject({ kind: 'ips', ranges: [], ips: [{ alerts: 1, bans: 1 }], total: 1 });
    expect(await (await controller.fetch(request('statistics/details?kind=returned&history=1&size=50'))).json()).toEqual({ kind: 'returned', ips: [], total: 0 });
    const machine = data.machines[0].value;
    const machines = await (await controller.fetch(request(`statistics/details?kind=machines&machines=${encodeURIComponent(JSON.stringify([machine]))}`))).json();
    expect(machines.machines[0]).toMatchObject({ value: machine, scenarios: [{ current: 1, previous: 0 }] });
    expect(data.configuration.status.backfillPending).toBe(false);
    expect(data.series[0].alerts).toBeNull();
    expect(data.coverage.comparisonPartial).toBe(true);
    expect(data.configuration.status.lastSuccess).toBeTruthy();
    database.clearSyncData();
    await controller.statistics.run();
    expect((await (await controller.fetch(request('statistics'))).json()).totals.alerts).toBe(1);
    expect(fetchCalls.filter((call) => call.url.includes('/v1/alerts'))).toHaveLength(lapiCalls);
    expect(database.getMeta('statistics_settings')?.value).toContain('true');
    const settings = database.db.prepare('SELECT value FROM state.settings WHERE key = ?').get('statistics_settings') as { value: string };
    expect(settings.value).toContain('true');
    expect(readFileSync(path.join(path.dirname(database.statePath!), 'statistics.db')).includes(Buffer.from('Blocked ssh bruteforce'))).toBe(false);
  });

  test('applies environment-managed settings and validates all controls', async () => {
    const { controller } = start({ env: { CONFIG_STATISTICS_ENABLED: 'false', CONFIG_STATISTICS_RETENTION_DAYS: '90', CONFIG_STATISTICS_JOB_INTERVAL: '30m' } });
    const config = await (await controller.fetch(request('config'))).json();
    expect(config.statistics).toMatchObject({ settings: { retentionDays: 90, jobInterval: '30m', enabled: false }, managed: { retentionDays: { path: 'statistics.retentionDays', env: 'CONFIG_STATISTICS_RETENTION_DAYS' } } });
    expect((await controller.fetch(request('config/statistics', { retentionDays: 30 }))).status).toBe(409);
    for (const settings of [{ retentionDays: -1 }, { jobInterval: '1m' }, { jobTimeBudget: '90s' }, { enabled: 'true' }, { unknown: true }]) expect((await controller.fetch(request('config/statistics', settings))).status).toBeGreaterThanOrEqual(400);
    expect((await controller.fetch(request('config/statistics', { enabled: true }))).status).toBe(409);
    expect((await controller.fetch(request('config/statistics', { jobTimeBudget: '10s' }))).status).toBe(200);
  });

  test('protects configuration writes in read-only mode and rejects malformed query ranges', async () => {
    const { controller } = start({ env: { CONFIG_UI_READ_ONLY: 'true' } });
    expect((await controller.fetch(request('config/statistics', { enabled: true }))).status).toBe(403);
    for (const query of ['from=2026-02-30', 'from=bad', 'to=2999-01-01', 'limit=1000', 'simulation=bad', 'instance=bad', 'ip=192.0.2.0%2F33', 'ip=bad%2F24', 'machine=bad', 'scenario=%20', `scenario=${'a'.repeat(257)}`, 'from=2026-02-01&to=2026-01-01']) {
      expect((await controller.fetch(request(`statistics?${query}`))).status, query).toBe(400);
    }
    for (const query of ['kind=bad', 'kind=ips&network=%20', 'kind=machines', 'kind=machines&machines=bad', `kind=machines&machines=${encodeURIComponent(JSON.stringify(['["unknown","m"]']))}`, 'kind=ips&from=bad', 'kind=ips&size=0', 'kind=ips&size=501', 'kind=returned&size=2.5']) {
      expect((await controller.fetch(request(`statistics/details?${query}`))).status, query).toBe(400);
    }
  });

  test('requires authentication when dashboard sign-in is enabled', async () => {
    const { controller } = start({ env: { CONFIG_AUTH_ENABLED: 'true' } });
    expect((await controller.fetch(request('statistics'))).status).toBe(401);
    expect((await controller.fetch(request('config/statistics', { enabled: true }))).status).toBe(401);
  });

  test('validates and forwards breakdown filters to statistics and details', async () => {
    const { controller } = start();
    const query = vi.spyOn(controller.statistics, 'query').mockResolvedValue({} as never);
    const details = vi.spyOn(controller.statistics, 'details').mockResolvedValue({} as never);
    const filters = 'country=de&network=Example%20Cloud&target=web.example.com';
    expect((await controller.fetch(request(`statistics?${filters}`))).status).toBe(200);
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ country: 'DE', network: 'Example Cloud', target: 'web.example.com' }));
    expect((await controller.fetch(request(`statistics/details?kind=ips&${filters}`))).status).toBe(200);
    expect(details).toHaveBeenCalledWith(expect.objectContaining({ country: 'DE', network: 'Example Cloud', target: 'web.example.com' }), expect.anything());
    for (const value of ['country=invalid', 'network=%20', `network=${'a'.repeat(257)}`, 'target=%20', `target=${'a'.repeat(257)}`]) {
      expect((await controller.fetch(request(`statistics?${value}`))).status, value).toBe(400);
    }
  });

  test('persists settings and deduplication through restart and cache reconstruction', async () => {
    const first = start();
    const alert = sampleAlert({ machine_id: 'm-1' });
    seedAlert(first.database, alert);
    await first.controller.statistics.update({ enabled: true, jobInterval: '30m' });
    await first.controller.statistics.run();
    first.controller.stopBackgroundTasks(); first.database.close(); controllers.pop();
    const second = start();
    expect(second.controller.statistics.configuration().settings).toMatchObject({ enabled: true, jobInterval: '30m' });
    const before = await (await second.controller.fetch(request('statistics'))).json();
    expect(before.configuration.status.lastSuccess).toBeTruthy();
    second.database.clearSyncData(); seedAlert(second.database, alert);
    await second.controller.statistics.run();
    expect((await (await second.controller.fetch(request('statistics'))).json()).totals.alerts).toBe(1);
  });

  test('finishes pending observations while disabled and backfills a gap when re-enabled', async () => {
    const { controller, database } = start();
    await controller.statistics.update({ enabled: true });
    seedAlert(database, sampleAlert());
    await controller.statistics.update({ enabled: false });
    seedAlert(database, sampleAlert({ id: 2, uuid: 'second', decisions: [] }));
    await controller.statistics.run();
    expect((await (await controller.fetch(request('statistics'))).json()).totals.alerts).toBe(1);
    await controller.statistics.update({ enabled: true }); await controller.statistics.run();
    expect((await (await controller.fetch(request('statistics'))).json()).totals.alerts).toBe(2);
  });

  test('starts with defaults when saved settings are damaged or come from another version', async () => {
    const first = start();
    first.database.setMeta('statistics_settings', JSON.stringify({ enabled: true, retentionDays: 99999, futureSetting: true }));
    first.controller.stopBackgroundTasks(); first.database.close(); controllers.pop();
    const second = start();
    expect(second.controller.statistics.configuration().settings).toMatchObject({ enabled: true, retentionDays: 90 });
    second.database.setMeta('statistics_settings', '{not json');
    second.database.setMeta('statistics_existing_install_default_disabled', 'true');
    second.controller.stopBackgroundTasks(); second.database.close(); controllers.pop();
    // Unreadable settings fall back to the installation default.
    expect(start().controller.statistics.configuration().settings.enabled).toBe(false);
  });

  test('does no archive work while disabled once pending observations are consumed', async () => {
    const { controller, database } = start();
    await controller.statistics.update({ enabled: true }); seedAlert(database, sampleAlert()); await controller.statistics.run();
    await controller.statistics.update({ enabled: false }); await controller.statistics.run();
    const before = controller.statistics.configuration().status;
    await controller.statistics.run();
    expect(controller.statistics.configuration().status).toMatchObject({ revision: before.revision, lastSuccess: before.lastSuccess });
  });

  test('continues coverage across a restart instead of leaving the downtime as a gap', async () => {
    const first = start({ env: { CONFIG_STATISTICS_ENABLED: 'true' } });
    seedAlert(first.database, sampleAlert()); await first.controller.statistics.run();
    const file = path.join(path.dirname(first.database.statePath!), 'statistics.db');
    first.controller.stopBackgroundTasks(); first.database.close(); controllers.pop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = start({ env: { CONFIG_STATISTICS_ENABLED: 'true' } });
    second.controller.statistics.start(); await second.controller.statistics.run();
    const archive = new Database(file, { readonly: true });
    try { expect(archive.prepare('SELECT COUNT(*) AS n FROM coverage').get()).toEqual({ n: 1 }); }
    finally { archive.close(); }
  });

  test('supports rollback-journal storage', async () => {
    const { controller, database } = start({ env: { CONFIG_STORAGE_WAL_ENABLED: 'false', CONFIG_STATISTICS_ENABLED: 'true' }, database: new CrowdsecDatabase({ cachePath: path.join(tempDir, 'test.db'), walEnabled: false }) });
    seedAlert(database, sampleAlert()); await controller.statistics.run();
    expect(controller.statistics.configuration().status.error).toBeNull();
    expect((await (await controller.fetch(request('statistics'))).json()).totals.alerts).toBe(1);
  });

  test('resumes bounded backfill across job budgets without losing or double-counting observations', async () => {
    const { controller, database } = start({ env: { CONFIG_STATISTICS_ENABLED: 'true', CONFIG_STATISTICS_JOB_TIME_BUDGET: '1s' } });
    database.transaction(() => {
      for (let i = 1; i <= 5000; i++) seedAlert(database, sampleAlert({ id: i, uuid: `budget-${i}`, decisions: [] }));
    })(undefined);
    await controller.statistics.run();
    expect(controller.statistics.configuration().status.backfillPending).toBe(true);
    // The time-budget setting above is managed; restart with a larger budget.
    controller.stopBackgroundTasks(); database.close(); controllers.pop();
    const restarted = start({ env: { CONFIG_STATISTICS_JOB_TIME_BUDGET: '30s' } });
    await restarted.controller.statistics.run();
    expect(restarted.controller.statistics.configuration().status).toMatchObject({ backfillPending: false, backlog: 0, error: null });
    expect((await (await restarted.controller.fetch(request('statistics'))).json()).totals.alerts).toBe(5000);
  });

  test('serializes settings changes and restores capture when saving durable settings fails', async () => {
    const { controller, database } = start();
    await Promise.all([controller.statistics.update({ enabled: true }), controller.statistics.update({ jobInterval: '30m' })]);
    expect(controller.statistics.configuration().settings).toMatchObject({ enabled: true, jobInterval: '30m' });
    await controller.statistics.update({ enabled: false });
    const original = database.setMeta.bind(database);
    const save = vi.spyOn(database, 'setMeta').mockImplementation((key, value) => {
      if (key === 'statistics_settings') throw new Error('Simulated state storage failure');
      original(key, value);
    });
    try { await expect(controller.statistics.update({ enabled: true })).rejects.toThrow('Simulated state storage failure'); }
    finally { save.mockRestore(); }
    expect(controller.statistics.configuration().settings.enabled).toBe(false);
    expect(database.getMeta('statistics_capture_enabled')?.value).toBe('false');
    seedAlert(database, sampleAlert());
    expect(database.db.prepare('SELECT COUNT(*) AS n FROM statistics_outbox').get()).toEqual({ n: 0 });
  });
});
