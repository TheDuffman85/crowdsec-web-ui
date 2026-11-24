import { describe, expect, test } from 'vitest';
import { hostDetail, listHosts } from '../../app/hosts';
import { createController, sampleAlert, seedAlert } from './harness';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

let nextId = 900;
function seed(database: Parameters<typeof seedAlert>[0], options: { machine?: string; hoursAgo: number; ip: string; scenario?: string; cn?: string; target?: string; simulated?: boolean; decisions?: boolean }) {
  const id = nextId++;
  seedAlert(database, sampleAlert({
    id,
    uuid: `host-${id}`,
    created_at: iso(options.hoursAgo),
    scenario: options.scenario ?? 'crowdsecurity/ssh-bf',
    machine_alias: options.machine,
    source: { ip: options.ip, value: options.ip, cn: options.cn ?? 'DE' },
    target: options.target ?? 'ssh',
    simulated: options.simulated ?? false,
    decisions: options.decisions
      ? [{ id: id * 10, type: 'ban', value: options.ip, duration: '4h', created_at: iso(options.hoursAgo), stop_at: new Date(NOW + 3_600_000).toISOString(), origin: 'crowdsec', simulated: false }]
      : [],
  }));
}

function seedFleet(database: Parameters<typeof seedAlert>[0]) {
  seed(database, { machine: 'web-1', hoursAgo: 1, ip: '203.0.113.1', decisions: true });
  seed(database, { machine: 'web-1', hoursAgo: 2, ip: '203.0.113.1', scenario: 'crowdsecurity/http-probing', target: 'nginx' });
  seed(database, { machine: 'web-1', hoursAgo: 30, ip: '203.0.113.2', cn: 'CN' });
  seed(database, { machine: 'web-1', hoursAgo: 24 * 20, ip: '203.0.113.3' });
  seed(database, { machine: 'web-1', hoursAgo: 1, ip: '203.0.113.4', simulated: true });
  seed(database, { machine: 'db-1', hoursAgo: 5, ip: '198.51.100.1' });
  seed(database, { hoursAgo: 5, ip: '198.51.100.2' }); // no machine reported
}

describe('hosts', () => {
  test('lists machines with windowed counts, busiest first', () => {
    const { controller } = createController();
    seedFleet(controller.database);
    const hosts = listHosts(controller.database, NOW);
    expect(hosts.map((host) => host.machine)).toEqual(['web-1', 'db-1']);
    expect(hosts[0]).toMatchObject({ alerts_total: 4, alerts_24h: 2, alerts_7d: 3, last_alert_at: iso(1) });
    expect(hosts[1]).toMatchObject({ alerts_total: 1, alerts_24h: 1, alerts_7d: 1 });
  });

  test('builds a zero-filled daily series and top lists for one machine', () => {
    const { controller } = createController();
    seedFleet(controller.database);
    const detail = hostDetail(controller.database, 'web-1', NOW)!;
    expect(detail.daily).toHaveLength(14);
    expect(detail.daily.at(-1)).toEqual({ date: '2026-11-20', count: 2 });
    expect(detail.daily.reduce((sum, day) => sum + day.count, 0)).toBe(3);
    expect(detail.active_decisions).toBe(1);
    expect(detail.top_scenarios).toEqual([{ name: 'crowdsecurity/ssh-bf', count: 3 }, { name: 'crowdsecurity/http-probing', count: 1 }]);
    expect(detail.top_sources[0]).toEqual({ name: '203.0.113.1', count: 2 });
    expect(detail.top_countries).toEqual([{ name: 'DE', count: 3 }, { name: 'CN', count: 1 }]);
    expect(detail.top_targets).toEqual([{ name: 'ssh', count: 4 }]);
    expect(detail.recent_alerts.map((alert) => alert.source_ip)).toEqual(['203.0.113.1', '203.0.113.1', '203.0.113.2', '203.0.113.3']);
    expect(hostDetail(controller.database, 'nope', NOW)).toBeNull();
  });

  test('serves hosts and details over the API', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'false' } });
    seed(controller.database, { machine: 'web 1/á', hoursAgo: 0.5, ip: '203.0.113.1' });
    const get = async (path: string): Promise<Response> => await controller.fetch(new Request(`http://localhost/crowdsec/api/hosts${path}`));

    expect((await get('').then((response) => response.json()) as { hosts: unknown[] }).hosts).toHaveLength(1);
    const detail = await get(`/detail?machine=${encodeURIComponent('web 1/á')}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ machine: 'web 1/á', alerts_total: 1 });
    expect((await get('/detail?machine=missing')).status).toBe(404);
    expect((await get('/detail')).status).toBe(400);
  });

  test('requires authentication when enabled', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
    expect((await controller.fetch(new Request('http://localhost/crowdsec/api/hosts'))).status).toBe(401);
  });
});
