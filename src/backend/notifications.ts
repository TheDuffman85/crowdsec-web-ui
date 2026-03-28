import type {
  AlertMetaValue,
  AlertSpikeRuleConfig,
  AlertRecord,
  AlertThresholdRuleConfig,
  NewCveRuleConfig,
  NotificationChannel,
  NotificationChannelType,
  NotificationDeliveryResult,
  NotificationFilter,
  NotificationItem,
  NotificationListResponse,
  NotificationRule,
  NotificationRuleConfig,
  NotificationRuleType,
  NotificationSettingsResponse,
  UpsertNotificationChannelRequest,
  UpsertNotificationRuleRequest,
} from '../../shared/contracts';
import { CrowdsecDatabase } from './database';
import { sendSmtpMail } from './smtp';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type RuleConfigInput = NotificationRuleConfig | Record<string, AlertMetaValue>;

export interface NotificationServiceOptions {
  database: CrowdsecDatabase;
  fetchImpl?: FetchLike;
}

interface NotificationCandidate {
  dedupeKey: string;
  title: string;
  message: string;
  metadata: Record<string, AlertMetaValue>;
}

const SECRET_FIELDS: Record<NotificationChannelType, string[]> = {
  ntfy: ['token', 'password'],
  gotify: ['token'],
  email: ['password'],
  webhook: ['authorization_header'],
};

const DEFAULT_CHANNEL_CONFIG: Record<NotificationChannelType, Record<string, AlertMetaValue>> = {
  ntfy: {
    server_url: 'https://ntfy.sh',
    topic: '',
    priority: 'default',
    tags: 'warning,shield',
    title_prefix: 'CrowdSec',
    username: '',
    password: '',
    token: '',
  },
  gotify: {
    server_url: '',
    token: '',
    priority: 5,
  },
  email: {
    host: '',
    port: 587,
    secure: false,
    username: '',
    password: '',
    from: '',
    to: '',
    subject_prefix: '[CrowdSec]',
  },
  webhook: {
    url: '',
    method: 'POST',
    authorization_header: '',
  },
};

export interface NotificationService {
  listSettings: () => NotificationSettingsResponse;
  listNotifications: (limit?: number) => NotificationListResponse;
  createChannel: (input: UpsertNotificationChannelRequest) => NotificationChannel;
  updateChannel: (id: string, input: UpsertNotificationChannelRequest) => NotificationChannel;
  deleteChannel: (id: string) => void;
  createRule: (input: UpsertNotificationRuleRequest) => NotificationRule;
  updateRule: (id: string, input: UpsertNotificationRuleRequest) => NotificationRule;
  deleteRule: (id: string) => void;
  markNotificationRead: (id: string) => boolean;
  markAllNotificationsRead: () => number;
  testChannel: (id: string) => Promise<void>;
  evaluateRules: (now?: Date) => Promise<void>;
}

