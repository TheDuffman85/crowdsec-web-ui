import { isIP } from 'node:net';
import type { Hono } from 'hono';
import type { DashboardAuth } from '../app-auth';

const REQUEST_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const LOOKUPS_PER_MINUTE = 30;
const MAX_LIST_ITEMS = 25;

export type IntelStatus = 'ok' | 'not_configured' | 'not_found' | 'error';

export interface IntelSource<T> {
  status: IntelStatus;
  data?: T;
  /** A short reason without URLs or credentials. */
  error?: string;
}

export interface WhoisData {
  name: string | null;
  handle: string | null;
  country: string | null;
  type: string | null;
  start_address: string | null;
  end_address: string | null;
  registered_at: string | null;
  last_changed_at: string | null;
}

export interface AbuseIpdbData {
  abuse_confidence_score: number;
  total_reports: number;
  distinct_reporters: number;
  last_reported_at: string | null;
  isp: string | null;
  usage_type: string | null;
  domain: string | null;
  country_code: string | null;
  is_tor: boolean;
}

export interface ShodanData {
  ports: number[];
  hostnames: string[];
  organization: string | null;
  os: string | null;
  vulnerabilities: string[];
  last_update: string | null;
}

export interface IpIntelResult {
  ip: string;
  whois: IntelSource<WhoisData>;
  abuseipdb: IntelSource<AbuseIpdbData>;
  shodan: IntelSource<ShodanData>;
  cached: boolean;
}

export interface IpIntelKeys {
  abuseipdb?: string;
  shodan?: string;
}

