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
    compact?: boolean;
    children: ReactNode;
}

export function CollapsibleSearchControls({
    inputRef,
    onHelp,
    compact = false,
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
    const controlSize = compact ? 'h-[38px] min-h-[38px] min-w-[38px]' : 'min-h-11 min-w-11';

    return (
        <div className={`flex min-w-0 items-stretch ${expanded ? 'flex-1 gap-2' : 'shrink-0'}`}>
            {expanded && (
                <button
                    type="button"
                    onClick={onHelp}
                    className={`inline-flex shrink-0 items-center justify-center rounded-md border border-gray-300 bg-white px-3 text-gray-600 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 ${controlSize}`}
                    aria-label={t('components.searchSyntax.help')}
                    title={t('components.searchSyntax.help')}
                >
                    <Info size={18} aria-hidden="true" />
                </button>
            )}
            <div className={`flex min-w-0 items-stretch ${expanded ? 'flex-1' : ''}`}>
                {expanded && (
                    <div id={inputContainerId} className="min-w-0 flex-1">
                        {children}
                    </div>
                )}
                <button
                    type="button"
                    onClick={() => setExpanded((current) => !current)}
                    className={`inline-flex shrink-0 items-center justify-center border px-3 transition-colors ${controlSize} ${
                        expanded
                            ? 'rounded-r-md border-gray-300 border-l-0 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
                            : 'rounded-md border-gray-300 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
                    }`}
                    aria-label={toggleLabel}
                    title={toggleLabel}
                    aria-expanded={expanded}
                    aria-controls={inputContainerId}
                >
                    <Search size={18} aria-hidden="true" />
                </button>
            </div>
        </div>
    );
}
