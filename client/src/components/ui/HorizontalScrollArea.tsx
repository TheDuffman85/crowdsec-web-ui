import { useEffect, useRef, useState, type PropsWithChildren } from 'react';

interface HiddenContent {
    start: boolean;
    end: boolean;
    /** Width of a pinned last column, which the end fade has to stay clear of. */
    endInset: number;
}

const FADE_CLASS_NAME = 'pointer-events-none absolute inset-y-0 z-20 w-8 from-gray-900/10 to-transparent transition-opacity duration-150 dark:from-black/30';

// Fades the edges that have more content past them, because the scrollbar of a long table
// is usually far below the visible rows. Offsets are absolute since scrollLeft is negative
// in right-to-left layouts.
export function HorizontalScrollArea({ children }: PropsWithChildren) {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const [hidden, setHidden] = useState<HiddenContent>({ start: false, end: false, endInset: 0 });

    useEffect(() => {
        const scroller = scrollerRef.current;
        if (!scroller) return undefined;

        const update = () => {
            const offset = Math.abs(scroller.scrollLeft);
            const pinnedColumn = scroller.querySelector('thead th:last-child');
            const next: HiddenContent = {
                start: offset > 1,
                end: scroller.scrollWidth - scroller.clientWidth - offset > 1,
                endInset: pinnedColumn && getComputedStyle(pinnedColumn).position === 'sticky'
                    ? pinnedColumn.getBoundingClientRect().width
                    : 0,
            };
            setHidden((current) => (
                current.start === next.start && current.end === next.end && current.endInset === next.endInset
                    ? current
                    : next
            ));
        };

        update();
        scroller.addEventListener('scroll', update, { passive: true });
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
        observer?.observe(scroller);
        if (scroller.firstElementChild) observer?.observe(scroller.firstElementChild);

        return () => {
            scroller.removeEventListener('scroll', update);
            observer?.disconnect();
        };
    }, []);

    return (
        <div className="relative">
            <div ref={scrollerRef} className="overflow-x-auto">
                {children}
            </div>
            <div
                aria-hidden="true"
                data-testid="scroll-fade-start"
                className={`${FADE_CLASS_NAME} start-0 bg-gradient-to-r rtl:bg-gradient-to-l ${hidden.start ? 'opacity-100' : 'opacity-0'}`}
            />
            <div
                aria-hidden="true"
                data-testid="scroll-fade-end"
                style={{ insetInlineEnd: hidden.endInset }}
                className={`${FADE_CLASS_NAME} bg-gradient-to-l rtl:bg-gradient-to-r ${hidden.end ? 'opacity-100' : 'opacity-0'}`}
            />
        </div>
    );
}
