import type { LapiAllowlist, LapiAllowlistItem } from '../server/lapi';

/** CrowdSec serializes an unset expiration as the zero time. */
export const LOAD_TEST_ALLOWLIST_ZERO_TIME = '0001-01-01T00:00:00.000Z';

const DAY_MS = 24 * 60 * 60 * 1_000;
const ALLOWLIST_NAMES = [
  'partner-networks',
  'corporate-egress',
  'customer-vpn',
  'monitoring-probes',
  'cdn-edges',
  'search-crawlers',
  'payment-providers',
  'support-staff',
] as const;
const DESCRIPTIONS = ['Customer', 'Office', 'VPN gateway', 'Monitoring probe', 'Contractor', 'Ticket'] as const;
// Load-test alert sources use 45.1.0.0-45.223.255.255; the first allowlist
// covers part of that space so alert badges and the decision guard trigger.
const ALERT_SOURCE_RANGES = 8;

export interface LoadTestAllowlistOptions {
  sizes: number[];
  seed: number;
  nowMs: number;
  /** 0 for the primary instance; later instances miss some entries and the last allowlist. */
  instanceIndex?: number;
}

function hash32(value: number, seed: number): number {
  let next = Math.imul(value ^ seed, 0x45d9f3b);
  next ^= next >>> 16;
  next = Math.imul(next, 0x45d9f3b);
  next ^= next >>> 16;
  return next >>> 0;
}

function fraction(value: number, seed: number, salt: number): number {
  return hash32(value + Math.imul(salt, 1_000_003), seed) / 0x1_0000_0000;
}

function allowlistName(index: number): string {
  return index < ALLOWLIST_NAMES.length ? ALLOWLIST_NAMES[index] : `allowlist-${index + 1}`;
}

