import { expect, test } from 'vitest';
import en from '../../locales/en.json';
import ar from '../../locales/ar.json';
import de from '../../locales/de.json';
import es from '../../locales/es.json';
import fr from '../../locales/fr.json';
import hi from '../../locales/hi.json';
import ja from '../../locales/ja.json';
import ko from '../../locales/ko.json';
import pt from '../../locales/pt.json';
import ru from '../../locales/ru.json';
import zh from '../../locales/zh.json';

test.each(Object.entries({ ar, de, es, fr, hi, ja, ko, pt, ru, zh }))('%s translates statistics labels and preserves placeholders', (_language, locale) => {
  for (const [key, value] of Object.entries(en).filter(([key]) => key.startsWith('pages.statistics.'))) {
    const translated = (locale as Record<string, string>)[key];
    expect(translated, key).toBeTruthy();
    expect(translated.match(/\{\w+\}/g)?.sort() || [], key).toEqual(value.match(/\{\w+\}/g)?.sort() || []);
  }
});
