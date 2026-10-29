import crypto from 'node:crypto';
import type { Hono } from 'hono';
import type {
  AllowlistCheckInstanceResult,
  AllowlistSyncProgress,
  AllowlistCheckResponse,
  AllowlistEntriesResponse,
  AllowlistEntry,
  AllowlistInstanceStatus,
  AllowlistsResponse,
  AllowlistSourceStatus,
  AllowlistSummary,
} from '../../shared/contracts';
import type { RuntimeConfig } from '../config';
import { ALLOWLIST_SYNC_META_PREFIX, type CachedAllowlist, type CrowdsecDatabase } from '../database';
import type { LapiAllowlist, LapiClient } from '../lapi';
import type { DatabaseQueryWorker } from '../query-worker-client';
import type { DatabaseSyncWorker } from '../sync-worker-client';
import { getPageRequest } from './request-parsing';

type HonoContext = any;
type HonoMiddleware = (context: HonoContext, next: () => Promise<void>) => Promise<Response | void>;
type ConfiguredInstance = RuntimeConfig['instances'][number];
type RunConsistentDatabaseRefresh = <T>(
  operation: () => Promise<T>,
  options?: { requiresPublication?: (result: T) => boolean },
) => Promise<{ result: T; releasePublishedRevision: () => void }>;

export type AllowlistService = ReturnType<typeof createAllowlistService>;

/** Persisted per instance, so restarts keep the last known status and skip unchanged snapshots. */
interface AllowlistSyncState {
  status: AllowlistSourceStatus;
  error?: string;
  /** Hash of the last cached snapshot. */
  hash?: string;
}

interface AllowlistRow {
  instance_id: string;
  name: string;
  description: string | null;
  created_at: string | null;
  updated_at: string | null;
  console_managed: number;
}

interface EntryRow {
  value: string;
  description: string | null;
  created_at: string | null;
  expiration: string;
  instance_ids: string;
}

const NEVER_EXPIRES = '9999-12-31T23:59:59.999Z';
const INSTANCE_ID_SEPARATOR = '\u001f';

// go-openapi serializes unset timestamps as the zero time instead of omitting them.
// Stored timestamps are normalized so SQL can compare them as text.
function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).getUTCFullYear() > 1 ? new Date(time).toISOString() : undefined;
}

function normalizeAllowlists(allowlists: LapiAllowlist[]): CachedAllowlist[] {
  const byName = new Map<string, CachedAllowlist>();
  for (const allowlist of allowlists) {
    const name = allowlist.name || '';
    if (byName.has(name)) continue;
    const items = new Map<string, CachedAllowlist['items'][number]>();
    for (const item of Array.isArray(allowlist.items) ? allowlist.items : []) {
      if (typeof item?.value !== 'string' || !item.value || items.has(item.value)) continue;
      const createdAt = normalizeTimestamp(item.created_at);
      items.set(item.value, {
        value: item.value,
        ...(item.description ? { description: item.description } : {}),
        ...(createdAt ? { created_at: createdAt } : {}),
        expiration: normalizeTimestamp(item.expiration) ?? null,
      });
    }
    const createdAt = normalizeTimestamp(allowlist.created_at);
    const updatedAt = normalizeTimestamp(allowlist.updated_at);
    byName.set(name, {
      name,
      ...(allowlist.allowlist_id ? { allowlist_id: allowlist.allowlist_id } : {}),
      ...(allowlist.description ? { description: allowlist.description } : {}),
      ...(createdAt ? { created_at: createdAt } : {}),
      ...(updatedAt ? { updated_at: updatedAt } : {}),
      console_managed: allowlist.console_managed === true,
      items: Array.from(items.values()),
    });
  }
  return Array.from(byName.values());
}

