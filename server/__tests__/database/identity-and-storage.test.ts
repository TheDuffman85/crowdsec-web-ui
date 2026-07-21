import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { tmpdir } from 'os';
import { CrowdsecDatabase } from '../../database';
import { decisionFromRow } from '../../normalized-record';
import { createLegacyDatabase, createTestDatabase, createTestDatabasePath, tempDirs } from './harness';

describe('CrowdsecDatabase identity and storage', () => {
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

});
