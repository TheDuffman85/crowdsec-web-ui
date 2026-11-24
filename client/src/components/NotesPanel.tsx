import { useCallback, useEffect, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { addNote, deleteNote, fetchNotes, updateNote, type EntityNote, type NoteSubjectType } from '../lib/insightsApi';

const MAX_NOTE_LENGTH = 2000;

interface NotesPanelProps {
  type: NoteSubjectType;
  subject: string;
  title: string;
}

/** Shared notes on one IP address or alert; every signed-in user can add, authors edit, authors and admins delete. */
export function NotesPanel({ type, subject, title }: NotesPanelProps) {
  const { t } = useI18n();
  const [notes, setNotes] = useState<EntityNote[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const timeoutId = window.setTimeout(() => {
      setLoaded(false);
      setNotes([]);
      setError(null);
      fetchNotes(type, subject)
        .then((result) => { if (active) { setNotes(result); setLoaded(true); } })
        .catch(() => { if (active) { setError(t('components.notes.loadFailed')); setLoaded(true); } });
    }, 0);
    return () => { active = false; window.clearTimeout(timeoutId); };
  }, [type, subject, t]);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : t('components.notes.saveFailed'));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const handleAdd = () => run(async () => {
    const created = await addNote(type, subject, draft);
    setNotes((current) => [...current, created]);
    setDraft('');
  });

  const handleSaveEdit = () => run(async () => {
    if (!editing) return;
    const updated = await updateNote(editing.id, editing.body);
    setNotes((current) => current.map((note) => (note.id === updated.id ? updated : note)));
    setEditing(null);
  });

  const handleDelete = (id: string) => run(async () => {
    await deleteNote(id);
    setNotes((current) => current.filter((note) => note.id !== id));
  });

  const heading = `${title}${loaded && notes.length > 0 ? ` (${notes.length})` : ''}`;

  return (
    <section className="rounded-lg border border-gray-200 p-4 dark:border-gray-700" aria-label={title} data-testid={`notes-${type}`}>
      <h4 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">{heading}</h4>
      {loaded && notes.length === 0 && !error && (
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">{t('components.notes.empty')}</p>
      )}
      <ul className="mb-3 space-y-3">
        {notes.map((note) => (
          <li key={note.id} className="rounded-md bg-gray-50 p-3 text-sm dark:bg-gray-900/50">
            <div className="mb-1 flex items-center justify-between gap-2 text-xs text-gray-500 dark:text-gray-400">
              <span>
                {t('components.notes.byAuthor', { author: note.author_name, date: new Date(note.created_at).toLocaleString() })}
                {note.updated_at !== note.created_at && ` · ${t('components.notes.edited')}`}
              </span>
              {(note.can_edit || note.can_delete) && (
                <span className="flex gap-1">
                  {note.can_edit && editing?.id !== note.id && (
                    <button
                      type="button"
                      className="rounded p-1 hover:bg-gray-200 dark:hover:bg-gray-700"
                      aria-label={t('components.notes.edit')}
                      onClick={() => setEditing({ id: note.id, body: note.body })}
                    >
                      <Pencil size={14} aria-hidden="true" />
                    </button>
                  )}
                  {note.can_delete && (
                    <button
                      type="button"
                      className="rounded p-1 hover:bg-gray-200 dark:hover:bg-gray-700"
                      aria-label={t('components.notes.delete')}
                      disabled={busy}
                      onClick={() => void handleDelete(note.id)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  )}
                </span>
              )}
            </div>
            {editing?.id === note.id ? (
              <div className="space-y-2">
                <textarea
                  className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700"
                  rows={3}
                  maxLength={MAX_NOTE_LENGTH}
                  aria-label={t('components.notes.edit')}
                  value={editing.body}
                  onChange={(event) => setEditing({ id: note.id, body: event.target.value })}
                />
                <div className="flex gap-2">
                  <button type="button" className="rounded-md bg-primary-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-60" disabled={busy || !editing.body.trim()} onClick={() => void handleSaveEdit()}>
                    {t('components.notes.save')}
                  </button>
                  <button type="button" className="rounded-md border border-gray-300 px-3 py-1 text-xs dark:border-gray-600" onClick={() => setEditing(null)}>
                    {t('components.notes.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <p className="whitespace-pre-wrap break-words text-gray-900 dark:text-gray-100">{note.body}</p>
            )}
          </li>
        ))}
      </ul>
      <div className="space-y-2">
        <textarea
          className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700"
          rows={2}
          maxLength={MAX_NOTE_LENGTH}
          placeholder={t('components.notes.placeholder')}
          aria-label={t('components.notes.placeholder')}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="rounded-md bg-primary-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
            disabled={busy || !draft.trim()}
            onClick={() => void handleAdd()}
          >
            {t('components.notes.add')}
          </button>
          {error && <span role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</span>}
        </div>
      </div>
    </section>
  );
}
