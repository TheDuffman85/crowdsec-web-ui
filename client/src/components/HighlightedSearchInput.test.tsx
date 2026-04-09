import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { HighlightedSearchInput } from './HighlightedSearchInput';

describe('HighlightedSearchInput', () => {
  test('renders SQL-like token highlighting for advanced queries', () => {
    render(
      <HighlightedSearchInput
        searchPage="alerts"
        value={'country:"germany" AND ssh'}
        onChange={() => {}}
      />,
    );

    const highlightLayer = document.querySelector('[data-search-highlight-layer="true"]');
    expect(highlightLayer).not.toBeNull();
    expect(highlightLayer?.querySelector('[data-search-highlight-kind="field"]')).toHaveTextContent('country');
    expect(highlightLayer?.querySelector('[data-search-highlight-kind="comparator"]')).toHaveTextContent(':');
    expect(highlightLayer?.querySelector('[data-search-highlight-kind="string"]')).toHaveTextContent('"germany"');
    expect(highlightLayer?.querySelector('[data-search-highlight-kind="booleanOperator"]')).toHaveTextContent('AND');
    expect(highlightLayer?.querySelector('[data-search-highlight-kind="term"]')).toHaveTextContent('ssh');
  });

  test('keeps the real input editable and syncs highlight scrolling', () => {
    const handleChange = vi.fn();
    render(
      <HighlightedSearchInput
        searchPage="decisions"
        placeholder="Filter decisions..."
        value="status:active"
        onChange={handleChange}
      />,
    );

    const input = screen.getByPlaceholderText('Filter decisions...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'status:active AND action:ban' } });
    expect(handleChange).toHaveBeenCalledTimes(1);

    Object.defineProperty(input, 'scrollLeft', {
      configurable: true,
      value: 42,
      writable: true,
    });
    fireEvent.scroll(input);

    const highlightLayer = document.querySelector('[data-search-highlight-layer="true"]') as HTMLDivElement;
    expect(highlightLayer.style.transform).toBe('translateX(-42px)');
  });

  test('marks syntax error ranges inside the mirrored highlight layer', () => {
    render(
      <HighlightedSearchInput
        searchPage="decisions"
        searchFeatures={{ originEnabled: true }}
        value="origin:(manual OR"
        onChange={() => {}}
      />,
    );

    const errorSegments = document.querySelectorAll('[data-search-highlight-error="true"]');
    expect(errorSegments.length).toBeGreaterThan(0);
    expect(screen.getByDisplayValue('origin:(manual OR')).toBeInTheDocument();
  });
});
