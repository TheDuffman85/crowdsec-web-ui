import { describe, expect, test } from 'vitest';
import { liveFeedSnapshot } from '../../app/live-feed';
import { createController, sampleAlert, seedAlert } from './harness';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

let nextId = 700;
function seed(database: Parameters<typeof seedAlert>[0], minutesAgo: number, ip: string, extra: { cn?: string; scenario?: string; simulated?: boolean } = {}) {
  const id = nextId++;
  seedAlert(database, sampleAlert({
    id, uuid: `feed-${id}`, created_at: iso(minutesAgo), scenario: extra.scenario ?? 'crowdsecurity/ssh-bf',
    source: { ip, value: ip, cn: extra.cn ?? 'DE', latitude: 52.5, longitude: 13.4, as_name: 'Example AS' },
    decisions: [], simulated: extra.simulated ?? false,
  }));
}

describe('liveFeedSnapshot', () => {
  test('returns the newest live alerts first with headline counters', () => {
    const { controller } = createController();
    const { database } = controller;
    seed(database, 5, '203.0.113.1', { cn: 'CN' });
    seed(database, 30, '203.0.113.2', { cn: 'CN', scenario: 'crowdsecurity/http-probing' });
    seed(database, 120, '203.0.113.3');
    seed(database, 60 * 30, '203.0.113.4'); // older than a day
    seed(database, 1, '203.0.113.5', { simulated: true });

    const snapshot = liveFeedSnapshot(database, { now: NOW });
    expect(snapshot.alerts.map((alert) => alert.source_ip)).toEqual(['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4']);
    expect(snapshot.alerts[0]).toMatchObject({ country: 'CN', latitude: 52.5, longitude: 13.4, as_name: 'Example AS', scenario: 'crowdsecurity/ssh-bf' });
    expect(snapshot).toMatchObject({ last_hour: 2, last_24h: 3, server_time: new Date(NOW).toISOString() });
    expect(snapshot.top_countries).toEqual([{ name: 'CN', count: 2 }, { name: 'DE', count: 1 }]);
    expect(snapshot.top_scenarios[0]).toEqual({ name: 'crowdsecurity/ssh-bf', count: 2 });
  });

  test('only returns alerts after the cursor and honours the limit', () => {
    const { controller } = createController();
    const { database } = controller;
    for (let index = 0; index < 5; index += 1) seed(database, 50 - index * 10, `203.0.113.${index + 1}`);
    expect(liveFeedSnapshot(database, { since: iso(25), now: NOW }).alerts).toHaveLength(2);
    expect(liveFeedSnapshot(database, { since: iso(0), now: NOW }).alerts).toEqual([]);
    expect(liveFeedSnapshot(database, { limit: 2, now: NOW }).alerts.map((alert) => alert.source_ip)).toEqual(['203.0.113.5', '203.0.113.4']);
    expect(liveFeedSnapshot(database, { limit: 0, now: NOW }).alerts).toHaveLength(1);
  });

  test('serves the feed over the API and validates the cursor', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'false' } });
    seed(controller.database, 1, '203.0.113.1');
    const get = async (query: string): Promise<Response> => await controller.fetch(new Request(`http://localhost/crowdsec/api/live-feed${query}`));
    const ok = await get('?limit=5').then((response) => response.json()) as { alerts: unknown[] };
    expect(ok.alerts).toHaveLength(1);
    expect((await get('?since=yesterday-ish')).status).toBe(400);
    expect((await get(`?since=${encodeURIComponent(new Date().toISOString())}`)).status).toBe(200);
  });

  test('requires authentication when enabled', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
    expect((await controller.fetch(new Request('http://localhost/crowdsec/api/live-feed'))).status).toBe(401);
  });
});
