import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import type { ConfigResponse, DecisionListItem, PaginatedResponse, SlimAlert } from '../../../types';
import * as api from '../../../lib/api';
import { compileAlertSearch } from '../../../../../shared/search';
import { I18nContext, type I18nContextValue, type TranslationValues } from '../../../lib/i18n';
import en from '../../../locales/en.json';

const largeDecisionList = Array.from({ length: 75 }, (_, index) => ({
  id: 1000 + index,
  value: `203.0.113.${index}`,
  type: 'ban',
  duration: `${index + 1}h`,
  simulated: false,
  expired: false,
  origin: 'CAPI',
}));

const setLastUpdatedMock = vi.fn();
let refreshSignalMock = 0;

function createDefaultConfigResponse(): ConfigResponse {
  return {
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
  };
}

function translateEnglish(key: string, values: TranslationValues = {}): string {
  let message = (en as Record<string, string>)[key] ?? key;
  for (const [name, value] of Object.entries(values)) {
    message = message.replaceAll(`{${name}}`, String(value ?? ''));
  }
  return message;
}

const chineseI18nValue: I18nContextValue = {
  language: 'zh',
  preference: 'zh',
  browserLanguage: 'zh',
  setLanguagePreference: () => undefined,
  t: translateEnglish,
};

function toPaginatedAlerts(
  alerts: SlimAlert[],
  page = 1,
  pageSize = 50,
  unfilteredTotal = alerts.length,
): PaginatedResponse<SlimAlert> {
  return {
    data: alerts.slice((page - 1) * pageSize, page * pageSize),
    pagination: {
      page,
      page_size: pageSize,
      total: alerts.length,
      total_pages: Math.ceil(alerts.length / pageSize),
      unfiltered_total: unfilteredTotal,
    },
    selectable_ids: alerts.map((alert) => alert.id),
  };
}

function toPaginatedDecisions(
  decisions: DecisionListItem[],
  page = 1,
  pageSize = 50,
): PaginatedResponse<DecisionListItem> {
  return {
    data: decisions.slice((page - 1) * pageSize, page * pageSize),
    pagination: {
      page,
      page_size: pageSize,
      total: decisions.length,
      total_pages: Math.ceil(decisions.length / pageSize),
      unfiltered_total: decisions.length,
    },
    selectable_ids: decisions
      .filter((decision) => !decision.expired)
      .map((decision) => decision.id),
  };
}

vi.mock('../../../contexts/useRefresh', () => ({
  useRefresh: () => ({
    refreshSignal: refreshSignalMock,
    setLastUpdated: setLastUpdatedMock,
  }),
}));

