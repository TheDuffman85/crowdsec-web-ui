import { describe, expect, test } from 'bun:test';
import { parseGoDuration, toDuration } from './duration';

describe('duration helpers', () => {
  test('parseGoDuration handles mixed units and negatives', () => {
    expect(parseGoDuration('1h2m3s')).toBe(3_723_000);
    expect(parseGoDuration('-5m')).toBe(-300_000);
    expect(parseGoDuration(undefined)).toBe(0);
  });

  test('toDuration converts a timestamp delta to Go-style duration', () => {
    expect(toDuration(1_000, 3_723_000 + 1_000)).toBe('1h2m3s');
  });
});
