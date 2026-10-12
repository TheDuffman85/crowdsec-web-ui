import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, CardContent } from './ui/Card';
import { cn } from '../lib/utils';

interface DashboardSummaryCardProps {
    label: string;
    icon: LucideIcon;
    iconClassName: string;
    value: ReactNode;
    valueClassName?: string;
    detail?: ReactNode;
    footer?: ReactNode;
    to?: string;
}

export function SummaryBreakdown({ label, total, filtered }: { label: string; total: number; filtered?: number }) {
    return (
        <div className="flex items-baseline gap-1.5">
            <span className="font-medium text-gray-500 dark:text-gray-400">{label}</span>
            <span className="font-semibold tabular-nums text-gray-900 dark:text-gray-100">{total}</span>
            {filtered !== undefined && (
                <span className="tabular-nums text-gray-400 dark:text-gray-500">{filtered}</span>
            )}
        </div>
    );
}

export function DashboardSummaryCard({
    label,
    icon: Icon,
    iconClassName,
    value,
    valueClassName,
    detail,
    footer,
    to,
}: DashboardSummaryCardProps) {
    const card = (
        <Card
            className={cn(
                'h-full',
                to && 'transition-[border-color,box-shadow,transform] duration-200 group-hover:-translate-y-0.5 group-hover:border-gray-300 group-hover:shadow-md dark:group-hover:border-gray-600',
            )}
        >
            <CardContent className="flex h-full flex-col gap-2 p-3 sm:gap-3 sm:p-5">
                <div className="flex items-start justify-between gap-2">
                    <p className="text-[11px] font-medium leading-tight text-gray-500 dark:text-gray-400 sm:text-sm">{label}</p>
                    <span className={cn('hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset sm:flex', iconClassName)}>
                        <Icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                </div>
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <h3 className={cn('text-xl font-bold tracking-tight tabular-nums text-gray-900 dark:text-white sm:text-3xl', valueClassName)}>
                        {value}
                    </h3>
                    {detail}
                </div>
                {footer && (
                    <div className="mt-auto border-t border-gray-100 pt-2 text-[11px] dark:border-gray-700/60 sm:pt-3 sm:text-xs">
                        {footer}
                    </div>
                )}
            </CardContent>
        </Card>
    );

    if (!to) return card;

    return (
        <Link
            to={to}
            className="group block h-full rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-50 dark:focus-visible:ring-offset-gray-950"
        >
            {card}
        </Link>
    );
}
