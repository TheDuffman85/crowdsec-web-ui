import { describe, expect, test, vi } from 'vitest';
import type { LapiStatus } from '../../../shared/contracts';
import { createAlert, createDecision, createService, insertAlert, insertDecision } from './harness';

describe('notification per-record incidents', () => {
  test('IP ban rules notify once per active ban decision with decision metadata', async () => {
    const { database, service } = createService();
    const rule = await service.createRule({
      name: 'Ban watch',
      type: 'ip-ban',
      enabled: true,
      severity: 'critical',
      channel_ids: [],
      config: {
        window_minutes: 60,
        filters: {},
      },
    });

    insertDecision(database, createDecision('decision-1', '2026-03-28T11:55:00.000Z', {
      value: '10.20.30.40',
      origin: 'manual',
      alert_id: 123,
    }));

    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));
    await service.evaluateRules(new Date('2026-03-28T12:05:00.000Z'));

    expect(service.listNotifications().data).toEqual([
      expect.objectContaining({
        rule_type: 'ip-ban',
        severity: 'critical',
        title: 'Ban watch: IP banned',
        message: '10.20.30.40 was banned by crowdsecurity/ssh-bf until 2026-03-28T13:00:00.000Z.',
        metadata: expect.objectContaining({
          decision_id: 'decision-1',
          value: '10.20.30.40',
          type: 'ban',
          origin: 'manual',
          scenario: 'crowdsecurity/ssh-bf',
          target: 'ssh',
          alert_id: 123,
          created_at: '2026-03-28T11:55:00.000Z',
          stop_at: '2026-03-28T13:00:00.000Z',
        }),
      }),
    ]);
    expect(database.listNotificationIncidentsByRule(rule.id)).toEqual([
      expect.objectContaining({
        incident_key: 'ip-ban:10.20.30.40:manual:crowdsecurity%2Fssh-bf:ssh',
        first_seen_at: '2026-03-28T11:55:00.000Z',
        resolved_at: null,
      }),
    ]);

    await service.evaluateRules(new Date('2026-03-28T13:01:00.000Z'));
    expect(database.listNotificationIncidentsByRule(rule.id)[0]).toEqual(expect.objectContaining({
      resolved_at: '2026-03-28T13:01:00.000Z',
    }));

    database.close();
  });

  test('IP ban rules do not refire when the same ban is resynced with volatile ids and timestamps', async () => {
    const { database, service } = createService();
    await service.createRule({
      name: 'Stable bans',
      type: 'ip-ban',
      enabled: true,
      severity: 'warning',
      channel_ids: [],
      config: {
        window_minutes: 60,
        filters: {},
      },
    });

    insertDecision(database, createDecision('decision-a', '2026-03-28T11:55:00.000Z', {
      value: '1.2.3.4',
      stop_at: '2026-03-28T13:00:00.000Z',
    }));
    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));

    database.deleteDecision('decision-a');
    insertDecision(database, createDecision('decision-b', '2026-03-28T11:56:00.000Z', {
      value: '1.2.3.4',
      stop_at: '2026-03-28T13:01:00.000Z',
    }));
    await service.evaluateRules(new Date('2026-03-28T12:05:00.000Z'));

    expect(service.listNotifications().data).toHaveLength(1);

    database.close();
  });

  test('IP ban rules collapse duplicate active decisions in the same evaluation', async () => {
    const { database, service } = createService();
    await service.createRule({
      name: 'Duplicate bans',
      type: 'ip-ban',
      enabled: true,
      severity: 'warning',
      channel_ids: [],
      config: {
        window_minutes: 60,
        filters: {},
      },
    });

    insertDecision(database, createDecision('decision-a', '2026-03-28T11:55:00.000Z', {
      value: '3.4.5.6',
      stop_at: '2026-03-28T13:00:00.000Z',
    }));
    insertDecision(database, createDecision('decision-b', '2026-03-28T11:56:00.000Z', {
      value: '3.4.5.6',
      stop_at: '2026-03-28T13:01:00.000Z',
    }));

    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));

    expect(service.listNotifications().data).toHaveLength(1);

    database.close();
  });

  test('IP ban rules resolve when an active decision is deleted from the cache', async () => {
    const { database, service } = createService();
    const rule = await service.createRule({
      name: 'Deleted bans',
      type: 'ip-ban',
      enabled: true,
      severity: 'warning',
      channel_ids: [],
      config: {
        window_minutes: 60,
        filters: {},
      },
    });

    insertDecision(database, createDecision('decision-a', '2026-03-28T11:55:00.000Z', {
      value: '2.3.4.5',
      stop_at: '2026-03-28T13:00:00.000Z',
    }));
    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));

    database.deleteDecision('decision-a');
    await service.evaluateRules(new Date('2026-03-28T12:05:00.000Z'));

    expect(database.listNotificationIncidentsByRule(rule.id)[0]).toEqual(expect.objectContaining({
      incident_key: 'ip-ban:2.3.4.5:crowdsec:crowdsecurity%2Fssh-bf:ssh',
      resolved_at: '2026-03-28T12:05:00.000Z',
    }));

    database.close();
  });

  test('IP ban rules respect window, decision type, simulation, scenario, target, exact IP, and CIDR filters', async () => {
    const { database, service } = createService();
    await service.createRule({
      name: 'Filtered bans',
      type: 'ip-ban',
      enabled: true,
      severity: 'warning',
      channel_ids: [],
      config: {
        window_minutes: 30,
        filters: {
          scenario: 'ssh',
          target: 'ssh',
          include_simulated: true,
          values: ['203.0.113.10', '10.0.0.0/24', '2001:db8::/32'],
        },
      },
    });

    insertDecision(database, createDecision('exact', '2026-03-28T11:50:00.000Z', { value: '203.0.113.10' }));
    insertDecision(database, createDecision('cidr-v4', '2026-03-28T11:51:00.000Z', { value: '10.0.0.42' }));
    insertDecision(database, createDecision('cidr-v6', '2026-03-28T11:52:00.000Z', { value: '2001:db8::42', simulated: true }));
    insertDecision(database, createDecision('captcha', '2026-03-28T11:53:00.000Z', { value: '10.0.0.43', type: 'captcha' }));
    insertDecision(database, createDecision('outside-cidr', '2026-03-28T11:54:00.000Z', { value: '10.0.1.42' }));
    insertDecision(database, createDecision('wrong-scenario', '2026-03-28T11:55:00.000Z', { value: '10.0.0.44', scenario: 'crowdsecurity/http-probing' }));
    insertDecision(database, createDecision('wrong-target', '2026-03-28T11:56:00.000Z', { value: '10.0.0.45', target: 'http' }));
    insertDecision(database, createDecision('old-ban', '2026-03-28T11:20:00.000Z', { value: '10.0.0.46' }));

    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));

    expect(service.listNotifications().data.map((notification) => notification.metadata.decision_id).sort()).toEqual([
      'cidr-v4',
      'cidr-v6',
      'exact',
    ]);

    database.close();
  });

  test('new alert or decision rules notify once per matching record with event details', async () => {
    const { database, service } = createService();
    await service.createRule({
      name: 'New security activity',
      type: 'new-alert-decision',
      enabled: true,
      severity: 'info',
      channel_ids: [],
      config: {
        window_minutes: 5,
        event_type: 'both',
        filters: {
          scenario: 'ssh',
          target: 'ssh',
          values: ['10.0.0.0/24'],
        },
      },
    });

    insertAlert(database, createAlert(10, '2026-03-28T11:58:00.000Z', {
      source: { ip: '10.0.0.10' },
      events_count: 4,
      machine_alias: 'gateway',
    }));
    insertAlert(database, createAlert(11, '2026-03-28T11:59:00.000Z', {
      source: { ip: '192.0.2.10' },
    }));
    insertDecision(database, createDecision('decision-10', '2026-03-28T11:59:00.000Z', {
      value: '10.0.0.20',
    }));
    insertDecision(database, createDecision('decision-simulated', '2026-03-28T11:59:30.000Z', {
      value: '10.0.0.21',
      simulated: true,
    }));

    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));
    await service.evaluateRules(new Date('2026-03-28T12:01:00.000Z'));

    const notifications = service.listNotifications().data;
    expect(notifications).toHaveLength(2);
    expect(notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule_type: 'new-alert-decision',
        title: 'New security activity: new alert',
        message: expect.stringContaining('Alert #10'),
        metadata: expect.objectContaining({
          event_type: 'alert',
          alert_id: '10',
          source: '10.0.0.10',
          machine: 'gateway',
          events_count: 4,
        }),
      }),
      expect.objectContaining({
        rule_type: 'new-alert-decision',
        title: 'New security activity: new decision',
        message: expect.stringContaining('Decision #decision-10'),
        metadata: expect.objectContaining({
          event_type: 'decision',
          decision_id: 'decision-10',
          value: '10.0.0.20',
          type: 'ban',
        }),
      }),
    ]));

    for (const eventType of ['alert', 'decision'] as const) {
      await service.createRule({
        name: `${eventType}-only`,
        type: 'new-alert-decision',
        enabled: true,
        severity: 'info',
        channel_ids: [],
        config: {
          window_minutes: 5,
          event_type: eventType,
          filters: { values: ['10.0.0.0/24'] },
        },
      });
    }

    await service.evaluateRules(new Date('2026-03-28T12:02:00.000Z'));
    expect(service.listNotifications().data.filter((item) => item.rule_name === 'alert-only')).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ event_type: 'alert' }) }),
    ]);
    expect(service.listNotifications().data.filter((item) => item.rule_name === 'decision-only')).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ event_type: 'decision' }) }),
    ]);

    database.close();
  });

  test('multi-instance per-record notifications identify the source instance by name', async () => {
    const instances = [
      { id: 'primary', name: 'Primary' },
      { id: 'edge', name: 'Edge' },
    ];
    const { database, service } = createService({ instanceAware: true, instances });
    await service.createRule({
      name: 'New alerts',
      type: 'new-alert-decision',
      enabled: true,
      severity: 'info',
      channel_ids: [],
      config: {
        window_minutes: 5,
        event_type: 'alert',
        filters: {},
      },
    });

    insertAlert(database, createAlert(7, '2026-03-28T11:58:00.000Z', {
      instance_id: 'primary',
      uuid: 'primary-alert-7',
    }));
    insertAlert(database, createAlert(7, '2026-03-28T11:59:00.000Z', {
      instance_id: 'edge',
      uuid: 'edge-alert-7',
    }));
    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));

    expect(service.listNotifications().data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: '[Primary] New alerts: new alert',
        metadata: expect.objectContaining({ instance_id: 'primary', instance_name: 'Primary', alert_id: '7' }),
      }),
      expect.objectContaining({
        title: '[Edge] New alerts: new alert',
        metadata: expect.objectContaining({ instance_id: 'edge', instance_name: 'Edge', alert_id: '7' }),
      }),
    ]));
    expect(service.listNotifications().data).toHaveLength(2);

    database.close();
  });

  test('IP ban rules reject invalid IP and range filter values', async () => {
    const { database, service } = createService();

    await expect(service.createRule({
      name: 'Invalid bans',
      type: 'ip-ban',
      enabled: true,
      severity: 'warning',
      channel_ids: [],
      config: {
        window_minutes: 60,
        filters: {
          values: ['not-an-ip'],
        },
      },
    })).rejects.toThrow('Invalid IP/range filter value: not-an-ip');

    database.close();
  });

});
