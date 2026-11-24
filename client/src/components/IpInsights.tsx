import { Link } from 'react-router-dom';
import { useI18n } from '../lib/i18n';
import { IpIntelPanel } from './IpIntelPanel';
import { NotesPanel } from './NotesPanel';
import { RepeatOffenderBanner } from './RepeatOffenderBanner';
import { ThreatScoreBadge } from './ThreatScoreBadge';

interface IpInsightsProps {
  ip: string | null;
  alertId: string | number | null;
}

const SINGLE_ADDRESS = /^[0-9a-fA-F:.]+$/;

/** Ban history, reputation lookup and shared notes for the source of an alert. */
export function IpInsights({ ip, alertId }: IpInsightsProps) {
  const { t } = useI18n();
  const address = ip && SINGLE_ADDRESS.test(ip) ? ip : null;
  if (!address && alertId === null) return null;

  return (
    <div className="space-y-4">
      {address && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('components.threatScore.label')}</span>
          <ThreatScoreBadge ip={address} />
          <Link to={`/tools/ip-timeline?ip=${encodeURIComponent(address)}`} className="text-sm text-primary-700 hover:underline dark:text-primary-400">{t('tools.timeline.open')}</Link>
        </div>
      )}
      {address && <RepeatOffenderBanner ip={address} />}
      {address && <IpIntelPanel ip={address} />}
      {address && <NotesPanel type="ip" subject={address} title={t('components.notes.ipTitle', { ip: address })} />}
      {alertId !== null && <NotesPanel type="alert" subject={String(alertId)} title={t('components.notes.alertTitle')} />}
    </div>
  );
}
