import { describe, expect, test, vi } from 'vitest';
import type { LapiStatus } from '../../../shared/contracts';
import { createAlert, createDecision, createService, insertAlert, insertDecision } from './harness';

describe('application update notifications', () => {
  test('application update rules keep only the notification for the current target version', async () => {
    let remoteVersion = '2.0.0';
    const { database, service } = createService({
      updateChecker: async () => ({
        update_available: true,
        local_version: '1.0.0',
        remote_version: remoteVersion,
      }),
    });

    const rule = await service.createRule({
      name: 'App updates',
      type: 'application-update',
      enabled: true,
      severity: 'info',
      channel_ids: [],
      config: {},
    });

    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));
    await service.evaluateRules(new Date('2026-03-28T12:30:00.000Z'));
    expect(service.listNotifications().data).toHaveLength(1);
    expect(database.listNotificationIncidentsByRule(rule.id)).toEqual([
      expect.objectContaining({ incident_key: 'application-update:2.0.0', resolved_at: null }),
    ]);

    remoteVersion = '2.1.0';
    await service.evaluateRules(new Date('2026-03-28T13:00:00.000Z'));
    expect(service.listNotifications().data).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({ remote_version: '2.1.0' }),
      }),
    ]);
    expect(database.listNotificationIncidentsByRule(rule.id)).toEqual([
      expect.objectContaining({ incident_key: 'application-update:2.0.0', resolved_at: '2026-03-28T13:00:00.000Z' }),
      expect.objectContaining({ incident_key: 'application-update:2.1.0', resolved_at: null }),
    ]);

    database.close();
  });

  test('removes the in-app notification after the installed version catches up', async () => {
    let updateAvailable = true;
    const { database, service } = createService({
      updateChecker: async () => ({
        update_available: updateAvailable,
        local_version: updateAvailable ? '2026.7.15' : '2026.7.17',
        remote_version: '2026.7.17',
      }),
    });

    const rule = await service.createRule({
      name: 'App updates',
      type: 'application-update',
      enabled: true,
      severity: 'info',
      channel_ids: [],
      config: {},
    });

    await service.evaluateRules(new Date('2026-07-22T12:00:00.000Z'));
    expect(service.listNotifications()).toMatchObject({
      data: [expect.objectContaining({ rule_type: 'application-update' })],
      unread_count: 1,
    });

    updateAvailable = false;
    await service.evaluateRules(new Date('2026-07-22T12:05:00.000Z'));

    expect(service.listNotifications()).toMatchObject({ data: [], unread_count: 0 });
    expect(database.listNotificationIncidentsByRule(rule.id)).toEqual([
      expect.objectContaining({
        incident_key: 'application-update:2026.7.17',
        resolved_at: '2026-07-22T12:05:00.000Z',
      }),
    ]);

    database.close();
  });

});
