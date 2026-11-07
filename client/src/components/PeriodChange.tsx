import { DASHBOARD_COLORS } from '../lib/dashboardColors';
import { useI18n } from '../lib/i18n';

const formatNumber = (value: number) => value.toLocaleString();

/** Explains the bar and the tick of PeriodChangeBar. */
export function PeriodLegend({ className = '' }: { className?: string }) {
  const { t } = useI18n();
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400 ${className}`} aria-hidden="true">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-1.5 w-4 rounded-full" style={{ backgroundColor: DASHBOARD_COLORS.liveAlerts }} />
        {t('pages.statistics.selectedPeriod')}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-0.5 rounded-full bg-gray-500 dark:bg-gray-300" />
        {t('pages.statistics.precedingPeriod')}
      </span>
    </div>
  );
}

/**
 * Alerts of the selected period as a bar, with a tick at the preceding
 * period's value. Rows sharing `scale` are comparable with each other.
 */
export function PeriodChangeBar({ previous, current, scale }: { previous: number; current: number; scale: number }) {
  const { t } = useI18n();
  const max = Math.max(1, scale);
  return (
    <span className="flex items-center gap-3">
      <span className="relative h-1.5 flex-1 rounded-full bg-gray-100 dark:bg-gray-700/60">
        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${current / max * 100}%`, backgroundColor: DASHBOARD_COLORS.liveAlerts }} />
        <span className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-gray-500 dark:bg-gray-300" style={{ left: `${previous / max * 100}%` }} />
      </span>
      <span className="w-24 shrink-0 text-right text-xs tabular-nums text-gray-500 dark:text-gray-400">{t('pages.statistics.alertCount', { count: formatNumber(current) })}</span>
    </span>
  );
}
