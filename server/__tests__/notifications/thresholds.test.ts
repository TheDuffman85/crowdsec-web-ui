import { describe, expect, test, vi } from 'vitest';
import type { LapiStatus } from '../../../shared/contracts';
import { createAlert, createDecision, createService, insertAlert, insertDecision } from './harness';

describe('notification threshold incidents', () => {
  test('threshold rules fire once while active, resolve, and fire again after re-breach', async () => {
    const { database, service } = createService();
    const rule = await service.createRule({
      name: 'Threshold',
      type: 'alert-threshold',
      enabled: true,
      severity: 'warning',
      channel_ids: [],
      config: {
        window_minutes: 60,
        alert_threshold: 1,
        filters: {},
      },
    });

    insertAlert(database, createAlert(1, '2026-03-28T11:55:00.000Z'));

    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));
    expect(service.listNotifications().data).toHaveLength(1);
    expect(database.listNotificationIncidentsByRule(rule.id)).toEqual([
      expect.objectContaining({
        incident_key: 'threshold:active',
        resolved_at: null,
      }),
    ]);

    await service.evaluateRules(new Date('2026-03-28T12:30:00.000Z'));
    expect(service.listNotifications().data).toHaveLength(1);

    await service.evaluateRules(new Date('2026-03-28T14:00:00.000Z'));
    expect(database.listNotificationIncidentsByRule(rule.id)[0]).toEqual(expect.objectContaining({
      incident_key: 'threshold:active',
      resolved_at: '2026-03-28T14:00:00.000Z',
    }));

    insertAlert(database, createAlert(2, '2026-03-28T14:05:00.000Z'));
    await service.evaluateRules(new Date('2026-03-28T14:06:00.000Z'));

    expect(service.listNotifications().data).toHaveLength(2);
    expect(database.listNotificationIncidentsByRule(rule.id)[0]).toEqual(expect.objectContaining({
      incident_key: 'threshold:active',
      first_seen_at: '2026-03-28T14:06:00.000Z',
      resolved_at: null,
    }));

    database.close();
  });

  test('multi-instance threshold rules aggregate all instances and identify contributing instances', async () => {
    const instances = [
      { id: 'primary', name: 'Primary' },
      { id: 'edge', name: 'Edge' },
    ];
    const { database, service } = createService({ instanceAware: true, instances });
    await service.createRule({
      name: 'Combined threshold',
      type: 'alert-threshold',
      enabled: true,
      severity: 'warning',
      channel_ids: [],
      config: {
        window_minutes: 60,
        alert_threshold: 2,
        filters: {},
      },
    });

    insertAlert(database, createAlert(1, '2026-03-28T11:55:00.000Z', { instance_id: 'primary' }));
    insertAlert(database, createAlert(2, '2026-03-28T11:56:00.000Z', { instance_id: 'edge' }));
    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));

    expect(service.listNotifications().data).toEqual([
      expect.objectContaining({
        title: '[Primary, Edge] Combined threshold: threshold exceeded',
        message: '2 alerts matched in the last 60 minutes, crossing the threshold of 2.',
        metadata: expect.objectContaining({
          matched_alerts: 2,
          instance_ids: ['primary', 'edge'],
          instance_names: ['Primary', 'Edge'],
        }),
      }),
    ]);

    database.close();
  });

  test('uses the explicit server language for notification content', async () => {
    const { database, service } = createService();
    database.setMeta('language', 'de');
    await service.createRule({
      name: 'Schwelle',
      type: 'alert-threshold',
      enabled: true,
      severity: 'warning',
      channel_ids: [],
      config: {
        window_minutes: 60,
        alert_threshold: 1,
        filters: {},
      },
    });

    insertAlert(database, createAlert(1, '2026-03-28T11:55:00.000Z'));
    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));

    expect(service.listNotifications().data[0]).toEqual(expect.objectContaining({
      title: 'Schwelle: Schwellenwert überschritten',
      message: '1 Alarme wurden in den letzten 60 Minuten gefunden und überschreiten den Schwellenwert von 1.',
    }));

    database.close();
  });

  test('spike rules stay deduplicated while active, then fire again after clearing', async () => {
    const { database, service } = createService();
    const rule = await service.createRule({
      name: 'Spike',
      type: 'alert-spike',
      enabled: true,
      severity: 'critical',
      channel_ids: [],
      config: {
        window_minutes: 60,
        percent_increase: 100,
        minimum_current_alerts: 2,
        filters: {},
      },
    });

    insertAlert(database, createAlert(1, '2026-03-28T10:30:00.000Z'));
    insertAlert(database, createAlert(2, '2026-03-28T11:10:00.000Z'));
    insertAlert(database, createAlert(3, '2026-03-28T11:20:00.000Z'));
    insertAlert(database, createAlert(4, '2026-03-28T11:30:00.000Z'));

    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));
    await service.evaluateRules(new Date('2026-03-28T12:05:00.000Z'));
    expect(service.listNotifications().data).toHaveLength(1);

    await service.evaluateRules(new Date('2026-03-28T14:30:00.000Z'));
    expect(database.listNotificationIncidentsByRule(rule.id)[0]).toEqual(expect.objectContaining({
      incident_key: 'spike:active',
      resolved_at: '2026-03-28T14:30:00.000Z',
    }));

    insertAlert(database, createAlert(5, '2026-03-28T15:10:00.000Z'));
    insertAlert(database, createAlert(6, '2026-03-28T16:10:00.000Z'));
    insertAlert(database, createAlert(7, '2026-03-28T16:20:00.000Z'));
    insertAlert(database, createAlert(8, '2026-03-28T16:30:00.000Z'));

    await service.evaluateRules(new Date('2026-03-28T17:00:00.000Z'));
    expect(service.listNotifications().data).toHaveLength(2);

    database.close();
  });

  test('new CVE rules create one incident per CVE and do not re-fire while still active', async () => {
    const publishedAt: Record<string, string> = {
      'CVE-2026-1111': '2026-03-20T00:00:00.000Z',
      'CVE-2026-2222': '2026-03-22T00:00:00.000Z',
    };
    const { database, service } = createService({
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        const cveId = url.searchParams.get('cveId') || '';
        return Response.json({
          vulnerabilities: [
            {
              cve: {
                published: publishedAt[cveId],
              },
            },
          ],
        });
      },
    });

    const rule = await service.createRule({
      name: 'Recent CVEs',
      type: 'new-cve',
      enabled: true,
      severity: 'warning',
      channel_ids: [],
      config: {
        max_cve_age_days: 30,
        filters: {},
      },
    });

    insertAlert(database, createAlert(1, '2026-03-28T10:00:00.000Z', { message: 'Matched CVE-2026-1111' }));
    insertAlert(database, createAlert(2, '2026-03-28T10:05:00.000Z', { message: 'Matched CVE-2026-2222' }));

    await service.evaluateRules(new Date('2026-03-28T12:00:00.000Z'));
    expect(service.listNotifications().data).toHaveLength(2);
    expect(database.listNotificationIncidentsByRule(rule.id)).toEqual([
      expect.objectContaining({ incident_key: 'cve:CVE-2026-1111', resolved_at: null }),
      expect.objectContaining({ incident_key: 'cve:CVE-2026-2222', resolved_at: null }),
    ]);

    await service.evaluateRules(new Date('2026-03-28T13:00:00.000Z'));
    expect(service.listNotifications().data).toHaveLength(2);

    database.close();
  });

});
