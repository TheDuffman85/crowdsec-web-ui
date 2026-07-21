import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, vi } from 'vitest';
import type { NotificationChannel, NotificationItem, NotificationListResponse, NotificationRule, NotificationSettingsResponse } from '../../../types';
import { I18nContext, type I18nContextValue } from '../../../lib/i18n';
import en from '../../../locales/en.json';
import zh from '../../../locales/zh.json';

vi.mock('../../../contexts/useRefresh', () => ({
  useRefresh: () => ({
    refreshSignal: 0,
  }),
}));

vi.mock('../../../contexts/useNotificationUnreadCount', () => ({
  useNotificationUnreadCount: vi.fn(),
}));

vi.mock('../../../lib/api', () => ({
  fetchNotificationSettings: vi.fn(),
  fetchNotificationsPaginated: vi.fn(),
  createNotificationChannel: vi.fn(),
  updateNotificationChannel: vi.fn(),
  deleteNotificationChannel: vi.fn(),
  testNotificationChannel: vi.fn(),
  createNotificationRule: vi.fn(),
  updateNotificationRule: vi.fn(),
  deleteNotificationRule: vi.fn(),
  deleteNotification: vi.fn(),
  bulkDeleteNotifications: vi.fn(),
  deleteReadNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markNotificationsRead: vi.fn(),
  fetchConfig: vi.fn(),
}));

import {
  fetchConfig,
  fetchNotificationSettings,
  fetchNotificationsPaginated,
} from '../../../lib/api';
import { useNotificationUnreadCount } from '../../../contexts/useNotificationUnreadCount';

const setUnreadCountMock = vi.fn();
const refreshUnreadCountMock = vi.fn();

const buildSettings = (overrides?: {
  channels?: NotificationChannel[];
  rules?: NotificationRule[];
}): NotificationSettingsResponse => ({
  channels: overrides?.channels ?? [
    {
      id: 'channel-1',
      name: 'Ops MQTT',
      type: 'mqtt',
      enabled: true,
      config: {
        brokerUrl: 'mqtt://broker.example.com:1883',
        username: 'ops',
        password: '(stored)',
        clientId: '',
        keepaliveSeconds: 60,
        connectTimeoutMs: 10000,
        qos: 1,
        topic: 'crowdsec/notifications',
        retainEvents: false,
      },
      configured_secrets: ['password'],
      created_at: '2026-03-28T12:00:00.000Z',
      updated_at: '2026-03-28T12:00:00.000Z',
    },
  ],
  rules: overrides?.rules ?? [],
});

function mockMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

function buildNotificationPage(overrides?: {
  data?: NotificationItem[];
  unread_count?: number;
  selectable_ids?: string[];
  total?: number;
  total_pages?: number;
  page?: number;
  page_size?: number;
}): NotificationListResponse {
  return {
    data: overrides?.data ?? [],
    pagination: {
      page: overrides?.page ?? 1,
      page_size: overrides?.page_size ?? 50,
      total: overrides?.total ?? (overrides?.data?.length ?? 0),
      total_pages: overrides?.total_pages ?? ((overrides?.data?.length ?? 0) > 0 ? 1 : 0),
      unfiltered_total: overrides?.total ?? (overrides?.data?.length ?? 0),
    },
    selectable_ids: overrides?.selectable_ids ?? (overrides?.data?.map((item) => String(item.id)) ?? []),
    unread_count: overrides?.unread_count ?? 0,
  };
}

function installControlledIntersectionObserver() {
  const callbacks: Array<() => void> = [];

  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) {
      callbacks.push(() => {
        callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      });
    }

    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  });

  return () => callbacks.forEach((callback) => callback());
}

function createTestTranslator(messages: Record<string, string>) {
  const fallbackMessages = en as Record<string, string>;
  return (key: string, values: Record<string, string | number | boolean | null | undefined> = {}) => {
    let template = messages[key] ?? fallbackMessages[key] ?? key;
    for (const [name, value] of Object.entries(values)) {
      template = template.replaceAll(`{${name}}`, String(value ?? ''));
    }
    return template;
  };
}

function renderWithChineseLocale(children: ReactNode) {
  const i18nValue: I18nContextValue = {
    language: 'zh',
    preference: 'zh',
    browserLanguage: 'zh',
    setLanguagePreference: () => undefined,
    t: createTestTranslator(zh as Record<string, string>),
  };

  return render(
    <I18nContext.Provider value={i18nValue}>
      {children}
    </I18nContext.Provider>,
  );
}

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockMatchMedia();
    setUnreadCountMock.mockReset();
    refreshUnreadCountMock.mockReset();

    vi.mocked(useNotificationUnreadCount).mockReturnValue({
      unreadCount: 0,
      setUnreadCount: setUnreadCountMock,
      refreshUnreadCount: refreshUnreadCountMock,
    });

    vi.mocked(fetchNotificationSettings).mockResolvedValue(buildSettings());

    vi.mocked(fetchNotificationsPaginated).mockResolvedValue(buildNotificationPage());
    vi.mocked(fetchConfig).mockResolvedValue({
      lookback_period: '1h',
      lookback_hours: 1,
      lookback_days: 1,
      refresh_interval: 30000,
      current_interval_name: '30s',
      lapi_status: { isConnected: true, lastCheck: null, lastError: null, offline_since: null },
      sync_status: { isSyncing: false, progress: 100, message: 'done', startedAt: null, completedAt: null },
      simulations_enabled: true,
      machine_features_enabled: false,
      origin_features_enabled: false,
      permissions: {
        mode: 'admin',
        can_manage_enforcement: true,
        can_manage_settings: true,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });


export { setUnreadCountMock, refreshUnreadCountMock, buildSettings, mockMatchMedia, buildNotificationPage, installControlledIntersectionObserver, createTestTranslator, renderWithChineseLocale };
