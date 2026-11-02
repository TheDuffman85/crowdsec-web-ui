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
    /** Below `sm`, joins the parent's wrapping flex row and moves the open input to its own line. */
    stackInputOnMobile?: boolean;
    footer?: ReactNode;
    children: ReactNode;
}

export function CollapsibleSearchControls({
    inputRef,
    onHelp,
    compact = false,
    forceExpanded = false,
    stackInputOnMobile = false,
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

    const stacked = stackInputOnMobile;
    const rootClassName = searchExpanded
        ? (stacked ? 'contents sm:flex sm:min-w-0 sm:flex-1 sm:flex-col sm:gap-y-2' : 'flex min-w-0 flex-1 flex-col gap-y-2')
        : (stacked ? 'contents sm:flex sm:min-w-0 sm:shrink-0 sm:items-stretch' : 'flex min-w-0 shrink-0 items-stretch');
    const toggleShapeClassName = !searchExpanded
        ? 'rounded-md'
        : stacked
            ? 'rounded-md sm:rounded-l-none sm:border-l-0'
            : 'rounded-r-md border-l-0';

    return (
        <div className={rootClassName}>
            <div className={stacked ? 'contents sm:flex sm:min-w-0 sm:items-stretch' : 'flex min-w-0 items-stretch'}>
                {searchExpanded && (
                    <div className={`flex min-w-0 items-start gap-2 ${stacked ? 'order-last basis-full sm:order-none sm:flex-1' : 'flex-1'}`}>
                        <button
                            type="button"
                            onClick={onHelp}
                            className={`inline-flex shrink-0 items-center justify-center rounded-md border border-gray-300 bg-white px-3 text-gray-600 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 ${controlSize}`}
                            aria-label={t('components.searchSyntax.help')}
                            title={t('components.searchSyntax.help')}
                        >
                            <Info size={18} aria-hidden="true" />
                        </button>
                        <div id={inputContainerId} className="min-w-0 flex-1">
                            {children}
                        </div>
                    </div>
                )}
                <button
                    type="button"
                    onClick={() => {
                        if (!forceExpanded) setExpanded((current) => !current);
                    }}
                    className={`inline-flex shrink-0 items-center justify-center border border-gray-300 bg-white px-3 text-gray-600 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 ${controlSize} ${toggleShapeClassName}`}
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
                    className={`min-w-0 ${stacked ? 'order-last w-full sm:order-none sm:ml-13 sm:w-auto' : 'ml-13'}`}
                    data-search-controls-footer="true"
                >
                    {footer}
                </div>
            )}
        </div>
    );
}
