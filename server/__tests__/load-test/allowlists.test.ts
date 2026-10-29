import { describe, expect, test } from 'vitest';
import {
  buildLoadTestAllowlists,
  createLoadTestAllowlistMatcher,
  LOAD_TEST_ALLOWLIST_ZERO_TIME,
  parseLoadTestAddressRange,
  withoutExpiredLoadTestAllowlistItems,
} from '../../../scripts/load-test-allowlists';

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1_000;

describe('load-test allowlists', () => {
  test('generates deterministic allowlists with unique, parseable values', () => {
    const options = { sizes: [5_000, 2_000, 300], seed: 1337, nowMs: NOW };
    const allowlists = buildLoadTestAllowlists(options);
    expect(buildLoadTestAllowlists(options)).toEqual(allowlists);

    expect(allowlists.map((allowlist) => [allowlist.name, allowlist.items?.length, allowlist.console_managed])).toEqual([
      ['partner-networks', 5_000, false],
      ['corporate-egress', 2_000, false],
      ['customer-vpn', 300, true],
    ]);
    for (const allowlist of allowlists) {
      const values = allowlist.items!.map((item) => item.value!);
      expect(new Set(values).size).toBe(values.length);
      expect(values.every((value) => parseLoadTestAddressRange(value) !== null)).toBe(true);
    }

    const items = allowlists.flatMap((allowlist) => allowlist.items!);
    const share = (predicate: (item: typeof items[number]) => boolean) => items.filter(predicate).length / items.length;
    expect(share((item) => item.value!.includes(':'))).toBeGreaterThan(0.1);
    expect(share((item) => item.value!.endsWith('/28'))).toBeGreaterThan(0.1);
    expect(share((item) => item.expiration === LOAD_TEST_ALLOWLIST_ZERO_TIME)).toBeGreaterThan(0.7);
    expect(share((item) => Boolean(item.description))).toBeGreaterThan(0.5);
    expect(allowlists[0].items!.slice(0, 2).map((item) => item.value)).toEqual(['45.1.0.0/16', '45.2.0.0/16']);
  });

  test('later instances miss some entries and the last allowlist', () => {
    const primary = buildLoadTestAllowlists({ sizes: [1_000, 100], seed: 7, nowMs: NOW });
    const secondary = buildLoadTestAllowlists({ sizes: [1_000, 100], seed: 7, nowMs: NOW, instanceIndex: 1 });
    const edge = buildLoadTestAllowlists({ sizes: [1_000, 100], seed: 7, nowMs: NOW, instanceIndex: 2 });

    expect(secondary.map((allowlist) => allowlist.name)).toEqual(['partner-networks']);
    // Every 50th entry is missing, except entry 1, which is one of the protected alert-source ranges.
    expect(secondary[0].items).toHaveLength(981);
    const primaryValues = new Set(primary[0].items!.map((item) => item.value));
    expect(secondary[0].items!.every((item) => primaryValues.has(item.value))).toBe(true);
    // Each instance misses different entries, and the alert-source ranges stay everywhere.
    expect(secondary[0].items!.map((item) => item.value)).not.toEqual(edge[0].items!.map((item) => item.value));
    expect(edge[0].items![0].value).toBe('45.1.0.0/16');
  });

  test('matches addresses inside ranges and ranges containing entries like LAPI', () => {
    const allowlists = [
      {
        name: 'zeta',
        items: [{ value: '10.0.0.0/8', description: 'Office', expiration: LOAD_TEST_ALLOWLIST_ZERO_TIME }],
      },
      {
        name: 'alpha',
        items: [
          { value: '10.1.2.3', expiration: LOAD_TEST_ALLOWLIST_ZERO_TIME },
          { value: '2001:db8:1::/48', description: 'IPv6', expiration: LOAD_TEST_ALLOWLIST_ZERO_TIME },
          { value: '192.0.2.1', expiration: new Date(NOW - DAY_MS).toISOString() },
        ],
      },
    ];
    let now = NOW;
    const check = createLoadTestAllowlistMatcher(allowlists, () => now);

    expect(check('10.1.2.3')).toEqual({ allowlisted: true, reason: '10.1.2.3 from alpha, 10.0.0.0/8 from zeta (Office)' });
    expect(check('10.200.0.0/16')).toEqual({ allowlisted: true, reason: '10.0.0.0/8 from zeta (Office)' });
    expect(check('10.1.2.0/24')).toEqual({ allowlisted: true, reason: '10.1.2.3 from alpha, 10.0.0.0/8 from zeta (Office)' });
    expect(check('2001:db8:1:ffff::1')).toEqual({ allowlisted: true, reason: '2001:db8:1::/48 from alpha (IPv6)' });
    expect(check('11.0.0.1')).toEqual({ allowlisted: false });
    expect(check('192.0.2.1')).toEqual({ allowlisted: false });
    expect(check('not-an-ip')).toEqual({ allowlisted: false });

    now = NOW - 2 * DAY_MS;
    expect(check('192.0.2.1')).toEqual({ allowlisted: true, reason: '192.0.2.1 from alpha' });
    expect(withoutExpiredLoadTestAllowlistItems(allowlists, NOW)[1].items!.map((item) => item.value)).toEqual([
      '10.1.2.3',
      '2001:db8:1::/48',
    ]);
  });

  test('parses IPv4 and IPv6 addresses and prefixes', () => {
    expect(parseLoadTestAddressRange('192.0.2.17/28')).toEqual({ family: 4, start: 0xc0000210n, end: 0xc000021fn });
    expect(parseLoadTestAddressRange('::1')).toEqual({ family: 6, start: 1n, end: 1n });
    expect(parseLoadTestAddressRange('2001:db8::/32')?.end).toBe((0x20010db8n << 96n) | ((1n << 96n) - 1n));
    for (const invalid of ['256.0.0.1', '1.2.3', '1.2.3.4/33', '1.2.3.4/', '1::2::3', '1:2:3:4:5:6:7:8:9', '10.0.0.0/8/1']) {
      expect(parseLoadTestAddressRange(invalid)).toBeNull();
    }
  });
});
