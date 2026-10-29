import { describe, expect, test } from 'vitest';
import ar from '../../locales/ar.json';
import de from '../../locales/de.json';
import en from '../../locales/en.json';
import es from '../../locales/es.json';
import fr from '../../locales/fr.json';
import hi from '../../locales/hi.json';
import ja from '../../locales/ja.json';
import ko from '../../locales/ko.json';
import pt from '../../locales/pt.json';
import ru from '../../locales/ru.json';
import zh from '../../locales/zh.json';

const locales = { ar, de, es, fr, hi, ja, ko, pt, ru, zh };

const ALLOWLIST_KEY_PATTERN = /^(pages\.allowlists\.|pages\.settings\.showAllowlistsInSidebar|components\.syncOverlay\.allowlists|components\.sidebar\.nav\.allowlists$|pages\.alerts\.allowlisted$|pages\.decisions\.(allowlisted|bypassAllowlist))/;

function allowlistKeys(locale: Record<string, string>): string[] {
  return Object.keys(locale)
    .filter((key) => ALLOWLIST_KEY_PATTERN.test(key))
    .sort();
}

describe('allowlist locale coverage', () => {
  test.each(Object.entries(locales))('%s contains every English allowlist key', (_language, locale) => {
    expect(allowlistKeys(locale)).toEqual(allowlistKeys(en));
  });
});
