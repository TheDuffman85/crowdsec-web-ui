import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DangerZoneSettings } from '../DangerZoneSettings';
import { I18nContext, type I18nContextValue } from '../../lib/i18n';
import { sessionFetch } from '../../lib/sessionFetch';
import en from '../../locales/en.json';

vi.mock('../../lib/sessionFetch', () => ({ sessionFetch: vi.fn() }));
const i18n: I18nContextValue = { language: 'en', preference: 'en', browserLanguage: 'en', setLanguagePreference: () => {}, t: (key) => (en as Record<string, string>)[key] || key };

function mount(props: Partial<Parameters<typeof DangerZoneSettings>[0]> = {}) {
  const showToast = vi.fn();
  render(<I18nContext.Provider value={i18n}>
    <DangerZoneSettings canDeleteCache canDeleteStatistics showStatistics showToast={showToast} {...props} />
  </I18nContext.Provider>);
  return showToast;
}
afterEach(() => { vi.clearAllMocks(); });

describe('Danger zone', () => {
  test('lists deleting the cache before deleting statistics', () => {
    mount();
    expect(screen.getByRole('heading', { name: 'Danger Zone' })).toBeInTheDocument();
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Delete cache', 'Delete all statistics']);
  });

  test('deletes the cache only after confirmation', async () => {
    vi.mocked(sessionFetch).mockResolvedValue(Response.json({ success: true }));
    const showToast = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Delete cache' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete the cache?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sessionFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete cache' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete cache' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('The cache was deleted and synced again.', 'success'));
    expect(sessionFetch).toHaveBeenCalledWith('/api/cache/clear', { method: 'POST' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('deletes all statistics after confirmation and keeps the dialog open on failure', async () => {
    vi.mocked(sessionFetch).mockResolvedValueOnce(Response.json({ error: 'Statistics could not be deleted' }, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ success: true }));
    const showToast = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Delete all statistics' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/permanently deletes all collected statistics/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete all statistics' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Statistics could not be deleted', 'danger'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete all statistics' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('All statistics were deleted.', 'success'));
    expect(sessionFetch).toHaveBeenLastCalledWith('/api/statistics', { method: 'DELETE' });
  });

  test('disables actions without permission and hides statistics without an archive', () => {
    mount({ canDeleteCache: false, showStatistics: false });
    expect(screen.getByRole('button', { name: 'Delete cache' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Delete all statistics' })).not.toBeInTheDocument();
  });
});
