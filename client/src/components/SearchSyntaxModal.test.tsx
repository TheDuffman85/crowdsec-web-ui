import { render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { getSearchHelpDefinition } from '../../../shared/search';
import { SearchSyntaxModal } from './SearchSyntaxModal';

describe('SearchSyntaxModal', () => {
  test('renders search examples with syntax highlighting while preserving accessible text', () => {
    render(
      <SearchSyntaxModal
        help={getSearchHelpDefinition('decisions', { machineEnabled: true, originEnabled: true })}
        searchFeatures={{ machineEnabled: true, originEnabled: true }}
        isOpen
        onClose={vi.fn()}
      />,
    );

    const exampleButton = screen.getByRole('button', { name: /status:active AND action:ban/i });
    const highlightedExample = within(exampleButton).getByText('status').closest('[data-search-highlight-layer="true"]');

    expect(highlightedExample).not.toBeNull();
    expect(highlightedExample?.querySelector('[data-search-highlight-kind="field"]')).toHaveTextContent('status');
    expect(highlightedExample?.querySelector('[data-search-highlight-kind="booleanOperator"]')).toHaveTextContent('AND');
  });
});
