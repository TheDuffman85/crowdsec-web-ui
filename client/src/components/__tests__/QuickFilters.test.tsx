import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest';
import { QuickFilters, type QuickFilterSectionId } from '../QuickFilters';
import * as api from '../../lib/api';
import { I18nContext, type I18nContextValue } from '../../lib/i18n';
import en from '../../locales/en.json';
import type { FacetField } from '../../types';
import type { SearchFacetSelection } from '../../../../shared/search';
import type { SearchDateRange } from '../../../../shared/search';

vi.mock('../../lib/api', () => ({
  fetchFacet: vi.fn(),
}));

const i18n: I18nContextValue = {
  language: 'en',
  preference: 'en',
  browserLanguage: 'en',
  setLanguagePreference: () => undefined,
  t: (key, values = {}) => {
    let message = (en as Record<string, string>)[key] || key;
    for (const [name, value] of Object.entries(values)) {
      message = message.replaceAll(`{${name}}`, String(value ?? ''));
    }
    return message;
  },
};

function renderFilters(
  options: {
    busy?: boolean;
    onSelectionChange?: Mock<(field: FacetField, selection: SearchFacetSelection) => void>;
    onDateRangeChange?: Mock<(range: SearchDateRange) => void>;
    selection?: SearchFacetSelection;
    dateRange?: SearchDateRange;
    sectionOrder?: QuickFilterSectionId[];
  } = {},
) {
  const onSelectionChange = options.onSelectionChange
    || vi.fn<(field: FacetField, selection: SearchFacetSelection) => void>();
  const onDateRangeChange = options.onDateRangeChange
    || vi.fn<(range: SearchDateRange) => void>();
  const result = render(
    <I18nContext.Provider value={i18n}>
      <QuickFilters
        page="alerts"
        fields={[
          { field: 'country', label: 'Country' },
          { field: 'ip', label: 'IP' },
        ]}
        filters={{ q: 'scenario:ssh' }}
        searchAst={null}
        onSelectionChange={onSelectionChange}
        dateRange={options.dateRange ?? { start: '', end: '' }}
        onDateRangeChange={onDateRangeChange}
        getSelection={options.selection ? () => options.selection! : undefined}
        sectionOrder={options.sectionOrder}
        busy={options.busy}
      />
    </I18nContext.Provider>,
  );
  return { ...result, onSelectionChange, onDateRangeChange };
}

