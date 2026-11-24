import { describe, expect, test } from 'vitest';
import { IpIntelService } from '../../app/ip-intel';
import { computeThreatScore, levelOf, scenarioSeverity, scoreAddress } from '../../app/threat-score';
import { createAuthSessionCookie, createController, sampleAlert, seedAlert } from './harness';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const base = { alerts: 0, scenarios: [], episodes: 0, abuseScore: null };

describe('scenario severity', () => {
  test.each([
    ['crowdsecurity/CVE-2025-29927', 1], ['crowdsecurity/ssh-bf', 0.8], ['crowdsecurity/http-sqli-probing-detection', 0.7],
    ['crowdsecurity/http-crawl-non_statics', 0.7], ['crowdsecurity/http-probing', 0.4], ['custom/unknown', 0.5],
  ])('%s -> %s', (name, expected) => expect(scenarioSeverity(name)).toBe(expected));
});

describe('computeThreatScore', () => {
  test('a quiet address scores zero', () => {
    const result = computeThreatScore('203.0.113.1', base);
    expect(result).toMatchObject({ score: 0, level: 'low', reputation_available: false });
    expect(result.factors.map((factor) => factor.points)).toEqual([0, 0, 0, 0]);
  });

  test('volume grows on a log scale and caps', () => {
    const points = (alerts: number) => computeThreatScore('x', { ...base, alerts }).factors[0]!.points;
    expect(points(1)).toBeGreaterThan(0);
    expect(points(10)).toBeGreaterThan(points(1));
    expect(points(100)).toBe(35);
    expect(points(100000)).toBe(35);
  });

  test('severity uses the worst scenario plus a bonus for variety', () => {
    const severity = (scenarios: string[]) => computeThreatScore('x', { ...base, scenarios }).factors[1]!.points;
    expect(severity(['crowdsecurity/http-probing'])).toBe(8);
    expect(severity(['crowdsecurity/CVE-2025-1'])).toBe(20);
    expect(severity(['a-cve-1', 'b', 'c', 'd', 'e'])).toBe(25);
  });

  test('repeat behaviour steps up with every extra episode', () => {
    const repeat = (episodes: number) => computeThreatScore('x', { ...base, episodes }).factors[2]!.points;
    expect([0, 1, 2, 3, 4, 5, 9].map(repeat)).toEqual([0, 5, 12, 16, 16, 20, 20]);
  });

  test('reputation counts only when known, and the score is scaled otherwise', () => {
    const worst = { alerts: 500, scenarios: ['crowdsecurity/CVE-2025-1', 'a', 'b', 'c', 'd'], episodes: 6 };
    const without = computeThreatScore('x', { ...worst, abuseScore: null });
    expect(without.score).toBe(100);
    expect(without.reputation_available).toBe(false);
    const withLow = computeThreatScore('x', { ...worst, abuseScore: 0 });
    expect(withLow.score).toBe(80);
    expect(withLow.reputation_available).toBe(true);
    expect(computeThreatScore('x', { ...worst, abuseScore: 100 }).score).toBe(100);
    expect(computeThreatScore('x', { ...worst, abuseScore: 250 }).factors[3]!.points).toBe(20);
    expect(computeThreatScore('x', { ...worst, abuseScore: -5 }).factors[3]!.points).toBe(0);
  });

  test('levels', () => {
    expect([0, 24, 25, 49, 50, 74, 75, 100].map(levelOf)).toEqual(['low', 'low', 'medium', 'medium', 'high', 'high', 'critical', 'critical']);
  });
});

describe('scoreAddress', () => {
  test('reads alerts, scenarios and ban history from the cache', () => {
    const { controller } = createController();
    const database = controller.database;
    let id = 9000;
    const seed = (scenario: string, daysAgo: number, ip = '203.0.113.50', simulated = false) => {
      id += 1;
      const created = new Date(NOW - daysAgo * 86_400_000).toISOString();
      seedAlert(database, sampleAlert({
        id, uuid: `ts-${id}`, created_at: created, scenario, simulated, source: { ip, value: ip, cn: 'DE' },
        decisions: [{ id: id * 10, type: 'ban', value: ip, duration: '4h', created_at: created, stop_at: new Date(NOW - daysAgo * 86_400_000 + 4 * 3_600_000).toISOString(), origin: 'crowdsec', simulated: false }],
      }));
    };
    seed('crowdsecurity/ssh-bf', 1);
    seed('crowdsecurity/ssh-bf', 3);
    seed('crowdsecurity/CVE-2025-1', 5);
    seed('crowdsecurity/ssh-bf', 90);
    seed('crowdsecurity/ssh-bf', 1, '203.0.113.99');
    const result = scoreAddress(database, '203.0.113.50', { now: NOW, abuseScore: 40 });
    const [volume, severity, repeat, reputation] = result.factors;
    expect(volume!.value).toBe(3);
    expect(severity!.value).toBe(2);
    expect(repeat!.value).toBeGreaterThanOrEqual(2);
    expect(reputation!.points).toBe(8);
    expect(result.score).toBeGreaterThan(40);
    expect(scoreAddress(database, '198.51.100.250', { now: NOW }).score).toBe(0);
  });
});

describe('IP intel peek', () => {
  test('never calls out and only returns a cached AbuseIPDB score', async () => {
    const calls: string[] = [];
    const service = new IpIntelService({
      keys: () => ({ abuseipdb: 'k' }),
      fetch: async (url) => {
        calls.push(url);
        const body = url.includes('abuseipdb') ? { data: { abuseConfidenceScore: 77, totalReports: 3, numDistinctUsers: 2, isTor: false } } : {};
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });
    expect(service.peekAbuseScore('203.0.113.7')).toBeNull();
    expect(calls).toEqual([]);
    await service.lookup('203.0.113.7');
    const after = calls.length;
    expect(service.peekAbuseScore('203.0.113.7')).toBe(77);
    expect(calls.length).toBe(after);
  });
});

describe('threat score API', () => {
  const root = 'http://localhost/crowdsec/api';
  test('validates input and scores in batches', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
    const id = controller.database.createAuthUser({ username: 'a', passwordHash: 'h', role: 'read-only', authProvider: 'password' });
    const cookie = createAuthSessionCookie(controller.database, { userId: id, username: 'a', role: 'read-only', authMethod: 'password' });
    const get = (path: string, withCookie = true) => controller.fetch(new Request(`${root}${path}`, { headers: withCookie ? { cookie } : {} }));
    expect((await get('/threat-score?ip=203.0.113.1', false)).status).toBe(401);
    expect((await get('/threat-score?ip=nope')).status).toBe(400);
    expect((await get('/threat-scores?ips=')).status).toBe(400);
    expect((await get('/threat-scores?ips=1.2.3.4,bad')).status).toBe(400);
    expect((await get(`/threat-scores?ips=${Array.from({ length: 101 }, (_, i) => `10.0.0.${i}`).join(',')}`)).status).toBe(400);
    const single = await (await get('/threat-score?ip=203.0.113.1')).json() as { score: number; level: string };
    expect(single).toMatchObject({ score: 0, level: 'low' });
    const batch = await (await get('/threat-scores?ips=203.0.113.1,203.0.113.1,2001:DB8::1')).json() as { scores: Array<{ ip: string }> };
    expect(batch.scores.map((entry) => entry.ip)).toEqual(['203.0.113.1', '2001:db8::1']);
  });
});
