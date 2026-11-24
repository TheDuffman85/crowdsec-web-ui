import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ThreatScoreBadge } from '../ThreatScoreBadge';
import type { ThreatScore } from '../../lib/insightsApi';

const mocks = vi.hoisted(() => ({ fetchThreatScore: vi.fn() }));
vi.mock('../../lib/insightsApi', () => ({ fetchThreatScore: mocks.fetchThreatScore }));

const score = (overrides: Partial<ThreatScore> = {}): ThreatScore => ({
  ip: '203.0.113.5', score: 82, level: 'critical', reputation_available: true,
  factors: [
    { key: 'volume', points: 30.5, max: 35, value: 70 },
    { key: 'severity', points: 20, max: 25, value: 3 },
    { key: 'repeat', points: 12, max: 20, value: 2 },
    { key: 'reputation', points: 16, max: 20, value: 80 },
  ],
  ...overrides,
});

afterEach(() => vi.clearAllMocks());

describe('ThreatScoreBadge', () => {
  test('loads the score for an address and explains it in a tooltip', async () => {
    const user = userEvent.setup();
    mocks.fetchThreatScore.mockResolvedValue(score());
    render(<ThreatScoreBadge ip="203.0.113.5" />);
    const badge = await screen.findByTestId('threat-score');
    expect(badge).toHaveTextContent('82');
    expect(badge).toHaveTextContent('Critical');
    expect(badge).toHaveAccessibleName('Threat score 82 out of 100, Critical');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    await user.hover(badge);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Alert volume 30.5 of 35 points');
    expect(tooltip).toHaveTextContent('70 alerts in the last 30 days');
    expect(tooltip).toHaveTextContent('AbuseIPDB confidence 80%');
    expect(tooltip).not.toHaveTextContent('scaled');
    await user.unhover(badge);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  test('is keyboard accessible and closes with Escape', async () => {
    const user = userEvent.setup();
    render(<ThreatScoreBadge score={score({ level: 'low', score: 10 })} />);
    await user.tab();
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(mocks.fetchThreatScore).not.toHaveBeenCalled();
  });

  test('says when reputation is missing', async () => {
    const user = userEvent.setup();
    const factors = score().factors.map((factor) => (factor.key === 'reputation' ? { ...factor, points: 0, value: null } : factor));
    render(<ThreatScoreBadge score={score({ reputation_available: false, factors })} />);
    await user.hover(screen.getByTestId('threat-score'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('No reputation data');
    expect(screen.getByRole('tooltip')).toHaveTextContent('scaled over the other factors');
  });

  test('renders nothing when the score is unavailable', async () => {
    mocks.fetchThreatScore.mockRejectedValue(new Error('x'));
    const view = render(<ThreatScoreBadge ip="203.0.113.5" />);
    await waitFor(() => expect(mocks.fetchThreatScore).toHaveBeenCalled());
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(<ThreatScoreBadge score={null} />);
    expect(view.container).toBeEmptyDOMElement();
  });
});
