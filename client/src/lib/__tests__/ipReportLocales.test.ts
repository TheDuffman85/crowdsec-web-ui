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

function ipReportKeys(locale: Record<string, string>): string[] {
  return Object.keys(locale)
    .filter((key) => key.startsWith('pages.settings.ipReports.'))
    .sort();
}

function placeholders(value: string): string[] {
  return Array.from(value.matchAll(/\{(\w+)\}/g), (match) => match[1]).sort();
}

describe('IP report locale coverage', () => {
  test.each(Object.entries(locales))('%s contains every English IP report key with the same placeholders', (_language, locale) => {
    const strings = locale as Record<string, string>;
    expect(ipReportKeys(strings)).toEqual(ipReportKeys(en));
    for (const key of ipReportKeys(en)) {
      expect(placeholders(strings[key]), key).toEqual(placeholders((en as Record<string, string>)[key]));
    }
  });
});
