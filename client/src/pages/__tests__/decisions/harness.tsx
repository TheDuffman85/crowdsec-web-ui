import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import type { ConfigResponse, DecisionListItem, PaginatedResponse } from '../../../types';
import * as api from '../../../lib/api';
import { compileDecisionSearch } from '../../../../../shared/search';
import { I18nContext, type I18nContextValue } from '../../../lib/i18n';

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

const chineseI18nValue: I18nContextValue = {
  language: 'zh',
  preference: 'zh',
  browserLanguage: 'zh',
  setLanguagePreference: () => undefined,
  t: (key) => key,
};

function toPaginatedDecisions(
  decisions: DecisionListItem[],
  page = 1,
  pageSize = 50,
  unfilteredTotal = decisions.length,
): PaginatedResponse<DecisionListItem> {
  return {
    data: decisions.slice((page - 1) * pageSize, page * pageSize),
    pagination: {
      page,
      page_size: pageSize,
      total: decisions.length,
      total_pages: Math.ceil(decisions.length / pageSize),
      unfiltered_total: unfilteredTotal,
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
  const defaultDecisions = [
    {
      id: 10,
      created_at: '2026-03-23T10:00:00.000Z',
      machine: 'host-a',
      value: '1.2.3.4',
      expired: false,
      is_duplicate: false,
      simulated: false,
      detail: {
        origin: 'manual',
        reason: 'crowdsecurity/ssh-bf',
        country: 'DE',
        as: 'Hetzner',
        action: 'ban',
        duration: '4h',
        alert_id: 1,
        target: 'ssh',
      },
    },
    {
      id: 20,
      created_at: '2026-03-24T11:00:00.000Z',
      machine: 'machine-2',
      value: '5.6.7.8',
      expired: false,
      is_duplicate: false,
      simulated: true,
      detail: {
        origin: 'CAPI',
        reason: 'crowdsecurity/nginx-bf',
        country: 'US',
        as: 'AWS',
        action: 'ban',
        duration: '4h',
        alert_id: 2,
        target: 'nginx',
      },
    },
  ];

  const paginateDecisions = (
    decisions: typeof defaultDecisions,
    page = 1,
    pageSize = 50,
    unfilteredTotal = decisions.length,
  ) => ({
    data: decisions.slice((page - 1) * pageSize, page * pageSize),
    pagination: {
      page,
      page_size: pageSize,
      total: decisions.length,
      total_pages: Math.ceil(decisions.length / pageSize),
      unfiltered_total: unfilteredTotal,
    },
    selectable_ids: decisions
      .filter((decision) => !decision.expired)
      .map((decision) => decision.id),
  });

  return {
    fetchDecisionsPaginated: vi.fn(async (page: number, pageSize: number, filters?: Record<string, string>) => {
      let decisions = defaultDecisions;
      if (filters?.simulation === 'simulated') {
        decisions = decisions.filter((decision) => decision.simulated === true);
      }
      if (filters?.q) {
        const compiledSearch = compileDecisionSearch(filters.q, {
          machineEnabled: true,
          originEnabled: true,
        });
        if (!compiledSearch.ok) {
          throw new Error(compiledSearch.error.message);
        }
        decisions = decisions.filter(compiledSearch.predicate);
      }
      return paginateDecisions(decisions, page, pageSize, defaultDecisions.length);
    }),
    addDecision: vi.fn(),
    deleteDecision: vi.fn(),
    bulkDeleteDecisions: vi.fn(async () => ({
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
  vi.mocked(api.fetchDecisionsPaginated).mockImplementation(async (page: number, pageSize = 50, filters?: Record<string, string>) => {
    let decisions: DecisionListItem[] = [
      {
        id: 10,
        created_at: '2026-03-23T10:00:00.000Z',
        machine: 'host-a',
        value: '1.2.3.4',
        expired: false,
        is_duplicate: false,
        simulated: false,
        detail: {
          origin: 'manual',
          reason: 'crowdsecurity/ssh-bf',
          country: 'DE',
          city: 'Berlin',
          region: 'State of Berlin',
          as: 'Hetzner',
          action: 'ban',
          duration: '4h',
          alert_id: 1,
          target: 'ssh',
        },
      },
      {
        id: 20,
        created_at: '2026-03-24T11:00:00.000Z',
        machine: 'machine-2',
        value: '5.6.7.8',
        expired: false,
        is_duplicate: false,
        simulated: true,
        detail: {
          origin: 'CAPI',
          reason: 'crowdsecurity/nginx-bf',
          country: 'US',
          as: 'AWS',
          action: 'ban',
          duration: '4h',
          alert_id: 2,
          target: 'nginx',
        },
      },
    ];

    if (filters?.simulation === 'simulated') {
      decisions = decisions.filter((decision) => decision.simulated === true);
    }
    if (filters?.q) {
      const compiledSearch = compileDecisionSearch(filters.q, {
        machineEnabled: true,
        originEnabled: true,
      });
      if (!compiledSearch.ok) {
        throw new Error(compiledSearch.error.message);
      }
      decisions = decisions.filter(compiledSearch.predicate);
    }

    return toPaginatedDecisions(decisions, page, pageSize, 2);
  });
});

afterEach(() => {
  refreshSignalMock = 0;
  vi.useRealTimers();
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

async function flushDecisionSearchDebounce(): Promise<void> {
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

export { setLastUpdatedMock, refreshSignalMock, createDefaultConfigResponse, chineseI18nValue, toPaginatedDecisions, installControlledIntersectionObserver, createDeferred, flushDecisionSearchDebounce, getVisibleColumnHeaderNames, setRefreshSignalMock };
