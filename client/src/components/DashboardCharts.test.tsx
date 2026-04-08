import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { ActivityBarChart } from './DashboardCharts';
import { getBrushSelectionPayload, getDraggedBrushWindow } from './DashboardCharts.helpers';

vi.mock('recharts', () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const YAxis = ({
    scale,
    domain,
    ticks,
  }: {
    scale?: string;
    domain?: Array<number | string>;
    ticks?: number[];
  }) => (
    <div
      data-testid="mock-y-axis"
      data-scale={scale}
      data-domain={domain?.join(',')}
      data-ticks={ticks?.join(',')}
    />
  );
  const Bar = ({
    dataKey,
    minPointSize,
  }: {
    dataKey?: string;
    minPointSize?: number | ((value: unknown, index: number) => number);
  }) => (
    <div
      data-testid={`mock-bar-${dataKey ?? 'unknown'}`}
      data-min-point-size-zero={typeof minPointSize === 'function' ? minPointSize(0, 0) : minPointSize}
      data-min-point-size-positive={typeof minPointSize === 'function' ? minPointSize(3, 0) : minPointSize}
    />
  );

  return {
    BarChart: Container,
    Bar,
    XAxis: () => null,
    YAxis,
    CartesianGrid: () => null,
    Tooltip: () => null,
    Legend: () => null,
    ResponsiveContainer: Container,
  };
});

const series = [
  { date: '2025-01-01', label: 'Jan 1', count: 1, fullDate: '2025-01-01' },
  { date: '2025-01-02', label: 'Jan 2', count: 2, fullDate: '2025-01-02' },
  { date: '2025-01-03', label: 'Jan 3', count: 3, fullDate: '2025-01-03' },
];

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock);

const createDomRect = (width: number, height = 20): DOMRect => ({
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: width,
  bottom: height,
  width,
  height,
  toJSON: () => ({}),
} as DOMRect);