describe('QuickFilters', () => {
  beforeEach(() => {
    vi.mocked(api.fetchFacet).mockResolvedValue({
      field: 'country',
      values: [
        { value: 'DE', count: 42 },
        { value: '', count: 3 },
      ],
      offset: 0,
      has_more: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test('does not fetch until the drawer and a group are opened', async () => {
    const user = userEvent.setup();
    const { onSelectionChange } = renderFilters();

    expect(api.fetchFacet).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    expect(api.fetchFacet).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Country' }));
    await waitFor(() => expect(api.fetchFacet).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('DE')).toBeInTheDocument();
    expect(screen.getByText('Empty')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Toggle DE in Country' }));
    expect(onSelectionChange).toHaveBeenCalledWith('country', {
      included: [],
      excluded: ['DE'],
    });

    await user.click(screen.getByRole('button', { name: 'DE' }));
    expect(onSelectionChange).toHaveBeenLastCalledWith('country', {
      included: ['DE'],
      excluded: [],
    });
  });

  test('keeps existing values visible while changed filters refresh in the background', async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    const onDateRangeChange = vi.fn();
    const renderQuickFilters = (filters: Record<string, string>, busy: boolean) => (
      <I18nContext.Provider value={i18n}>
        <QuickFilters
          page="alerts"
          fields={[{ field: 'country', label: 'Country' }]}
          filters={filters}
          searchAst={null}
          onSelectionChange={onSelectionChange}
          dateRange={{ start: '', end: '' }}
          onDateRangeChange={onDateRangeChange}
          busy={busy}
        />
      </I18nContext.Provider>
    );
    const { rerender } = render(renderQuickFilters({ q: 'scenario:ssh' }, false));

    await user.click(screen.getByRole('button', { name: 'Filters' }));
    await user.click(screen.getByRole('button', { name: 'Country' }));
    expect(await screen.findByText('DE')).toBeInTheDocument();

    let resolveRefresh!: (response: Awaited<ReturnType<typeof api.fetchFacet>>) => void;
    vi.mocked(api.fetchFacet).mockImplementationOnce(() => new Promise((resolve) => {
      resolveRefresh = resolve;
    }));

    rerender(renderQuickFilters({ q: 'scenario:ssh AND country:DE' }, true));
    expect(screen.getByText('DE')).toBeInTheDocument();
    expect(screen.queryByText('No values')).not.toBeInTheDocument();

    rerender(renderQuickFilters({ q: 'scenario:ssh AND country:DE' }, false));
    await waitFor(() => expect(api.fetchFacet).toHaveBeenCalledTimes(2));
    expect(screen.getByText('DE')).toBeInTheDocument();
    expect(screen.getByText('Loading values...')).toHaveClass('sr-only');

    await act(async () => {
      resolveRefresh({
        field: 'country',
        values: [{ value: 'US', count: 7 }],
        offset: 0,
        has_more: false,
      });
    });
    await waitFor(() => expect(screen.getByText('US')).toBeInTheDocument());
    expect(screen.queryByText('DE')).not.toBeInTheDocument();
  });

  test('uses the same lazy drawer interaction at desktop widths', async () => {
    const user = userEvent.setup();
    const { rerender } = renderFilters({ busy: true });
    expect(api.fetchFacet).not.toHaveBeenCalled();

    rerender(
      <I18nContext.Provider value={i18n}>
        <QuickFilters
          page="alerts"
          fields={[{ field: 'country', label: 'Country' }]}
          filters={{ q: 'scenario:ssh' }}
          searchAst={null}
          onSelectionChange={vi.fn()}
          dateRange={{ start: '', end: '' }}
          onDateRangeChange={vi.fn()}
          busy={false}
        />
      </I18nContext.Provider>,
    );
    expect(api.fetchFacet).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    expect(api.fetchFacet).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Country' }));
    await waitFor(() => expect(api.fetchFacet).toHaveBeenCalledTimes(1));
  });

  test('closes the drawer with Escape and restores trigger focus', async () => {
    const user = userEvent.setup();
    renderFilters();
    const trigger = screen.getByRole('button', { name: 'Filters' });

    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Quick filters' })).toBeInTheDocument();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(screen.queryByRole('dialog', { name: 'Quick filters' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  test('offers date and time range controls without making a facet request', async () => {
    const user = userEvent.setup();
    const { onDateRangeChange } = renderFilters();

    await user.click(screen.getByRole('button', { name: 'Filters' }));
    await user.click(screen.getByRole('button', { name: 'Date and time' }));
    const from = screen.getByLabelText('From');
    fireEvent.change(from, { target: { value: '2026-03-29T01:30' } });

    expect(api.fetchFacet).not.toHaveBeenCalled();
    expect(onDateRangeChange).toHaveBeenLastCalledWith({
      start: '2026-03-29T01:00',
      end: '',
    });
    expect(from).toHaveAttribute('step', '3600');
  });

  test('orders sections as requested and does not render a date calendar icon', async () => {
    const user = userEvent.setup();
    renderFilters({ sectionOrder: ['ip', 'date', 'country'] });

    await user.click(screen.getByRole('button', { name: 'Filters' }));
    const dialog = screen.getByRole('dialog', { name: 'Quick filters' });
    const sectionButtons = within(dialog).getAllByRole('button').filter((button) => (
      ['IP', 'Date and time', 'Country'].includes(button.textContent || '')
    ));

    expect(sectionButtons.map((button) => button.textContent)).toEqual(['IP', 'Date and time', 'Country']);
    expect(screen.getByRole('button', { name: 'Date and time' }).querySelector('.lucide-calendar-clock')).toBeNull();
  });

  test('shows the same header count and clear control for every active section', async () => {
    const user = userEvent.setup();
    const { onSelectionChange, onDateRangeChange } = renderFilters({
      selection: { included: ['DE'], excluded: [] },
      dateRange: { start: '2026-03-29T01', end: '2026-03-29T03' },
    });

    await user.click(screen.getByRole('button', { name: 'Filters' }));
    const dateSection = screen.getByRole('button', { name: 'Date and time' }).closest('section');
    const countrySection = screen.getByRole('button', { name: 'Country' }).closest('section');
    expect(dateSection).not.toBeNull();
    expect(countrySection).not.toBeNull();
    expect(within(dateSection!).getByText('2')).toBeInTheDocument();
    expect(within(countrySection!).getByText('1')).toBeInTheDocument();

    const clearDate = within(dateSection!).getByRole('button', { name: 'Clear date and time' });
    const clearCountry = within(countrySection!).getByRole('button', { name: 'Clear Country' });
    expect(clearDate.querySelector('.lucide-x')).not.toBeNull();
    expect(clearCountry.querySelector('.lucide-x')).not.toBeNull();
    expect(clearDate).toHaveClass('min-h-11', 'min-w-11');
    expect(clearCountry).toHaveClass('min-h-11', 'min-w-11');

    await user.click(clearDate);
    expect(onDateRangeChange).toHaveBeenLastCalledWith({ start: '', end: '' });

    await user.click(clearCountry);
    expect(onSelectionChange).toHaveBeenLastCalledWith('country', {
      included: [],
      excluded: [],
    });
  });
});
