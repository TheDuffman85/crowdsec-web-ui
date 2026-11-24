import { Sparkles } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { buildSummaryParts } from '../lib/smartSummary';
import { getCountryName } from '../lib/utils';
import type { DashboardStatListItem, DashboardStatsBucket } from '../types';

interface SmartSummaryProps {
  alerts: DashboardStatsBucket[];
  granularity: 'day' | 'hour';
  totalAlerts: number;
  topScenarios: DashboardStatListItem[];
  topCountries: DashboardStatListItem[];
  topIPs: DashboardStatListItem[];
}

/** A short plain-language reading of the dashboard numbers, written from templates on this page's own data. */
export function SmartSummary(props: SmartSummaryProps) {
  const { t, language } = useI18n();
  const parts = buildSummaryParts({
    ...props,
    t,
    countryName: (code, fallback) => getCountryName(code, language) ?? fallback,
  });
  return (
    <div className="flex items-start gap-3 rounded-xl border border-primary-200 bg-primary-50 px-4 py-3 text-sm text-primary-900 dark:border-primary-900/50 dark:bg-primary-900/20 dark:text-primary-100" data-testid="smart-summary">
      <Sparkles className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p><span className="sr-only">{t('components.smartSummary.label')}: </span>{parts.map((part) => t(part.key, part.values)).join(' ')}</p>
    </div>
  );
}
