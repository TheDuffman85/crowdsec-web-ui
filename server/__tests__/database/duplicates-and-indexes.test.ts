import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { tmpdir } from 'os';
import { CrowdsecDatabase } from '../../database';
import { decisionFromRow } from '../../normalized-record';
import { createLegacyDatabase, createTestDatabase, createTestDatabasePath, tempDirs } from './harness';

describe('CrowdsecDatabase duplicates and indexes', () => {
  test('transaction helper batches work', () => {
    const db = createTestDatabase();
    const insertMany = db.transaction<Array<number>>((ids) => {
      for (const id of ids) {
        db.insertAlert({
          $id: id,
          $uuid: `alert-${id}`,
          $created_at: '2025-01-01T00:00:00.000Z',
          $scenario: 'scenario',
          $source_ip: '1.2.3.4',
          $message: 'alert',
          $raw_data: JSON.stringify({ id }),
        });
      }
    });

    insertMany([1, 2, 3]);
    expect(db.countAlerts()).toBe(3);
    db.close();
  });

  test('treats unchanged sync upserts as no-ops', () => {
    const db = createTestDatabase();
    const alert = {
      $id: 1,
      $uuid: 'alert-1',
      $created_at: '2025-01-01T00:00:00.000Z',
      $scenario: 'crowdsecurity/ssh-bf',
      $source_ip: '1.2.3.4',
      $message: 'alert',
      $raw_data: JSON.stringify({ id: 1, message: 'alert' }),
    };
    const decision = {
      $id: '10',
      $uuid: '10',
      $alert_id: 1,
      $created_at: '2025-01-01T00:00:00.000Z',
      $stop_at: '2030-01-01T00:00:00.000Z',
      $value: '1.2.3.4',
      $type: 'ban',
      $origin: 'manual',
      $scenario: 'crowdsecurity/ssh-bf',
      $raw_data: JSON.stringify({ id: 10, value: '1.2.3.4', stop_at: '2030-01-01T00:00:00.000Z' }),
    };

    expect(db.insertAlert(alert)).toBe(true);
    expect(db.insertDecision(decision)).toBe(true);
    db.db.prepare('UPDATE decisions SET is_duplicate = 1 WHERE id = ?').run('10');

    expect(db.insertAlert(alert)).toBe(false);
    expect(db.insertDecision(decision)).toBe(false);
    expect((db.db.prepare('SELECT is_duplicate FROM decisions WHERE id = ?').get('10') as { is_duplicate: number }).is_duplicate).toBe(1);
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM alerts_fts').get() as { count: number }).count).toBe(1);
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM decisions_fts').get() as { count: number }).count).toBe(1);

    expect(db.insertAlert({ ...alert, $message: 'updated', $raw_data: JSON.stringify({ id: 1, message: 'updated' }) })).toBe(true);
    expect(db.insertDecision({ ...decision, $stop_at: '2031-01-01T00:00:00.000Z' })).toBe(true);
    expect((db.db.prepare('SELECT is_duplicate FROM decisions WHERE id = ?').get('10') as { is_duplicate: number }).is_duplicate).toBe(0);

    db.close();
  });

  test('updates duplicate flags differentially and skips unchanged rows', () => {
    const db = createTestDatabase();
    const insertDecision = (id: string, stopAt: string) => db.insertDecision({
      $id: id,
      $uuid: id,
      $alert_id: 1,
      $created_at: '2026-01-01T00:00:00.000Z',
      $stop_at: stopAt,
      $value: '1.2.3.4',
      $type: 'ban',
      $origin: 'crowdsec',
      $scenario: 'crowdsecurity/ssh-bf',
      $raw_data: JSON.stringify({ id, value: '1.2.3.4', stop_at: stopAt }),
    });

    insertDecision('10', '2030-01-03T00:00:00.000Z');
    insertDecision('11', '2030-01-02T00:00:00.000Z');
    insertDecision('12', '2030-01-01T00:00:00.000Z');

    expect(db.refreshDecisionDuplicateFlags('2029-01-01T00:00:00.000Z')).toBe(2);
    expect(db.db.prepare('SELECT id, is_duplicate FROM decisions ORDER BY id').all()).toEqual([
      { id: '10', is_duplicate: 0 },
      { id: '11', is_duplicate: 1 },
      { id: '12', is_duplicate: 1 },
    ]);
    expect(db.refreshDecisionDuplicateFlags('2029-01-01T00:00:00.000Z', true)).toBe(0);

    db.deleteDecision('10');
    expect(db.refreshDecisionDuplicateFlags('2029-01-01T00:00:00.000Z')).toBe(1);
    expect(db.db.prepare('SELECT id, is_duplicate FROM decisions ORDER BY id').all()).toEqual([
      { id: '11', is_duplicate: 0 },
      { id: '12', is_duplicate: 1 },
    ]);

    db.close();
  });

  test('keeps the newest decision visible when duplicate expirations are equal', () => {
    const db = createTestDatabase();
    const insertDecision = (id: string) => db.insertDecision({
      $id: id,
      $uuid: id,
      $alert_id: 1,
      $created_at: '2026-01-01T00:00:00.000Z',
      $stop_at: '2030-01-03T00:00:00.000Z',
      $value: '1.2.3.4',
      $type: 'ban',
      $origin: 'crowdsec',
      $scenario: 'crowdsecurity/ssh-bf',
      $raw_data: JSON.stringify({ id, value: '1.2.3.4', stop_at: '2030-01-03T00:00:00.000Z' }),
    });

    insertDecision('10');
    insertDecision('12');

    expect(db.refreshDecisionDuplicateFlags('2029-01-01T00:00:00.000Z')).toBe(1);
    expect(db.db.prepare('SELECT id, is_duplicate FROM decisions ORDER BY id').all()).toEqual([
      { id: '10', is_duplicate: 1 },
      { id: '12', is_duplicate: 0 },
    ]);

    db.close();
  });

  test('rebuilds persisted duplicate flags after the ranking algorithm changes', () => {
    const dbPath = createTestDatabasePath();
    let db = new CrowdsecDatabase({ dbPath });
    const insertDecision = (id: string) => db.insertDecision({
      $id: id,
      $uuid: id,
      $alert_id: 1,
      $created_at: '2026-01-01T00:00:00.000Z',
      $stop_at: '2030-01-03T00:00:00.000Z',
      $value: '1.2.3.4',
      $type: 'ban',
      $origin: 'crowdsec',
      $scenario: 'crowdsecurity/ssh-bf',
      $raw_data: JSON.stringify({ id, value: '1.2.3.4', stop_at: '2030-01-03T00:00:00.000Z' }),
    });

    insertDecision('10');
    insertDecision('12');
    db.refreshDecisionDuplicateFlags('2029-01-01T00:00:00.000Z');
    db.db.prepare("UPDATE decisions SET is_duplicate = CASE id WHEN '10' THEN 0 ELSE 1 END").run();
    db.db.prepare("DELETE FROM meta WHERE key = 'decision_duplicate_rank_version'").run();
    db.close();

    db = new CrowdsecDatabase({ dbPath });
    expect(db.refreshDecisionDuplicateFlags('2029-01-01T00:01:00.000Z')).toBe(2);
    expect(db.db.prepare('SELECT id, is_duplicate FROM decisions ORDER BY id').all()).toEqual([
      { id: '10', is_duplicate: 1 },
      { id: '12', is_duplicate: 0 },
    ]);

    db.close();
  });

  test('refreshes many independent duplicate groups without multiplying the decisions scan', () => {
    const db = createTestDatabase();
    const insertRange = db.transaction(({ start, count }: { start: number; count: number }) => {
      for (let index = start; index < start + count; index += 1) {
        const id = String(index);
        const value = `198.51.${Math.floor(index / 256) % 256}.${index % 256}`;
        db.insertDecision({
          $id: id,
          $uuid: id,
          $alert_id: 1,
          $created_at: '2026-01-01T00:00:00.000Z',
          $stop_at: '2030-01-01T00:00:00.000Z',
          $value: value,
          $type: 'ban',
          $origin: 'lists',
          $scenario: 'crowdsecurity/blocklist-import',
          $raw_data: JSON.stringify({ id, value, stop_at: '2030-01-01T00:00:00.000Z' }),
        });
      }
    });

    insertRange({ start: 1, count: 2_000 });
    expect(db.refreshDecisionDuplicateFlags('2029-01-01T00:00:00.000Z')).toBe(0);
    insertRange({ start: 2_001, count: 2_000 });
    expect(db.refreshDecisionDuplicateFlags('2029-01-01T00:00:01.000Z')).toBe(0);
    expect(db.getMeta('decision_duplicate_flags_dirty')?.value).toBe('false');

    db.close();
  });

  test('deleting retained expired decisions does not dirty active duplicate flags', () => {
    const db = createTestDatabase();
    const insertDecision = (id: string, stopAt: string) => db.insertDecision({
      $id: id,
      $uuid: id,
      $alert_id: 1,
      $created_at: '2026-01-01T00:00:00.000Z',
      $stop_at: stopAt,
      $value: '1.2.3.4',
      $type: 'ban',
      $origin: 'crowdsec',
      $scenario: 'crowdsecurity/ssh-bf',
      $raw_data: JSON.stringify({ id, value: '1.2.3.4', stop_at: stopAt }),
    });

    insertDecision('expired', '2025-01-01T00:00:00.000Z');
    insertDecision('active-1', '2030-01-03T00:00:00.000Z');
    insertDecision('active-2', '2030-01-02T00:00:00.000Z');
    expect(db.refreshDecisionDuplicateFlags('2029-01-01T00:00:00.000Z')).toBe(1);
    expect(db.getMeta('decision_duplicate_flags_dirty')?.value).toBe('false');

    expect(db.deleteOldDecisions('2026-01-01T00:00:00.000Z')).toBe(1);
    expect(db.getMeta('decision_duplicate_flags_dirty')?.value).toBe('false');
    expect(db.refreshDecisionDuplicateFlags('2029-01-01T00:00:00.000Z')).toBe(0);
    expect(db.db.prepare('SELECT id, is_duplicate FROM decisions ORDER BY id').all()).toEqual([
      { id: 'active-1', is_duplicate: 0 },
      { id: 'active-2', is_duplicate: 1 },
    ]);
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM decisions_fts').get() as { count: number }).count).toBe(2);

    db.close();
  });

  test('defers alert and decision secondary indexes until bulk import completes', () => {
    const db = createTestDatabase();

    db.beginDeferredSearchIndexUpdates();
    const alertIndexesDuringImport = db.db.prepare("PRAGMA index_list('alerts')").all() as Array<{ name: string }>;
    const decisionIndexesDuringImport = db.db.prepare("PRAGMA index_list('decisions')").all() as Array<{ name: string }>;
    expect(alertIndexesDuringImport.every((index) => index.name.startsWith('sqlite_autoindex_'))).toBe(true);
    expect(decisionIndexesDuringImport.every((index) => index.name.startsWith('sqlite_autoindex_'))).toBe(true);

    db.insertAlert({
      $id: 1,
      $uuid: 'deferred-alert',
      $created_at: '2026-01-01T00:00:00.000Z',
      $scenario: 'crowdsecurity/ssh-bf',
      $source_ip: '1.2.3.4',
      $message: 'deferred searchable alert',
      $raw_data: JSON.stringify({ id: 1, message: 'deferred searchable alert' }),
    });
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM alerts_fts').get() as { count: number }).count).toBe(0);

    db.rebuildSearchIndexes();
    const rebuiltAlertIndexes = db.db.prepare("PRAGMA index_list('alerts')").all() as Array<{ name: string }>;
    const rebuiltDecisionIndexes = db.db.prepare("PRAGMA index_list('decisions')").all() as Array<{ name: string }>;
    expect(rebuiltAlertIndexes.map((index) => index.name)).toContain('idx_alerts_created_at');
    expect(rebuiltAlertIndexes.map((index) => index.name)).toContain('idx_alerts_filters');
    expect(rebuiltDecisionIndexes.map((index) => index.name)).toContain('idx_decisions_stop_alert_id');
    expect(rebuiltDecisionIndexes.map((index) => index.name)).toContain('idx_decisions_alert_created_id');
    expect(rebuiltDecisionIndexes.map((index) => index.name)).toContain('idx_decisions_alert_summary');
    expect(
      (db.db.prepare("PRAGMA index_info('idx_decisions_alert_created_id')").all() as Array<{ name: string }>).map((column) => column.name),
    ).toEqual(['alert_id', 'created_at', 'id', 'stop_at']);
    const alertDecisionPagingPlan = db.db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT raw_data
      FROM decisions
      WHERE (created_at >= ? OR stop_at > ?) AND alert_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all('2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', 1, 50, 0) as Array<{ detail: string }>;
    expect(alertDecisionPagingPlan.map((step) => step.detail).join('\n')).toContain(
      'USING INDEX idx_decisions_alert_created_id (alert_id=?)',
    );
    expect(alertDecisionPagingPlan.map((step) => step.detail).join('\n')).not.toContain('USE TEMP B-TREE');
    expect(
      (db.db.prepare("PRAGMA index_info('idx_decisions_alert_summary')").all() as Array<{ name: string }>).map((column) => column.name),
    ).toEqual(['alert_id', 'origin', 'simulated', 'stop_at']);
    const alertDecisionSummaryPlan = db.db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT alert_id, origin, simulated,
        SUM(CASE WHEN stop_at > ? THEN 1 ELSE 0 END) AS active_count,
        SUM(CASE WHEN stop_at <= ? THEN 1 ELSE 0 END) AS expired_count
      FROM decisions INDEXED BY idx_decisions_alert_summary
      WHERE alert_id IN (?, ?)
      GROUP BY alert_id, origin, simulated
    `).all(
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      1,
      2,
    ) as Array<{ detail: string }>;
    expect(alertDecisionSummaryPlan.map((step) => step.detail).join('\n')).toContain(
      'USING COVERING INDEX idx_decisions_alert_summary (alert_id=?)',
    );
    expect(alertDecisionSummaryPlan.map((step) => step.detail).join('\n')).not.toContain('USE TEMP B-TREE');
    expect(
      (db.db.prepare("PRAGMA index_info('idx_alerts_filters')").all() as Array<{ name: string }>).map((column) => column.name),
    ).toEqual([
      'instance_id', 'country', 'scenario', 'as_name', 'source_ip', 'target', 'country_name',
      'region', 'city', 'machine', 'origins', 'message', 'upstream_id', 'simulated', 'created_at', 'id',
    ]);
    const filteredAlertCountPlan = db.db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT COUNT(*)
      FROM alerts INDEXED BY idx_alerts_filters
      WHERE instance_id = ?
        AND country IN (?, ?)
        AND COALESCE(LOWER(scenario), '') LIKE ?
    `).all('default', 'DE', 'NL', '%crowdsecurity/http-probing%') as Array<{ detail: string }>;
    expect(filteredAlertCountPlan.map((step) => step.detail).join('\n')).toContain(
      'USING COVERING INDEX idx_alerts_filters (instance_id=? AND country=?)',
    );
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM alerts_fts WHERE alerts_fts MATCH ?').get('deferred') as { count: number }).count).toBe(1);

    db.close();
  });

});
