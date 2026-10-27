import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { describe, expect, test } from 'vitest';
import { useHistoryBackedOverlay } from '../historyOverlay';

function Overlay({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const overlayHistory = useHistoryBackedOverlay(`${name}Open`, () => setOpen(false));

  return (
    <div>
      <button onClick={() => { setOpen(true); overlayHistory.open(); }}>Open {name}</button>
      <button onClick={() => { setOpen(false); overlayHistory.close(); }}>Close {name}</button>
      {open && <p>{name} is open</p>}
    </div>
  );
}

function renderOverlays() {
  const history: { navigate?: NavigateFunction; path?: string; state?: unknown } = {};
  function HistoryProbe() {
    const location = useLocation();
    const navigate = useNavigate();
    useEffect(() => {
      history.navigate = navigate;
      history.path = `${location.pathname}${location.search}`;
      history.state = location.state;
    });
    return null;
  }

  render(
    <MemoryRouter initialEntries={['/', '/page']} initialIndex={1}>
      <HistoryProbe />
      <Routes>
        <Route path="/" element={<p>Home page</p>} />
        <Route path="/page" element={<><Overlay name="drawer" /><Overlay name="dialog" /></>} />
        <Route path="/other" element={<p>Other page</p>} />
      </Routes>
    </MemoryRouter>,
  );

  const goBack = () => {
    act(() => {
      void history.navigate!(-1);
    });
  };
  return { history, goBack };
}

describe('useHistoryBackedOverlay', () => {
  test('closes on Back without leaving the page', async () => {
    const { history, goBack } = renderOverlays();
    await userEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    expect(screen.getByText('drawer is open')).toBeInTheDocument();

    goBack();

    expect(screen.queryByText('drawer is open')).not.toBeInTheDocument();
    expect(history.path).toBe('/page');
    goBack();
    expect(await screen.findByText('Home page')).toBeInTheDocument();
  });

  test('pops its entry when closed directly', async () => {
    const { history, goBack } = renderOverlays();
    await userEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
    expect(history.state).toBeNull();

    goBack();
    expect(await screen.findByText('Home page')).toBeInTheDocument();
  });

  test('stacks overlays opened on top of each other', async () => {
    const { history, goBack } = renderOverlays();
    await userEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    await userEvent.click(screen.getByRole('button', { name: 'Open dialog' }));

    goBack();
    expect(screen.queryByText('dialog is open')).not.toBeInTheDocument();
    expect(screen.getByText('drawer is open')).toBeInTheDocument();

    goBack();
    expect(screen.queryByText('drawer is open')).not.toBeInTheDocument();
    expect(history.path).toBe('/page');
  });

  test('closes and leaves no entry behind when a navigation replaces it', async () => {
    const { history, goBack } = renderOverlays();
    await userEvent.click(screen.getByRole('button', { name: 'Open drawer' }));

    act(() => {
      void history.navigate!('/other', { replace: true });
    });
    expect(await screen.findByText('Other page')).toBeInTheDocument();

    goBack();
    expect(history.path).toBe('/page');
    expect(history.state).toBeNull();
    expect(screen.queryByText('drawer is open')).not.toBeInTheDocument();
    goBack();
    expect(await screen.findByText('Home page')).toBeInTheDocument();
  });

  test('drops its flag instead of popping after the URL was replaced', async () => {
    const { history } = renderOverlays();
    await userEvent.click(screen.getByRole('button', { name: 'Open drawer' }));

    act(() => {
      void history.navigate!('/page?instance=east', { replace: true, state: history.state });
    });
    expect(screen.getByText('drawer is open')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
    expect(history.path).toBe('/page?instance=east');
    expect(history.state).toBeNull();
  });
});
