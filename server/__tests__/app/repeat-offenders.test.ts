import { describe, expect, test } from 'vitest';
import { checkOffender, countEpisodes, findRepeatOffenders } from '../../app/repeat-offenders';
import { escalateDuration, formatDurationMs } from '../../../shared/escalation';
import { createController, sampleAlert, seedAlert } from './harness';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

let nextId = 100;
function seedBan(database: Parameters<typeof seedAlert>[0], ip: string, startHoursAgo: number, endHoursAgo: number, scenario = 'crowdsecurity/ssh-bf') {
  const id = nextId++;
  seedAlert(database, sampleAlert({
    id,
    uuid: `alert-${id}`,
    created_at: iso(startHoursAgo),
    scenario,
    source: { ip, value: ip, cn: 'DE' },
    decisions: [{ id: id * 10, type: 'ban', value: ip, duration: '1h', created_at: iso(startHoursAgo), stop_at: iso(endHoursAgo), origin: 'crowdsec', simulated: false }],
  }));
}

describe('countEpisodes', () => {
  const hour = 3_600_000;
  test('merges overlapping and touching bans into one episode', () => {
    expect(countEpisodes([{ start: 0, end: hour }, { start: hour / 2, end: 2 * hour }, { start: 2 * hour, end: 3 * hour }])).toEqual({ episodes: 1, firstStart: 0, lastEnd: 3 * hour });
  });

  test('counts a ban that starts after the previous one ended as a new episode', () => {
    expect(countEpisodes([{ start: 5 * hour, end: 6 * hour }, { start: 0, end: hour }, { start: 10 * hour, end: 11 * hour }])).toMatchObject({ episodes: 3, firstStart: 0, lastEnd: 11 * hour });
  });

  test('handles empty and invalid input', () => {
    expect(countEpisodes([])).toBeNull();
    expect(countEpisodes([{ start: Number.NaN, end: 1 }])).toBeNull();
  });
});

describe('escalateDuration', () => {
  test('doubles with every earlier ban and respects the cap', () => {
    expect(escalateDuration(0)).toBe('4h');
    expect(escalateDuration(1)).toBe('8h');
    expect(escalateDuration(2)).toBe('16h');
    expect(escalateDuration(3)).toBe('32h');
    expect(escalateDuration(4)).toBe('64h');
    expect(escalateDuration(6)).toBe('256h');
    expect(escalateDuration(20)).toBe('30d');
    expect(escalateDuration(2, '1d', '5d')).toBe('4d');
    expect(escalateDuration(5, '1d', '5d')).toBe('5d');
  });

  test('falls back to the default for unusable input', () => {
    expect(escalateDuration(2, 'abc')).toBe('4h');
    expect(escalateDuration(-3)).toBe('4h');
    expect(escalateDuration(2, '1h', 'nonsense')).toBe('1h');
  });

  test('formats with the largest whole unit', () => {
    expect(formatDurationMs(86_400_000)).toBe('1d');
    expect(formatDurationMs(7_200_000)).toBe('2h');
    expect(formatDurationMs(90_000)).toBe('90s');
    expect(formatDurationMs(120_000)).toBe('2m');
  });
});

describe('repeat offenders', () => {
  test('flags only addresses banned again after an earlier ban ended', () => {
    const { controller } = createController();
    const { database } = controller;
    // Came back twice after bans ended.
    seedBan(database, '203.0.113.1', 30, 29);
    seedBan(database, '203.0.113.1', 20, 19, 'crowdsecurity/http-probing');
    seedBan(database, '203.0.113.1', 2, -1);
    // Two overlapping decisions: still a single episode.
    seedBan(database, '203.0.113.2', 10, 8);
    seedBan(database, '203.0.113.2', 9, 7);
    // Banned once.
    seedBan(database, '203.0.113.3', 5, 4);

    const offenders = findRepeatOffenders(database, { now: NOW });
    expect(offenders.map((offender) => offender.ip)).toEqual(['203.0.113.1']);
    expect(offenders[0]).toMatchObject({
      episodes: 3,
      banned_now: true,
      country: 'DE',
      scenarios: ['crowdsecurity/ssh-bf', 'crowdsecurity/http-probing'],
      suggested_duration: '32h',
    });
    expect(offenders[0].first_ban_at).toBe(iso(30));
    expect(findRepeatOffenders(database, { now: NOW, minEpisodes: 4 })).toEqual([]);

    expect(checkOffender(database, '203.0.113.3', { now: NOW })).toMatchObject({ episodes: 1, banned_now: false, suggested_duration: '8h' });
    expect(checkOffender(database, '203.0.113.99', { now: NOW })).toBeNull();
  });

  test('ignores simulated bans', () => {
    const { controller } = createController();
    for (const [start, end] of [[10, 9], [5, 4]]) {
      const id = nextId++;
      seedAlert(controller.database, sampleAlert({
        id, uuid: `alert-${id}`, created_at: iso(start),
        source: { ip: '203.0.113.7', value: '203.0.113.7' },
        decisions: [{ id: id * 10, type: 'ban', value: '203.0.113.7', duration: '1h', created_at: iso(start), stop_at: iso(end), simulated: true }],
      }));
    }
    expect(findRepeatOffenders(controller.database, { now: NOW })).toEqual([]);
  });

  test('serves offenders and per-IP checks to signed-in users', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'false' } });
    seedBan(controller.database, '198.51.100.9', 40, 39);
    seedBan(controller.database, '198.51.100.9', 10, 9);
    const get = async (path: string): Promise<Response> => await controller.fetch(new Request(`http://localhost/crowdsec/api/repeat-offenders${path}`));

    const list = await get('').then((response) => response.json()) as { offenders: Array<{ ip: string; episodes: number }> };
    expect(list.offenders).toMatchObject([{ ip: '198.51.100.9', episodes: 2 }]);
    const check = await get('/check?ip=198.51.100.9').then((response) => response.json()) as { repeat_offender: boolean; previous_bans: number };
    expect(check).toMatchObject({ repeat_offender: true, previous_bans: 2 });
    const clean = await get('/check?ip=198.51.100.10').then((response) => response.json()) as { repeat_offender: boolean; previous_bans: number };
    expect(clean).toMatchObject({ repeat_offender: false, previous_bans: 0 });
    expect((await get('/check?ip=bogus')).status).toBe(400);
    expect((await get('/check?ip=198.51.100.0/24')).status).toBe(400);
  });

  test('requires authentication when it is enabled', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/repeat-offenders'));
    expect(response.status).toBe(401);
  });
});
