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

const USER_KEY_PATTERN = /^(pages\.passwordChange\.|pages\.settings\.(\w*User\w*|users?\w*|initialPassword|passwordRequirements|requirePasswordChange)$)/;

function userKeys(locale: Record<string, string>): string[] {
  return Object.keys(locale)
    .filter((key) => USER_KEY_PATTERN.test(key))
    .sort();
}

describe('user management locale coverage', () => {
  test.each(Object.entries(locales))('%s contains every English user management key', (_language, locale) => {
    expect(userKeys(locale)).toEqual(userKeys(en));
  });
});
