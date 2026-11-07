import { useI18n } from './i18n';

/** Relative change against the preceding period; values without one are new. */
export function usePeriodChange() {
  const { t } = useI18n();
  return (previous: number, current: number) => {
    if (previous === 0) return current > 0 ? t('pages.statistics.new') : '0%';
    const percent = Math.round((current - previous) / previous * 100);
    return `${percent > 0 ? '+' : percent < 0 ? '−' : ''}${Math.abs(percent).toLocaleString()}%`;
  };
}