describe('ActivityBarChart', () => {
  test('builds the selected brush payload from slider buckets', () => {
    expect(
      getBrushSelectionPayload(
        series.map(({ date }) => ({ bucketKey: date })),
        { startIndex: 1, endIndex: 2 },
      ),
    ).toEqual({
      dateRange: { start: '2025-01-02', end: '2025-01-03' },
      isAtEnd: true,
    });
  });

  test('switches granularity from the header controls', async () => {
    const setGranularity = vi.fn();

    render(
      <ActivityBarChart
        alertsData={series}
        decisionsData={series}
        unfilteredAlertsData={series}
        unfilteredDecisionsData={series}
        granularity="day"
        setGranularity={setGranularity}
        onDateRangeSelect={vi.fn()}
        selectedDateRange={null}
        isSticky={false}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Hour' }));
    expect(setGranularity).toHaveBeenCalledWith('hour');
  });

  test('keeps the chart controls on a single row on mobile-sized layouts', () => {
    render(
      <ActivityBarChart
        alertsData={series}
        decisionsData={series}
        unfilteredAlertsData={series}
        unfilteredDecisionsData={series}
        granularity="day"
        setGranularity={vi.fn()}
        onDateRangeSelect={vi.fn()}
        selectedDateRange={null}
        isSticky={false}
      />,
    );

    const scaleGroup = screen.getByRole('group', { name: 'Activity chart scale' });
    const granularityGroup = screen.getByRole('group', { name: 'Activity chart granularity' });
    const controlsWrapper = scaleGroup.parentElement;

    expect(controlsWrapper).toHaveClass('justify-between');
    expect(controlsWrapper).not.toHaveClass('flex-col');
    expect(granularityGroup).not.toHaveClass('self-start');
  });

  test('renders the activity chart with linear scaling by default', () => {
    const mixedSeries = [
      { date: '2025-01-01', label: 'Jan 1', count: 5, fullDate: '2025-01-01' },
      { date: '2025-01-02', label: 'Jan 2', count: 50, fullDate: '2025-01-02' },
      { date: '2025-01-03', label: 'Jan 3', count: 15000, fullDate: '2025-01-03' },
    ];

    render(
      <ActivityBarChart
        alertsData={mixedSeries}
        decisionsData={mixedSeries}
        unfilteredAlertsData={mixedSeries}
        unfilteredDecisionsData={mixedSeries}
        granularity="day"
        setGranularity={vi.fn()}
        onDateRangeSelect={vi.fn()}
        selectedDateRange={null}
        isSticky={false}
      />,
    );

    expect(screen.getByRole('button', { name: 'Symlog' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Linear' })).toBeInTheDocument();
    expect(screen.getByTestId('mock-y-axis')).toHaveAttribute('data-scale', 'linear');
    expect(screen.getByTestId('mock-y-axis')).toHaveAttribute('data-domain', '0,15000');
    expect(screen.getByTestId('mock-y-axis')).not.toHaveAttribute('data-ticks');
    expect(screen.getByTestId('mock-bar-alerts')).toHaveAttribute('data-min-point-size-zero', '0');
    expect(screen.getByTestId('mock-bar-alerts')).toHaveAttribute('data-min-point-size-positive', '2');
    expect(screen.getByTestId('mock-bar-decisions')).toHaveAttribute('data-min-point-size-zero', '0');
    expect(screen.getByTestId('mock-bar-decisions')).toHaveAttribute('data-min-point-size-positive', '2');
  });

  test('switches the activity chart axis between symlog and linear scale', async () => {
    const mixedSeries = [
      { date: '2025-01-01', label: 'Jan 1', count: 5, fullDate: '2025-01-01' },
      { date: '2025-01-02', label: 'Jan 2', count: 50, fullDate: '2025-01-02' },
      { date: '2025-01-03', label: 'Jan 3', count: 15000, fullDate: '2025-01-03' },
    ];

    render(
      <ActivityBarChart
        alertsData={mixedSeries}
        decisionsData={mixedSeries}
        unfilteredAlertsData={mixedSeries}
        unfilteredDecisionsData={mixedSeries}
        granularity="day"
        setGranularity={vi.fn()}
        onDateRangeSelect={vi.fn()}
        selectedDateRange={null}
        isSticky={false}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Symlog' }));

    expect(screen.getByTestId('mock-y-axis')).toHaveAttribute('data-scale', 'symlog');
    expect(screen.getByTestId('mock-y-axis')).toHaveAttribute('data-ticks', '0,5,50,500,2000,15000');

    await userEvent.click(screen.getByRole('button', { name: 'Linear' }));

    expect(screen.getByTestId('mock-y-axis')).toHaveAttribute('data-scale', 'linear');
    expect(screen.getByTestId('mock-y-axis')).toHaveAttribute('data-domain', '0,15000');
    expect(screen.getByTestId('mock-y-axis')).not.toHaveAttribute('data-ticks');
  });

  test('reinitializes the brush window when the selected range changes', () => {
    const { rerender } = render(
      <ActivityBarChart
        alertsData={series}
        decisionsData={series}
        unfilteredAlertsData={series}
        unfilteredDecisionsData={series}
        granularity="day"
        setGranularity={vi.fn()}
        onDateRangeSelect={vi.fn()}
        selectedDateRange={null}
        isSticky={false}
      />,
    );

    expect(screen.getByTestId('activity-range-selection')).toHaveAttribute('data-start-index', '0');
    expect(screen.getByTestId('activity-range-selection')).toHaveAttribute('data-end-index', '2');

    rerender(
      <ActivityBarChart
        alertsData={series.slice(1)}
        decisionsData={series.slice(1)}
        unfilteredAlertsData={series}
        unfilteredDecisionsData={series}
        granularity="day"
        setGranularity={vi.fn()}
        onDateRangeSelect={vi.fn()}
        selectedDateRange={{ start: '2025-01-02', end: '2025-01-03' }}
        isSticky={true}
      />,
    );

    expect(screen.getByTestId('activity-range-selection')).toHaveAttribute('data-start-index', '1');
    expect(screen.getByTestId('activity-range-selection')).toHaveAttribute('data-end-index', '2');
  });

  test('derives dragged brush windows for handle and slide interactions', () => {
    expect(
      getDraggedBrushWindow(
        {
          mode: 'start',
          pointerStartX: 0,
          initialStartIndex: 0,
          initialEndIndex: 2,
          bucketWidth: 100,
          bucketCount: 3,
        },
        100,
        { startIndex: 0, endIndex: 2 },
      ),
    ).toEqual({ startIndex: 1, endIndex: 2 });

    expect(
      getDraggedBrushWindow(
        {
          mode: 'move',
          pointerStartX: 200,
          initialStartIndex: 1,
          initialEndIndex: 2,
          bucketWidth: 100,
          bucketCount: 3,
        },
        100,
        { startIndex: 1, endIndex: 2 },
      ),
    ).toEqual({ startIndex: 0, endIndex: 1 });
  });

  test('keeps the brush synced across consecutive parent range updates', () => {
    const { rerender } = render(
      <ActivityBarChart
        alertsData={series}
        decisionsData={series}
        unfilteredAlertsData={series}
        unfilteredDecisionsData={series}
        granularity="day"
        setGranularity={vi.fn()}
        onDateRangeSelect={vi.fn()}
        selectedDateRange={null}
        isSticky={false}
      />,
    );

    expect(screen.getByTestId('activity-range-selection')).toHaveAttribute('data-start-index', '0');
    expect(screen.getByTestId('activity-range-selection')).toHaveAttribute('data-end-index', '2');

    rerender(
      <ActivityBarChart
        alertsData={series.slice(1)}
        decisionsData={series.slice(1)}
        unfilteredAlertsData={series}
        unfilteredDecisionsData={series}
        granularity="day"
        setGranularity={vi.fn()}
        onDateRangeSelect={vi.fn()}
        selectedDateRange={{ start: '2025-01-02', end: '2025-01-03' }}
        isSticky={false}
      />,
    );

    expect(screen.getByTestId('activity-range-selection')).toHaveAttribute('data-start-index', '1');
    expect(screen.getByTestId('activity-range-selection')).toHaveAttribute('data-end-index', '2');

    rerender(
      <ActivityBarChart
        alertsData={series.slice(0, 2)}
        decisionsData={series.slice(0, 2)}
        unfilteredAlertsData={series}
        unfilteredDecisionsData={series}
        granularity="day"
        setGranularity={vi.fn()}
        onDateRangeSelect={vi.fn()}
        selectedDateRange={{ start: '2025-01-01', end: '2025-01-02' }}
        isSticky={false}
      />,
    );

    expect(screen.getByTestId('activity-range-selection')).toHaveAttribute('data-start-index', '0');
    expect(screen.getByTestId('activity-range-selection')).toHaveAttribute('data-end-index', '1');
  });

  test('keeps the selected range stable across data refreshes', () => {
    const refreshedSeries = [
      { date: '2025-01-01', label: 'Jan 1', count: 4, fullDate: '2025-01-01' },
      { date: '2025-01-02', label: 'Jan 2', count: 5, fullDate: '2025-01-02' },
      { date: '2025-01-03', label: 'Jan 3', count: 6, fullDate: '2025-01-03' },
    ];

    const { rerender } = render(
      <ActivityBarChart
        alertsData={series.slice(1)}
        decisionsData={series.slice(1)}
        unfilteredAlertsData={series}
        unfilteredDecisionsData={series}
        granularity="day"
        setGranularity={vi.fn()}
        onDateRangeSelect={vi.fn()}
        selectedDateRange={{ start: '2025-01-02', end: '2025-01-03' }}
        isSticky={false}
      />,
    );

    expect(screen.getByTestId('activity-range-selection')).toHaveAttribute('data-start-index', '1');
    expect(screen.getByTestId('activity-range-selection')).toHaveAttribute('data-end-index', '2');

    rerender(
      <ActivityBarChart
        alertsData={refreshedSeries.slice(1)}
        decisionsData={refreshedSeries.slice(1)}
        unfilteredAlertsData={refreshedSeries}
        unfilteredDecisionsData={refreshedSeries}
        granularity="day"
        setGranularity={vi.fn()}
        onDateRangeSelect={vi.fn()}
        selectedDateRange={{ start: '2025-01-02', end: '2025-01-03' }}
        isSticky={false}
      />,
    );

    expect(screen.getByTestId('activity-range-selection')).toHaveAttribute('data-start-index', '1');
    expect(screen.getByTestId('activity-range-selection')).toHaveAttribute('data-end-index', '2');
  });

  test('shows the selected start and end labels while the slider is hovered', async () => {
    render(
      <ActivityBarChart
        alertsData={series}
        decisionsData={series}
        unfilteredAlertsData={series}
        unfilteredDecisionsData={series}
        granularity="day"
        setGranularity={vi.fn()}
        onDateRangeSelect={vi.fn()}
        selectedDateRange={{ start: '2025-01-02', end: '2025-01-03' }}
        isSticky={false}
      />,
    );

    expect(screen.queryByTestId('activity-range-start-label')).not.toBeInTheDocument();
    expect(screen.queryByTestId('activity-range-end-label')).not.toBeInTheDocument();

    await userEvent.hover(screen.getByTestId('activity-slider-track'));

    expect(screen.getByTestId('activity-slider-track')).toHaveAttribute('data-label-layout', 'below');
    expect(screen.getByTestId('activity-range-start-label')).toHaveTextContent('Jan 2');
    expect(screen.getByTestId('activity-range-end-label')).toHaveTextContent('Jan 3');

    await userEvent.unhover(screen.getByTestId('activity-slider-track'));

    expect(screen.queryByTestId('activity-range-start-label')).not.toBeInTheDocument();
    expect(screen.queryByTestId('activity-range-end-label')).not.toBeInTheDocument();
  });

  test('keeps hover labels readable for a narrow selected range', async () => {
    const hourlySeries = [
      { date: '2025-03-20T15:00:00Z', label: '20. Mar, 15:00', count: 1, fullDate: '2025-03-20T15:00:00Z' },
      { date: '2025-03-20T18:00:00Z', label: '20. Mar, 18:00', count: 2, fullDate: '2025-03-20T18:00:00Z' },
      { date: '2025-03-20T21:00:00Z', label: '20. Mar, 21:00', count: 3, fullDate: '2025-03-20T21:00:00Z' },
      { date: '2025-03-21T00:00:00Z', label: '21. Mar, 00:00', count: 4, fullDate: '2025-03-21T00:00:00Z' },
      { date: '2025-03-21T03:00:00Z', label: '21. Mar, 03:00', count: 5, fullDate: '2025-03-21T03:00:00Z' },
      { date: '2025-03-21T06:00:00Z', label: '21. Mar, 06:00', count: 6, fullDate: '2025-03-21T06:00:00Z' },
    ];

    render(
      <ActivityBarChart
        alertsData={hourlySeries.slice(2, 4)}
        decisionsData={hourlySeries.slice(2, 4)}
        unfilteredAlertsData={hourlySeries}
        unfilteredDecisionsData={hourlySeries}
        granularity="hour"
        setGranularity={vi.fn()}
        onDateRangeSelect={vi.fn()}
        selectedDateRange={{ start: '2025-03-20T21:00:00Z', end: '2025-03-21T00:00:00Z' }}
        isSticky={false}
      />,
    );

    await userEvent.hover(screen.getByTestId('activity-slider-track'));

    expect(screen.getByTestId('activity-slider-track')).toHaveAttribute('data-label-layout', 'below');
    expect(screen.getByTestId('activity-range-start-label')).toHaveTextContent('20. Mar, 21:00');
    expect(screen.getByTestId('activity-range-end-label')).toHaveTextContent('21. Mar, 00:00');
  });

  test('keeps tight-range hover labels on one row below the slider', async () => {
    const tightSeries = [
      { date: '2025-03-21T17:00:00Z', label: '21. Mar, 17:00', count: 1, fullDate: '2025-03-21T17:00:00Z' },
      { date: '2025-03-21T20:00:00Z', label: '21. Mar, 20:00', count: 2, fullDate: '2025-03-21T20:00:00Z' },
      { date: '2025-03-21T23:00:00Z', label: '21. Mar, 23:00', count: 3, fullDate: '2025-03-21T23:00:00Z' },
      { date: '2025-03-22T02:00:00Z', label: '22. Mar, 02:00', count: 4, fullDate: '2025-03-22T02:00:00Z' },
      { date: '2025-03-22T05:00:00Z', label: '22. Mar, 05:00', count: 5, fullDate: '2025-03-22T05:00:00Z' },
      { date: '2025-03-22T08:00:00Z', label: '22. Mar, 08:00', count: 6, fullDate: '2025-03-22T08:00:00Z' },
      { date: '2025-03-22T11:00:00Z', label: '22. Mar, 11:00', count: 7, fullDate: '2025-03-22T11:00:00Z' },
      { date: '2025-03-22T14:00:00Z', label: '22. Mar, 14:00', count: 8, fullDate: '2025-03-22T14:00:00Z' },
      { date: '2025-03-22T17:00:00Z', label: '22. Mar, 17:00', count: 9, fullDate: '2025-03-22T17:00:00Z' },
    ];

    render(
      <ActivityBarChart
        alertsData={tightSeries.slice(2, 4)}
        decisionsData={tightSeries.slice(2, 4)}
        unfilteredAlertsData={tightSeries}
        unfilteredDecisionsData={tightSeries}
        granularity="hour"
        setGranularity={vi.fn()}
        onDateRangeSelect={vi.fn()}
        selectedDateRange={{ start: '2025-03-21T23:00:00Z', end: '2025-03-22T02:00:00Z' }}
        isSticky={false}
      />,
    );

    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const getBoundingClientRectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function mockBoundingClientRect(this: HTMLElement) {
        const testId = this.getAttribute('data-testid');
        if (testId === 'activity-slider-track') {
          return createDomRect(160, 40);
        }
        if (testId === 'activity-range-start-label' || testId === 'activity-range-end-label') {
          return createDomRect(96, 18);
        }
        return originalGetBoundingClientRect.call(this);
      });

    await userEvent.hover(screen.getByTestId('activity-slider-track'));

    expect(screen.getByTestId('activity-slider-track')).toHaveAttribute('data-label-layout', 'below');
    await waitFor(() => {
      expect(screen.getByTestId('activity-slider-track')).toHaveAttribute('data-label-offset-active', 'true');
    });
    expect(screen.getByTestId('activity-range-start-label')).toHaveTextContent('21. Mar, 23:00');
    expect(screen.getByTestId('activity-range-end-label')).toHaveTextContent('22. Mar, 02:00');

    getBoundingClientRectSpy.mockRestore();
  });
});
