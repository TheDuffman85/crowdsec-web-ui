import { afterEach, describe, expect, test, vi } from 'vitest';
import { summarizeGeoBlocking } from '../../app/geo-blocking';
import { createController, destroyTempDir, sampleAlert, seedAlert } from './harness';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

let nextId = 500;
function seedCountryAlert(database: Parameters<typeof seedAlert>[0], ip: string, cn: string, hoursAgo: number, simulated = false) {
  const id = nextId++;
  seedAlert(database, sampleAlert({
    id, uuid: `geo-${id}`, created_at: iso(hoursAgo), source: { ip, value: ip, cn }, decisions: [], simulated,
  }));
}

function seedCountryDecision(database: Parameters<typeof seedAlert>[0], code: string, stopHoursFromNow: number) {
  database.db.query(`INSERT INTO decisions (id, created_at, stop_at, value, type, scope, simulated) VALUES (?, ?, ?, ?, 'ban', 'Country', 0)`)
    .run(`country-${code}-${nextId++}`, iso(1), new Date(NOW + stopHoursFromNow * 3_600_000).toISOString(), code);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('summarizeGeoBlocking', () => {
  test('counts recent live alerts and distinct IPs per country', () => {
    const { controller } = createController();
    const { database } = controller;
    seedCountryAlert(database, '203.0.113.1', 'CN', 1);
    seedCountryAlert(database, '203.0.113.1', 'CN', 2);
    seedCountryAlert(database, '203.0.113.2', 'cn', 3);
    seedCountryAlert(database, '198.51.100.1', 'RU', 4);
    seedCountryAlert(database, '192.0.2.1', 'DE', 5);
    seedCountryAlert(database, '192.0.2.2', 'DE', 500); // outside the window
    seedCountryAlert(database, '192.0.2.3', 'FR', 2, true); // simulated

    const summary = summarizeGeoBlocking(database, { hours: 24, now: NOW });
    expect(summary).toMatchObject({ hours: 24, total_alerts: 5, blocked_countries: [] });
    expect(summary.countries).toEqual([
      { code: 'CN', alerts: 3, unique_ips: 2, blocked: false },
      { code: 'DE', alerts: 1, unique_ips: 1, blocked: false },
      { code: 'RU', alerts: 1, unique_ips: 1, blocked: false },
    ]);
  });

  test('marks countries that already have an active Country ban, including ones without recent alerts', () => {
    const { controller } = createController();
    const { database } = controller;
    seedCountryAlert(database, '203.0.113.1', 'CN', 1);
    seedCountryDecision(database, 'CN', 24);
    seedCountryDecision(database, 'KP', 24);
    seedCountryDecision(database, 'RU', -1); // already expired
    const summary = summarizeGeoBlocking(database, { hours: 24, now: NOW });
    expect(summary.blocked_countries).toEqual(['CN', 'KP']);
    expect(summary.countries).toEqual([
      { code: 'CN', alerts: 1, unique_ips: 1, blocked: true },
      { code: 'KP', alerts: 0, unique_ips: 0, blocked: true },
    ]);
  });

  test('clamps the window', () => {
    const { controller } = createController();
    expect(summarizeGeoBlocking(controller.database, { hours: 0, now: NOW }).hours).toBe(1);
    expect(summarizeGeoBlocking(controller.database, { hours: 999_999, now: NOW }).hours).toBe(24 * 90);
    expect(summarizeGeoBlocking(controller.database, { now: NOW }).hours).toBe(168);
  });
});

describe('geo-blocking API', () => {
  test('requires a signed-in user', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
    expect((await controller.fetch(new Request('http://localhost/crowdsec/api/geo-blocking'))).status).toBe(401);
  });

  test('serves the summary', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'false' } });
    seedCountryAlert(controller.database, '203.0.113.1', 'CN', 1);
    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/geo-blocking?hours=48'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ hours: 48, countries: [{ code: 'CN', alerts: 1 }] });
  });

  test('applies country blocks through bulk add with the Country scope and no allowlist lookup', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { controller, database, lapiClient, fetchCalls } = createController({
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
    });
    const alertPosts = () => fetchCalls.filter((call) => call.url.endsWith('/v1/alerts') && call.method === 'POST');
    const bulkAdd = async (body: Record<string, unknown>): Promise<Response> => await controller.fetch(new Request('http://localhost/crowdsec/api/decisions/bulk-add', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }));
    try {
      await lapiClient.login();
      expect((await bulkAdd({ values: ['china'], value_scope: 'country' })).status).toBe(400);
      expect((await bulkAdd({ values: ['cn'], value_scope: 'country' })).status).toBe(400);
      expect((await bulkAdd({ values: ['1.2.3.4'], value_scope: 'country' })).status).toBe(400);
      expect((await bulkAdd({ values: ['CN'], value_scope: 'planet' })).status).toBe(400);
      expect(alertPosts()).toHaveLength(0);

      const response = await bulkAdd({ values: ['CN', 'RU', 'CN'], value_scope: 'country', duration: '24h', reason: 'geo block' });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ added: ['CN', 'RU'], allowlisted: [], succeeded: 1, failed: 0 });
      expect(fetchCalls.some((call) => call.url.includes('/v1/allowlists/check/'))).toBe(false);
      const sent = alertPosts()[0].body as Array<{ source: { scope: string; value: string }; decisions: Array<{ scope: string; value: string; duration: string }> }>;
      expect(sent.map((alert) => alert.source)).toEqual([{ scope: 'Country', value: 'CN' }, { scope: 'Country', value: 'RU' }]);
      expect(sent.map((alert) => alert.decisions[0])).toMatchObject([{ scope: 'Country', value: 'CN', duration: '24h' }, { scope: 'Country', value: 'RU', duration: '24h' }]);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      logSpy.mockRestore();
      destroyTempDir();
    }
  });
});
