import { describe, expect, test } from 'vitest';
import { classifyOrigin, summarizeBlocklists } from '../../app/blocklists';
import { createController } from './harness';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const hours = (offset: number) => new Date(NOW + offset * 3_600_000).toISOString();

let counter = 0;
function insert(database: ReturnType<typeof createController>['controller']['database'], options: { origin: string; scenario: string; value: string; stopInHours: number; simulated?: boolean }) {
  database.db.query(`INSERT INTO decisions (id, created_at, stop_at, value, type, origin, scenario, scope, simulated) VALUES (?, ?, ?, ?, 'ban', ?, ?, 'Ip', ?)`)
    .run(`bl-${counter++}`, hours(-2), hours(options.stopInHours), options.value, options.origin, options.scenario, options.simulated ? 1 : 0);
}

describe('classifyOrigin', () => {
  test('separates the community list, subscribed lists and local decisions', () => {
    expect(classifyOrigin('CAPI')).toBe('community');
    expect(classifyOrigin('lists')).toBe('subscribed');
    expect(classifyOrigin('lists:firehol_greensnow')).toBe('subscribed');
    expect(classifyOrigin('crowdsec')).toBe('local');
    expect(classifyOrigin('cscli')).toBe('local');
  });
});

describe('summarizeBlocklists', () => {
  test('groups decisions by origin with a per-list breakdown and active counts', () => {
    const { controller } = createController();
    const { database } = controller;
    insert(database, { origin: 'crowdsec', scenario: 'crowdsecurity/ssh-bf', value: '203.0.113.1', stopInHours: 2 });
    insert(database, { origin: 'crowdsec', scenario: 'crowdsecurity/ssh-bf', value: '203.0.113.2', stopInHours: -1 });
    insert(database, { origin: 'CAPI', scenario: 'crowdsecurity/community-blocklist', value: '198.51.100.1', stopInHours: 5 });
    insert(database, { origin: 'CAPI', scenario: 'crowdsecurity/community-blocklist', value: '198.51.100.2', stopInHours: 5 });
    insert(database, { origin: 'lists:firehol_greensnow', scenario: 'firehol_greensnow', value: '192.0.2.1', stopInHours: 5 });
    insert(database, { origin: 'lists', scenario: 'free_proxies', value: '192.0.2.2', stopInHours: 5 });
    insert(database, { origin: 'crowdsec', scenario: 'crowdsecurity/ssh-bf', value: '203.0.113.9', stopInHours: 5, simulated: true });

    const overview = summarizeBlocklists(database, NOW);
    expect(overview.manageable).toBe(false);
    expect(overview.origins.map((origin) => [origin.origin, origin.kind, origin.active, origin.total])).toEqual([
      ['CAPI', 'community', 2, 2],
      ['lists', 'subscribed', 1, 1],
      ['lists:firehol_greensnow', 'subscribed', 1, 1],
      ['crowdsec', 'local', 1, 2],
    ]);
    expect(overview.origins[0].lists).toEqual([{ name: 'crowdsecurity/community-blocklist', active: 2, total: 2, unique_values: 2 }]);
    expect(overview.origins[1].lists[0].name).toBe('free_proxies');
    expect(overview.origins[2].lists[0].name).toBe('firehol_greensnow');
    expect(overview.origins[3].lists).toEqual([]);
  });

  test('is empty without decisions and served over the API', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'false' } });
    expect(summarizeBlocklists(controller.database, NOW).origins).toEqual([]);
    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/blocklists'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ origins: [], manageable: false });
  });

  test('requires authentication when enabled', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
    expect((await controller.fetch(new Request('http://localhost/crowdsec/api/blocklists'))).status).toBe(401);
  });
});
