import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import {
  IpIntelService,
  isPrivateAddress,
  parseAbuseIpdb,
  parseShodan,
  parseWhois,
  registerIpIntelRoutes,
  type IntelFetch,
} from '../../app/ip-intel';

const SECRET_ABUSE = 'abuse-secret-key-123';
const SECRET_SHODAN = 'shodan-secret-key-456';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const rdap = { name: 'EXAMPLE-NET', handle: 'NET-1', country: 'US', type: 'ALLOCATED PA', startAddress: '203.0.113.0', endAddress: '203.0.113.255', events: [{ eventAction: 'registration', eventDate: '2001-01-01T00:00:00Z' }, { eventAction: 'last changed', eventDate: '2020-02-02T00:00:00Z' }] };
const abuse = { data: { abuseConfidenceScore: 87, totalReports: 12, numDistinctUsers: 5, lastReportedAt: '2026-11-19T10:00:00+00:00', isp: 'Example ISP', usageType: 'Data Center', domain: 'example.net', countryCode: 'US', isTor: false } };
const shodan = { ports: [22, 80], hostnames: ['host.example.net'], org: 'Example Org', os: null, vulns: ['CVE-2020-0001'], last_update: '2026-11-18T00:00:00' };

function route(url: string): Response {
  if (url.startsWith('https://rdap.org/')) return json(rdap);
  if (url.startsWith('https://api.abuseipdb.com/')) return json(abuse);
  if (url.startsWith('https://api.shodan.io/')) return json(shodan);
  return json({}, 500);
}

function build(options: { keys?: { abuseipdb?: string; shodan?: string }; fetch?: IntelFetch; now?: () => number } = {}) {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const fetchImpl: IntelFetch = options.fetch ?? (async (url, init) => { calls.push({ url, headers: init.headers }); return route(url); });
  const service = new IpIntelService({ keys: () => options.keys ?? {}, fetch: fetchImpl, now: options.now });
  const app = new Hono();
  registerIpIntelRoutes({ app, basePath: '/crowdsec', auth: { ensureAuth: async (_context: unknown, next: () => Promise<void>) => { await next(); } } as never, service });
  return { app, service, calls };
}

const get = async (app: Hono, path: string): Promise<Response> => await app.request(`http://localhost/crowdsec/api/ip-intel${path}`);

describe('parsers', () => {
  test('whois reads the RDAP summary and dates', () => {
    expect(parseWhois(rdap)).toEqual({ name: 'EXAMPLE-NET', handle: 'NET-1', country: 'US', type: 'ALLOCATED PA', start_address: '203.0.113.0', end_address: '203.0.113.255', registered_at: '2001-01-01T00:00:00Z', last_changed_at: '2020-02-02T00:00:00Z' });
    expect(parseWhois(null)).toMatchObject({ name: null, registered_at: null });
  });
  test('abuseipdb and shodan tolerate missing fields', () => {
    expect(parseAbuseIpdb(abuse)).toMatchObject({ abuse_confidence_score: 87, total_reports: 12, distinct_reporters: 5, is_tor: false });
    expect(parseAbuseIpdb({})).toMatchObject({ abuse_confidence_score: 0, isp: null });
    expect(parseShodan(shodan)).toMatchObject({ ports: [22, 80], hostnames: ['host.example.net'], vulnerabilities: ['CVE-2020-0001'], os: null });
    expect(parseShodan({ ports: 'x', vulns: [1, 'CVE-1'] })).toMatchObject({ ports: [], vulnerabilities: ['CVE-1'] });
  });
});

