import '@testing-library/jest-dom/vitest';

const translations: Record<string, string> = {
  'common.loading': 'Loading...',
  'common.loading_dashboard': 'Loading dashboard...',
  'common.loading_chart': 'Loading chart...',
  'common.loading_map': 'Loading map...',
  'common.refreshing': 'Refreshing...',
  'common.refreshing_dashboard': 'Refreshing dashboard...',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.deleting': 'Deleting...',
  'common.save': 'Save',
  'common.saving': 'Saving...',
  'common.off': 'Off',
  'common.no_data': 'No data available',
  'common.learn_more': 'Learn more',
  'common.see_readme': 'See README: ',
  'layout.page_title_dashboard': 'Dashboard',
  'layout.page_title_alerts': 'Alerts',
  'layout.page_title_decisions': 'Decisions',
  'layout.page_title_notifications': 'Notifications',
  'layout.aria_open_menu': 'Open Menu',
  'layout.aria_close_menu': 'Close Menu',
  'sidebar.title': 'CrowdSec Web UI',
  'sidebar.nav_dashboard': 'Dashboard',
  'sidebar.nav_alerts': 'Alerts',
  'sidebar.nav_decisions': 'Decisions',
  'sidebar.nav_notifications': 'Notifications',
  'sidebar.refresh_label': 'Refresh',
  'sidebar.refresh_off': 'Off',
  'sidebar.refresh_5s': 'Every 5s',
  'sidebar.refresh_30s': 'Every 30s',
  'sidebar.refresh_1m': 'Every 1m',
  'sidebar.refresh_5m': 'Every 5m',
  'sidebar.dark_mode': 'Dark Mode',
  'sidebar.light_mode': 'Light Mode',
  'sidebar.update_available': 'Update Available',
  'sidebar.new_version': 'New version:',
  'sidebar.development': 'Development',
  'sidebar.aria_logo': 'CrowdSec Logo',
  'sidebar.unread_notifications': '{{count}} unread notifications',
  'sidebar.crowdsec_lapi': 'CrowdSec LAPI',
  'sidebar.online': 'Online',
  'sidebar.offline': 'Offline',
  'sidebar.aria_collapse_menu': 'Collapse Menu',
  'sidebar.aria_expand_menu': 'Expand Menu',
  'sidebar.expand_menu': 'Expand Menu',
  'dashboard.total_alerts': 'Total Alerts',
  'dashboard.active_decisions': 'Active Decisions',
  'dashboard.simulation': 'Simulation',
  'dashboard.last_days_stats': 'Last {{days}} Days Statistics',
  'dashboard.view_alerts': 'View Alerts',
  'dashboard.view_decisions': 'View Decisions',
  'dashboard.reset_filters': 'Reset Filters',
  'dashboard.filtered': 'Filtered',
  'dashboard.global': 'Global',
  'dashboard.mode': 'Mode',
  'dashboard.all': 'All',
  'dashboard.live': 'Live',
  'dashboard.top_countries': 'Top Countries',
  'dashboard.top_scenarios': 'Top Scenarios',
  'dashboard.top_as': 'Top AS',
  'dashboard.top_targets': 'Top Targets',
  'alerts.loading_alerts': 'Loading alerts...',
  'alerts.no_alerts': 'No alerts found',
  'alerts.summary': 'Showing {{count}} of {{total}} alerts',
  'alerts.summary_filtered': 'Showing {{count}} of {{total}} alerts ({{unfiltered}} total before filters)',
  'alerts.delete_selected': 'Delete selected',
  'alerts.reset_all_filters': 'Reset all filters',
  'alerts.search': 'Search:',
  'alerts.simulation_badge': 'Simulation:',
  'alerts.actions': 'Actions',
  'alerts.filter_alerts': 'Filter alerts...',
  'alerts.aria_select_all': 'Select all filtered alerts',
  'alerts.aria_select_alert': 'Select alert {{id}}',
  'alerts.aria_delete_alert': 'Delete Alert',
  'alerts.aria_delete_all_ip': 'Delete all alerts and decisions for {{value}}',
  'alerts.aria_search_help': 'Search syntax help',
  'alerts.aria_columns': 'Choose alert table columns',
  'alerts.aria_dismiss_error': 'Dismiss error message',
  'alerts.alert_details': 'Alert Details',
  'alerts.alert_details_id': 'Alert Details #{{id}}',
  'alerts.captured_at': 'Captured at {{time}}',
  'alerts.machine': 'Machine',
  'alerts.scenario': 'Scenario',
  'alerts.location': 'Location',
  'alerts.ip_range': 'IP / Range',
  'alerts.message': 'Message',
  'alerts.decisions_taken': 'Decisions Taken',
  'alerts.showing_decisions': 'Showing {{count}} of {{total}}',
  'alerts.events_title': 'Events ({{count}})',
  'alerts.show_all_events': 'Show all {{total}} events ({{remaining}} more)',
  'alerts.delete_alert_confirm': 'Are you sure you want to delete alert #{{id}}? This will also delete all associated decisions. This action cannot be undone.',
  'alerts.delete_selected_confirm': 'Are you sure you want to delete {{count}} selected alert? This will also remove associated decisions from the cache.',
  'alerts.delete_ip_confirm': 'Are you sure you want to delete all alerts and decisions for {{ip}}? This action cannot be undone.',
  'alerts.search_syntax_error': 'Search syntax error at character {{position}}: {{message}}',
  'alerts.delete_alert': 'Delete Alert?',
  'alerts.delete_selected_modal_title': 'Delete Selected Alerts?',
  'alerts.delete_all_ip_modal_title': 'Delete All for this IP?',
  'alerts.active': 'Active',
  'alerts.inactive_label': 'Inactive',
  'decisions.loading_decisions': 'Loading decisions...',
  'decisions.no_decisions': 'No decisions found',
  'decisions.no_decisions_for_alert': 'No decisions for this alert',
  'decisions.summary': 'Showing {{count}} of {{total}} decisions',
  'decisions.summary_filtered': 'Showing {{count}} of {{total}} decisions ({{unfiltered}} total before filters)',
  'decisions.delete_selected': 'Delete selected',
  'decisions.add_decision': 'Add Decision',
  'decisions.add_manual_decision': 'Add Manual Decision',
  'decisions.adding': 'Adding...',
  'decisions.reset_all_filters': 'Reset all filters',
  'decisions.search': 'Search:',
  'decisions.hide_inactive': 'Hide: Inactive',
  'decisions.hide_duplicates': 'Hide: Duplicates',
  'decisions.alert_filter': 'Alert:',
  'decisions.simulation': 'Simulation:',
  'decisions.expired': '(Expired)',
  'decisions.decision_expired': 'Decision already expired',
  'decisions.actions': 'Actions',
  'decisions.filter_decisions': 'Filter decisions...',
  'decisions.aria_select_all': 'Select all filtered decisions',
  'decisions.aria_select_decision': 'Select decision {{id}}',
  'decisions.aria_delete_decision': 'Delete Decision',
  'decisions.aria_delete_all_ip': 'Delete all alerts and decisions for {{value}}',
  'decisions.aria_search_help': 'Search syntax help',
  'decisions.aria_columns': 'Choose decision table columns',
  'decisions.aria_dismiss_error': 'Dismiss error message',
  'decisions.search_syntax_error': 'Search syntax error at character {{position}}: {{message}}',
  'decisions.delete_decision': 'Delete Decision?',
  'decisions.delete_selected_modal_title': 'Delete Selected Decisions?',
  'decisions.delete_all_ip_modal_title': 'Delete All for this IP?',
  'decisions.delete_decision_confirm': 'Are you sure you want to delete decision #{{id}}? This action cannot be undone.',
  'decisions.delete_selected_confirm': 'Are you sure you want to delete {{count}} selected decision? This action cannot be undone.',
  'decisions.delete_ip_confirm': 'Are you sure you want to delete all alerts and decisions for {{ip}}? This action cannot be undone.',
  'decisions.search_syntax_error': 'Search syntax error at character {{position}}: {{message}}',
  'decisions.delete_decision': 'Delete Decision?',
  'decisions.delete_selected_modal_title': 'Delete Selected Decisions?',
  'decisions.delete_all_ip_modal_title': 'Delete All for this IP?',
  'decisions.ip_range': 'IP / Range',
  'decisions.duration': 'Duration',
  'decisions.reason': 'Reason',
  'decisions.placeholder_ip': '1.2.3.4',
  'decisions.placeholder_duration': '4h',
  'decisions.placeholder_reason': 'Manual ban',
  'decisions.duration_hint': 'e.g. 4h, 1d, 30m',
  'notifications.loading': 'Loading notifications...',
  'notifications.failed_to_load': 'Failed to load notifications',
  'notifications.unread_title': 'Unread Notifications',
  'notifications.destinations': 'Destinations',
  'notifications.rules': 'Rules',
  'notifications.active_count': '{{count}} active',
  'notifications.recent_notifications': 'Recent Notifications',
  'notifications.no_notifications': 'No notifications yet.',
  'notifications.select_all': 'Select all notifications',
  'notifications.mark_selected_read': 'Mark Selected Read',
  'notifications.delete_selected': 'Delete Selected',
  'notifications.delete_all_read': 'Delete All Read',
  'notifications.delete_notification_title': 'Delete Notification?',
  'notifications.delete_selected_title': 'Delete Selected Notifications?',
  'notifications.delete_read_title': 'Delete All Read Notifications?',
  'notifications.no_destinations': 'No outbound destinations configured yet.',
  'notifications.no_rules': 'No notification rules configured yet.',
  'notifications.destinations_title': 'Destinations',
  'notifications.add_destination': 'Add Destination',
  'notifications.rules_title': 'Rules',
  'notifications.add_rule': 'Add Rule',
  'common.showing_of': 'Showing {{count}} of {{total}}',
  'common.showing_of_before_filters': 'Showing {{count}} of {{total}} ({{unfiltered}} total before filters)',
  'common.add': 'Add',
  'common.edit': 'Edit',
  'common.remove': 'Remove',
  'common.close': 'Close',
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.enabled': 'Enabled',
  'common.disabled': 'Disabled',
  'common.active': 'Active',
  'common.inactive': 'Inactive',
  'common.not_applicable': '-',
  'stat_card.no_data': 'No data available',
  'table_columns.id': 'ID',
  'table_columns.time': 'Time',
  'table_columns.scenario': 'Scenario',
  'table_columns.country': 'Country',
  'table_columns.as': 'AS',
  'table_columns.source': 'Source',
  'table_columns.machine': 'Machine',
  'table_columns.origin': 'Origin',
  'table_columns.decisions': 'Decisions',
  'table_columns.action': 'Action',
  'table_columns.expiration': 'Expiration',
  'table_columns.alert': 'Alert',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      let text = translations[key] ?? key;
      if (options) {
        for (const [k, v] of Object.entries(options)) {
          text = text.replace(`{{${k}}}`, String(v));
        }
      }
      return text;
    },
    i18n: {
      language: 'en',
      changeLanguage: vi.fn(),
    },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

class MockIntersectionObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

Object.defineProperty(globalThis, 'IntersectionObserver', {
  writable: true,
  configurable: true,
  value: MockIntersectionObserver,
});

type StorageMethodName = 'getItem' | 'setItem' | 'removeItem' | 'clear' | 'key';

function hasWorkingStorage(storage: unknown): storage is Storage {
  if (!storage || typeof storage !== 'object') {
    return false;
  }

  return ['getItem', 'setItem', 'removeItem', 'clear', 'key'].every((method) =>
    typeof (storage as Record<StorageMethodName, unknown>)[method as StorageMethodName] === 'function',
  );
}

function createStorageMock(): Storage {
  const store = new Map<string, string>();

  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key) {
      store.delete(key);
    },
    setItem(key, value) {
      store.set(String(key), String(value));
    },
  };
}

function installStorageMock(name: 'localStorage' | 'sessionStorage') {
  try {
    if (hasWorkingStorage(window[name])) {
      return;
    }
  } catch {
    // Some runtimes expose the property but throw when accessed.
  }

  const storage = createStorageMock();

  Object.defineProperty(window, name, {
    value: storage,
    writable: true,
    configurable: true,
  });

  Object.defineProperty(globalThis, name, {
    value: storage,
    writable: true,
    configurable: true,
  });
}

installStorageMock('localStorage');
installStorageMock('sessionStorage');