vi.mock('../../../lib/api', () => {
  const defaultAlerts: SlimAlert[] = [
    {
      id: 1,
      created_at: '2026-03-23T10:00:00.000Z',
      scenario: 'crowdsecurity/ssh-bf',
      machine_id: 'machine-1',
      machine_alias: 'host-a',
      source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', city: 'Berlin', region: 'State of Berlin', as_name: 'Hetzner' },
      target: 'ssh',
      meta_search: 'ssh',
      decisions: [{ id: 10, value: '1.2.3.4', type: 'ban', origin: 'manual', simulated: false, expired: false }],
    },
    {
      id: 2,
      created_at: '2026-03-23T11:00:00.000Z',
      scenario: 'crowdsecurity/nginx-bf',
      machine_id: 'machine-2',
      source: { ip: '5.6.7.8', value: '5.6.7.8', cn: 'US', as_name: 'AWS' },
      target: 'nginx',
      meta_search: 'nginx',
      simulated: true,
      decisions: [{ id: 20, value: '5.6.7.8', type: 'ban', origin: 'CAPI', simulated: true, expired: false }],
    },
    {
      id: 14302,
      created_at: '2026-03-24T19:47:52.000Z',
      scenario: 'manual/web-ui',
      source: { range: '192.168.5.0/24', cn: 'Unknown', as_name: 'Local Network' },
      target: 'manual',
      meta_search: '192.168.5.0/24 localhost',
      decisions: [{ id: 14302, value: '192.168.5.0/24', type: 'ban', origin: 'cscli', simulated: false, expired: false }],
    },
  ];

  const paginateAlerts = (
    alerts: typeof defaultAlerts,
    page = 1,
    pageSize = 50,
    unfilteredTotal = alerts.length,
  ) => ({
    data: alerts.slice((page - 1) * pageSize, page * pageSize),
    pagination: {
      page,
      page_size: pageSize,
      total: alerts.length,
      total_pages: Math.ceil(alerts.length / pageSize),
      unfiltered_total: unfilteredTotal,
    },
    selectable_ids: alerts.map((alert) => alert.id),
  });

  return {
    fetchFacet: vi.fn(async (_page: string, field: string) => ({
      field,
      values: field === 'country'
        ? [{ value: 'DE', count: 2 }, { value: 'US', count: 1 }]
        : [],
      offset: 0,
      has_more: false,
    })),
    fetchAlertsPaginated: vi.fn(async (page: number, pageSize: number, filters?: Record<string, string>) => {
      let alerts = defaultAlerts;
      if (filters?.simulation === 'simulated') {
        alerts = alerts.filter((alert) => alert.simulated === true);
      }
      if (filters?.q) {
        const compiledSearch = compileAlertSearch(filters.q, {
          machineEnabled: true,
          originEnabled: true,
        });
        if (!compiledSearch.ok) {
          throw new Error(compiledSearch.error.message);
        }
        alerts = alerts.filter(compiledSearch.predicate);
      }
      return paginateAlerts(alerts, page, pageSize, defaultAlerts.length);
    }),
    fetchAlert: vi.fn(async (id: string | number) => ({
      id,
      created_at: '2026-03-23T11:00:00.000Z',
      scenario: 'crowdsecurity/nginx-bf',
      machine_id: 'machine-2',
      source: { ip: '5.6.7.8', value: '5.6.7.8', cn: 'US', as_name: 'AWS' },
      target: 'nginx',
      message: 'Simulated alert',
      simulated: true,
      decisions: [{ id: 20, value: '5.6.7.8', type: 'ban', simulated: true, expired: false }],
      events: [],
    })),
    fetchDecisionsPaginated: vi.fn(async (_page: number, pageSize: number, filters?: Record<string, string>) => {
      const alertId = filters?.alert_id;
      const matchingAlert = defaultAlerts.find((alert) => String(alert.id) === alertId) || defaultAlerts[0];
      const decisions: DecisionListItem[] = (matchingAlert.decisions || []).map((decision) => ({
        id: decision.id,
        created_at: matchingAlert.created_at,
        machine: matchingAlert.machine_alias || matchingAlert.machine_id,
        value: decision.value,
        expired: decision.expired === true,
        is_duplicate: false,
        simulated: decision.simulated === true,
        detail: {
          origin: decision.origin || 'manual',
          type: decision.type,
          reason: matchingAlert.scenario,
          action: decision.type,
          country: matchingAlert.source?.cn,
          as: matchingAlert.source?.as_name,
          duration: decision.id === 14302 ? '30m' : '4h',
          expiration: '2030-01-01T00:00:00.000Z',
          alert_id: matchingAlert.id,
        },
      }));
      return toPaginatedDecisions(decisions, 1, pageSize);
    }),
    deleteAlert: vi.fn(),
    bulkDeleteAlerts: vi.fn(async () => ({
      requested_alerts: 0,
      requested_decisions: 0,
      deleted_alerts: 0,
      deleted_decisions: 0,
      failed: [],
    })),
    cleanupByIp: vi.fn(async () => ({
      requested_alerts: 0,
      requested_decisions: 0,
      deleted_alerts: 0,
      deleted_decisions: 0,
      failed: [],
    })),
    fetchConfig: vi.fn(async () => createDefaultConfigResponse()),
  };
});

beforeEach(() => {
  vi.mocked(api.fetchConfig).mockResolvedValue(createDefaultConfigResponse());
});

afterEach(() => {
  refreshSignalMock = 0;
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

async function flushAlertSearchDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
}

function getVisibleColumnHeaderNames(): string[] {
  return screen.getAllByRole('columnheader')
    .map((header) => header.textContent?.trim() || '')
    .filter(Boolean);
}


function setRefreshSignalMock(value: number): void {
  refreshSignalMock = value;
}

export { largeDecisionList, setLastUpdatedMock, refreshSignalMock, createDefaultConfigResponse, translateEnglish, chineseI18nValue, toPaginatedAlerts, toPaginatedDecisions, installControlledIntersectionObserver, createDeferred, flushAlertSearchDebounce, getVisibleColumnHeaderNames, setRefreshSignalMock };
