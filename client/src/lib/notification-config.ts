import type { AlertMetaValue, NotificationChannelType } from '../types';

export const STORED_SECRET_SENTINEL = '(stored)';

export type EmailTlsMode = 'plain' | 'starttls' | 'tls';

export interface EmailConfig {
  smtpHost: string;
  smtpPort: number;
  smtpTlsMode: EmailTlsMode;
  allowInsecureTls: boolean;
  smtpUser: string;
  smtpPassword: string;
  smtpFrom: string;
  emailTo: string;
  emailImportanceOverride: 'auto' | 'normal' | 'important';
  subjectPrefix: string;
}

export interface GotifyConfig {
  gotifyUrl: string;
  gotifyToken: string;
  gotifyPriorityOverride: string;
}

export interface NtfyConfig {
  ntfyUrl: string;
  ntfyTopic: string;
  ntfyToken: string;
  ntfyPriorityOverride: string;
  ntfyUsername: string;
  ntfyPassword: string;
  titlePrefix: string;
  tags: string;
}

export interface MqttConfig {
  brokerUrl: string;
  username: string;
  password: string;
  clientId: string;
  keepaliveSeconds: number;
  connectTimeoutMs: number;
  qos: 0 | 1;
  topic: string;
  retainEvents: boolean;
}

export interface WebhookField {
  name: string;
  value: string;
  sensitive: boolean;
}

export type WebhookAuthConfig =
  | { mode: 'none' }
  | { mode: 'bearer'; token: string }
  | { mode: 'basic'; username: string; password: string };

export type WebhookBodyConfig =
  | { mode: 'text' | 'json'; template: string }
  | { mode: 'form'; fields: WebhookField[] };