describe('isPrivateAddress', () => {
  test.each(['10.0.0.1', '127.0.0.1', '192.168.1.1', '172.16.5.5', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'garbage'])('%s is private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
  test.each(['8.8.8.8', '203.0.113.9', '172.32.0.1', '2001:db8::1'])('%s is public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('lookup', () => {
  test('uses whois alone when no keys are configured', async () => {
    const { app, calls } = build();
    const body = await get(app, '?ip=203.0.113.9').then((response) => response.json()) as any;
    expect(body.whois.status).toBe('ok');
    expect(body.abuseipdb).toEqual({ status: 'not_configured' });
    expect(body.shodan).toEqual({ status: 'not_configured' });
    expect(calls).toHaveLength(1);
  });

  test('queries every source with keys, sends keys only upstream, and never returns them', async () => {
    const { app, calls } = build({ keys: { abuseipdb: SECRET_ABUSE, shodan: SECRET_SHODAN } });
    const response = await get(app, '?ip=203.0.113.9');
    const raw = await response.text();
    expect(raw).not.toContain(SECRET_ABUSE);
    expect(raw).not.toContain(SECRET_SHODAN);
    const body = JSON.parse(raw);
    expect(body.abuseipdb).toMatchObject({ status: 'ok', data: { abuse_confidence_score: 87 } });
    expect(body.shodan).toMatchObject({ status: 'ok', data: { ports: [22, 80] } });
    expect(calls.find((call) => call.url.includes('abuseipdb'))?.headers?.Key).toBe(SECRET_ABUSE);
    expect(calls.find((call) => call.url.includes('shodan'))?.url).toContain(`key=${SECRET_SHODAN}`);
  });

  test('reports source failures without URLs or keys and does not cache them', async () => {
    let failing = true;
    const fetchImpl: IntelFetch = async (url) => {
      if (url.includes('shodan')) return failing ? json({}, 401) : json(shodan);
      if (url.includes('abuseipdb')) throw new Error(`boom for ${url} with ${SECRET_ABUSE}`);
      return json(rdap);
    };
    const { app } = build({ keys: { abuseipdb: SECRET_ABUSE, shodan: SECRET_SHODAN }, fetch: fetchImpl });
    const raw = await get(app, '?ip=203.0.113.9').then((response) => response.text());
    expect(raw).not.toContain(SECRET_ABUSE);
    expect(raw).not.toContain(SECRET_SHODAN);
    const body = JSON.parse(raw);
    expect(body.abuseipdb).toEqual({ status: 'error', error: 'request failed' });
    expect(body.shodan).toEqual({ status: 'error', error: 'the API key was rejected' });
    expect(body.cached).toBe(false);
    failing = false;
    const retry = await get(app, '?ip=203.0.113.9').then((response) => response.json()) as any;
    expect(retry.shodan.status).toBe('ok');
  });

  test('maps 404 to not_found and 429 to a rate limit message', async () => {
    const fetchImpl: IntelFetch = async (url) => (url.includes('shodan') ? json({}, 404) : url.includes('rdap') ? json({}, 429) : json(abuse));
    const { app } = build({ keys: { abuseipdb: SECRET_ABUSE, shodan: SECRET_SHODAN }, fetch: fetchImpl });
    const body = await get(app, '?ip=203.0.113.9').then((response) => response.json()) as any;
    expect(body.shodan).toEqual({ status: 'not_found' });
    expect(body.whois).toEqual({ status: 'error', error: 'rate limit reached' });
  });

  test('caches successful lookups for an hour', async () => {
    let now = 1_000_000;
    const { app, calls } = build({ now: () => now });
    await get(app, '?ip=203.0.113.9');
    const second = await get(app, '?ip=203.0.113.9').then((response) => response.json()) as any;
    expect(second.cached).toBe(true);
    expect(calls).toHaveLength(1);
    now += 61 * 60 * 1000;
    const third = await get(app, '?ip=203.0.113.9').then((response) => response.json()) as any;
    expect(third.cached).toBe(false);
    expect(calls).toHaveLength(2);
  });

  test('rejects invalid and private addresses before contacting anyone', async () => {
    const fetchSpy = vi.fn<IntelFetch>();
    const { app } = build({ fetch: fetchSpy });
    expect((await get(app, '?ip=nope')).status).toBe(400);
    expect((await get(app, '?ip=203.0.113.0/24')).status).toBe(400);
    expect((await get(app, '?ip=10.1.2.3')).status).toBe(400);
    expect((await get(app, '')).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('limits lookups per minute', async () => {
    let now = 5_000_000;
    const { app } = build({ now: () => now });
    for (let index = 0; index < 30; index += 1) expect((await get(app, `?ip=203.0.113.${index}`)).status).toBe(200);
    expect((await get(app, '?ip=203.0.113.200')).status).toBe(429);
    now += 61_000;
    expect((await get(app, '?ip=203.0.113.200')).status).toBe(200);
  });

  test('says which sources are configured without exposing keys', async () => {
    const { app } = build({ keys: { shodan: SECRET_SHODAN } });
    const raw = await get(app, '/sources').then((response) => response.text());
    expect(JSON.parse(raw)).toEqual({ whois: true, abuseipdb: false, shodan: true });
    expect(raw).not.toContain(SECRET_SHODAN);
  });
});
