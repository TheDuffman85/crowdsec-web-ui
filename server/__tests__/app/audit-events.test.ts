import { describe, expect, test, vi } from 'vitest';
import { createAuditLogger } from '../../audit-log';
import { AUDIT_EVENT_LIMIT, auditTarget, insertAuditEvent, queryAuditEvents } from '../../app/audit-events';
import { createAuthSessionCookie, createController } from './harness';

const entry = (overrides: Record<string, unknown> = {}) => ({
  time: '2026-11-20T10:00:00.000Z', user: 'tommy', role: 'admin', action: 'decision.add' as const, outcome: 'success' as const, ip: '203.0.113.5', reason: 'scanner', ...overrides,
});

describe('auditTarget', () => {
  test('picks the most useful subject', () => {
    expect(auditTarget(entry())).toBe('203.0.113.5');
    expect(auditTarget(entry({ ip: undefined, target_username: 'alice' }))).toBe('alice');
    expect(auditTarget(entry({ ip: undefined, values: ['198.51.100.1', '198.51.100.2'] }))).toBe('2 values');
    expect(auditTarget(entry({ ip: undefined, alert_ids: [7] }))).toBe('alert 7');
    expect(auditTarget(entry({ ip: undefined, alert_ids: [7, 8, 9] }))).toBe('3 alerts');
    expect(auditTarget(entry({ ip: undefined, decision_ids: [4] }))).toBe('decision 4');
    expect(auditTarget(entry({ ip: undefined }))).toBeNull();
  });
});