export type IntelFetch = (url: string, init: { headers?: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

/** Addresses that mean nothing to an outside service and should not be sent to one. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
  }
  return true;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null);
const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function failure(error: unknown): IntelSource<never> {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return { status: 'error', error: 'timeout' };
  return { status: 'error', error: 'request failed' };
}

function httpFailure(response: Response): IntelSource<never> {
  if (response.status === 401 || response.status === 403) return { status: 'error', error: 'the API key was rejected' };
  if (response.status === 429) return { status: 'error', error: 'rate limit reached' };
  return { status: 'error', error: `HTTP ${response.status}` };
}

export function parseWhois(body: any): WhoisData {
  const events: Array<{ eventAction?: string; eventDate?: string }> = Array.isArray(body?.events) ? body.events : [];
  const dateOf = (action: string) => text(events.find((event) => event.eventAction === action)?.eventDate);
  return {
    name: text(body?.name),
    handle: text(body?.handle),
    country: text(body?.country),
    type: text(body?.type),
    start_address: text(body?.startAddress),
    end_address: text(body?.endAddress),
    registered_at: dateOf('registration'),
    last_changed_at: dateOf('last changed'),
  };
}

export function parseAbuseIpdb(body: any): AbuseIpdbData {
  const data = body?.data ?? {};
  return {
    abuse_confidence_score: number(data.abuseConfidenceScore),
    total_reports: number(data.totalReports),
    distinct_reporters: number(data.numDistinctUsers),
    last_reported_at: text(data.lastReportedAt),
    isp: text(data.isp),
    usage_type: text(data.usageType),
    domain: text(data.domain),
    country_code: text(data.countryCode),
    is_tor: data.isTor === true,
  };
}

export function parseShodan(body: any): ShodanData {
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, MAX_LIST_ITEMS) : []);
  return {
    ports: Array.isArray(body?.ports) ? body.ports.filter((port: unknown): port is number => typeof port === 'number').slice(0, MAX_LIST_ITEMS * 4) : [],
    hostnames: strings(body?.hostnames),
    organization: text(body?.org),
    os: text(body?.os),
    vulnerabilities: strings(body?.vulns),
    last_update: text(body?.last_update),
  };
}

export class IpIntelService {
  private readonly cache = new Map<string, { expiresAt: number; result: Omit<IpIntelResult, 'cached'> }>();
  private windowStart = 0;
  private windowCount = 0;

  constructor(private readonly options: {
    keys: () => IpIntelKeys;
    fetch?: IntelFetch;
    now?: () => number;
  }) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /** Which sources have credentials; never exposes the keys. */
  configured(): { whois: true; abuseipdb: boolean; shodan: boolean } {
    const keys = this.options.keys();
    return { whois: true, abuseipdb: Boolean(keys.abuseipdb), shodan: Boolean(keys.shodan) };
  }

  /** Allows a small burst of lookups per minute so a stuck client cannot burn through an API quota. */
  takeSlot(): boolean {
    const now = this.now();
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    if (this.windowCount >= LOOKUPS_PER_MINUTE) return false;
    this.windowCount += 1;
    return true;
  }

  private async get(url: string, headers?: Record<string, string>): Promise<Response> {
    const fetcher: IntelFetch = this.options.fetch ?? ((target, init) => fetch(target, init));
    return fetcher(url, { ...(headers ? { headers } : {}), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }

  private async lookupWhois(ip: string): Promise<IntelSource<WhoisData>> {
    try {
      const response = await this.get(`https://rdap.org/ip/${encodeURIComponent(ip)}`, { Accept: 'application/rdap+json, application/json' });
      if (response.status === 404) return { status: 'not_found' };
      if (!response.ok) return httpFailure(response);
      return { status: 'ok', data: parseWhois(await response.json()) };
    } catch (error) {
      return failure(error);
    }
  }

  private async lookupAbuseIpdb(ip: string, key: string | undefined): Promise<IntelSource<AbuseIpdbData>> {
    if (!key) return { status: 'not_configured' };
    try {
      const response = await this.get(
        `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90`,
        { Accept: 'application/json', Key: key },
      );
      if (!response.ok) return httpFailure(response);
      return { status: 'ok', data: parseAbuseIpdb(await response.json()) };
    } catch (error) {
      return failure(error);
    }
  }

  private async lookupShodan(ip: string, key: string | undefined): Promise<IntelSource<ShodanData>> {
    if (!key) return { status: 'not_configured' };
    try {
      const response = await this.get(`https://api.shodan.io/shodan/host/${encodeURIComponent(ip)}?key=${encodeURIComponent(key)}`, { Accept: 'application/json' });
      if (response.status === 404) return { status: 'not_found' };
      if (!response.ok) return httpFailure(response);
      return { status: 'ok', data: parseShodan(await response.json()) };
    } catch (error) {
      return failure(error);
    }
  }

  /** The AbuseIPDB confidence score if this address was already looked up; never triggers a request. */
  peekAbuseScore(ip: string): number | null {
    const hit = this.cache.get(ip);
    if (!hit || hit.expiresAt <= this.now()) return null;
    const source = hit.result.abuseipdb;
    return source.status === 'ok' && source.data ? source.data.abuse_confidence_score : null;
  }

  async lookup(ip: string): Promise<IpIntelResult> {
    const now = this.now();
    const hit = this.cache.get(ip);
    if (hit && hit.expiresAt > now) return { ...hit.result, cached: true };
    const keys = this.options.keys();
    const [whois, abuseipdb, shodan] = await Promise.all([
      this.lookupWhois(ip),
      this.lookupAbuseIpdb(ip, keys.abuseipdb),
      this.lookupShodan(ip, keys.shodan),
    ]);
    const result = { ip, whois, abuseipdb, shodan };
    // Do not cache failures: a timeout or rate limit should be retried on the next click.
    if ([whois, abuseipdb, shodan].every((source) => source.status !== 'error')) {
      if (this.cache.size >= CACHE_MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(ip, { expiresAt: now + CACHE_TTL_MS, result });
    }
    return { ...result, cached: false };
  }
}

export function registerIpIntelRoutes(options: {
  app: Hono;
  basePath: string;
  auth: DashboardAuth;
  service: IpIntelService;
}): void {
  const { app, basePath, auth, service } = options;
  const root = `${basePath}/api/ip-intel`;

  app.get(`${root}/sources`, auth.ensureAuth, (context) => context.json(service.configured()));

  app.get(root, auth.ensureAuth, async (context) => {
    const ip = (context.req.query('ip') ?? '').trim();
    if (!isIP(ip)) return context.json({ error: 'A valid IP address is required' }, 400);
    if (isPrivateAddress(ip)) return context.json({ error: 'Private and reserved addresses are not looked up' }, 400);
    if (!service.takeSlot()) return context.json({ error: 'Too many lookups, try again in a minute' }, 429);
    return context.json(await service.lookup(ip));
  });
}
