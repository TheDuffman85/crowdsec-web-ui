import { describe, expect, test } from 'vitest';
import { insertAuditEvent } from '../../app/audit-events';
import { buildIpTimeline } from '../../app/ip-timeline';
import { createAuthSessionCookie, createController, sampleAlert, seedAlert } from './harness';

const IP = '203.0.113.50';

function seedTimeline() {
  const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
  const database = controller.database;
  const alert = (id: number, created: string, scenario: string, extra: Record<string, unknown> = {}) => seedAlert(database, sampleAlert({
    id, uuid: `tl-${id}`, created_at: created, scenario, source: { ip: IP, value: IP, cn: 'DE' }, machine_id: 'web-01',
    decisions: [{ id: id * 10, type: 'ban', value: IP, duration: '4h', created_at: created, stop_at: '2026-12-31T00:00:00.000Z', origin: 'crowdsec', simulated: false }],
    ...extra,
  } as never));
  alert(8001, '2026-11-18T10:00:00.000Z', 'crowdsecurity/ssh-bf');
  alert(8002, '2026-11-19T10:00:00.000Z', 'crowdsecurity/http-probing', { machine_id: 'web-02' });
  seedAlert(database, sampleAlert({ id: 8003, uuid: 'tl-other', created_at: '2026-11-19T11:00:00.000Z', source: { ip: '198.51.100.1', value: '198.51.100.1', cn: 'FR' } } as never));
  database.db.query(`INSERT INTO entity_notes (id, subject_type, subject, author_id, author_name, body, created_at, updated_at)
    VALUES ('n1', 'ip', ?, 1, 'alice', 'Known scanner', '2026-11-19T12:00:00.000Z', '2026-11-19T12:00:00.000Z'),
           ('n2', 'ip', '198.51.100.1', 1, 'alice', 'Other', '2026-11-19T12:00:00.000Z', '2026-11-19T12:00:00.000Z')`).run(IP);
  insertAuditEvent(database, { time: '2026-11-20T09:00:00.000Z', user: 'tommy', role: 'admin', action: 'decision.add', outcome: 'success', ip: IP, reason: 'manual' } as never);
  insertAuditEvent(database, { time: '2026-11-20T09:30:00.000Z', user: 'tommy', role: 'admin', action: 'decision.add', outcome: 'success', ip: '198.51.100.1' } as never);
  return { controller, database };
}

describe('buildIpTimeline', () => {
  test('merges alerts, decisions, notes and audit entries newest first', () => {
    const { database } = seedTimeline();
    const timeline = buildIpTimeline(database, IP, { includeAudit: true });
    expect(timeline.counts).toEqual({ alert: 2, decision: 2, note: 1, audit: 1 });
    expect(timeline.events[0]).toMatchObject({ kind: 'audit', title: 'decision.add', detail: { user: 'tommy', reason: 'manual', outcome: 'success' } });
    const times = timeline.events.map((event) => event.time);
    expect([...times].sort().reverse()).toEqual(times);
    expect(timeline.machines).toEqual(expect.arrayContaining(['web-01', 'web-02']));
    expect(timeline.instances.length).toBeGreaterThan(0);
    expect(timeline.events.find((event) => event.kind === 'note')).toMatchObject({ title: 'alice', detail: { body: 'Known scanner' } });
    expect(timeline.events.every((event) => JSON.stringify(event).indexOf('198.51.100.1') === -1)).toBe(true);
    expect(timeline.audit_included).toBe(true);
    expect(timeline.truncated).toBe(false);
  });

  test('leaves audit entries out unless allowed and applies the limit', () => {
    const { database } = seedTimeline();
    const timeline = buildIpTimeline(database, IP, { includeAudit: false, limit: 3 });
    expect(timeline.counts.audit).toBe(0);
    expect(timeline.audit_included).toBe(false);
    expect(timeline.events).toHaveLength(3);
    expect(timeline.truncated).toBe(true);
    expect(buildIpTimeline(database, '192.0.2.250', { includeAudit: true })).toMatchObject({ events: [], machines: [] });
  });
});

describe('ip timeline API', () => {
  test('requires a session and a valid address, and hides audit rows from non-admins', async () => {
    const { controller } = seedTimeline();
    const adminId = controller.database.createAuthUser({ username: 'admin', passwordHash: 'h', role: 'admin', authProvider: 'password' });
    const viewerId = controller.database.createAuthUser({ username: 'viewer', passwordHash: 'h', role: 'read-only', authProvider: 'password' });
    const admin = createAuthSessionCookie(controller.database, { userId: adminId, username: 'admin', role: 'admin', authMethod: 'password' });
    const viewer = createAuthSessionCookie(controller.database, { userId: viewerId, username: 'viewer', role: 'read-only', authMethod: 'password' });
    const get = (query: string, cookie?: string) => controller.fetch(new Request(`http://localhost/crowdsec/api/ip-timeline${query}`, { headers: cookie ? { cookie } : {} }));
    expect((await get(`?ip=${IP}`)).status).toBe(401);
    expect((await get('?ip=nope', admin)).status).toBe(400);
    const asAdmin = await (await get(`?ip=${IP}`, admin)).json() as { counts: { audit: number } };
    expect(asAdmin.counts.audit).toBe(1);
    const asViewer = await (await get(`?ip=${IP}&limit=2`, viewer)).json() as { counts: { audit: number }; events: unknown[]; audit_included: boolean };
    expect(asViewer.counts.audit).toBe(0);
    expect(asViewer.audit_included).toBe(false);
    expect(asViewer.events).toHaveLength(2);
  });
});
