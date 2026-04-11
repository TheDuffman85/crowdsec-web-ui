import type {
  AlertMetaValue,
  AlertSpikeRuleConfig,
  ApplicationUpdateRuleConfig,
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
  NotificationSeverity,
  NotificationSettingsResponse,
  UpsertNotificationChannelRequest,
  UpsertNotificationRuleRequest,
  UpdateCheckResponse,
} from '../shared/contracts';
import { CrowdsecDatabase } from './database';
import type { MqttPublishConfig } from './notifications/mqtt-client';
import {
  getNotificationProvider,
  type NotificationProviderPayload,
} from './notifications/providers';
import type { NotificationOutboundGuard } from './notifications/outbound-guard';
import type { NotificationSecretStore } from './notifications/secret-store';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type RuleConfigInput = NotificationRuleConfig | Record<string, AlertMetaValue>;

export interface NotificationServiceOptions {
  database: CrowdsecDatabase;
  fetchImpl?: FetchLike;
  mqttPublishImpl?: (config: MqttPublishConfig, payload: string) => Promise<void>;
  updateChecker?: () => Promise<UpdateCheckResponse>;
  outboundGuard: NotificationOutboundGuard;
  secretStore: NotificationSecretStore;
}

interface NotificationCandidate {
  dedupeKey: string;
  title: string;
  message: string;
  metadata: Record<string, AlertMetaValue>;
}

interface NotificationIncidentState {
  incidentKey: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}

export interface NotificationService {
  listSettings: () => NotificationSettingsResponse;
  listNotifications: (page?: number, pageSize?: number) => NotificationListResponse;
  createChannel: (input: UpsertNotificationChannelRequest) => NotificationChannel;
  updateChannel: (id: string, input: UpsertNotificationChannelRequest) => NotificationChannel;
  deleteChannel: (id: string) => void;
  createRule: (input: UpsertNotificationRuleRequest) => NotificationRule;
  updateRule: (id: string, input: UpsertNotificationRuleRequest) => NotificationRule;
  deleteRule: (id: string) => void;
  deleteNotification: (id: string) => boolean;
  deleteNotifications: (ids: string[]) => number;
  deleteReadNotifications: () => number;
  markNotificationRead: (id: string) => boolean;
  markNotificationsRead: (ids: string[]) => number;
  markAllNotificationsRead: () => number;
  testChannel: (id: string) => Promise<void>;
  evaluateRules: (now?: Date) => Promise<void>;
}

