import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CrowdsecDatabase, getSqliteMaintenanceWarning } from '../../database';

const tempDirs: string[] = [];

function databasePath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-sqlite-maintenance-'));
  tempDirs.push(dir);
  return path.join(dir, 'crowdsec.db');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SQLite maintenance', () => {
  test('enables incremental auto-vacuum only for fresh databases when configured', () => {
    const enabled = new CrowdsecDatabase({ dbPath: databasePath() });
    expect(enabled.wasFresh).toBe(true);
    expect(enabled.getStorageStats().autoVacuum).toBe(2);
    enabled.close();

    const disabled = new CrowdsecDatabase({
      dbPath: databasePath(),
      incrementalVacuumEnabled: false,
    });
    expect(disabled.wasFresh).toBe(true);
    expect(disabled.getStorageStats().autoVacuum).toBe(0);
    disabled.close();
  });

  test('does not migrate an existing database from auto_vacuum NONE', () => {
    const dbPath = databasePath();
    const existing = new Database(dbPath);
    existing.exec('CREATE TABLE existing_data (id INTEGER PRIMARY KEY)');
    existing.close();

    const database = new CrowdsecDatabase({ dbPath, incrementalVacuumEnabled: true });
    expect(database.wasFresh).toBe(false);
    expect(database.getStorageStats().autoVacuum).toBe(0);
    database.close();

    const reopened = new Database(dbPath);
    expect(reopened.prepare('PRAGMA auto_vacuum').get()).toEqual({ auto_vacuum: 0 });
    reopened.close();
  });

  test('warns only when an existing NONE database crosses both reclaim thresholds', () => {
    const storage = {
      autoVacuum: 0,
      pageSize: 4096,
      pageCount: 200_000,
      freelistCount: 40_000,
      reclaimableBytes: 160 * 1024 * 1024,
      freeRatio: 0.2,
      journalMode: 'wal',
    };
    expect(getSqliteMaintenanceWarning(storage)).toBeNull();
    expect(getSqliteMaintenanceWarning({ ...storage, freeRatio: 0.25 })).toBe(
      'SQLite can reclaim ~160 MiB. Stop the app and enable incremental vacuum: '
      + 'https://github.com/TheDuffman85/crowdsec-web-ui#sqlite-database-maintenance',
    );
    expect(getSqliteMaintenanceWarning({ ...storage, autoVacuum: 2, freeRatio: 0.25 })).toBeNull();
  });

  test('runs bounded incremental vacuum above thresholds and observes the cooldown', () => {
    const database = new CrowdsecDatabase({ dbPath: databasePath() });
    database.db.exec('CREATE TABLE vacuum_payload (payload BLOB NOT NULL)');
    const insert = database.db.prepare('INSERT INTO vacuum_payload(payload) VALUES (randomblob(8192))');
    const fill = database.db.transaction(() => {
      for (let index = 0; index < 1024; index += 1) insert.run();
    });
    fill();
    database.db.exec('DELETE FROM vacuum_payload');
    expect(database.getStorageStats().freelistCount).toBeGreaterThan(1);

    const now = Date.parse('2026-09-01T00:00:00.000Z');
    const first = database.runIncrementalVacuum({
      now,
      minFreeRatio: 0.01,
      minFreeBytes: 1,
      maxPages: 1,
      cooldownMs: 24 * 60 * 60 * 1000,
    });
    expect(first.performed).toBe(true);
    expect(first.reason).toBe('completed');
    expect(first.before.freelistCount).toBeGreaterThan(first.after.freelistCount);

    const second = database.runIncrementalVacuum({
      now: now + 60_000,
      minFreeRatio: 0.01,
      minFreeBytes: 1,
      maxPages: 1,
      cooldownMs: 24 * 60 * 60 * 1000,
    });
    expect(second).toEqual(expect.objectContaining({ performed: false, reason: 'cooldown' }));
    database.close();
  });

  test('skips incremental vacuum below either reclaim threshold', () => {
    const database = new CrowdsecDatabase({ dbPath: databasePath() });
    const result = database.runIncrementalVacuum({
      now: Date.now(),
      minFreeRatio: 0.25,
      minFreeBytes: 128 * 1024 * 1024,
      maxPages: 4096,
      cooldownMs: 24 * 60 * 60 * 1000,
    });
    expect(result).toEqual(expect.objectContaining({ performed: false, reason: 'below-threshold' }));
    database.close();
  });

  test('journal size retention does not cap a transaction larger than the limit', () => {
    const dbPath = databasePath();
    const database = new CrowdsecDatabase({ dbPath, journalSizeLimitBytes: 64 * 1024 });
    expect(database.db.prepare('PRAGMA journal_size_limit').get()).toEqual({ journal_size_limit: 64 * 1024 });
    database.db.exec('CREATE TABLE large_transaction (payload BLOB NOT NULL)');
    const insert = database.db.prepare('INSERT INTO large_transaction(payload) VALUES (randomblob(16384))');
    database.db.transaction(() => {
      for (let index = 0; index < 256; index += 1) insert.run();
    })();
    expect(database.db.prepare('SELECT COUNT(*) AS count FROM large_transaction').get()).toEqual({ count: 256 });
    database.close();

    const reopened = new Database(dbPath);
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM large_transaction').get()).toEqual({ count: 256 });
    reopened.close();
  });

  test('supports unlimited WAL retention and ignores the setting in DELETE mode', () => {
    const dbPath = databasePath();
    const unlimited = new CrowdsecDatabase({ dbPath, journalSizeLimitBytes: -1 });
    expect(unlimited.db.prepare('PRAGMA journal_size_limit').get()).toEqual({ journal_size_limit: -1 });
    unlimited.close();

    const rollback = new CrowdsecDatabase({
      dbPath,
      walEnabled: false,
      journalSizeLimitBytes: 1,
    });
    expect(rollback.getStorageStats().journalMode).toBe('delete');
    expect(rollback.db.prepare('PRAGMA journal_size_limit').get()).toEqual({ journal_size_limit: -1 });
    rollback.close();
  });
});
