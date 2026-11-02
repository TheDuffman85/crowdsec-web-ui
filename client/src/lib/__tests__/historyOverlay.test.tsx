import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { MemoryRouter, Route, Router, Routes, useLocation, useNavigate, type Location, type NavigateFunction, type Navigator, type To } from 'react-router-dom';
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

// A router whose navigations stay queued until the test lands them, as they do while React
// has not committed them yet, so a test can decide the order they arrive in.
function renderOverlayWithQueuedNavigation() {
  const entries: Location[] = [{ pathname: '/page', search: '', hash: '', state: null, key: 'initial' }];
  const queue: Array<() => void> = [];
  let index = 0;
  let nextKey = 0;

  function QueuedRouter() {
    const [location, setLocation] = useState(entries[0]);
    const [navigator] = useState<Navigator>(() => ({
      createHref: (to: To) => String(to),
      go: (delta) => {
        queue.push(() => {
          index += delta;
          setLocation(entries[index]);
        });
      },
      push: (to, state) => {
        queue.push(() => {
          index += 1;
          entries.splice(index, entries.length, { ...entries[0], ...(to as object), state, key: `pushed-${nextKey += 1}` });
          setLocation(entries[index]);
        });
      },
      replace: () => {
        throw new Error('This overlay should pop the entry it pushed');
      },
    }));
    return <Router location={location} navigator={navigator}><Overlay name="dialog" /></Router>;
  }

  render(<QueuedRouter />);
  const land = () => {
    act(() => queue.shift()!());
  };
  return { land };
}

describe('useHistoryBackedOverlay', () => {
  test('stays open when reopened before its own close has landed', async () => {
    const { land } = renderOverlayWithQueuedNavigation();
    await userEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
    land();

    await userEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByText('dialog is open')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open dialog' }));

    // The close lands first and must not count as the user leaving the reopened overlay.
    land();
    expect(screen.getByText('dialog is open')).toBeInTheDocument();
    land();
    expect(screen.getByText('dialog is open')).toBeInTheDocument();

    // Once the push has landed, the overlay is tracked as usual again.
    await userEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    land();
    expect(screen.queryByText('dialog is open')).not.toBeInTheDocument();
  });

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
