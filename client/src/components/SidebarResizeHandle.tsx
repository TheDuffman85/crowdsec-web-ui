import type { KeyboardEvent, PointerEvent } from 'react';
import { useI18n } from '../lib/i18n';

interface SidebarResizeHandleProps {
    width: number;
    minWidth: number;
    maxWidth: number;
    onResize: (width: number) => void;
    onReset: () => void;
    onResizingChange: (resizing: boolean) => void;
}

export function SidebarResizeHandle({
    width,
    minWidth,
    maxWidth,
    onResize,
    onReset,
    onResizingChange,
}: SidebarResizeHandleProps) {
    const { t } = useI18n();

    const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        onResizingChange(true);
    };

    const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        onResize(event.clientX);
    };

    const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        onResizingChange(false);
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const step = event.shiftKey ? 64 : 16;
        if (event.key === 'ArrowLeft') onResize(width - step);
        else if (event.key === 'ArrowRight') onResize(width + step);
        else if (event.key === 'Home') onResize(minWidth);
        else if (event.key === 'End') onResize(maxWidth);
        else return;
        event.preventDefault();
    };

    return (
        <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t('components.sidebar.resize')}
            aria-valuemin={minWidth}
            aria-valuemax={maxWidth}
            aria-valuenow={width}
            tabIndex={0}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            onDoubleClick={onReset}
            onKeyDown={handleKeyDown}
            className="group fixed inset-y-0 z-[10000] hidden w-2 -translate-x-1/2 cursor-col-resize touch-none outline-none lg:block"
            style={{ left: width }}
        >
            <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-transparent transition-colors group-hover:bg-primary-400 group-focus-visible:bg-primary-500 group-active:bg-primary-500" />
        </div>
    );
}
