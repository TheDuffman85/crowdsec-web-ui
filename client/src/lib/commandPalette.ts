export interface PaletteCommand {
  id: string;
  labelKey: string;
  /** Passed to the translated label as `{query}` for search commands. */
  query?: string;
  path: string;
  /** Two-key sequence started with `g`, for example `d` for `g d`. */
  shortcut?: string;
}

interface NavigationTarget {
  id: string;
  labelKey: string;
  path: string;
  shortcut?: string;
}

export const NAVIGATION_TARGETS: readonly NavigationTarget[] = [
  { id: 'dashboard', labelKey: 'components.sidebar.nav.dashboard', path: '/', shortcut: 'd' },
  { id: 'statistics', labelKey: 'pages.statistics.title', path: '/statistics', shortcut: 's' },
  { id: 'alerts', labelKey: 'components.sidebar.nav.alerts', path: '/alerts', shortcut: 'a' },
  { id: 'decisions', labelKey: 'components.sidebar.nav.decisions', path: '/decisions', shortcut: 'b' },
  { id: 'allowlists', labelKey: 'components.sidebar.nav.allowlists', path: '/allowlists', shortcut: 'l' },
  { id: 'metrics', labelKey: 'components.sidebar.nav.metrics', path: '/metrics', shortcut: 'm' },
  { id: 'notifications', labelKey: 'components.sidebar.nav.notifications', path: '/notifications', shortcut: 'n' },
  { id: 'tools', labelKey: 'components.sidebar.nav.tools', path: '/tools', shortcut: 'o' },
  { id: 'geo-blocking', labelKey: 'tools.geo.title', path: '/tools/geo-blocking' },
  { id: 'auto-ban', labelKey: 'tools.autoBan.title', path: '/tools/auto-ban' },
  { id: 'repeat-offenders', labelKey: 'tools.offenders.title', path: '/tools/repeat-offenders' },
  { id: 'blocklists', labelKey: 'tools.blocklists.title', path: '/tools/blocklists' },
  { id: 'hosts', labelKey: 'tools.hosts.title', path: '/tools/hosts' },
  { id: 'wallboard', labelKey: 'tools.wallboard.title', path: '/tools/wallboard', shortcut: 'w' },
  { id: 'hub', labelKey: 'tools.hub.title', path: '/tools/hub' },
  { id: 'asn', labelKey: 'tools.asn.title', path: '/tools/asn' },
  { id: 'ip-timeline', labelKey: 'tools.timeline.title', path: '/tools/ip-timeline' },
  { id: 'audit-log', labelKey: 'tools.audit.title', path: '/tools/audit-log' },
  { id: 'attack-map', labelKey: 'tools.attackMap.title', path: '/tools/attack-map' },
  { id: 'report', labelKey: 'tools.report.title', path: '/tools/report' },
  { id: 'settings', labelKey: 'components.sidebar.nav.settings', path: '/settings', shortcut: 't' },
];

const IP_OR_RANGE = /^(?:\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?|[0-9a-f]*:[0-9a-f:]*(?:\/\d{1,3})?)$/i;

export function looksLikeIp(value: string): boolean {
  return IP_OR_RANGE.test(value.trim());
}

/** Commands for the typed text: matching pages first, then searches across alerts and decisions. */
export function buildPaletteCommands(
  rawQuery: string,
  translate: (key: string) => string,
): PaletteCommand[] {
  const query = rawQuery.trim();
  const needle = query.toLowerCase();
  const pages: PaletteCommand[] = NAVIGATION_TARGETS
    .filter((target) => !needle || translate(target.labelKey).toLowerCase().includes(needle))
    .map((target) => ({
      id: `go-${target.id}`,
      labelKey: target.labelKey,
      path: target.path,
      shortcut: target.shortcut,
    }));
  if (!query) return pages;

  const encoded = encodeURIComponent(query);
  const ip = looksLikeIp(query);
  return [
    ...pages,
    {
      id: 'search-alerts',
      labelKey: ip ? 'components.commandPalette.lookUpIpAlerts' : 'components.commandPalette.searchAlerts',
      query,
      path: `/alerts?q=${encoded}`,
    },
    {
      id: 'search-decisions',
      labelKey: ip ? 'components.commandPalette.lookUpIpDecisions' : 'components.commandPalette.searchDecisions',
      query,
      path: `/decisions?q=${encoded}`,
    },
  ];
}

/** True when keystrokes belong to a form control or editor rather than to global shortcuts. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function findShortcutTarget(key: string): NavigationTarget | undefined {
  return NAVIGATION_TARGETS.find((target) => target.shortcut === key.toLowerCase());
}
