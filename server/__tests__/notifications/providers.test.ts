import { describe, expect, test } from 'vitest';
import type { NotificationChannel } from '../../../shared/contracts';
import { getNotificationProvider, STORED_SECRET_SENTINEL, type NotificationProviderPayload } from '../../notifications/providers';

const basePayload: NotificationProviderPayload = {
  title: 'Alert threshold exceeded',
  message: '25 alerts matched in the last hour.',
  severity: 'warning',
  metadata: { matched_alerts: 25 },
  sent_at: '2026-03-28T12:00:00.000Z',
  channel_id: 'channel-1',
  channel_name: 'Ops',
  channel_type: 'mqtt',
  rule_id: 'rule-1',
  rule_name: 'Alert threshold',
  rule_type: 'alert-threshold',
  app_name: 'CrowdSec Web UI',
};

function createChannel(type: NotificationChannel['type'], config: NotificationChannel['config']): NotificationChannel {
  return {
    id: 'channel-1',
    name: 'Primary',
    type,
    enabled: true,
    config,
    configured_secrets: [],
    created_at: '2026-03-28T12:00:00.000Z',
    updated_at: '2026-03-28T12:00:00.000Z',
  };
}

describe('notification providers', () => {
  test('email provider auto-upgrades legacy config and masks stored secrets', () => {
    const provider = getNotificationProvider('email');
    const normalized = provider.normalizeConfig({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      username: 'ops',
      password: 'secret',
      from: 'ops@example.com',
      to: 'team@example.com',
      subject_prefix: '[Legacy]',
    });

    expect(normalized).toEqual(expect.objectContaining({
      smtpHost: 'smtp.example.com',
      smtpPort: 465,
      smtpTlsMode: 'tls',
      smtpUser: 'ops',
      smtpPassword: 'secret',
      smtpFrom: 'ops@example.com',
      emailTo: 'team@example.com',
      subjectPrefix: '[Legacy]',
    }));
    expect(provider.maskConfig(normalized)).toEqual(expect.objectContaining({
      smtpPassword: STORED_SECRET_SENTINEL,
    }));
  });

  test('webhook provider migrates authorization_header into advanced config and preserves masked secrets', () => {
    const provider = getNotificationProvider('webhook');
    const normalized = provider.normalizeConfig({
      url: 'https://example.com/webhook',
      method: 'POST',
      authorization_header: 'Bearer old-token',
    });

    expect(normalized).toEqual(expect.objectContaining({
      url: 'https://example.com/webhook',
      method: 'POST',
      headers: [expect.objectContaining({ name: 'Authorization', value: 'Bearer old-token', sensitive: true })],
    }));

    const merged = provider.normalizeConfig({
      url: 'https://example.com/webhook',
      method: 'PATCH',
      headers: [{ name: 'Authorization', value: STORED_SECRET_SENTINEL, sensitive: true }],
    }, normalized);

    expect(merged).toEqual(expect.objectContaining({
      method: 'PATCH',
      headers: [expect.objectContaining({ name: 'Authorization', value: 'Bearer old-token', sensitive: true })],
    }));

    const masked = provider.maskConfig(merged);
    expect(masked).toEqual(expect.objectContaining({
      headers: [expect.objectContaining({ name: 'Authorization', value: STORED_SECRET_SENTINEL, sensitive: true })],
    }));
  });

  test('webhook provider includes truncated response body snippets on failed responses', async () => {
    const provider = getNotificationProvider('webhook');
    const config = provider.normalizeConfig({
      url: 'https://example.com/webhook',
      method: 'POST',
      body: {
        mode: 'json',
        template: '{"rule":{{event.rule_nameJson}}}',
      },
      retryAttempts: 0,
    });

    await expect(provider.send(createChannel('webhook', config), {
      ...basePayload,
      channel_type: 'webhook',
    }, {
      fetchImpl: async () => new Response('{"error":"rule field must be a string"}', { status: 400 }),
      assertHostAllowed: async () => {},
      assertUrlAllowed: async () => {},
    })).rejects.toThrow('Webhook request failed with status 400: {"error":"rule field must be a string"}');
  });

  test('webhook provider redacts sensitive form fields from failure debug snippets', async () => {
    const provider = getNotificationProvider('webhook');
    const config = provider.normalizeConfig({
      url: 'https://example.com/webhook',
      method: 'POST',
      body: {
        mode: 'form',
        fields: [
          { name: 'token', value: 'secret-token', sensitive: true },
          { name: 'title', value: '{{event.title}}', sensitive: false },
        ],
      },
      retryAttempts: 0,
    });

    try {
      await provider.send(createChannel('webhook', config), {
        ...basePayload,
        channel_type: 'webhook',
      }, {
        fetchImpl: async () => new Response('bad request', { status: 400 }),
        assertHostAllowed: async () => {},
        assertUrlAllowed: async () => {},
      });
      throw new Error('Expected webhook send to fail');
    } catch (error) {
      expect(error).toEqual(expect.objectContaining({
        requestBodySnippet: expect.stringContaining('token=%28redacted%29'),
      }));
      expect((error as { requestBodySnippet?: string }).requestBodySnippet).toContain('title=Alert+threshold+exceeded');
      expect((error as { requestBodySnippet?: string }).requestBodySnippet).not.toContain('secret-token');
    }
  });

  test('ntfy provider encodes non-ASCII headers for localized notifications', async () => {
    const provider = getNotificationProvider('ntfy');
    const config = provider.normalizeConfig({
      ntfyUrl: 'https://ntfy.sh',
      ntfyTopic: 'crowdsec_alerts',
      tags: '警告',
    });
    const requests: Array<{ url: string; init?: RequestInit }> = [];

    await provider.send(createChannel('ntfy', config), {
      ...basePayload,
      title: '阈值已超过',
      message: '过去 60 分钟内匹配到 25 条告警。',
      channel_type: 'ntfy',
    }, {
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), init });
        return Response.json({ id: 'message' });
      },
      assertHostAllowed: async () => {},
      assertUrlAllowed: async () => {},
    });

    expect(requests[0]?.url).toBe('https://ntfy.sh/crowdsec_alerts');
    expect(requests[0]?.init?.headers).toEqual(expect.objectContaining({
      Title: `=?UTF-8?B?${Buffer.from('CrowdSec: 阈值已超过', 'utf8').toString('base64')}?=`,
      Tags: `=?UTF-8?B?${Buffer.from('警告', 'utf8').toString('base64')}?=`,
    }));
    expect(requests[0]?.init?.body).toBe('过去 60 分钟内匹配到 25 条告警。');
  });

  describe('Gotify and ntfy redirects', () => {
    const cases: Array<{ type: 'gotify' | 'ntfy'; config: NotificationChannel['config']; label: string }> = [
      { type: 'gotify', config: { gotifyUrl: 'https://push.example.com', gotifyToken: 'app-token' }, label: 'Gotify URL' },
      { type: 'ntfy', config: { ntfyUrl: 'https://push.example.com', ntfyTopic: 'alerts' }, label: 'ntfy URL' },
    ];

    function sendThroughRedirects(
      type: 'gotify' | 'ntfy',
      config: NotificationChannel['config'],
      responses: Response[],
      restrictedHost?: string,
    ) {
      const provider = getNotificationProvider(type);
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      const checked: string[] = [];
      const send = provider.send(createChannel(type, provider.normalizeConfig(config)), { ...basePayload, channel_type: type }, {
        fetchImpl: async (input, init) => {
          requests.push({ url: String(input), init });
          return responses.shift() ?? Response.json({});
        },
        assertHostAllowed: async () => {},
        assertUrlAllowed: async (value, label) => {
          checked.push(value);
          if (restrictedHost && new URL(value).hostname === restrictedHost) throw new Error(`${label} points to a restricted address`);
        },
      });
      return { send, requests, checked };
    }

    const redirect = (status: number, location: string) => new Response(null, { status, headers: { location } });

    test.each(cases)('$type checks every same-origin redirect hop before following it', async ({ type, config }) => {
      const { send, requests, checked } = sendThroughRedirects(type, config, [redirect(308, '/v2/push')]);
      await send;

      expect(requests).toHaveLength(2);
      expect(requests.every((request) => request.init?.redirect === 'manual')).toBe(true);
      expect(requests[1]?.url).toBe('https://push.example.com/v2/push');
      expect(requests[1]?.init?.method).toBe('POST');
      expect(checked).toEqual(requests.map((request) => request.url));
    });

    test.each(cases)('$type refuses redirects to another host', async ({ type, config, label }) => {
      const { send, requests } = sendThroughRedirects(type, config, [redirect(307, 'http://127.0.0.1:8080/admin')]);
      await expect(send).rejects.toThrow(`${label} redirected to another host`);
      expect(requests).toHaveLength(1);
    });

    test.each(cases)('$type refuses redirects that would turn the POST into a GET', async ({ type, config, label }) => {
      const { send } = sendThroughRedirects(type, config, [redirect(302, '/elsewhere')]);
      await expect(send).rejects.toThrow(`${label} redirected (302)`);
    });

    test.each(cases)('$type stops after too many redirects', async ({ type, config, label }) => {
      const { send, requests } = sendThroughRedirects(type, config, Array.from({ length: 5 }, (_, index) => redirect(307, `/hop-${index}`)));
      await expect(send).rejects.toThrow(`${label} redirected too many times`);
      expect(requests).toHaveLength(4);
    });

    test.each(cases)('$type does not send to a restricted configured URL', async ({ type, config, label }) => {
      const { send, requests } = sendThroughRedirects(type, config, [], 'push.example.com');
      await expect(send).rejects.toThrow(`${label} points to a restricted address`);
      expect(requests).toHaveLength(0);
    });
  });

  test('mqtt provider validates config and publishes the expected payload', async () => {
    const provider = getNotificationProvider('mqtt');
    const config = provider.normalizeConfig({
      brokerUrl: 'mqtt://broker.example.com:1883',
      username: 'ops',
      password: 'secret',
      clientId: 'crowdsec-web-ui',
      keepaliveSeconds: 45,
      connectTimeoutMs: 5000,
      qos: 1,
      topic: 'crowdsec/notifications',
      retainEvents: true,
    });

    expect(provider.validateConfig(config)).toBeNull();

    const published: Array<{ config: unknown; payload: string }> = [];
    await provider.send(createChannel('mqtt', config), basePayload, {
      fetchImpl: async () => Response.json({}),
      assertHostAllowed: async () => {},
      assertUrlAllowed: async () => {},
      mqttPublishImpl: async (publishConfig, payload) => {
        published.push({ config: publishConfig, payload });
      },
    });

    expect(published).toHaveLength(1);
    expect(published[0]?.config).toEqual(expect.objectContaining({
      brokerUrl: 'mqtt://broker.example.com:1883',
      topic: 'crowdsec/notifications',
      retainEvents: true,
      qos: 1,
    }));
    expect(JSON.parse(published[0]?.payload || '{}')).toEqual(expect.objectContaining({
      severity: 'warning',
      channel_name: 'Ops',
      rule_name: 'Alert threshold',
      metadata: { matched_alerts: 25 },
    }));
  });
});