// LAPI versions without allowlist routes answer 404 from their catch-all handler.
function failureStatus(error: unknown): Exclude<AllowlistSourceStatus, 'available'> {
  return (error as { status?: number } | null)?.status === 404 ? 'unsupported' : 'unavailable';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function textMatches(value: string | null | undefined, query: string): boolean {
  return Boolean(value?.toLowerCase().includes(query.toLowerCase()));
}

export function createAllowlistService(options: {
  config: RuntimeConfig;
  lapiClients: Map<string, LapiClient>;
  database: CrowdsecDatabase;
  queryWorker: DatabaseQueryWorker;
  syncWorker: Partial<Pick<DatabaseSyncWorker, 'replaceAllowlists'>>;
  runConsistentDatabaseRefresh: RunConsistentDatabaseRefresh;
  /** Notifies open pages after cached allowlists or their status changed. */
  onChange: (instanceIds: string[]) => void;
}) {
  const { config, lapiClients, database, queryWorker, syncWorker, runConsistentDatabaseRefresh, onChange } = options;
  const syncs = new Map<string, Promise<void>>();
  const progress = new Map<string, AllowlistSyncProgress>();
  const instanceOrder = (instanceId: string) => config.instances.findIndex((instance) => instance.id === instanceId);
  const byInstanceOrder = (left: string, right: string) => instanceOrder(left) - instanceOrder(right);

  function resolveScope(scope: string | undefined): ConfiguredInstance[] | null {
    if (!scope || scope === 'all') return config.instances;
    const instance = config.instances.find((candidate) => candidate.id === scope);
    return instance ? [instance] : null;
  }

  function readSyncState(instanceId: string): AllowlistSyncState | null {
    const value = database.getMeta(`${ALLOWLIST_SYNC_META_PREFIX}${instanceId}`)?.value;
    if (!value) return null;
    try {
      return JSON.parse(value) as AllowlistSyncState;
    } catch {
      return null;
    }
  }

  async function runSync(instanceId: string): Promise<void> {
    const instance = config.instances.find((candidate) => candidate.id === instanceId);
    const client = lapiClients.get(instanceId);
    if (!instance || !client) return;
    const previous = readSyncState(instanceId);
    progress.set(instanceId, { state: 'syncing' });
    let snapshot: CachedAllowlist[] | null = null;
    let next: AllowlistSyncState;
    try {
      snapshot = normalizeAllowlists(await client.fetchAllowlists());
      next = { status: 'available', hash: crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
    } catch (error) {
      // A failed read keeps the cached allowlists, like a failed alert refresh.
      const status = failureStatus(error);
      next = {
        status,
        ...(status === 'unavailable' ? { error: errorMessage(error) } : {}),
        ...(previous?.hash ? { hash: previous.hash } : {}),
      };
    }
    const snapshotChanged = snapshot !== null && next.hash !== previous?.hash;
    const stateChanged = JSON.stringify(next) !== JSON.stringify(previous);
    const finished: AllowlistSyncProgress = snapshot
      ? {
          state: 'complete',
          allowlists: snapshot.length,
          entries: snapshot.reduce((sum, allowlist) => sum + allowlist.items.length, 0),
        }
      : next.status === 'unsupported'
        ? { state: 'unsupported' }
        : { state: 'failed', ...(next.error ? { error: next.error } : {}) };
    if (!snapshotChanged && !stateChanged) {
      progress.set(instanceId, finished);
      return;
    }

    const changedSnapshot = snapshotChanged ? snapshot : null;
    const committed = await runConsistentDatabaseRefresh(async () => (syncWorker.replaceAllowlists
      ? syncWorker.replaceAllowlists(instanceId, changedSnapshot, JSON.stringify(next))
      // Injected test workers without this operation write through the main connection.
      : database.replaceAllowlists(instanceId, changedSnapshot, JSON.stringify(next))));
    committed.releasePublishedRevision();
    progress.set(instanceId, finished);
    if (snapshotChanged) {
      console.log(`[allowlists] Cached ${finished.allowlists} allowlists with ${finished.entries} entries for ${instance.name}.`);
    } else if (next.status !== 'available') {
      console.warn(`[allowlists] Could not refresh allowlists for ${instance.name}: ${next.error || 'not supported by this LAPI'}.`);
    }
    // Nothing could show this instance's allowlists before its first sync.
    if (previous) onChange([instanceId]);
  }

  /** Refreshes one instance's cached allowlists from LAPI; never throws into the caller's refresh. */
  function syncInstance(instanceId: string): Promise<void> {
    const running = syncs.get(instanceId);
    if (running) return running;
    const sync = runSync(instanceId)
      .catch((error) => {
        progress.set(instanceId, { state: 'failed', error: errorMessage(error) });
        console.error(`[allowlists] Sync failed for ${instanceId}: ${errorMessage(error)}`);
      })
      .finally(() => syncs.delete(instanceId));
    syncs.set(instanceId, sync);
    return sync;
  }

  function syncInstances(instanceIds: string[]): Promise<void> {
    return Promise.all(instanceIds.map(syncInstance)).then(() => undefined);
  }

  // Readers only wait for instances that were never synchronized.
  async function ensureSynced(instances: ConfiguredInstance[]): Promise<void> {
    await syncInstances(instances.filter((instance) => !readSyncState(instance.id)).map((instance) => instance.id));
  }

  function instanceStatuses(instances: ConfiguredInstance[]): AllowlistInstanceStatus[] {
    return instances.map((instance) => {
      const state = readSyncState(instance.id);
      return {
        instance_id: instance.id,
        instance_name: instance.name,
        ...(instance.icon ? { instance_icon: instance.icon } : {}),
        status: state?.status ?? 'unavailable',
        ...(state?.error ? { error: state.error } : {}),
      };
    });
  }

  function entryFilter(query: string): { sql: string; params: string[] } {
    if (!query) return { sql: '', params: [] };
    const pattern = likePattern(query);
    return { sql: `(value LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')`, params: [pattern, pattern] };
  }

  async function querySummaries(instances: ConfiguredInstance[], query: string, name?: string): Promise<AllowlistSummary[]> {
    const ids = instances.map((instance) => instance.id);
    const placeholders = ids.map(() => '?').join(', ');
    const nameFilter = name === undefined ? '' : 'AND name = ?';
    const itemNameFilter = name === undefined ? '' : 'AND allowlist_name = ?';
    const nameParams = name === undefined ? [] : [name];
    const now = new Date().toISOString();
    const rows = await queryWorker.all<AllowlistRow>(`
      SELECT instance_id, name, description, created_at, updated_at, console_managed
      FROM allowlists
      WHERE instance_id IN (${placeholders}) ${nameFilter}
    `, [...ids, ...nameParams]);
    const countSql = (filter: string) => `
      SELECT allowlist_name AS name, COUNT(DISTINCT value) AS count
      FROM allowlist_items
      WHERE instance_id IN (${placeholders}) ${itemNameFilter}
        AND (expiration IS NULL OR expiration > ?) ${filter ? `AND ${filter}` : ''}
      GROUP BY allowlist_name
    `;
    const totals = new Map((await queryWorker.all<{ name: string; count: number }>(countSql(''), [...ids, ...nameParams, now]))
      .map((row) => [row.name, row.count]));
    const filter = entryFilter(query);
    const matches = query
      ? new Map((await queryWorker.all<{ name: string; count: number }>(countSql(filter.sql), [...ids, ...nameParams, now, ...filter.params]))
        .map((row) => [row.name, row.count]))
      : totals;

    const summaries = new Map<string, AllowlistSummary>();
    for (const row of rows.sort((left, right) => byInstanceOrder(left.instance_id, right.instance_id))) {
      let summary = summaries.get(row.name);
      if (!summary) {
        summary = {
          name: row.name,
          ...(row.description ? { description: row.description } : {}),
          ...(row.created_at ? { created_at: row.created_at } : {}),
          console_managed: false,
          instance_ids: [],
          entry_count: totals.get(row.name) ?? 0,
          matching_entries: 0,
        };
        summaries.set(row.name, summary);
      }
      summary.instance_ids.push(row.instance_id);
      summary.console_managed ||= row.console_managed === 1;
      if (row.updated_at && (!summary.updated_at || row.updated_at > summary.updated_at)) summary.updated_at = row.updated_at;
    }
    return Array.from(summaries.values())
      .flatMap((summary) => {
        // A filter matching the allowlist itself keeps every entry.
        const listMatches = textMatches(summary.name, query) || textMatches(summary.description, query);
        const matching = !query || listMatches ? summary.entry_count : matches.get(summary.name) ?? 0;
        // A requested allowlist stays listed so its page can report zero matches.
        return name === undefined && query && !listMatches && matching === 0 ? [] : [{ ...summary, matching_entries: matching }];
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async function listAllowlists(instances: ConfiguredInstance[], query = ''): Promise<AllowlistsResponse> {
    const statuses = instanceStatuses(instances);
    return {
      instances: statuses,
      allowlists: await querySummaries(instances, query.trim()),
      partial: statuses.some((instance) => instance.status === 'unavailable'),
    };
  }

  async function listEntries(
    instances: ConfiguredInstance[],
    name: string,
    page: { page: number; pageSize: number },
    rawQuery = '',
  ): Promise<AllowlistEntriesResponse | null> {
    const query = rawQuery.trim();
    const [allowlist] = await querySummaries(instances, query, name);
    if (!allowlist) return null;
    const keepsEveryEntry = textMatches(allowlist.name, query) || textMatches(allowlist.description, query);
    const filter = entryFilter(keepsEveryEntry ? '' : query);
    const ids = instances.map((instance) => instance.id);
    const placeholders = ids.map(() => '?').join(', ');
    // Match after grouping so every active copy contributes membership and metadata.
    const rows = await queryWorker.all<EntryRow>(`
      SELECT
        value,
        MAX(description) AS description,
        MIN(created_at) AS created_at,
        MAX(COALESCE(expiration, ?)) AS expiration,
        group_concat(instance_id, ?) AS instance_ids
      FROM allowlist_items
      WHERE allowlist_name = ? AND instance_id IN (${placeholders})
        AND (expiration IS NULL OR expiration > ?)
      GROUP BY value
      ${filter.sql ? `HAVING MAX(${filter.sql}) = 1` : ''}
      ORDER BY MIN(created_at) DESC, value
      LIMIT ? OFFSET ?
    `, [
      NEVER_EXPIRES,
      INSTANCE_ID_SEPARATOR,
      name,
      ...ids,
      new Date().toISOString(),
      ...filter.params,
      page.pageSize,
      (page.page - 1) * page.pageSize,
    ]);
    const data: AllowlistEntry[] = rows.map((row) => ({
      value: row.value,
      ...(row.description ? { description: row.description } : {}),
      ...(row.created_at ? { created_at: row.created_at } : {}),
      expiration: row.expiration === NEVER_EXPIRES ? null : row.expiration,
      instance_ids: row.instance_ids.split(INSTANCE_ID_SEPARATOR).sort(byInstanceOrder),
    }));
    const total = allowlist.matching_entries;
    return {
      allowlist,
      data,
      pagination: {
        page: page.page,
        page_size: page.pageSize,
        total,
        total_pages: Math.ceil(total / page.pageSize),
        unfiltered_total: allowlist.entry_count,
      },
    };
  }

  async function checkValue(instances: ConfiguredInstance[], value: string): Promise<AllowlistCheckResponse> {
    // Checks stay live: LAPI matches ranges, and the decision guard needs the current state.
    const results = await Promise.all(instances.map(async (instance): Promise<AllowlistCheckInstanceResult> => {
      const base = {
        instance_id: instance.id,
        instance_name: instance.name,
        ...(instance.icon ? { instance_icon: instance.icon } : {}),
      };
      try {
        const result = await lapiClients.get(instance.id)!.checkAllowlist(value);
        return { ...base, status: 'available', ...result };
      } catch (error) {
        const status = failureStatus(error);
        return { ...base, status, allowlisted: false, ...(status === 'unavailable' ? { error: errorMessage(error) } : {}) };
      }
    }));
    return {
      value,
      allowlisted: results.some((result) => result.allowlisted),
      results,
    };
  }

  /** Progress of the latest sync, for the sync overlay. */
  function getSyncProgress(instanceId: string): AllowlistSyncProgress {
    return { ...(progress.get(instanceId) ?? { state: 'pending' }) };
  }

  return { resolveScope, ensureSynced, getSyncProgress, syncInstance, syncInstances, listAllowlists, listEntries, checkValue };
}

export function registerAllowlistRoutes(options: {
  app: Hono;
  basePath: string;
  ensureAuth: HonoMiddleware;
  ensurePublishedRevisionRead: HonoMiddleware;
  allowlistService: AllowlistService;
  isValidIpOrRange: (value: string) => boolean;
}): void {
  const { app, basePath, ensureAuth, ensurePublishedRevisionRead, allowlistService, isValidIpOrRange } = options;
  const unknownScope = (context: HonoContext, scope: string | undefined) => (
    context.json({ error: `Unknown CrowdSec instance scope "${scope}"` }, 404)
  );

  // Syncing writes the cache, so it must finish before the published-revision read starts.
  const ensureScopeSynced: HonoMiddleware = async (context, next) => {
    const instances = allowlistService.resolveScope(context.req.query('instance'));
    if (instances) await allowlistService.ensureSynced(instances);
    await next();
  };

  // Allowlists are read-only through LAPI, so read-only users may view them too.
  app.get(`${basePath}/api/allowlists`, ensureAuth, ensureScopeSynced, ensurePublishedRevisionRead, async (context) => {
    const scope = context.req.query('instance');
    const instances = allowlistService.resolveScope(scope);
    if (!instances) return unknownScope(context, scope);
    return context.json(await allowlistService.listAllowlists(instances, context.req.query('q') || ''));
  });

  app.get(`${basePath}/api/allowlists/check`, ensureAuth, async (context) => {
    const value = context.req.query('value')?.trim() || '';
    if (!isValidIpOrRange(value)) return context.json({ error: 'A valid IP address or range is required' }, 400);
    const scope = context.req.query('instance');
    const instances = allowlistService.resolveScope(scope);
    if (!instances) return unknownScope(context, scope);
    return context.json(await allowlistService.checkValue(instances, value));
  });

  app.get(`${basePath}/api/allowlists/:name/entries`, ensureAuth, ensureScopeSynced, ensurePublishedRevisionRead, async (context) => {
    const scope = context.req.query('instance');
    const instances = allowlistService.resolveScope(scope);
    if (!instances) return unknownScope(context, scope);
    const page = getPageRequest(context) ?? { page: 1, pageSize: 50 };
    const response = await allowlistService.listEntries(instances, context.req.param('name'), page, context.req.query('q') || '');
    if (!response) return context.json({ error: 'Unknown allowlist' }, 404);
    return context.json(response);
  });
}
