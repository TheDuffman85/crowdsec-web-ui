import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { compileAlertSearch, compileDecisionSearch } from '../../shared/search';
import type { DashboardAuth } from '../app-auth';
import { RECENT_FILTER_LIMIT, type CrowdsecDatabase } from '../database';

const MAX_NAME_LENGTH = 80;
const MAX_QUERY_LENGTH = 4096;
const MAX_SAVED_FILTERS = 100;
const SEARCH_FEATURES = { machineEnabled: true, originEnabled: true };

export interface SavedSearchFilter {
  id: string;
  name: string;
  query: string;
  created_at: string;
  updated_at: string;
}

export interface RecentSearchFilter {
  query: string;
  used_at: string;
}

function validQuery(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > MAX_QUERY_LENGTH) return false;
  return compileAlertSearch(value, SEARCH_FEATURES).ok || compileDecisionSearch(value, SEARCH_FEATURES).ok;
}

function validName(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.trim().length <= MAX_NAME_LENGTH;
}

function readBody(context: any): Promise<Record<string, unknown>> {
  return context.req.json().then((body: unknown) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid JSON object');
    return body as Record<string, unknown>;
  });
}

function listSaved(database: CrowdsecDatabase, ownerId: number): SavedSearchFilter[] {
  return database.db.query(`
    SELECT id, name, query, created_at, updated_at FROM saved_search_filters
    WHERE owner_id = ? ORDER BY name COLLATE NOCASE, id
  `).all(ownerId) as SavedSearchFilter[];
}

function listRecent(database: CrowdsecDatabase, ownerId: number): RecentSearchFilter[] {
  const rows = database.db.query(`
    SELECT query, used_at_ms FROM recent_search_filters
    WHERE owner_id = ? ORDER BY used_at_ms DESC LIMIT ${RECENT_FILTER_LIMIT}
  `).all(ownerId) as Array<{ query: string; used_at_ms: number }>;
  return rows.map((row) => ({ query: row.query, used_at: new Date(row.used_at_ms).toISOString() }));
}

