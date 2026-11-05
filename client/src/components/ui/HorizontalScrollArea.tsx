import { useEffect, useRef, useState, type PropsWithChildren } from 'react';

interface HiddenContent {
    start: boolean;
    end: boolean;
    /** Width of a pinned last column, which the end fade has to stay clear of. */
    endInset: number;
}

const FADE_CLASS_NAME = 'pointer-events-none absolute inset-y-0 z-20 w-8 from-gray-900/10 to-transparent transition-opacity duration-150 dark:from-black/30';

// The scrollbar of a long table would sit far below the visible rows, so the native one is
// replaced by a mirrored scrollbar that sticks to the bottom of the page's scroll container
// and rests below the table once its end is reached. Sticking needs every ancestor up to that
// container to leave overflow visible or clipped: overflow-hidden would capture it.
// The edges with more content past them fade as well. Offsets are absolute since scrollLeft
// is negative in right-to-left layouts.
export function HorizontalScrollArea({ children }: PropsWithChildren) {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const scrollbarRef = useRef<HTMLDivElement>(null);
    const scrollbarContentRef = useRef<HTMLDivElement>(null);
    const [hidden, setHidden] = useState<HiddenContent>({ start: false, end: false, endInset: 0 });

    useEffect(() => {
        const scroller = scrollerRef.current;
        const scrollbar = scrollbarRef.current;
        const scrollbarContent = scrollbarContentRef.current;
        if (!scroller || !scrollbar || !scrollbarContent) return undefined;

        // A write to one side fires a scroll event on it a frame later, by when a touch scroll has
        // moved on. Following that echo would pull the scroll back to an old position and break up
        // the gesture, so each side ignores the position that was set on it by the other.
        let positionSetOnScroller: number | null = null;
        let positionSetOnScrollbar: number | null = null;

        const syncScrollbar = () => {
            const position = scroller.scrollLeft;
            if (position === positionSetOnScroller) return;
            positionSetOnScroller = null;
            if (scrollbar.scrollLeft !== position) {
                scrollbar.scrollLeft = position;
                positionSetOnScrollbar = scrollbar.scrollLeft;
            }
        };
        const syncScroller = () => {
            const position = scrollbar.scrollLeft;
            if (position === positionSetOnScrollbar) return;
            positionSetOnScrollbar = null;
            if (scroller.scrollLeft !== position) {
                scroller.scrollLeft = position;
                positionSetOnScroller = scroller.scrollLeft;
            }
        };

        let maxOffset = 0;
        let endInset = 0;

        const updateHidden = () => {
            const offset = Math.abs(scroller.scrollLeft);
            const next: HiddenContent = {
                start: offset > 1,
                end: maxOffset - offset > 1,
                endInset,
            };
            setHidden((current) => (
                current.start === next.start && current.end === next.end && current.endInset === next.endInset
                    ? current
                    : next
            ));
        };

        const onScroll = () => {
            syncScrollbar();
            updateHidden();
        };

        // The sizes only change with a resize, so scrolling does not have to read them.
        const updateSizes = () => {
            const contentWidth = `${scroller.scrollWidth}px`;
            if (scrollbarContent.style.width !== contentWidth) scrollbarContent.style.width = contentWidth;
            maxOffset = scroller.scrollWidth - scroller.clientWidth;

            const pinnedColumn = scroller.querySelector('thead th:last-child');
            endInset = pinnedColumn && getComputedStyle(pinnedColumn).position === 'sticky'
                ? pinnedColumn.getBoundingClientRect().width
                : 0;
            onScroll();
        };

        updateSizes();
        scroller.addEventListener('scroll', onScroll, { passive: true });
        scrollbar.addEventListener('scroll', syncScroller, { passive: true });
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateSizes);
        observer?.observe(scroller);
        if (scroller.firstElementChild) observer?.observe(scroller.firstElementChild);

        return () => {
            scroller.removeEventListener('scroll', onScroll);
            scrollbar.removeEventListener('scroll', syncScroller);
            observer?.disconnect();
        };
    }, []);

    return (
        <div className="relative">
            <div ref={scrollerRef} data-horizontal-scroller className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
            {/* The minimum height leaves overlay scrollbars, which take up no space, room to show. */}
            <div
                ref={scrollbarRef}
                aria-hidden="true"
                tabIndex={-1}
                data-testid="scroll-scrollbar"
                className={`sticky bottom-0 z-20 min-h-3 overflow-x-auto overflow-y-hidden ${hidden.start || hidden.end ? '' : 'hidden'}`}
            >
                <div ref={scrollbarContentRef} className="h-px" />
            </div>
        </div>
    );
}
