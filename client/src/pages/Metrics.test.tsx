import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Metrics } from './Metrics';
import type { CrowdsecMetricsResponse } from '../types';

const {
  fetchConfigMock,
  fetchCrowdsecMetricsMock,
  setLastUpdatedMock,
} = vi.hoisted(() => ({
  fetchConfigMock: vi.fn(),
  fetchCrowdsecMetricsMock: vi.fn(),
  setLastUpdatedMock: vi.fn(),
}));

vi.mock('../contexts/useRefresh', () => ({
  useRefresh: () => ({
    refreshSignal: 0,
    setLastUpdated: setLastUpdatedMock,
  }),
}));

vi.mock('../lib/api', () => ({
  fetchConfig: fetchConfigMock,
  fetchCrowdsecMetrics: fetchCrowdsecMetricsMock,
}));

function buildMetricsResponse(): CrowdsecMetricsResponse {
  return {
    fetched_at: '2026-06-30T10:00:00.000Z',
    totals: {
      bouncerRequests: 10,
      machineRequests: 5,
      appsecRequests: 100,
      appsecBlocked: 7,
      parserProcessed: 95,
      parserOk: 94,
      parserKo: 1,
      parserSuccessRate: 94 / 95,
      parserAverageSeconds: 0.002,
      whitelistHits: 2,
      whitelisted: 1,
    },
    bouncers: [],
    machines: [],
    parserSources: [],
    parserNodes: [],
    whitelists: [],
    parserTimings: [
      {
        source: 'journalctl',
        type: 'syslog',
        count: 10,
        averageSeconds: 0.002,
      },
    ],
    lapiRoutes: [
      {
        method: 'GET',
        route: '/v1/alerts',
        requests: 4,
        averageSeconds: 0.2,
      },
    ],
    appsecEngines: [
      {
        engine: 'appsec',
        source: '0.0.0.0:7422',
        requests: 100,
        blocked: 7,
        blockRate: 0.07,
      },
    ],
  };
}

beforeEach(() => {
  fetchConfigMock.mockReset();
  fetchCrowdsecMetricsMock.mockReset();
  setLastUpdatedMock.mockReset();
  fetchConfigMock.mockResolvedValue({ metrics_enabled: true });
});

describe('Metrics page', () => {
  test('renders Grafana-inspired runtime sections', async () => {
    fetchCrowdsecMetricsMock.mockResolvedValue(buildMetricsResponse());

    render(<Metrics />);

    await waitFor(() => expect(screen.getByText('LAPI latency')).toBeInTheDocument());
    expect(screen.getByText('LAPI latency')).toBeInTheDocument();
    expect(screen.getByText('/v1/alerts')).toBeInTheDocument();
    expect(screen.getByText('AppSec engines')).toBeInTheDocument();
    expect(screen.getByText('appsec')).toBeInTheDocument();
    expect(screen.getByLabelText(/Parser timing color:/)).toBeInTheDocument();
    expect(screen.getByLabelText(/AppSec block rate color:/)).toBeInTheDocument();
  });

  test('handles missing optional runtime sections', async () => {
    const response = buildMetricsResponse();
    delete response.lapiRoutes;
    delete response.appsecEngines;
    fetchCrowdsecMetricsMock.mockResolvedValue(response);

    render(<Metrics />);

    await waitFor(() => expect(screen.getByText('No LAPI duration histogram data was exposed by CrowdSec.')).toBeInTheDocument());
    expect(screen.getByText('No AppSec engine metrics were exposed by CrowdSec.')).toBeInTheDocument();
  });
});
