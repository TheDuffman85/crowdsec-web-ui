import { useState } from "react";
import type { AlertSessionScenarioGroup as ScenarioGroup } from "../../../shared/contracts";
import { useI18n } from "../lib/i18n";
import { ScenarioName } from "./ScenarioName";
import { Badge } from "./ui/Badge";

const COLLAPSED_SCENARIO_COUNT = 3;

interface AlertSessionScenarioGroupProps {
    group: ScenarioGroup;
    simulated: boolean;
}

// Keeps the open state in the cell, so toggling it does not re-render the alert table.
export function AlertSessionScenarioGroup({ group, simulated }: AlertSessionScenarioGroupProps) {
    const { t } = useI18n();
    const [expanded, setExpanded] = useState(false);
    const canExpand = group.scenarios.length > COLLAPSED_SCENARIO_COUNT;
    const visibleScenarios = expanded ? group.scenarios : group.scenarios.slice(0, COLLAPSED_SCENARIO_COUNT);
    const hiddenCount = group.scenario_count - visibleScenarios.length;

    return (
        <div className="space-y-1">
            {group.kind && (
                <div className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">{group.kind}</div>
            )}
            {visibleScenarios.map((entry) => (
                <div key={entry.scenario} className="flex min-w-0 items-center gap-1" title={entry.scenario}>
                    <Badge variant="secondary" className="flex-shrink-0">{entry.count}x</Badge>
                    <ScenarioName name={entry.scenario} simulated={simulated} />
                </div>
            ))}
            {/* The server caps the list, so a group can have scenarios it cannot show. */}
            {(expanded || !canExpand) && hiddenCount > 0 && (
                <div className="text-xs text-gray-500 dark:text-gray-400">
                    {t('pages.alerts.sessionMoreScenarios', { count: hiddenCount })}
                </div>
            )}
            {canExpand && (
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        setExpanded((current) => !current);
                    }}
                    aria-expanded={expanded}
                    className="rounded text-xs text-gray-500 underline-offset-2 transition-colors hover:text-gray-900 hover:underline dark:text-gray-400 dark:hover:text-gray-100"
                >
                    {expanded
                        ? t('pages.alerts.sessionFewerScenarios')
                        : t('pages.alerts.sessionMoreScenarios', { count: hiddenCount })}
                </button>
            )}
        </div>
    );
}
