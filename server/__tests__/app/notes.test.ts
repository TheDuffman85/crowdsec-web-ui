import { describe, expect, test } from 'vitest';
import { MAX_NOTE_LENGTH, normalizeSubject } from '../../app/notes';
import { createAuthSessionCookie, createController } from './harness';

const root = 'http://localhost/crowdsec/api/notes';

async function request(controller: ReturnType<typeof createController>['controller'], path = '', options: {
  method?: string;
  cookie?: string;
  body?: unknown;
} = {}) {
  return await controller.fetch(new Request(`${root}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  }));
}

function setup() {
  const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
  const adminId = controller.database.createAuthUser({ username: 'admin', passwordHash: 'hash', role: 'admin', authProvider: 'password' });
  const aliceId = controller.database.createAuthUser({ username: 'alice', passwordHash: 'hash', role: 'read-only', authProvider: 'password' });
  const bobId = controller.database.createAuthUser({ username: 'bob', passwordHash: 'hash', role: 'read-only', authProvider: 'password' });
  const cookie = (userId: number, username: string, role: 'admin' | 'read-only') => createAuthSessionCookie(controller.database, { userId, username, role, authMethod: 'password' });
  return {
    controller,
    admin: cookie(adminId, 'admin', 'admin'),
    alice: cookie(aliceId, 'alice', 'read-only'),
    bob: cookie(bobId, 'bob', 'read-only'),
  };
}

describe('subject normalisation', () => {
  const isIp = (value: string) => /^[0-9a-f.:/]+$/i.test(value);
  test('lower-cases IPs and rejects malformed subjects', () => {
    expect(normalizeSubject('ip', ' 2001:DB8::1 ', isIp)).toBe('2001:db8::1');
    expect(normalizeSubject('ip', 'not an ip', isIp)).toBeNull();
    expect(normalizeSubject('ip', 42, isIp)).toBeNull();
    expect(normalizeSubject('alert', 'abc-123', isIp)).toBe('abc-123');
    expect(normalizeSubject('alert', 'a b', isIp)).toBeNull();
    expect(normalizeSubject('alert', 'x'.repeat(65), isIp)).toBeNull();
  });
});

describe('notes API', () => {
  test('requires a signed-in user', async () => {
    const { controller } = setup();
    expect((await request(controller, '?type=ip&subject=1.2.3.4')).status).toBe(401);
    expect((await request(controller, '', { method: 'POST', body: { subject_type: 'ip', subject: '1.2.3.4', body: 'x' } })).status).toBe(401);
  });

  test('lets several users share notes on an IP and keeps authorship', async () => {
    const { controller, admin, alice, bob } = setup();
    const first = await request(controller, '', { method: 'POST', cookie: alice, body: { subject_type: 'ip', subject: '1.2.3.4', body: '  Known scanner  ' } });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ author_name: 'alice', body: 'Known scanner', can_edit: true, can_delete: true });
    expect((await request(controller, '', { method: 'POST', cookie: bob, body: { subject_type: 'ip', subject: '1.2.3.4', body: 'Ours, ignore' } })).status).toBe(201);

    const asBob = await request(controller, '?type=ip&subject=1.2.3.4', { cookie: bob }).then((response) => response.json()) as { notes: Array<{ author_name: string; can_edit: boolean; can_delete: boolean }> };
    expect(asBob.notes.map((note) => [note.author_name, note.can_edit, note.can_delete])).toEqual([['alice', false, false], ['bob', true, true]]);
    const asAdmin = await request(controller, '?type=ip&subject=1.2.3.4', { cookie: admin }).then((response) => response.json()) as { notes: Array<{ can_edit: boolean; can_delete: boolean }> };
    expect(asAdmin.notes.map((note) => [note.can_edit, note.can_delete])).toEqual([[false, true], [false, true]]);
    const other = await request(controller, '?type=ip&subject=5.6.7.8', { cookie: bob }).then((response) => response.json()) as { notes: unknown[] };
    expect(other.notes).toEqual([]);
  });

  test('keeps IP notes and alert notes separate', async () => {
    const { controller, alice } = setup();
    await request(controller, '', { method: 'POST', cookie: alice, body: { subject_type: 'alert', subject: '42', body: 'Alert note' } });
    const ipNotes = await request(controller, '?type=ip&subject=1.2.3.4', { cookie: alice }).then((response) => response.json()) as { notes: unknown[] };
    const alertNotes = await request(controller, '?type=alert&subject=42', { cookie: alice }).then((response) => response.json()) as { notes: unknown[] };
    expect(ipNotes.notes).toHaveLength(0);
    expect(alertNotes.notes).toHaveLength(1);
  });

  test('only authors edit; authors and administrators delete', async () => {
    const { controller, admin, alice, bob } = setup();
    const created = await request(controller, '', { method: 'POST', cookie: alice, body: { subject_type: 'ip', subject: '1.2.3.4', body: 'Mine' } }).then((response) => response.json()) as { id: string };
    expect((await request(controller, `/${created.id}`, { method: 'PATCH', cookie: bob, body: { body: 'Hijack' } })).status).toBe(403);
    expect((await request(controller, `/${created.id}`, { method: 'PATCH', cookie: admin, body: { body: 'Reworded' } })).status).toBe(403);
    const edited = await request(controller, `/${created.id}`, { method: 'PATCH', cookie: alice, body: { body: 'Updated' } });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ body: 'Updated' });
    expect((await request(controller, `/${created.id}`, { method: 'DELETE', cookie: bob })).status).toBe(403);
    expect((await request(controller, `/${created.id}`, { method: 'DELETE', cookie: admin })).status).toBe(200);
    expect((await request(controller, `/${created.id}`, { method: 'DELETE', cookie: admin })).status).toBe(404);
    expect((await request(controller, `/${created.id}`, { method: 'PATCH', cookie: alice, body: { body: 'Gone' } })).status).toBe(404);
  });

  test('validates input', async () => {
    const { controller, alice } = setup();
    const post = (body: unknown) => request(controller, '', { method: 'POST', cookie: alice, body });
    expect((await post({ subject_type: 'host', subject: 'x', body: 'y' })).status).toBe(400);
    expect((await post({ subject_type: 'ip', subject: 'bogus', body: 'y' })).status).toBe(400);
    expect((await post({ subject_type: 'ip', subject: '1.2.3.4', body: '   ' })).status).toBe(400);
    expect((await post({ subject_type: 'ip', subject: '1.2.3.4', body: 'x'.repeat(MAX_NOTE_LENGTH + 1) })).status).toBe(400);
    expect((await request(controller, '?type=ip&subject=bogus', { cookie: alice })).status).toBe(400);
    expect((await request(controller, '?type=nope&subject=1.2.3.4', { cookie: alice })).status).toBe(400);
  });

  test('works for the shared session when authentication is disabled', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'false' } });
    const created = await request(controller, '', { method: 'POST', body: { subject_type: 'ip', subject: '1.2.3.4', body: 'Solo' } });
    expect(created.status).toBe(201);
    const list = await request(controller, '?type=ip&subject=1.2.3.4').then((response) => response.json()) as { notes: Array<{ can_edit: boolean }> };
    expect(list.notes).toHaveLength(1);
    expect(list.notes[0].can_edit).toBe(true);
  });
});
