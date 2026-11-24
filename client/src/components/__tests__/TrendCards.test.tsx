import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import type { DashboardStatsBucket } from '../../types';
import { TrendCards } from '../TrendCards';

const buckets = (counts: number[]): DashboardStatsBucket[] =>
  counts.map((count, index) => ({ date: `d${index}`, fullDate: `2026-11-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`, count }));

describe('TrendCards', () => {
  test('shows week-over-week change with direction colours', () => {
    render(
      <TrendCards
        alerts={buckets([...Array(7).fill(10), ...Array(7).fill(15)])}
        decisions={buckets([...Array(7).fill(4), ...Array(7).fill(2)])}
        granularity="day"
      />,
    );

    const alerts = screen.getByTestId('trend-alerts');
    expect(alerts).toHaveAttribute('data-direction', 'up');
    expect(alerts).toHaveTextContent('105');
    expect(alerts).toHaveTextContent('+50%');
    expect(alerts).toHaveTextContent('vs 70 in the previous 7 days');
    expect(alerts).toHaveTextContent('last 7 days');

    const decisions = screen.getByTestId('trend-decisions');
    expect(decisions).toHaveAttribute('data-direction', 'down');
    expect(decisions).toHaveTextContent('-50%');
    expect(screen.getByRole('img', { name: 'Alerts trend over the selected period' })).toBeInTheDocument();
  });

  test('labels hourly comparisons and new activity', () => {
    render(<TrendCards alerts={buckets([...Array(24).fill(0), ...Array(24).fill(2)])} decisions={[]} granularity="hour" />);
    expect(screen.getByTestId('trend-alerts')).toHaveTextContent('New');
    expect(screen.getByTestId('trend-alerts')).toHaveTextContent('last 24 hours');
    expect(screen.queryByTestId('trend-decisions')).not.toBeInTheDocument();
  });

  test('renders nothing without enough data', () => {
    const { container } = render(<TrendCards alerts={[]} decisions={buckets([1])} granularity="day" />);
    expect(container).toBeEmptyDOMElement();
  });
});
