import { useEffect, useId, useState } from 'react';
import { fetchThreatScore, type ThreatLevel, type ThreatScore } from '../lib/insightsApi';
import { useI18n } from '../lib/i18n';

const LEVEL_STYLES: Record<ThreatLevel, string> = {
  low: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  medium: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  high: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  critical: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
};

interface ThreatScoreBadgeProps {
  ip?: string;
  /** A score already loaded by the parent, for example for a whole list at once. */
  score?: ThreatScore | null;
}

/** A 0-100 score with a tooltip that explains where the points came from. */
export function ThreatScoreBadge({ ip, score: provided }: ThreatScoreBadgeProps) {
  const { t } = useI18n();
  const tooltipId = useId();
  const [loaded, setLoaded] = useState<{ ip: string; score: ThreatScore } | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (provided !== undefined || !ip) return;
    let active = true;
    fetchThreatScore(ip).then((score) => { if (active) setLoaded({ ip, score }); }).catch(() => { /* The score is optional context. */ });
    return () => { active = false; };
  }, [ip, provided]);

  const score = provided ?? (loaded && loaded.ip === ip ? loaded.score : null);
  if (!score) return null;

  const detail = (factor: ThreatScore['factors'][number]): string => {
    switch (factor.key) {
      case 'volume': return t('components.threatScore.detail.volume', { count: factor.value ?? 0 });
      case 'severity': return t('components.threatScore.detail.severity', { count: factor.value ?? 0 });
      case 'repeat': return t('components.threatScore.detail.repeat', { count: factor.value ?? 0 });
      default: return factor.value === null ? t('components.threatScore.detail.noReputation') : t('components.threatScore.detail.reputation', { score: factor.value });
    }
  };

  return (
    <span className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-describedby={open ? tooltipId : undefined}
        aria-label={t('components.threatScore.aria', { score: score.score, level: t(`components.threatScore.level.${score.level}`) })}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}
        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${LEVEL_STYLES[score.level]}`}
        data-testid="threat-score"
      >
        <span className="tabular-nums">{score.score}</span>
        <span>{t(`components.threatScore.level.${score.level}`)}</span>
      </button>
      {open && (
        <span id={tooltipId} role="tooltip" className="absolute left-0 top-full z-50 mt-1 w-72 rounded-lg border border-gray-200 bg-white p-3 text-left text-xs text-gray-700 shadow-xl dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">
          <span className="mb-2 block font-medium">{t('components.threatScore.explain')}</span>
          <span className="block space-y-1">
            {score.factors.map((factor) => (
              <span key={factor.key} className="block">
                <span className="font-medium">{t(`components.threatScore.factor.${factor.key}`)}</span>
                {' '}
                <span className="tabular-nums">{t('components.threatScore.points', { points: factor.points, max: factor.max })}</span>
                <span className="block text-gray-500 dark:text-gray-400">{detail(factor)}</span>
              </span>
            ))}
          </span>
          {!score.reputation_available && <span className="mt-2 block text-gray-500 dark:text-gray-400">{t('components.threatScore.scaled')}</span>}
        </span>
      )}
    </span>
  );
}
