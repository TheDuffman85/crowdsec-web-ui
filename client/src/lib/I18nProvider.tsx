import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { updateLanguagePreference } from './api';
import {
  I18nContext,
  LANGUAGE_SETTING_KEY,
  getBrowserLanguage,
  getStoredLanguagePreference,
  normalizeLanguagePreference,
  resolveLanguagePreference,
  type I18nContextValue,
  type LanguagePreference,
  type TranslationValues,
} from './i18n';

export function I18nProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<LanguagePreference>(getStoredLanguagePreference);
  const hasSyncedStoredPreferenceRef = useRef(false);
  const { t: translate, i18n } = useTranslation();
  const browserLanguage = getBrowserLanguage();
  const language = resolveLanguagePreference(preference);

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    if (i18n.language !== language) {
      void i18n.changeLanguage(language);
    }
  }, [i18n, language]);

  useEffect(() => {
    if (hasSyncedStoredPreferenceRef.current) {
      return;
    }
    hasSyncedStoredPreferenceRef.current = true;

    if (typeof window === 'undefined' || localStorage.getItem(LANGUAGE_SETTING_KEY) == null) {
      return;
    }

    void updateLanguagePreference(preference).catch((error) => {
      console.error('Failed to update server language preference', error);
    });
  }, [preference]);

  const setLanguagePreference = useCallback((nextPreference: LanguagePreference) => {
    const normalizedPreference = normalizeLanguagePreference(nextPreference);
    setPreferenceState(normalizedPreference);
    if (typeof window !== 'undefined') {
      localStorage.setItem(LANGUAGE_SETTING_KEY, normalizedPreference);
    }
    void updateLanguagePreference(normalizedPreference).catch((error) => {
      console.error('Failed to update server language preference', error);
    });
  }, []);

  const t = useCallback(
    (key: string, values?: TranslationValues) => String(translate(key, values)),
    [translate],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ language, preference, browserLanguage, setLanguagePreference, t }),
    [browserLanguage, language, preference, setLanguagePreference, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
