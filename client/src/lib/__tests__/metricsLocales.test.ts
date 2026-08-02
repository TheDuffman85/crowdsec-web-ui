import { describe, expect, test } from 'vitest';
import ar from '../../locales/ar.json';
import de from '../../locales/de.json';
import en from '../../locales/en.json';
import es from '../../locales/es.json';
import fr from '../../locales/fr.json';
import hi from '../../locales/hi.json';
import ja from '../../locales/ja.json';
import pt from '../../locales/pt.json';
import ru from '../../locales/ru.json';
import zh from '../../locales/zh.json';

const locales = { ar, de, es, fr, hi, ja, pt, ru, zh };

function metricKeys(locale: Record<string, string>): string[] {
  return Object.keys(locale)
    .filter((key) => key.startsWith('pages.metrics.'))
    .sort();
}

describe('metrics locale coverage', () => {
  test.each(Object.entries(locales))('%s contains every English metrics key', (_language, locale) => {
    expect(metricKeys(locale)).toEqual(metricKeys(en));
  });
});
