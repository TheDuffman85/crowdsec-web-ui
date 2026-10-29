import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface TabItem<T extends string> {
    id: T;
    label: string;
    icon?: LucideIcon;
}

interface TabsProps<T extends string> {
    idPrefix: string;
    label: string;
    tabs: TabItem<T>[];
    value: T;
    onChange: (value: T) => void;
}

function tabId(idPrefix: string, id: string) {
    return `${idPrefix}-tab-${id}`;
}

function tabPanelId(idPrefix: string, id: string) {
    return `${idPrefix}-panel-${id}`;
}

export function Tabs<T extends string>({ idPrefix, label, tabs, value, onChange }: TabsProps<T>) {
    const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

    // Arrow keys, Home and End move between tabs, following the WAI-ARIA tabs pattern.
    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const index = tabs.findIndex((tab) => tab.id === value);
        let nextIndex: number;
        switch (event.key) {
            case 'ArrowRight':
                nextIndex = (index + 1) % tabs.length;
                break;
            case 'ArrowLeft':
                nextIndex = (index - 1 + tabs.length) % tabs.length;
                break;
            case 'Home':
                nextIndex = 0;
                break;
            case 'End':
                nextIndex = tabs.length - 1;
                break;
            default:
                return;
        }
        event.preventDefault();
        const next = tabs[nextIndex];
        onChange(next.id);
        tabRefs.current[next.id]?.focus();
    };

    return (
        <div
            role="tablist"
            aria-label={label}
            onKeyDown={handleKeyDown}
            // The bottom line is an inset shadow rather than a border, so the active tab's underline can
            // cover it without overflowing the list, which would show a scrollbar. Narrow screens can
            // still scroll the tabs sideways, without a visible scrollbar.
            className="flex gap-1 overflow-x-auto shadow-[inset_0_-1px_0_var(--color-gray-200)] [scrollbar-width:none] dark:shadow-[inset_0_-1px_0_var(--color-gray-700)] [&::-webkit-scrollbar]:hidden"
        >
            {tabs.map((tab) => {
                const selected = tab.id === value;
                const Icon = tab.icon;
                return (
                    <button
                        key={tab.id}
                        ref={(element) => { tabRefs.current[tab.id] = element; }}
                        id={tabId(idPrefix, tab.id)}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        aria-controls={tabPanelId(idPrefix, tab.id)}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => onChange(tab.id)}
                        className={cn(
                            "inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500",
                            selected
                                ? "border-primary-600 text-primary-700 dark:border-primary-400 dark:text-primary-300"
                                : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:border-gray-600 dark:hover:text-gray-200",
                        )}
                    >
                        {Icon && <Icon className="h-4 w-4" aria-hidden="true" />}
                        {tab.label}
                    </button>
                );
            })}
        </div>
    );
}

export function TabPanel({ idPrefix, id, children }: { idPrefix: string; id: string; children: ReactNode }) {
    return (
        <div role="tabpanel" id={tabPanelId(idPrefix, id)} aria-labelledby={tabId(idPrefix, id)}>
            {children}
        </div>
    );
}
