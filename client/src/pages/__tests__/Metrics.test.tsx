import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { BrowserRouter, useNavigate } from 'react-router-dom';
import { Metrics } from '../Metrics';
import type { CrowdsecMetricsResponse } from '../../types';
import { I18nContext } from '../../lib/i18n';

const {
  fetchConfigMock,
  fetchCombinedCrowdsecMetricsMock,
  fetchCrowdsecMetricsMock,
  setLastUpdatedMock,
} = vi.hoisted(() => ({
  fetchConfigMock: vi.fn(),
  fetchCombinedCrowdsecMetricsMock: vi.fn(),
  fetchCrowdsecMetricsMock: vi.fn(),
  setLastUpdatedMock: vi.fn(),
}));

vi.mock('../../contexts/useRefresh', () => ({
  useRefresh: () => ({
    refreshSignal: 0,
    setLastUpdated: setLastUpdatedMock,
  }),
}));

vi.mock('../../lib/api', () => ({
  fetchConfig: fetchConfigMock,
  fetchCombinedCrowdsecMetrics: fetchCombinedCrowdsecMetricsMock,
  fetchCrowdsecMetrics: fetchCrowdsecMetricsMock,
}));

function buildMetricsResponse(): CrowdsecMetricsResponse {
  return {
    fetched_at: '2026-06-30T10:00:00.000Z',
    crowdsecStartedAt: '2026-06-30T09:00:00.000Z',
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

function renderMetrics(content = <Metrics />) {
  return render(<BrowserRouter>{content}</BrowserRouter>);
}

function InstanceSwitcher() {
  const navigate = useNavigate();

  return (
    <button type="button" onClick={() => void navigate('/metrics?instance=secondary')}>
      Select secondary
    </button>
  );
}

beforeEach(() => {
  fetchConfigMock.mockReset();
  fetchCombinedCrowdsecMetricsMock.mockReset();
  fetchCrowdsecMetricsMock.mockReset();
  setLastUpdatedMock.mockReset();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/metrics');
  fetchConfigMock.mockResolvedValue({ metrics_enabled: true });
  fetchCombinedCrowdsecMetricsMock.mockResolvedValue(buildMetricsResponse());
});

describe('Metrics page', () => {
  test('shows the current per-instance metrics configuration when no endpoint is configured', async () => {
    fetchConfigMock.mockResolvedValue({
      metrics_enabled: false,
      instances: [{ id: 'primary', name: 'Primary', prometheus: [] }],
    });

    renderMetrics();

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

    renderMetrics();

    await waitFor(() => expect(fetchCrowdsecMetricsMock).toHaveBeenCalledWith('primary', 'lapi'));
    expect(screen.queryByLabelText('Instance')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Metrics endpoint')).not.toBeInTheDocument();
  });

  test('shows an endpoint selector when the selected instance has multiple endpoints', async () => {
    fetchConfigMock.mockResolvedValue({
      metrics_enabled: true,
      instances: [{
        id: 'primary',
        name: 'Primary',
        prometheus: [{ id: 'lapi', name: 'LAPI', icon: '🧠' }, { id: 'engine', name: 'Engine', icon: '🛡️' }],
      }],
    });
    fetchCrowdsecMetricsMock.mockResolvedValue(buildMetricsResponse());

    const { unmount } = renderMetrics();
    const selector = await screen.findByLabelText('Metrics endpoint');
    await waitFor(() => expect(fetchCombinedCrowdsecMetricsMock).toHaveBeenCalledWith('primary'));
    expect(new URLSearchParams(window.location.search).get('endpoint')).toBe('_combined');
    expect(selector.querySelector('.lucide-blend')).toBeInTheDocument();
    await userEvent.click(selector);
    expect(screen.getByRole('option', { name: 'Combined' }).querySelector('.lucide-blend')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'LAPI' })).toHaveTextContent('🧠');
    expect(screen.getByRole('option', { name: 'Engine' })).toHaveTextContent('🛡️');
    expect(screen.queryByLabelText('Instance')).not.toBeInTheDocument();
    unmount();
  });

  test('uses the sidebar instance scope and lists endpoints from every instance for all instances', async () => {
    fetchConfigMock.mockResolvedValue({
      metrics_enabled: true,
      instances: [
        { id: 'primary', name: 'Primary', icon: '🟦', prometheus: [{ id: 'lapi', name: 'Primary LAPI', icon: '🧠' }] },
        { id: 'secondary', name: 'Secondary', icon: '🟩', prometheus: [{ id: 'lapi', name: 'Secondary LAPI', icon: '🛰️' }] },
      ],
    });
    fetchCrowdsecMetricsMock.mockResolvedValue(buildMetricsResponse());
    window.history.replaceState({}, '', '/metrics?instance=all');

    renderMetrics();

    const endpointSelector = await screen.findByLabelText('Metrics endpoint');
    await waitFor(() => expect(fetchCombinedCrowdsecMetricsMock).toHaveBeenCalledWith('all'));
    expect(screen.queryByLabelText('Instance')).not.toBeInTheDocument();
    await userEvent.click(endpointSelector);
    expect(screen.getByRole('option', { name: 'Combined' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Primary — Primary LAPI' })).toBeInTheDocument();
    const secondaryOption = screen.getByRole('option', { name: 'Secondary — Secondary LAPI' });
    expect(screen.getByRole('option', { name: 'Primary — Primary LAPI' })).toHaveTextContent('🧠');
    expect(secondaryOption).toHaveTextContent('🛰️');
    expect(secondaryOption).not.toHaveTextContent('🟩');

    await userEvent.click(secondaryOption);
    await waitFor(() => expect(fetchCrowdsecMetricsMock).toHaveBeenLastCalledWith('secondary', 'lapi'));
    expect(new URLSearchParams(window.location.search).get('instance')).toBe('all');
  });

  test('shows source-qualified rows and a warning for partial combined data', async () => {
    fetchConfigMock.mockResolvedValue({
      metrics_enabled: true,
      instances: [
        { id: 'primary', name: 'Primary', prometheus: [{ id: 'lapi', name: 'LAPI' }] },
        { id: 'secondary', name: 'Secondary', prometheus: [{ id: 'agent', name: 'Agent' }] },
      ],
    });
    const response = buildMetricsResponse();
    response.machines = [{
      source_id: 'primary:lapi',
      name: 'node-1',
      requests: 3,
      topRoute: '/v1/alerts',
      topMethod: 'POST',
      alertRequests: 3,
      heartbeatRequests: 0,
    }];
    response.aggregation = {
      partial: true,
      sources: [
        {
          id: 'primary:lapi',
          instance_id: 'primary',
          instance_name: 'Primary',
          endpoint_id: 'lapi',
          endpoint_name: 'LAPI',
          endpoint_icon: '🧠',
          status: 'available',
          fetched_at: '2026-06-30T10:00:00.000Z',
          crowdsecVersion: 'v1.7.8',
        },
        {
          id: 'secondary:agent',
          instance_id: 'secondary',
          instance_name: 'Secondary',
          endpoint_id: 'agent',
          endpoint_name: 'Agent',
          status: 'unavailable',
          error: 'Prometheus endpoint returned HTTP 503',
        },
      ],
    };
    fetchCombinedCrowdsecMetricsMock.mockResolvedValue(response);
    window.history.replaceState({}, '', '/metrics?instance=all');

    renderMetrics();

    expect(await screen.findByText(/Some metrics sources are unavailable: Secondary — Agent/)).toBeInTheDocument();
    expect(screen.getAllByText('Primary — LAPI').length).toBeGreaterThan(1);
    expect(screen.getAllByText('🧠').length).toBeGreaterThan(0);
    expect(screen.getByText('Prometheus endpoint returned HTTP 503')).toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
  });

  test('shows the retry state when a combined request fails completely', async () => {
    fetchConfigMock.mockResolvedValue({
      metrics_enabled: true,
      instances: [{
        id: 'primary',
        name: 'Primary',
        prometheus: [{ id: 'lapi', name: 'LAPI' }, { id: 'agent', name: 'Agent' }],
      }],
    });
    fetchCombinedCrowdsecMetricsMock.mockRejectedValue(new Error('Failed to fetch combined CrowdSec metrics'));

    renderMetrics();

    expect(await screen.findByText('Metrics unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  test('shows the setup hint when the sidebar-selected instance has no metrics', async () => {
    fetchConfigMock.mockResolvedValue({
      metrics_enabled: true,
      instances: [
        { id: 'primary', name: 'Primary', prometheus: [{ id: 'lapi', name: 'LAPI' }] },
        { id: 'secondary', name: 'Secondary', prometheus: [] },
      ],
    });
    window.history.replaceState({}, '', '/metrics?instance=secondary');

    renderMetrics();

    expect(await screen.findByText('CONFIG_INSTANCE_METRICS_URL')).toBeInTheDocument();
    expect(fetchCrowdsecMetricsMock).not.toHaveBeenCalled();
    expect(new URLSearchParams(window.location.search).get('instance')).toBe('secondary');
  });

  test('reloads metrics when the sidebar changes the instance scope', async () => {
    fetchConfigMock.mockResolvedValue({
      metrics_enabled: true,
      instances: [
        { id: 'primary', name: 'Primary', prometheus: [{ id: 'lapi', name: 'LAPI' }] },
        { id: 'secondary', name: 'Secondary', prometheus: [{ id: 'engine', name: 'Engine' }] },
      ],
    });
    fetchCrowdsecMetricsMock.mockResolvedValue(buildMetricsResponse());
    window.history.replaceState({}, '', '/metrics?instance=primary');

    renderMetrics(
      <>
        <InstanceSwitcher />
        <Metrics />
      </>,
    );

    await waitFor(() => expect(fetchCrowdsecMetricsMock).toHaveBeenCalledWith('primary', 'lapi'));
    await userEvent.click(screen.getByRole('button', { name: 'Select secondary' }));

    await waitFor(() => expect(fetchCrowdsecMetricsMock).toHaveBeenLastCalledWith('secondary', 'engine'));
  });

  test('translates the endpoint selector label', async () => {
    fetchConfigMock.mockResolvedValue({
      metrics_enabled: true,
      instances: [
        {
          id: 'primary',
          name: 'Primary',
          prometheus: [{ id: 'lapi', name: 'LAPI' }, { id: 'engine', name: 'Engine' }],
        },
        {
          id: 'secondary',
          name: 'Secondary',
          prometheus: [{ id: 'lapi', name: 'LAPI' }],
        },
      ],
    });
    fetchCrowdsecMetricsMock.mockResolvedValue(buildMetricsResponse());

    renderMetrics(
      <I18nContext.Provider value={{
        language: 'de',
        preference: 'de',
        browserLanguage: 'en',
        setLanguagePreference: vi.fn(),
        t: (key) => ({
          'pages.metrics.instance': 'Instanz',
          'pages.metrics.metricsEndpoint': 'Metrik-Endpunkt',
        })[key] ?? key,
      }}>
        <Metrics />
      </I18nContext.Provider>,
    );

    expect(await screen.findByLabelText('Metrik-Endpunkt')).toBeInTheDocument();
    expect(screen.queryByLabelText('Instanz')).not.toBeInTheDocument();
  });

  test('renders Grafana-inspired runtime sections', async () => {
    fetchCrowdsecMetricsMock.mockResolvedValue(buildMetricsResponse());

    renderMetrics();

    await waitFor(() => expect(screen.getByText('LAPI latency')).toBeInTheDocument());
    expect(screen.getByText('LAPI latency')).toBeInTheDocument();
    expect(document.querySelector('time[datetime="2026-06-30T09:00:00.000Z"]')).toBeInTheDocument();
    expect(screen.getByText('Started')).toBeInTheDocument();
    expect(screen.queryByText(/CrowdSec started:/)).not.toBeInTheDocument();
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

  test('presents log processors and stream bouncers without implying live-mode health', async () => {
    const response = buildMetricsResponse();
    response.totals.machineRequests = 13;
    response.totals.machineAlertRequests = 7;
    response.totals.machineHeartbeatRequests = 5;
    response.totals.activeDecisions = 4;
    response.totals.alerts = 3;
    response.crowdsecVersion = 'v1.7.8';
    response.bouncers = [{
      name: 'stream-firewall',
      requests: 20,
      topRoute: '/v1/decisions/stream',
      topMethod: 'GET',
      mode: 'stream',
      routes: [{ method: 'GET', route: '/v1/decisions/stream', requests: 20 }],
    }];
    response.machines = [{
      name: 'processor-1',
      requests: 13,
      topRoute: '/v1/alerts',
      topMethod: 'POST',
      alertRequests: 7,
      heartbeatRequests: 5,
      lastHeartbeatAt: '2026-06-30T09:59:30.000Z',
      otherRequests: 1,
      routes: [
        { method: 'POST', route: '/v1/alerts', requests: 7 },
        { method: 'GET', route: '/v1/heartbeat', requests: 5 },
      ],
    }, {
      name: 'processor-stale',
      requests: 6,
      topRoute: '/v1/alerts',
      topMethod: 'POST',
      alertRequests: 1,
      heartbeatRequests: 5,
      lastHeartbeatAt: '2026-06-30T09:50:00.000Z',
      otherRequests: 0,
      routes: [{ method: 'GET', route: '/v1/heartbeat', requests: 5 }],
    }, {
      name: 'processor-legacy',
      requests: 2,
      topRoute: '/v1/heartbeat',
      topMethod: 'GET',
      alertRequests: 1,
      heartbeatRequests: 1,
      otherRequests: 0,
      routes: [{ method: 'GET', route: '/v1/heartbeat', requests: 1 }],
    }, {
      name: 'processor-without-heartbeat',
      requests: 1,
      topRoute: '/v1/alerts',
      topMethod: 'POST',
      alertRequests: 1,
      heartbeatRequests: 0,
      otherRequests: 0,
      routes: [{ method: 'POST', route: '/v1/alerts', requests: 1 }],
    }];
    response.scenarios = [{
      name: 'crowdsecurity/ssh-bf',
      current: 2,
      instantiations: 8,
      overflows: 3,
      underflows: 1,
      canceled: 1,
      poured: 12,
    }];
    fetchCrowdsecMetricsMock.mockResolvedValue(response);

    renderMetrics();

    await waitFor(() => expect(screen.getByText('stream-firewall')).toBeInTheDocument());
    expect(screen.getByText('Stream mode')).toBeInTheDocument();
    expect(screen.getByText('Log processor alert posts')).toBeInTheDocument();
    expect(screen.getByText('Online')).toBeInTheDocument();
    expect(screen.getByText('Stale heartbeat')).toBeInTheDocument();
    expect(screen.getByText('Heartbeat observed')).toBeInTheDocument();
    expect(screen.getByText('No heartbeat observed')).not.toHaveAttribute('title');
    expect(screen.getByText('Version')).toBeInTheDocument();
    expect(screen.getByText('Started')).toBeInTheDocument();
    expect(screen.getByText('v1.7.8')).toBeInTheDocument();
    expect(screen.getByText('Active decisions')).toBeInTheDocument();
    expect(screen.getByText('Alerts')).toBeInTheDocument();
    expect(screen.getByText('Scenarios')).toBeInTheDocument();
    expect(screen.getByText('crowdsecurity/ssh-bf')).toBeInTheDocument();
    expect(screen.getByText(/Stream mode uses \/v1\/decisions\/stream/)).toBeInTheDocument();
    const remediationNote = screen.getByText(/These are LAPI API counters/);
    expect(remediationNote).toHaveClass('bg-blue-50', 'mt-3');
    expect(remediationNote.compareDocumentPosition(screen.getByText('stream-firewall')) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  test('handles missing optional runtime sections', async () => {
    const response = buildMetricsResponse();
    delete response.lapiRoutes;
    delete response.appsecEngines;
    fetchCrowdsecMetricsMock.mockResolvedValue(response);

    renderMetrics();

    await waitFor(() => expect(screen.getByText('No LAPI route or duration metrics were exposed by CrowdSec.')).toBeInTheDocument());
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

    renderMetrics();

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

    renderMetrics();

    await waitFor(() => expect(screen.getByText('Child parser nodes are hidden. Turn on the toggle to include them.')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('switch', { name: 'Show child nodes' }));

    expect(screen.getByText('child-crowdsecurity/sshd-logs')).toBeInTheDocument();
    expect(window.localStorage.getItem('crowdsec-web-ui:metrics:show-child-parser-nodes')).toBe('true');
  });
});