export function createNotificationService(options: NotificationServiceOptions): NotificationService {
  const database = options.database;
  const fetchImpl = options.fetchImpl || fetch;

  return {
    listSettings,
    listNotifications,
    createChannel,
    updateChannel,
    deleteChannel,
    createRule,
    updateRule,
    deleteRule,
    markNotificationRead,
    markAllNotificationsRead,
    testChannel,
    evaluateRules,
  };

  function listSettings(): NotificationSettingsResponse {
    return { channels: loadChannels(true), rules: loadRules() };
  }

  function listNotifications(limit = 100): NotificationListResponse {
    const notifications = database.listNotifications(limit).map((row) => ({
      id: String(row.id),
      rule_id: String(row.rule_id),
      rule_name: String(row.rule_name),
      rule_type: normalizeRuleType(row.rule_type),
      severity: normalizeSeverity(row.severity),
      title: String(row.title),
      message: String(row.message),
      created_at: String(row.created_at),
      read_at: row.read_at ? String(row.read_at) : null,
      metadata: parseJsonRecord(row.metadata_json),
      deliveries: parseJsonArray<NotificationDeliveryResult>(row.deliveries_json),
    }));

    return {
      notifications,
      unread_count: database.countUnreadNotifications(),
    };
  }

  function createChannel(input: UpsertNotificationChannelRequest): NotificationChannel {
    const now = new Date().toISOString();
    const channel = normalizeChannelInput(input, null, crypto.randomUUID(), now);
    saveChannel(channel);
    return sanitizeChannel(channel);
  }

  function updateChannel(id: string, input: UpsertNotificationChannelRequest): NotificationChannel {
    const existing = getStoredChannel(id);
    if (!existing) {
      throw new Error('Notification channel not found');
    }

    const channel = normalizeChannelInput(input, existing, id, existing.created_at);
    saveChannel(channel);
    return sanitizeChannel(channel);
  }

  function deleteChannel(id: string): void {
    database.deleteNotificationChannel(id);

    for (const rule of loadRules()) {
      if (!rule.channel_ids.includes(id)) {
        continue;
      }
      saveRule({
        ...rule,
        channel_ids: rule.channel_ids.filter((value) => value !== id),
        updated_at: new Date().toISOString(),
      });
    }
  }

  function createRule(input: UpsertNotificationRuleRequest): NotificationRule {
    const now = new Date().toISOString();
    const rule = normalizeRuleInput(input, null, crypto.randomUUID(), now);
    saveRule(rule);
    return rule;
  }

  function updateRule(id: string, input: UpsertNotificationRuleRequest): NotificationRule {
    const existing = getStoredRule(id);
    if (!existing) {
      throw new Error('Notification rule not found');
    }

    const rule = normalizeRuleInput(input, existing, id, existing.created_at);
    saveRule(rule);
    return rule;
  }

  function deleteRule(id: string): void {
    database.deleteNotificationRule(id);
  }

  function markNotificationRead(id: string): boolean {
    return database.markNotificationRead(id, new Date().toISOString());
  }

  function markAllNotificationsRead(): number {
    return database.markAllNotificationsRead(new Date().toISOString());
  }

  async function testChannel(id: string): Promise<void> {
    const channel = getStoredChannel(id);
    if (!channel) {
      throw new Error('Notification channel not found');
    }
    if (!channel.enabled) {
      throw new Error('Enable the notification channel before testing it');
    }

    const result = await sendToChannel(channel, {
      title: 'CrowdSec notification test',
      message: `Test sent at ${new Date().toLocaleString()}.`,
      metadata: { kind: 'test' },
      dedupeKey: `test:${Date.now()}`,
    });
    if (result.status !== 'delivered') {
      throw new Error(result.error || 'Test notification failed');
    }
  }

  async function evaluateRules(now = new Date()): Promise<void> {
    const rules = loadRules().filter((rule) => rule.enabled);
    if (rules.length === 0) {
      return;
    }

    const activeChannels = loadChannels(false).filter((channel) => channel.enabled);
    for (const rule of rules) {
      const candidates = await evaluateRule(rule, now);
      if (candidates.length === 0) {
        continue;
      }

      for (const candidate of candidates) {
        const latest = database.getLatestNotificationForRule(rule.id);
        if (latest && isWithinCooldown(latest.created_at, rule.cooldown_minutes, now)) {
          continue;
        }

        const deliveries: NotificationDeliveryResult[] = [];
        for (const channel of activeChannels.filter((item) => rule.channel_ids.includes(item.id))) {
          deliveries.push(await sendToChannel(channel, candidate));
        }

        const timestamp = now.toISOString();
        database.insertNotification({
          $id: crypto.randomUUID(),
          $created_at: timestamp,
          $updated_at: timestamp,
          $rule_id: rule.id,
          $rule_name: rule.name,
          $rule_type: rule.type,
          $severity: rule.severity,
          $title: candidate.title,
          $message: candidate.message,
          $read_at: null,
          $metadata_json: JSON.stringify(candidate.metadata),
          $deliveries_json: JSON.stringify(deliveries),
          $dedupe_key: `${rule.id}:${candidate.dedupeKey}`,
        });
      }
    }
  }

  function getStoredChannel(id: string): NotificationChannel | null {
    const row = database.getNotificationChannelById(id);
    return row ? hydrateChannel(row) : null;
  }

  function getStoredRule(id: string): NotificationRule | null {
    const row = database.getNotificationRuleById(id);
    return row ? hydrateRule(row) : null;
  }

  function loadChannels(sanitize = true): NotificationChannel[] {
    return database.listNotificationChannels().map((row) => {
      const channel = hydrateChannel(row);
      return sanitize ? sanitizeChannel(channel) : channel;
    });
  }

  function loadRules(): NotificationRule[] {
    return database.listNotificationRules().map(hydrateRule);
  }

  function hydrateChannel(row: {
    id?: string;
    created_at?: string;
    updated_at?: string;
    name?: string;
    type?: string;
    enabled?: number;
    config_json?: string;
  }): NotificationChannel {
    const type = normalizeChannelType(row.type);
    const config = {
      ...DEFAULT_CHANNEL_CONFIG[type],
      ...parseJsonRecord(row.config_json),
    };
    return {
      id: String(row.id),
      name: String(row.name),
      type,
      enabled: row.enabled === 1,
      config,
      configured_secrets: SECRET_FIELDS[type].filter((field) => Boolean(config[field])),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  function hydrateRule(row: {
    id?: string;
    created_at?: string;
    updated_at?: string;
    name?: string;
    type?: string;
    enabled?: number;
    severity?: string;
    cooldown_minutes?: number;
    channel_ids_json?: string;
    config_json?: string;
  }): NotificationRule {
    const type = normalizeRuleType(row.type);
    return {
      id: String(row.id),
      name: String(row.name),
      type,
      enabled: row.enabled === 1,
      severity: normalizeSeverity(row.severity),
      cooldown_minutes: Math.max(0, Number(row.cooldown_minutes) || 0),
      channel_ids: parseJsonArray<string>(row.channel_ids_json).filter((value): value is string => typeof value === 'string'),
      config: normalizeRuleConfig(type, parseJsonRecord(row.config_json)),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  function saveChannel(channel: NotificationChannel): void {
    database.upsertNotificationChannel({
      $id: channel.id,
      $created_at: channel.created_at,
      $updated_at: channel.updated_at,
      $name: channel.name,
      $type: channel.type,
      $enabled: channel.enabled ? 1 : 0,
      $config_json: JSON.stringify(channel.config),
    });
  }

  function saveRule(rule: NotificationRule): void {
    database.upsertNotificationRule({
      $id: rule.id,
      $created_at: rule.created_at,
      $updated_at: rule.updated_at,
      $name: rule.name,
      $type: rule.type,
      $enabled: rule.enabled ? 1 : 0,
      $severity: rule.severity,
      $cooldown_minutes: rule.cooldown_minutes,
      $channel_ids_json: JSON.stringify(rule.channel_ids),
      $config_json: JSON.stringify(rule.config),
    });
  }

  function sanitizeChannel(channel: NotificationChannel): NotificationChannel {
    const config = { ...channel.config };
    for (const field of SECRET_FIELDS[channel.type]) {
      config[field] = '';
    }
    return { ...channel, config };
  }

  function normalizeChannelInput(
    input: UpsertNotificationChannelRequest,
    existing: NotificationChannel | null,
    id: string,
    createdAt: string,
  ): NotificationChannel {
    const type = normalizeChannelType(input.type);
    const name = String(input.name || '').trim();
    if (!name) {
      throw new Error('Channel name is required');
    }

    const config = mergeChannelConfig(type, input.config, existing?.config);
    validateChannelConfig(type, config);

    return {
      id,
      name,
      type,
      enabled: input.enabled !== false,
      config,
      configured_secrets: SECRET_FIELDS[type].filter((field) => Boolean(config[field])),
      created_at: createdAt,
      updated_at: new Date().toISOString(),
    };
  }

  function normalizeRuleInput(
    input: UpsertNotificationRuleRequest,
    existing: NotificationRule | null,
    id: string,
    createdAt: string,
  ): NotificationRule {
    const type = normalizeRuleType(input.type);
    const name = String(input.name || '').trim();
    if (!name) {
      throw new Error('Rule name is required');
    }

    const channelIds = Array.isArray(input.channel_ids)
      ? input.channel_ids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];

    const knownChannels = new Set(loadChannels(false).map((channel) => channel.id));
    for (const channelId of channelIds) {
      if (!knownChannels.has(channelId)) {
        throw new Error(`Unknown notification channel: ${channelId}`);
      }
    }

    return {
      id,
      name,
      type,
      enabled: input.enabled !== false,
      severity: normalizeSeverity(input.severity),
      cooldown_minutes: normalizePositiveNumber(input.cooldown_minutes, existing?.cooldown_minutes ?? 60),
      channel_ids: channelIds,
      config: normalizeRuleConfig(type, input.config),
      created_at: createdAt,
      updated_at: new Date().toISOString(),
    };
  }

  async function evaluateRule(rule: NotificationRule, now: Date): Promise<NotificationCandidate[]> {
    if (rule.type === 'alert-spike') {
      return evaluateAlertSpikeRule(rule, now);
    }
    if (rule.type === 'alert-threshold') {
      return evaluateAlertThresholdRule(rule, now);
    }
    return evaluateNewCveRule(rule, now);
  }

  async function evaluateAlertSpikeRule(rule: NotificationRule, now: Date): Promise<NotificationCandidate[]> {
    const config = normalizeRuleConfig('alert-spike', rule.config);
    const windowMs = config.window_minutes * 60_000;
    const currentStart = now.getTime() - windowMs;
    const previousStart = currentStart - windowMs;
    const currentAlerts = getAlertsBetween(new Date(currentStart), now, config.filters);
    const previousAlerts = getAlertsBetween(new Date(previousStart), new Date(currentStart), config.filters);
    const baseline = Math.max(previousAlerts.length, 1);
    const increasePercent = ((currentAlerts.length - previousAlerts.length) / baseline) * 100;

    if (
      currentAlerts.length < config.minimum_current_alerts ||
      currentAlerts.length <= previousAlerts.length ||
      increasePercent < config.percent_increase
    ) {
      return [];
    }

    return [{
      dedupeKey: `spike:${floorToBucket(now.getTime(), windowMs)}`,
      title: `${rule.name}: alert spike detected`,
      message: `${currentAlerts.length} alerts in the last ${config.window_minutes} minutes, up ${Math.round(increasePercent)}% from the previous window (${previousAlerts.length}).`,
      metadata: {
        current_count: currentAlerts.length,
        previous_count: previousAlerts.length,
        increase_percent: Math.round(increasePercent),
        window_minutes: config.window_minutes,
        filters: toMetaRecord(config.filters),
      },
    }];
  }

  async function evaluateAlertThresholdRule(rule: NotificationRule, now: Date): Promise<NotificationCandidate[]> {
    const config = normalizeRuleConfig('alert-threshold', rule.config);
    const windowMs = config.window_minutes * 60_000;
    const alerts = getAlertsBetween(new Date(now.getTime() - windowMs), now, config.filters);

    if (alerts.length < config.alert_threshold) {
      return [];
    }

    return [{
      dedupeKey: `threshold:${floorToBucket(now.getTime(), windowMs)}`,
      title: `${rule.name}: threshold exceeded`,
      message: `${alerts.length} alerts matched in the last ${config.window_minutes} minutes, crossing the threshold of ${config.alert_threshold}.`,
      metadata: {
        matched_alerts: alerts.length,
        threshold: config.alert_threshold,
        window_minutes: config.window_minutes,
        filters: toMetaRecord(config.filters),
      },
    }];
  }

  async function evaluateNewCveRule(rule: NotificationRule, now: Date): Promise<NotificationCandidate[]> {
    const config = normalizeRuleConfig('new-cve', rule.config);
    const alerts = getAlertsBetween(new Date(now.getTime() - 7 * 86_400_000), now, config.filters);
    const matches = new Map<string, AlertRecord[]>();

    for (const alert of alerts) {
      for (const cveId of extractCveIds(alert)) {
        const list = matches.get(cveId) || [];
        list.push(alert);
        matches.set(cveId, list);
      }
    }

    const candidates: NotificationCandidate[] = [];
    for (const [cveId, matchedAlerts] of matches.entries()) {
      const publishedAt = await getCvePublishedAt(cveId);
      if (!publishedAt) {
        continue;
      }

      const ageDays = Math.floor((now.getTime() - publishedAt.getTime()) / 86_400_000);
      if (ageDays > config.max_cve_age_days) {
        continue;
      }

      candidates.push({
        dedupeKey: `cve:${cveId}`,
        title: `${rule.name}: recent CVE activity`,
        message: `${cveId} was published ${ageDays} day${ageDays === 1 ? '' : 's'} ago and appeared in ${matchedAlerts.length} alert${matchedAlerts.length === 1 ? '' : 's'}.`,
        metadata: {
          cve_id: cveId,
          age_days: ageDays,
          published_at: publishedAt.toISOString(),
          matched_alerts: matchedAlerts.length,
          filters: toMetaRecord(config.filters),
        },
      });
    }

    return candidates;
  }

  function getAlertsBetween(start: Date, end: Date, filters?: NotificationFilter): AlertRecord[] {
    return database
      .getAlertsBetween(start.toISOString(), end.toISOString())
      .map((row) => JSON.parse(row.raw_data) as AlertRecord)
      .filter((alert) => matchesAlertFilters(alert, filters));
  }

  async function getCvePublishedAt(cveId: string): Promise<Date | null> {
    const cached = database.getCveCacheEntry(cveId);
    if (cached?.published_at) {
      return new Date(String(cached.published_at));
    }

    try {
      const response = await fetchImpl(`https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${encodeURIComponent(cveId)}`, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'crowdsec-web-ui',
        },
      });
      if (!response.ok) {
        return null;
      }

      const payload = await response.json() as { vulnerabilities?: Array<{ cve?: { published?: string } }> };
      const published = payload.vulnerabilities?.[0]?.cve?.published;
      if (!published) {
        return null;
      }

      database.upsertCveCacheEntry(cveId, published, new Date().toISOString());
      return new Date(published);
    } catch (error) {
      console.error(`Failed to resolve ${cveId} from NVD:`, error);
      return null;
    }
  }

  async function sendToChannel(channel: NotificationChannel, candidate: NotificationCandidate): Promise<NotificationDeliveryResult> {
    const attemptedAt = new Date().toISOString();
    try {
      if (channel.type === 'ntfy') {
        await sendNtfyNotification(fetchImpl, channel, candidate.title, candidate.message);
      } else if (channel.type === 'gotify') {
        await sendGotifyNotification(fetchImpl, channel, candidate.title, candidate.message);
      } else if (channel.type === 'webhook') {
        await sendWebhookNotification(fetchImpl, channel, candidate.title, candidate.message, candidate.metadata);
      } else {
        await sendEmailNotification(channel, candidate.title, candidate.message);
      }

      return {
        channel_id: channel.id,
        channel_name: channel.name,
        channel_type: channel.type,
        status: 'delivered',
        attempted_at: attemptedAt,
      };
    } catch (error) {
      return {
        channel_id: channel.id,
        channel_name: channel.name,
        channel_type: channel.type,
        status: 'failed',
        attempted_at: attemptedAt,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

function mergeChannelConfig(
  type: NotificationChannelType,
  inputConfig: Record<string, AlertMetaValue>,
  existingConfig?: Record<string, AlertMetaValue>,
): Record<string, AlertMetaValue> {
  const config = { ...DEFAULT_CHANNEL_CONFIG[type], ...(existingConfig || {}) };
  const safeInput = inputConfig && typeof inputConfig === 'object' && !Array.isArray(inputConfig) ? inputConfig : {};
  for (const [key, value] of Object.entries(safeInput)) {
    if (SECRET_FIELDS[type].includes(key) && (value === '' || value === null || value === undefined)) {
      continue;
    }
    config[key] = value;
  }
  return config;
}

function validateChannelConfig(type: NotificationChannelType, config: Record<string, AlertMetaValue>): void {
  if (type === 'ntfy' && !getConfigString(config, 'topic')) {
    throw new Error('ntfy topic is required');
  }
  if (type === 'gotify' && (!getConfigString(config, 'server_url') || !getConfigString(config, 'token'))) {
    throw new Error('Gotify server URL and token are required');
  }
  if (type === 'webhook' && !getConfigString(config, 'url')) {
    throw new Error('Webhook URL is required');
  }
  if (type === 'email') {
    for (const field of ['host', 'from', 'to']) {
      if (!getConfigString(config, field)) {
        throw new Error(`Email ${field} is required`);
      }
    }
  }
}

function normalizeRuleConfig(type: 'alert-spike', config: RuleConfigInput): AlertSpikeRuleConfig;
function normalizeRuleConfig(type: 'alert-threshold', config: RuleConfigInput): AlertThresholdRuleConfig;
function normalizeRuleConfig(type: 'new-cve', config: RuleConfigInput): NewCveRuleConfig;
function normalizeRuleConfig(type: NotificationRuleType, config: RuleConfigInput): NotificationRuleConfig;
function normalizeRuleConfig(type: NotificationRuleType, config: RuleConfigInput): NotificationRuleConfig {
  const safeConfig = config && typeof config === 'object' && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {};
  const filters = normalizeFilters(safeConfig.filters as NotificationFilter | undefined);

  if (type === 'alert-spike') {
    return {
      window_minutes: normalizePositiveNumber(safeConfig.window_minutes, 60),
      percent_increase: normalizePositiveNumber(safeConfig.percent_increase, 100),
      minimum_current_alerts: normalizePositiveNumber(safeConfig.minimum_current_alerts, 10),
      filters,
    };
  }

  if (type === 'alert-threshold') {
    return {
      window_minutes: normalizePositiveNumber(safeConfig.window_minutes, 60),
      alert_threshold: normalizePositiveNumber(safeConfig.alert_threshold, 25),
      filters,
    };
  }

  return {
    max_cve_age_days: normalizePositiveNumber(safeConfig.max_cve_age_days, 14),
    filters,
  };
}

function toMetaRecord(filters?: NotificationFilter): Record<string, unknown> {
  return filters ? { ...filters } : {};
}

function normalizeFilters(filters: NotificationFilter | undefined): NotificationFilter | undefined {
  if (!filters || typeof filters !== 'object') {
    return undefined;
  }
  const scenario = typeof filters.scenario === 'string' ? filters.scenario.trim() : '';
  const target = typeof filters.target === 'string' ? filters.target.trim() : '';
  if (!scenario && !target && filters.include_simulated !== true) {
    return undefined;
  }
  return {
    scenario: scenario || undefined,
    target: target || undefined,
    include_simulated: filters.include_simulated === true,
  };
}

function matchesAlertFilters(alert: AlertRecord, filters?: NotificationFilter): boolean {
  if (filters?.include_simulated !== true && alert.simulated === true) {
    return false;
  }
  if (filters?.scenario && !String(alert.scenario || '').toLowerCase().includes(filters.scenario.toLowerCase())) {
    return false;
  }
  if (filters?.target && !String(alert.target || '').toLowerCase().includes(filters.target.toLowerCase())) {
    return false;
  }
  return true;
}

function extractCveIds(alert: AlertRecord): string[] {
  const inputs: string[] = [];
  if (typeof alert.message === 'string') inputs.push(alert.message);
  if (typeof alert.meta_search === 'string') inputs.push(alert.meta_search);
  for (const event of alert.events || []) {
    for (const meta of event.meta || []) {
      if (typeof meta.value === 'string') inputs.push(meta.value);
    }
  }

  const matcher = /\bCVE-\d{4}-\d{4,7}\b/gi;
  const values = new Set<string>();
  for (const input of inputs) {
    for (const match of input.matchAll(matcher)) {
      values.add(match[0].toUpperCase());
    }
  }
  return [...values];
}

async function sendNtfyNotification(fetchImpl: FetchLike, channel: NotificationChannel, title: string, message: string): Promise<void> {
  const serverUrl = normalizeUrl(getConfigString(channel.config, 'server_url') || 'https://ntfy.sh');
  const topic = getConfigString(channel.config, 'topic');
  if (!topic) {
    throw new Error('ntfy topic is required');
  }

  const headers: Record<string, string> = {
    Title: appendPrefix(getConfigString(channel.config, 'title_prefix'), title),
  };
  const priority = getConfigString(channel.config, 'priority');
  const tags = getConfigString(channel.config, 'tags');
  if (priority) headers.Priority = priority;
  if (tags) headers.Tags = tags;
  applyAuthHeaders(headers, getConfigString(channel.config, 'token'), getConfigString(channel.config, 'username'), getConfigString(channel.config, 'password'));

  const response = await fetchImpl(`${serverUrl}/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers,
    body: message,
  });
  if (!response.ok) {
    throw new Error(`ntfy request failed with status ${response.status}`);
  }
}

async function sendGotifyNotification(fetchImpl: FetchLike, channel: NotificationChannel, title: string, message: string): Promise<void> {
  const serverUrl = normalizeUrl(getConfigString(channel.config, 'server_url'));
  const token = getConfigString(channel.config, 'token');
  if (!serverUrl || !token) {
    throw new Error('Gotify server URL and token are required');
  }

  const response = await fetchImpl(`${serverUrl}/message?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, message, priority: Number(channel.config.priority) || 5 }),
  });
  if (!response.ok) {
    throw new Error(`Gotify request failed with status ${response.status}`);
  }
}

async function sendWebhookNotification(
  fetchImpl: FetchLike,
  channel: NotificationChannel,
  title: string,
  message: string,
  metadata: Record<string, AlertMetaValue>,
): Promise<void> {
  const url = getConfigString(channel.config, 'url');
  if (!url) {
    throw new Error('Webhook URL is required');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const authorization = getConfigString(channel.config, 'authorization_header');
  if (authorization) {
    headers.Authorization = authorization;
  }

  const response = await fetchImpl(url, {
    method: getConfigString(channel.config, 'method') || 'POST',
    headers,
    body: JSON.stringify({ title, message, metadata, sent_at: new Date().toISOString() }),
  });
  if (!response.ok) {
    throw new Error(`Webhook request failed with status ${response.status}`);
  }
}

async function sendEmailNotification(channel: NotificationChannel, title: string, message: string): Promise<void> {
  const to = getConfigString(channel.config, 'to')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  await sendSmtpMail({
    host: getConfigString(channel.config, 'host'),
    port: Number(channel.config.port) || 587,
    secure: channel.config.secure === true || String(channel.config.secure).toLowerCase() === 'true',
    username: getConfigString(channel.config, 'username') || undefined,
    password: getConfigString(channel.config, 'password') || undefined,
    from: getConfigString(channel.config, 'from'),
    to,
    subject: appendPrefix(getConfigString(channel.config, 'subject_prefix'), title),
    text: message,
  });
}

function normalizeChannelType(value: unknown): NotificationChannelType {
  if (value === 'ntfy' || value === 'gotify' || value === 'email' || value === 'webhook') return value;
  throw new Error('Invalid notification channel type');
}

function normalizeRuleType(value: unknown): NotificationRuleType {
  if (value === 'alert-spike' || value === 'alert-threshold' || value === 'new-cve') return value;
  throw new Error('Invalid notification rule type');
}

function normalizeSeverity(value: unknown): NotificationItem['severity'] {
  return value === 'info' || value === 'warning' || value === 'critical' ? value : 'warning';
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : fallback;
}

function parseJsonRecord(value: string | undefined): Record<string, AlertMetaValue> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, AlertMetaValue>;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray<T>(value: string | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as T[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getConfigString(config: Record<string, AlertMetaValue>, key: string): string {
  const value = config[key];
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

function normalizeUrl(value: string): string {
  return value.replace(/\/$/, '');
}

function applyAuthHeaders(headers: Record<string, string>, token: string, username: string, password: string): void {
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    return;
  }
  if (username && password) {
    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }
}

function appendPrefix(prefix: string, value: string): string {
  return prefix ? `${prefix}: ${value}` : value;
}

function floorToBucket(timestampMs: number, bucketMs: number): number {
  return Math.floor(timestampMs / bucketMs) * bucketMs;
}

function isWithinCooldown(createdAt: string | undefined, cooldownMinutes: number, now: Date): boolean {
  if (!createdAt || cooldownMinutes <= 0) return false;
  return now.getTime() - new Date(createdAt).getTime() < cooldownMinutes * 60_000;
}
