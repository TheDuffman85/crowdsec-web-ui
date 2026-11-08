import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CrowdsecDatabase } from '../../database';
import { StatisticsStore, canonicalStatisticsIP, canonicalStatisticsSource, decodeStatisticsObservation, type ConsolidationContext } from '../../statistics-store';
import { acknowledgeStatisticsBatch, configureStatisticsCapture, readStatisticsBatch } from '../../statistics-capture';
import { statisticsCutoff, validateStatisticsSettings, type StatisticsFilters } from '../../../shared/statistics';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'statistics-'));
  const source = new CrowdsecDatabase({ dataDir: dir });
  const store = new StatisticsStore(path.join(dir, 'statistics.db'));
  cleanups.push(() => { source.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const context: ConsolidationContext = { cutoff: '2026-01-01', epoch: 'first', enabled: true, caughtUp: true, coverageFrom: { default: '2026-01-01T00:00:00.000Z' }, instances: ['default'], now: '2026-02-01T12:00:00.000Z' };
  const filters: StatisticsFilters = { from: '2026-01-01', to: '2026-01-31', instance: 'all', simulation: 'all', limit: 10 };
  const query = (overrides: Partial<StatisticsFilters> = {}) => store.query({ ...filters, ...overrides }, 365, ['default', 'other'], Date.parse(context.now));
  const alert = (id: number, overrides: Record<string, unknown> = {}) => {
    const record = { id, uuid: `a-${id}`, created_at: `2026-01-${id % 2 ? '10' : '11'}T10:00:00.000Z`, scenario: 'ssh', source: { ip: '1.2.3.4', cn: 'DE', as_number: '42', as_name: 'Network' }, machine_id: 'machine-1', machine_alias: 'Server', events_count: 20, ...overrides };
    source.insertAlert({ $id: id, $uuid: String(record.uuid), $created_at: String(record.created_at), $message: 'not stored in statistics', $record: record as any, $instance_id: String(overrides.instance_id || 'default') });
  };
  const decision = (id: number, alertId: number, overrides: Record<string, unknown> = {}) => {
    const record = { id, type: 'ban', origin: 'crowdsec', value: '1.2.3.4', created_at: '2026-01-12T10:00:00.000Z', ...overrides };
    source.insertDecision({ $id: String(id), $uuid: String(id), $alert_id: alertId, $created_at: String(record.created_at), $stop_at: '2026-01-13T00:00:00.000Z', $record: record as any, $instance_id: String(overrides.instance_id || 'default') });
  };
  const consolidate = () => {
    const batch = readStatisticsBatch(source.db, true);
    store.consolidate(batch.rows, context);
    acknowledgeStatisticsBatch(source.db, batch.rows.map((r) => r.seq), context.cutoff);
    return batch;
  };
  return { source, store, context, query, alert, decision, consolidate };
}

describe('long-term statistics capture and aggregation', () => {
  it('archives distinct targets and ranks them within the selected scope, without counting bans as alerts', () => {
    const f = fixture(); configureStatisticsCapture(f.source.db, true);
    const common = { created_at: '2026-01-10T10:00:00.000Z', target: 'web.example.com' };
    f.alert(1, common); f.alert(2, common);
    f.alert(3, { ...common, source: { ip: '1.2.3.5' } });
    f.alert(4, { ...common, target: 'ssh.example.com' });
    f.alert(5, { ...common, target: 'other.example.com', instance_id: 'other' });
    f.alert(6, { ...common, target: 'simulated.example.com', simulated: true });
    f.alert(7, { ...common, target: 'Unknown' });
    f.alert(8, { ...common, target: 'N/A' });
    f.alert(9, { ...common, target: '', machine_alias: '', machine_id: '' });
    f.decision(1, 1); f.decision(2, 1);
    const batch = f.consolidate();
    expect(decodeStatisticsObservation(batch.rows.find((row) => decodeStatisticsObservation(row.payload).kind === 'alert')!.payload).target).toBe('web.example.com');
    expect(f.query({ instance: 'default', simulation: 'live' }).targets).toEqual([
      { label: 'web.example.com', count: 3, uniqueIPs: 2 },
      { label: 'ssh.example.com', count: 1, uniqueIPs: 1 },
    ]);
    expect(f.query({ ip: '1.2.3.5' }).targets).toEqual([{ label: 'web.example.com', count: 1, uniqueIPs: 1 }]);
    expect(f.query({ simulation: 'simulated' }).targets).toEqual([{ label: 'simulated.example.com', count: 1, uniqueIPs: 1 }]);
    expect(f.query({ instance: 'other' }).targets).toEqual([{ label: 'other.example.com', count: 1, uniqueIPs: 1 }]);
    expect(f.query({ from: '2026-01-11' }).targets).toEqual([]);
    // Captured targets survive deleting cached alerts, and replay is idempotent.
    f.source.db.prepare('DELETE FROM alerts').run();
    f.store.consolidate(batch.rows, f.context);
    expect(f.query({ instance: 'default', simulation: 'live' }).targets[0]).toEqual({ label: 'web.example.com', count: 3, uniqueIPs: 2 });
  });

  it('upgrades an existing clustered archive without losing historical counts or assuming targets', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'statistics-targets-'));
    const file = path.join(dir, 'statistics.db');
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const first = new StatisticsStore(file);
    const context: ConsolidationContext = { cutoff: '2026-01-01', epoch: 'e', enabled: false, caughtUp: true, coverageFrom: {}, instances: ['default'], now: '2026-02-01T12:00:00.000Z' };
    const legacy = { seq: 1, identity: 'legacy', day: '2026-01-10', payload: JSON.stringify([1, 'a', '2026-01-10T10:00:00.000Z', 'default', '1.2.3.4', '', '', '', '', '', 'ssh', 0, 20]) };
    first.consolidate([legacy], context);
    first.db.exec('ALTER TABLE cells DROP COLUMN target');
    first.close();
    const upgraded = new StatisticsStore(file);
    cleanups.push(() => upgraded.close());
    upgraded.consolidate([legacy, { ...legacy, seq: 2, identity: 'new', payload: JSON.stringify([1, 'a', '2026-01-10T10:00:00.000Z', 'default', '1.2.3.4', '', '', '', '', '', 'ssh', 0, 20, 'web.example.com']) }], context);
    const result = upgraded.query({ from: '2026-01-01', to: '2026-01-31', instance: 'all', simulation: 'all', limit: 10 }, 365, ['default'], Date.parse(context.now));
    expect(result.totals).toMatchObject({ alerts: 2, events: 40 });
    expect(result.targets).toEqual([{ label: 'web.example.com', count: 1, uniqueIPs: 1 }]);
  });

  it('captures exact IP/machine/scenario relationships and distinct expired bans', () => {
    const f = fixture(); configureStatisticsCapture(f.source.db, true);
    f.alert(1); f.alert(2); f.alert(3, { scenario: 'http', machine_id: 'machine-2', machine_alias: 'Web' });
    f.alert(4, { source: { value: '192.0.2.0/24' } });
    f.decision(1, 1); f.decision(2, 1); f.decision(3, 3, { type: 'captcha' });
    f.consolidate();
    const result = f.query();
    // Alert 1 (day 10) was banned and the IP attacked again on day 11. The
    // preceding period is outside retention, so new IPs cannot be told apart.
    expect(result.totals).toEqual({ alerts: 4, events: 80, uniqueIPs: 1, bans: 2, decisions: 3, repeatAttackers: 1, bannedIPs: 1, returnedAfterBan: 1, newIPs: null });
    expect(result.previousTotals).toBeNull();
    expect(result.attackers[0]).toMatchObject({ alerts: 3, bans: 2, machines: 2, activeDays: 2, country: 'DE', asn: '42', network: 'Network' });
    expect(result.attackers[0].scenarios).toEqual([{ label: 'ssh', count: 2 }, { label: 'http', count: 1 }]);
    expect(result.machines[0]).toMatchObject({ alerts: 3, uniqueIPs: 1, bans: 2 });
    expect(result.attackers[0].returnedAfterBan).toBe(true);
    expect(result.scenarios).toEqual([
      { label: 'ssh', count: 3, uniqueIPs: 1, machines: 1, bans: 2, bannedIPs: 1, previous: null },
      { label: 'http', count: 1, uniqueIPs: 1, machines: 1, bans: 0, bannedIPs: 0, previous: null },
    ]);
  });

  it('skips unknown countries and scenarios in top lists and ranks IP ranges, like the dashboard', () => {
    const f = fixture(); configureStatisticsCapture(f.source.db, true);
    f.alert(1); f.alert(2, { scenario: '', source: { ip: '1.2.3.5' } });
    f.alert(3, { source: { value: '192.0.2.0/24', range: '192.0.2.0/24', cn: 'Unknown' } });
    f.alert(5, { source: { value: '192.0.2.0/24', range: '192.0.2.0/24' } });
    f.consolidate();
    const result = f.query();
    expect(result.countries).toEqual([{ label: 'DE', count: 1, uniqueIPs: 1 }]);
    expect(result.scenarios).toEqual([{ label: 'ssh', count: 3, uniqueIPs: 1, machines: 1, bans: 0, bannedIPs: 0, previous: null }]);
    expect(result.attackers.map((row) => [row.value, row.alerts])).toEqual([['192.0.2.0/24', 2], ['1.2.3.4', 1], ['1.2.3.5', 1]]);
    expect(result.totals).toMatchObject({ alerts: 4, uniqueIPs: 2, repeatAttackers: 0 });
    expect(f.query({ ip: '192.0.2.0/24' }).totals.alerts).toBe(2);
    expect(canonicalStatisticsSource('2001:DB8::/32')).toBe('2001:db8::/32');
    expect(canonicalStatisticsSource('192.0.2.0/33')).toBe('');
  });

  it('lists only alerts with a known AS name in Top AS, like the dashboard', () => {
    const f = fixture(); configureStatisticsCapture(f.source.db, true);
    f.alert(1); f.alert(2, { source: { ip: '1.2.3.5', as_number: '0' } }); f.alert(3, { source: { ip: '1.2.3.6', as_number: '0', as_name: '' } });
    f.alert(4, { source: { ip: '1.2.3.7', as_number: '64500' } });
    f.consolidate();
    expect(f.query().networks).toEqual([{ label: 'Network', count: 1, uniqueIPs: 1 }]);
  });

  it('compares with a fully covered preceding period and flags new, returning and silent sources', () => {
    const f = fixture(); configureStatisticsCapture(f.source.db, true);
    const at = (day: string) => `2026-01-${day}T10:00:00.000Z`;
    // Preceding period (Jan 8-19): a banned SSH attacker and a web server that later goes quiet.
    f.alert(1, { created_at: at('10') }); f.decision(1, 1, { created_at: at('10') });
    f.alert(2, { created_at: at('11'), scenario: 'http', source: { ip: '5.5.5.5', cn: 'FR' }, machine_id: 'machine-2', machine_alias: 'Web' });
    // Range (Jan 20-31): the banned IP returns, a new IP arrives with a new scenario.
    f.alert(3, { created_at: at('21') });
    f.alert(4, { created_at: at('22'), scenario: 'smb', source: { ip: '6.6.6.6', cn: 'US' } });
    f.alert(5, { created_at: at('23'), scenario: 'smb', source: { ip: '6.6.6.6', cn: 'US' } });
    f.consolidate();
    const result = f.query({ instance: 'default', from: '2026-01-20', to: '2026-01-31' });
    expect(result.coverage.comparisonPartial).toBe(false);
    expect(result.totals).toMatchObject({ alerts: 3, uniqueIPs: 2, bannedIPs: 0, repeatAttackers: 1, returnedAfterBan: 1, newIPs: 1 });
    expect(result.previousTotals).toEqual({ alerts: 2, bans: 1, decisions: 1, uniqueIPs: 2, bannedIPs: 1, repeatAttackers: 0 });
    expect(result.scenarios.map((s) => [s.label, s.count, s.previous])).toEqual([['smb', 2, 0], ['ssh', 1, 1]]);
    expect(result.attackers.find((row) => row.value === '1.2.3.4')?.returnedAfterBan).toBe(true);
    expect(result.attackers.find((row) => row.value === '6.6.6.6')?.returnedAfterBan).toBe(false);
    expect(result.quietMachines).toEqual([{ value: JSON.stringify(['default', 'machine-2']), label: 'Web', previous: 1 }]);
    expect(result.increases).toEqual([{ value: JSON.stringify(['default', 'machine-1']), label: 'Server', current: 3, previous: 1, change: 2 }]);
    expect(result.decreases).toEqual([]);
    // Silence is expected when only part of the traffic is selected.
    expect(f.query({ instance: 'default', from: '2026-01-20', to: '2026-01-31', scenario: 'ssh' }).quietMachines).toEqual([]);
    expect(f.query({ instance: 'default', from: '2026-01-20', to: '2026-01-31', scenario: 'smb' }).totals).toMatchObject({ alerts: 2, uniqueIPs: 1, newIPs: 1 });
  });

  it('lists machines whose alerts fell, apart from those that went quiet', () => {
    const f = fixture(); configureStatisticsCapture(f.source.db, true);
    const at = (day: string) => `2026-01-${day}T10:00:00.000Z`;
    f.alert(1, { created_at: at('10') }); f.alert(2, { created_at: at('11') }); f.alert(3, { created_at: at('12') });
    f.alert(4, { created_at: at('13'), machine_id: 'machine-2', machine_alias: 'Web' });
    f.alert(5, { created_at: at('21') });
    f.consolidate();
    const result = f.query({ instance: 'default', from: '2026-01-20', to: '2026-01-31' });
    expect(result.decreases).toEqual([{ value: JSON.stringify(['default', 'machine-1']), label: 'Server', current: 1, previous: 3, change: -2 }]);
    expect(result.increases).toEqual([]);
    expect(result.quietMachines.map((row) => row.label)).toEqual(['Web']);
  });

  it('loads finding details: IPs with their ranges, returning IPs and machine activity', () => {
    const f = fixture(); configureStatisticsCapture(f.source.db, true);
    const at = (day: string) => `2026-01-${day}T10:00:00.000Z`;
    const cloud = (ip: string) => ({ ip, cn: 'US', as_number: '15169', as_name: 'Cloud' });
    f.alert(1, { created_at: at('10') }); f.decision(1, 1, { created_at: at('10') });
    f.alert(2, { created_at: at('11'), machine_id: 'machine-2', machine_alias: 'Web' });
    f.alert(3, { created_at: at('21') });
    f.alert(4, { created_at: at('22'), scenario: 'http', source: cloud('198.51.100.7') });
    f.alert(5, { created_at: at('22'), scenario: 'http', source: cloud('198.51.100.8') });
    f.alert(6, { created_at: at('23'), scenario: 'http', source: cloud('2001:db8:1:2::9') });
    f.consolidate();
    const range = { instance: 'default', from: '2026-01-20', to: '2026-01-31' } as const;
    const details = (request: Parameters<typeof f.store.details>[1], overrides: Partial<StatisticsFilters> = {}) => f.store.details(
      { simulation: 'all', limit: 10, ...range, ...overrides } as StatisticsFilters, request, 365, ['default'], Date.parse(f.context.now));

    const network = details({ kind: 'ips', network: 'Cloud' });
    expect(network.kind === 'ips' && network.ips.map((row) => row.ip)).toEqual(['198.51.100.7', '198.51.100.8', '2001:db8:1:2::9']);
    expect(network.kind === 'ips' && network.ranges).toEqual([{ range: '198.51.100.0/24', ips: 2, alerts: 2 }, { range: '2001:db8:1:2::/64', ips: 1, alerts: 1 }]);
    // Lists are paged; totals count every match.
    const page = details({ kind: 'ips', network: 'Cloud', size: 1 });
    expect(page).toMatchObject({ kind: 'ips', ips: [{ ip: '198.51.100.7' }], total: 3, ranges: [{ range: '198.51.100.0/24' }], rangeTotal: 2 });
    const scenario = details({ kind: 'ips' }, { scenario: 'ssh' });
    expect(scenario.kind === 'ips' && scenario.ips).toEqual([expect.objectContaining({ ip: '1.2.3.4', alerts: 1, bans: 0, machines: 1, country: 'DE' })]);
    expect(scenario.kind === 'ips' && scenario.ranges).toEqual([]);

    // The ban before the range only counts when history is requested.
    const returned = details({ kind: 'returned', history: true });
    expect(returned.kind === 'returned' && returned.ips).toEqual([expect.objectContaining({ ip: '1.2.3.4', bannedBefore: true, firstBan: null })]);
    expect(details({ kind: 'returned', history: false })).toEqual({ kind: 'returned', ips: [], total: 0 });
    const within = details({ kind: 'returned', history: false }, { from: '2026-01-01' });
    expect(within.kind === 'returned' && within.ips).toEqual([expect.objectContaining({ ip: '1.2.3.4', firstBan: '2026-01-10', bannedBefore: false })]);

    const web = JSON.stringify(['default', 'machine-2']);
    const server = JSON.stringify(['default', 'machine-1']);
    const machines = details({ kind: 'machines', machines: [web, server] });
    expect(machines).toEqual({ kind: 'machines', machines: [
      { value: web, lastActivity: at('11'), scenarios: [{ label: 'ssh', current: 0, previous: 1 }], ips: [] },
      { value: server, lastActivity: at('23'), scenarios: [{ label: 'http', current: 3, previous: 0 }, { label: 'ssh', current: 1, previous: 1 }], ips: expect.arrayContaining([{ ip: '1.2.3.4', alerts: 1 }]) },
    ] });
  });

  it('counts blocklist decisions as issued decisions but not as attack bans', () => {
    const f = fixture(); configureStatisticsCapture(f.source.db, true);
    f.alert(1); f.decision(1, 1);
    f.alert(2, { scenario: 'crowdsecurity/blocklist-import', source: { scope: 'lists:example' } });
    f.decision(2, 2, { origin: 'lists', value: '198.51.100.9' }); f.decision(3, 2, { origin: 'lists', value: '198.51.100.10' });
    f.consolidate();
    expect(f.query().totals).toMatchObject({ bans: 1, decisions: 3, bannedIPs: 1 });
    expect(f.query().decisionOrigins).toEqual([{ label: 'lists', count: 2 }, { label: 'crowdsec', count: 1 }]);
  });

  it('reorganizes an archive of the first layout by date and keeps linking decisions to its alerts', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'statistics-layout-'));
    const file = path.join(dir, 'statistics.db');
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const digest = (value: string) => createHash('sha256').update(value).digest();
    const dims = ['alert', '2026-01-10', 'default', 0, 0, '1.2.3.4', '["default","m-1"]', 'm-1', 'Server', 'ssh', 'DE', '42', 'Network', '', ''];
    const identity = JSON.stringify(['alert', 'default', ['uuid', 'a-1']]);
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE seen (identity BLOB PRIMARY KEY, day TEXT NOT NULL, cell_key BLOB) WITHOUT ROWID;
      CREATE TABLE cells (key BLOB PRIMARY KEY, kind TEXT NOT NULL, day TEXT NOT NULL, instance TEXT NOT NULL, simulated INTEGER NOT NULL,
        alert_simulated INTEGER NOT NULL, ip TEXT NOT NULL, machine TEXT NOT NULL, machine_id TEXT NOT NULL, machine_name TEXT NOT NULL,
        scenario TEXT NOT NULL, country TEXT NOT NULL, asn TEXT NOT NULL, network TEXT NOT NULL, type TEXT NOT NULL, origin TEXT NOT NULL,
        count INTEGER NOT NULL, events INTEGER NOT NULL, first_at TEXT NOT NULL, last_at TEXT NOT NULL, hours TEXT NOT NULL) WITHOUT ROWID;
      CREATE INDEX idx_statistics_cells_date ON cells(kind, day, instance);
      CREATE INDEX idx_statistics_cells_expiry ON cells(day);
      CREATE INDEX idx_statistics_cells_ip ON cells(ip, kind, day);
      CREATE INDEX idx_statistics_cells_machine ON cells(machine, kind, day);
    `);
    legacy.prepare(`INSERT INTO cells VALUES (${Array(21).fill('?').join(',')})`).run(digest(JSON.stringify(dims)), ...dims, 2, 40, '2026-01-10T10:00:00.000Z', '2026-01-10T11:00:00.000Z', '{"10":2}');
    legacy.prepare('INSERT INTO seen VALUES (?, ?, ?)').run(digest(identity), '2026-01-10', digest(JSON.stringify(dims)));
    legacy.close();

    const store = new StatisticsStore(file);
    cleanups.push(() => store.close());
    expect((store.db.prepare('PRAGMA table_info(cells)').all() as Array<{ name: string; pk: number }>).filter((column) => column.pk).map((column) => column.name)).toEqual(['kind', 'day', 'key']);
    // A later decision whose alert is only known from the old layout still joins it.
    store.consolidate([{ seq: 1, identity: JSON.stringify(['decision', 'default', 9, 1, '2026-01-12T00:00:00.000Z']), day: '2026-01-12',
      payload: JSON.stringify([1, 'd', '2026-01-12T00:00:00.000Z', 'default', '', '', '', '', '', '', '', 0, '2026-01-12T00:00:00.000Z', 0, 'ban', 'crowdsec', JSON.parse(identity)]) }],
    { cutoff: '2026-01-01', epoch: 'e', enabled: false, caughtUp: false, coverageFrom: {}, instances: ['default'], now: '2026-02-01T12:00:00.000Z' });
    const result = store.query({ from: '2026-01-01', to: '2026-01-31', instance: 'all', simulation: 'all', limit: 10 }, 365, ['default'], Date.parse('2026-02-01T12:00:00.000Z'));
    expect(result.totals).toMatchObject({ alerts: 2, events: 40, bans: 1, decisions: 1, uniqueIPs: 1, bannedIPs: 1 });
    expect(result.attackers[0]).toMatchObject({ value: '1.2.3.4', alerts: 2, bans: 1 });
    expect(store.hasExpired('2026-01-11')).toBe(true);
    store.prune('2026-01-11');
    expect(store.hasExpired('2026-01-11')).toBe(false);
  });

  it('is atomic with the source transaction and idempotent across replay and expiry updates', () => {
    const f = fixture(); configureStatisticsCapture(f.source.db, true);
    expect(() => f.source.db.transaction(() => { f.alert(1); throw new Error('rollback'); })()).toThrow('rollback');
    expect(readStatisticsBatch(f.source.db, false).rows).toHaveLength(0);
    f.alert(1); f.decision(1, 1);
    const batch = readStatisticsBatch(f.source.db, true);
    f.store.consolidate(batch.rows, f.context);
    // Simulate a crash after statistics commit but before outbox acknowledgement.
    f.store.consolidate(batch.rows, f.context);
    acknowledgeStatisticsBatch(f.source.db, batch.rows.map((r) => r.seq), f.context.cutoff);
    f.alert(1, { scenario: 'edited' }); f.decision(1, 1, { duration: '12h' }); f.consolidate();
    expect(f.query().totals).toMatchObject({ alerts: 1, bans: 1, decisions: 1 });
    expect(f.query().scenarios).toMatchObject([{ label: 'ssh', count: 1 }]);
  });

  it('backfills old cached records and preserves their relationships when parents are deleted first', () => {
    const f = fixture(); f.alert(1); f.decision(1, 1);
    configureStatisticsCapture(f.source.db, true);
    // A parent can already have been captured while a large decision backfill is pending.
    f.source.db.prepare('UPDATE alerts SET statistics_captured = 1 WHERE id = 1').run();
    f.source.db.prepare('DELETE FROM alerts').run();
    f.source.db.prepare('DELETE FROM decisions').run();
    f.consolidate();
    expect(f.query().totals).toMatchObject({ alerts: 1, bans: 1, decisions: 1 });
    expect(f.query().machines[0].bans).toBe(1);
  });

  it('separates alert cohort bans from decisions issued and rejects duplicate source IDs across instances', () => {
    const f = fixture(); configureStatisticsCapture(f.source.db, true);
    f.alert(1); f.decision(1, 1, { created_at: '2026-02-01T10:00:00.000Z' });
    f.alert(1, { instance_id: 'other' }); f.decision(1, 1, { instance_id: 'other' });
    f.consolidate();
    expect(f.query({ instance: 'default' }).totals).toMatchObject({ alerts: 1, bans: 1, decisions: 0 });
    expect(f.query({ instance: 'default', from: '2026-02-01', to: '2026-02-01' }).totals).toMatchObject({ alerts: 0, bans: 0, decisions: 1 });
    expect(f.query().machines).toHaveLength(2);
  });

  it('keeps simulations separate and canonicalizes IPv6 without counting network ranges', () => {
    const f = fixture(); configureStatisticsCapture(f.source.db, true);
    f.alert(1, { source: { ip: '2001:db8:0:0::1' }, simulated: true });
    f.alert(2, { source: { ip: '2001:db8::1' }, simulated: true });
    f.decision(1, 1, { simulated: true }); f.consolidate();
    expect(f.query({ simulation: 'live' }).totals.alerts).toBe(0);
    expect(f.query({ simulation: 'simulated' }).attackers[0]).toMatchObject({ value: '2001:db8::1', alerts: 2, bans: 1 });
    expect(canonicalStatisticsIP('192.0.2.0/24')).toBe('');
  });

  it('enforces retention immediately and prunes aggregates, identities and coverage', () => {
    const f = fixture(); configureStatisticsCapture(f.source.db, true); f.alert(1); f.consolidate();
    const result = f.store.query({ from: '2026-01-01', to: '2026-02-01', instance: 'all', simulation: 'all', limit: 10 }, 1, ['default'], Date.parse(f.context.now));
    expect(result.totals.alerts).toBe(0);
    expect(result.series[0].alerts).toBeNull();
    f.store.prune('2026-02-01');
    expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM seen').get().n).toBe(0);
    expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM cells').get().n).toBe(0);
  });

  it('does no capture when disabled and still consumes previously pending observations', () => {
    const f = fixture(); f.alert(1);
    expect(readStatisticsBatch(f.source.db, false).rows).toHaveLength(0);
    configureStatisticsCapture(f.source.db, true); f.alert(2);
    configureStatisticsCapture(f.source.db, false); f.alert(3);
    const batch = readStatisticsBatch(f.source.db, false); f.store.consolidate(batch.rows, { ...f.context, enabled: false });
    expect(f.query().totals.alerts).toBe(1);
  });

  it('keeps first-observation dates and metadata even when edited before consolidation', () => {
    const f = fixture(); configureStatisticsCapture(f.source.db, true);
    f.alert(1); f.decision(1, 1);
    f.alert(1, { created_at: '2026-01-20T12:00:00Z', scenario: 'changed' });
    f.decision(1, 1, { created_at: '2026-01-21T12:00:00Z' });
    f.consolidate();
    expect(f.query().totals).toMatchObject({ alerts: 1, decisions: 1, bans: 1 });
    expect(f.query().attackers[0].firstActivity).toBe('2026-01-10T10:00:00.000Z');
  });

  it('attributes late decisions to the first captured parent after its metadata changes', () => {
    const f = fixture(); configureStatisticsCapture(f.source.db, true);
    f.alert(1); f.consolidate();
    f.alert(1, { created_at: '2026-01-20T12:00:00Z', machine_id: 'changed', scenario: 'changed' });
    f.decision(1, 1, { created_at: '2026-01-21T12:00:00Z' }); f.consolidate();
    expect(f.query({ from: '2026-01-10', to: '2026-01-10' }).machines[0]).toMatchObject({ machineId: 'machine-1', bans: 1 });
    expect(f.query({ from: '2026-01-20', to: '2026-01-20' }).totals.bans).toBe(0);
    expect(f.query({ from: '2026-01-21', to: '2026-01-21' }).totals.decisions).toBe(1);
  });

  it('captures an unprocessed parent ahead of decision backfill even when source IDs have different order', () => {
    const f = fixture(); f.alert(9999); f.decision(1, 9999);
    configureStatisticsCapture(f.source.db, true);
    // Use a two-observation page to force parent and decision across batches.
    const first = readStatisticsBatch(f.source.db, true, 2);
    expect(decodeStatisticsObservation(first.rows[0].payload).kind).toBe('alert');
    f.store.consolidate(first.rows, f.context);
    expect(f.query().totals).toMatchObject({ alerts: 1, decisions: 1, bans: 1 });
  });

  it('rolls back identities and aggregates together if a batch fails before commit', () => {
    const f = fixture(); configureStatisticsCapture(f.source.db, true); f.alert(1); f.alert(2);
    const batch = readStatisticsBatch(f.source.db, true);
    const broken = { ...batch.rows[1], payload: JSON.stringify({ kind: 'alert', at: 'invalid' }) };
    expect(() => f.store.consolidate([batch.rows[0], broken], f.context)).toThrow('Invalid statistics observation');
    expect(f.query().totals.alerts).toBe(0);
    expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM seen').get().n).toBe(0);
    f.store.consolidate(batch.rows, f.context);
    expect(f.query().totals.alerts).toBe(2);
  });

  it('leaves gaps after unrecoverable outages and partial imports instead of inventing zeroes', () => {
    const f = fixture();
    f.store.consolidate([], { ...f.context, coverageFrom: { default: '2026-01-01T00:00:00Z' }, now: '2026-01-05T23:59:59.999Z' });
    f.store.consolidate([], { ...f.context, coverageFrom: { default: '2026-01-20T00:00:00Z' }, now: '2026-02-01T12:00:00Z' });
    const result = f.query({ instance: 'default' });
    expect(result.series.find((s) => s.date === '2026-01-03')?.alerts).toBe(0);
    expect(result.series.find((s) => s.date === '2026-01-10')?.alerts).toBeNull();
    expect(result.series.find((s) => s.date === '2026-01-22')?.alerts).toBe(0);
    f.store.consolidate([], { ...f.context, instances: ['other'], coverageFrom: { other: '2026-01-01T00:00:00Z' }, sourceComplete: false });
    expect(f.query({ instance: 'other' }).series.every((s) => s.alerts === null)).toBe(true);
  });

  it('does not retain future-dated source records beyond the configured lifetime', () => {
    const f = fixture(); configureStatisticsCapture(f.source.db, true);
    f.alert(1, { created_at: '2099-01-01T12:00:00Z' }); f.consolidate();
    expect(f.query().totals.alerts).toBe(0);
    expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM seen').get().n).toBe(0);
  });

  it('prunes an expired capture backlog in bounded batches without running consolidation', () => {
    const f = fixture();
    const insert = f.source.db.prepare('INSERT INTO statistics_outbox(identity, day, payload) VALUES (?, ?, ?)');
    f.source.db.transaction(() => { for (let i = 0; i < 600; i++) insert.run(`expired-${i}`, '2025-01-01', '{}'); })();
    insert.run('retained', '2026-02-01', '{}');
    expect(acknowledgeStatisticsBatch(f.source.db, [], '2026-01-01')).toBe(true);
    expect(acknowledgeStatisticsBatch(f.source.db, [], '2026-01-01')).toBe(false);
    expect(f.source.db.prepare('SELECT identity FROM statistics_outbox').all()).toEqual([{ identity: 'retained' }]);
  });

  it('emits each row once: later sync updates and backfill touches do not re-emit captured rows', () => {
    const f = fixture(); configureStatisticsCapture(f.source.db, true);
    f.alert(1); f.decision(1, 1);
    expect(f.consolidate().rows).toHaveLength(2);
    f.alert(1, { scenario: 'edited' }); f.decision(1, 1, { duration: '12h' });
    expect(readStatisticsBatch(f.source.db, true).rows).toHaveLength(0);
  });

  it('counts an alert once when its uuid only becomes known after capture', () => {
    const f = fixture(); configureStatisticsCapture(f.source.db, true);
    f.alert(1, { uuid: 1 }); f.consolidate();
    f.alert(1, { uuid: 'late-uuid' }); f.consolidate();
    expect(f.query().totals.alerts).toBe(1);
  });

  it('gives a decision the same identity whether or not its parent alert is cached', () => {
    const f = fixture(); configureStatisticsCapture(f.source.db, true);
    f.decision(1, 1); f.consolidate();
    f.source.clearSyncData(); f.alert(1); f.decision(1, 1); f.consolidate();
    expect(f.query().totals.decisions).toBe(1);
  });

  it('resumes the backfill cursor when capture is reconfigured at startup', () => {
    const f = fixture(); f.alert(1); f.alert(2);
    const cursor = () => (f.source.db.prepare("SELECT value FROM meta WHERE key = 'statistics_backfill_alerts'").get() as { value: string } | undefined)?.value;
    configureStatisticsCapture(f.source.db, true);
    readStatisticsBatch(f.source.db, true, 2);
    const scanned = cursor();
    expect(Number(scanned)).toBeGreaterThan(0);
    configureStatisticsCapture(f.source.db, true);
    expect(cursor()).toBe(scanned);
    configureStatisticsCapture(f.source.db, false); configureStatisticsCapture(f.source.db, true);
    expect(cursor()).toBe('0');
  });

  it('stops scanning for backfill once it has reached the end of the cache', () => {
    const f = fixture(); f.alert(1);
    const cursor = () => (f.source.db.prepare("SELECT value FROM meta WHERE key = 'statistics_backfill_alerts'").get() as { value: string } | undefined)?.value;
    configureStatisticsCapture(f.source.db, true);
    expect(f.consolidate().backfillPending).toBe(false);
    expect(cursor()).toBe('done');
    f.alert(2);
    expect(f.consolidate().rows).toHaveLength(1);
    expect(cursor()).toBe('done');
    f.source.clearSyncData();
    expect(cursor()).toBeUndefined();
  });

  it('keeps observations from source clocks that run slightly ahead of the server', () => {
    const f = fixture(); configureStatisticsCapture(f.source.db, true);
    f.alert(1, { created_at: '2026-02-02T00:00:03.000Z' }); f.consolidate();
    expect(f.query({ from: '2026-02-02', to: '2026-02-02' }).totals.alerts).toBe(1);
  });

  it('treats the current day as covered while the latest job is recent', () => {
    const f = fixture();
    f.store.consolidate([], { ...f.context, coverageFrom: { default: '2026-01-01T00:00:00Z' }, now: '2026-02-01T11:30:00.000Z' });
    const today = (freshnessMs: number) => f.store.query({ from: '2026-02-01', to: '2026-02-01', instance: 'default', simulation: 'all', limit: 10 }, 365, ['default'], Date.parse('2026-02-01T12:00:00Z'), freshnessMs);
    expect(today(0).coverage.partial).toBe(true);
    expect(today(3_600_000).coverage.partial).toBe(false);
    expect(today(3_600_000).series[0].alerts).toBe(0);
  });
});

describe('hourly activity', () => {
  it('charts ranges within the last two days by hour and older ranges by day', () => {
    const f = fixture(); configureStatisticsCapture(f.source.db, true);
    f.alert(1, { created_at: '2026-01-31T10:15:00.000Z' });
    f.alert(2, { created_at: '2026-01-31T10:45:00.000Z', source: { ip: '1.2.3.5' } });
    f.alert(3, { created_at: '2026-02-01T09:05:00.000Z' });
    f.alert(4, { created_at: '2026-01-20T09:05:00.000Z' });
    f.decision(1, 3, { created_at: '2026-02-01T09:06:00.000Z' });
    f.consolidate();
    const recent = f.query({ from: '2026-01-31', to: '2026-02-01', instance: 'default' });
    expect(recent.granularity).toBe('hour');
    // Through the current hour (12:00 UTC), not the rest of today.
    expect(recent.series).toHaveLength(24 + 13);
    expect(recent.series.find((s) => s.date === '2026-01-31T10:00:00.000Z')).toEqual({ date: '2026-01-31T10:00:00.000Z', alerts: 2, decisions: 0 });
    expect(recent.series.find((s) => s.date === '2026-02-01T09:00:00.000Z')).toMatchObject({ alerts: 1, decisions: 1 });
    expect(recent.series.find((s) => s.date === '2026-02-01T11:00:00.000Z')).toMatchObject({ alerts: 0, decisions: 0 });
    // Hours agree with the daily totals and keep the page filters.
    expect(recent.series.reduce((sum, s) => sum + (s.alerts ?? 0), 0)).toBe(recent.totals.alerts);
    expect(f.query({ from: '2026-01-31', to: '2026-01-31', ip: '1.2.3.5' }).series.filter((s) => s.alerts).map((s) => [s.date, s.alerts])).toEqual([['2026-01-31T10:00:00.000Z', 1]]);
    const older = f.query({ from: '2026-01-19', to: '2026-01-20', instance: 'default' });
    expect(older.granularity).toBe('day');
    expect(older.series.map((s) => s.alerts)).toEqual([0, 1]);
    // Hours older than the kept days are dropped by the next job.
    f.store.consolidate([], { ...f.context, now: '2026-02-03T00:30:00.000Z', cutoff: '2026-01-05' });
    expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM hours').get().n).toBe(0);
  });

  it('keeps daily points for days before an existing archive started recording hours', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'statistics-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'statistics.db');
    const first = new StatisticsStore(file);
    first.db.exec('DROP TABLE hours');
    first.close();
    const upgraded = new StatisticsStore(file);
    cleanups.push(() => upgraded.close());
    const since = upgraded.metadata('hourlySince')!;
    const today = since.slice(0, 10);
    const query = (from: string) => upgraded.query({ from, to: today, instance: 'all', simulation: 'all', limit: 10 }, 90, ['default'], Date.parse(since) + 60_000);
    expect(query(today).granularity).toBe('day');
  });
});

describe('statistics validation', () => {
  it('uses bounded settings and UTC calendar retention', () => {
    expect(validateStatisticsSettings({})).toEqual({ enabled: false, retentionDays: 90, jobInterval: '1h', jobTimeBudget: '30s' });
    for (const value of [{ enabled: 'true' }, { retentionDays: 0 }, { retentionDays: 3651 }, { jobInterval: '1m' }, { jobInterval: '25h' }, { jobTimeBudget: '0s' }, { jobTimeBudget: '61s' }, { jobInterval: '1.5h' }, { bogus: 1 }]) expect(() => validateStatisticsSettings(value)).toThrow();
    expect(statisticsCutoff(1, Date.parse('2026-02-01T23:59:59Z'))).toBe('2026-02-01');
    expect(statisticsCutoff(30, Date.parse('2026-02-01T00:00:00Z'))).toBe('2026-01-03');
  });
});
