import { expect, test } from 'vitest';
import { CrowdsecDatabase } from '../../database';
import { createTestDatabasePath } from './harness';

test('persists saved and recent filters across restarts', () => {
  const dbPath = createTestDatabasePath();
  let database = new CrowdsecDatabase({ cachePath: dbPath });
  const userId = database.createAuthUser({ username: 'operator', passwordHash: 'hash', role: 'admin', authProvider: 'password' });
  database.db.query(`INSERT INTO saved_search_filters (id, owner_id, name, query, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run('filter-1', userId, 'Germany', 'country=DE', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
  database.db.query('INSERT INTO recent_search_filters (owner_id, query, used_at_ms) VALUES (?, ?, ?)').run(userId, 'country=DE', 1);
  database.close();

  database = new CrowdsecDatabase({ cachePath: dbPath });
  expect(database.getAuthUserById(userId)?.username).toBe('operator');
  expect(database.db.query('SELECT query FROM saved_search_filters WHERE owner_id = ?').get(userId)).toEqual({ query: 'country=DE' });
  expect(database.db.query('SELECT query FROM recent_search_filters WHERE owner_id = ?').all(userId)).toEqual([{ query: 'country=DE' }]);
  database.close();
});
