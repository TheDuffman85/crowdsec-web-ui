import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  window.localStorage.clear();
  fetchConfigMock.mockResolvedValue({ metrics_enabled: true });
});

describe('Metrics page', () => {
  test('shows the current per-instance metrics configuration when no endpoint is configured', async () => {
    fetchConfigMock.mockResolvedValue({
      metrics_enabled: false,
      instances: [{ id: 'primary', name: 'Primary', prometheus: [] }],
    });

    render(<Metrics />);

    expect(await screen.findByText('CONFIG_INSTANCE_METRICS_URL')).toBeInTheDocument();
    expect(screen.getByText(/no metrics endpoint is configured/i)).toBeInTheDocument();
    expect(screen.queryByText('CROWDSEC_PROMETHEUS_URL')).not.toBeInTheDocument();
    expect(fetchCrowdsecMetricsMock).not.toHaveBeenCalled();
  });

  test('hides selectors when only one instance and one endpoint are configured', async () => {
    fetchConfigMock.mockResolvedValue({
      metrics_enabled: true,
      instances: [{ id: 'primary', name: 'Primary', prometheus: [{ id: 'lapi', name: 'LAPI' }] }],
    });
    fetchCrowdsecMetricsMock.mockResolvedValue(buildMetricsResponse());

    render(<Metrics />);

    await waitFor(() => expect(fetchCrowdsecMetricsMock).toHaveBeenCalledWith('primary', 'lapi'));
    expect(screen.queryByLabelText('Instance')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Metrics endpoint')).not.toBeInTheDocument();
  });

  test('shows only selectors that have multiple choices', async () => {
    fetchConfigMock.mockResolvedValue({
      metrics_enabled: true,
      instances: [{
        id: 'primary',
        name: 'Primary',
        prometheus: [{ id: 'lapi', name: 'LAPI' }, { id: 'engine', name: 'Engine' }],
      }],
    });
    fetchCrowdsecMetricsMock.mockResolvedValue(buildMetricsResponse());

    const { unmount } = render(<Metrics />);
    await waitFor(() => expect(screen.getByLabelText('Metrics endpoint')).toBeInTheDocument());
    expect(screen.queryByLabelText('Instance')).not.toBeInTheDocument();
    unmount();

    fetchConfigMock.mockResolvedValue({
      metrics_enabled: true,
      instances: [
        { id: 'primary', name: 'Primary', prometheus: [{ id: 'lapi', name: 'LAPI' }] },
        { id: 'secondary', name: 'Secondary', prometheus: [{ id: 'lapi', name: 'LAPI' }] },
      ],
    });
    render(<Metrics />);
    await waitFor(() => expect(screen.getByLabelText('Instance')).toBeInTheDocument());
    expect(screen.queryByLabelText('Metrics endpoint')).not.toBeInTheDocument();
  });

  test('renders Grafana-inspired runtime sections', async () => {
    fetchCrowdsecMetricsMock.mockResolvedValue(buildMetricsResponse());

    render(<Metrics />);

    await waitFor(() => expect(screen.getByText('LAPI latency')).toBeInTheDocument());
    expect(screen.getByText('LAPI latency')).toBeInTheDocument();
    expect(screen.getByText('/v1/alerts')).toBeInTheDocument();
    expect(screen.getByText('AppSec engines')).toBeInTheDocument();
    expect(screen.getByText('appsec')).toBeInTheDocument();
    expect(screen.getAllByText('100').length).toBeGreaterThan(0);
    expect(screen.getByText('requests')).toBeInTheDocument();
    expect(screen.getByText('93')).toBeInTheDocument();
    expect(screen.getByText('allowed')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('blocked')).toBeInTheDocument();
    expect(screen.getByText('10 parser events timed')).toBeInTheDocument();
    expect(screen.getByLabelText(/Parser timing color:/)).toBeInTheDocument();
    expect(screen.getByLabelText(/AppSec activity bar: green shows allowed requests/)).toBeInTheDocument();
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

  test('hides child parser nodes by default', async () => {
    const response = buildMetricsResponse();
    response.parserNodes = [
      {
        name: 'crowdsecurity/sshd-logs',
        stage: 's01-parse',
        source: '/var/log/auth.log',
        type: 'syslog',
        acquisType: 'file',
        isChild: false,
        processed: 80,
        parsedOk: 78,
        parsedKo: 2,
        successRate: 0.975,
      },
      {
        name: 'child-crowdsecurity/sshd-logs',
        stage: 's01-parse',
        source: '/var/log/auth.log',
        type: 'syslog',
        acquisType: 'file',
        isChild: true,
        processed: 20,
        parsedOk: 10,
        parsedKo: 10,
        successRate: 0.5,
      },
    ];
    fetchCrowdsecMetricsMock.mockResolvedValue(response);

    render(<Metrics />);

    await waitFor(() => expect(screen.getByText('crowdsecurity/sshd-logs')).toBeInTheDocument());
    expect(screen.queryByText('child-crowdsecurity/sshd-logs')).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Show child nodes' })).not.toBeChecked();
  });

  test('persists the child parser node toggle in localStorage', async () => {
    const response = buildMetricsResponse();
    response.parserNodes = [
      {
        name: 'child-crowdsecurity/sshd-logs',
        stage: 's01-parse',
        source: '/var/log/auth.log',
        type: 'syslog',
        acquisType: 'file',
        isChild: true,
        processed: 20,
        parsedOk: 10,
        parsedKo: 10,
        successRate: 0.5,
      },
    ];
    fetchCrowdsecMetricsMock.mockResolvedValue(response);

    render(<Metrics />);

    await waitFor(() => expect(screen.getByText('Child parser nodes are hidden. Turn on the toggle to include them.')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('switch', { name: 'Show child nodes' }));

    expect(screen.getByText('child-crowdsecurity/sshd-logs')).toBeInTheDocument();
    expect(window.localStorage.getItem('crowdsec-web-ui:metrics:show-child-parser-nodes')).toBe('true');
  });
});
