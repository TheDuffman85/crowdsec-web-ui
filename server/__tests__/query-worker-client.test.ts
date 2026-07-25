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
    const database = new CrowdsecDatabase({ dbPath });
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
});
