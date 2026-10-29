import {
  useCallback,
  useEffect,
  useMemo,
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
  loadLanguageResources,
  normalizeLanguagePreference,
  resolveLanguagePreference,
  type I18nContextValue,
  type LanguagePreference,
  type TranslationValues,
} from './i18n';

export function I18nProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<LanguagePreference>(getStoredLanguagePreference);
  const { t: translate, i18n } = useTranslation();
  const browserLanguage = getBrowserLanguage();
  const language = resolveLanguagePreference(preference);

  useEffect(() => {
    let cancelled = false;

    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';

    void loadLanguageResources(language)
      .then(() => {
        if (!cancelled && i18n.language !== language) {
          void i18n.changeLanguage(language);
        }
      })
      .catch((error) => {
        console.error(`Failed to load ${language} translations`, error);
        if (!cancelled && i18n.language !== 'en') {
          void i18n.changeLanguage('en');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [i18n, language]);

  const setLanguagePreference = useCallback((nextPreference: LanguagePreference, options?: { sync?: boolean }) => {
    const normalizedPreference = normalizeLanguagePreference(nextPreference);
    setPreferenceState(normalizedPreference);
    if (typeof window !== 'undefined') {
      localStorage.setItem(LANGUAGE_SETTING_KEY, normalizedPreference);
    }
    if (options?.sync === false) return;
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
