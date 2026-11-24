import { render as baseRender, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ProtectionCoverageCard } from '../ProtectionCoverageCard';

const { fetchConfigMock, fetchMetricsMock, fetchCombinedMock, fetchHubServersMock } = vi.hoisted(() => ({
  fetchHubServersMock: vi.fn(),
  fetchConfigMock: vi.fn(),
  fetchMetricsMock: vi.fn(),
  fetchCombinedMock: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  fetchConfig: fetchConfigMock,
  fetchCrowdsecMetrics: fetchMetricsMock,
  fetchCombinedCrowdsecMetrics: fetchCombinedMock,
}));

vi.mock('../../lib/insightsApi', () => ({ fetchHubServers: fetchHubServersMock }));

const render = (ui: ReactElement) => {
  const result = baseRender(<MemoryRouter>{ui}</MemoryRouter>);
  return { ...result, rerender: (next: ReactElement) => result.rerender(<MemoryRouter>{next}</MemoryRouter>) };
};

const hubServer = (name: string, status: string) => ({ id: status === 'detected' ? null : `m-${name}`, name, machine: name, status });

const emptyTotals = {
  bouncerRequests: 0, machineRequests: 0, appsecRequests: 0, appsecBlocked: 0,
  parserProcessed: 0, parserOk: 0, parserKo: 0, parserSuccessRate: null, parserAverageSeconds: null,
  whitelistHits: 0, whitelisted: 0, activeDecisions: 7,
};

function metrics(bouncers: Array<{ name: string }>, machines: Array<{ name: string; lastHeartbeatAt: string }>) {
  return {
    fetched_at: new Date().toISOString(),
    totals: emptyTotals,
    bouncers: bouncers.map((bouncer) => ({ ...bouncer, requests: 1, topRoute: null, topMethod: null })),
    machines: machines.map((machine) => ({ ...machine, requests: 1, topRoute: null, topMethod: null })),
    parserSources: [], parserNodes: [], whitelists: [], parserTimings: [],
  };
}

describe('ProtectionCoverageCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchHubServersMock.mockResolvedValue({ servers: [] });
  });

  test('warns when no bouncer enforces the active decisions', async () => {
    fetchConfigMock.mockResolvedValue({ instances: [] });
    fetchMetricsMock.mockResolvedValue(metrics([], [{ name: 'odin', lastHeartbeatAt: new Date().toISOString() }]));
    render(<ProtectionCoverageCard />);

    await waitFor(() => expect(screen.getByTestId('protection-coverage')).toHaveAttribute('data-level', 'critical'));
    expect(screen.getByText('No bouncer is enforcing your decisions.')).toBeInTheDocument();
    expect(screen.getByText(/has 7 active decisions/)).toBeInTheDocument();
  });

  test('names machines that stopped reporting', async () => {
    fetchConfigMock.mockResolvedValue({ instances: [] });
    fetchMetricsMock.mockResolvedValue(metrics([{ name: 'firewall' }], [{ name: 'thor', lastHeartbeatAt: '2020-01-01T00:00:00.000Z' }]));
    render(<ProtectionCoverageCard />);

    await waitFor(() => expect(screen.getByTestId('protection-coverage')).toHaveAttribute('data-level', 'warning'));
    expect(screen.getByText('1 machine(s) stopped reporting.')).toBeInTheDocument();
    expect(screen.getByText(/No heartbeat for over 10 minutes: thor/)).toBeInTheDocument();
  });

  test('uses the combined endpoint for several instances', async () => {
    fetchConfigMock.mockResolvedValue({
      instances: [
        { id: 'a', prometheus: [{ id: 'p1' }] },
        { id: 'b', prometheus: [{ id: 'p2' }] },
      ],
    });
    fetchCombinedMock.mockResolvedValue(metrics([{ name: 'firewall' }], [{ name: 'odin', lastHeartbeatAt: new Date().toISOString() }]));
    render(<ProtectionCoverageCard />);

    await waitFor(() => expect(screen.getByTestId('protection-coverage')).toHaveAttribute('data-level', 'ok'));
    expect(fetchCombinedMock).toHaveBeenCalledWith('all');
  });

  test('stays hidden when metrics are not configured or fail', async () => {
    fetchConfigMock.mockResolvedValue({ instances: [], metrics_enabled: false });
    const { container, rerender } = render(<ProtectionCoverageCard />);
    await waitFor(() => expect(fetchConfigMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();

    fetchConfigMock.mockResolvedValue({ instances: [] });
    fetchMetricsMock.mockRejectedValue(new Error('down'));
    rerender(<ProtectionCoverageCard key="again" />);
    await waitFor(() => expect(fetchMetricsMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  test('lists which machines have a hub installer, detected ones included', async () => {
    fetchConfigMock.mockResolvedValue({ instances: [] });
    fetchMetricsMock.mockResolvedValue(metrics([{ name: 'firewall' }], [
      { name: 'odin', lastHeartbeatAt: new Date().toISOString() }, { name: 'thor', lastHeartbeatAt: new Date().toISOString() },
    ]));
    fetchHubServersMock.mockResolvedValue({ servers: [hubServer('odin', 'paired'), hubServer('RMM', 'detected')] });
    render(<ProtectionCoverageCard />);

    const rows = await screen.findAllByTestId('installer-machine');
    expect(rows.map((row) => [row.textContent, row.getAttribute('data-status')])).toEqual([
      ['odinInstaller set up', 'paired'], ['RMMDetected, installer not set up', 'detected'], ['thorDetected, installer not set up', 'detected'],
    ]);
    expect(screen.getByText('1 of 3 machines have an installer set up.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage on the hub page' })).toHaveAttribute('href', '/tools/hub');
  });

  test('still shows the installers when metrics are not available', async () => {
    fetchConfigMock.mockResolvedValue({ instances: [], metrics_enabled: false });
    fetchHubServersMock.mockResolvedValue({ servers: [hubServer('RMM', 'detected'), hubServer('NT-APP01', 'pending'), hubServer('WP01', 'error')] });
    render(<ProtectionCoverageCard />);

    await screen.findByTestId('installer-coverage');
    expect(screen.getByText('Protection coverage')).toBeInTheDocument();
    expect(screen.getAllByTestId('installer-machine').map((row) => row.getAttribute('data-status'))).toEqual(['detected', 'pending', 'error']);
    expect(screen.getByText('Waiting for pairing')).toBeInTheDocument();
    expect(screen.getByText('Installer connection error')).toBeInTheDocument();
  });

  test('keeps working when the hub servers cannot be read', async () => {
    fetchConfigMock.mockResolvedValue({ instances: [] });
    fetchMetricsMock.mockResolvedValue(metrics([{ name: 'firewall' }], [{ name: 'odin', lastHeartbeatAt: new Date().toISOString() }]));
    fetchHubServersMock.mockRejectedValue(new Error('down'));
    render(<ProtectionCoverageCard />);

    await waitFor(() => expect(screen.getByTestId('protection-coverage')).toHaveAttribute('data-level', 'ok'));
    await waitFor(() => expect(screen.getByTestId('installer-machine')).toBeInTheDocument());
  });
});
