import { useCallback, useRef, useState } from 'react';
import { Bookmark, SquarePen, Trash2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useI18n } from '../lib/i18n';
import {
  clearRecentFilters,
  createSavedFilter,
  deleteSavedFilter,
  fetchFilterLists,
  filterValidForPage,
  renameSavedFilter,
  recordRecentFilter,
  type FilterLists,
  type FilterPage,
} from '../lib/savedFilters';
import { Modal } from './ui/Modal';

interface SavedFiltersMenuProps {
  page: FilterPage;
  query: string;
  onApply: (query: string) => void;
}

export function SavedFiltersMenu(props: SavedFiltersMenuProps) {
  const { authEnabled, user } = useAuth();
  const owner = authEnabled ? user?.userId ?? 'signed-out' : 'shared';
  return <SavedFiltersMenuBody key={owner} {...props} />;
}

function SavedFiltersMenuBody({ page, query, onApply }: SavedFiltersMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [lists, setLists] = useState<FilterLists | null>(null);
  const [name, setName] = useState('');
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);

  const reload = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const next = await fetchFilterLists();
      if (id === requestId.current) {
        setLists(next);
        setError('');
      }
    } catch (failure) {
      if (id === requestId.current) setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);

  const show = () => {
    setOpen(true);
    void reload();
  };

  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await operation();
      await reload();
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const apply = (value: string) => {
    onApply(value);
    setOpen(false);
    void recordRecentFilter(value).catch(() => {
      // Search remains usable if recording recent history fails.
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={show}
        className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-md border border-gray-300 bg-white px-3 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
        aria-label={t('components.savedFilters.title')}
        title={t('components.savedFilters.title')}
      >
        <Bookmark size={18} aria-hidden="true" />
      </button>
      <Modal isOpen={open} onClose={() => setOpen(false)} title={t('components.savedFilters.title')} maxWidth="max-w-xl">
        <div className="space-y-6 text-sm text-gray-900 dark:text-gray-100">
          {lists?.shared && <p className="text-amber-700 dark:text-amber-300">{t('components.savedFilters.shared')}</p>}
          {error && <p role="alert" className="text-red-600 dark:text-red-400">{error}</p>}
          <form className="flex flex-wrap gap-2" onSubmit={async (event) => {
            event.preventDefault();
            if (await mutate(() => createSavedFilter(name, query.trim()))) setName('');
          }}>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              aria-label={t('components.savedFilters.name')}
              placeholder={t('components.savedFilters.name')}
              className="min-h-11 min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-3 text-gray-900 placeholder:text-gray-500 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/30 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-400"
            />
            <button type="submit" disabled={busy || !name.trim() || !filterValidForPage(query, page)} className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary-600 px-4 font-medium text-white transition-colors hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-50">
              {t('components.savedFilters.save')}
            </button>
          </form>
          {!filterValidForPage(query, page) && <p className="text-gray-500 dark:text-gray-400">{t('components.savedFilters.validQuery')}</p>}
          <section aria-label={t('components.savedFilters.saved')} className="space-y-2">
            <h4 className="font-semibold">{t('components.savedFilters.saved')}</h4>
            {!lists && !error && <p>{t('components.savedFilters.loading')}</p>}
            {lists?.saved.length === 0 && <p className="text-gray-500 dark:text-gray-400">{t('components.savedFilters.emptySaved')}</p>}
            {lists?.saved.map((filter) => {
              const compatible = filterValidForPage(filter.query, page);
              return <div key={filter.id} className="rounded-md border border-gray-200 bg-gray-50 px-3 py-3 dark:border-gray-700 dark:bg-gray-900/40">
                {renameId === filter.id ? (
                  <form className="flex flex-wrap gap-2" onSubmit={async (event) => {
                    event.preventDefault();
                    if (await mutate(() => renameSavedFilter(filter.id, renameValue))) setRenameId(null);
                  }}>
                    <input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} maxLength={80} aria-label={t('components.savedFilters.name')} className="min-h-9 min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-3 text-gray-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/30 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
                    <button type="submit" disabled={busy || !renameValue.trim()} className="inline-flex min-h-9 items-center justify-center rounded-md bg-primary-600 px-3 font-medium text-white transition-colors hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-50">{t('common.save')}</button>
                    <button type="button" onClick={() => setRenameId(null)} className="inline-flex min-h-9 items-center justify-center rounded-md border border-gray-300 px-3 font-medium text-gray-700 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">{t('common.cancel')}</button>
                  </form>
                ) : (
                  <>
                    <div className="font-medium">{filter.name}</div>
                    <div className="mt-1 break-all text-xs leading-5 text-gray-500 dark:text-gray-400">{filter.query}</div>
                    <div className="mt-3 flex flex-wrap items-center gap-1 border-t border-gray-200 pt-2 dark:border-gray-700">
                      <button type="button" disabled={!compatible || busy} title={!compatible ? t('components.savedFilters.incompatible') : undefined} onClick={() => apply(filter.query)} className="inline-flex min-h-9 items-center justify-center rounded-md border border-primary-300 px-3 font-medium text-primary-700 transition-colors hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:border-gray-300 disabled:text-gray-400 dark:border-primary-700 dark:text-primary-300 dark:hover:bg-primary-900/30 dark:disabled:border-gray-700 dark:disabled:text-gray-500">{t('components.savedFilters.apply')}</button>
                      <button type="button" disabled={busy} aria-label={t('components.savedFilters.rename')} title={t('components.savedFilters.rename')} onClick={() => { setRenameId(filter.id); setRenameValue(filter.name); }} className="inline-flex h-9 w-9 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"><SquarePen className="h-4 w-4" aria-hidden="true" /></button>
                      <button type="button" disabled={busy} aria-label={t('common.delete')} title={t('common.delete')} onClick={() => { void mutate(() => deleteSavedFilter(filter.id)); }} className="inline-flex h-9 w-9 items-center justify-center rounded-full text-red-600 transition-colors hover:bg-red-50 hover:text-red-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-900/20 dark:hover:text-red-300"><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
                      {!compatible && <span className="text-xs text-gray-500 dark:text-gray-400">{t('components.savedFilters.incompatible')}</span>}
                    </div>
                  </>
                )}
              </div>;
            })}
          </section>
          <section aria-label={t('components.savedFilters.recent')} className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h4 className="font-semibold">{t('components.savedFilters.recent')}</h4>
              {!!lists?.recent.length && <button type="button" disabled={busy} onClick={() => { void mutate(clearRecentFilters); }} className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 hover:text-red-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-900/20 dark:hover:text-red-300"><Trash2 className="h-3.5 w-3.5" aria-hidden="true" />{t('components.savedFilters.clearRecent')}</button>}
            </div>
            {lists?.recent.length === 0 && <p className="text-gray-500 dark:text-gray-400">{t('components.savedFilters.emptyRecent')}</p>}
            {lists?.recent.map((filter) => {
              const compatible = filterValidForPage(filter.query, page);
              return <div key={filter.query} className="flex items-start justify-between gap-3 rounded-md border border-gray-200 bg-gray-50 px-3 py-3 dark:border-gray-700 dark:bg-gray-900/40">
                <span className="min-w-0 break-all leading-5">{filter.query}</span>
                <button type="button" disabled={!compatible || busy} title={!compatible ? t('components.savedFilters.incompatible') : undefined} onClick={() => apply(filter.query)} className="inline-flex min-h-9 shrink-0 items-center justify-center rounded-md border border-primary-300 px-3 font-medium text-primary-700 transition-colors hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:border-gray-300 disabled:text-gray-400 dark:border-primary-700 dark:text-primary-300 dark:hover:bg-primary-900/30 dark:disabled:border-gray-700 dark:disabled:text-gray-500">{t('components.savedFilters.apply')}</button>
              </div>;
            })}
          </section>
        </div>
      </Modal>
    </>
  );
}
