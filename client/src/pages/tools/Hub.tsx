import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw, RotateCw } from 'lucide-react';
import { CommandBlock, CopyCommand } from '../../components/hub/CopyCommand';
import { PairingModal } from '../../components/hub/PairingModal';
import { ScenarioName } from '../../components/ScenarioName';
import { ToolMessage, ToolPage } from '../../components/ToolPage';
import { Badge } from '../../components/ui/Badge';
import { Card, CardContent } from '../../components/ui/Card';
import { Modal } from '../../components/ui/Modal';
import {
  applyHubProfile, checkHubServer, fetchHub, fetchHubServers, reloadCrowdsec, removeHubServer, runHubAction,
  type HubAction, type HubActionResult, type HubItem, type HubItemType, type HubServer, type HubServers, type HubStatus,
} from '../../lib/insightsApi';
import { hubCommand } from '../../lib/hubCommands';
import { useI18n } from '../../lib/i18n';

const TYPES: readonly HubItemType[] = ['scenarios', 'collections', 'parsers', 'postoverflows'];
const FILTERS = ['installed', 'updates', 'available', 'all'] as const;
type Filter = (typeof FILTERS)[number];
const PAGE_SIZE = 100;
const RELOAD_COMMAND = 'docker kill --signal=SIGHUP crowdsec';

const TYPE_LABEL_KEYS: Record<HubItemType, string> = {
  scenarios: 'tools.hub.type.scenarios',
  collections: 'tools.hub.type.collections',
  parsers: 'tools.hub.type.parsers',
  postoverflows: 'tools.hub.type.postoverflows',
};
const FILTER_LABEL_KEYS: Record<Filter, string> = {
  installed: 'tools.hub.filter.installed',
  updates: 'tools.hub.filter.updates',
  available: 'tools.hub.filter.available',
  all: 'tools.hub.filter.all',
};
const STATUS_LABEL_KEYS = {
  detected: 'tools.hub.servers.status.detected',
  pending: 'tools.hub.servers.status.pending',
  paired: 'tools.hub.servers.status.paired',
  error: 'tools.hub.servers.status.error',
} as const;
const STATUS_VARIANTS = { detected: 'secondary', pending: 'warning', paired: 'success', error: 'danger' } as const;

const SMALL_BUTTON = 'inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700';

type Pending =
  | { kind: 'action'; action: HubAction; targets: string[] }
  | { kind: 'profile'; profile: string; targets: string[] }
  | { kind: 'reload' };

interface Outcome { title: string; ok: boolean; results: HubActionResult['results'] }

const usable = (server: HubServer): server is HubServer & { id: string } => server.id !== null && (server.status === 'paired' || server.status === 'error');