describe('audit event storage', () => {
  function setup() {
    const { controller } = createController();
    const database = controller.database;
    insertAuditEvent(database, entry());
    insertAuditEvent(database, entry({ time: '2026-11-21T10:00:00.000Z', user: 'alice', action: 'decision.delete', ip: undefined, decision_ids: [4], outcome: 'partial' }));
    insertAuditEvent(database, entry({ time: '2026-11-22T10:00:00.000Z', user: 'auto-ban', role: 'system', ip: '198.51.100.9', reason: 'auto-ban: SSH' }));
    return database;
  }

  test('returns newest first and keeps details', () => {
    const { data, total } = queryAuditEvents(setup(), {}, 1, 10);
    expect(total).toBe(3);
    expect(data.map((row) => row.user)).toEqual(['auto-ban', 'alice', 'tommy']);
    expect(data[2]).toMatchObject({ target: '203.0.113.5', details: { ip: '203.0.113.5', reason: 'scanner' } });
    expect(data[2]!.details).not.toHaveProperty('user');
  });

  test('filters by user, action, outcome, date, text and target', () => {
    const database = setup();
    const ids = (filters: Parameters<typeof queryAuditEvents>[1]) => queryAuditEvents(database, filters, 1, 10).data.map((row) => row.user);
    expect(ids({ user: 'alice' })).toEqual(['alice']);
    expect(ids({ action: 'decision.add' })).toEqual(['auto-ban', 'tommy']);
    expect(ids({ outcome: 'partial' })).toEqual(['alice']);
    expect(ids({ from: '2026-11-21T00:00:00.000Z', to: '2026-11-21T23:59:59.999Z' })).toEqual(['alice']);
    expect(ids({ q: 'auto-ban:' })).toEqual(['auto-ban']);
    expect(ids({ q: '%' })).toEqual([]);
    expect(ids({ target: '203.0.113.5' })).toEqual(['tommy']);
  });

  test('paginates', () => {
    const database = setup();
    expect(queryAuditEvents(database, {}, 2, 2)).toMatchObject({ total: 3, data: [{ user: 'tommy' }] });
  });

  test('prunes the oldest rows once the cap is exceeded', () => {
    const { controller } = createController();
    const database = controller.database;
    const insert = database.db.query("INSERT INTO audit_events (time, user, action, outcome, details) VALUES ('2026-01-01T00:00:00Z', 'u', 'a', 'success', '{}')");
    database.db.exec('BEGIN');
    for (let i = 0; i < AUDIT_EVENT_LIMIT + 150; i += 1) insert.run();
    database.db.exec('COMMIT');
    // Pruning runs every 200th entry, so keep adding until one does.
    for (let i = 0; i < 200; i += 1) insertAuditEvent(database, entry());
    const total = (database.db.query('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number }).count;
    expect(total).toBeLessThanOrEqual(AUDIT_EVENT_LIMIT + 199);
    expect(total).toBeGreaterThanOrEqual(AUDIT_EVENT_LIMIT);
    const oldest = (database.db.query('SELECT MIN(id) AS id FROM audit_events').get() as { id: number }).id;
    expect(oldest).toBeGreaterThan(150);
  });
});

describe('audit logger store', () => {
  test('hands every entry to the store, including system actions, and survives a failing store', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = vi.fn();
    const logger = createAuditLogger({ enabled: true, getActor: () => ({ username: 'tommy', role: 'admin' }), store });
    logger.record({}, { action: 'decision.add', outcome: 'success', ip: '203.0.113.5' });
    logger.recordSystem('auto-ban', { action: 'decision.add', outcome: 'success', ip: '203.0.113.6' });
    expect(store.mock.calls.map(([stored]) => [stored.user, stored.role, stored.ip])).toEqual([['tommy', 'admin', '203.0.113.5'], ['auto-ban', 'system', '203.0.113.6']]);
    store.mockImplementation(() => { throw new Error('disk full'); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => logger.record({}, { action: 'decision.add', outcome: 'success' })).not.toThrow();
    expect(error).toHaveBeenCalled();
    const disabled = createAuditLogger({ enabled: false, getActor: () => null, store });
    store.mockClear();
    disabled.recordSystem('x', { action: 'decision.add', outcome: 'success' });
    expect(store).not.toHaveBeenCalled();
    log.mockRestore();
    error.mockRestore();
  });
});

describe('audit log API', () => {
  const root = 'http://localhost/crowdsec/api/audit-log';

  test('is limited to administrators and filters rows', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
    const adminId = controller.database.createAuthUser({ username: 'admin', passwordHash: 'hash', role: 'admin', authProvider: 'password' });
    const viewerId = controller.database.createAuthUser({ username: 'viewer', passwordHash: 'hash', role: 'read-only', authProvider: 'password' });
    const admin = createAuthSessionCookie(controller.database, { userId: adminId, username: 'admin', role: 'admin', authMethod: 'password' });
    const viewer = createAuthSessionCookie(controller.database, { userId: viewerId, username: 'viewer', role: 'read-only', authMethod: 'password' });
    insertAuditEvent(controller.database, entry());
    insertAuditEvent(controller.database, entry({ user: 'alice', ip: '198.51.100.1' }));

    const get = (query: string, cookie?: string) => controller.fetch(new Request(`${root}${query}`, { headers: cookie ? { cookie } : {} }));
    expect((await get('')).status).toBe(401);
    expect((await get('', viewer)).status).toBe(403);
    const page = await (await get('?user=alice&date=ignored&from=2026-11-01&to=2026-11-30', admin)).json() as { data: Array<{ user: string }>; users: string[]; actions: string[]; pagination: { total: number } };
    expect(page.data.map((row) => row.user)).toEqual(['alice']);
    expect(page.pagination.total).toBe(1);
    expect(page.users).toEqual(['alice', 'tommy']);
    expect(page.actions).toEqual(['decision.add']);
    const second = await (await get('?page=2&page_size=1', admin)).json() as { users?: string[]; data: unknown[] };
    expect(second.users).toBeUndefined();
    expect(second.data).toHaveLength(1);
    expect((await (await get('?from=garbage', admin)).json() as { data: unknown[] }).data).toHaveLength(2);
  });
});
