import {
    useId,
    useLayoutEffect,
    useState,
    type ReactNode,
    type RefObject,
} from 'react';
import { Info, Search } from 'lucide-react';
import { useI18n } from '../lib/i18n';

interface CollapsibleSearchControlsProps {
    inputRef: RefObject<HTMLInputElement | null>;
    onHelp: () => void;
    children: ReactNode;
}

export function CollapsibleSearchControls({
    inputRef,
    onHelp,
    children,
}: CollapsibleSearchControlsProps) {
    const { t } = useI18n();
    const [expanded, setExpanded] = useState(false);
    const inputContainerId = useId();

    useLayoutEffect(() => {
        if (expanded) inputRef.current?.focus();
    }, [expanded, inputRef]);

    const toggleLabel = expanded
        ? t('components.search.collapse')
        : t('components.search.expand');

    return (
        <div className={`flex min-w-0 items-stretch ${expanded ? 'flex-1 gap-2' : 'shrink-0'}`}>
            <div className={`flex min-w-0 items-stretch ${expanded ? 'flex-1' : ''}`}>
                <button
                    type="button"
                    onClick={() => setExpanded((current) => !current)}
                    className={`inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center border px-3 transition-colors ${
                        expanded
                            ? 'rounded-l-md border-primary-500 border-r-0 bg-primary-50 text-primary-700 dark:border-primary-500 dark:bg-primary-900/30 dark:text-primary-300'
                            : 'rounded-md border-gray-300 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
                    }`}
                    aria-label={toggleLabel}
                    title={toggleLabel}
                    aria-expanded={expanded}
                    aria-controls={inputContainerId}
                >
                    <Search size={18} aria-hidden="true" />
                </button>
                {expanded && (
                    <div id={inputContainerId} className="min-w-0 flex-1">
                        {children}
                    </div>
                )}
            </div>
            {expanded && (
                <button
                    type="button"
                    onClick={onHelp}
                    className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md border border-gray-300 bg-white px-3 text-gray-600 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                    aria-label={t('components.searchSyntax.help')}
                    title={t('components.searchSyntax.help')}
                >
                    <Info size={18} aria-hidden="true" />
                </button>
            )}
        </div>
    );
}
