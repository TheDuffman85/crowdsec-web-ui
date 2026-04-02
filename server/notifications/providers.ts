import type {
  AlertMetaValue,
  NotificationChannel,
  NotificationChannelType,
  NotificationRuleType,
  NotificationSeverity,
} from '../../shared/contracts';
import { sendSmtpMail } from '../smtp';
import type { SmtpTlsMode } from '../smtp';
import { publishMqttNotification, type MqttPublishConfig } from './mqtt-client';
import { renderTemplate, validateTemplate } from './webhook-template';

export const STORED_SECRET_SENTINEL = '(stored)';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface NotificationProviderPayload {
  title: string;
  message: string;
  severity: NotificationSeverity;
  metadata: Record<string, AlertMetaValue>;
  sent_at: string;
  channel_id: string;
  channel_name: string;
  channel_type: NotificationChannelType;
  rule_id: string | null;
  rule_name: string | null;
  rule_type: NotificationRuleType | null;
}

export interface NotificationProviderContext {
  fetchImpl: FetchLike;
  mqttPublishImpl?: (config: MqttPublishConfig, payload: string) => Promise<void>;
  assertHostAllowed: (host: string, label: string) => Promise<void>;
  assertUrlAllowed: (value: string, label: string) => Promise<void>;
}

export interface NotificationProvider {
  readonly type: NotificationChannelType;
  readonly secretFields: string[];
  getDefaultConfig(): Record<string, AlertMetaValue>;
  normalizeConfig(
    config: Record<string, AlertMetaValue>,
    existingConfig?: Record<string, AlertMetaValue>,
  ): Record<string, AlertMetaValue>;
  maskConfig(config: Record<string, AlertMetaValue>): Record<string, AlertMetaValue>;
  validateConfig(config: Record<string, AlertMetaValue>): string | null;
  send(
    channel: NotificationChannel,
    payload: NotificationProviderPayload,
    context: NotificationProviderContext,
  ): Promise<void>;
  getConfiguredSecrets(config: Record<string, AlertMetaValue>): string[];
}

interface WebhookHeader {
  name: string;
  value: string;
  sensitive: boolean;
}

interface NotificationSendError extends Error {
  retriable?: boolean;
}

interface WebhookQuery {
  name: string;
  value: string;
}

type WebhookAuthConfig =
  | { mode: 'none' }
  | { mode: 'bearer'; token: string }
  | { mode: 'basic'; username: string; password: string };

type WebhookBodyConfig =
  | { mode: 'text' | 'json'; template: string }
  | { mode: 'form'; fields: WebhookHeader[] };

interface WebhookConfig {
  method: 'POST' | 'PUT' | 'PATCH';
  url: string;
  query: WebhookQuery[];
  headers: WebhookHeader[];
  auth: WebhookAuthConfig;
  body: WebhookBodyConfig;
  timeoutMs: number;
  retryAttempts: number;
  retryDelayMs: number;
  allowInsecureTls: boolean;
}

const HTTP_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const NTFY_PRIORITIES = new Set(['auto', 'min', 'low', 'default', 'high', 'urgent']);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function rawStringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown, fallback: number, min?: number, max?: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  let next = Math.trunc(parsed);
  if (typeof min === 'number') {
    next = Math.max(min, next);
  }
  if (typeof max === 'number') {
    next = Math.min(max, next);
  }
  return next;
}

function booleanValue(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return fallback;
}

function maskSecret(value: string): string {
  return value ? STORED_SECRET_SENTINEL : '';
}

function isStoredSecret(value: unknown): boolean {
  return value === STORED_SECRET_SENTINEL || value === '';
}

function validateHttpUrl(value: string, label: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `${label} must use http or https`;
    }
    if (!parsed.hostname) {
      return `${label} must include a hostname`;
    }
    return null;
  } catch {
    return `${label} must be a valid URL`;
  }
}

