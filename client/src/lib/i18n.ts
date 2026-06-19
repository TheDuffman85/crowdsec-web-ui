import { createContext, useContext } from 'react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import ar from '../locales/ar.json';
import de from '../locales/de.json';
import en from '../locales/en.json';
import es from '../locales/es.json';
import fr from '../locales/fr.json';
import hi from '../locales/hi.json';
import ru from '../locales/ru.json';
import zh from '../locales/zh.json';

export const LANGUAGE_SETTING_KEY = 'language';
export const BROWSER_LANGUAGE_SETTING = 'browser';

export const SUPPORTED_LANGUAGES = [
  { code: 'ar', labelKey: 'languages.ar' },
  { code: 'en', labelKey: 'languages.en' },
  { code: 'de', labelKey: 'languages.de' },
  { code: 'fr', labelKey: 'languages.fr' },
  { code: 'hi', labelKey: 'languages.hi' },
  { code: 'es', labelKey: 'languages.es' },
  { code: 'ru', labelKey: 'languages.ru' },
  { code: 'zh', labelKey: 'languages.zh' },
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]['code'];
export type LanguagePreference = SupportedLanguage | typeof BROWSER_LANGUAGE_SETTING;
export type TranslationValues = Record<string, string | number | boolean | null | undefined>;

export const i18nResources = {
  ar: {
    translation: ar,
  },
  de: {
    translation: de,
  },
  en: {
    translation: en,
  },
  es: {
    translation: es,
  },
  fr: {
    translation: fr,
  },
  hi: {
    translation: hi,
  },
  ru: {
    translation: ru,
  },
  zh: {
    translation: zh,
  },
} as const;

const supportedLanguageCodes = new Set<string>(
  SUPPORTED_LANGUAGES.map((language) => language.code),
);

if (!i18next.isInitialized) {
  void i18next
    .use(initReactI18next)
    .init({
      resources: i18nResources,
      lng: 'en',
      fallbackLng: 'en',
      supportedLngs: SUPPORTED_LANGUAGES.map((language) => language.code),
      interpolation: {
        escapeValue: false,
        prefix: '{',
        suffix: '}',
      },
      returnNull: false,
      react: {
        useSuspense: false,
      },
    });
}

function normalizeLanguageCode(language: string | null | undefined): SupportedLanguage | null {
  if (!language) return null;
  const normalized = language.trim().toLowerCase().replace('_', '-');
  const exact = normalized as SupportedLanguage;
  if (supportedLanguageCodes.has(exact)) return exact;

  const base = normalized.split('-')[0] as SupportedLanguage;
  return supportedLanguageCodes.has(base) ? base : null;
}

export function normalizeLanguagePreference(
  preference: string | null | undefined,
): LanguagePreference {
  if (!preference || preference === BROWSER_LANGUAGE_SETTING) return BROWSER_LANGUAGE_SETTING;
  return normalizeLanguageCode(preference) ?? BROWSER_LANGUAGE_SETTING;
}

export function getBrowserLanguage(): SupportedLanguage {
  if (typeof navigator === 'undefined') return 'en';

  const languages =
    Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language];

  for (const language of languages) {
    const supportedLanguage = normalizeLanguageCode(language);
    if (supportedLanguage) return supportedLanguage;
  }

  return 'en';
}

export function resolveLanguagePreference(
  preference: LanguagePreference,
): SupportedLanguage {
  return preference === BROWSER_LANGUAGE_SETTING ? getBrowserLanguage() : preference;
}

export function getLanguageLabelKey(language: SupportedLanguage): string {
  return (
    SUPPORTED_LANGUAGES.find((candidate) => candidate.code === language)?.labelKey ??
    language
  );
}

export type I18nContextValue = {
  language: SupportedLanguage;
  preference: LanguagePreference;
  browserLanguage: SupportedLanguage;
  setLanguagePreference: (preference: LanguagePreference) => void;
  t: (key: string, values?: TranslationValues) => string;
};

const fallbackI18n: I18nContextValue = {
  language: 'en',
  preference: BROWSER_LANGUAGE_SETTING,
  browserLanguage: 'en',
  setLanguagePreference: () => undefined,
  t: (key, values) => String(i18next.t(key, values)),
};

export const I18nContext = createContext<I18nContextValue>(fallbackI18n);

export function getStoredLanguagePreference(): LanguagePreference {
  if (typeof window === 'undefined') return BROWSER_LANGUAGE_SETTING;
  return normalizeLanguagePreference(localStorage.getItem(LANGUAGE_SETTING_KEY));
}

export function useI18n() {
  return useContext(I18nContext);
}
