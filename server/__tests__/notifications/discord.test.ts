import { describe, expect, test } from 'vitest';
import type { NotificationChannel } from '../../../shared/contracts';
import { buildDiscordEmbed, normalizeLinkBaseUrl, truncateText } from '../../notifications/discord-embed';
import { getNotificationProvider, STORED_SECRET_SENTINEL, type NotificationProviderPayload } from '../../notifications/providers';

const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/abc-DEF_123';

const payload: NotificationProviderPayload = {
  title: 'New alert',
  message: 'Alert 42 from 203.0.113.9 matched crowdsecurity/ssh-bf',
  severity: 'warning',
  metadata: {
    event_type: 'alert',
    alert_id: '42',
    source: '203.0.113.9',
    scenario: 'crowdsecurity/ssh-bf',
    target: 'sshd',
    machine: 'odin',
    events_count: 6,
    simulated: false,
    filters: { scenario: 'ssh' },
  },
  sent_at: '2026-11-20T10:00:00.000Z',
  channel_id: 'channel-1',
  channel_name: 'Discord',
  channel_type: 'discord',
  rule_id: 'rule-1',
  rule_name: 'SSH alerts',
  rule_type: 'new-alert-decision',
  app_name: 'CrowdSec Web UI',
};

function createChannel(config: NotificationChannel['config']): NotificationChannel {
  return {
    id: 'channel-1',
    name: 'Discord',
    type: 'discord',
    enabled: true,
    config,
    configured_secrets: [],
    created_at: '2026-11-20T10:00:00.000Z',
    updated_at: '2026-11-20T10:00:00.000Z',
  };
}

describe('discord embed builder', () => {
  test('builds an embed with severity colour, ordered fields and no internal identifiers', () => {
    const embed = buildDiscordEmbed({
      title: payload.title,
      message: payload.message,
      severity: 'critical',
      metadata: payload.metadata,
      sentAt: payload.sent_at,
      appName: payload.app_name,
      ruleName: payload.rule_name,
    });

    expect(embed.color).toBe(0xef4444);
    expect(embed.timestamp).toBe('2026-11-20T10:00:00.000Z');
    expect(embed.footer.text).toBe('CrowdSec Web UI · SSH alerts');
    expect(embed.fields.map((field) => field.name)).toEqual([
      'Source', 'Scenario', 'Target', 'Machine', 'Events count', 'Simulated',
    ]);
    expect(embed.url).toBeUndefined();
  });

  test('adds links back to the Web UI for IP events only when a base URL is configured', () => {
    const embed = buildDiscordEmbed({
      title: 't', message: 'm', severity: 'info', metadata: payload.metadata,
      sentAt: payload.sent_at, appName: 'App', ruleName: null,
      linkBaseUrl: 'https://crowdsec.example.com/ui/?x=1#top',
    });
    expect(embed.url).toBe('https://crowdsec.example.com/ui/alerts?q=203.0.113.9');
    const links = embed.fields.at(-1);
    expect(links?.value).toContain('https://crowdsec.example.com/ui/decisions?q=203.0.113.9');

    const noIp = buildDiscordEmbed({
      title: 't', message: 'm', severity: 'info', metadata: { matched_alerts: 3 },
      sentAt: payload.sent_at, appName: 'App', ruleName: null,
      linkBaseUrl: 'https://crowdsec.example.com',
    });
    expect(noIp.url).toBeUndefined();
    expect(noIp.fields.map((field) => field.name)).toEqual(['Matched alerts']);
  });

  test('respects Discord size limits', () => {
    const embed = buildDiscordEmbed({
      title: 'x'.repeat(500),
      message: 'y'.repeat(9000),
      severity: 'info',
      metadata: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`key_${index}`, 'z'.repeat(2000)])),
      sentAt: 'not-a-date',
      appName: 'App',
      ruleName: null,
    });
    expect(embed.title.length).toBeLessThanOrEqual(256);
    expect(embed.description.length).toBeLessThanOrEqual(4096);
    expect(embed.fields.length).toBeLessThanOrEqual(12);
    expect(embed.fields.every((field) => field.value.length <= 1024)).toBe(true);
    expect(embed.timestamp).toBeUndefined();
  });

  test('helpers normalise link URLs and truncate text', () => {
    expect(normalizeLinkBaseUrl('ftp://example.com')).toBeNull();
    expect(normalizeLinkBaseUrl('')).toBeNull();
    expect(normalizeLinkBaseUrl('https://example.com/')).toBe('https://example.com');
    expect(truncateText('abcdef', 4)).toBe('abc…');
  });
});

