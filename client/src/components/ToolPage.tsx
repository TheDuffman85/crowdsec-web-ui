import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useI18n } from '../lib/i18n';

interface ToolPageProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}

/** Shared frame for the pages under /tools: heading, short description and a link back to the hub. */
export function ToolPage({ title, description, actions, children }: ToolPageProps) {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <div>
        <Link to="/tools" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200">
          <ArrowLeft size={14} aria-hidden="true" />
          {t('tools.backToTools')}
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{title}</h2>
            {description && <p className="mt-1 max-w-3xl text-sm text-gray-500 dark:text-gray-400">{description}</p>}
          </div>
          {actions}
        </div>
      </div>
      {children}
    </div>
  );
}

export function ToolMessage({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'error' | 'warning' }) {
  const color = tone === 'error'
    ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300'
    : tone === 'warning'
      ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200'
      : 'border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-300';
  return <div role={tone === 'error' ? 'alert' : undefined} className={`rounded-lg border px-4 py-3 text-sm ${color}`}>{children}</div>;
}