function validateMqttTopic(topic: string, label: string): string | null {
  if (!topic.trim()) return `${label} is required`;
  if (topic.includes('#') || topic.includes('+')) return `${label} must not contain MQTT wildcards`;
  if (topic.startsWith('/') || topic.endsWith('/')) return `${label} must not start or end with a slash`;
  if (topic.includes('//')) return `${label} must not contain empty topic levels`;
  return null;
}

function severityToImportance(severity: NotificationSeverity): 'normal' | 'important' {
  return severity === 'info' ? 'normal' : 'important';
}

function severityToNtfyPriority(severity: NotificationSeverity): 'default' | 'high' | 'urgent' {
  if (severity === 'critical') return 'urgent';
  if (severity === 'warning') return 'high';
  return 'default';
}

function severityToGotifyPriority(severity: NotificationSeverity): number {
  if (severity === 'critical') return 10;
  if (severity === 'warning') return 7;
  return 5;
}

function appendPrefix(prefix: string, value: string): string {
  return prefix ? `${prefix}: ${value}` : value;
}

function encodeBasicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
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

function defaultWebhookConfig(): WebhookConfig {
  return {
    method: 'POST',
    url: '',
    query: [],
    headers: [],
    auth: { mode: 'none' },
    body: { mode: 'json', template: createLegacyWebhookTemplate() },
    timeoutMs: 10_000,
    retryAttempts: 2,
    retryDelayMs: 30_000,
    allowInsecureTls: false,
  };
}

function normalizeWebhookHeader(value: unknown): WebhookHeader | null {
  const raw = asRecord(value);
  const name = rawStringValue(raw.name);
  if (!name.trim()) return null;
  return {
    name,
    value: rawStringValue(raw.value),
    sensitive: raw.sensitive === true,
  };
}

function normalizeWebhookQuery(value: unknown): WebhookQuery | null {
  const raw = asRecord(value);
  const name = rawStringValue(raw.name);
  if (!name.trim()) return null;
  return {
    name,
    value: rawStringValue(raw.value),
  };
}

function normalizeWebhookAuth(
  value: unknown,
  existing?: WebhookAuthConfig,
): WebhookAuthConfig {
  const raw = asRecord(value);
  const mode = raw.mode === 'bearer' || raw.mode === 'basic' ? raw.mode : 'none';

  if (mode === 'bearer') {
    const token = rawStringValue(raw.token);
    return {
      mode,
      token: token === STORED_SECRET_SENTINEL || token === ''
        ? existing && existing.mode === 'bearer'
          ? existing.token
          : ''
        : token,
    };
  }

  if (mode === 'basic') {
    const password = rawStringValue(raw.password);
    return {
      mode,
      username: rawStringValue(raw.username),
      password: password === STORED_SECRET_SENTINEL || password === ''
        ? existing && existing.mode === 'basic'
          ? existing.password
          : ''
        : password,
    };
  }

  return { mode: 'none' };
}

function normalizeWebhookBody(
  value: unknown,
  existing?: WebhookBodyConfig,
): WebhookBodyConfig {
  const raw = asRecord(value);
  if (raw.mode === 'form') {
    const storedFields = existing && existing.mode === 'form' ? existing.fields : [];
    const incomingFields = Array.isArray(raw.fields)
      ? raw.fields.map(normalizeWebhookHeader).filter((field): field is WebhookHeader => Boolean(field))
      : [];
    const nextFields = incomingFields.map((field, index) => {
      if (!field.sensitive) {
        return field;
      }

      const prior = storedFields[index];
      if (field.value === STORED_SECRET_SENTINEL || field.value === '') {
        return { ...field, value: prior?.value || '' };
      }
      return field;
    });

    return {
      mode: 'form',
      fields: nextFields,
    };
  }

  return {
    mode: raw.mode === 'json' ? 'json' : 'text',
    template: rawStringValue(raw.template),
  };
}