describe('discord provider', () => {
  const provider = getNotificationProvider('discord');

  test('validates the webhook URL and optional fields', () => {
    expect(provider.validateConfig({})).toBe('Discord webhook URL is required');
    expect(provider.validateConfig({ discordWebhookUrl: 'http://discord.com/api/webhooks/1/a' })).toBe('Discord webhook URL must use https');
    expect(provider.validateConfig({ discordWebhookUrl: 'https://discord.com/other/path' })).toContain('must look like');
    expect(provider.validateConfig({ discordWebhookUrl: 'nope' })).toBe('Discord webhook URL must be a valid URL');
    expect(provider.validateConfig({ discordWebhookUrl: WEBHOOK, discordLinkUrl: 'javascript:alert(1)' })).toContain('Web UI link URL');
    expect(provider.validateConfig({ discordWebhookUrl: WEBHOOK, discordUsername: 'x'.repeat(81) })).toContain('username');
    expect(provider.validateConfig({ discordWebhookUrl: WEBHOOK, discordLinkUrl: 'https://crowdsec.example.com' })).toBeNull();
  });

  test('treats the webhook URL as a stored secret', () => {
    const stored = provider.normalizeConfig({ discordWebhookUrl: WEBHOOK });
    expect(provider.getConfiguredSecrets(stored)).toEqual(['discordWebhookUrl']);
    const masked = provider.maskConfig(stored);
    expect(masked.discordWebhookUrl).toBe(STORED_SECRET_SENTINEL);
    expect(provider.normalizeConfig(masked, stored).discordWebhookUrl).toBe(WEBHOOK);
    expect(JSON.stringify(masked)).not.toContain('abc-DEF_123');
  });

  async function send(config: Record<string, string>, override: Partial<NotificationProviderPayload>, responses: Response[] = [new Response(null, { status: 204 })]) {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const checked: string[] = [];
    await provider.send(createChannel(provider.normalizeConfig(config)), { ...payload, ...override }, {
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), init });
        return responses.shift() ?? new Response(null, { status: 204 });
      },
      assertHostAllowed: async () => {},
      assertUrlAllowed: async (value) => { checked.push(value); },
    });
    return { requests, checked };
  }

  test('posts one embed through the outbound guard and never pings by default', async () => {
    const { requests, checked } = await send({ discordWebhookUrl: WEBHOOK, discordUsername: 'Shield' }, {});
    expect(checked).toEqual([WEBHOOK]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init?.method).toBe('POST');
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0].color).toBe(0xf59e0b);
    expect(body.username).toBe('Shield');
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content).toBeUndefined();
  });

  test('mentions only on critical events when a mention is configured', async () => {
    const config = { discordWebhookUrl: WEBHOOK, discordMention: '<@&123456789012345678>' };
    const warning = JSON.parse(String((await send(config, { severity: 'warning' })).requests[0]?.init?.body));
    expect(warning.content).toBeUndefined();
    expect(warning.allowed_mentions).toEqual({ parse: [] });

    const critical = JSON.parse(String((await send(config, { severity: 'critical' })).requests[0]?.init?.body));
    expect(critical.content).toBe('<@&123456789012345678>');
    expect(critical.allowed_mentions.parse).toContain('roles');
  });

  test('marks rate limits and server errors retriable but client errors not', async () => {
    const failing = (status: number) => send({ discordWebhookUrl: WEBHOOK }, {}, [new Response('{"message":"nope"}', { status })]);
    await expect(failing(429)).rejects.toMatchObject({ retriable: true, status: 429 });
    await expect(failing(503)).rejects.toMatchObject({ retriable: true });
    await expect(failing(404)).rejects.toMatchObject({ retriable: false, status: 404 });
  });
});
