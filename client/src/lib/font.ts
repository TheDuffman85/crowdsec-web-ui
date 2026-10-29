import { createContext, useContext } from 'react';
import type { SupportedLanguage } from './i18n';

export const FONT_SETTING_KEY = 'font';
export const SYSTEM_FONT_SETTING = 'system';
export const AUTO_FONT_SETTING = 'auto';

// Tailwind's default sans stack. It stays behind the selected font so missing glyphs still render.
const SYSTEM_FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', 'Noto Sans', Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'";

export const FONT_PRESETS = [
  {
    id: 'ibm-plex-sans',
    label: 'IBM Plex Sans',
    family: 'IBM Plex Sans',
    load: () => Promise.all([
      import('@fontsource/ibm-plex-sans/400.css'),
      import('@fontsource/ibm-plex-sans/500.css'),
      import('@fontsource/ibm-plex-sans/600.css'),
      import('@fontsource/ibm-plex-sans/700.css'),
    ]),
  },
  {
    id: 'ibm-plex-sans-kr',
    label: 'IBM Plex Sans KR',
    family: 'IBM Plex Sans KR',
    load: () => Promise.all([
      import('@fontsource/ibm-plex-sans-kr/400.css'),
      import('@fontsource/ibm-plex-sans-kr/500.css'),
      import('@fontsource/ibm-plex-sans-kr/600.css'),
      import('@fontsource/ibm-plex-sans-kr/700.css'),
    ]),
  },
  {
    id: 'ibm-plex-sans-jp',
    label: 'IBM Plex Sans JP',
    family: 'IBM Plex Sans JP',
    load: () => Promise.all([
      import('@fontsource/ibm-plex-sans-jp/400.css'),
      import('@fontsource/ibm-plex-sans-jp/500.css'),
      import('@fontsource/ibm-plex-sans-jp/600.css'),
      import('@fontsource/ibm-plex-sans-jp/700.css'),
    ]),
  },
  {
    id: 'ibm-plex-sans-arabic',
    label: 'IBM Plex Sans Arabic',
    family: 'IBM Plex Sans Arabic',
    load: () => Promise.all([
      import('@fontsource/ibm-plex-sans-arabic/400.css'),
      import('@fontsource/ibm-plex-sans-arabic/500.css'),
      import('@fontsource/ibm-plex-sans-arabic/600.css'),
      import('@fontsource/ibm-plex-sans-arabic/700.css'),
    ]),
  },
  {
    id: 'ibm-plex-sans-devanagari',
    label: 'IBM Plex Sans Devanagari',
    family: 'IBM Plex Sans Devanagari',
    load: () => Promise.all([
      import('@fontsource/ibm-plex-sans-devanagari/400.css'),
      import('@fontsource/ibm-plex-sans-devanagari/500.css'),
      import('@fontsource/ibm-plex-sans-devanagari/600.css'),
      import('@fontsource/ibm-plex-sans-devanagari/700.css'),
    ]),
  },
  {
    id: 'noto-sans-sc',
    label: 'Noto Sans SC',
    family: 'Noto Sans SC Variable',
    load: () => import('@fontsource-variable/noto-sans-sc'),
  },
] as const;

export type FontPreset = (typeof FONT_PRESETS)[number];
export type FontPresetId = FontPreset['id'];
export type FontPreference = FontPresetId | typeof SYSTEM_FONT_SETTING | typeof AUTO_FONT_SETTING;

const LANGUAGE_FONTS: Record<SupportedLanguage, FontPresetId> = {
  ar: 'ibm-plex-sans-arabic',
  de: 'ibm-plex-sans',
  en: 'ibm-plex-sans',
  es: 'ibm-plex-sans',
  fr: 'ibm-plex-sans',
  hi: 'ibm-plex-sans-devanagari',
  ja: 'ibm-plex-sans-jp',
  ko: 'ibm-plex-sans-kr',
  pt: 'ibm-plex-sans',
  ru: 'ibm-plex-sans',
  zh: 'noto-sans-sc',
};

const presetsById = new Map<string, FontPreset>(FONT_PRESETS.map((preset) => [preset.id, preset]));
const loadPromises = new Map<FontPresetId, Promise<void>>();

export function normalizeFontPreference(value: string | null | undefined): FontPreference {
  if (value === AUTO_FONT_SETTING) return AUTO_FONT_SETTING;
  return value && presetsById.has(value) ? value as FontPresetId : SYSTEM_FONT_SETTING;
}

export function resolveFontPreset(
  preference: FontPreference,
  language: SupportedLanguage,
): FontPreset | null {
  if (preference === SYSTEM_FONT_SETTING) return null;
  const id = preference === AUTO_FONT_SETTING ? LANGUAGE_FONTS[language] : preference;
  return presetsById.get(id) ?? null;
}

export function getFontStack(preset: FontPreset | null): string {
  return preset ? `'${preset.family}', ${SYSTEM_FONT_STACK}` : SYSTEM_FONT_STACK;
}

export function loadFontPreset(preset: FontPreset): Promise<void> {
  const existing = loadPromises.get(preset.id);
  if (existing) return existing;

  const promise = preset.load().then(() => undefined);
  promise.catch(() => loadPromises.delete(preset.id));
  loadPromises.set(preset.id, promise);
  return promise;
}

export function applyFontPreset(preset: FontPreset | null): void {
  const root = document.documentElement;
  if (preset) {
    root.style.setProperty('--font-sans', getFontStack(preset));
  } else {
    root.style.removeProperty('--font-sans');
  }
}

export function getStoredFontPreference(): FontPreference {
  if (typeof window === 'undefined') return SYSTEM_FONT_SETTING;
  return normalizeFontPreference(localStorage.getItem(FONT_SETTING_KEY));
}

export type FontContextValue = {
  preference: FontPreference;
  /** Saves the preference for the signed-in user too, unless `sync` is false. */
  setFontPreference: (preference: FontPreference, options?: { sync?: boolean }) => void;
};

export const FontContext = createContext<FontContextValue>({
  preference: SYSTEM_FONT_SETTING,
  setFontPreference: () => undefined,
});

export function useFont() {
  return useContext(FontContext);
}