function normalizeWebhookConfig(
  config: Record<string, AlertMetaValue>,
  existingConfig?: Record<string, AlertMetaValue>,
): WebhookConfig {
  const raw = asRecord(config);
  const existing = existingConfig ? normalizeWebhookConfig(existingConfig) : defaultWebhookConfig();
  const legacyAuthorizationHeader = rawStringValue(raw.authorization_header);

  const headers = Array.isArray(raw.headers)
    ? raw.headers.map(normalizeWebhookHeader).filter((field): field is WebhookHeader => Boolean(field))
    : existing.headers;

  const mergedHeaders = legacyAuthorizationHeader
    ? [
        ...headers.filter((entry) => entry.name.toLowerCase() !== 'authorization'),
        { name: 'Authorization', value: legacyAuthorizationHeader, sensitive: true },
      ]
    : headers.map((field, index) => {
        if (!field.sensitive) {
          return field;
        }
        const prior = existing.headers[index];
        if (field.value === STORED_SECRET_SENTINEL || field.value === '') {
          return { ...field, value: prior?.value || '' };
        }
        return field;
      });

  return {
    method: HTTP_METHODS.has(rawStringValue(raw.method)) ? rawStringValue(raw.method) as WebhookConfig['method'] : existing.method,
    url: rawStringValue(raw.url, existing.url),
    query: Array.isArray(raw.query)
      ? raw.query.map(normalizeWebhookQuery).filter((entry): entry is WebhookQuery => Boolean(entry))
      : existing.query,
    headers: mergedHeaders,
    auth: normalizeWebhookAuth(raw.auth, existing.auth),
    body: normalizeWebhookBody(raw.body, existing.body),
    timeoutMs: numberValue(raw.timeoutMs, existing.timeoutMs, 1000, 30000),
    retryAttempts: numberValue(raw.retryAttempts, existing.retryAttempts, 0, 5),
    retryDelayMs: numberValue(raw.retryDelayMs, existing.retryDelayMs, 0, 300000),
    allowInsecureTls: booleanValue(raw.allowInsecureTls, existing.allowInsecureTls),
  };
}

function webhookConfigToRecord(config: WebhookConfig): Record<string, AlertMetaValue> {
  return {
    method: config.method,
    url: config.url,
    query: config.query,
    headers: config.headers,
    auth: config.auth,
    body: config.body,
    timeoutMs: config.timeoutMs,
    retryAttempts: config.retryAttempts,
    retryDelayMs: config.retryDelayMs,
    allowInsecureTls: config.allowInsecureTls,
  };
}

function maskWebhookConfig(config: WebhookConfig): Record<string, AlertMetaValue> {
  const headers = config.headers.map((field) => ({
    ...field,
    value: field.sensitive ? maskSecret(field.value) : field.value,
  }));
  const auth = config.auth.mode === 'bearer'
    ? { ...config.auth, token: maskSecret(config.auth.token) }
    : config.auth.mode === 'basic'
      ? { ...config.auth, password: maskSecret(config.auth.password) }
      : config.auth;
  const body = config.body.mode === 'form'
    ? {
        mode: 'form' as const,
        fields: config.body.fields.map((field) => ({
          ...field,
          value: field.sensitive ? maskSecret(field.value) : field.value,
        })),
      }
    : config.body;

  return {
    ...webhookConfigToRecord(config),
    headers,
    auth,
    body,
  };
}

function getWebhookConfiguredSecrets(config: WebhookConfig): string[] {
  const secrets: string[] = [];
  if (config.auth.mode === 'bearer' && config.auth.token) {
    secrets.push('auth.token');
  }
  if (config.auth.mode === 'basic' && config.auth.password) {
    secrets.push('auth.password');
  }
  if (config.headers.some((field) => field.sensitive && field.value)) {
    secrets.push('headers');
  }
  if (config.body.mode === 'form' && config.body.fields.some((field) => field.sensitive && field.value)) {
    secrets.push('body.fields');
  }
  return secrets;
}

