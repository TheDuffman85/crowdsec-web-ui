import type { ReactNode } from 'react';

const formatNumber = (value: number) => value.toLocaleString();

/**
 * A list row in the style of StatCard: optional rank and a label on the left,
 * the change with the alerts of both periods on the right.
 */
export function PeriodChangeRow({ rank, label, change, changeClassName, previous, current }: {
  rank?: number;
  label: ReactNode;
  change: string;
  changeClassName: string;
  previous: number;
  current: number;
}) {
  return (
    <span className="flex items-center justify-between gap-2">
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {rank !== undefined && (
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-100 text-xs font-semibold text-primary-700 dark:bg-primary-900/30 dark:text-primary-300">{rank}</span>
        )}
        {label}
      </span>
      <span className="ml-2 flex shrink-0 flex-col items-end">
        <span className={`text-sm font-bold tabular-nums ${changeClassName}`}>{change}</span>
        <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">{formatNumber(previous)} → {formatNumber(current)}</span>
      </span>
    </span>
  );
}
