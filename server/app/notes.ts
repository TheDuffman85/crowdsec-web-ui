import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import type { DashboardAuth } from '../app-auth';
import type { CrowdsecDatabase } from '../database';

export const MAX_NOTE_LENGTH = 2000;
export const MAX_NOTES_PER_SUBJECT = 200;
const MAX_SUBJECT_LENGTH = 64;
const SUBJECT_TYPES = ['ip', 'alert'] as const;

export type NoteSubjectType = (typeof SUBJECT_TYPES)[number];

export interface EntityNote {
  id: string;
  subject_type: NoteSubjectType;
  subject: string;
  author_id: number;
  author_name: string;
  body: string;
  created_at: string;
  updated_at: string;
  /** True for the author, the only person who can reword a note. */
  can_edit: boolean;
  /** True for the author and for administrators. */
  can_delete: boolean;
}

type NoteRow = Omit<EntityNote, 'can_edit' | 'can_delete'>;

function isSubjectType(value: unknown): value is NoteSubjectType {
  return typeof value === 'string' && (SUBJECT_TYPES as readonly string[]).includes(value);
}

/** IP notes follow the address, so they are keyed by its lower-case text; alert notes by the alert id. */
export function normalizeSubject(type: NoteSubjectType, value: unknown, isValidIpOrRange: (value: string) => boolean): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_SUBJECT_LENGTH) return null;
  if (type === 'ip') return isValidIpOrRange(trimmed) ? trimmed.toLowerCase() : null;
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : null;
}

function readBody(context: any): Promise<Record<string, unknown>> {
  return context.req.json().then((body: unknown) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid JSON object');
    return body as Record<string, unknown>;
  });
}

function validNoteBody(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.trim().length <= MAX_NOTE_LENGTH;
}

/**
 * Shared notes on IP addresses and alerts, stored in the application database.
 * Every signed-in user can read and add notes; authors edit and delete their
 * own notes, and administrators can delete any note.
 */
export function registerNoteRoutes(options: {
  app: Hono;
  basePath: string;
  database: CrowdsecDatabase;
  auth: DashboardAuth;
  isValidIpOrRange: (value: string) => boolean;
  writeDatabase: <T>(operation: () => T) => Promise<T>;
}): void {
  const { app, basePath, database, auth, isValidIpOrRange, writeDatabase } = options;
  const root = `${basePath}/api/notes`;
  const session = (context: any) => auth.getSession(context)!;

  const canManage = (context: any, authorId: number) => {
    const current = session(context);
    return current.role === 'admin' || current.userId === authorId;
  };
  const present = (context: any, row: NoteRow): EntityNote => ({ ...row, can_edit: session(context).userId === row.author_id, can_delete: canManage(context, row.author_id) });
  const select = 'SELECT id, subject_type, subject, author_id, author_name, body, created_at, updated_at FROM entity_notes';

  app.get(root, auth.ensureAuth, (context) => {
    const type = context.req.query('type');
    if (!isSubjectType(type)) return context.json({ error: 'Unknown note subject type' }, 400);
    const subject = normalizeSubject(type, context.req.query('subject'), isValidIpOrRange);
    if (!subject) return context.json({ error: 'Invalid note subject' }, 400);
    const rows = database.db.query(`${select} WHERE subject_type = ? AND subject = ? ORDER BY created_at, id`).all(type, subject) as NoteRow[];
    return context.json({ notes: rows.map((row) => present(context, row)) });
  });

  app.post(root, auth.ensureAuth, async (context) => {
    let body: Record<string, unknown>;
    try { body = await readBody(context); } catch { return context.json({ error: 'Invalid JSON body' }, 400); }
    if (!isSubjectType(body.subject_type)) return context.json({ error: 'Unknown note subject type' }, 400);
    const subject = normalizeSubject(body.subject_type, body.subject, isValidIpOrRange);
    if (!subject) return context.json({ error: 'Invalid note subject' }, 400);
    if (!validNoteBody(body.body)) return context.json({ error: `Note must be 1-${MAX_NOTE_LENGTH} characters` }, 400);
    const subjectType = body.subject_type;
    const text = body.body.trim();
    const author = session(context);
    const result = await writeDatabase(() => {
      const count = database.db.query('SELECT COUNT(*) AS count FROM entity_notes WHERE subject_type = ? AND subject = ?').get(subjectType, subject) as { count: number };
      if (count.count >= MAX_NOTES_PER_SUBJECT) return 'limit' as const;
      const now = new Date().toISOString();
      const row: NoteRow = { id: randomUUID(), subject_type: subjectType, subject, author_id: author.userId, author_name: author.username, body: text, created_at: now, updated_at: now };
      database.db.query(`INSERT INTO entity_notes (id, subject_type, subject, author_id, author_name, body, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.subject_type, row.subject, row.author_id, row.author_name, row.body, row.created_at, row.updated_at);
      return row;
    });
    if (result === 'limit') return context.json({ error: 'Note limit reached for this item' }, 409);
    return context.json(present(context, result), 201);
  });

  app.patch(`${root}/:id`, auth.ensureAuth, async (context) => {
    let body: Record<string, unknown>;
    try { body = await readBody(context); } catch { return context.json({ error: 'Invalid JSON body' }, 400); }
    if (!validNoteBody(body.body)) return context.json({ error: `Note must be 1-${MAX_NOTE_LENGTH} characters` }, 400);
    const text = body.body.trim();
    const id = context.req.param('id');
    const result = await writeDatabase(() => {
      const existing = database.db.query(`${select} WHERE id = ?`).get(id) as NoteRow | null;
      if (!existing) return 'missing' as const;
      // Only the author may rewrite a note; administrators can remove but not reword it.
      if (existing.author_id !== session(context).userId) return 'forbidden' as const;
      const updatedAt = new Date().toISOString();
      database.db.query('UPDATE entity_notes SET body = ?, updated_at = ? WHERE id = ?').run(text, updatedAt, id);
      return { ...existing, body: text, updated_at: updatedAt };
    });
    if (result === 'missing') return context.json({ error: 'Note not found' }, 404);
    if (result === 'forbidden') return context.json({ error: 'Only the author can edit this note' }, 403);
    return context.json(present(context, result));
  });

  app.delete(`${root}/:id`, auth.ensureAuth, async (context) => {
    const id = context.req.param('id');
    const result = await writeDatabase(() => {
      const existing = database.db.query(`${select} WHERE id = ?`).get(id) as NoteRow | null;
      if (!existing) return 'missing' as const;
      if (!canManage(context, existing.author_id)) return 'forbidden' as const;
      database.db.query('DELETE FROM entity_notes WHERE id = ?').run(id);
      return 'deleted' as const;
    });
    if (result === 'missing') return context.json({ error: 'Note not found' }, 404);
    if (result === 'forbidden') return context.json({ error: 'Only the author or an administrator can delete this note' }, 403);
    return context.json({ success: true });
  });
}
