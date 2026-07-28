import { act, createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { BackToTop } from '../BackToTop';

describe('BackToTop', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('appears only after the header leaves above the visible area and scrolls its container', () => {
    let notifyIntersection!: IntersectionObserverCallback;
    let observerOptions: IntersectionObserverInit | undefined;

    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        notifyIntersection = callback;
        observerOptions = options;
      }

      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    });

    const headerRef = createRef<HTMLTableSectionElement>();
    const scrollTo = vi.fn();
    const { container } = render(
      <div data-scroll-container>
        <table>
          <thead ref={headerRef}>
            <tr><th>Header</th></tr>
          </thead>
        </table>
        <BackToTop visibilityTargetRef={headerRef} />
      </div>,
    );
    const scrollContainer = container.querySelector<HTMLElement>('[data-scroll-container]');
    Object.defineProperty(scrollContainer, 'scrollTo', { value: scrollTo });

    expect(observerOptions).toMatchObject({
      root: scrollContainer,
      rootMargin: '-64px 0px 0px 0px',
      threshold: 0,
    });
    expect(screen.queryByRole('button', { name: 'Back to top' })).not.toBeInTheDocument();

    act(() => {
      notifyIntersection([{
        isIntersecting: false,
        boundingClientRect: { top: 40 },
        rootBounds: { top: 64 },
      } as IntersectionObserverEntry], {} as IntersectionObserver);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Back to top' }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });

    act(() => {
      notifyIntersection([{
        isIntersecting: false,
        boundingClientRect: { top: 100 },
        rootBounds: { top: 64 },
      } as IntersectionObserverEntry], {} as IntersectionObserver);
    });

    expect(screen.queryByRole('button', { name: 'Back to top' })).not.toBeInTheDocument();
  });
});
