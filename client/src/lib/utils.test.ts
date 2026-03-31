import { describe, expect, test } from 'vitest';
import { cn, getCountryName, getHubUrl } from './utils';

describe('utils', () => {
  test('cn merges class values', () => {
    expect(cn('px-2', undefined, 'px-4', ['font-bold'])).toContain('px-4');
    expect(cn('px-2', undefined, 'px-4', ['font-bold'])).toContain('font-bold');
  });

  test('getHubUrl returns scenario and appsec links', () => {
    expect(getHubUrl('crowdsecurity/ssh-bf')).toBe('https://app.crowdsec.net/hub/author/crowdsecurity/scenarios/ssh-bf');
    expect(getHubUrl('crowdsecurity/appsec-rule')).toBe('https://app.crowdsec.net/hub/author/crowdsecurity/appsec-rules/appsec-rule');
    expect(getHubUrl('crowdsecurity/vpatch-test')).toBe('https://app.crowdsec.net/hub/author/crowdsecurity/appsec-rules/vpatch-test');
    expect(getHubUrl('crowdsecurity/crs-test')).toBe('https://app.crowdsec.net/hub/author/crowdsecurity/appsec-rules/crs-test');
    expect(getHubUrl('invalid')).toBeNull();
    expect(getHubUrl(null)).toBeNull();
  });

  test('getCountryName resolves display names and falls back safely', () => {
    expect(getCountryName('de')).toBe('Germany');
    expect(getCountryName(null)).toBeNull();
  });

  test('getCountryName falls back to the code when Intl throws', () => {
    const original = Intl.DisplayNames;
    Object.defineProperty(Intl, 'DisplayNames', {
      configurable: true,
      value: class {
        constructor() {
          throw new Error('boom');
        }
      },
    });

    expect(getCountryName('zz')).toBe('zz');
    Object.defineProperty(Intl, 'DisplayNames', {
      configurable: true,
      value: original,
    });
  });

  test('getCountryName falls back to the raw code when Intl returns undefined', () => {
    const original = Intl.DisplayNames;
    Object.defineProperty(Intl, 'DisplayNames', {
      configurable: true,
      value: class {
        of() {
          return undefined;
        }
      },
    });

    expect(getCountryName('zz')).toBe('zz');
    Object.defineProperty(Intl, 'DisplayNames', {
      configurable: true,
      value: original,
    });
  });
});
