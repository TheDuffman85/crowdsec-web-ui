import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  FONT_SETTING_KEY,
  FontContext,
  applyFontPreset,
  getStoredFontPreference,
  loadFontPreset,
  normalizeFontPreference,
  resolveFontPreset,
  type FontContextValue,
  type FontPreference,
} from './font';
import { useI18n } from './i18n';

export function FontProvider({ children }: { children: ReactNode }) {
  const { language } = useI18n();
  const [preference, setPreference] = useState<FontPreference>(getStoredFontPreference);
  const preset = resolveFontPreset(preference, language);

  useEffect(() => {
    applyFontPreset(preset);
    if (!preset) return;

    loadFontPreset(preset).catch((error) => {
      console.error(`Failed to load ${preset.label}`, error);
    });
  }, [preset]);

  const setFontPreference = useCallback((nextPreference: FontPreference) => {
    const normalizedPreference = normalizeFontPreference(nextPreference);
    setPreference(normalizedPreference);
    if (typeof window !== 'undefined') {
      localStorage.setItem(FONT_SETTING_KEY, normalizedPreference);
    }
  }, []);

  const value = useMemo<FontContextValue>(
    () => ({ preference, setFontPreference }),
    [preference, setFontPreference],
  );

  return <FontContext.Provider value={value}>{children}</FontContext.Provider>;
}
