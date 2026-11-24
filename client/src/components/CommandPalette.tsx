import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { Modal } from './ui/Modal';
import { useI18n } from '../lib/i18n';
import {
  buildPaletteCommands,
  findShortcutTarget,
  isEditableTarget,
} from '../lib/commandPalette';

/** The `g` prefix expires if the second key does not follow quickly. */
const SEQUENCE_TIMEOUT_MS = 1500;

/**
 * Ctrl/Cmd+K command palette plus `g` then a letter navigation shortcuts.
 * Shortcuts are ignored while typing in a form field or when a dialog is open.
 */
export function CommandPalette() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const commands = useMemo(() => buildPaletteCommands(query, t), [query, t]);
  const activeIndex = Math.min(active, Math.max(0, commands.length - 1));

  useEffect(() => {
    let sequenceTimer: number | undefined;
    let awaitingSecondKey = false;
    const clearSequence = () => {
      awaitingSecondKey = false;
      if (sequenceTimer !== undefined) window.clearTimeout(sequenceTimer);
      sequenceTimer = undefined;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        clearSequence();
        setQuery('');
        setActive(0);
        setOpen((current) => !current);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditableTarget(event.target) || document.querySelector('[role="dialog"]')) {
        clearSequence();
        return;
      }
      if (awaitingSecondKey) {
        const target = findShortcutTarget(event.key);
        clearSequence();
        if (target) {
          event.preventDefault();
          navigate(target.path);
        }
        return;
      }
      if (event.key === 'g') {
        awaitingSecondKey = true;
        sequenceTimer = window.setTimeout(clearSequence, SEQUENCE_TIMEOUT_MS);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      clearSequence();
    };
  }, [navigate]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const run = (index: number) => {
    const command = commands[index];
    if (!command) return;
    setOpen(false);
    navigate(command.path);
  };

  return (
    <Modal isOpen={open} onClose={() => setOpen(false)} title={null} showCloseButton={false} maxWidth="max-w-lg">
      <div role="combobox" aria-expanded="true" aria-haspopup="listbox" aria-controls="command-palette-list" className="-m-2">
        <div className="flex items-center gap-2 border-b border-gray-200 px-2 pb-3 dark:border-gray-700">
          <Search size={18} className="text-gray-400" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            aria-label={t('components.commandPalette.inputLabel')}
            aria-autocomplete="list"
            aria-activedescendant={commands[activeIndex] ? `command-${commands[activeIndex].id}` : undefined}
            placeholder={t('components.commandPalette.placeholder')}
            className="w-full bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400 dark:text-gray-100"
            onChange={(event) => { setQuery(event.target.value); setActive(0); }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setActive(Math.min(activeIndex + 1, commands.length - 1)); }
              else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(Math.max(activeIndex - 1, 0)); }
              else if (event.key === 'Enter') { event.preventDefault(); run(activeIndex); }
            }}
          />
        </div>
        <ul id="command-palette-list" role="listbox" className="mt-2 max-h-72 overflow-y-auto">
          {commands.map((command, index) => (
            <li
              key={command.id}
              id={`command-${command.id}`}
              role="option"
              aria-selected={index === activeIndex}
              onMouseEnter={() => setActive(index)}
              onClick={() => run(index)}
              className={`flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-sm ${index === activeIndex ? 'bg-primary-50 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300' : 'text-gray-700 dark:text-gray-300'}`}
            >
              <span className="min-w-0 truncate">
                {command.query !== undefined ? t(command.labelKey, { query: command.query }) : t(command.labelKey)}
              </span>
              {command.shortcut && (
                <kbd className="shrink-0 rounded border border-gray-300 px-1.5 py-0.5 text-xs text-gray-500 dark:border-gray-600 dark:text-gray-400">
                  g {command.shortcut}
                </kbd>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-3 border-t border-gray-200 px-2 pt-3 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
          {t('components.commandPalette.hint')}
        </p>
      </div>
    </Modal>
  );
}
