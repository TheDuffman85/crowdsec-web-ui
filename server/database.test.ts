import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { tmpdir } from 'os';
import { CrowdsecDatabase } from './database';
import { decisionFromRow } from './normalized-record';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createTestDatabase(): CrowdsecDatabase {
  const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-'));
  tempDirs.push(dir);
  return new CrowdsecDatabase({ dbPath: path.join(dir, 'test.db') });
}

function createTestDatabasePath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-'));
  tempDirs.push(dir);
  return path.join(dir, 'test.db');
}

function createLegacyDatabase(dbPath: string): { exec: (sql: string) => unknown; close: () => void; query: (sql: string) => { run: (...params: any[]) => unknown }; prepare: (sql: string) => { run: (...params: any[]) => unknown } } {
  const database = new Database(dbPath) as {
    exec: (sql: string) => unknown;
    close: () => void;
    prepare: (sql: string) => { run: (...params: any[]) => unknown };
    query: (sql: string) => { run: (...params: any[]) => unknown };
  };
  database.query = (sql: string) => {
    const statement = database.prepare(sql);
    return {
      run: (...params: any[]) => statement.run(...params.map((value) => {
        if (!value || Array.isArray(value) || typeof value !== 'object') {
          return value;
        }
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key.replace(/^[$:@]/, ''), entry]),
        );
      })),
    };
  };
  return database;
}

