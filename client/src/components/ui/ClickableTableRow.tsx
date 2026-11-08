import type { ComponentProps } from 'react';

interface ClickableTableRowProps extends Omit<ComponentProps<'tr'>, 'onClick' | 'onKeyDown' | 'onSelect'> {
  onSelect: () => void;
  selected?: boolean;
}

/** Keep table semantics and let embedded controls handle their own interactions. */
export function ClickableTableRow({ onSelect, selected = false, className = '', children, ...props }: ClickableTableRowProps) {
  return (
    <tr
      {...props}
      tabIndex={0}
      aria-selected={selected}
      className={`group cursor-pointer transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary-500 ${selected
        ? 'bg-primary-50 hover:bg-primary-100 dark:bg-primary-900/40 dark:hover:bg-primary-900/50'
        : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'} ${className}`}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('a, button, input, select, textarea, [role="button"]')) return;
        onSelect();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        onSelect();
      }}
    >
      {children}
    </tr>
  );
}
