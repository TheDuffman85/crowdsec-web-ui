import { describe, expect, test } from 'vitest';
import { formatAlertSessionDuration } from '../alertGrouping';
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

const at = (minutes: number, seconds = 0) => new Date(Date.UTC(2026, 10, 1, 12, minutes, seconds)).toISOString();

describe('formatAlertSessionDuration', () => {
  test.each([
    [at(0), at(0), '<1m'],
    [at(0), at(0, 59), '<1m'],
    [at(0), at(1), '1m'],
    [at(0), at(59, 59), '59m'],
    [at(0), at(60), '1h'],
    [at(0), at(125), '2h 5m'],
  ])('formats %s to %s as %s', (firstSeen, lastSeen, expected) => {
    expect(formatAlertSessionDuration(firstSeen, lastSeen)).toBe(expected);
  });

  test('falls back to the shortest label for unreadable timestamps', () => {
    expect(formatAlertSessionDuration('unknown', at(0))).toBe('<1m');
  });
});

describe('alert session locale coverage', () => {
  const keys = Object.keys(en).filter((key) => /^pages\.alerts\.(groupByIp|session)/.test(key));

  test('defines the English keys', () => {
    expect(keys.length).toBeGreaterThan(0);
  });

  test.each(Object.entries({ ar, de, es, fr, hi, ja, ko, pt, ru, zh }))('%s contains every key and placeholder', (_language, locale) => {
    const translations = locale as Record<string, string>;
    const placeholders = (value: string) => (value.match(/\{\w+\}/g) || []).sort();
    for (const key of keys) {
      expect(placeholders(translations[key] ?? '')).toEqual(placeholders((en as Record<string, string>)[key]));
    }
  });
});
