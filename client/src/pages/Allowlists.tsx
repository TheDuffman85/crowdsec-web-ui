import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, Info, ListChecks, RefreshCw, Search, X } from 'lucide-react';

import { checkAllowlist, fetchAllowlistEntries, fetchAllowlists } from '../lib/api';
import { useRefresh } from '../contexts/useRefresh';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { InstanceIcon } from '../components/InstanceIcon';
import { useI18n } from '../lib/i18n';
import { useDateTime } from '../lib/dateTime';
import type {
  AllowlistCheckResponse,
  AllowlistEntry,
  AllowlistInstanceStatus,
  AllowlistsResponse,
  AllowlistSummary,
  PaginationMeta,
} from '../types';

type AllowlistsState = { instanceScope: string } & (
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: AllowlistsResponse }
);

type CheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'error'; message: string }
  | { status: 'done'; data: AllowlistCheckResponse };

interface EntriesState {
  entries: AllowlistEntry[];
  pagination: PaginationMeta | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

const ENTRY_PAGE_SIZE = 50;
const FILTER_DEBOUNCE_MS = 300;
const DESCRIPTION_DISMISSED_STORAGE_KEY = 'crowdsec-web-ui:allowlists-description-dismissed';
const ENTRY_GRID_CLASS_NAME = 'lg:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)_160px_160px]';
const ENTRY_GRID_WITH_INSTANCES_CLASS_NAME = 'lg:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)_150px_150px_minmax(0,1.2fr)]';

function Notice({ tone, children, onDismiss }: { tone: 'info' | 'warning'; children: ReactNode; onDismiss?: () => void }) {
  const { t } = useI18n();
  const Icon = tone === 'info' ? Info : AlertCircle;
  const className = tone === 'info'
    ? 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-100'
    : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100';
  return (
    <div className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${className}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 break-words">{children}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('common.hide')}
          className="ms-auto shrink-0 rounded p-0.5 hover:bg-blue-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current dark:hover:bg-blue-900/50"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function InstanceLabel({ instance, colorIndex }: { instance?: { instance_name: string; instance_icon?: string }; colorIndex: number }) {
  if (!instance) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <InstanceIcon icon={instance.instance_icon} colorIndex={colorIndex} />
      {instance.instance_name}
    </span>
  );
}

function instanceLabels(instanceIds: string[], instances: AllowlistInstanceStatus[]) {
  return instanceIds.map((instanceId) => {
    const index = instances.findIndex((instance) => instance.instance_id === instanceId);
    return <InstanceLabel key={instanceId} instance={instances[index]} colorIndex={index} />;
  });
}

function AllowlistCheckCard({ instanceScope, multipleInstances }: { instanceScope: string; multipleInstances: boolean }) {
  const { t } = useI18n();
  const [value, setValue] = useState('');
  const [state, setState] = useState<CheckState>({ status: 'idle' });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    setState({ status: 'checking' });
    try {
      setState({ status: 'done', data: await checkAllowlist(trimmed, instanceScope) });
    } catch {
      setState({ status: 'error', message: t('pages.allowlists.checkFailed') });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Search className="h-5 w-5 text-primary-600 dark:text-primary-400" aria-hidden="true" />
          {t('pages.allowlists.checkTitle')}
        </CardTitle>
        <p className="mt-2 text-sm leading-6 text-gray-500 dark:text-gray-400">{t('pages.allowlists.checkDescription')}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
          <label htmlFor="allowlist-check-value" className="sr-only">{t('pages.allowlists.checkLabel')}</label>
          <input
            id="allowlist-check-value"
            type="text"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={t('pages.allowlists.checkPlaceholder')}
            className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-sm text-gray-900 shadow-sm focus:border-primary-500 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 sm:max-w-sm"
          />
          <button
            type="submit"
            disabled={state.status === 'checking' || !value.trim()}
            className="inline-flex items-center justify-center rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state.status === 'checking' ? t('pages.allowlists.checking') : t('pages.allowlists.check')}
          </button>
        </form>
        {state.status === 'error' && <Notice tone="warning">{state.message}</Notice>}
        {state.status === 'done' && (
          <ul className="space-y-2" aria-label={t('pages.allowlists.checkResults')}>
            {state.data.results.map((result, index) => (
              <li key={result.instance_id} className="flex flex-wrap items-center gap-2 text-sm">
                {multipleInstances && (
                  <span className="font-medium text-gray-900 dark:text-white">
                    <InstanceLabel instance={result} colorIndex={index} />
                  </span>
                )}
                {result.status === 'available' ? (
                  <Badge variant={result.allowlisted ? 'info' : 'secondary'}>
                    {t(result.allowlisted ? 'pages.allowlists.allowlisted' : 'pages.allowlists.notAllowlisted', { value: state.data.value })}
                  </Badge>
                ) : (
                  <Badge variant="warning">
                    {t(result.status === 'unsupported' ? 'pages.allowlists.statusUnsupported' : 'pages.allowlists.statusUnavailable')}
                  </Badge>
                )}
                {result.reason && <span className="min-w-0 break-words text-gray-600 dark:text-gray-300">{result.reason}</span>}
                {result.error && <span className="min-w-0 break-words text-xs text-amber-800 dark:text-amber-200">{result.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AllowlistPicker({
  allowlists,
  instances,
  selectedName,
  filtered,
  onSelect,
}: {
  allowlists: AllowlistSummary[];
  instances: AllowlistInstanceStatus[];
  selectedName: string;
  filtered: boolean;
  onSelect: (name: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Card>
      <ul className="divide-y divide-gray-100 dark:divide-gray-700/70" aria-label={t('pages.allowlists.title')}>
        {allowlists.map((allowlist) => {
          const selected = allowlist.name === selectedName;
          return (
            <li key={allowlist.name}>
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelect(allowlist.name)}
                className={`flex w-full flex-col gap-1 px-6 py-3 text-left transition-colors sm:flex-row sm:items-center sm:gap-4 ${selected
                  ? 'bg-primary-50 dark:bg-primary-900/20'
                  : 'hover:bg-gray-50 dark:hover:bg-gray-700/40'}`}
              >
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  <span className={`break-all font-semibold ${selected ? 'text-primary-700 dark:text-primary-300' : 'text-gray-900 dark:text-white'}`}>
                    {allowlist.name}
                  </span>
                  {allowlist.console_managed && <Badge variant="info">{t('pages.allowlists.consoleManaged')}</Badge>}
                  {allowlist.description && (
                    <span className="min-w-0 truncate text-sm text-gray-500 dark:text-gray-400">{allowlist.description}</span>
                  )}
                </span>
                {instances.length > 1 && (
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                    {instanceLabels(allowlist.instance_ids, instances)}
                  </span>
                )}
                <Badge variant="secondary" className="w-fit shrink-0">
                  {filtered
                    ? t('pages.allowlists.matchingEntries', {
                      matching: allowlist.matching_entries.toLocaleString(),
                      total: allowlist.entry_count.toLocaleString(),
                    })
                    : t('pages.allowlists.entryCount', { count: allowlist.entry_count.toLocaleString() })}
                </Badge>
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function AllowlistEntriesCard({
  allowlist,
  instances,
  instanceScope,
  query,
}: {
  allowlist: AllowlistSummary;
  instances: AllowlistInstanceStatus[];
  instanceScope: string;
  query: string;
}) {
  const { t } = useI18n();
  const { formatDateTime } = useDateTime();
  const { refreshSignal } = useRefresh();
  const [state, setState] = useState<EntriesState>({ entries: [], pagination: null, loading: true, loadingMore: false, error: null });
  const observer = useRef<IntersectionObserver | null>(null);
  const multipleInstances = instances.length > 1;
  const gridClassName = multipleInstances ? ENTRY_GRID_WITH_INSTANCES_CLASS_NAME : ENTRY_GRID_CLASS_NAME;
  const loadedPages = state.pagination?.page ?? 0;
  const hasMore = Boolean(state.pagination && state.pagination.page < state.pagination.total_pages);

  const loadPage = useCallback(async (page: number) => {
    setState((current) => ({ ...current, loadingMore: page > 1, error: null }));
    try {
      const response = await fetchAllowlistEntries(allowlist.name, instanceScope, page, ENTRY_PAGE_SIZE, query);
      setState((current) => ({
        entries: page > 1 ? [...current.entries, ...response.data] : response.data,
        pagination: response.pagination,
        loading: false,
        loadingMore: false,
        error: null,
      }));
    } catch {
      setState((current) => ({ ...current, loading: false, loadingMore: false, error: t('pages.allowlists.entriesLoadFailed') }));
    }
  }, [allowlist.name, instanceScope, query, t]);

  // Refreshes reload only the first page, so they never reset a longer scroll position.
  const reloadsOnRefresh = loadedPages <= 1;
  useEffect(() => {
    if (!reloadsOnRefresh) return;
    const timeoutId = window.setTimeout(() => void loadPage(1), 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadPage, refreshSignal, reloadsOnRefresh]);

  const lastEntryRef = useCallback((node: HTMLLIElement | null) => {
    if (state.loading || state.loadingMore || !hasMore) return;
    observer.current?.disconnect();
    observer.current = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void loadPage(loadedPages + 1);
    });
    if (node) observer.current.observe(node);
  }, [hasMore, loadPage, loadedPages, state.loading, state.loadingMore]);

  useEffect(() => () => observer.current?.disconnect(), []);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="min-w-0 break-all">{allowlist.name}</CardTitle>
          {allowlist.console_managed && <Badge variant="info">{t('pages.allowlists.consoleManaged')}</Badge>}
        </div>
        {allowlist.description && (
          <p className="mt-2 break-words text-sm leading-6 text-gray-500 dark:text-gray-400">{allowlist.description}</p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
          {multipleInstances && instanceLabels(allowlist.instance_ids, instances)}
          {allowlist.updated_at && <span>{t('pages.allowlists.updated', { time: formatDateTime(allowlist.updated_at) })}</span>}
          {state.pagination && state.pagination.total > 0 && (
            <span>{t('pages.allowlists.showingEntries', {
              shown: state.entries.length.toLocaleString(),
              total: state.pagination.total.toLocaleString(),
            })}</span>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {state.error && (
          <div className="flex flex-wrap items-center gap-3 px-6 py-4">
            <Notice tone="warning">{state.error}</Notice>
            <button
              type="button"
              onClick={() => void loadPage(loadedPages + 1)}
              className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-700"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              {t('pages.allowlists.retry')}
            </button>
          </div>
        )}
        {state.loading && <p className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">{t('app.loading')}</p>}
        {!state.loading && !state.error && state.entries.length === 0 && (
          <p className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">{t('pages.allowlists.noEntries')}</p>
        )}
        {state.entries.length > 0 && (
          <div>
            <div className={`hidden gap-3 border-b border-gray-100 bg-gray-50 px-6 py-2 text-xs font-semibold uppercase text-gray-500 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-400 lg:grid ${gridClassName}`}>
              <span>{t('pages.allowlists.columns.value')}</span>
              <span>{t('pages.allowlists.columns.description')}</span>
              <span>{t('pages.allowlists.columns.expiration')}</span>
              <span>{t('pages.allowlists.columns.created')}</span>
              {multipleInstances && <span>{t('pages.allowlists.columns.instances')}</span>}
            </div>
            <ul className="divide-y divide-gray-100 dark:divide-gray-700/70">
              {state.entries.map((entry, index) => (
                <li
                  key={entry.value}
                  ref={index === state.entries.length - 1 ? lastEntryRef : null}
                  className={`grid gap-1 px-6 py-3 text-sm lg:items-center lg:gap-3 ${gridClassName}`}
                >
                  <span className="break-all font-mono font-medium text-gray-900 dark:text-white">{entry.value}</span>
                  <span className="break-words text-gray-600 dark:text-gray-300">{entry.description || '-'}</span>
                  <span className="text-gray-600 dark:text-gray-300">
                    <span className="text-xs text-gray-500 lg:hidden">{t('pages.allowlists.columns.expiration')}: </span>
                    {entry.expiration ? formatDateTime(entry.expiration) : t('pages.allowlists.never')}
                  </span>
                  <span className="text-gray-600 dark:text-gray-300">
                    <span className="text-xs text-gray-500 lg:hidden">{t('pages.allowlists.columns.created')}: </span>
                    {entry.created_at ? formatDateTime(entry.created_at) : '-'}
                  </span>
                  {multipleInstances && (
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                      {instanceLabels(entry.instance_ids, instances)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {state.loadingMore && (
              <p className="border-t border-gray-100 px-6 py-3 text-center text-sm text-gray-500 dark:border-gray-700/70 dark:text-gray-400">
                {t('pages.allowlists.loadingMore')}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function Allowlists() {
  const { t } = useI18n();
  const { refreshSignal } = useRefresh();
  const location = useLocation();
  const navigate = useNavigate();
  const searchParams = new URLSearchParams(location.search);
  const instanceScope = searchParams.get('instance') || 'all';
  const requestedAllowlist = searchParams.get('allowlist');
  const [loadedState, setState] = useState<AllowlistsState>({ status: 'loading', instanceScope });
  const state = loadedState.instanceScope === instanceScope ? loadedState : { status: 'loading' as const };
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [descriptionDismissed, setDescriptionDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(DESCRIPTION_DISMISSED_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const dismissDescription = () => {
    setDescriptionDismissed(true);
    try {
      window.localStorage.setItem(DESCRIPTION_DISMISSED_STORAGE_KEY, 'true');
    } catch {
      // Keep the banner dismissible when browser storage is unavailable.
    }
  };

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setQuery(filter.trim()), FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [filter]);

  useEffect(() => {
    let cancelled = false;
    const timeoutId = window.setTimeout(async () => {
      try {
        const data = await fetchAllowlists(instanceScope, query);
        if (!cancelled) setState({ status: 'ready', instanceScope, data });
      } catch {
        if (!cancelled) setState({ status: 'error', instanceScope, message: t('pages.allowlists.loadFailed') });
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [instanceScope, query, t, refreshSignal, retryAttempt]);

  const selectAllowlist = (name: string) => {
    const params = new URLSearchParams(location.search);
    params.set('allowlist', name);
    navigate(`${location.pathname}?${params.toString()}`, { replace: true });
  };

  const data = state.status === 'ready' ? state.data : null;
  const instances = data?.instances ?? [];
  const allowlists = data?.allowlists ?? [];
  const selected = allowlists.find((allowlist) => allowlist.name === requestedAllowlist) ?? allowlists[0];
  const unsupported = instances.filter((instance) => instance.status === 'unsupported');
  const unavailable = instances.filter((instance) => instance.status === 'unavailable');
  const multipleInstances = instances.length > 1;

  return (
    <div className="space-y-6">
      {!descriptionDismissed && (
        <Notice tone="info" onDismiss={dismissDescription}>
          {t('pages.allowlists.description')}{' '}
          <code className="rounded bg-blue-100 px-1 py-0.5 font-mono text-xs dark:bg-blue-900/50">cscli allowlists</code>
        </Notice>
      )}

      <AllowlistCheckCard key={instanceScope} instanceScope={instanceScope} multipleInstances={multipleInstances} />

      {state.status === 'loading' && (
        <Card>
          <CardContent className="p-8 text-center text-gray-500 dark:text-gray-400">{t('app.loading')}</CardContent>
        </Card>
      )}

      {state.status === 'error' && (
        <Card>
          <CardContent className="flex flex-col gap-4 p-6">
            <Notice tone="warning">{state.message}</Notice>
            <button
              type="button"
              onClick={() => setRetryAttempt((attempt) => attempt + 1)}
              className="inline-flex w-fit items-center gap-2 rounded-lg bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-700"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              {t('pages.allowlists.retry')}
            </button>
          </CardContent>
        </Card>
      )}

      {data && (
        <>
          {unsupported.length > 0 && (
            <Notice tone="info">
              {t(multipleInstances ? 'pages.allowlists.unsupportedOn' : 'pages.allowlists.unsupported', {
                names: unsupported.map((instance) => instance.instance_name).join(', '),
              })}
            </Notice>
          )}
          {unavailable.map((instance) => (
            <Notice key={instance.instance_id} tone="warning">
              {t('pages.allowlists.unavailable', { name: instance.instance_name })}
              {instance.error && <span className="block text-xs">{instance.error}</span>}
            </Notice>
          ))}

          {(allowlists.length > 0 || query) && (
            <div className="max-w-sm">
              <label htmlFor="allowlist-filter" className="sr-only">{t('pages.allowlists.filterPlaceholder')}</label>
              <input
                id="allowlist-filter"
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder={t('pages.allowlists.filterPlaceholder')}
                className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-primary-500 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              />
            </div>
          )}

          {allowlists.length === 0 && !query && unsupported.length + unavailable.length < instances.length && (
            <Card>
              <CardContent className="flex flex-col items-center gap-2 p-8 text-center text-sm text-gray-500 dark:text-gray-400">
                <ListChecks className="h-6 w-6" aria-hidden="true" />
                {t('pages.allowlists.empty')}
              </CardContent>
            </Card>
          )}
          {allowlists.length === 0 && query && (
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('pages.allowlists.noMatches')}</p>
          )}

          {selected && (
            <>
              <AllowlistPicker
                allowlists={allowlists}
                instances={instances}
                selectedName={selected.name}
                filtered={Boolean(query)}
                onSelect={selectAllowlist}
              />
              <AllowlistEntriesCard
                key={`${instanceScope}\u0000${selected.name}\u0000${query}`}
                allowlist={selected}
                instances={instances}
                instanceScope={instanceScope}
                query={query}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
