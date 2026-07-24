import { Badge } from './ui/Badge';
import { useI18n } from '../lib/i18n';

interface TargetDisplayProps {
    target?: string | null;
    targetCount?: number;
    className?: string;
}

export function TargetDisplay({ target, targetCount, className = '' }: TargetDisplayProps) {
    const { t } = useI18n();
    const distinctTargetCount = Number.isFinite(targetCount) && Number(targetCount) > 1
        ? Math.floor(Number(targetCount))
        : 1;
    const countLabel = t('components.targetDisplay.distinctTargets', {
        count: distinctTargetCount,
        defaultValue: `${distinctTargetCount} distinct targets`,
    });

    if (!target) {
        return <span className={className}>-</span>;
    }

    return (
        <div
            className={`flex min-w-0 items-center gap-2 ${className}`}
            title={distinctTargetCount > 1 ? `${target} · ${countLabel}` : target}
        >
            <span className="truncate">{target}</span>
            {distinctTargetCount > 1 && (
                <Badge variant="secondary" title={countLabel}>
                    {distinctTargetCount}
                </Badge>
            )}
        </div>
    );
}
