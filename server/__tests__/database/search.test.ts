import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { tmpdir } from 'os';
import { CrowdsecDatabase } from '../../database';
import { decisionFromRow } from '../../normalized-record';
import { createLegacyDatabase, createTestDatabase, createTestDatabasePath, tempDirs } from './harness';

describe('CrowdsecDatabase search', () => {
  test('backfills alert context values into cached search indexes', () => {
    const dbPath = createTestDatabasePath();
    let db = new CrowdsecDatabase({ dbPath });
    const alert = {
      id: 1,
      created_at: '2026-07-22T12:00:00.000Z',
      scenario: 'crowdsecurity/http-bf',
      message: 'legacy cached alert',
      source: { ip: '192.0.2.1' },
      events: [{ meta: [{ key: 'service', value: 'http' }] }],
      meta: [{ key: 'host', value: 'protected.example.test' }],
    };
    db.insertAlert({
      $id: alert.id,
      $uuid: 'alert-1',
      $created_at: alert.created_at,
      $scenario: alert.scenario,
      $source_ip: alert.source.ip,
      $message: alert.message,
      $raw_data: JSON.stringify(alert),
    });
    db.db.prepare("UPDATE alerts SET meta_search = 'http', search_text = 'legacy cached alert http'").run();
    db.db.prepare("UPDATE alerts_fts SET search_text = 'legacy cached alert http' WHERE alert_id = '1'").run();
    db.db.prepare("DELETE FROM meta WHERE key = 'alert_context_search_version'").run();
    db.close();

    db = new CrowdsecDatabase({ dbPath });
    expect(db.db.prepare('SELECT meta_search FROM alerts WHERE id = 1').get()).toEqual({
      meta_search: 'http protected.example.test',
    });
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM alerts_fts WHERE alerts_fts MATCH ?')
      .get('"protected.example.test"') as { count: number }).count).toBe(1);
    db.close();
  });

  test('defers only search indexes when reconciling a populated cache', () => {
    const db = createTestDatabase();
    const insertAlert = (id: number, message: string) => db.insertAlert({
      $id: id,
      $uuid: `cached-alert-${id}`,
      $created_at: '2026-01-01T00:00:00.000Z',
      $scenario: 'crowdsecurity/ssh-bf',
      $source_ip: `192.0.2.${id}`,
      $message: message,
      $raw_data: JSON.stringify({ id, message }),
    });

    insertAlert(1, 'existing searchable alert');
    db.beginDeferredSearchIndexUpdates(false);

    const alertIndexes = db.db.prepare("PRAGMA index_list('alerts')").all() as Array<{ name: string }>;
    const decisionIndexes = db.db.prepare("PRAGMA index_list('decisions')").all() as Array<{ name: string }>;
    expect(alertIndexes.map((index) => index.name)).toContain('idx_alerts_created_at');
    expect(decisionIndexes.map((index) => index.name)).toContain('idx_decisions_alert_summary');
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM alerts_fts').get() as { count: number }).count).toBe(0);

    insertAlert(2, 'new searchable alert');
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM alerts_fts').get() as { count: number }).count).toBe(0);

    db.rebuildSearchIndexes();
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM alerts_fts').get() as { count: number }).count).toBe(2);

    db.close();
  });

  test('rebuilds alert search rows for colliding IDs from every instance', () => {
    const db = createTestDatabase();
    const insertAlert = (instanceId: string, message: string) => db.insertAlert({
      $id: 1,
      $instance_id: instanceId,
      $uuid: 'shared-upstream-uuid',
      $created_at: '2026-01-01T00:00:00.000Z',
      $message: message,
      $record: {
        id: 1,
        uuid: 'shared-upstream-uuid',
        created_at: '2026-01-01T00:00:00.000Z',
        message,
      },
    });

    db.beginDeferredSearchIndexUpdates();
    insertAlert('default', 'primary searchable alert');
    insertAlert('secondary', 'secondary searchable alert');
    db.rebuildSearchIndexes();

    expect((db.db.prepare('SELECT COUNT(*) AS count FROM alerts_fts').get() as { count: number }).count).toBe(2);
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM alerts_fts WHERE alerts_fts MATCH ?').get('primary') as { count: number }).count).toBe(1);
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM alerts_fts WHERE alerts_fts MATCH ?').get('secondary') as { count: number }).count).toBe(1);
    expect((db.db.prepare('SELECT rowid FROM alerts_fts ORDER BY rowid').all() as Array<{ rowid: number }>)).toEqual([
      { rowid: -1 },
      { rowid: 1 },
    ]);

    db.close();
  });

  test('rebuilds only touched search rows after a large populated-cache delta', () => {
    const db = createTestDatabase();
    const insertAlert = (id: number, message: string) => db.insertAlert({
      $id: id,
      $uuid: `alert-${id}`,
      $created_at: '2026-01-01T00:00:00.000Z',
      $scenario: 'crowdsecurity/ssh-bf',
      $source_ip: `192.0.2.${id}`,
      $message: message,
      $raw_data: JSON.stringify({ id, message }),
    });
    const insertDecision = (id: string, alertId: number, origin: string) => db.insertDecision({
      $id: id,
      $uuid: `decision-${id}`,
      $alert_id: alertId,
      $created_at: '2026-01-01T00:00:00.000Z',
      $stop_at: '2027-01-01T00:00:00.000Z',
      $value: `198.51.100.${id}`,
      $type: 'ban',
      $origin: origin,
      $scenario: 'crowdsecurity/ssh-bf',
      $raw_data: JSON.stringify({ id, alert_id: alertId, origin }),
    });

    insertAlert(1, 'old touched alert');
    insertAlert(2, 'preserved untouched alert');
    insertAlert(4, 'other untouched alert');
    insertDecision('10', 1, 'old-touched-origin');
    insertDecision('20', 2, 'removed-origin');
    insertDecision('40', 4, 'preserved-origin');

    db.beginDeferredSearchIndexUpdates(false, false);
    insertAlert(1, 'new touched alert');
    insertAlert(3, 'new delta alert');
    insertDecision('10', 1, 'new-touched-origin');
    insertDecision('30', 3, 'new-delta-origin');
    db.deleteDecision('20');
    db.rebuildSearchIndexes({ alertIds: [1, 3], decisionIds: ['10', '20', '30'] });

    expect((db.db.prepare('SELECT COUNT(*) AS count FROM alerts_fts').get() as { count: number }).count).toBe(4);
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM decisions_fts').get() as { count: number }).count).toBe(3);
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM decision_fts_rows').get() as { count: number }).count).toBe(3);
    expect((db.db.prepare(`
      SELECT COUNT(*) AS count
      FROM decision_fts_rows AS search_rows
      JOIN decisions_fts ON decisions_fts.rowid = search_rows.fts_rowid
      WHERE decisions_fts.decision_id = search_rows.decision_id
    `).get() as { count: number }).count).toBe(3);
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM alerts_fts WHERE alerts_fts MATCH ?').get('old') as { count: number }).count).toBe(0);
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM alerts_fts WHERE alerts_fts MATCH ?').get('new') as { count: number }).count).toBe(2);
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM alerts_fts WHERE alerts_fts MATCH ?').get('preserved') as { count: number }).count).toBe(1);
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM decisions_fts WHERE decisions_fts MATCH ?').get('old') as { count: number }).count).toBe(0);
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM decisions_fts WHERE decisions_fts MATCH ?').get('new') as { count: number }).count).toBe(2);
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM decisions_fts WHERE decisions_fts MATCH ?').get('preserved') as { count: number }).count).toBe(1);
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM decisions_fts WHERE decisions_fts MATCH ?').get('removed') as { count: number }).count).toBe(0);

    db.close();
  });

  test('adds rowid mappings for an existing decision search index', () => {
    const dbPath = createTestDatabasePath();
    let db = new CrowdsecDatabase({ dbPath });
    db.insertDecision({
      $id: 'legacy-search-row',
      $uuid: 'legacy-search-row',
      $alert_id: 1,
      $created_at: '2026-01-01T00:00:00.000Z',
      $stop_at: '2027-01-01T00:00:00.000Z',
      $value: '198.51.100.1',
      $type: 'ban',
      $origin: 'lists',
      $scenario: 'crowdsecurity/ssh-bf',
      $raw_data: JSON.stringify({ id: 'legacy-search-row' }),
    });
    db.db.exec('DROP TABLE decision_fts_rows');
    db.close();

    db = new CrowdsecDatabase({ dbPath });
    expect(db.db.prepare(`
      SELECT search_rows.decision_id
      FROM decision_fts_rows AS search_rows
      JOIN decisions_fts ON decisions_fts.rowid = search_rows.fts_rowid
    `).all()).toEqual([{ decision_id: 'legacy-search-row' }]);
    db.close();
  });

  test('migrates legacy search indexes to trigram substring indexes', () => {
    const dbPath = createTestDatabasePath();
    let db = new CrowdsecDatabase({ dbPath });
    db.insertAlert({
      $id: 1,
      $uuid: 'legacy-search-alert',
      $created_at: '2026-01-01T00:00:00.000Z',
      $scenario: 'crowdsecurity/netgear_rce',
      $source_ip: '198.51.100.42',
      $message: 'legacy search alert',
      $raw_data: JSON.stringify({ id: 1, scenario: 'crowdsecurity/netgear_rce' }),
    });
    db.close();

    const legacy = new Database(dbPath);
    legacy.exec(`
      DROP TABLE alerts_fts;
      DROP TABLE decisions_fts;
      DROP TABLE decision_fts_rows;
      CREATE VIRTUAL TABLE alerts_fts USING fts5(alert_id UNINDEXED, search_text, tokenize = 'unicode61');
      CREATE VIRTUAL TABLE decisions_fts USING fts5(decision_id UNINDEXED, search_text, tokenize = 'unicode61');
      CREATE TABLE decision_fts_rows(decision_id TEXT PRIMARY KEY, fts_rowid INTEGER NOT NULL UNIQUE);
    `);
    legacy.close();

    db = new CrowdsecDatabase({ dbPath });
    const definition = db.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'alerts_fts'").get() as { sql: string };
    expect(definition.sql).toMatch(/tokenize\s*=\s*'trigram'/i);
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM alerts_fts WHERE alerts_fts MATCH ?').get('gear_r') as { count: number }).count).toBe(1);
    db.close();
  });

});
