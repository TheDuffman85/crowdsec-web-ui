import { useEffect, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { checkRepeatOffender, type RepeatOffenderCheck } from '../lib/insightsApi';

const CHECK_DELAY_MS = 400;
const SINGLE_ADDRESS = /^[0-9a-fA-F:.]+$/;

interface EscalationHintProps {
  ip: string;
  currentDuration: string;
  disabled?: boolean;
  onApply: (duration: string) => void;
}

/** Offers a longer ban for an address that was banned before; the choice stays with the person adding the ban. */
export function EscalationHint({ ip, currentDuration, disabled, onApply }: EscalationHintProps) {
  const { t } = useI18n();
  const [lookup, setLookup] = useState<{ ip: string; check: RepeatOffenderCheck } | null>(null);
  const valid = SINGLE_ADDRESS.test(ip) && !ip.includes('/');

  useEffect(() => {
    if (!valid) return;
    let active = true;
    const timer = window.setTimeout(() => {
      checkRepeatOffender(ip)
        .then((check) => { if (active) setLookup({ ip, check }); })
        .catch(() => { /* A failed history lookup should never block adding a ban. */ });
    }, CHECK_DELAY_MS);
    return () => { active = false; window.clearTimeout(timer); };
  }, [ip, valid]);

  const result = lookup?.ip === ip ? lookup.check : null;
  if (!valid || !result?.offender || result.previous_bans < 1) return null;
  const suggested = result.offender.suggested_duration;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-900/10 dark:text-amber-200" data-testid="escalation-hint">
      <span>{t('components.escalation.message', { count: result.previous_bans })}</span>
      <button
        type="button"
        disabled={disabled || currentDuration === suggested}
        onClick={() => onApply(suggested)}
        className="rounded-full border border-amber-300 bg-white px-3 py-1 font-medium hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-amber-700 dark:bg-gray-800 dark:hover:bg-gray-700"
      >
        {t('components.escalation.apply', { duration: suggested })}
      </button>
    </div>
  );
}
