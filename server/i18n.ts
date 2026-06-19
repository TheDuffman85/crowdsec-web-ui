import ar from '../client/src/locales/ar.json';
import de from '../client/src/locales/de.json';
import en from '../client/src/locales/en.json';
import es from '../client/src/locales/es.json';
import fr from '../client/src/locales/fr.json';
import hi from '../client/src/locales/hi.json';
import ja from '../client/src/locales/ja.json';
import pt from '../client/src/locales/pt.json';
import ru from '../client/src/locales/ru.json';
import zh from '../client/src/locales/zh.json';
import type { CrowdsecDatabase } from './database';

export const LANGUAGE_SETTING_KEY = 'language';
export const BROWSER_LANGUAGE_SETTING = 'browser';

export const SUPPORTED_SERVER_LANGUAGES = ['ar', 'en', 'de', 'fr', 'hi', 'ja', 'pt', 'es', 'ru', 'zh'] as const;
export type SupportedServerLanguage = (typeof SUPPORTED_SERVER_LANGUAGES)[number];
export type LanguagePreference = SupportedServerLanguage | typeof BROWSER_LANGUAGE_SETTING;
export type TranslationValues = Record<string, string | number | boolean | null | undefined>;
export type Translator = (key: string, values?: TranslationValues) => string;

const resources: Record<SupportedServerLanguage, Record<string, string>> = {
  ar,
  de,
  en,
  es,
  fr,
  hi,
  ja,
  pt,
  ru,
  zh,
};

const supportedLanguageCodes = new Set<string>(SUPPORTED_SERVER_LANGUAGES);

function normalizeLanguageCode(language: string | null | undefined): SupportedServerLanguage | null {
  if (!language) return null;
  const normalized = language.trim().toLowerCase().replace('_', '-');
  if (supportedLanguageCodes.has(normalized)) return normalized as SupportedServerLanguage;

  const base = normalized.split('-')[0];
  return supportedLanguageCodes.has(base) ? base as SupportedServerLanguage : null;
}

export function normalizeLanguagePreference(preference: string | null | undefined): LanguagePreference {
  if (!preference || preference === BROWSER_LANGUAGE_SETTING) return BROWSER_LANGUAGE_SETTING;
  return normalizeLanguageCode(preference) ?? BROWSER_LANGUAGE_SETTING;
}

export function getServerLanguage(database: CrowdsecDatabase): SupportedServerLanguage {
  const preference = normalizeLanguagePreference(database.getMeta(LANGUAGE_SETTING_KEY)?.value);
  return preference === BROWSER_LANGUAGE_SETTING ? 'en' : preference;
}

export function saveLanguagePreference(database: CrowdsecDatabase, preference: string | null | undefined): LanguagePreference {
  const normalizedPreference = normalizeLanguagePreference(preference);
  database.setMeta(LANGUAGE_SETTING_KEY, normalizedPreference);
  return normalizedPreference;
}

export function createTranslator(language: SupportedServerLanguage): Translator {
  const resource = resources[language] ?? resources.en;
  return (key, values = {}) => {
    let template = resource[key] ?? resources.en[key] ?? key;
    for (const [name, value] of Object.entries(values)) {
      template = template.replaceAll(`{${name}}`, String(value ?? ''));
    }
    return template;
  };
}

export function getServerTranslator(database: CrowdsecDatabase): Translator {
  return createTranslator(getServerLanguage(database));
}