function buildWebhookRequestBody(config: WebhookConfig, payload: NotificationProviderPayload): {
  body: string | undefined;
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = {};

  if (config.body.mode === 'form') {
    const params = new URLSearchParams();
    for (const field of config.body.fields) {
      params.append(field.name, renderTemplate(field.value, payload));
    }
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    return { body: params.toString(), headers };
  }

  if (config.body.mode === 'json') {
    headers['Content-Type'] = 'application/json';
    return {
      body: renderTemplate(config.body.template, payload),
      headers,
    };
  }

  headers['Content-Type'] = 'text/plain; charset=utf-8';
  return {
    body: renderTemplate(config.body.template, payload),
    headers,
  };
}

function getWebhookAuthHeaders(auth: WebhookAuthConfig): Record<string, string> {
  if (auth.mode === 'bearer' && auth.token) {
    return { Authorization: `Bearer ${auth.token}` };
  }
  if (auth.mode === 'basic' && auth.username && auth.password) {
    return { Authorization: encodeBasicAuth(auth.username, auth.password) };
  }
  return {};
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createNotificationSendError(message: string, retriable = false): NotificationSendError {
  const error = new Error(message) as NotificationSendError;
  error.retriable = retriable;
  return error;
}

async function sendWebhookRequest(
  config: WebhookConfig,
  payload: NotificationProviderPayload,
  context: NotificationProviderContext,
): Promise<void> {
  try {
    await context.assertUrlAllowed(config.url, 'Webhook URL');
  } catch (error) {
    throw createNotificationSendError(error instanceof Error ? error.message : 'Webhook URL is not allowed');
  }
  const requestUrl = new URL(config.url);
  for (const query of config.query) {
    requestUrl.searchParams.append(query.name, renderTemplate(query.value, payload));
  }

  const body = buildWebhookRequestBody(config, payload);
  const extraHeaders = Object.fromEntries(
    config.headers.map((field) => [field.name, renderTemplate(field.value, payload)]),
  );
  const init = {
    method: config.method,
    headers: {
      ...body.headers,
      ...extraHeaders,
      ...getWebhookAuthHeaders(config.auth),
    },
    body: body.body,
    signal: AbortSignal.timeout(config.timeoutMs),
    redirect: 'error',
    tls: config.allowInsecureTls ? { rejectUnauthorized: false } : undefined,
  } as RequestInit & { tls?: { rejectUnauthorized: boolean } };

  const response = await context.fetchImpl(requestUrl.toString(), init);
  if (!response.ok) {
    throw createNotificationSendError(`Webhook request failed with status ${response.status}`, response.status >= 500 || response.status === 429);
  }
}

function normalizeEmailTlsMode(value: unknown, legacySecure: unknown, legacyPort: unknown): SmtpTlsMode {
  if (value === 'plain' || value === 'starttls' || value === 'tls') {
    return value;
  }
  if (legacySecure === true || legacySecure === 'true') {
    return numberValue(legacyPort, 587) === 465 ? 'tls' : 'starttls';
  }
  if (legacySecure === false || legacySecure === 'false') {
    return 'plain';
  }
  return 'starttls';
}

const providers: Record<NotificationChannelType, NotificationProvider> = {
  email: {
    type: 'email',
    secretFields: ['smtpPassword'],
    getDefaultConfig() {
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
    },
    normalizeConfig(config, existingConfig) {
      const raw = asRecord(config);
      const existing = existingConfig ? this.normalizeConfig(existingConfig) : this.getDefaultConfig();
      const incomingPassword = rawStringValue(raw.smtpPassword ?? raw.password);
      return {
        smtpHost: stringValue(raw.smtpHost ?? raw.host, stringValue(existing.smtpHost)),
        smtpPort: numberValue(raw.smtpPort ?? raw.port, numberValue(existing.smtpPort, 587), 1, 65535),
        smtpTlsMode: normalizeEmailTlsMode(raw.smtpTlsMode, raw.secure, raw.smtpPort ?? raw.port ?? existing.smtpPort),
        allowInsecureTls: booleanValue(raw.allowInsecureTls, booleanValue(existing.allowInsecureTls)),
        smtpUser: rawStringValue(raw.smtpUser ?? raw.username, rawStringValue(existing.smtpUser)),
        smtpPassword: isStoredSecret(incomingPassword)
          ? rawStringValue(existing.smtpPassword)
          : incomingPassword,
        smtpFrom: stringValue(raw.smtpFrom ?? raw.from, stringValue(existing.smtpFrom)),
        emailTo: stringValue(raw.emailTo ?? raw.to, stringValue(existing.emailTo)),
        emailImportanceOverride: stringValue(raw.emailImportanceOverride, stringValue(existing.emailImportanceOverride) || 'auto'),
        subjectPrefix: rawStringValue(raw.subjectPrefix ?? raw.subject_prefix, rawStringValue(existing.subjectPrefix)),
      };
    },
    maskConfig(config) {
      return {
        ...config,
        smtpPassword: maskSecret(rawStringValue(config.smtpPassword)),
      };
    },
    validateConfig(config) {
      const normalized = this.normalizeConfig(config);
      if (!stringValue(normalized.smtpHost)) return 'SMTP host is required';
      if (!stringValue(normalized.smtpFrom)) return 'Sender email address is required';
      if (!stringValue(normalized.emailTo)) return 'Recipient email address is required';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(stringValue(normalized.smtpFrom))) return 'Invalid sender email address';
      const recipients = stringValue(normalized.emailTo).split(',').map((entry) => entry.trim()).filter(Boolean);
      if (recipients.length === 0) return 'At least one email address is required';
      for (const recipient of recipients) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
          return `Invalid email address: ${recipient}`;
        }
      }
      if (!['plain', 'starttls', 'tls'].includes(rawStringValue(normalized.smtpTlsMode))) {
        return 'SMTP TLS mode must be one of: plain, starttls, tls';
      }
      if (!['auto', 'normal', 'important'].includes(rawStringValue(normalized.emailImportanceOverride) || 'auto')) {
        return 'Email importance override must be one of: auto, normal, important';
      }
      return null;
    },
    async send(channel, payload, context) {
      const config = this.normalizeConfig(channel.config);
      const recipients = stringValue(config.emailTo)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      const importance = stringValue(config.emailImportanceOverride) === 'auto'
        ? severityToImportance(payload.severity)
        : stringValue(config.emailImportanceOverride) as 'normal' | 'important';
      const subject = appendPrefix(rawStringValue(config.subjectPrefix), payload.title);
      const prefix = importance === 'important' && payload.severity !== 'info' ? '[Important]' : '';
      await context.assertHostAllowed(stringValue(config.smtpHost), 'SMTP host');

      await sendSmtpMail({
        host: stringValue(config.smtpHost),
        port: numberValue(config.smtpPort, 587),
        tlsMode: rawStringValue(config.smtpTlsMode) as SmtpTlsMode,
        allowInsecureTls: booleanValue(config.allowInsecureTls),
        username: rawStringValue(config.smtpUser) || undefined,
        password: rawStringValue(config.smtpPassword) || undefined,
        from: stringValue(config.smtpFrom),
        to: recipients,
        subject: prefix ? `${prefix} ${subject}` : subject,
        text: payload.message,
      });
    },
    getConfiguredSecrets(config) {
      return rawStringValue(config.smtpPassword) ? ['smtpPassword'] : [];
    },
  },
  gotify: {
    type: 'gotify',
    secretFields: ['gotifyToken'],
    getDefaultConfig() {
      return {
        gotifyUrl: '',
        gotifyToken: '',
        gotifyPriorityOverride: 'auto',
      };
    },
    normalizeConfig(config, existingConfig) {
      const raw = asRecord(config);
      const existing = existingConfig ? this.normalizeConfig(existingConfig) : this.getDefaultConfig();
      const incomingToken = rawStringValue(raw.gotifyToken ?? raw.token);
      const priority = raw.gotifyPriorityOverride ?? raw.priority ?? existing.gotifyPriorityOverride;
      return {
        gotifyUrl: stringValue(raw.gotifyUrl ?? raw.server_url, stringValue(existing.gotifyUrl)),
        gotifyToken: isStoredSecret(incomingToken)
          ? rawStringValue(existing.gotifyToken)
          : incomingToken,
        gotifyPriorityOverride: String(priority ?? 'auto'),
      };
    },
    maskConfig(config) {
      return {
        ...config,
        gotifyToken: maskSecret(rawStringValue(config.gotifyToken)),
      };
    },
    validateConfig(config) {
      const normalized = this.normalizeConfig(config);
      if (!stringValue(normalized.gotifyUrl)) return 'Gotify URL is required';
      const urlError = validateHttpUrl(stringValue(normalized.gotifyUrl), 'Gotify URL');
      if (urlError) return urlError;
      if (!stringValue(normalized.gotifyToken)) return 'Gotify app token is required';
      const override = rawStringValue(normalized.gotifyPriorityOverride) || 'auto';
      if (override !== 'auto') {
        const parsed = Number.parseInt(override, 10);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) {
          return 'Gotify priority override must be "auto" or an integer from 0 to 10';
        }
      }
      return null;
    },
    async send(channel, payload, context) {
      const config = this.normalizeConfig(channel.config);
      const baseUrl = stringValue(config.gotifyUrl).replace(/\/+$/, '');
      await context.assertUrlAllowed(baseUrl, 'Gotify URL');
      const url = new URL(`${baseUrl}/message`);
      url.searchParams.set('token', stringValue(config.gotifyToken));

      const priority = rawStringValue(config.gotifyPriorityOverride) === 'auto'
        ? severityToGotifyPriority(payload.severity)
        : Number.parseInt(rawStringValue(config.gotifyPriorityOverride), 10);

      const response = await context.fetchImpl(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: payload.title,
          message: payload.message,
          priority,
        }),
      });
      if (!response.ok) {
        throw new Error(`Gotify request failed with status ${response.status}`);
      }
    },
    getConfiguredSecrets(config) {
      return rawStringValue(config.gotifyToken) ? ['gotifyToken'] : [];
    },
  },
  mqtt: {
    type: 'mqtt',
    secretFields: ['password'],
    getDefaultConfig() {
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
    },
    normalizeConfig(config, existingConfig) {
      const raw = asRecord(config);
      const existing = existingConfig ? this.normalizeConfig(existingConfig) : this.getDefaultConfig();
      const incomingPassword = rawStringValue(raw.password);
      return {
        brokerUrl: stringValue(raw.brokerUrl, stringValue(existing.brokerUrl)),
        username: rawStringValue(raw.username, rawStringValue(existing.username)),
        password: isStoredSecret(incomingPassword)
          ? rawStringValue(existing.password)
          : incomingPassword,
        clientId: rawStringValue(raw.clientId, rawStringValue(existing.clientId)),
        keepaliveSeconds: numberValue(raw.keepaliveSeconds, numberValue(existing.keepaliveSeconds, 60), 1, 3600),
        connectTimeoutMs: numberValue(raw.connectTimeoutMs, numberValue(existing.connectTimeoutMs, 10000), 1000, 120000),
        qos: numberValue(raw.qos, numberValue(existing.qos, 1), 0, 1) === 0 ? 0 : 1,
        topic: stringValue(raw.topic, stringValue(existing.topic)),
        retainEvents: booleanValue(raw.retainEvents, booleanValue(existing.retainEvents)),
      };
    },
    maskConfig(config) {
      return {
        ...config,
        password: maskSecret(rawStringValue(config.password)),
      };
    },
    validateConfig(config) {
      const normalized = this.normalizeConfig(config);
      const brokerUrl = stringValue(normalized.brokerUrl);
      if (!brokerUrl) return 'MQTT broker URL is required';
      try {
        const parsed = new URL(brokerUrl);
        if (!['mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(parsed.protocol)) {
          return 'MQTT broker URL must use mqtt://, mqtts://, ws://, or wss://';
        }
        if (!parsed.hostname) {
          return 'MQTT broker URL must include a hostname';
        }
      } catch {
        return 'Invalid MQTT broker URL';
      }
      const topicError = validateMqttTopic(stringValue(normalized.topic), 'MQTT topic');
      if (topicError) return topicError;
      return null;
    },
    async send(channel, payload, context) {
      const config = this.normalizeConfig(channel.config);
      await context.assertUrlAllowed(stringValue(config.brokerUrl), 'MQTT broker URL');
      const publisher = context.mqttPublishImpl || publishMqttNotification;
      await publisher({
        brokerUrl: stringValue(config.brokerUrl),
        username: rawStringValue(config.username) || undefined,
        password: rawStringValue(config.password) || undefined,
        clientId: rawStringValue(config.clientId) || undefined,
        keepaliveSeconds: numberValue(config.keepaliveSeconds, 60),
        connectTimeoutMs: numberValue(config.connectTimeoutMs, 10000),
        qos: numberValue(config.qos, 1) === 0 ? 0 : 1,
        topic: stringValue(config.topic),
        retainEvents: booleanValue(config.retainEvents),
      }, JSON.stringify(payload));
    },
    getConfiguredSecrets(config) {
      return rawStringValue(config.password) ? ['password'] : [];
    },
  },
  ntfy: {
    type: 'ntfy',
    secretFields: ['ntfyToken', 'ntfyPassword'],
    getDefaultConfig() {
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
    },
    normalizeConfig(config, existingConfig) {
      const raw = asRecord(config);
      const existing = existingConfig ? this.normalizeConfig(existingConfig) : this.getDefaultConfig();
      const incomingToken = rawStringValue(raw.ntfyToken ?? raw.token);
      const incomingPassword = rawStringValue(raw.ntfyPassword ?? raw.password);
      return {
        ntfyUrl: stringValue(raw.ntfyUrl ?? raw.server_url, stringValue(existing.ntfyUrl) || 'https://ntfy.sh'),
        ntfyTopic: stringValue(raw.ntfyTopic ?? raw.topic, stringValue(existing.ntfyTopic)),
        ntfyToken: isStoredSecret(incomingToken)
          ? rawStringValue(existing.ntfyToken)
          : incomingToken,
        ntfyPriorityOverride: stringValue(raw.ntfyPriorityOverride ?? raw.priority, stringValue(existing.ntfyPriorityOverride) || 'auto'),
        ntfyUsername: rawStringValue(raw.ntfyUsername ?? raw.username, rawStringValue(existing.ntfyUsername)),
        ntfyPassword: isStoredSecret(incomingPassword)
          ? rawStringValue(existing.ntfyPassword)
          : incomingPassword,
        titlePrefix: rawStringValue(raw.titlePrefix ?? raw.title_prefix, rawStringValue(existing.titlePrefix)),
        tags: rawStringValue(raw.tags, rawStringValue(existing.tags)),
      };
    },
    maskConfig(config) {
      return {
        ...config,
        ntfyToken: maskSecret(rawStringValue(config.ntfyToken)),
        ntfyPassword: maskSecret(rawStringValue(config.ntfyPassword)),
      };
    },
    validateConfig(config) {
      const normalized = this.normalizeConfig(config);
      if (!stringValue(normalized.ntfyUrl)) return 'ntfy URL is required';
      const urlError = validateHttpUrl(stringValue(normalized.ntfyUrl), 'ntfy URL');
      if (urlError) return urlError;
      if (!stringValue(normalized.ntfyTopic)) return 'ntfy topic is required';
      if (!/^[a-zA-Z0-9_-]+$/.test(stringValue(normalized.ntfyTopic))) {
        return 'ntfy topic must only contain letters, numbers, hyphens, and underscores';
      }
      const priority = stringValue(normalized.ntfyPriorityOverride) || 'auto';
      if (!NTFY_PRIORITIES.has(priority)) {
        return `ntfy priority override must be one of: ${Array.from(NTFY_PRIORITIES).join(', ')}`;
      }
      return null;
    },
    async send(channel, payload, context) {
      const config = this.normalizeConfig(channel.config);
      const baseUrl = stringValue(config.ntfyUrl).replace(/\/+$/, '');
      await context.assertUrlAllowed(baseUrl, 'ntfy URL');
      const headers: Record<string, string> = {
        Title: appendPrefix(rawStringValue(config.titlePrefix), payload.title),
        Priority: rawStringValue(config.ntfyPriorityOverride) === 'auto'
          ? severityToNtfyPriority(payload.severity)
          : rawStringValue(config.ntfyPriorityOverride),
      };
      const tags = rawStringValue(config.tags);
      if (tags) {
        headers.Tags = tags;
      }
      if (rawStringValue(config.ntfyToken)) {
        headers.Authorization = `Bearer ${rawStringValue(config.ntfyToken)}`;
      } else if (rawStringValue(config.ntfyUsername) && rawStringValue(config.ntfyPassword)) {
        headers.Authorization = encodeBasicAuth(rawStringValue(config.ntfyUsername), rawStringValue(config.ntfyPassword));
      }

      const response = await context.fetchImpl(`${baseUrl}/${encodeURIComponent(stringValue(config.ntfyTopic))}`, {
        method: 'POST',
        headers,
        body: payload.message,
      });
      if (!response.ok) {
        throw new Error(`ntfy request failed with status ${response.status}`);
      }
    },
    getConfiguredSecrets(config) {
      const secrets: string[] = [];
      if (rawStringValue(config.ntfyToken)) secrets.push('ntfyToken');
      if (rawStringValue(config.ntfyPassword)) secrets.push('ntfyPassword');
      return secrets;
    },
  },
  webhook: {
    type: 'webhook',
    secretFields: ['auth', 'headers', 'body.fields'],
    getDefaultConfig() {
      return webhookConfigToRecord(defaultWebhookConfig());
    },
    normalizeConfig(config, existingConfig) {
      return webhookConfigToRecord(normalizeWebhookConfig(config, existingConfig));
    },
    maskConfig(config) {
      return maskWebhookConfig(normalizeWebhookConfig(config));
    },
    validateConfig(config) {
      const normalized = normalizeWebhookConfig(config);
      if (!normalized.url) return 'Webhook URL is required';
      const urlError = validateHttpUrl(normalized.url, 'Webhook URL');
      if (urlError) return urlError;
      try {
        const parsed = new URL(normalized.url);
        if (parsed.username || parsed.password) {
          return 'Webhook URL must not embed credentials';
        }
      } catch {
        return 'Webhook URL must be a valid URL';
      }
      if (normalized.auth.mode === 'bearer' && !normalized.auth.token) {
        return 'Bearer authentication requires a token';
      }
      if (normalized.auth.mode === 'basic' && (!normalized.auth.username || !normalized.auth.password)) {
        return 'Basic authentication requires username and password';
      }
      if (normalized.body.mode !== 'form') {
        const templateError = validateTemplate(normalized.body.template);
        if (templateError) return templateError;
      } else {
        for (const field of normalized.body.fields) {
          const templateError = validateTemplate(field.value);
          if (templateError) return templateError;
        }
      }
      for (const query of normalized.query) {
        const templateError = validateTemplate(query.value);
        if (templateError) return templateError;
      }
      for (const header of normalized.headers) {
        const templateError = validateTemplate(header.value);
        if (templateError) return templateError;
      }
      return null;
    },
    async send(channel, payload, context) {
      const config = normalizeWebhookConfig(channel.config);
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= config.retryAttempts; attempt += 1) {
        try {
          await sendWebhookRequest(config, payload, context);
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          const retriable = (lastError as NotificationSendError).retriable !== false;
          if (attempt >= config.retryAttempts || !retriable) {
            throw lastError;
          }
          await delay(config.retryDelayMs);
        }
      }

      throw lastError || new Error('Webhook request failed');
    },
    getConfiguredSecrets(config) {
      return getWebhookConfiguredSecrets(normalizeWebhookConfig(config));
    },
  },
};

export function getNotificationProvider(type: NotificationChannelType): NotificationProvider {
  return providers[type];
}

export function getNotificationProviderTypes(): NotificationChannelType[] {
  return Object.keys(providers) as NotificationChannelType[];
}