describe('CrowdsecDatabase', () => {
  test('isolates colliding upstream alert, decision, and UUID identities by instance', () => {
    const db = createTestDatabase();
    db.setMeta('multi_instance_primary_id', 'primary');
    for (const instanceId of ['primary', 'secondary']) {
      expect(db.insertAlert({
        $id: 1,
        $instance_id: instanceId,
        $uuid: 'same-alert-uuid',
        $created_at: '2026-07-19T10:00:00.000Z',
        $scenario: 'crowdsecurity/ssh-bf',
        $source_ip: instanceId === 'primary' ? '1.1.1.1' : '2.2.2.2',
        $message: instanceId,
        $raw_data: JSON.stringify({ id: 1, uuid: 'same-alert-uuid' }),
      })).toBe(true);
      expect(db.insertDecision({
        $id: '1',
        $instance_id: instanceId,
        $uuid: 'same-decision-uuid',
        $alert_id: 1,
        $created_at: '2026-07-19T10:00:00.000Z',
        $stop_at: '2026-07-20T10:00:00.000Z',
        $value: '3.3.3.3',
        $type: 'ban',
        $origin: 'crowdsec',
        $scenario: 'crowdsecurity/ssh-bf',
        $raw_data: JSON.stringify({ id: 1, alert_id: 1 }),
      })).toBe(true);
    }

    expect(db.countAlerts()).toBe(2);
    expect(db.countDecisions()).toBe(2);
    expect(db.getAlertInternalId('primary', 1)).not.toBe(db.getAlertInternalId('secondary', 1));
    expect(db.getDecisionInternalId('primary', 1)).not.toBe(db.getDecisionInternalId('secondary', 1));
    db.refreshDecisionDuplicateFlags('2026-07-19T11:00:00.000Z', true);
    const duplicateFlags = db.db.prepare('SELECT instance_id, is_duplicate FROM decisions ORDER BY instance_id').all() as Array<{ instance_id: string; is_duplicate: number }>;
    expect(duplicateFlags).toEqual([
      { instance_id: 'primary', is_duplicate: 0 },
      { instance_id: 'secondary', is_duplicate: 0 },
    ]);
    db.deleteDecisionByInstanceId('secondary', 1);
    db.deleteAlertByInstanceId('secondary', 1);
    expect(db.countAlerts()).toBe(1);
    expect(db.countDecisions()).toBe(1);
    db.close();
  });

  test('replaces legacy global UUID constraints with per-instance constraints', () => {
    const dbPath = createTestDatabasePath();
    const legacy = createLegacyDatabase(dbPath);
    legacy.exec(`
      CREATE TABLE alerts (
        id INTEGER PRIMARY KEY,
        uuid TEXT UNIQUE,
        created_at TEXT NOT NULL,
        scenario TEXT,
        source_ip TEXT,
        message TEXT,
        raw_data TEXT
      );
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY,
        uuid TEXT UNIQUE,
        alert_id INTEGER,
        created_at TEXT NOT NULL,
        stop_at TEXT NOT NULL,
        value TEXT,
        type TEXT,
        origin TEXT,
        scenario TEXT,
        raw_data TEXT
      );
      INSERT INTO alerts (id, uuid, created_at, scenario, source_ip, message, raw_data)
      VALUES (
        1,
        'same-alert-uuid',
        '2026-07-19T10:00:00.000Z',
        'crowdsecurity/ssh-bf',
        '1.1.1.1',
        'default',
        '{"id":1,"uuid":"same-alert-uuid"}'
      );
      INSERT INTO decisions (id, uuid, alert_id, created_at, stop_at, value, type, origin, scenario, raw_data)
      VALUES (
        '1',
        'same-decision-uuid',
        1,
        '2026-07-19T10:00:00.000Z',
        '2026-07-20T10:00:00.000Z',
        '3.3.3.3',
        'ban',
        'crowdsec',
        'crowdsecurity/ssh-bf',
        '{"id":1,"uuid":"same-decision-uuid","alert_id":1}'
      );
    `);
    legacy.close();

    const db = new CrowdsecDatabase({ dbPath });

    expect(db.insertAlert({
      $id: 1,
      $instance_id: 'secondary',
      $uuid: 'same-alert-uuid',
      $created_at: '2026-07-19T10:00:00.000Z',
      $scenario: 'crowdsecurity/ssh-bf',
      $source_ip: '2.2.2.2',
      $message: 'secondary',
      $raw_data: JSON.stringify({ id: 1, uuid: 'same-alert-uuid' }),
    })).toBe(true);
    expect(db.insertDecision({
      $id: '1',
      $instance_id: 'secondary',
      $uuid: 'same-decision-uuid',
      $alert_id: 1,
      $created_at: '2026-07-19T10:00:00.000Z',
      $stop_at: '2026-07-20T10:00:00.000Z',
      $value: '3.3.3.3',
      $type: 'ban',
      $origin: 'crowdsec',
      $scenario: 'crowdsecurity/ssh-bf',
      $raw_data: JSON.stringify({ id: 1, uuid: 'same-decision-uuid', alert_id: 1 }),
    })).toBe(true);

    expect(db.countAlerts()).toBe(2);
    expect(db.countDecisions()).toBe(2);
    expect(db.getAlertInternalId('default', 1)).not.toBe(db.getAlertInternalId('secondary', 1));
    expect(db.getDecisionInternalId('default', 1)).not.toBe(db.getDecisionInternalId('secondary', 1));
    db.close();
  });

  test('persists alert deletion tombstones and blocks sync from restoring queued records', () => {
    const dbPath = createTestDatabasePath();
    const original = new CrowdsecDatabase({ dbPath });
    const alert = {
      $id: 1,
      $uuid: 'alert-1',
      $created_at: '2025-01-01T00:00:00.000Z',
      $scenario: 'crowdsecurity/ssh-bf',
      $source_ip: '1.2.3.4',
      $message: 'alert',
      $raw_data: JSON.stringify({ id: 1 }),
    };
    const decision = {
      $id: '10',
      $uuid: 'decision-10',
      $alert_id: 1,
      $created_at: '2025-01-01T00:00:00.000Z',
      $stop_at: '2030-01-01T00:00:00.000Z',
      $value: '1.2.3.4',
      $type: 'ban',
      $origin: 'manual',
      $scenario: 'crowdsecurity/ssh-bf',
      $raw_data: JSON.stringify({ id: 10, alert_id: 1 }),
    };
    original.insertAlert(alert);
    original.insertDecision(decision);

    const requestedAt = '2026-07-15T12:00:00.000Z';
    const queue = original.transaction(() => {
      original.queueAlertDeletion(1, ['10'], requestedAt);
      original.deleteDecisionsByAlertId(1);
      original.deleteAlert(1);
    });
    queue(undefined);
    original.close();

    const reopened = new CrowdsecDatabase({ dbPath });
    expect(reopened.getAlertDeletionTombstone(1)).toEqual(expect.objectContaining({
      alert_id: '1',
      decision_ids_json: '["10"]',
      requested_at: requestedAt,
      completed_at: null,
    }));
    expect(reopened.insertAlert(alert)).toBe(false);
    expect(reopened.insertDecision(decision)).toBe(false);
    expect(reopened.countAlerts()).toBe(0);
    expect(reopened.countDecisions()).toBe(0);
    reopened.close();
  });

  test('stores alerts, decisions, and metadata', () => {
    const db = createTestDatabase();

    db.insertAlert({
      $id: 1,
      $uuid: 'alert-1',
      $created_at: '2025-01-01T00:00:00.000Z',
      $scenario: 'crowdsecurity/ssh-bf',
      $source_ip: '1.2.3.4',
      $message: 'alert',
      $raw_data: JSON.stringify({ id: 1, source: { latitude: '52.52', longitude: 13.405 } }),
    });

    db.insertDecision({
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
    });

    db.setMeta('refresh_interval_ms', '5000');

    expect(db.countAlerts()).toBe(1);
    expect(db.searchIndexAvailable).toBe(true);
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM alerts_fts WHERE alerts_fts MATCH ?').get('alert') as { count: number }).count).toBe(1);
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM alerts_fts WHERE alerts_fts MATCH ?').get('ler') as { count: number }).count).toBe(1);
    expect(db.getAlertsSince('2024-12-31T00:00:00.000Z')).toHaveLength(1);
    expect(db.getActiveDecisions('2025-01-01T00:00:00.000Z')).toHaveLength(1);
    expect(db.getDecisionById('10')?.stop_at).toBe('2030-01-01T00:00:00.000Z');
    expect(db.getDecisionStopAtBatch(['10', 'missing'])).toEqual(
      new Map([['10', '2030-01-01T00:00:00.000Z']]),
    );
    expect(db.getMeta('refresh_interval_ms')?.value).toBe('5000');
    expect(db.getAlertsBetween('2024-12-31T00:00:00.000Z', '2025-01-02T00:00:00.000Z')).toHaveLength(1);
    expect(db.getAlertDecisionSnapshot(1)).toEqual({
      raw_data: expect.any(String),
      metadata_hash: expect.any(String),
      decision_count: 1,
      origins: null,
      simulated: 0,
    });
    expect(db.getAlertDecisionSnapshot('missing')).toBeNull();
    expect(db.db.prepare('SELECT latitude, longitude FROM alerts WHERE id = 1').get()).toEqual({
      latitude: 52.52,
      longitude: 13.405,
    });

    db.deleteDecision('10');
    db.deleteAlert(1);
    expect(db.getActiveDecisions('2025-01-01T00:00:00.000Z')).toHaveLength(0);
    expect(db.countAlerts()).toBe(0);

    db.close();
  });

  test('only excludes the literal dup_ prefix when selecting an active decision', () => {
    const db = createTestDatabase();
    const insert = (id: string, stopAt: string) => db.insertDecision({
      $id: id,
      $uuid: id,
      $alert_id: 1,
      $created_at: '2026-01-01T00:00:00.000Z',
      $stop_at: stopAt,
      $value: '198.51.100.42',
      $type: 'ban',
      $origin: 'crowdsec',
      $scenario: 'crowdsecurity/test',
      $raw_data: JSON.stringify({ id, value: '198.51.100.42', stop_at: stopAt }),
    });
    insert('real', '2027-01-02T00:00:00.000Z');
    insert('dup_1', '2027-01-04T00:00:00.000Z');
    insert('dupX1', '2027-01-03T00:00:00.000Z');

    expect(db.getActiveDecisionByValue('198.51.100.42', '2026-01-01T00:00:00.000Z')?.id).toBe('dupX1');
    db.close();
  });

  test('stores CrowdSec timestamps in a lexically sortable UTC format', () => {
    const db = createTestDatabase();

    db.insertAlert({
      $id: 1,
      $uuid: 'offset-alert',
      $created_at: '2026-07-14T08:56:33-04:00',
      $message: 'offset alert',
      $raw_data: JSON.stringify({
        id: 1,
        created_at: '2026-07-14T08:56:33-04:00',
        start_at: '2026-07-14T08:55:00-04:00',
      }),
    });
    db.insertDecision({
      $id: '10',
      $uuid: 'offset-decision',
      $alert_id: 1,
      $created_at: '2026-07-14T08:56:33-04:00',
      $stop_at: '2026-07-14T10:00:00-04:00',
      $value: '1.2.3.4',
      $type: 'ban',
      $origin: 'crowdsec',
      $scenario: 'crowdsecurity/ssh-bf',
      $raw_data: JSON.stringify({
        id: 10,
        created_at: '2026-07-14T08:56:33-04:00',
        stop_at: '2026-07-14T10:00:00-04:00',
      }),
    });

    expect(db.getAlertsSince('2026-07-14T12:00:00.000Z')).toHaveLength(1);
    expect(db.getActiveDecisions('2026-07-14T13:00:00.000Z')).toHaveLength(1);
    expect(db.db.prepare('SELECT created_at FROM alerts WHERE id = 1').get()).toEqual({
      created_at: '2026-07-14T12:55:00.000Z',
    });
    expect(db.db.prepare('SELECT created_at, stop_at, raw_data FROM decisions WHERE id = ?').get('10')).toEqual({
      created_at: '2026-07-14T12:56:33.000Z',
      stop_at: '2026-07-14T14:00:00.000Z',
      raw_data: null,
    });

    db.close();
  });

  test('normalizes CrowdSec records and retains only unknown extensions as JSON', () => {
    const db = createTestDatabase();
    const createdAt = '2026-07-17T08:00:00.000Z';
    const alert = {
      id: 42,
      uuid: 'alert-42',
      created_at: createdAt,
      scenario: 'crowdsecurity/ssh-bf',
      kind: 'capi',
      source: { ip: '192.0.2.42', scope: 'ip', provider: 'example' },
      events: [{ timestamp: createdAt, meta: [{ key: 'service', value: 'ssh' }] }],
      decisions: [{ id: 420 }],
      simulated: false,
    };
    db.insertAlert({
      $id: alert.id,
      $uuid: alert.uuid,
      $created_at: alert.created_at,
      $scenario: alert.scenario,
      $source_ip: alert.source.ip,
      $message: '',
      $record: alert,
    });
    const decision = {
      id: 420,
      alert_id: 42,
      created_at: createdAt,
      stop_at: '2026-07-18T08:00:00.000Z',
      value: '192.0.2.42',
      type: 'ban',
      scope: 'ip',
      remediation: 'custom-extension',
      simulated: false,
    };
    db.insertDecision({
      $id: '420',
      $uuid: '420',
      $alert_id: 42,
      $created_at: decision.created_at,
      $stop_at: decision.stop_at,
      $value: decision.value,
      $type: decision.type,
      $record: decision,
    });

    const storedAlert = db.db.prepare('SELECT raw_data, extra_data, source_extra_data FROM alerts WHERE id = 42').get() as {
      raw_data: string | null;
      extra_data: string;
      source_extra_data: string;
    };
    expect(storedAlert.raw_data).toBeNull();
    expect(JSON.parse(storedAlert.extra_data)).toEqual({ kind: 'capi', events: alert.events });
    expect(JSON.parse(storedAlert.source_extra_data)).toEqual({ provider: 'example' });

    const storedDecision = db.db.prepare('SELECT raw_data, extra_data FROM decisions WHERE id = ?').get('420') as {
      raw_data: string | null;
      extra_data: string;
    };
    expect(storedDecision.raw_data).toBeNull();
    expect(JSON.parse(storedDecision.extra_data)).toEqual({ remediation: 'custom-extension' });
    expect(decisionFromRow(db.getDecisionById('420')!)).toEqual(expect.objectContaining({
      id: 420,
      scope: 'ip',
      remediation: 'custom-extension',
    }));
    expect(JSON.parse(db.getAlertsSince('2026-07-17T00:00:00.000Z')[0].raw_data)).toEqual(expect.objectContaining({
      id: 42,
      kind: 'capi',
      events: alert.events,
      source: expect.objectContaining({ provider: 'example', scope: 'ip' }),
    }));
    db.close();
  });

  test('normalizes timestamps already stored by earlier versions', () => {
    const dbPath = createTestDatabasePath();
    const original = new CrowdsecDatabase({ dbPath });
    original.insertAlert({
      $id: 1,
      $uuid: 'legacy-offset-alert',
      $created_at: '2026-07-14T12:56:33.000Z',
      $message: 'legacy offset alert',
      $raw_data: JSON.stringify({ id: 1, created_at: '2026-07-14T12:56:33.000Z' }),
    });
    original.insertDecision({
      $id: '10',
      $uuid: 'legacy-offset-decision',
      $alert_id: 1,
      $created_at: '2026-07-14T12:56:33.000Z',
      $stop_at: '2026-07-14T14:00:00.000Z',
      $value: '1.2.3.4',
      $type: 'ban',
      $origin: 'crowdsec',
      $scenario: 'crowdsecurity/ssh-bf',
      $raw_data: JSON.stringify({
        id: 10,
        created_at: '2026-07-14T12:56:33.000Z',
        stop_at: '2026-07-14T14:00:00.000Z',
      }),
    });
    original.db.prepare(`
      UPDATE alerts
      SET created_at = ?, raw_data = ?
      WHERE id = 1
    `).run(
      '2026-07-14T08:56:33-04:00',
      JSON.stringify({ id: 1, created_at: '2026-07-14T08:56:33-04:00' }),
    );
    original.db.prepare(`
      UPDATE decisions
      SET created_at = ?, stop_at = ?, raw_data = ?
      WHERE id = '10'
    `).run(
      '2026-07-14T08:56:33-04:00',
      '2026-07-14T10:00:00-04:00',
      JSON.stringify({
        id: 10,
        created_at: '2026-07-14T08:56:33-04:00',
        stop_at: '2026-07-14T10:00:00-04:00',
      }),
    );
    original.db.prepare(`
      INSERT INTO notifications (
        id, created_at, updated_at, rule_id, rule_name, rule_type, severity, title, message,
        read_at, metadata_json, deliveries_json, dedupe_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-notification',
      '2026-07-14T12:56:33Z',
      '2026-07-14T08:56:34-04:00',
      'legacy-rule',
      'Legacy rule',
      'new-alert-decision',
      'info',
      'Legacy notification',
      'Legacy notification',
      '2026-07-14T12:57:00Z',
      JSON.stringify({ created_at: '2026-07-14T12:56:33Z' }),
      JSON.stringify([{ attempted_at: '2026-07-14T08:56:35-04:00' }]),
      'legacy-notification',
    );
    original.db.prepare(`
      INSERT INTO notification_incidents (rule_id, incident_key, first_seen_at, last_seen_at, resolved_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      'legacy-rule',
      'legacy-incident',
      '2026-07-14T12:56:33Z',
      '2026-07-14T08:57:00-04:00',
      '2026-07-14T12:58:00Z',
    );
    original.db.prepare(`
      INSERT INTO cve_cache (id, published_at, fetched_at)
      VALUES (?, ?, ?)
    `).run('CVE-2026-1234', '2026-07-14T12:00:00Z', '2026-07-14T08:59:00-04:00');
    original.db.prepare(`
      INSERT OR REPLACE INTO meta (key, value)
      VALUES ('sync_timestamp_format_version', '1')
    `).run();
    original.close();

    const migrated = new CrowdsecDatabase({ dbPath });
    expect(migrated.db.prepare('SELECT created_at, raw_data FROM alerts WHERE id = 1').get()).toEqual({
      created_at: '2026-07-14T12:56:33.000Z',
      raw_data: null,
    });
    expect(migrated.db.prepare('SELECT created_at, stop_at, raw_data FROM decisions WHERE id = ?').get('10')).toEqual({
      created_at: '2026-07-14T12:56:33.000Z',
      stop_at: '2026-07-14T14:00:00.000Z',
      raw_data: null,
    });
    expect(migrated.db.prepare(`
      SELECT created_at, updated_at, read_at, metadata_json, deliveries_json
      FROM notifications
      WHERE id = 'legacy-notification'
    `).get()).toEqual({
      created_at: '2026-07-14T12:56:33.000Z',
      updated_at: '2026-07-14T12:56:34.000Z',
      read_at: '2026-07-14T12:57:00.000Z',
      metadata_json: JSON.stringify({ created_at: '2026-07-14T12:56:33.000Z' }),
      deliveries_json: JSON.stringify([{ attempted_at: '2026-07-14T12:56:35.000Z' }]),
    });
    expect(migrated.listNotificationIncidentsByRule('legacy-rule')).toEqual([
      expect.objectContaining({
        first_seen_at: '2026-07-14T12:56:33.000Z',
        last_seen_at: '2026-07-14T12:57:00.000Z',
        resolved_at: '2026-07-14T12:58:00.000Z',
      }),
    ]);
    expect(migrated.getCveCacheEntry('CVE-2026-1234')).toEqual(expect.objectContaining({
      published_at: '2026-07-14T12:00:00.000Z',
      fetched_at: '2026-07-14T12:59:00.000Z',
    }));
    expect(migrated.getMeta('sync_timestamp_format_version')?.value).toBe('2');

    migrated.close();
  });

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
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM alerts_fts WHERE alerts_fts MATCH ?').get('deferred') as { count: number }).count).toBe(1);

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

  test('fresh databases default dashboard auth on', () => {
    const db = createTestDatabase();

    expect(db.isAuthMigrationDefaultDisabled()).toBe(false);

    db.close();
  });

  test('binds OIDC users to issuer and subject without merging local usernames', () => {
    const db = createTestDatabase();
    const localUserId = db.createAuthUser({
      username: 'operator',
      passwordHash: 'local-password-hash',
      role: 'admin',
      authProvider: 'password',
    });

    const oidcUser = db.upsertOidcUser({
      username: 'operator',
      role: 'read-only',
      issuer: 'https://idp.example.com',
      subject: 'subject-1',
    });
    expect(oidcUser.id).not.toBe(localUserId);
    expect(oidcUser.username).toMatch(/^operator#oidc-/);
    expect(oidcUser.oidc_issuer).toBe('https://idp.example.com');
    expect(oidcUser.oidc_subject).toBe('subject-1');
    expect(db.getAuthUserById(localUserId)).toMatchObject({
      username: 'operator',
      auth_provider: 'password',
      password_hash: 'local-password-hash',
      role: 'admin',
    });

    const renamedOidcUser = db.upsertOidcUser({
      username: 'renamed-operator',
      role: 'admin',
      issuer: 'https://idp.example.com',
      subject: 'subject-1',
    });
    expect(renamedOidcUser.id).toBe(oidcUser.id);
    expect(renamedOidcUser.username).toBe('renamed-operator');
    expect(renamedOidcUser.session_version).toBe(oidcUser.session_version + 1);

    db.close();
  });

  test('migrates legacy OIDC users in place on their next login', () => {
    const db = createTestDatabase();
    const legacyId = db.createAuthUser({
      username: 'legacy-oidc',
      passwordHash: null,
      role: 'read-only',
      authProvider: 'oidc',
    });

    const migrated = db.upsertOidcUser({
      username: 'legacy-oidc',
      role: 'read-only',
      issuer: 'https://idp.example.com',
      subject: 'legacy-subject',
    });
    expect(migrated.id).toBe(legacyId);
    expect(migrated).toMatchObject({
      oidc_issuer: 'https://idp.example.com',
      oidc_subject: 'legacy-subject',
    });

    db.close();
  });

  test('existing databases are migrated with dashboard auth disabled by default', () => {
    const dbPath = createTestDatabasePath();
    const legacy = createLegacyDatabase(dbPath);
    legacy.exec(`
      CREATE TABLE alerts (
        id INTEGER PRIMARY KEY,
        uuid TEXT UNIQUE,
        created_at TEXT NOT NULL,
        scenario TEXT,
        source_ip TEXT,
        message TEXT,
        raw_data TEXT
      )
    `);
    legacy.close();

    const db = new CrowdsecDatabase({ dbPath });

    expect(db.isAuthMigrationDefaultDisabled()).toBe(true);

    db.close();
  });

  test('migrates legacy decision tables before creating duplicate indexes', () => {
    const dbPath = createTestDatabasePath();
    const legacy = createLegacyDatabase(dbPath);
    legacy.exec(`
      CREATE TABLE alerts (
        id INTEGER PRIMARY KEY,
        uuid TEXT UNIQUE,
        created_at TEXT NOT NULL,
        scenario TEXT,
        source_ip TEXT,
        message TEXT,
        raw_data TEXT
      );
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY,
        uuid TEXT UNIQUE,
        alert_id INTEGER,
        created_at TEXT NOT NULL,
        stop_at TEXT NOT NULL,
        value TEXT,
        type TEXT,
        origin TEXT,
        scenario TEXT,
        raw_data TEXT
      );
      CREATE INDEX idx_decisions_alert_created_at ON decisions(alert_id, created_at DESC);
      INSERT INTO decisions (
        id, uuid, alert_id, created_at, stop_at, value, type, origin, scenario, raw_data
      )
      VALUES (
        '10',
        'decision-10',
        1,
        '2026-01-01T00:00:00.000Z',
        '2030-01-01T00:00:00.000Z',
        '1.2.3.4',
        'ban',
        'cscli',
        'crowdsecurity/ssh-bf',
        '{"id":10,"value":"1.2.3.4","stop_at":"2030-01-01T00:00:00.000Z"}'
      );
    `);
    legacy.close();

    const db = new CrowdsecDatabase({ dbPath });
    const columns = db.db.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>;
    const indexes = db.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'decisions'
    `).all() as Array<{ name: string }>;
    const row = db.db.prepare('SELECT is_duplicate FROM decisions WHERE id = ?').get('10') as { is_duplicate: number };

    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(['is_duplicate', 'search_text', 'simulated']));
    expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      'idx_decisions_alert_created_id',
      'idx_decisions_duplicate_paging',
      'idx_decisions_duplicate_filters',
      'idx_decisions_duplicate_value_paging',
      'idx_decisions_duplicate_primary',
    ]));
    expect(indexes.map((index) => index.name)).not.toContain('idx_decisions_alert_created_at');
    expect(row.is_duplicate).toBe(0);
    expect(db.getDecisionById('10')?.stop_at).toBe('2030-01-01T00:00:00.000Z');

    db.close();
  });

  test('adds and backfills source coordinates for legacy alerts', () => {
    const dbPath = createTestDatabasePath();
    const legacy = createLegacyDatabase(dbPath);
    legacy.exec(`
      CREATE TABLE alerts (
        id INTEGER PRIMARY KEY,
        uuid TEXT UNIQUE,
        created_at TEXT NOT NULL,
        scenario TEXT,
        source_ip TEXT,
        message TEXT,
        raw_data TEXT
      );
      INSERT INTO alerts (id, uuid, created_at, scenario, source_ip, message, raw_data)
      VALUES (
        1,
        'alert-1',
        '2026-01-01T00:00:00.000Z',
        'crowdsecurity/ssh-bf',
        '1.2.3.4',
        'alert',
        '{"id":1,"source":{"latitude":"52.52","longitude":13.405}}'
      );
    `);
    legacy.close();

    const db = new CrowdsecDatabase({ dbPath });
    const columns = db.db.prepare('PRAGMA table_info(alerts)').all() as Array<{ name: string }>;
    const location = db.db.prepare('SELECT latitude, longitude FROM alerts WHERE id = 1').get();

    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(['latitude', 'longitude']));
    expect(location).toEqual({ latitude: 52.52, longitude: 13.405 });

    db.close();
  });

  test('migrates existing auth users with TOTP replay tracking', () => {
    const dbPath = createTestDatabasePath();
    const legacy = createLegacyDatabase(dbPath);
    legacy.exec(`
      CREATE TABLE auth_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        totp_secret TEXT,
        totp_enabled INTEGER NOT NULL DEFAULT 0,
        role TEXT NOT NULL DEFAULT 'admin',
        auth_provider TEXT NOT NULL DEFAULT 'password',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    legacy.query(`
      INSERT INTO auth_users (username, password_hash, totp_secret, totp_enabled, role, auth_provider, created_at, updated_at)
      VALUES ($username, $password_hash, $totp_secret, $totp_enabled, $role, $auth_provider, $created_at, $updated_at)
    `).run({
      $username: 'admin',
      $password_hash: 'hash',
      $totp_secret: 'secret',
      $totp_enabled: 1,
      $role: 'admin',
      $auth_provider: 'password',
      $created_at: '2026-01-01T00:00:00.000Z',
      $updated_at: '2026-01-01T00:00:00.000Z',
    });
    legacy.close();

    const db = new CrowdsecDatabase({ dbPath });

    expect(db.getAuthUserByUsername('admin')?.totp_last_step).toBeNull();
    expect(db.updateAuthUserTotpLastStep(1, 12345)).toBe(true);
    expect(db.getAuthUserByUsername('admin')?.totp_last_step).toBe(12345);
    expect(db.updateAuthUserTotpLastStep(1, 12345)).toBe(false);
    expect(db.updateAuthUserTotpLastStep(1, 12344)).toBe(false);
    expect(db.getAuthUserByUsername('admin')?.totp_last_step).toBe(12345);

    db.close();
  });

  test('deleteDecisionsByAlertIdExcept removes stale decisions while preserving kept and unrelated rows', () => {
    const db = createTestDatabase();

    db.insertDecision({
      $id: '10',
      $uuid: '10',
      $alert_id: 1,
      $created_at: '2025-01-01T00:00:00.000Z',
      $stop_at: '2030-01-01T00:00:00.000Z',
      $value: '1.2.3.4',
      $type: 'ban',
      $origin: 'manual',
      $scenario: 'crowdsecurity/ssh-bf',
      $raw_data: JSON.stringify({ id: 10, alert_id: 1 }),
    });
    db.insertDecision({
      $id: '11',
      $uuid: '11',
      $alert_id: 1,
      $created_at: '2025-01-01T00:01:00.000Z',
      $stop_at: '2030-01-01T00:01:00.000Z',
      $value: '1.2.3.5',
      $type: 'ban',
      $origin: 'manual',
      $scenario: 'crowdsecurity/ssh-bf',
      $raw_data: JSON.stringify({ id: 11, alert_id: 1 }),
    });
    db.insertDecision({
      $id: '12',
      $uuid: '12',
      $alert_id: 1,
      $created_at: '2025-01-01T00:02:00.000Z',
      $stop_at: '2030-01-01T00:02:00.000Z',
      $value: '1.2.3.6',
      $type: 'ban',
      $origin: 'manual',
      $scenario: 'crowdsecurity/ssh-bf',
      $raw_data: JSON.stringify({ id: 12, alert_id: 1 }),
    });
    db.insertDecision({
      $id: '20',
      $uuid: '20',
      $alert_id: 2,
      $created_at: '2025-01-01T00:03:00.000Z',
      $stop_at: '2030-01-01T00:03:00.000Z',
      $value: '5.6.7.8',
      $type: 'ban',
      $origin: 'manual',
      $scenario: 'crowdsecurity/http-probing',
      $raw_data: JSON.stringify({ id: 20, alert_id: 2 }),
    });

    expect(db.deleteDecisionsByAlertIdExcept(1, ['10', '12'])).toBe(1);
    expect(db.getDecisionById('10')).not.toBeNull();
    expect(db.getDecisionById('11')).toBeNull();
    expect(db.getDecisionById('12')).not.toBeNull();
    expect(db.getDecisionById('20')).not.toBeNull();

    expect(db.deleteDecisionsByAlertIdExcept(1, [])).toBe(2);
    expect(db.getDecisionById('10')).toBeNull();
    expect(db.getDecisionById('12')).toBeNull();
    expect(db.getDecisionById('20')).not.toBeNull();

    db.close();
  });

  test('deleteAlertsMissingBetween removes stale alerts and linked decisions only inside the window', () => {
    const db = createTestDatabase();

    for (const alert of [
      { id: 1, createdAt: '2025-01-01T00:00:00.000Z' },
      { id: 2, createdAt: '2025-01-01T00:01:00.000Z' },
      { id: 3, createdAt: '2025-01-01T03:00:00.000Z' },
    ]) {
      db.insertAlert({
        $id: alert.id,
        $uuid: `alert-${alert.id}`,
        $created_at: alert.createdAt,
        $scenario: 'scenario',
        $source_ip: '1.2.3.4',
        $message: 'alert',
        $raw_data: JSON.stringify({ id: alert.id }),
      });
      db.insertDecision({
        $id: String(alert.id * 10),
        $uuid: String(alert.id * 10),
        $alert_id: alert.id,
        $created_at: alert.createdAt,
        $stop_at: '2030-01-01T00:00:00.000Z',
        $value: '1.2.3.4',
        $type: 'ban',
        $origin: 'manual',
        $scenario: 'scenario',
        $raw_data: JSON.stringify({ id: alert.id * 10, alert_id: alert.id }),
      });
    }

    expect(db.deleteAlertsMissingBetween(
      '2025-01-01T00:00:00.000Z',
      '2025-01-01T02:00:00.000Z',
      ['1'],
    )).toEqual({ alerts: 1, decisions: 1 });

    expect(db.getAlertsBetween('2025-01-01T00:00:00.000Z', '2025-01-01T02:00:00.000Z')).toHaveLength(1);
    expect(db.getAlertsSince('2025-01-01T00:00:00.000Z')).toHaveLength(2);
    expect(db.getDecisionById('10')).not.toBeNull();
    expect(db.getDecisionById('20')).toBeNull();
    expect(db.getDecisionById('30')).not.toBeNull();

    db.close();
  });

  test('deleteActiveAlertsMissing removes only active cached alerts absent from keep ids', () => {
    const db = createTestDatabase();

    for (const alert of [
      { id: 1, createdAt: '2025-01-01T00:00:00.000Z', stopAt: '2030-01-01T00:00:00.000Z' },
      { id: 2, createdAt: '2025-01-01T00:00:00.000Z', stopAt: '2030-01-01T00:00:00.000Z' },
      { id: 3, createdAt: '2025-01-01T00:00:00.000Z', stopAt: '2020-01-01T00:00:00.000Z' },
      { id: 4, createdAt: '2024-01-01T00:00:00.000Z', stopAt: '2030-01-01T00:00:00.000Z' },
    ]) {
      db.insertAlert({
        $id: alert.id,
        $uuid: `active-alert-${alert.id}`,
        $created_at: alert.createdAt,
        $scenario: 'scenario',
        $source_ip: '1.2.3.4',
        $message: 'alert',
        $raw_data: JSON.stringify({ id: alert.id }),
      });
      db.insertDecision({
        $id: String(alert.id * 10),
        $uuid: String(alert.id * 10),
        $alert_id: alert.id,
        $created_at: '2025-01-01T00:00:00.000Z',
        $stop_at: alert.stopAt,
        $value: '1.2.3.4',
        $type: 'ban',
        $origin: 'manual',
        $scenario: 'scenario',
        $raw_data: JSON.stringify({ id: alert.id * 10, alert_id: alert.id }),
      });
    }

    expect(db.deleteActiveAlertsMissing(['1'], '2025-01-01T00:00:00.000Z', '2024-12-31T00:00:00.000Z')).toEqual({ alerts: 1, decisions: 1 });
    expect(db.getAlertsSince('2024-01-01T00:00:00.000Z')).toHaveLength(3);
    expect(db.getDecisionById('10')).not.toBeNull();
    expect(db.getDecisionById('20')).toBeNull();
    expect(db.getDecisionById('30')).not.toBeNull();
    expect(db.getDecisionById('40')).not.toBeNull();

    db.close();
  });

  test('stores notification channels, rules, notifications, and cve cache', () => {
    const db = createTestDatabase();

    db.upsertNotificationChannel({
      $id: 'channel-1',
      $created_at: '2025-01-01T00:00:00.000Z',
      $updated_at: '2025-01-01T00:00:00.000Z',
      $name: 'ntfy main',
      $type: 'ntfy',
      $enabled: 1,
      $config_json: JSON.stringify({ topic: 'crowdsec' }),
    });

    db.upsertNotificationRule({
      $id: 'rule-1',
      $created_at: '2025-01-01T00:00:00.000Z',
      $updated_at: '2025-01-01T00:00:00.000Z',
      $name: 'Alert threshold',
      $type: 'alert-threshold',
      $enabled: 1,
      $severity: 'warning',
      $channel_ids_json: JSON.stringify(['channel-1']),
      $config_json: JSON.stringify({ window_minutes: 60, alert_threshold: 10 }),
    });

    const inserted = db.insertNotification({
      $id: 'notif-1',
      $created_at: '2025-01-01T00:00:00.000Z',
      $updated_at: '2025-01-01T00:00:00.000Z',
      $rule_id: 'rule-1',
      $rule_name: 'Alert threshold',
      $rule_type: 'alert-threshold',
      $severity: 'warning',
      $title: 'Threshold exceeded',
      $message: '10 alerts matched.',
      $read_at: null,
      $metadata_json: JSON.stringify({ matched_alerts: 10 }),
      $deliveries_json: JSON.stringify([{ channel_name: 'ntfy main', status: 'delivered' }]),
      $dedupe_key: 'rule-1:bucket',
    });
    expect(inserted).toBe(true);
    expect(db.insertNotification({
      $id: 'notif-2',
      $created_at: '2025-01-01T02:00:00.000Z',
      $updated_at: '2025-01-01T02:00:00.000Z',
      $rule_id: 'rule-1',
      $rule_name: 'Alert threshold',
      $rule_type: 'alert-threshold',
      $severity: 'warning',
      $title: 'Threshold exceeded',
      $message: '10 alerts matched.',
      $read_at: null,
      $metadata_json: JSON.stringify({ matched_alerts: 10 }),
      $deliveries_json: JSON.stringify([]),
      $dedupe_key: 'rule-1:bucket',
    })).toBe(true);

    db.upsertNotificationIncident({
      $rule_id: 'rule-1',
      $incident_key: 'threshold:active',
      $first_seen_at: '2025-01-01T00:00:00.000Z',
      $last_seen_at: '2025-01-01T00:00:00.000Z',
      $resolved_at: null,
    });

    db.upsertCveCacheEntry('CVE-2025-1234', '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z');

    expect(db.listNotificationChannels()).toHaveLength(1);
    expect(db.listNotificationRules()).toHaveLength(1);
    expect(db.listNotifications()).toHaveLength(2);
    expect(db.listNotificationsPage(1, 1)).toHaveLength(1);
    expect(db.countNotifications()).toBe(2);
    expect(db.listNotificationIds()).toEqual(['notif-2', 'notif-1']);
    expect(db.countUnreadNotifications()).toBe(2);
    expect(db.listNotificationIncidentsByRule('rule-1')).toEqual([
      expect.objectContaining({
        rule_id: 'rule-1',
        incident_key: 'threshold:active',
        first_seen_at: '2025-01-01T00:00:00.000Z',
        last_seen_at: '2025-01-01T00:00:00.000Z',
        resolved_at: null,
      }),
    ]);
    expect(db.getCveCacheEntry('CVE-2025-1234')?.published_at).toBe('2025-01-01T00:00:00.000Z');

    expect(db.markNotificationRead('notif-1', '2025-01-01T01:00:00.000Z')).toBe(true);
    expect(db.countUnreadNotifications()).toBe(1);
    expect(db.markNotificationsRead(['notif-2'], '2025-01-01T02:00:00.000Z')).toBe(1);
    expect(db.countUnreadNotifications()).toBe(0);
    expect(db.markAllNotificationsRead('2025-01-01T03:00:00.000Z')).toBe(0);
    expect(db.deleteNotification('notif-1')).toBe(true);
    expect(db.deleteNotifications(['notif-2'])).toBe(1);
    expect(db.countNotifications()).toBe(0);
    expect(db.resolveNotificationIncident('rule-1', 'threshold:active', '2025-01-01T04:00:00.000Z')).toBe(true);
    expect(db.listNotificationIncidentsByRule('rule-1')[0]).toEqual(expect.objectContaining({
      resolved_at: '2025-01-01T04:00:00.000Z',
      last_seen_at: '2025-01-01T04:00:00.000Z',
    }));

    db.deleteNotificationRule('rule-1');
    db.deleteNotificationChannel('channel-1');
    expect(db.listNotificationRules()).toHaveLength(0);
    expect(db.listNotificationChannels()).toHaveLength(0);

    db.close();
  });

  test('normalizes every timestamp-bearing notification write', () => {
    const db = createTestDatabase();

    db.upsertNotificationChannel({
      $id: 'channel-offset',
      $created_at: '2025-01-01T00:00:00Z',
      $updated_at: '2024-12-31T20:00:01-04:00',
      $name: 'Offset channel',
      $type: 'ntfy',
      $enabled: 1,
      $config_json: '{}',
    });
    db.upsertNotificationRule({
      $id: 'rule-offset',
      $created_at: '2025-01-01T00:00:00Z',
      $updated_at: '2024-12-31T20:00:01-04:00',
      $name: 'Offset rule',
      $type: 'alert-threshold',
      $enabled: 1,
      $severity: 'warning',
      $channel_ids_json: '[]',
      $config_json: '{}',
    });
    db.insertNotification({
      $id: 'notification-offset',
      $created_at: '2025-01-01T00:00:00Z',
      $updated_at: '2024-12-31T20:00:01-04:00',
      $rule_id: 'rule-offset',
      $rule_name: 'Offset rule',
      $rule_type: 'alert-threshold',
      $severity: 'warning',
      $title: 'Offset notification',
      $message: 'Offset notification',
      $read_at: null,
      $metadata_json: JSON.stringify({ created_at: '2024-12-31T20:00:00-04:00' }),
      $deliveries_json: JSON.stringify([{ attempted_at: '2025-01-01T00:00:02Z' }]),
      $dedupe_key: 'notification-offset',
    });
    db.upsertNotificationIncident({
      $rule_id: 'rule-offset',
      $incident_key: 'incident-offset',
      $first_seen_at: '2025-01-01T00:00:00Z',
      $last_seen_at: '2024-12-31T20:00:01-04:00',
      $resolved_at: null,
    });
    db.upsertCveCacheEntry('CVE-2025-9999', '2025-01-01T00:00:00Z', '2024-12-31T20:00:01-04:00');
    db.markNotificationRead('notification-offset', '2024-12-31T20:00:03-04:00');
    db.resolveNotificationIncident('rule-offset', 'incident-offset', '2025-01-01T00:00:04Z');

    expect(db.getNotificationChannelById('channel-offset')).toEqual(expect.objectContaining({
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:01.000Z',
    }));
    expect(db.getNotificationRuleById('rule-offset')).toEqual(expect.objectContaining({
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:01.000Z',
    }));
    expect(db.listNotifications()[0]).toEqual(expect.objectContaining({
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:03.000Z',
      read_at: '2025-01-01T00:00:03.000Z',
      metadata_json: JSON.stringify({ created_at: '2025-01-01T00:00:00.000Z' }),
      deliveries_json: JSON.stringify([{ attempted_at: '2025-01-01T00:00:02.000Z' }]),
    }));
    expect(db.listNotificationIncidentsByRule('rule-offset')).toEqual([
      expect.objectContaining({
        first_seen_at: '2025-01-01T00:00:00.000Z',
        last_seen_at: '2025-01-01T00:00:04.000Z',
        resolved_at: '2025-01-01T00:00:04.000Z',
      }),
    ]);
    expect(db.getCveCacheEntry('CVE-2025-9999')).toEqual(expect.objectContaining({
      published_at: '2025-01-01T00:00:00.000Z',
      fetched_at: '2025-01-01T00:00:01.000Z',
    }));

    db.close();
  });

  test('checkpoints WAL data on close so settings survive container recreation', () => {
    const dbPath = createTestDatabasePath();
    const db = new CrowdsecDatabase({ dbPath });

    db.upsertNotificationChannel({
      $id: 'channel-persisted',
      $created_at: '2026-05-14T15:00:00.000Z',
      $updated_at: '2026-05-14T15:00:00.000Z',
      $name: 'Persisted ntfy',
      $type: 'ntfy',
      $enabled: 1,
      $config_json: JSON.stringify({ topic: 'crowdsec' }),
    });

    db.close();

    const walPath = `${dbPath}-wal`;
    if (existsSync(walPath)) {
      expect(statSync(walPath).size).toBe(0);
    }

    const reopened = new CrowdsecDatabase({ dbPath });
    expect(reopened.listNotificationChannels()).toEqual([
      expect.objectContaining({
        id: 'channel-persisted',
        name: 'Persisted ntfy',
      }),
    ]);
    reopened.close();
  });

  test('can disable WAL and persists the rollback journal mode', () => {
    const dbPath = createTestDatabasePath();
    const walDatabase = new CrowdsecDatabase({ dbPath });
    expect(walDatabase.db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    walDatabase.close();

    const rollbackDatabase = new CrowdsecDatabase({ dbPath, walEnabled: false });
    expect(rollbackDatabase.db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    rollbackDatabase.close();

    const reopened = new Database(dbPath);
    expect(reopened.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    reopened.close();
  });

  test('docker entrypoint preserves SQLite WAL files for restart recovery', () => {
    const entrypoint = readFileSync(path.resolve(process.cwd(), 'docker-entrypoint.sh'), 'utf8');

    expect(entrypoint).not.toContain('rm -f /app/data/crowdsec.db-wal');
    expect(entrypoint).not.toContain('rm -f /app/data/crowdsec.db-shm');
  });

  test('load-test Docker image keeps synthetic data away from the regular database', () => {
    const dockerfile = readFileSync(path.resolve(process.cwd(), 'Dockerfile'), 'utf8');
    const entrypoint = readFileSync(path.resolve(process.cwd(), 'docker-loadtest-entrypoint.sh'), 'utf8');
    const loadTestServer = readFileSync(path.resolve(process.cwd(), 'scripts/load-test-server.ts'), 'utf8');

    expect(dockerfile).toContain('FROM runner AS loadtest');
    expect(dockerfile).toContain('ENV LOADTEST_DB_DIR="/tmp/crowdsec-web-ui-load-test"');
    expect(entrypoint).toContain('export LOADTEST_DB_DIR');
    expect(entrypoint).not.toContain('export DB_DIR=');
    expect(entrypoint).not.toContain('${DB_DIR:-');
    expect(entrypoint).not.toContain('chown -R node:node /app/data');
    expect(loadTestServer).toContain('CONFIG_STORAGE_DATA_DIR: dbDir');
  });

  test('load-test Docker entrypoint applies a selected profile and keeps environment overrides', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-loadtest-entrypoint-'));
    tempDirs.push(dir);
    const binDir = path.join(dir, 'bin');
    const dbDir = path.join(dir, 'db');
    const mkdirResult = spawnSync('/bin/mkdir', ['-p', binDir]);
    expect(mkdirResult.status).toBe(0);

    const nodeStub = path.join(binDir, 'node');
    const gosuStub = path.join(binDir, 'gosu');
    const chownStub = path.join(binDir, 'chown');
    writeFileSync(nodeStub, '#!/bin/sh\nexit 0\n', 'utf8');
    writeFileSync(gosuStub, '#!/bin/sh\nshift\nexec "$@"\n', 'utf8');
    writeFileSync(chownStub, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(nodeStub, 0o755);
    chmodSync(gosuStub, 0o755);
    chmodSync(chownStub, 0o755);

    const result = spawnSync(
      '/bin/bash',
      [path.resolve(process.cwd(), 'docker-loadtest-entrypoint.sh'), '/usr/bin/env'],
      {
        encoding: 'utf8',
        env: {
          PATH: `${binDir}:/usr/bin:/bin`,
          LOADTEST_PROFILE: 'blocklist',
          LOADTEST_PROFILE_DIR: path.resolve(process.cwd(), 'scripts/load-test-profiles'),
          LOADTEST_DB_DIR: dbDir,
          LOADTEST_ALERTS: '42',
        },
      },
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const environment = new Set(result.stdout.trim().split('\n'));
    expect(environment).toContain('LOADTEST_PROFILE=blocklist');
    expect(environment).toContain('LOADTEST_ALERTS=42');
    expect(environment).toContain('LOADTEST_DECISIONS=410463');
    expect(environment).toContain('LOADTEST_SEED=1337');
    expect(environment).toContain(`LOADTEST_DB_DIR=${dbDir}`);
    expect([...environment].some((entry) => entry.startsWith('DB_DIR='))).toBe(false);
  });

  test('migrates legacy notification rules, notifications, and seeds incidents from history', () => {
    const dbPath = createTestDatabasePath();
    const legacy = createLegacyDatabase(dbPath);

    legacy.exec(`
      CREATE TABLE notification_rules (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        severity TEXT NOT NULL,
        cooldown_minutes INTEGER NOT NULL DEFAULT 60,
        channel_ids_json TEXT NOT NULL,
        config_json TEXT NOT NULL
      );
      CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        rule_name TEXT NOT NULL,
        rule_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        read_at TEXT,
        metadata_json TEXT NOT NULL,
        deliveries_json TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE
      );
    `);

    legacy.query(`
      INSERT INTO notification_rules (
        id, created_at, updated_at, name, type, enabled, severity, cooldown_minutes, channel_ids_json, config_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'rule-legacy',
      '2025-01-01T00:00:00.000Z',
      '2025-01-01T00:00:00.000Z',
      'Legacy threshold',
      'alert-threshold',
      1,
      'warning',
      60,
      '[]',
      JSON.stringify({ window_minutes: 60, alert_threshold: 10 }),
    );
    legacy.query(`
      INSERT INTO notifications (
        id, created_at, updated_at, rule_id, rule_name, rule_type, severity, title, message, read_at, metadata_json, deliveries_json, dedupe_key
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'notif-legacy',
      '2025-01-01T00:00:00.000Z',
      '2025-01-01T00:00:00.000Z',
      'rule-legacy',
      'Legacy threshold',
      'alert-threshold',
      'warning',
      'Threshold exceeded',
      '10 alerts matched.',
      null,
      JSON.stringify({ matched_alerts: 10 }),
      JSON.stringify([]),
      'rule-legacy:threshold:28928160',
    );
    legacy.close();

    const db = new CrowdsecDatabase({ dbPath });

    expect(db.listNotificationRules()).toEqual([
      expect.objectContaining({
        id: 'rule-legacy',
        name: 'Legacy threshold',
        severity: 'warning',
      }),
    ]);
    expect(db.listNotificationIncidentsByRule('rule-legacy')).toEqual([
      expect.objectContaining({
        rule_id: 'rule-legacy',
        incident_key: 'threshold:active',
        resolved_at: null,
      }),
    ]);

    expect(db.insertNotification({
      $id: 'notif-legacy-2',
      $created_at: '2025-01-01T05:00:00.000Z',
      $updated_at: '2025-01-01T05:00:00.000Z',
      $rule_id: 'rule-legacy',
      $rule_name: 'Legacy threshold',
      $rule_type: 'alert-threshold',
      $severity: 'warning',
      $title: 'Threshold exceeded again',
      $message: '11 alerts matched.',
      $read_at: null,
      $metadata_json: JSON.stringify({ matched_alerts: 11 }),
      $deliveries_json: JSON.stringify([]),
      $dedupe_key: 'threshold:active',
    })).toBe(true);
    expect(db.listNotifications()).toHaveLength(2);

    db.close();
  });
});
