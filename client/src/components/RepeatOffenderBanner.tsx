import { useEffect, useState } from 'react';
import { Repeat } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { checkRepeatOffender, type RepeatOffenderCheck } from '../lib/insightsApi';

/** Flags an address that was banned, came back after the ban ended, and was banned again. */
export function RepeatOffenderBanner({ ip }: { ip: string }) {
  const { t } = useI18n();
  const [lookup, setLookup] = useState<{ ip: string; check: RepeatOffenderCheck } | null>(null);

  useEffect(() => {
    let active = true;
    checkRepeatOffender(ip)
      .then((result) => { if (active) setLookup({ ip, check: result }); })
      .catch(() => { if (active) setLookup(null); });
    return () => { active = false; };
  }, [ip]);

  const check = lookup?.ip === ip ? lookup.check : null;
  if (!check?.repeat_offender || !check.offender) return null;
  const { offender } = check;

  return (
    <div role="status" className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-900/10 dark:text-amber-200" data-testid="repeat-offender-banner">
      <Repeat size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div>
        <p className="font-medium">{t('components.repeatOffender.title', { count: offender.episodes })}</p>
        <p>
          {t('components.repeatOffender.detail', {
            date: new Date(offender.last_ban_end).toLocaleString(),
            duration: offender.suggested_duration,
          })}
        </p>
      </div>
    </div>
  );
}