function octets(value: number): string {
  return [(value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

// Every allowlist owns one IPv4 /8 and one IPv6 /48 and derives each value
// from the entry index, so values stay unique per list. Ranges overlap single
// addresses on purpose, as they do in real allowlists.
function entryValue(listIndex: number, entryIndex: number, kind: number): string {
  if (listIndex === 0 && entryIndex < ALERT_SOURCE_RANGES) return `45.${entryIndex + 1}.0.0/16`;
  const first = 100 + (listIndex % 100);
  if (kind < 0.7) return `${first}.${octets(entryIndex)}`;
  if (kind < 0.85) return `${first}.${octets((entryIndex * 16) & 0xffffff)}/28`;
  const prefix = `2001:db8:${listIndex.toString(16)}:${(entryIndex >>> 16).toString(16)}:${(entryIndex & 0xffff).toString(16)}`;
  return kind < 0.95 ? `${prefix}::1` : `${prefix}::/80`;
}

export function buildLoadTestAllowlists(options: LoadTestAllowlistOptions): LapiAllowlist[] {
  const { sizes, seed, nowMs } = options;
  const instanceIndex = options.instanceIndex ?? 0;
  const listCount = instanceIndex > 0 && sizes.length > 1 ? sizes.length - 1 : sizes.length;
  const allowlists: LapiAllowlist[] = [];
  for (let listIndex = 0; listIndex < listCount; listIndex += 1) {
    const listSeed = seed + listIndex * 7_919;
    const createdAt = new Date(nowMs - (30 + listIndex * 15) * DAY_MS).toISOString();
    const items: LapiAllowlistItem[] = [];
    for (let entryIndex = 0; entryIndex < sizes[listIndex]; entryIndex += 1) {
      if (instanceIndex > 0 && entryIndex >= ALERT_SOURCE_RANGES && entryIndex % 50 === instanceIndex) continue;
      const kind = fraction(entryIndex, listSeed, 1);
      const value = entryValue(listIndex, entryIndex, kind);
      const description = fraction(entryIndex, listSeed, 2) < 0.6
        ? `${DESCRIPTIONS[hash32(entryIndex, listSeed) % DESCRIPTIONS.length]} ${entryIndex + 1}`
        : undefined;
      const expires = fraction(entryIndex, listSeed, 3) < 0.2;
      items.push({
        value,
        ...(description ? { description } : {}),
        created_at: new Date(nowMs - Math.floor(fraction(entryIndex, listSeed, 4) * 365 * DAY_MS)).toISOString(),
        expiration: expires
          ? new Date(nowMs + Math.ceil(fraction(entryIndex, listSeed, 5) * 90 * DAY_MS)).toISOString()
          : LOAD_TEST_ALLOWLIST_ZERO_TIME,
      });
    }
    allowlists.push({
      allowlist_id: `loadtest-${listIndex + 1}`,
      name: allowlistName(listIndex),
      description: `Synthetic allowlist ${listIndex + 1} with ${sizes[listIndex].toLocaleString('en-US')} entries`,
      created_at: createdAt,
      updated_at: new Date(nowMs - listIndex * DAY_MS).toISOString(),
      console_managed: listIndex % 3 === 2,
      items,
    });
  }
  return allowlists;
}

interface AddressRange {
  family: 4 | 6;
  start: bigint;
  end: bigint;
}

function parseIpv4(value: string): bigint | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let result = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    result = (result << 8n) | BigInt(Number(part));
  }
  return result;
}

function parseIpv6(value: string): bigint | null {
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  let result = 0n;
  for (const group of groups) {
    if (!/^[\da-f]{1,4}$/i.test(group)) return null;
    result = (result << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return result;
}

export function parseLoadTestAddressRange(value: string): AddressRange | null {
  const [address, prefixText, extra] = value.trim().split('/');
  if (extra !== undefined) return null;
  const family = address.includes(':') ? 6 : 4;
  const parsed = family === 4 ? parseIpv4(address) : parseIpv6(address);
  if (parsed === null) return null;
  const bits = family === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? bits : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits || (prefixText !== undefined && !/^\d+$/.test(prefixText))) return null;
  const hostMask = (1n << BigInt(bits - prefix)) - 1n;
  return { family, start: parsed & ~hostMask, end: parsed | hostMask };
}

/**
 * Matches like LAPI: the value is inside an allowlisted range or contains an
 * allowlisted value. Reasons follow CrowdSec's `<value> from <name> (<comment>)`.
 */
export function createLoadTestAllowlistMatcher(allowlists: LapiAllowlist[], nowMs: () => number = Date.now) {
  const entries = allowlists
    .flatMap((allowlist) => (allowlist.items || []).flatMap((item) => {
      const range = item.value ? parseLoadTestAddressRange(item.value) : null;
      if (!range) return [];
      const expiresAt = item.expiration && item.expiration !== LOAD_TEST_ALLOWLIST_ZERO_TIME ? Date.parse(item.expiration) : null;
      const reason = `${item.value} from ${allowlist.name}${item.description ? ` (${item.description})` : ''}`;
      return [{ ...range, name: allowlist.name || '', expiresAt, reason }];
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return (value: string): { allowlisted: boolean; reason?: string } => {
    const query = parseLoadTestAddressRange(value);
    if (!query) return { allowlisted: false };
    const now = nowMs();
    const reasons = entries
      .filter((entry) => entry.family === query.family
        && (entry.expiresAt === null || entry.expiresAt > now)
        && ((entry.start <= query.start && query.end <= entry.end) || (query.start <= entry.start && entry.end <= query.end)))
      .map((entry) => entry.reason);
    return reasons.length > 0 ? { allowlisted: true, reason: reasons.join(', ') } : { allowlisted: false };
  };
}

/** LAPI leaves expired entries out of allowlist listings. */
export function withoutExpiredLoadTestAllowlistItems(allowlists: LapiAllowlist[], nowMs: number): LapiAllowlist[] {
  return allowlists.map((allowlist) => ({
    ...allowlist,
    items: (allowlist.items || []).filter((item) => !item.expiration
      || item.expiration === LOAD_TEST_ALLOWLIST_ZERO_TIME
      || Date.parse(item.expiration) > nowMs),
  }));
}
