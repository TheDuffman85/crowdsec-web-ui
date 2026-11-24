import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, test } from 'vitest';
import { CommandPalette } from '../CommandPalette';
import { NAVIGATION_TARGETS } from '../../lib/commandPalette';

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function renderPalette() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <CommandPalette />
      <input aria-label="Page field" />
      <Location />
    </MemoryRouter>,
  );
}

const openPalette = () => fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

describe('CommandPalette', () => {
  test('opens with Ctrl+K, filters pages and navigates on Enter', async () => {
    const user = userEvent.setup();
    renderPalette();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    openPalette();
    const input = await screen.findByRole('textbox', { name: 'Command palette' });
    expect(input).toHaveFocus();
    expect(screen.getAllByRole('option')).toHaveLength(NAVIGATION_TARGETS.length);

    await user.type(input, 'decis');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Decisionsg b',
      'Search alerts for "decis"',
      'Search decisions for "decis"',
    ]);
    await user.keyboard('{Enter}');

    expect(screen.getByTestId('location')).toHaveTextContent('/decisions');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('searches alerts for an IP with the arrow keys', async () => {
    const user = userEvent.setup();
    renderPalette();
    openPalette();
    const input = await screen.findByRole('textbox', { name: 'Command palette' });
    await user.type(input, '203.0.113.9');
    expect(screen.getByRole('option', { name: 'Look up 203.0.113.9 in decisions' })).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByTestId('location')).toHaveTextContent('/decisions?q=203.0.113.9');
  });

  test('closes on Ctrl+K again and with Escape', async () => {
    renderPalette();
    openPalette();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    openPalette();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    openPalette();
    await screen.findByRole('dialog');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('g then a letter jumps to a page, but not while typing in a field', async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.keyboard('ga');
    expect(screen.getByTestId('location')).toHaveTextContent('/alerts');

    await user.keyboard('g');
    await user.keyboard('x');
    expect(screen.getByTestId('location')).toHaveTextContent('/alerts');

    await user.click(screen.getByRole('textbox', { name: 'Page field' }));
    await user.keyboard('gs');
    expect(screen.getByTestId('location')).toHaveTextContent('/alerts');
  });
});
