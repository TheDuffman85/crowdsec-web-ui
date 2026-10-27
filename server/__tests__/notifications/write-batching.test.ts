import { expect, test } from 'vitest';
import { createNotificationService } from '../../notifications';
import { createNotificationSecretStore } from '../../notifications/secret-store';
import { createDecision, createTestDatabase, insertDecision } from './harness';

test('batches incident and history writes into bounded transactions', async () => {
  const database = createTestDatabase();
  let writes = 0;
  const service = createNotificationService({
    database,
    writeDatabase: async (operation) => {
      writes += 1;
      return operation();
    },
    outboundGuard: { assertHostAllowed: async () => {}, assertUrlAllowed: async () => {} },
    secretStore: createNotificationSecretStore(),
  });
  const rule = await service.createRule({
    name: 'Ban watch',
    type: 'ip-ban',
    enabled: true,
    severity: 'info',
    channel_ids: [],
    config: { window_minutes: 60, filters: {} },
  });
  for (let index = 0; index < 250; index += 1) {
    insertDecision(database, createDecision(`decision-${index}`, '2026-03-28T11:55:00.000Z', { value: `192.0.2.${index}` }));
  }

  writes = 0;
  await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));
  expect(database.listNotificationIncidentsByRule(rule.id)).toHaveLength(250);
  expect(database.countNotifications()).toBe(250);
  expect(writes).toBe(3);

  // Existing incidents only refresh last_seen_at, still in batches.
  writes = 0;
  await service.evaluateRules(new Date('2026-03-28T12:05:00.000Z'));
  expect(database.countNotifications()).toBe(250);
  expect(database.listNotificationIncidentsByRule(rule.id).every((incident) => incident.last_seen_at === '2026-03-28T12:05:00.000Z')).toBe(true);
  expect(writes).toBe(3);

  database.close();
});

test('yields to timers between batches of new notifications', async () => {
  const database = createTestDatabase();
  let writes = 0;
  let timerFired = false;
  let timerFiredBeforeLastBatch = false;
  const service = createNotificationService({
    database,
    writeDatabase: async (operation) => {
      writes += 1;
      if (writes === 10) timerFiredBeforeLastBatch = timerFired;
      return operation();
    },
    outboundGuard: { assertHostAllowed: async () => {}, assertUrlAllowed: async () => {} },
    secretStore: createNotificationSecretStore(),
  });
  await service.createRule({
    name: 'Ban watch',
    type: 'ip-ban',
    enabled: true,
    severity: 'info',
    channel_ids: [],
    config: { window_minutes: 60, filters: {} },
  });
  database.transaction<void>(() => {
    for (let index = 0; index < 1_000; index += 1) {
      insertDecision(database, createDecision(`decision-${index}`, '2026-03-28T11:55:00.000Z', {
        value: `10.0.${Math.floor(index / 250)}.${index % 250}`,
      }));
    }
  })(undefined);

  writes = 0;
  setTimeout(() => {
    timerFired = true;
  }, 0);
  await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));

  expect(database.countNotifications()).toBe(1_000);
  expect(writes).toBe(10);
  expect(timerFiredBeforeLastBatch).toBe(true);

  database.close();
});
