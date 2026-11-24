import { describe, expect, test } from 'vitest';
import en from '../../locales/en.json';
import {
  buildPaletteCommands,
  findShortcutTarget,
  isEditableTarget,
  looksLikeIp,
  NAVIGATION_TARGETS,
} from '../commandPalette';

const t = (key: string) => (en as Record<string, string>)[key] ?? key;

describe('command palette helpers', () => {
  test('lists every page when nothing is typed', () => {
    const commands = buildPaletteCommands('', t);
    expect(commands.map((command) => command.path)).toEqual(NAVIGATION_TARGETS.map((target) => target.path));
    expect(commands.filter((command) => command.shortcut)).toHaveLength(NAVIGATION_TARGETS.filter((target) => target.shortcut).length);
  });

  test('filters pages by translated name and adds searches for the typed text', () => {
    const commands = buildPaletteCommands('alert', t);
    expect(commands.map((command) => command.id)).toEqual(['go-alerts', 'search-alerts', 'search-decisions']);
    expect(commands[1]).toMatchObject({ path: '/alerts?q=alert', query: 'alert' });
  });

  test('offers IP lookups for addresses and encodes the query', () => {
    const commands = buildPaletteCommands('203.0.113.9', t);
    expect(commands.map((command) => command.labelKey)).toEqual([
      'components.commandPalette.lookUpIpAlerts',
      'components.commandPalette.lookUpIpDecisions',
    ]);
    expect(buildPaletteCommands('ssh brute&force', t).at(-1)?.path).toBe('/decisions?q=ssh%20brute%26force');
  });

  test('recognises IPv4, IPv6 and ranges', () => {
    expect(looksLikeIp('1.2.3.4')).toBe(true);
    expect(looksLikeIp('1.2.3.0/24')).toBe(true);
    expect(looksLikeIp('2001:db8::1')).toBe(true);
    expect(looksLikeIp('ssh-bf')).toBe(false);
    expect(looksLikeIp('1.2.3')).toBe(false);
  });

  test('maps shortcut letters to pages and ignores form controls', () => {
    expect(findShortcutTarget('A')?.path).toBe('/alerts');
    expect(findShortcutTarget('z')).toBeUndefined();
    expect(isEditableTarget(document.createElement('input'))).toBe(true);
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
    expect(isEditableTarget(document.createElement('div'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  test('shortcut letters are unique', () => {
    const letters = NAVIGATION_TARGETS.map((target) => target.shortcut).filter(Boolean);
    expect(new Set(letters).size).toBe(letters.length);
  });
});
