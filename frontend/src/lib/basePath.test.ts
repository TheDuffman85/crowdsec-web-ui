import { afterEach, describe, expect, test } from 'vitest';
import { apiUrl, assetUrl, getBasePath, withBasePath } from './basePath';

afterEach(() => {
  delete window.__BASE_PATH__;
});

describe('basePath helpers', () => {
  test('returns an empty base path when none is configured', () => {
    expect(getBasePath()).toBe('');
    expect(withBasePath('/api/alerts')).toBe('/api/alerts');
  });

  test('prefixes asset and api paths when a base path is configured', () => {
    window.__BASE_PATH__ = '/crowdsec';

    expect(getBasePath()).toBe('/crowdsec');
    expect(withBasePath('/api/alerts')).toBe('/crowdsec/api/alerts');
    expect(withBasePath('api/alerts')).toBe('/crowdsec/api/alerts');
    expect(apiUrl('/api/config')).toBe('/crowdsec/api/config');
    expect(assetUrl('/logo.svg')).toBe('/crowdsec/logo.svg');
  });
});
