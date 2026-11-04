import { describe, expect, test } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HorizontalScrollArea } from '../ui/HorizontalScrollArea';

function renderArea(pinned = false) {
  render(
    <HorizontalScrollArea>
      <table>
        <thead>
          <tr>
            <th>First</th>
            <th style={pinned ? { position: 'sticky' } : undefined}>Actions</th>
          </tr>
        </thead>
      </table>
    </HorizontalScrollArea>,
  );
  return screen.getByRole('table').parentElement!;
}

function scrollTo(scroller: HTMLElement, scrollLeft: number, scrollWidth = 1000, clientWidth = 600) {
  Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: clientWidth });
  scroller.scrollLeft = scrollLeft;
  fireEvent.scroll(scroller);
}

function expectFades(start: boolean, end: boolean) {
  expect(screen.getByTestId('scroll-fade-start')).toHaveClass(start ? 'opacity-100' : 'opacity-0');
  expect(screen.getByTestId('scroll-fade-end')).toHaveClass(end ? 'opacity-100' : 'opacity-0');
}

describe('HorizontalScrollArea', () => {
  test('shows no fade when everything fits', () => {
    const scroller = renderArea();

    scrollTo(scroller, 0, 600, 600);

    expectFades(false, false);
  });

  test('fades only the edges with more content past them', () => {
    const scroller = renderArea();

    scrollTo(scroller, 0);
    expectFades(false, true);

    scrollTo(scroller, 200);
    expectFades(true, true);

    scrollTo(scroller, 400);
    expectFades(true, false);
  });

  test('handles the negative offsets of right-to-left layouts', () => {
    const scroller = renderArea();

    scrollTo(scroller, -200);
    expectFades(true, true);

    scrollTo(scroller, -400);
    expectFades(true, false);
  });

  test('keeps the end fade clear of a pinned last column', () => {
    const scroller = renderArea(true);
    screen.getByRole('columnheader', { name: 'Actions' }).getBoundingClientRect = () => ({ width: 136 }) as DOMRect;

    scrollTo(scroller, 0);

    expect(screen.getByTestId('scroll-fade-end').style.insetInlineEnd).toBe('136px');
  });

  test('runs the end fade to the edge without a pinned column', () => {
    const scroller = renderArea();

    scrollTo(scroller, 0);

    expect(screen.getByTestId('scroll-fade-end').style.insetInlineEnd).toBe('0px');
  });

  test('hides the sticky scrollbar when everything fits', () => {
    const scroller = renderArea();

    scrollTo(scroller, 0, 600, 600);

    expect(screen.getByTestId('scroll-scrollbar')).toHaveClass('hidden');
  });

  test('sizes the sticky scrollbar to the scrollable content', () => {
    const scroller = renderArea();

    scrollTo(scroller, 0);

    const scrollbar = screen.getByTestId('scroll-scrollbar');
    expect(scrollbar).not.toHaveClass('hidden');
    expect((scrollbar.firstElementChild as HTMLElement).style.width).toBe('1000px');
  });

  test('keeps the sticky scrollbar and the table in sync', () => {
    const scroller = renderArea();
    const scrollbar = screen.getByTestId('scroll-scrollbar');

    scrollTo(scroller, 200);
    expect(scrollbar.scrollLeft).toBe(200);

    scrollbar.scrollLeft = 350;
    fireEvent.scroll(scrollbar);
    expect(scroller.scrollLeft).toBe(350);
  });
});
