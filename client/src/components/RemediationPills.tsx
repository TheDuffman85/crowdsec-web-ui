import { Badge } from './ui/Badge';
import { useRemediationTypeLabel } from '../lib/remediationTypes';
import type { StatisticsRemediationType } from '../../../shared/statistics';

const VARIANTS: Record<string, 'danger' | 'warning'> = { ban: 'danger', captcha: 'warning' };

/** One pill per decision type with its count, for a right-aligned Remediations cell; empty without remediations. */
export function RemediationPills({ types }: { types: StatisticsRemediationType[] }) {
  const label = useRemediationTypeLabel();
  if (!types.length) return null;
  return (
    <span className="inline-flex flex-wrap justify-end gap-1">
      {types.map((type) => (
        <Badge key={type.label} variant={VARIANTS[type.label.toLowerCase()] ?? 'secondary'} className="whitespace-nowrap tabular-nums">
          {label(type.label)} {type.count.toLocaleString()}
        </Badge>
      ))}
    </span>
  );
}
