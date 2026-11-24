import { describe, expect, test } from 'vitest';
import { asnDetail, listAsns, normalizeAsn } from '../../app/asn';
import { createAuthSessionCookie, createController, sampleAlert, seedAlert } from './harness';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const at = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();

function seed() {
  const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
  const database = controller.database;
  let id = 7000;
  const add = (ip: string, asn: string | number | undefined, name: string, scenario: string, daysAgo: number, extra: Record<string, unknown> = {}) => {
    id += 1;
    seedAlert(database, sampleAlert({
      id, uuid: `asn-${id}`, created_at: at(daysAgo), scenario,
      source: { ip, value: ip, cn: 'NL', as_name: name, as_number: asn, range: `${ip.split('.').slice(0, 3).join('.')}.0/24` },
      decisions: [], ...extra,
    } as never));
  };
  add('203.0.113.1', '64500', 'Example Hosting', 'crowdsecurity/ssh-bf', 1);
  add('203.0.113.1', '64500', 'Example Hosting', 'crowdsecurity/ssh-bf', 2);
  add('203.0.113.2', '64500', 'Example Hosting', 'crowdsecurity/http-probing', 3);
  add('198.51.100.7', '64501', 'Other Net', 'crowdsecurity/ssh-bf', 4);
  add('192.0.2.9', '0', 'Unknown', 'crowdsecurity/ssh-bf', 1);
  add('192.0.2.10', undefined, 'Unknown', 'crowdsecurity/ssh-bf', 1);
  add('203.0.113.3', '64500', 'Example Hosting', 'crowdsecurity/ssh-bf', 90);
  add('203.0.113.4', '64500', 'Example Hosting', 'crowdsecurity/ssh-bf', 1, { simulated: true });
  seedAlert(database, sampleAlert({
    id: 7100, uuid: 'asn-ban', created_at: at(1), source: { ip: '203.0.113.2', value: '203.0.113.2', cn: 'NL', as_name: 'Example Hosting', as_number: '64500' },
    decisions: [{ id: 71000, type: 'ban', value: '203.0.113.2', duration: '4h', created_at: at(1), stop_at: new Date(NOW + 3_600_000).toISOString(), origin: 'crowdsec', simulated: false }],
  } as never));
  return { controller, database };
}

describe('normalizeAsn', () => {
  test.each([['64500', '64500'], ['AS64500', '64500'], [' as13335 ', '13335'], ['0', null], ['', null], ['abc', null], ['12; DROP', null], ['12345678901', null], [undefined, null]])('%s', (input, expected) => {
    expect(normalizeAsn(input as string | undefined)).toBe(expected);
  });
});

describe('listAsns', () => {
  test('groups by AS, skips unknown and simulated, and applies the period', () => {
    const { database } = seed();
    const result = listAsns(database, { now: NOW });
    expect(result.asns.map((entry) => entry.asn)).toEqual(['64500', '64501']);
    expect(result.unknown_alerts).toBe(2);
    const first = result.asns[0]!;
    expect(first).toMatchObject({ name: 'Example Hosting', alerts: 4, unique_ips: 2 });
    expect(first.scenarios[0]).toEqual({ name: 'crowdsecurity/ssh-bf', count: 3 });
    expect(first.countries).toEqual([{ code: 'NL', count: 4 }]);
    expect(first.ranges.map((range) => range.range)).toContain('203.0.113.0/24');
    expect(listAsns(database, { now: NOW, days: 365 }).asns[0]!.alerts).toBe(5);
    expect(listAsns(database, { now: NOW, limit: 1 }).asns).toHaveLength(1);
  });

  test('is empty without data', () => {
    const { controller } = createController();
    expect(listAsns(controller.database)).toEqual({ asns: [], unknown_alerts: 0, days: 30 });
  });
});

describe('asnDetail', () => {
  test('lists addresses with scenarios and ban state', () => {
    const { database } = seed();
    const detail = asnDetail(database, '64500', { now: NOW })!;
    expect(detail).toMatchObject({ asn: '64500', alerts: 4, unique_ips: 2, truncated: false });
    expect(detail.ips.map((ip) => ip.ip)).toEqual(['203.0.113.1', '203.0.113.2']);
    expect(detail.ips[0]).toMatchObject({ alerts: 2, scenarios: ['crowdsecurity/ssh-bf'], banned_now: false });
    expect(detail.ips[1]).toMatchObject({ banned_now: true });
    expect(detail.ranges[0]).toMatchObject({ range: '203.0.113.0/24' });
    expect(detail.scenarios[0]).toEqual({ name: 'crowdsecurity/ssh-bf', count: 3 });
    expect(asnDetail(database, '99999', { now: NOW })).toBeNull();
  });
});

describe('ASN API', () => {
  test('needs a session, validates the AS number and returns data', async () => {
    const { controller } = seed();
    const id = controller.database.createAuthUser({ username: 'v', passwordHash: 'h', role: 'read-only', authProvider: 'password' });
    const cookie = createAuthSessionCookie(controller.database, { userId: id, username: 'v', role: 'read-only', authMethod: 'password' });
    const get = (path: string, withCookie = true) => controller.fetch(new Request(`http://localhost/crowdsec/api/asn${path}`, { headers: withCookie ? { cookie } : {} }));
    expect((await get('', false)).status).toBe(401);
    expect((await get('/nope')).status).toBe(400);
    expect((await get('/64999')).status).toBe(404);
    const list = await (await get('?days=9999&limit=0')).json() as { asns: unknown[]; days: number };
    expect(list.days).toBe(365);
    expect(list.asns.length).toBeGreaterThan(0);
    const detail = await (await get('/AS64500?days=30')).json() as { asn: string; ips: unknown[] };
    expect(detail.asn).toBe('64500');
    expect(detail.ips).toHaveLength(2);
  });
});
