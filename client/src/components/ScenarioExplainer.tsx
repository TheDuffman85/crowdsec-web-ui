import { Info } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { explainScenario, type ScenarioSeverity } from '../lib/scenarioExplainer';

const SEVERITY_CLASSES: Record<ScenarioSeverity, string> = {
  low: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  medium: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  high: 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300',
};

/** Short plain-English description and severity for a scenario; renders nothing for unknown scenarios. */
export function ScenarioExplainer({ scenario }: { scenario?: string | null }) {
  const { t } = useI18n();
  const explanation = explainScenario(scenario);
  if (!explanation) return null;

  return (
    <div className="mt-2 flex items-start gap-2 text-sm text-gray-600 dark:text-gray-400" data-testid="scenario-explainer">
      <Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      <p className="min-w-0">
        <span className={`mr-2 inline-block rounded px-1.5 py-0.5 text-xs font-semibold ${SEVERITY_CLASSES[explanation.severity]}`}>
          {t(`components.scenarioExplainer.severity.${explanation.severity}`)}
        </span>
        {t(`components.scenarioExplainer.category.${explanation.category}`)}
      </p>
    </div>
  );
}