export function Hub() {
  const { t, language } = useI18n();
  const [servers, setServers] = useState<HubServers | null>(null);
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [statuses, setStatuses] = useState<Record<string, HubStatus>>({});
  const [baseStatus, setBaseStatus] = useState<HubStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [type, setType] = useState<HubItemType>('scenarios');
  const [filter, setFilter] = useState<Filter>('installed');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reloadChoice, setReloadChoice] = useState<string[]>([]);
  const [profileChoice, setProfileChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pairTarget, setPairTarget] = useState<HubServer | null>(null);
  const [removeTarget, setRemoveTarget] = useState<HubServer | null>(null);
  const [removed, setRemoved] = useState<{ name: string; command: string } | null>(null);

  const profileLabel = useCallback((id: string) => {
    const label = t(`tools.hub.profile.${id}`);
    return label === `tools.hub.profile.${id}` ? id : label;
  }, [t]);

  const pairedServers = useMemo(() => (servers?.servers ?? []).filter(usable), [servers]);
  const selected = useMemo(() => {
    const available = new Set(pairedServers.map((server) => server.id));
    const wanted = chosen ?? pairedServers.slice(0, 1).map((server) => server.id);
    return wanted.filter((id) => available.has(id));
  }, [chosen, pairedServers]);
  const selectedKey = selected.join('|');

  const loadServers = useCallback(async () => {
    try {
      setServers(await fetchHubServers());
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t('tools.hub.loadFailed'));
    }
  }, [t]);

  const loadStatus = useCallback(async (id: string) => {
    try {
      const status = await fetchHub(id);
      setStatuses((current) => ({ ...current, [id]: status }));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t('tools.hub.loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadServers(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadServers]);

  // Each server's hub is read once it is selected, so a server that was never picked is never contacted.
  useEffect(() => {
    const missing = selectedKey ? selectedKey.split('|').filter((id) => statuses[id] === undefined) : [];
    if (missing.length === 0) return;
    const timer = window.setTimeout(() => { missing.forEach((id) => { void loadStatus(id); }); }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedKey, statuses, loadStatus]);

  // With no server set up there is nothing to select; the scenarios that raised alerts still come from the app.
  const noServers = servers !== null && pairedServers.length === 0;
  useEffect(() => {
    if (!noServers) return;
    const timer = window.setTimeout(() => {
      fetchHub().then(setBaseStatus).catch((error: unknown) => setLoadError(error instanceof Error ? error.message : t('tools.hub.loadFailed')));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [noServers, t]);

  const refresh = useCallback(async () => {
    setStatuses({});
    await loadServers();
  }, [loadServers]);

  const canManage = Boolean(servers?.can_manage);
  const canAct = canManage && selected.length > 0;
  const nameOf = useCallback((id: string) => servers?.servers.find((server) => server.id === id)?.name ?? id, [servers]);

  // One row per hub item, with the state of that item on every selected server.
  const catalogRows = useMemo(() => {
    const rows = new Map<string, { name: string; description: string; byServer: Record<string, HubItem | undefined> }>();
    for (const id of selected) {
      for (const item of statuses[id]?.catalog?.[type] ?? []) {
        const row = rows.get(item.name) ?? { name: item.name, description: item.description, byServer: {} };
        row.byServer[id] = item;
        if (!row.description) row.description = item.description;
        rows.set(item.name, row);
      }
    }
    return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [selected, statuses, type]);

  const items = useMemo(() => {
    const query = search.trim().toLowerCase();
    return catalogRows.filter((row) => {
      const states = selected.map((id) => row.byServer[id]);
      if (filter === 'installed' && !states.some((item) => item?.installed)) return false;
      if (filter === 'updates' && !states.some((item) => item?.upgradable)) return false;
      if (filter === 'available' && !states.some((item) => item && !item.installed)) return false;
      return !query || row.name.toLowerCase().includes(query) || row.description.toLowerCase().includes(query);
    });
  }, [catalogRows, selected, filter, search]);

  const catalogLoaded = selected.some((id) => statuses[id]?.catalog);
  const errors = selected.filter((id) => statuses[id]?.catalog_error);
  const reference = (selected[0] ? statuses[selected[0]] : null) ?? baseStatus;
  const alertsByScenario = useMemo(() => new Map((reference?.seen_scenarios ?? []).map((row) => [row.name, row.alerts])), [reference]);
  const seenMissing = (reference?.seen_scenarios ?? []).filter((row) => row.installed === false);
  const pendingServers = pairedServers.filter((server) => server.pending_reload);

  const targetsFor = (row: { byServer: Record<string, HubItem | undefined> }, action: 'install' | 'remove' | 'upgrade'): string[] => selected.filter((id) => {
    const item = row.byServer[id];
    if (!item || item.local) return false;
    if (action === 'install') return !item.installed;
    if (action === 'remove') return item.installed;
    return item.upgradable;
  });

  const toggle = (id: string) => {
    setChosen(selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]);
    setLimit(PAGE_SIZE);
  };

  const run = async () => {
    if (!pending) return;
    setBusy(true);
    setActionError(null);
    try {
      let result: HubActionResult;
      let title: string;
      if (pending.kind === 'reload') {
        result = await reloadCrowdsec(reloadChoice);
        title = t('tools.hub.reloadTitle');
      } else if (pending.kind === 'profile') {
        result = await applyHubProfile(pending.profile, pending.targets);
        title = t('tools.hub.profiles.confirmTitle', { profile: profileLabel(pending.profile) });
      } else {
        result = await runHubAction(pending.action, pending.targets);
        title = hubCommand(pending.action);
      }
      setOutcome({ title, ok: result.ok, results: result.results });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('tools.hub.actionFailed'));
    } finally {
      setBusy(false);
      setPending(null);
      await refresh();
    }
  };

  const confirmRemove = async () => {
    if (!removeTarget?.id) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await removeHubServer(removeTarget.id);
      setRemoved({ name: removeTarget.name, command: result.uninstall_command });
      setChosen((current) => (current ?? []).filter((id) => id !== removeTarget.id));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('tools.hub.actionFailed'));
    } finally {
      setBusy(false);
      setRemoveTarget(null);
      await refresh();
    }
  };

  const checkServer = async (server: HubServer) => {
    if (!server.id) return;
    setActionError(null);
    try {
      await checkHubServer(server.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('tools.hub.actionFailed'));
    }
    await refresh();
  };

  const openReload = (ids: string[]) => {
    setReloadChoice(ids);
    setPending({ kind: 'reload' });
  };

  const dialog = (() => {
    if (!pending) return null;
    if (pending.kind === 'reload') {
      return { title: t('tools.hub.reloadTitle'), body: t('tools.hub.reloadBody'), command: null, confirmLabel: t('tools.hub.reloadConfirm'), targets: null, danger: false, disabled: reloadChoice.length === 0 };
    }
    if (pending.kind === 'profile') {
      const profile = servers?.profiles.find((item) => item.id === pending.profile);
      return {
        title: t('tools.hub.profiles.confirmTitle', { profile: profileLabel(pending.profile) }),
        body: t('tools.hub.profiles.confirmBody', { items: (profile?.items ?? []).map((item) => item.name).join(', ') }),
        command: null, confirmLabel: t('tools.hub.action.install'), targets: pending.targets, danger: false, disabled: pending.targets.length === 0,
      };
    }
    const { action } = pending;
    const base = { command: hubCommand(action), targets: pending.targets, danger: action.action === 'remove', disabled: pending.targets.length === 0 };
    if (action.action === 'update') return { ...base, title: t('tools.hub.updateTitle'), body: t('tools.hub.updateBody'), confirmLabel: t('tools.hub.updateConfirm') };
    if (action.action === 'upgrade-all') return { ...base, title: t('tools.hub.upgradeAllTitle'), body: t('tools.hub.upgradeAllBody'), confirmLabel: t('tools.hub.upgradeAllConfirm') };
    return {
      ...base,
      title: t(`tools.hub.confirmTitle.${action.action}`, { name: action.name }),
      body: t(`tools.hub.confirmBody.${action.action}`, { name: action.name }),
      confirmLabel: t(`tools.hub.action.${action.action}`),
    };
  })();

  const formatTime = (value: string | null) => (value ? new Date(value).toLocaleString(language) : t('tools.hub.servers.neverChecked'));

  return (
    <ToolPage
      title={t('tools.hub.title')}
      description={t('tools.hub.description')}
      actions={servers && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={pairedServers.length > 0 ? 'success' : 'secondary'} data-testid="hub-executor-state">
            {t('tools.hub.serversBadge', { paired: pairedServers.length, total: servers.servers.length })}
          </Badge>
          <button type="button" onClick={() => { void refresh(); }} className={SMALL_BUTTON}>
            <RefreshCw size={12} aria-hidden="true" />{t('tools.hub.refresh')}
          </button>
        </div>
      )}
    >
      {loadError && <ToolMessage tone="error">{loadError}</ToolMessage>}
      {!servers && !loadError && <p className="text-sm text-gray-500">{t('app.loading')}</p>}
      {actionError && <ToolMessage tone="error">{actionError}</ToolMessage>}
      {removed && (
        <ToolMessage>
          <p className="font-medium">{t('tools.hub.remove.done', { name: removed.name })}</p>
          <div className="mt-2"><CommandBlock command={removed.command} label={t('tools.hub.pair.copyUninstall')} /></div>
        </ToolMessage>
      )}
      {outcome && (
        <ToolMessage tone={outcome.ok ? 'muted' : 'error'}>
          <p className="font-medium" data-testid="hub-outcome">
            {outcome.ok ? t('tools.hub.resultOk') : outcome.results.some((result) => result.ok) ? t('tools.hub.resultPartial') : t('tools.hub.resultFailed')}{' '}
            <span className="font-mono text-xs">{outcome.title}</span>
          </p>
          <ul className="mt-2 space-y-2">
            {outcome.results.map((result) => (
              <li key={result.server} data-testid="hub-server-result">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium">{result.name}</span>
                  <Badge variant={result.ok ? 'success' : 'danger'}>{result.ok ? t('tools.hub.serverOk') : t('tools.hub.serverFailed')}</Badge>
                </div>
                {result.output && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-xs">{result.output}</pre>}
              </li>
            ))}
          </ul>
        </ToolMessage>
      )}

      {servers && (
        <>
          <Card>
            <CardContent className="space-y-3 pt-4">
              <div>
                <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('tools.hub.servers.title')}</h3>
                <p className="text-sm text-gray-500">{t('tools.hub.servers.body')}</p>
              </div>
              {servers.servers.length === 0 && <p className="text-sm text-gray-500">{t('tools.hub.servers.none')}</p>}
              <ul className="divide-y divide-gray-100 dark:divide-gray-800" data-testid="hub-servers">
                {servers.servers.map((server) => {
                  const key = server.id ?? `machine:${server.name}`;
                  const expired = server.status === 'pending' && server.pairing_expired;
                  return (
                    <li key={key} className="flex flex-wrap items-start justify-between gap-3 py-3" data-testid="hub-server" data-status={server.status}>
                      <div className="flex min-w-0 items-start gap-3">
                        {usable(server) ? (
                          <input type="checkbox" className="mt-1" checked={selected.includes(server.id)} onChange={() => toggle(server.id)} aria-label={t('tools.hub.servers.select', { name: server.name })} />
                        ) : <span className="w-4" aria-hidden="true" />}
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-gray-900 dark:text-gray-100">{server.name}</span>
                            <Badge variant={STATUS_VARIANTS[server.status]}>{expired ? t('tools.hub.servers.status.pendingExpired') : t(STATUS_LABEL_KEYS[server.status])}</Badge>
                            {server.mode && <Badge variant="outline">{t(`tools.hub.servers.mode.${server.mode}`)}</Badge>}
                            {server.source === 'env' && <Badge variant="outline">{t('tools.hub.servers.source.env')}</Badge>}
                            {server.pending_reload && <Badge variant="warning">{t('tools.hub.servers.reloadNeeded')}</Badge>}
                          </div>
                          {(server.host || server.ssh_user) && (
                            <div className="font-mono text-xs text-gray-500">{[server.ssh_user && server.host ? `${server.ssh_user}@${server.host}` : server.host, server.port && server.port !== 22 ? `:${server.port}` : ''].join('')}</div>
                          )}
                          {server.host_key_fingerprint && <div className="break-all font-mono text-xs text-gray-500">{t('tools.hub.servers.hostKey', { fingerprint: server.host_key_fingerprint })}</div>}
                          {(server.status === 'paired' || server.status === 'error') && <div className="text-xs text-gray-500">{t('tools.hub.servers.lastCheck', { time: formatTime(server.last_check_at) })}</div>}
                          {server.status === 'error' && server.last_error && <div className="text-xs text-red-600 dark:text-red-400">{server.last_error}</div>}
                        </div>
                      </div>
                      {canManage && (
                        <div className="flex flex-wrap justify-end gap-1">
                          {server.status === 'detected' && <button type="button" className={SMALL_BUTTON} onClick={() => setPairTarget(server)}>{t('tools.hub.servers.setup')}</button>}
                          {server.status === 'pending' && <button type="button" className={SMALL_BUTTON} onClick={() => setPairTarget(server)}>{t('tools.hub.servers.newCommand')}</button>}
                          {usable(server) && <button type="button" className={SMALL_BUTTON} onClick={() => { void checkServer(server); }}>{t('tools.hub.servers.check')}</button>}
                          {server.id && server.source === 'pairing' && <button type="button" className={SMALL_BUTTON} onClick={() => setRemoveTarget(server)}>{t('tools.hub.servers.remove')}</button>}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {!canManage && <p className="text-xs text-gray-500">{t('tools.hub.adminOnly')}</p>}
            </CardContent>
          </Card>

          {noServers && (
            <ToolMessage tone="warning">
              <p className="font-medium">{t('tools.hub.readOnlyTitle')}</p>
              <p className="mt-1">{t('tools.hub.readOnlyBody')}</p>
              {servers.config_error && <p className="mt-1 font-mono text-xs">{servers.config_error}</p>}
            </ToolMessage>
          )}

          {pendingServers.length > 0 && (
            <ToolMessage tone="warning">
              <div className="flex flex-wrap items-center justify-between gap-3" data-testid="hub-pending-reload">
                <p>{t('tools.hub.pendingReload', { names: pendingServers.map((server) => server.name).join(', ') })}</p>
                {canManage
                  ? <button type="button" onClick={() => openReload(pendingServers.map((server) => server.id))} className="inline-flex items-center gap-1 rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700"><RotateCw size={12} aria-hidden="true" />{t('tools.hub.reloadButton')}</button>
                  : <CopyCommand command={RELOAD_COMMAND} label={t('tools.hub.copyReload')} />}
              </div>
            </ToolMessage>
          )}

          {errors.map((id) => <ToolMessage key={id} tone="error">{t('tools.hub.catalogError', { error: `${nameOf(id)}: ${statuses[id]?.catalog_error ?? ''}` })}</ToolMessage>)}
          {pairedServers.length > 0 && selected.length === 0 && <ToolMessage>{t('tools.hub.servers.noneSelected')}</ToolMessage>}

          {canManage && selected.length > 0 && servers.profiles.length > 0 && (
            <Card>
              <CardContent className="space-y-3 pt-4">
                <div>
                  <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('tools.hub.profiles.title')}</h3>
                  <p className="text-sm text-gray-500">{t('tools.hub.profiles.body')}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select aria-label={t('tools.hub.profiles.title')} value={profileChoice} onChange={(event) => setProfileChoice(event.target.value)} className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800">
                    <option value="">{t('tools.hub.pair.profileNone')}</option>
                    {servers.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profileLabel(profile.id)}</option>)}
                  </select>
                  <button type="button" disabled={!profileChoice} onClick={() => setPending({ kind: 'profile', profile: profileChoice, targets: selected })} className={SMALL_BUTTON}>{t('tools.hub.profiles.apply')}</button>
                </div>
                {profileChoice && <p className="text-xs text-gray-500">{t(`tools.hub.profile.${profileChoice}.desc`)}</p>}
              </CardContent>
            </Card>
          )}

          {catalogLoaded && (
            <Card>
              <CardContent className="space-y-4 pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <div role="tablist" aria-label={t('tools.hub.types')} className="flex flex-wrap gap-1">
                    {TYPES.map((value) => (
                      <button
                        key={value}
                        type="button"
                        role="tab"
                        aria-selected={type === value}
                        onClick={() => { setType(value); setLimit(PAGE_SIZE); }}
                        className={`rounded-md px-3 py-1.5 text-sm font-medium ${type === value ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600'}`}
                      >
                        {t(TYPE_LABEL_KEYS[value])}
                      </button>
                    ))}
                  </div>
                  <select aria-label={t('tools.hub.filterLabel')} value={filter} onChange={(event) => { setFilter(event.target.value as Filter); setLimit(PAGE_SIZE); }} className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800">
                    {FILTERS.map((value) => <option key={value} value={value}>{t(FILTER_LABEL_KEYS[value])}</option>)}
                  </select>
                  <input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setLimit(PAGE_SIZE); }} placeholder={t('tools.hub.search')} aria-label={t('tools.hub.search')} className="min-w-[12rem] flex-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800" />
                </div>

                <div className="flex flex-wrap gap-2">
                  {canAct ? (
                    <>
                      <button type="button" onClick={() => setPending({ kind: 'action', action: { action: 'update' }, targets: selected })} className={SMALL_BUTTON}><Download size={12} aria-hidden="true" />{t('tools.hub.updateIndex')}</button>
                      <button type="button" onClick={() => setPending({ kind: 'action', action: { action: 'upgrade-all' }, targets: selected })} className={SMALL_BUTTON}><Download size={12} aria-hidden="true" />{t('tools.hub.upgradeAll')}</button>
                    </>
                  ) : (
                    <>
                      <CopyCommand command="cscli hub update" label={t('tools.hub.copyUpdate')} />
                      <CopyCommand command="cscli hub upgrade" label={t('tools.hub.copyUpgradeAll')} />
                    </>
                  )}
                </div>

                {items.length === 0 ? <p className="text-sm text-gray-500">{t('tools.hub.noItems')}</p> : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-gray-200 text-xs uppercase text-gray-500 dark:border-gray-700">
                          <th className="py-2 pr-3">{t('tools.hub.col.name')}</th>
                          <th className="py-2 pr-3">{t('tools.hub.col.status')}</th>
                          <th className="hidden py-2 pr-3 md:table-cell">{t('tools.hub.col.description')}</th>
                          <th className="py-2 text-right">{t('tools.hub.col.actions')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.slice(0, limit).map((row) => {
                          const alerts = type === 'scenarios' ? alertsByScenario.get(row.name) : undefined;
                          return (
                            <tr key={row.name} className="border-b border-gray-100 align-top dark:border-gray-800" data-testid="hub-row">
                              <td className="py-2 pr-3">
                                {type === 'scenarios' ? <ScenarioName name={row.name} showLink={false} /> : <span className="font-mono text-xs">{row.name}</span>}
                                {alerts !== undefined && <div className="text-xs text-gray-500">{t('tools.hub.alertCount', { count: alerts })}</div>}
                              </td>
                              <td className="py-2 pr-3">
                                <div className="space-y-1">
                                  {selected.map((id) => {
                                    const item = row.byServer[id];
                                    return (
                                      <div key={id} className="flex flex-wrap items-center gap-1" data-testid="hub-item-state" data-server={id}>
                                        {selected.length > 1 && <span className="mr-1 text-xs text-gray-500">{nameOf(id)}</span>}
                                        {!item ? <span className="text-xs text-gray-400">–</span> : (
                                          <>
                                            <Badge variant={item.installed ? 'success' : 'secondary'}>{item.installed ? t('tools.hub.installed') : t('tools.hub.notInstalled')}</Badge>
                                            {item.installed && item.version && <Badge variant="outline">v{item.version}</Badge>}
                                            {item.upgradable && <Badge variant="info">{t('tools.hub.updateAvailable')}</Badge>}
                                            {item.tainted && <Badge variant="warning">{t('tools.hub.tainted')}</Badge>}
                                            {item.local && <Badge variant="outline">{t('tools.hub.local')}</Badge>}
                                          </>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </td>
                              <td className="hidden py-2 pr-3 text-gray-600 dark:text-gray-400 md:table-cell">{row.description}</td>
                              <td className="py-2 text-right">
                                <div className="flex flex-wrap justify-end gap-1">
                                  {(['install', 'upgrade', 'remove'] as const).map((action) => {
                                    const targets = targetsFor(row, action);
                                    if (targets.length === 0) return null;
                                    const label = t(`tools.hub.action.${action}`);
                                    const hubAction: HubAction = { action, type, name: row.name };
                                    if (!canAct) return <CopyCommand key={action} command={hubCommand(hubAction)} label={t('tools.hub.copyCommandFor', { action: label, name: row.name })} />;
                                    return (
                                      <button
                                        key={action}
                                        type="button"
                                        onClick={() => setPending({ kind: 'action', action: hubAction, targets })}
                                        aria-label={t('tools.hub.actionFor', { action: label, name: row.name })}
                                        className={`rounded px-2 py-1 text-xs font-medium text-white ${action === 'remove' ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}
                                      >
                                        {selected.length > 1 ? `${label} (${targets.length})` : label}
                                      </button>
                                    );
                                  })}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {items.length > limit && (
                  <button type="button" onClick={() => setLimit((value) => value + PAGE_SIZE)} className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400">
                    {t('tools.hub.showMore', { count: items.length - limit })}
                  </button>
                )}
              </CardContent>
            </Card>
          )}

          {!catalogLoaded && (reference?.seen_scenarios.length ?? 0) > 0 && noServers && (
            <Card>
              <CardContent className="space-y-3 pt-4">
                <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('tools.hub.seenTitle')}</h3>
                <p className="text-sm text-gray-500">{t('tools.hub.seenBody')}</p>
                <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                  {reference!.seen_scenarios.map((row) => (
                    <li key={row.name} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="hub-seen-row">
                      <div>
                        <ScenarioName name={row.name} showLink={false} />
                        <div className="text-xs text-gray-500">{t('tools.hub.alertCount', { count: row.alerts })}</div>
                      </div>
                      <CopyCommand command={`cscli scenarios inspect ${row.name}`} label={t('tools.hub.copyInspect', { name: row.name })} />
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-2 text-xs">
                  <CopyCommand command="cscli hub list" label={t('tools.hub.copyList')} />
                  <CopyCommand command="cscli hub update" label={t('tools.hub.copyUpdate')} />
                  <CopyCommand command="cscli hub upgrade" label={t('tools.hub.copyUpgradeAll')} />
                  <CopyCommand command={RELOAD_COMMAND} label={t('tools.hub.copyReload')} />
                </div>
                <p className="text-xs text-gray-500">{t('tools.hub.dockerHint')}</p>
              </CardContent>
            </Card>
          )}

          {catalogLoaded && seenMissing.length > 0 && (
            <ToolMessage>{t('tools.hub.seenMissing', { count: seenMissing.length, names: seenMissing.slice(0, 5).map((row) => row.name).join(', ') })}</ToolMessage>
          )}
        </>
      )}

      <Modal isOpen={dialog !== null} onClose={() => { if (!busy) setPending(null); }} title={dialog?.title ?? null} maxWidth="max-w-lg">
        {dialog && pending && (
          <div className="space-y-4">
            <p className="text-sm text-gray-700 dark:text-gray-300">{dialog.body}</p>
            {dialog.command && <code className="block overflow-x-auto rounded bg-gray-100 px-3 py-2 text-xs dark:bg-gray-800">{dialog.command}</code>}
            {pending.kind === 'reload' ? (
              <fieldset className="space-y-1" data-testid="hub-reload-servers">
                <legend className="text-sm font-medium text-gray-800 dark:text-gray-200">{t('tools.hub.reloadPick')}</legend>
                {pairedServers.map((server) => (
                  <label key={server.id} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                    <input
                      type="checkbox"
                      checked={reloadChoice.includes(server.id)}
                      onChange={() => setReloadChoice((current) => (current.includes(server.id) ? current.filter((id) => id !== server.id) : [...current, server.id]))}
                    />
                    <span>{server.name}</span>
                    {server.pending_reload && <Badge variant="warning">{t('tools.hub.servers.reloadNeeded')}</Badge>}
                  </label>
                ))}
              </fieldset>
            ) : (
              <div className="text-sm text-gray-700 dark:text-gray-300" data-testid="hub-targets">
                <p className="font-medium">{t('tools.hub.targets')}</p>
                <ul className="list-inside list-disc">{(dialog.targets ?? []).map((id) => <li key={id}>{nameOf(id)}</li>)}</ul>
              </div>
            )}
            {pending.kind !== 'reload' && <p className="text-xs text-gray-500">{t('tools.hub.reloadLater')}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" disabled={busy} onClick={() => setPending(null)} className="rounded border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600">{t('tools.hub.cancel')}</button>
              <button type="button" disabled={busy || dialog.disabled} onClick={() => { void run(); }} className={`rounded px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60 ${dialog.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}>
                {busy ? t('tools.hub.working') : dialog.confirmLabel}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal isOpen={removeTarget !== null} onClose={() => { if (!busy) setRemoveTarget(null); }} title={removeTarget ? t('tools.hub.remove.title', { name: removeTarget.name }) : null} maxWidth="max-w-lg">
        {removeTarget && (
          <div className="space-y-4">
            <p className="text-sm text-gray-700 dark:text-gray-300">{t('tools.hub.remove.body')}</p>
            <div className="flex justify-end gap-2">
              <button type="button" disabled={busy} onClick={() => setRemoveTarget(null)} className="rounded border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600">{t('tools.hub.cancel')}</button>
              <button type="button" disabled={busy} onClick={() => { void confirmRemove(); }} className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60">{busy ? t('tools.hub.working') : t('tools.hub.remove.confirm')}</button>
            </div>
          </div>
        )}
      </Modal>

      {pairTarget && servers && (
        <PairingModal
          key={pairTarget.name}
          machine={pairTarget}
          profiles={servers.profiles}
          ttlMinutes={servers.pairing_ttl_minutes}
          uninstallCommand={servers.uninstall_command}
          profileLabel={profileLabel}
          onClose={() => { setPairTarget(null); void refresh(); }}
          onServers={setServers}
        />
      )}
    </ToolPage>
  );
}
