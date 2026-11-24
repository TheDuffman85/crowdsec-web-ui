import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PeriodCompareCard } from '../PeriodCompareCard';

const mocks = vi.hoisted(() => ({ fetchStatisticsRange: vi.fn() }));
vi.mock('../../lib/comparePeriods', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/comparePeriods')>()), fetchStatisticsRange: mocks.fetchStatisticsRange }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ children, data }: { children: ReactNode; data: unknown[] }) => <div data-testid="chart" data-rows={data.length}>{children}</div>,
  CartesianGrid: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null, Legend: () => null,
  Line: ({ dataKey }: { dataKey: string }) => <span data-testid={`line-${dataKey}`} />,
}));

const stats = (alerts: number, decisions: number, ips: number, days = 7) => ({
  totals: { alerts, decisions, uniqueIPs: ips },
  series: Array.from({ length: days }, (_, index) => ({ date: `2026-11-${String(index + 1).padStart(2, '0')}`, alerts: index, decisions: 1 })),
});

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-20T12:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('PeriodCompareCard', () => {
  test('shows the current period alone until comparison is switched on', async () => {
    const user = userEvent.setup();
    mocks.fetchStatisticsRange.mockImplementation(async (from: string) => (from === '2026-11-14' ? stats(120, 30, 40) : stats(80, 40, 40)));
    render(<PeriodCompareCard timeZone="UTC" />);
    expect(await screen.findByTestId('compare-alerts')).toHaveTextContent('120');
    expect(mocks.fetchStatisticsRange).toHaveBeenCalledTimes(1);
    expect(mocks.fetchStatisticsRange).toHaveBeenCalledWith('2026-11-14', '2026-11-20', expect.anything());
    expect(screen.queryByTestId('line-previousAlerts')).not.toBeInTheDocument();
    expect(screen.getByTestId('compare-alerts')).not.toHaveTextContent('vs previous');

    await user.click(screen.getByRole('checkbox', { name: 'Compare with previous period' }));
    await waitFor(() => expect(screen.getByTestId('compare-alerts')).toHaveTextContent('+50% vs previous'));
    expect(mocks.fetchStatisticsRange).toHaveBeenCalledWith('2026-11-07', '2026-11-13', expect.anything());
    expect(within(screen.getByTestId('compare-decisions')).getByText(/-25% vs previous/)).toBeInTheDocument();
    expect(screen.getByTestId('compare-ips')).toHaveTextContent('0% vs previous');
    expect(screen.getByTestId('line-previousAlerts')).toBeInTheDocument();
    expect(screen.getByTestId('line-previousDecisions')).toBeInTheDocument();
  });

  test('changes the range and says when there is nothing earlier to compare with', async () => {
    const user = userEvent.setup();
    mocks.fetchStatisticsRange.mockImplementation(async (from: string) => (from === '2026-10-22' ? stats(10, 1, 3, 30) : stats(0, 0, 0, 30)));
    render(<PeriodCompareCard timeZone="UTC" />);
    await screen.findByTestId('compare-alerts');
    await user.selectOptions(screen.getByLabelText('Range'), '30');
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveAttribute('data-rows', '30'));
    await user.click(screen.getByRole('checkbox', { name: 'Compare with previous period' }));
    await waitFor(() => expect(screen.getByTestId('compare-alerts')).toHaveTextContent('no earlier data'));
  });

  test('reports a failed load and a failed baseline', async () => {
    const user = userEvent.setup();
    mocks.fetchStatisticsRange.mockRejectedValueOnce(new Error('boom'));
    render(<PeriodCompareCard timeZone="UTC" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    mocks.fetchStatisticsRange.mockImplementation(async (from: string) => { if (from === '2026-11-07') throw new Error('x'); return stats(5, 1, 2); });
    await user.selectOptions(screen.getByLabelText('Range'), '7');
    await user.click(screen.getByRole('checkbox', { name: 'Compare with previous period' }));
    expect(await screen.findByRole('status')).toHaveTextContent('The previous period could not be loaded.');
  });
});
