import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { computeTrend, sparklinePoints, type Trend } from '../lib/trends';
import type { DashboardStatsBucket } from '../types';
import { Card, CardContent } from './ui/Card';

interface TrendCardsProps {
  alerts: DashboardStatsBucket[];
  decisions: DashboardStatsBucket[];
  granularity: 'day' | 'hour';
}

const SPARKLINE_WIDTH = 120;
const SPARKLINE_HEIGHT = 36;

function TrendCard({ kind, title, trend }: { kind: 'alerts' | 'decisions'; title: string; trend: Trend }) {
  const { t } = useI18n();
  // More attacks is worse, so an increase is red and a decrease is green.
  const tone = trend.direction === 'up'
    ? 'text-red-600 dark:text-red-400'
    : trend.direction === 'down'
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-gray-500 dark:text-gray-400';
  const Icon = trend.direction === 'up' ? ArrowUpRight : trend.direction === 'down' ? ArrowDownRight : ArrowRight;
  const change = trend.percentChange === null
    ? (trend.current > 0 ? t('components.trendCards.new') : '0%')
    : `${trend.percentChange > 0 ? '+' : ''}${trend.percentChange.toLocaleString()}%`;

  return (
    <Card>
      <CardContent>
        <div className="flex items-center justify-between gap-4" data-testid={`trend-${kind}`} data-direction={trend.direction}>
          <div className="min-w-0">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {title}
              <span className="ml-1">· {t(`components.trendCards.window.${trend.unit}`, { count: trend.windowSize })}</span>
            </p>
            <p className="text-2xl font-bold tabular-nums text-gray-900 dark:text-gray-100">{trend.current.toLocaleString()}</p>
            <p className={`flex items-center gap-1 text-sm font-medium ${tone}`}>
              <Icon size={16} aria-hidden="true" />
              <span>{change}</span>
              <span className="font-normal text-gray-500 dark:text-gray-400">
                {t(`components.trendCards.versus.${trend.unit}`, { count: trend.windowSize, previous: trend.previous.toLocaleString() })}
              </span>
            </p>
          </div>
          <svg
            width={SPARKLINE_WIDTH}
            height={SPARKLINE_HEIGHT}
            viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
            className={`shrink-0 ${tone}`}
            role="img"
            aria-label={t('components.trendCards.sparklineLabel', { title })}
          >
            <polyline
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              points={sparklinePoints(trend.values, SPARKLINE_WIDTH, SPARKLINE_HEIGHT)}
            />
          </svg>
        </div>
      </CardContent>
    </Card>
  );
}

/** Alert and decision totals for the latest window with the change against the one before, plus a sparkline. */
export function TrendCards({ alerts, decisions, granularity }: TrendCardsProps) {
  const { t } = useI18n();
  const unit = granularity === 'day' ? 'days' : 'hours';
  const alertTrend = computeTrend(alerts, unit);
  const decisionTrend = computeTrend(decisions, unit);
  if (!alertTrend && !decisionTrend) return null;

  return (
    <div className="grid gap-8 md:grid-cols-2">
      {alertTrend && <TrendCard kind="alerts" title={t('components.trendCards.alerts')} trend={alertTrend} />}
      {decisionTrend && <TrendCard kind="decisions" title={t('components.trendCards.decisions')} trend={decisionTrend} />}
    </div>
  );
}
