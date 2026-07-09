import { createContext, useContext } from 'react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../locales/en.json';

export const LANGUAGE_SETTING_KEY = 'language';
export const BROWSER_LANGUAGE_SETTING = 'browser';

export const SUPPORTED_LANGUAGES = [
  { code: 'ar', labelKey: 'languages.ar' },
  { code: 'en', labelKey: 'languages.en' },
  { code: 'de', labelKey: 'languages.de' },
  { code: 'fr', labelKey: 'languages.fr' },
  { code: 'hi', labelKey: 'languages.hi' },
  { code: 'ja', labelKey: 'languages.ja' },
  { code: 'pt', labelKey: 'languages.pt' },
  { code: 'es', labelKey: 'languages.es' },
  { code: 'ru', labelKey: 'languages.ru' },
  { code: 'zh', labelKey: 'languages.zh' },
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]['code'];
export type LanguagePreference = SupportedLanguage | typeof BROWSER_LANGUAGE_SETTING;
export type TranslationValues = Record<string, string | number | boolean | null | undefined>;

export const i18nResources = { en: { translation: en } } as const;

const localeLoaders: Record<SupportedLanguage, () => Promise<{ default: Record<string, string> }>> = {
  ar: () => import('../locales/ar.json'),
  de: () => import('../locales/de.json'),
  en: async () => ({ default: en as Record<string, string> }),
  es: () => import('../locales/es.json'),
  fr: () => import('../locales/fr.json'),
  hi: () => import('../locales/hi.json'),
  ja: () => import('../locales/ja.json'),
  pt: () => import('../locales/pt.json'),
  ru: () => import('../locales/ru.json'),
  zh: () => import('../locales/zh.json'),
};
const languageResourcePromises = new Map<SupportedLanguage, Promise<void>>();

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

export async function loadLanguageResources(language: SupportedLanguage): Promise<void> {
  if (i18next.hasResourceBundle(language, 'translation')) {
    return;
  }

  const existingPromise = languageResourcePromises.get(language);
  if (existingPromise) {
    return existingPromise;
  }

  const promise = localeLoaders[language]()
    .then((resources) => {
      i18next.addResourceBundle(language, 'translation', resources.default, true, true);
    })
    .finally(() => {
      languageResourcePromises.delete(language);
    });
  languageResourcePromises.set(language, promise);
  return promise;
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
