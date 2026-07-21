import { afterEach, beforeEach, vi } from 'vitest';

const {
  chartSpy,
  mapSpy,
  fetchConfigMock,
  fetchDashboardStatsMock,
  setLastUpdatedMock,
} = vi.hoisted(() => ({
  chartSpy: vi.fn(),
  mapSpy: vi.fn(),
  fetchConfigMock: vi.fn(),
  fetchDashboardStatsMock: vi.fn(),
  setLastUpdatedMock: vi.fn(),
}));
let refreshSignalMock = 0;

vi.mock('../../../contexts/useRefresh', () => ({
  useRefresh: () => ({
    refreshSignal: refreshSignalMock,
    setLastUpdated: setLastUpdatedMock,
  }),
}));

vi.mock('../../../components/DashboardCharts', () => ({
  ActivityBarChart: (props: unknown) => {
    chartSpy(props);
    return <div>Chart</div>;
  },
}));

vi.mock('../../../components/WorldMapCard', () => ({
  WorldMapCard: (props: unknown) => {
    mapSpy(props);
    return <div>Map</div>;
  },
}));

vi.mock('../../../lib/api', () => ({
  fetchConfig: fetchConfigMock,
  fetchDashboardStats: fetchDashboardStatsMock,
}));

function buildDashboardStatsResponse(filters?: Record<string, string>) {
  const simulation = filters?.simulation || 'all';
  const liveAlertCount = simulation === 'simulated' ? 0 : 1;
  const simulatedAlertCount = simulation === 'live' ? 0 : 1;
  const liveDecisionCount = simulation === 'simulated' ? 0 : 1;
  const simulatedDecisionCount = simulation === 'live' ? 0 : 1;
  const allAlertCount = liveAlertCount + simulatedAlertCount;
  const bucket = {
    date: filters?.granularity === 'hour' ? '2026-04-07T10' : '2026-04-07',
    fullDate: '2026-04-07T10:00:00.000Z',
  };

  return {
    totals: {
      alerts: 2,
      decisions: 1,
      simulatedAlerts: 1,
      simulatedDecisions: 1,
    },
    filteredTotals: {
      alerts: allAlertCount,
      decisions: liveDecisionCount,
      simulatedAlerts: simulatedAlertCount,
      simulatedDecisions: simulatedDecisionCount,
    },
    globalTotal: allAlertCount,
    topTargets: liveAlertCount ? [{ label: 'ssh', count: liveAlertCount }] : [],
    topCountries: liveAlertCount ? [{ label: 'Germany', value: 'DE', countryCode: 'DE', count: liveAlertCount }] : [],
    allCountries: [
      {
        label: 'Germany',
        countryCode: 'DE',
        count: allAlertCount,
        liveCount: liveAlertCount,
        simulatedCount: simulatedAlertCount,
      },
    ],
    attackLocations: [
      {
        latitude: 52.52,
        longitude: 13.405,
        count: allAlertCount,
        liveCount: liveAlertCount,
        simulatedCount: simulatedAlertCount,
      },
    ],
    topScenarios: liveAlertCount ? [{ label: 'crowdsecurity/ssh-bf', count: liveAlertCount }] : [],
    topAS: liveAlertCount ? [{ label: 'Hetzner', count: liveAlertCount }] : [],
    series: {
      alertsHistory: [{ ...bucket, count: liveAlertCount }],
      simulatedAlertsHistory: [{ ...bucket, count: simulatedAlertCount }],
      decisionsHistory: [{ ...bucket, count: liveDecisionCount }],
      simulatedDecisionsHistory: [{ ...bucket, count: simulatedDecisionCount }],
      activeDecisionsHistory: [{ ...bucket, count: liveDecisionCount }],
      activeSimulatedDecisionsHistory: [{ ...bucket, count: simulatedDecisionCount }],
      unfilteredAlertsHistory: [{ ...bucket, count: liveAlertCount }],
      unfilteredSimulatedAlertsHistory: [{ ...bucket, count: simulatedAlertCount }],
      unfilteredDecisionsHistory: [{ ...bucket, count: liveDecisionCount }],
      unfilteredSimulatedDecisionsHistory: [{ ...bucket, count: simulatedDecisionCount }],
    },
  };
}

beforeEach(() => {
  refreshSignalMock = 0;
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  localStorage.clear();
  chartSpy.mockClear();
  mapSpy.mockClear();
  fetchDashboardStatsMock.mockClear();
  setLastUpdatedMock.mockClear();
  fetchConfigMock.mockResolvedValue({
    lookback_period: '7d',
    lookback_hours: 168,
    lookback_days: 7,
    refresh_interval: 30000,
    current_interval_name: '30s',
    lapi_status: { isConnected: true, lastCheck: null, lastError: null, offline_since: null },
    sync_status: { isSyncing: false, progress: 100, message: 'done', startedAt: null, completedAt: null },
    simulations_enabled: true,
    machine_features_enabled: false,
    origin_features_enabled: false,
  });
  fetchDashboardStatsMock.mockImplementation(async (filters?: Record<string, string>) => buildDashboardStatsResponse(filters));
});

afterEach(() => {
  refreshSignalMock = 0;
  vi.restoreAllMocks();
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}


function setRefreshSignalMock(value: number): void {
  refreshSignalMock = value;
}

export { chartSpy, mapSpy, fetchConfigMock, fetchDashboardStatsMock, setLastUpdatedMock, refreshSignalMock, buildDashboardStatsResponse, createDeferred, setRefreshSignalMock };