export function createNotificationService(options: NotificationServiceOptions): NotificationService {
  const database = options.database;
  const fetchImpl = options.fetchImpl || fetch;
  const mqttPublishImpl = options.mqttPublishImpl;
  const updateChecker = options.updateChecker;
  const outboundGuard = options.outboundGuard;
  const secretStore = options.secretStore;

  return {
    listSettings,
    listNotifications,
    createChannel,
    updateChannel,
    deleteChannel,
    createRule,
    updateRule,
    deleteRule,
    deleteNotification,
    deleteNotifications,
    deleteReadNotifications,
    markNotificationRead,
    markNotificationsRead,
    markAllNotificationsRead,
    testChannel,
    evaluateRules,
  };

  function listSettings(): NotificationSettingsResponse {
    return { channels: loadChannels(true), rules: loadRules() };
  }

  function listNotifications(page = 1, pageSize = 50): NotificationListResponse {
    const total = database.countNotifications();
    const safePage = Math.max(1, page);
    const safePageSize = Math.max(1, pageSize);
    const data = database.listNotificationsPage(safePage, safePageSize).map((row) => ({
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
      data,
      pagination: {
        page: safePage,
        page_size: safePageSize,
        total,
        total_pages: Math.ceil(total / safePageSize),
        unfiltered_total: total,
      },
      selectable_ids: database.listNotificationIds(),
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
    if (shouldResetIncidentState(existing, rule)) {
      database.deleteNotificationIncidentsByRule(id);
    }
    return rule;
  }

  function deleteRule(id: string): void {
    database.deleteNotificationIncidentsByRule(id);
    database.deleteNotificationRule(id);
  }

  function deleteNotification(id: string): boolean {
    return database.deleteNotification(id);
  }

  function deleteNotifications(ids: string[]): number {
    return database.deleteNotifications(ids);
  }

  function deleteReadNotifications(): number {
    return database.deleteReadNotifications();
  }

  function markNotificationRead(id: string): boolean {
    return database.markNotificationRead(id, new Date().toISOString());
  }

  function markNotificationsRead(ids: string[]): number {
    return database.markNotificationsRead(ids, new Date().toISOString());
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
    }, 'info');
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
    const timestamp = now.toISOString();
    for (const rule of rules) {
      const candidates = await evaluateRule(rule, now);
      const activeIncidents = loadActiveIncidents(rule.id);
      const candidateKeys = new Set(candidates.map((candidate) => candidate.dedupeKey));

      for (const incident of activeIncidents.values()) {
        if (!candidateKeys.has(incident.incidentKey)) {
          database.resolveNotificationIncident(rule.id, incident.incidentKey, timestamp);
        }
      }

      for (const candidate of candidates) {
        const existingIncident = activeIncidents.get(candidate.dedupeKey);
        if (existingIncident) {
          database.upsertNotificationIncident({
            $rule_id: rule.id,
            $incident_key: existingIncident.incidentKey,
            $first_seen_at: existingIncident.firstSeenAt,
            $last_seen_at: timestamp,
            $resolved_at: null,
          });
          continue;
        }

        const deliveries: NotificationDeliveryResult[] = [];
        for (const channel of activeChannels.filter((item) => rule.channel_ids.includes(item.id))) {
          deliveries.push(await sendToChannel(channel, candidate, rule.severity, rule));
        }

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
          $dedupe_key: candidate.dedupeKey,
        });
        database.upsertNotificationIncident({
          $rule_id: rule.id,
          $incident_key: candidate.dedupeKey,
          $first_seen_at: timestamp,
          $last_seen_at: timestamp,
          $resolved_at: null,
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

  function loadActiveIncidents(ruleId: string): Map<string, NotificationIncidentState> {
    return new Map(
      database
        .listNotificationIncidentsByRule(ruleId)
        .filter((row) => row.resolved_at == null)
        .map((row) => [
          String(row.incident_key),
          {
            incidentKey: String(row.incident_key),
            firstSeenAt: String(row.first_seen_at),
            lastSeenAt: String(row.last_seen_at),
            resolvedAt: row.resolved_at == null ? null : String(row.resolved_at),
          } satisfies NotificationIncidentState,
        ]),
    );
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
    const provider = getNotificationProvider(type);
    const parsedConfig = secretStore.parseConfig(String(row.config_json || '{}'));
    const config = provider.normalizeConfig(parsedConfig.config as Record<string, AlertMetaValue>);
    const configuredSecrets = provider.getConfiguredSecrets(config);
    if (configuredSecrets.length > 0 && !parsedConfig.isEncrypted && !secretStore.hasKey()) {
      throw new Error('NOTIFICATION_SECRET_KEY is required to load notification destinations with saved secrets');
    }
    return {
      id: String(row.id),
      name: String(row.name),
      type,
      enabled: row.enabled === 1,
      config,
      configured_secrets: configuredSecrets,
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
      channel_ids: parseJsonArray<string>(row.channel_ids_json).filter((value): value is string => typeof value === 'string'),
      config: normalizeRuleConfig(type, parseJsonRecord(row.config_json)),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  function saveChannel(channel: NotificationChannel): void {
    const provider = getNotificationProvider(channel.type);
    database.upsertNotificationChannel({
      $id: channel.id,
      $created_at: channel.created_at,
      $updated_at: channel.updated_at,
      $name: channel.name,
      $type: channel.type,
      $enabled: channel.enabled ? 1 : 0,
      $config_json: secretStore.serializeConfig(channel.config, provider.getConfiguredSecrets(channel.config).length > 0),
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
      $channel_ids_json: JSON.stringify(rule.channel_ids),
      $config_json: JSON.stringify(rule.config),
    });
  }

  function sanitizeChannel(channel: NotificationChannel): NotificationChannel {
    const provider = getNotificationProvider(channel.type);
    return { ...channel, config: provider.maskConfig(channel.config) };
  }

  function normalizeChannelInput(
    input: UpsertNotificationChannelRequest,
    existing: NotificationChannel | null,
    id: string,
    createdAt: string,
  ): NotificationChannel {
    const type = normalizeChannelType(input.type);
    const provider = getNotificationProvider(type);
    const name = String(input.name || '').trim();
    if (!name) {
      throw new Error('Channel name is required');
    }

    const config = provider.normalizeConfig(input.config, existing?.config);
    const validationError = provider.validateConfig(config);
    if (validationError) {
      throw new Error(validationError);
    }

    return {
      id,
      name,
      type,
      enabled: input.enabled !== false,
      config,
      configured_secrets: provider.getConfiguredSecrets(config),
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
    if (rule.type === 'application-update') {
      return evaluateApplicationUpdateRule(rule);
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
      dedupeKey: 'spike:active',
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
      dedupeKey: 'threshold:active',
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

  async function evaluateApplicationUpdateRule(rule: NotificationRule): Promise<NotificationCandidate[]> {
    if (!updateChecker) {
      return [];
    }

    const status = await updateChecker();
    if (!status.update_available || !status.remote_version) {
      return [];
    }

    const targetVersion = status.tag === 'dev' ? `dev-${status.remote_version}` : status.remote_version;
    const currentVersion = status.local_version || 'current version';

    return [{
      dedupeKey: `application-update:${targetVersion}`,
      title: `${rule.name}: application update available`,
      message: `A newer CrowdSec Web UI version is available: ${currentVersion} -> ${targetVersion}.`,
      metadata: {
        update_available: true,
        local_version: status.local_version || null,
        remote_version: status.remote_version,
        release_url: status.release_url || null,
        tag: status.tag || null,
      },
    }];
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

  async function sendToChannel(
    channel: NotificationChannel,
    candidate: NotificationCandidate,
    severity: NotificationSeverity,
    rule?: Pick<NotificationRule, 'id' | 'name' | 'type'>,
  ): Promise<NotificationDeliveryResult> {
    const attemptedAt = new Date().toISOString();
    try {
      const provider = getNotificationProvider(channel.type);
      const payload: NotificationProviderPayload = {
        title: candidate.title,
        message: candidate.message,
        severity,
        metadata: candidate.metadata,
        sent_at: attemptedAt,
        channel_id: channel.id,
        channel_name: channel.name,
        channel_type: channel.type,
        rule_id: rule?.id || null,
        rule_name: rule?.name || null,
        rule_type: rule?.type || null,
      };
      await provider.send(channel, payload, {
        fetchImpl,
        mqttPublishImpl,
        assertHostAllowed: outboundGuard.assertHostAllowed,
        assertUrlAllowed: outboundGuard.assertUrlAllowed,
      });

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

function normalizeRuleConfig(type: 'alert-spike', config: RuleConfigInput): AlertSpikeRuleConfig;
function normalizeRuleConfig(type: 'alert-threshold', config: RuleConfigInput): AlertThresholdRuleConfig;
function normalizeRuleConfig(type: 'new-cve', config: RuleConfigInput): NewCveRuleConfig;
function normalizeRuleConfig(type: 'application-update', config: RuleConfigInput): ApplicationUpdateRuleConfig;
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

  if (type === 'application-update') {
    return {};
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

function normalizeChannelType(value: unknown): NotificationChannelType {
  if (value === 'ntfy' || value === 'gotify' || value === 'email' || value === 'mqtt' || value === 'webhook') return value;
  throw new Error('Invalid notification channel type');
}

function normalizeRuleType(value: unknown): NotificationRuleType {
  if (value === 'alert-spike' || value === 'alert-threshold' || value === 'new-cve' || value === 'application-update') return value;
  throw new Error('Invalid notification rule type');
}

function normalizeSeverity(value: unknown): NotificationItem['severity'] {
  return value === 'info' || value === 'warning' || value === 'critical' ? value : 'warning';
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : fallback;
}

function shouldResetIncidentState(existing: NotificationRule, next: NotificationRule): boolean {
  if (!next.enabled) {
    return true;
  }
  if (existing.type !== next.type) {
    return true;
  }
  return JSON.stringify(existing.config) !== JSON.stringify(next.config);
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
