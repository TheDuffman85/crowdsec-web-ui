import { expect, test } from 'vitest';
import { CrowdsecDatabase } from '../../database';
import { createTestDatabasePath } from './harness';

test('creates filter tables on existing databases and persists entries across restarts', () => {
  const dbPath = createTestDatabasePath();
  let database = new CrowdsecDatabase({ dbPath });
  const userId = database.createAuthUser({ username: 'operator', passwordHash: 'hash', role: 'admin', authProvider: 'password' });
  database.db.exec('DROP TABLE saved_search_filters; DROP TABLE recent_search_filters;');
  database.close();

  database = new CrowdsecDatabase({ dbPath });
  expect(database.getAuthUserById(userId)?.username).toBe('operator');
  database.db.query(`INSERT INTO saved_search_filters (id, owner_id, name, query, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run('filter-1', userId, 'Germany', 'country=DE', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
  for (let index = 0; index < 7; index += 1) {
    database.db.query('INSERT INTO recent_search_filters (owner_id, query, used_at_ms) VALUES (?, ?, ?)').run(userId, `country=DE AND ip:192.0.2.${index}`, index);
  }
  database.close();

  database = new CrowdsecDatabase({ dbPath });
  expect(database.db.query('SELECT query FROM saved_search_filters WHERE owner_id = ?').get(userId)).toEqual({ query: 'country=DE' });
  expect(database.db.query('SELECT query FROM recent_search_filters WHERE owner_id = ? ORDER BY used_at_ms DESC').all(userId)).toEqual(
    [6, 5, 4, 3, 2].map((index) => ({ query: `country=DE AND ip:192.0.2.${index}` })),
  );
  database.close();
});
