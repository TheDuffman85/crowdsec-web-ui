import { Link } from 'react-router-dom';
import { Ban } from 'lucide-react';
import { Card, CardContent } from '../components/ui/Card';
import { TOOLS } from '../lib/tools';
import { useI18n } from '../lib/i18n';

export function Tools() {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-gray-100">
          <Ban size={22} aria-hidden="true" />
          {t('tools.title')}
        </h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('tools.description')}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {TOOLS.map((tool) => (
          <Link key={tool.slug} to={`/tools/${tool.slug}`} className="block rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
            <Card className="h-full transition-colors hover:border-primary-400 dark:hover:border-primary-500">
              <CardContent className="flex gap-3 pt-5">
                <tool.icon size={22} className="mt-0.5 shrink-0 text-primary-600 dark:text-primary-400" aria-hidden="true" />
                <div>
                  <h3 className="font-semibold text-gray-900 dark:text-gray-100">{t(tool.titleKey)}</h3>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t(tool.descriptionKey)}</p>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
