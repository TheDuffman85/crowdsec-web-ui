import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CrowdsecDatabase } from '../database';
import { DatabaseQueryWorker } from '../query-worker-client';

const tempDirs: string[] = [];
const workers: DatabaseQueryWorker[] = [];

afterEach(() => {
  for (const worker of workers.splice(0)) worker.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('DatabaseQueryWorker', () => {
  test('falls back to SQLite planning while optional bootstrap indexes are absent', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-query-worker-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'test.db');
    const database = new CrowdsecDatabase({ cachePath: dbPath });
    database.insertDecision({
      $id: 'decision-1',
      $uuid: 'decision-1',
      $alert_id: 1,
      $created_at: '2026-07-25T00:00:00.000Z',
      $stop_at: '2030-01-01T00:00:00.000Z',
      $value: '192.0.2.1',
      $type: 'ban',
      $origin: 'crowdsec',
      $scenario: 'crowdsecurity/ssh-bf',
      $raw_data: JSON.stringify({ id: 'decision-1', value: '192.0.2.1' }),
    });
    database.beginDeferredSearchIndexUpdates();

    const worker = new DatabaseQueryWorker({ dbPath, maxWorkers: 1 });
    workers.push(worker);
    await expect(worker.all<{ id: string }>(`
      SELECT id
      FROM decisions INDEXED BY idx_decisions_duplicate_paging
      WHERE is_duplicate = 0
      ORDER BY created_at DESC, id DESC
    `)).resolves.toEqual([{ id: 'decision-1' }]);

    worker.close();
    database.close();
  });

  test('distinguishes queue starvation from query execution timeouts', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-query-worker-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'test.db');
    const database = new CrowdsecDatabase({ cachePath: dbPath });
    const worker = new DatabaseQueryWorker({
      dbPath,
      maxWorkers: 1,
      timeoutMs: 250,
      queueTimeoutMs: 25,
    });
    workers.push(worker);
    const slowQuery = worker.get(`
      WITH RECURSIVE counter(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM counter WHERE value < 100000000
      )
      SELECT SUM(value) AS total FROM counter
    `, [], { label: 'slow regression query' });
    const queuedQuery = worker.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM alerts',
      [],
      { label: 'queued regression query' },
    );

    await expect(queuedQuery).rejects.toMatchObject({
      name: 'QueryWorkerTimeoutError',
      stage: 'queue',
      label: 'queued regression query',
    });
    await expect(slowQuery).rejects.toEqual(expect.objectContaining({
      name: 'QueryWorkerTimeoutError',
      stage: 'execution',
      label: 'slow regression query',
    }));

    database.close();
  });

  test('aborts an executing query and replaces its worker for subsequent reads', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-query-worker-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'test.db');
    const database = new CrowdsecDatabase({ cachePath: dbPath });
    const worker = new DatabaseQueryWorker({
      dbPath,
      maxWorkers: 1,
      timeoutMs: 30_000,
    });
    workers.push(worker);
    const controller = new AbortController();
    const slowQuery = worker.get(`
      WITH RECURSIVE counter(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM counter WHERE value < 100000000
      )
      SELECT SUM(value) AS total FROM counter
    `, [], { label: 'abortable regression query', signal: controller.signal });

    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    await expect(slowQuery).rejects.toMatchObject({ name: 'AbortError' });
    await expect(worker.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM alerts',
    )).resolves.toEqual({ count: 0 });

    database.close();
  });
});

test('kills a native query on timeout and serves the next read without waiting for SQL completion', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-query-timeout-'));
  tempDirs.push(dir);
  const database = new CrowdsecDatabase({ cachePath: path.join(dir, 'test.db') });
  const worker = new DatabaseQueryWorker({ dbPath: database.cachePath, maxWorkers: 1, timeoutMs: 1000 });
  workers.push(worker);
  try {
    await worker.get('SELECT 1');
    await expect(worker.get(`
      WITH RECURSIVE c(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM c WHERE v < 1000000000000)
      SELECT COUNT(*) FROM c
    `)).rejects.toMatchObject({ name: 'QueryWorkerTimeoutError', stage: 'execution' });
    expect(await worker.get('SELECT 42 AS answer')).toEqual({ answer: 42 });
    worker.close();
    await expect(worker.get('SELECT 1')).rejects.toThrow('closed');
  } finally { database.close(); }
}, 10000);