export function registerSavedFilterRoutes(options: {
  app: Hono;
  basePath: string;
  database: CrowdsecDatabase;
  auth: DashboardAuth;
  writeDatabase: <T>(operation: () => T) => Promise<T>;
}): void {
  const { app, basePath, database, auth, writeDatabase } = options;
  const root = `${basePath}/api/search-filters`;
  const owner = (context: any) => auth.getSession(context)!.userId;

  app.get(root, auth.ensureAuth, (context) => context.json({
    saved: listSaved(database, owner(context)),
    recent: listRecent(database, owner(context)),
    shared: !auth.enabled,
  }));

  app.post(`${root}/saved`, auth.ensureAuth, async (context) => {
    let body: Record<string, unknown>;
    try { body = await readBody(context); } catch { return context.json({ error: 'Invalid JSON body' }, 400); }
    if (!validName(body.name)) return context.json({ error: `Name must be 1-${MAX_NAME_LENGTH} characters` }, 400);
    if (!validQuery(body.query)) return context.json({ error: 'Query is empty, too long, or invalid' }, 400);
    const name = body.name.trim();
    const query = body.query.trim();
    const result = await writeDatabase(() => {
      const ownerId = owner(context);
      const duplicate = database.db.query('SELECT 1 FROM saved_search_filters WHERE owner_id = ? AND name = ?').get(ownerId, name);
      if (duplicate) return 'duplicate' as const;
      const count = database.db.query('SELECT COUNT(*) AS count FROM saved_search_filters WHERE owner_id = ?').get(ownerId) as { count: number };
      if (count.count >= MAX_SAVED_FILTERS) return 'limit' as const;
      const entry: SavedSearchFilter = { id: randomUUID(), name, query, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      database.db.query(`INSERT INTO saved_search_filters (id, owner_id, name, query, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(entry.id, ownerId, entry.name, entry.query, entry.created_at, entry.updated_at);
      return entry;
    });
    if (result === 'duplicate') return context.json({ error: 'A saved filter with this name already exists' }, 409);
    if (result === 'limit') return context.json({ error: 'Saved filter limit reached' }, 409);
    return context.json(result, 201);
  });

  app.patch(`${root}/saved/:id`, auth.ensureAuth, async (context) => {
    let body: Record<string, unknown>;
    try { body = await readBody(context); } catch { return context.json({ error: 'Invalid JSON body' }, 400); }
    if (!validName(body.name)) return context.json({ error: `Name must be 1-${MAX_NAME_LENGTH} characters` }, 400);
    const name = body.name.trim();
    const result = await writeDatabase(() => {
      const ownerId = owner(context);
      const id = context.req.param('id');
      const existing = database.db.query('SELECT id FROM saved_search_filters WHERE id = ? AND owner_id = ?').get(id, ownerId);
      if (!existing) return 'missing' as const;
      const duplicate = database.db.query('SELECT 1 FROM saved_search_filters WHERE owner_id = ? AND name = ? AND id <> ?').get(ownerId, name, id);
      if (duplicate) return 'duplicate' as const;
      const updatedAt = new Date().toISOString();
      database.db.query('UPDATE saved_search_filters SET name = ?, updated_at = ? WHERE id = ? AND owner_id = ?').run(name, updatedAt, id, ownerId);
      return database.db.query('SELECT id, name, query, created_at, updated_at FROM saved_search_filters WHERE id = ? AND owner_id = ?').get(id, ownerId) as SavedSearchFilter;
    });
    if (result === 'missing') return context.json({ error: 'Saved filter not found' }, 404);
    if (result === 'duplicate') return context.json({ error: 'A saved filter with this name already exists' }, 409);
    return context.json(result);
  });

  app.delete(`${root}/saved/:id`, auth.ensureAuth, async (context) => {
    const deleted = await writeDatabase(() => database.db.query('DELETE FROM saved_search_filters WHERE id = ? AND owner_id = ?').run(context.req.param('id'), owner(context)).changes);
    if (!deleted) return context.json({ error: 'Saved filter not found' }, 404);
    return context.json({ success: true });
  });

  app.post(`${root}/recent`, auth.ensureAuth, async (context) => {
    let body: Record<string, unknown>;
    try { body = await readBody(context); } catch { return context.json({ error: 'Invalid JSON body' }, 400); }
    if (!validQuery(body.query)) return context.json({ error: 'Query is empty, too long, or invalid' }, 400);
    const query = body.query.trim();
    const recent = await writeDatabase(() => {
      const ownerId = owner(context);
      const latest = database.db.query('SELECT MAX(used_at_ms) AS latest FROM recent_search_filters WHERE owner_id = ?').get(ownerId) as { latest: number | null };
      const usedAt = Math.max(Date.now(), (latest.latest ?? 0) + 1);
      database.db.query(`INSERT INTO recent_search_filters (owner_id, query, used_at_ms) VALUES (?, ?, ?)
        ON CONFLICT(owner_id, query) DO UPDATE SET used_at_ms = excluded.used_at_ms`).run(ownerId, query, usedAt);
      database.db.query(`DELETE FROM recent_search_filters WHERE owner_id = ? AND query NOT IN
        (SELECT query FROM recent_search_filters WHERE owner_id = ? ORDER BY used_at_ms DESC LIMIT ${RECENT_FILTER_LIMIT})`).run(ownerId, ownerId);
      return listRecent(database, ownerId);
    });
    return context.json({ recent });
  });

  app.delete(`${root}/recent`, auth.ensureAuth, async (context) => {
    await writeDatabase(() => database.db.query('DELETE FROM recent_search_filters WHERE owner_id = ?').run(owner(context)));
    return context.json({ success: true });
  });
}
