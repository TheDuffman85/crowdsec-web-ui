import { ArrowUp } from "lucide-react";
import { useEffect, useState, type RefObject } from "react";
import { useI18n } from "../lib/i18n";

interface BackToTopProps {
    visibilityTargetRef: RefObject<HTMLElement | null>;
}

export function BackToTop({ visibilityTargetRef }: BackToTopProps) {
    const { t } = useI18n();
    const [showButton, setShowButton] = useState(false);

    useEffect(() => {
        const visibilityTarget = visibilityTargetRef.current;
        if (!visibilityTarget) return;

        const scrollContainer = visibilityTarget.closest<HTMLElement>('[data-scroll-container]');
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) {
                setShowButton(false);
                return;
            }

            const visibleTop = entry.rootBounds?.top ?? 0;
            setShowButton(entry.boundingClientRect.top < visibleTop);
        }, {
            root: scrollContainer,
            rootMargin: '-64px 0px 0px 0px',
            threshold: 0,
        });

        observer.observe(visibilityTarget);
        return () => observer.disconnect();
    }, [visibilityTargetRef]);

    if (!showButton) return null;

    const scrollToTop = () => {
        const scrollContainer = visibilityTargetRef.current?.closest<HTMLElement>('[data-scroll-container]');
        const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

        if (scrollContainer) {
            scrollContainer.scrollTo({ top: 0, behavior });
        } else {
            window.scrollTo({ top: 0, behavior });
        }
    };

    return (
        <button
            type="button"
            onClick={scrollToTop}
            className="fixed bottom-4 right-4 z-40 inline-flex h-11 w-11 items-center justify-center rounded-full bg-primary-600 text-white shadow-lg transition-colors hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 dark:focus:ring-offset-gray-950 sm:bottom-6 sm:right-6"
            aria-label={t('common.backToTop')}
            title={t('common.backToTop')}
        >
            <ArrowUp size={20} aria-hidden="true" />
        </button>
    );
}
