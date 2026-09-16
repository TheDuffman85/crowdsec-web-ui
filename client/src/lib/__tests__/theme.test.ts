import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useTheme } from '../theme';

type Listener = (event: { matches: boolean }) => void;

function stubMatchMedia(matches: boolean) {
  const listeners = new Set<Listener>();
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches,
    addEventListener: (_: string, cb: Listener) => listeners.add(cb),
    removeEventListener: (_: string, cb: Listener) => listeners.delete(cb),
  }));
  return (next: boolean) => listeners.forEach((cb) => cb({ matches: next }));
}

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('defaults to system and follows the OS preference live', () => {
    const emit = stubMatchMedia(true);
    const { result } = renderHook(() => useTheme());

    expect(result.current[0]).toBe('system');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    act(() => emit(false));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  test('explicit mode ignores the OS preference and is persisted', () => {
    const emit = stubMatchMedia(true);
    const { result } = renderHook(() => useTheme());

    act(() => result.current[1]('light'));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('theme')).toBe('light');

    act(() => emit(true));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  test('restores a saved mode', () => {
    stubMatchMedia(false);
    localStorage.setItem('theme', 'dark');
    const { result } = renderHook(() => useTheme());

    expect(result.current[0]).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
