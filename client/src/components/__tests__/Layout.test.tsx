import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Layout } from '../Layout';

vi.mock('../Sidebar', () => ({
  Sidebar: ({ isOpen, onToggle }: { isOpen: boolean; onToggle: () => void }) => (
    <button onClick={onToggle}>{isOpen ? 'Sidebar open' : 'Sidebar closed'}</button>
  ),
}));

vi.mock('../BackToTop', () => ({ BackToTop: () => null }));

vi.mock('../../contexts/useToast', () => ({
  useToast: () => ({ toasts: [], removeToast: vi.fn() }),
}));

vi.mock('../../lib/theme', () => ({
  useTheme: () => ['light', vi.fn()],
}));

function LocationState() {
  return <p data-testid="location-state">{JSON.stringify(useLocation().state)}</p>;
}

function renderLayout(initialEntries: Parameters<typeof MemoryRouter>[0]['initialEntries'] = ['/']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<LocationState />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('Layout sidebar state', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  describe('on mobile', () => {
    beforeEach(() => {
      vi.stubGlobal('innerWidth', 500);
    });

    test('starts closed when no preference is saved', () => {
      renderLayout();

      expect(screen.getByRole('button', { name: 'Sidebar closed' })).toBeInTheDocument();
    });

    test('starts closed even if an open sidebar was saved', () => {
      localStorage.setItem('menuOpen', 'true');

      renderLayout();

      expect(screen.getByRole('button', { name: 'Sidebar closed' })).toBeInTheDocument();
    });

    test('does not remember an opened drawer for the next visit', async () => {
      const user = userEvent.setup();
      const { unmount } = renderLayout();

      await user.click(screen.getByRole('button', { name: 'Open menu' }));
      expect(screen.getByRole('button', { name: 'Sidebar open' })).toBeInTheDocument();
      expect(localStorage.getItem('menuOpen')).toBeNull();
      unmount();

      renderLayout();
      expect(screen.getByRole('button', { name: 'Sidebar closed' })).toBeInTheDocument();
    });

    test('drops a drawer history entry restored with the page', async () => {
      renderLayout([{ pathname: '/', state: { menuOpen: true, other: true } }]);

      expect(screen.getByRole('button', { name: 'Sidebar closed' })).toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId('location-state')).toHaveTextContent('{"other":true}'));
    });
  });

  describe('on desktop', () => {
    beforeEach(() => {
      vi.stubGlobal('innerWidth', 1440);
    });

    test('starts open when no preference is saved', () => {
      renderLayout();

      expect(screen.getByRole('button', { name: 'Sidebar open' })).toBeInTheDocument();
    });

    test('restores and remembers the collapsed preference', async () => {
      const user = userEvent.setup();
      localStorage.setItem('menuOpen', 'false');
      const { unmount } = renderLayout();

      await user.click(screen.getByRole('button', { name: 'Sidebar closed' }));
      expect(localStorage.getItem('menuOpen')).toBe('true');

      await user.click(screen.getByRole('button', { name: 'Sidebar open' }));
      expect(localStorage.getItem('menuOpen')).toBe('false');
      unmount();

      renderLayout();
      expect(screen.getByRole('button', { name: 'Sidebar closed' })).toBeInTheDocument();
    });
  });
});