export interface WebhookConfig {
  method: 'POST' | 'PUT' | 'PATCH';
  url: string;
  query: Array<{ name: string; value: string }>;
  headers: WebhookField[];
  auth: WebhookAuthConfig;
  body: WebhookBodyConfig;
  timeoutMs: number;
  retryAttempts: number;
  retryDelayMs: number;
  allowInsecureTls: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function booleanValue(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return fallback;
}

function createLegacyWebhookTemplate(): string {
  return JSON.stringify(
    {
      title: '{{event.titleJson}}',
      message: '{{event.messageJson}}',
      severity: '{{event.severityJson}}',
      metadata: '{{event.metadataJson}}',
      sent_at: '{{event.sent_atJson}}',
      channel_id: '{{event.channel_idJson}}',
      channel_name: '{{event.channel_nameJson}}',
      channel_type: '{{event.channel_typeJson}}',
      rule_id: '{{event.rule_idJson}}',
      rule_name: '{{event.rule_nameJson}}',
      rule_type: '{{event.rule_typeJson}}',
    },
    null,
    2,
  )
    .replaceAll('"{{', '{{')
    .replaceAll('}}"', '}}');
}

export function defaultEmailConfig(): EmailConfig {
  return {
    smtpHost: '',
    smtpPort: 587,
    smtpTlsMode: 'starttls',
    allowInsecureTls: false,
    smtpUser: '',
    smtpPassword: '',
    smtpFrom: '',
    emailTo: '',
    emailImportanceOverride: 'auto',
    subjectPrefix: '[CrowdSec]',
  };
}

export function defaultGotifyConfig(): GotifyConfig {
  return {
    gotifyUrl: '',
    gotifyToken: '',
    gotifyPriorityOverride: 'auto',
  };
}

export function defaultNtfyConfig(): NtfyConfig {
  return {
    ntfyUrl: 'https://ntfy.sh',
    ntfyTopic: '',
    ntfyToken: '',
    ntfyPriorityOverride: 'auto',
    ntfyUsername: '',
    ntfyPassword: '',
    titlePrefix: 'CrowdSec',
    tags: 'warning,shield',
  };
}

export function defaultMqttConfig(): MqttConfig {
  return {
    brokerUrl: '',
    username: '',
    password: '',
    clientId: '',
    keepaliveSeconds: 60,
    connectTimeoutMs: 10000,
    qos: 1,
    topic: '',
    retainEvents: false,
  };
}

export function defaultWebhookConfig(): WebhookConfig {
  return {
    method: 'POST',
    url: '',
    query: [],
    headers: [],
    auth: { mode: 'none' },
    body: { mode: 'json', template: createLegacyWebhookTemplate() },
    timeoutMs: 10000,
    retryAttempts: 2,
    retryDelayMs: 30000,
    allowInsecureTls: false,
  };
}

export function defaultChannelConfig(type: NotificationChannelType): Record<string, AlertMetaValue> {
  if (type === 'email') return defaultEmailConfig() as unknown as Record<string, AlertMetaValue>;
  if (type === 'gotify') return defaultGotifyConfig() as unknown as Record<string, AlertMetaValue>;
  if (type === 'mqtt') return defaultMqttConfig() as unknown as Record<string, AlertMetaValue>;
  if (type === 'webhook') return defaultWebhookConfig() as unknown as Record<string, AlertMetaValue>;
  return defaultNtfyConfig() as unknown as Record<string, AlertMetaValue>;
}

export function coerceEmailConfig(config: unknown): EmailConfig {
  const raw = asRecord(config);
  return {
    smtpHost: stringValue(raw.smtpHost),
    smtpPort: numberValue(raw.smtpPort, 587),
    smtpTlsMode: raw.smtpTlsMode === 'plain' || raw.smtpTlsMode === 'starttls' || raw.smtpTlsMode === 'tls'
      ? raw.smtpTlsMode
      : 'starttls',
    allowInsecureTls: booleanValue(raw.allowInsecureTls),
    smtpUser: stringValue(raw.smtpUser),
    smtpPassword: stringValue(raw.smtpPassword),
    smtpFrom: stringValue(raw.smtpFrom),
    emailTo: stringValue(raw.emailTo),
    emailImportanceOverride: raw.emailImportanceOverride === 'normal' || raw.emailImportanceOverride === 'important'
      ? raw.emailImportanceOverride
      : 'auto',
    subjectPrefix: stringValue(raw.subjectPrefix, '[CrowdSec]'),
  };
}

export function coerceGotifyConfig(config: unknown): GotifyConfig {
  const raw = asRecord(config);
  return {
    gotifyUrl: stringValue(raw.gotifyUrl),
    gotifyToken: stringValue(raw.gotifyToken),
    gotifyPriorityOverride: stringValue(raw.gotifyPriorityOverride, 'auto'),
  };
}

export function coerceNtfyConfig(config: unknown): NtfyConfig {
  const raw = asRecord(config);
  return {
    ntfyUrl: stringValue(raw.ntfyUrl, 'https://ntfy.sh'),
    ntfyTopic: stringValue(raw.ntfyTopic),
    ntfyToken: stringValue(raw.ntfyToken),
    ntfyPriorityOverride: stringValue(raw.ntfyPriorityOverride, 'auto'),
    ntfyUsername: stringValue(raw.ntfyUsername),
    ntfyPassword: stringValue(raw.ntfyPassword),
    titlePrefix: stringValue(raw.titlePrefix, 'CrowdSec'),
    tags: stringValue(raw.tags, 'warning,shield'),
  };
}

export function coerceMqttConfig(config: unknown): MqttConfig {
  const raw = asRecord(config);
  return {
    brokerUrl: stringValue(raw.brokerUrl),
    username: stringValue(raw.username),
    password: stringValue(raw.password),
    clientId: stringValue(raw.clientId),
    keepaliveSeconds: numberValue(raw.keepaliveSeconds, 60),
    connectTimeoutMs: numberValue(raw.connectTimeoutMs, 10000),
    qos: numberValue(raw.qos, 1) === 0 ? 0 : 1,
    topic: stringValue(raw.topic),
    retainEvents: booleanValue(raw.retainEvents),
  };
}

function normalizeWebhookField(value: unknown): WebhookField {
  const raw = asRecord(value);
  return {
    name: stringValue(raw.name),
    value: stringValue(raw.value),
    sensitive: raw.sensitive === true,
  };
}

function normalizeWebhookAuth(value: unknown): WebhookAuthConfig {
  const raw = asRecord(value);
  if (raw.mode === 'bearer') {
    return { mode: 'bearer', token: stringValue(raw.token) };
  }
  if (raw.mode === 'basic') {
    return { mode: 'basic', username: stringValue(raw.username), password: stringValue(raw.password) };
  }
  return { mode: 'none' };
}

function normalizeWebhookBody(value: unknown): WebhookBodyConfig {
  const raw = asRecord(value);
  if (raw.mode === 'form') {
    return {
      mode: 'form',
      fields: Array.isArray(raw.fields)
        ? raw.fields.map(normalizeWebhookField)
        : [],
    };
  }
  return {
    mode: raw.mode === 'json' ? 'json' : 'text',
    template: stringValue(raw.template),
  };
}

export function coerceWebhookConfig(config: unknown): WebhookConfig {
  const raw = asRecord(config);
  return {
    method: raw.method === 'PUT' || raw.method === 'PATCH' ? raw.method : 'POST',
    url: stringValue(raw.url),
    query: Array.isArray(raw.query)
      ? raw.query.map((entry) => {
          const item = asRecord(entry);
          return { name: stringValue(item.name), value: stringValue(item.value) };
        })
      : [],
    headers: Array.isArray(raw.headers)
      ? raw.headers.map(normalizeWebhookField)
      : [],
    auth: normalizeWebhookAuth(raw.auth),
    body: normalizeWebhookBody(raw.body),
    timeoutMs: numberValue(raw.timeoutMs, 10000),
    retryAttempts: numberValue(raw.retryAttempts, 2),
    retryDelayMs: numberValue(raw.retryDelayMs, 30000),
    allowInsecureTls: booleanValue(raw.allowInsecureTls),
  };
}

export function validateNotificationChannelConfig(type: NotificationChannelType, config: Record<string, AlertMetaValue>): string | null {
  if (type === 'email') {
    const email = coerceEmailConfig(config);
    if (!email.smtpHost.trim()) return 'SMTP host is required';
    if (!email.smtpFrom.trim()) return 'Sender email address is required';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.smtpFrom.trim())) return 'Invalid sender email address';
    const recipients = email.emailTo.split(',').map((entry) => entry.trim()).filter(Boolean);
    if (recipients.length === 0) return 'At least one email address is required';
    for (const recipient of recipients) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
        return `Invalid email address: ${recipient}`;
      }
    }
    if (email.smtpPort < 1 || email.smtpPort > 65535) return 'SMTP port must be between 1 and 65535';
    return null;
  }

  if (type === 'gotify') {
    const gotify = coerceGotifyConfig(config);
    if (!gotify.gotifyUrl.trim()) return 'Gotify URL is required';
    try {
      const parsed = new URL(gotify.gotifyUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return 'Gotify URL must use http or https';
      }
    } catch {
      return 'Gotify URL must be a valid URL';
    }
    if (!gotify.gotifyToken.trim()) return 'Gotify app token is required';
    if (gotify.gotifyPriorityOverride !== 'auto') {
      const parsed = Number.parseInt(gotify.gotifyPriorityOverride, 10);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) {
        return 'Gotify priority override must be "auto" or an integer from 0 to 10';
      }
    }
    return null;
  }

  if (type === 'ntfy') {
    const ntfy = coerceNtfyConfig(config);
    if (!ntfy.ntfyUrl.trim()) return 'ntfy URL is required';
    try {
      const parsed = new URL(ntfy.ntfyUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return 'ntfy URL must use http or https';
      }
    } catch {
      return 'ntfy URL must be a valid URL';
    }
    if (!ntfy.ntfyTopic.trim()) return 'ntfy topic is required';
    if (!/^[a-zA-Z0-9_-]+$/.test(ntfy.ntfyTopic)) {
      return 'ntfy topic must only contain letters, numbers, hyphens, and underscores';
    }
    if (!['auto', 'min', 'low', 'default', 'high', 'urgent'].includes(ntfy.ntfyPriorityOverride)) {
      return 'ntfy priority override must be one of: auto, min, low, default, high, urgent';
    }
    return null;
  }

  if (type === 'mqtt') {
    const mqtt = coerceMqttConfig(config);
    if (!mqtt.brokerUrl.trim()) return 'MQTT broker URL is required';
    try {
      const parsed = new URL(mqtt.brokerUrl);
      if (!['mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(parsed.protocol)) {
        return 'MQTT broker URL must use mqtt://, mqtts://, ws://, or wss://';
      }
      if (!parsed.hostname) {
        return 'MQTT broker URL must include a hostname';
      }
    } catch {
      return 'Invalid MQTT broker URL';
    }
    if (!mqtt.topic.trim()) return 'MQTT topic is required';
    if (mqtt.topic.includes('#') || mqtt.topic.includes('+')) return 'MQTT topic must not contain MQTT wildcards';
    if (mqtt.topic.startsWith('/') || mqtt.topic.endsWith('/')) return 'MQTT topic must not start or end with a slash';
    if (mqtt.topic.includes('//')) return 'MQTT topic must not contain empty topic levels';
    if (mqtt.keepaliveSeconds < 1 || mqtt.keepaliveSeconds > 3600) return 'Keepalive must be between 1 and 3600 seconds';
    if (mqtt.connectTimeoutMs < 1000 || mqtt.connectTimeoutMs > 120000) return 'Connect timeout must be between 1000 and 120000 ms';
    return null;
  }

  const webhook = coerceWebhookConfig(config);
  if (!webhook.url.trim()) return 'Webhook URL is required';
  try {
    const parsed = new URL(webhook.url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return 'Webhook URL must use http or https';
    }
    if (parsed.username || parsed.password) {
      return 'Webhook URL must not embed credentials';
    }
  } catch {
    return 'Webhook URL must be a valid URL';
  }
  if (webhook.timeoutMs < 1000 || webhook.timeoutMs > 30000) return 'Timeout must be between 1000 and 30000 ms';
  if (webhook.retryAttempts < 0 || webhook.retryAttempts > 5) return 'Retry attempts must be between 0 and 5';
  if (webhook.retryDelayMs < 0 || webhook.retryDelayMs > 300000) return 'Retry delay must be between 0 and 300000 ms';
  if (webhook.auth.mode === 'bearer' && !webhook.auth.token.trim()) return 'Bearer authentication requires a token';
  if (webhook.auth.mode === 'basic' && (!webhook.auth.username.trim() || !webhook.auth.password.trim())) {
    return 'Basic authentication requires username and password';
  }
  return null;
}

export function hasStoredSecret(value: string): boolean {
  return value === STORED_SECRET_SENTINEL;
}
