import { useI18n } from './i18n';

const LABELS: Record<string, string> = { ban: 'pages.decisions.typeBan', captcha: 'pages.decisions.typeCaptcha' };

/** Translated name of a decision type; custom types keep their own name. */
export function useRemediationTypeLabel(): (type: string) => string {
  const { t } = useI18n();
  return (type) => (LABELS[type.toLowerCase()] ? t(LABELS[type.toLowerCase()]) : type);
}
