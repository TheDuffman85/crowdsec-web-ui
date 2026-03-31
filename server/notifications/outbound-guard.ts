import dns from 'node:dns/promises';
import net from 'node:net';

export interface NotificationOutboundGuardOptions {
  allowPrivateAddresses: boolean;
}

export interface NotificationOutboundGuard {
  assertHostAllowed(host: string, label: string): Promise<void>;
  assertUrlAllowed(value: string, label: string): Promise<void>;
}

export function createNotificationOutboundGuard(options: NotificationOutboundGuardOptions): NotificationOutboundGuard {
  return {
    async assertHostAllowed(host, label) {
      const normalizedHost = host.trim();
      if (!normalizedHost) {
        throw new Error(`${label} must include a hostname`);
      }
      if (options.allowPrivateAddresses) {
        return;
      }

      const addresses = await resolveHostAddresses(normalizedHost);
      for (const address of addresses) {
        const verdict = classifyAddress(address);
        if (verdict === 'public') {
          continue;
        }
        if (verdict === 'private' && options.allowPrivateAddresses) {
          continue;
        }
        throw new Error(`${label} points to a restricted address (${address})`);
      }
    },
    async assertUrlAllowed(value, label) {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        throw new Error(`${label} must be a valid URL`);
      }
      await this.assertHostAllowed(parsed.hostname, label);
    },
  };
}

async function resolveHostAddresses(host: string): Promise<string[]> {
  if (host.toLowerCase() === 'localhost') {
    return ['127.0.0.1', '::1'];
  }

  if (net.isIP(host)) {
    return [normalizeIp(host)];
  }

  const records = await dns.lookup(host, { all: true, verbatim: true });
  const addresses = records.map((record) => normalizeIp(record.address));
  if (addresses.length === 0) {
    throw new Error(`Unable to resolve destination host: ${host}`);
  }
  return [...new Set(addresses)];
}

function normalizeIp(value: string): string {
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length);
    if (net.isIP(mapped) === 4) {
      return mapped;
    }
  }
  return value.toLowerCase();
}

function classifyAddress(address: string): 'public' | 'private' | 'local' {
  const version = net.isIP(address);
  if (version === 4) {
    return classifyIpv4(address);
  }
  if (version === 6) {
    return classifyIpv6(address);
  }
  return 'local';
}

function classifyIpv4(address: string): 'public' | 'private' | 'local' {
  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return 'local';
  }

  const [a, b] = octets;
  if (a === 0 || a === 127) return 'local';
  if (a === 169 && b === 254) return 'local';
  if (a >= 224) return 'local';
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 198 && (b === 18 || b === 19)) return 'private';
  return 'public';
}

function classifyIpv6(address: string): 'public' | 'private' | 'local' {
  const normalized = address.toLowerCase();
  if (normalized === '::' || normalized === '::1') {
    return 'local';
  }
  if (normalized.startsWith('fe80:')) {
    return 'local';
  }
  if (normalized.startsWith('ff')) {
    return 'local';
  }

  const value = ipv6ToBigInt(normalized);
  if (value === null) {
    return 'local';
  }

  if (inIpv6Range(value, 'fc00::', 7)) return 'private';
  if (inIpv6Range(value, 'fd00::', 8)) return 'private';
  if (inIpv6Range(value, 'fe80::', 10)) return 'local';
  return 'public';
}

function ipv6ToBigInt(address: string): bigint | null {
  const hasIpv4Suffix = address.includes('.');
  let working = address;

  if (hasIpv4Suffix) {
    const lastColon = address.lastIndexOf(':');
    if (lastColon < 0) {
      return null;
    }
    const ipv4 = address.slice(lastColon + 1);
    const converted = ipv4ToIpv6Tail(ipv4);
    if (!converted) {
      return null;
    }
    working = `${address.slice(0, lastColon)}:${converted}`;
  }

  const parts = working.split('::');
  if (parts.length > 2) {
    return null;
  }

  const head = parts[0]
    ? parts[0].split(':').filter(Boolean)
    : [];
  const tail = parts[1]
    ? parts[1].split(':').filter(Boolean)
    : [];
  const missing = 8 - (head.length + tail.length);
  if (missing < 0) {
    return null;
  }

  const expanded = parts.length === 2
    ? [...head, ...new Array(missing).fill('0'), ...tail]
    : head;
  if (expanded.length !== 8) {
    return null;
  }

  let value = 0n;
  for (const segment of expanded) {
    if (!/^[0-9a-f]{1,4}$/i.test(segment)) {
      return null;
    }
    value = (value << 16n) + BigInt(Number.parseInt(segment, 16));
  }
  return value;
}

function ipv4ToIpv6Tail(address: string): string | null {
  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
}

function inIpv6Range(value: bigint, base: string, prefixBits: number): boolean {
  const baseValue = ipv6ToBigInt(base);
  if (baseValue === null) {
    return false;
  }
  const shift = 128n - BigInt(prefixBits);
  return (value >> shift) === (baseValue >> shift);
}
