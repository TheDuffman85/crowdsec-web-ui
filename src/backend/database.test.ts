import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { CrowdsecDatabase } from './database';

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

describe('CrowdsecDatabase', () => {
  test('stores alerts, decisions, and metadata', () => {
    const db = createTestDatabase();

    db.insertAlert({
      $id: 1,
      $uuid: 'alert-1',
      $created_at: '2025-01-01T00:00:00.000Z',
      $scenario: 'crowdsecurity/ssh-bf',
      $source_ip: '1.2.3.4',
      $message: 'alert',
      $raw_data: JSON.stringify({ id: 1 }),
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
    expect(db.getAlertsSince('2024-12-31T00:00:00.000Z')).toHaveLength(1);
    expect(db.getActiveDecisions('2025-01-01T00:00:00.000Z')).toHaveLength(1);
    expect(db.getDecisionById('10')?.stop_at).toBe('2030-01-01T00:00:00.000Z');
    expect(db.getMeta('refresh_interval_ms')?.value).toBe('5000');

    db.deleteDecision('10');
    db.deleteAlert(1);
    expect(db.getActiveDecisions('2025-01-01T00:00:00.000Z')).toHaveLength(0);
    expect(db.countAlerts()).toBe(0);

    db.close();
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
});
