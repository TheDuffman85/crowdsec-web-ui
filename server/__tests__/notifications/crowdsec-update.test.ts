import { describe, expect, test, vi } from 'vitest';
import type { CrowdsecUpdateObservation } from '../../crowdsec-update-check';
import { createService } from './harness';

function observation(endpointId: string, currentVersion: string | null, remoteVersion: string | null, updateAvailable: boolean | null): CrowdsecUpdateObservation {
  return {
    instanceId: 'edge',
    instanceName: 'Edge CrowdSec',
    endpointId,
    endpointName: 'Node ' + endpointId,
    currentVersion,
    remoteVersion,
    releaseUrl: remoteVersion ? 'https://github.com/crowdsecurity/crowdsec/releases/tag/' + remoteVersion : null,
    updateAvailable,
  };
}

describe('CrowdSec update notifications', () => {
  test('delivers once per endpoint and target, replaces older targets, and preserves unknown checks', async () => {
    let observations = [
      observation('one', 'v1.7.8', 'v1.8.0', true),
      observation('two', 'v1.7.7', 'v1.8.0', true),
    ];
    const sent = vi.fn(async () => Response.json({ ok: true }));
    const { database, service } = createService({
      crowdsecUpdateChecker: async () => observations,
      fetchImpl: sent,
    });
    try {
      const channel = await service.createChannel({
        name: 'Updates webhook',
        type: 'webhook',
        enabled: true,
        config: { url: 'https://example.com/webhook', method: 'POST', retryAttempts: 0 },
      });
      const rule = await service.createRule({
        name: 'CrowdSec updates',
        type: 'crowdsec-update',
        enabled: true,
        severity: 'info',
        channel_ids: [channel.id],
        config: {},
      });
      expect(rule.config).toEqual({});

      await service.evaluateRules(new Date('2026-09-24T10:00:00.000Z'));
      await service.evaluateRules(new Date('2026-09-24T10:01:00.000Z'));
      expect(sent).toHaveBeenCalledTimes(2);
      expect(service.listNotifications().data).toEqual([
        expect.objectContaining({
          rule_type: 'crowdsec-update',
          metadata: expect.objectContaining({
            instance_name: 'Edge CrowdSec',
            endpoint_name: 'Node two',
            local_version: 'v1.7.7',
            remote_version: 'v1.8.0',
            release_url: 'https://github.com/crowdsecurity/crowdsec/releases/tag/v1.8.0',
          }),
          deliveries: [expect.objectContaining({ status: 'delivered' })],
          message: expect.stringContaining('https://github.com/crowdsecurity/crowdsec/releases/tag/v1.8.0'),
        }),
        expect.objectContaining({ metadata: expect.objectContaining({ endpoint_id: 'one' }) }),
      ]);

      observations = [
        observation('one', 'v1.7.8', 'v1.8.1', true),
        observation('two', null, 'v1.8.1', null),
      ];
      await service.evaluateRules(new Date('2026-09-24T11:00:00.000Z'));
      expect(sent).toHaveBeenCalledTimes(3);
      expect(service.listNotifications().data.map((item) => [item.metadata.endpoint_id, item.metadata.remote_version])).toEqual([
        ['one', 'v1.8.1'],
        ['two', 'v1.8.0'],
      ]);

      observations = [
        observation('one', 'v1.8.1', 'v1.8.1', false),
        observation('two', null, null, null),
      ];
      await service.evaluateRules(new Date('2026-09-24T11:05:00.000Z'));
      expect(service.listNotifications().data.map((item) => item.metadata.endpoint_id)).toEqual(['two']);

      observations = [];
      await service.evaluateRules(new Date('2026-09-24T11:10:00.000Z'));
      expect(service.listNotifications().data).toEqual([]);
      expect(database.listNotificationIncidentsByRule(rule.id).filter((item) => item.resolved_at === null)).toEqual([]);
    } finally {
      database.close();
    }
  });
});
