import { describe, expect, test, vi } from 'vitest';
import type { LapiStatus } from '../../../shared/contracts';
import { createAlert, createDecision, createService, insertAlert, insertDecision } from './harness';

describe('LAPI availability notifications', () => {
  test('lapi availability rules wait for the threshold, dedupe outages, and resolve silently by default', async () => {
    let lapiStatus: LapiStatus = {
      isConnected: false,
      lastCheck: '2026-03-28T12:00:00.000Z',
      lastError: 'Connection refused',
      offline_since: '2026-03-28T11:59:10.000Z',
    };
    const { database, service } = createService({
      getLapiStatus: () => lapiStatus,
    });

    const rule = await service.createRule({
      name: 'LAPI health',
      type: 'lapi-availability',
      enabled: true,
      severity: 'critical',
      channel_ids: [],
      config: {
        outage_threshold_seconds: 60,
        notify_on_recovery: false,
      },
    });

    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));
    expect(service.listNotifications().data).toHaveLength(0);

    lapiStatus = {
      ...lapiStatus,
      lastCheck: '2026-03-28T12:00:10.000Z',
    };
    await service.evaluateRules(new Date('2026-03-28T12:00:10.000Z'));
    expect(service.listNotifications().data).toEqual([
      expect.objectContaining({
        rule_type: 'lapi-availability',
        severity: 'critical',
        title: 'LAPI health: LAPI unavailable',
        metadata: expect.objectContaining({
          offline_since: '2026-03-28T11:59:10.000Z',
          last_error: 'Connection refused',
          outage_threshold_seconds: 60,
          outage_duration_seconds: 60,
        }),
      }),
    ]);
    expect(database.listNotificationIncidentsByRule(rule.id)).toEqual([
      expect.objectContaining({
        incident_key: 'lapi-availability:offline',
        first_seen_at: '2026-03-28T11:59:10.000Z',
        resolved_at: null,
      }),
    ]);

    lapiStatus = {
      ...lapiStatus,
      lastCheck: '2026-03-28T12:01:10.000Z',
    };
    await service.evaluateRules(new Date('2026-03-28T12:01:10.000Z'));
    expect(service.listNotifications().data).toHaveLength(1);

    lapiStatus = {
      isConnected: true,
      lastCheck: '2026-03-28T12:01:20.000Z',
      lastError: null,
      offline_since: null,
    };
    await service.evaluateRules(new Date('2026-03-28T12:01:20.000Z'));
    expect(service.listNotifications().data).toHaveLength(1);
    expect(database.listNotificationIncidentsByRule(rule.id)).toEqual([
      expect.objectContaining({
        incident_key: 'lapi-availability:offline',
        resolved_at: '2026-03-28T12:01:20.000Z',
      }),
    ]);

    lapiStatus = {
      isConnected: false,
      lastCheck: '2026-03-28T12:05:10.000Z',
      lastError: 'Connection refused',
      offline_since: '2026-03-28T12:04:00.000Z',
    };
    await service.evaluateRules(new Date('2026-03-28T12:05:10.000Z'));
    expect(service.listNotifications().data).toHaveLength(2);
    expect(service.listNotifications().data[0]).toEqual(expect.objectContaining({
      rule_type: 'lapi-availability',
      title: 'LAPI health: LAPI unavailable',
      metadata: expect.objectContaining({
        offline_since: '2026-03-28T12:04:00.000Z',
        outage_duration_seconds: 70,
      }),
    }));

    database.close();
  });

  test('multi-instance LAPI notifications identify each unavailable instance', async () => {
    const instances = [
      { id: 'primary', name: 'Primary' },
      { id: 'edge', name: 'Edge' },
    ];
    const offlineStatus: LapiStatus = {
      isConnected: false,
      lastCheck: '2026-03-28T12:00:00.000Z',
      lastError: 'Connection refused',
      offline_since: '2026-03-28T11:59:00.000Z',
    };
    const { database, service } = createService({
      instanceAware: true,
      instances,
      getLapiStatuses: () => instances.map((instance) => ({
        instanceId: instance.id,
        instanceName: instance.name,
        status: offlineStatus,
      })),
    });
    await service.createRule({
      name: 'LAPI health',
      type: 'lapi-availability',
      enabled: true,
      severity: 'critical',
      channel_ids: [],
      config: {
        outage_threshold_seconds: 60,
        notify_on_recovery: false,
      },
    });

    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));

    expect(service.listNotifications().data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: '[Primary] LAPI health: LAPI unavailable',
        metadata: expect.objectContaining({ instance_id: 'primary', instance_name: 'Primary' }),
      }),
      expect.objectContaining({
        title: '[Edge] LAPI health: LAPI unavailable',
        metadata: expect.objectContaining({ instance_id: 'edge', instance_name: 'Edge' }),
      }),
    ]));
    expect(service.listNotifications().data).toHaveLength(2);

    database.close();
  });

  test('lapi availability rules emit a single info recovery notification when enabled', async () => {
    let lapiStatus: LapiStatus = {
      isConnected: false,
      lastCheck: '2026-03-28T12:10:00.000Z',
      lastError: 'timeout',
      offline_since: '2026-03-28T12:08:30.000Z',
    };
    const { database, service } = createService({
      getLapiStatus: () => lapiStatus,
    });

    await service.createRule({
      name: 'LAPI health',
      type: 'lapi-availability',
      enabled: true,
      severity: 'critical',
      channel_ids: [],
      config: {
        outage_threshold_seconds: 60,
        notify_on_recovery: true,
      },
    });

    await service.evaluateRules(new Date('2026-03-28T12:10:00.000Z'));

    lapiStatus = {
      isConnected: true,
      lastCheck: '2026-03-28T12:11:00.000Z',
      lastError: null,
      offline_since: null,
    };
    await service.evaluateRules(new Date('2026-03-28T12:11:00.000Z'));
    await service.evaluateRules(new Date('2026-03-28T12:11:30.000Z'));

    expect(service.listNotifications().data).toHaveLength(2);
    expect(service.listNotifications().data[0]).toEqual(expect.objectContaining({
      rule_type: 'lapi-availability',
      severity: 'info',
      title: 'LAPI health: LAPI recovered',
      metadata: expect.objectContaining({
        offline_since: '2026-03-28T12:08:30.000Z',
        recovered_at: '2026-03-28T12:11:00.000Z',
        outage_duration_seconds: 150,
      }),
    }));
    expect(service.listNotifications().data[1]).toEqual(expect.objectContaining({
      severity: 'critical',
      title: 'LAPI health: LAPI unavailable',
    }));

    database.close();
  });
});
