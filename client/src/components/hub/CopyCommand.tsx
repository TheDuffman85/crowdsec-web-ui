import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

const BUTTON = 'inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700';

export function CopyCommand({ command, label }: { command: string; label: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(command).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* Clipboard access can be blocked; the command is still shown. */ });
  };
  return (
    <button type="button" onClick={copy} aria-label={label} title={command} className={BUTTON}>
      {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
      {copied ? t('tools.hub.copied') : t('tools.hub.copy')}
    </button>
  );
}

/** A command shown in full with a copy button, for commands that are run on another machine. */
export function CommandBlock({ command, label }: { command: string; label: string }) {
  return (
    <div className="space-y-1">
      <code className="block overflow-x-auto whitespace-pre rounded bg-gray-100 px-3 py-2 text-xs dark:bg-gray-800" data-testid="hub-command">{command}</code>
      <CopyCommand command={command} label={label} />
    </div>
  );
}
