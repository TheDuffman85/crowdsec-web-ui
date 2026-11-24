import { useI18n } from '../lib/i18n';

interface CompareToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/** Switches a chart between "this period" and "this period against the one before". */
export function CompareToggle({ checked, onChange }: CompareToggleProps) {
  const { t } = useI18n();
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {t('components.compare.toggle')}
    </label>
  );
}
