import {
    useId,
    useLayoutEffect,
    useRef,
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
    forceExpanded?: boolean;
    footer?: ReactNode;
    children: ReactNode;
}

export function CollapsibleSearchControls({
    inputRef,
    onHelp,
    compact = false,
    forceExpanded = false,
    footer,
    children,
}: CollapsibleSearchControlsProps) {
    const { t } = useI18n();
    const [expanded, setExpanded] = useState(false);
    const wasForcedExpandedRef = useRef(forceExpanded);
    const inputContainerId = useId();
    const searchExpanded = forceExpanded || expanded;

    useLayoutEffect(() => {
        if (expanded) inputRef.current?.focus();
    }, [expanded, inputRef]);

    useLayoutEffect(() => {
        if (wasForcedExpandedRef.current && !forceExpanded) {
            setExpanded(true);
        }
        wasForcedExpandedRef.current = forceExpanded;
    }, [forceExpanded]);

    const toggleLabel = searchExpanded
        ? t('components.search.collapse')
        : t('components.search.expand');
    const controlSize = compact ? 'h-[38px] min-h-[38px] min-w-[38px]' : 'min-h-11 min-w-11';

    return (
        <div className={searchExpanded
            ? 'grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-2'
            : 'flex min-w-0 shrink-0 items-stretch'}
        >
            {searchExpanded && (
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
            <div className="flex min-w-0 items-stretch">
                {searchExpanded && (
                    <div id={inputContainerId} className="min-w-0 flex-1">
                        {children}
                    </div>
                )}
                <button
                    type="button"
                    onClick={() => {
                        if (!forceExpanded) setExpanded((current) => !current);
                    }}
                    className={`inline-flex shrink-0 items-center justify-center border px-3 transition-colors ${controlSize} ${
                        searchExpanded
                            ? 'rounded-r-md border-gray-300 border-l-0 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
                            : 'rounded-md border-gray-300 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
                    }`}
                    aria-label={toggleLabel}
                    title={toggleLabel}
                    aria-expanded={searchExpanded}
                    aria-disabled={forceExpanded || undefined}
                    aria-controls={inputContainerId}
                >
                    <Search size={18} aria-hidden="true" />
                </button>
            </div>
            {searchExpanded && footer && (
                <div
                    className="col-start-2 min-w-0"
                    data-search-controls-footer="true"
                >
                    {footer}
                </div>
            )}
        </div>
    );
}
