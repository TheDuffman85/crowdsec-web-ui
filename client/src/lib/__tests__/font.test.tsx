import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { FontProvider } from '../FontProvider';
import {
  FONT_PRESETS,
  getFontStack,
  loadFontPreset,
  normalizeFontPreference,
  resolveFontPreset,
  useFont,
  type FontContextValue,
  type FontPreset,
} from '../font';
import { I18nContext, type I18nContextValue, type SupportedLanguage } from '../i18n';

function i18nValue(language: SupportedLanguage): I18nContextValue {
  return {
    language,
    preference: language,
    browserLanguage: language,
    setLanguagePreference: () => undefined,
    t: (key) => key,
  };
}

function rootFont() {
  return document.documentElement.style.getPropertyValue('--font-sans');
}

describe('font presets', () => {
  test('normalizes stored preferences', () => {
    expect(normalizeFontPreference('ibm-plex-sans-jp')).toBe('ibm-plex-sans-jp');
    expect(normalizeFontPreference('auto')).toBe('auto');
    expect(normalizeFontPreference('Comic Sans')).toBe('system');
    expect(normalizeFontPreference(null)).toBe('system');
  });

  test('matches each language to its preset when set to auto', () => {
    expect(resolveFontPreset('auto', 'ko')?.family).toBe('IBM Plex Sans KR');
    expect(resolveFontPreset('auto', 'ja')?.family).toBe('IBM Plex Sans JP');
    expect(resolveFontPreset('auto', 'ar')?.family).toBe('IBM Plex Sans Arabic');
    expect(resolveFontPreset('auto', 'hi')?.family).toBe('IBM Plex Sans Devanagari');
    expect(resolveFontPreset('auto', 'zh')?.family).toBe('Noto Sans SC Variable');
    expect(resolveFontPreset('auto', 'ru')?.family).toBe('IBM Plex Sans');
    expect(resolveFontPreset('ibm-plex-sans-kr', 'de')?.family).toBe('IBM Plex Sans KR');
    expect(resolveFontPreset('system', 'ko')).toBeNull();
  });

  test('keeps the system stack behind the selected family', () => {
    const stack = getFontStack(FONT_PRESETS[0]);
    expect(stack.startsWith("'IBM Plex Sans', ")).toBe(true);
    expect(stack.endsWith(getFontStack(null))).toBe(true);
  });

  test('reuses a pending load and retries after a failure', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('chunk missing'))
      .mockResolvedValue([]);
    const preset = { id: 'retry-test', label: 'Retry', family: 'Retry', load } as unknown as FontPreset;

    await expect(loadFontPreset(preset)).rejects.toThrow('chunk missing');
    const first = loadFontPreset(preset);
    expect(loadFontPreset(preset)).toBe(first);
    await first;
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('FontProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty('--font-sans');
  });

  test('leaves the Tailwind font untouched by default', () => {
    render(
      <I18nContext.Provider value={i18nValue('ko')}>
        <FontProvider><span /></FontProvider>
      </I18nContext.Provider>,
    );

    expect(rootFont()).toBe('');
  });

  test('follows the interface language in auto mode and persists changes', () => {
    localStorage.setItem('font', 'auto');
    const font: { current: FontContextValue | null } = { current: null };
    function Probe() {
      font.current = useFont();
      return null;
    }

    const { rerender } = render(
      <I18nContext.Provider value={i18nValue('ko')}>
        <FontProvider><Probe /></FontProvider>
      </I18nContext.Provider>,
    );
    expect(rootFont()).toContain('IBM Plex Sans KR');

    rerender(
      <I18nContext.Provider value={i18nValue('ja')}>
        <FontProvider><Probe /></FontProvider>
      </I18nContext.Provider>,
    );
    expect(rootFont()).toContain('IBM Plex Sans JP');

    act(() => font.current?.setFontPreference('system'));
    expect(rootFont()).toBe('');
    expect(localStorage.getItem('font')).toBe('system');
  });
});
