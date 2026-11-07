import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CrowdsecDatabase } from '../../database';
import { StatisticsStore, canonicalStatisticsIP, decodeStatisticsObservation, type ConsolidationContext } from '../../statistics-store';
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
  it('captures exact IP/machine/scenario relationships and distinct expired bans', () => {
    const f = fixture(); configureStatisticsCapture(f.source.db, true);
    f.alert(1); f.alert(2); f.alert(3, { scenario: 'http', machine_id: 'machine-2', machine_alias: 'Web' });
    f.alert(4, { source: { value: '192.0.2.0/24' } });
    f.decision(1, 1); f.decision(2, 1); f.decision(3, 3, { type: 'captcha' });
    f.consolidate();
    const result = f.query();
    expect(result.totals).toEqual({ alerts: 4, events: 80, uniqueIPs: 1, bans: 2, decisions: 3, repeatAttackers: 1 });
    expect(result.attackers[0]).toMatchObject({ alerts: 3, bans: 2, machines: 2, activeDays: 2, country: 'DE', asn: '42', network: 'Network' });
    expect(result.attackers[0].scenarios).toEqual([{ label: 'ssh', count: 2 }, { label: 'http', count: 1 }]);
    expect(result.machines[0]).toMatchObject({ alerts: 3, uniqueIPs: 1, bans: 2 });
    expect(result.hours[10]).toBe(4);
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
    expect(f.query().scenarios).toEqual([{ label: 'ssh', count: 1 }]);
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

describe('statistics validation', () => {
  it('uses bounded settings and UTC calendar retention', () => {
    expect(validateStatisticsSettings({})).toEqual({ enabled: false, retentionDays: 365, jobInterval: '1h', jobTimeBudget: '30s' });
    for (const value of [{ enabled: 'true' }, { retentionDays: 0 }, { retentionDays: 3651 }, { jobInterval: '1m' }, { jobInterval: '25h' }, { jobTimeBudget: '0s' }, { jobTimeBudget: '61s' }, { jobInterval: '1.5h' }, { bogus: 1 }]) expect(() => validateStatisticsSettings(value)).toThrow();
    expect(statisticsCutoff(1, Date.parse('2026-02-01T23:59:59Z'))).toBe('2026-02-01');
    expect(statisticsCutoff(30, Date.parse('2026-02-01T00:00:00Z'))).toBe('2026-01-03');
  });
});
