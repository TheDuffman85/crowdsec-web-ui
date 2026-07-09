import { isIP } from 'node:net';
import type {
  AlertDecision,
  AlertMetaValue,
  AlertSpikeRuleConfig,
  ApplicationUpdateRuleConfig,
  AlertRecord,
  AlertThresholdRuleConfig,
  IpBanRuleConfig,
  LapiAvailabilityRuleConfig,
  LapiStatus,
  NewAlertDecisionRuleConfig,
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
} from '../shared/contracts';
import { CrowdsecDatabase } from './database';
import type { MqttPublishConfig } from './notifications/mqtt-client';
import {
  getNotificationProvider,
  type NotificationProviderPayload,
} from './notifications/providers';
import type { NotificationOutboundGuard } from './notifications/outbound-guard';
import type { NotificationSecretStore } from './notifications/secret-store';
import type { UpdateChecker } from './update-check';
import { getServerTranslator, type Translator } from './i18n';
import type { TimeFormat } from './config';
import { formatDateTime } from './utils/date-time';
import type { DatabaseQueryWorker } from './query-worker-client';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type RuleConfigInput = NotificationRuleConfig | Record<string, AlertMetaValue>;

export interface NotificationServiceOptions {
  database: CrowdsecDatabase;
  queryWorker?: Pick<DatabaseQueryWorker, 'all' | 'get'>;
  fetchImpl?: FetchLike;
  mqttPublishImpl?: (config: MqttPublishConfig, payload: string) => Promise<void>;
  updateChecker?: UpdateChecker;
  getLapiStatus?: () => LapiStatus;
  outboundGuard: NotificationOutboundGuard;
  secretStore: NotificationSecretStore;
  debugPayloads?: boolean;
  timeZone?: string | null;
  timeFormat?: TimeFormat;
}

interface NotificationCandidate {
  dedupeKey: string;
  title: string;
  message: string;
  metadata: Record<string, AlertMetaValue>;
  incidentStartedAt?: string;
  severity?: NotificationSeverity;
}

interface NotificationIncidentState {
  incidentKey: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}

interface NotificationDeliveryRuleContext {
  id: string;
  name: string;
  type: NotificationRuleType | 'test';
}

interface NotificationDeliveryError extends Error {
  status?: number;
  responseSnippet?: string;
  requestBodySnippet?: string;
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
  const queryWorker = options.queryWorker || {
    all: async <T>(sql: string, params: unknown[] = []) => database.db.prepare(sql).all(...params) as T[],
    get: async <T>(sql: string, params: unknown[] = []) => database.db.prepare(sql).get(...params) as T,
  };
  const fetchImpl = options.fetchImpl || fetch;
  const mqttPublishImpl = options.mqttPublishImpl;
  const updateChecker = options.updateChecker;
  const getLapiStatus = options.getLapiStatus;
  const outboundGuard = options.outboundGuard;
  const secretStore = options.secretStore;
  const debugPayloads = options.debugPayloads === true;

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
    const t = getServerTranslator(database);

    const result = await sendToChannel(channel, {
      title: t('server.notifications.test.title'),
      message: t('server.notifications.test.message', {
        timestamp: formatDateTime(new Date(), options.timeZone ?? null, options.timeFormat ?? 'browser'),
      }),
      metadata: { kind: 'test' },
      dedupeKey: `test:${Date.now()}`,
    }, 'info', {
      id: 'test',
      name: t('server.notifications.test.ruleName'),
      type: 'test',
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
    const timestamp = now.toISOString();
    const t = getServerTranslator(database);
    for (const rule of rules) {
      const candidates = dedupeCandidates(await evaluateRule(rule, now, t));
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
        const candidateSeverity = candidate.severity || rule.severity;
        for (const channel of activeChannels.filter((item) => rule.channel_ids.includes(item.id))) {
          deliveries.push(await sendToChannel(channel, candidate, candidateSeverity, rule));
        }

        database.insertNotification({
          $id: crypto.randomUUID(),
          $created_at: timestamp,
          $updated_at: timestamp,
          $rule_id: rule.id,
          $rule_name: rule.name,
          $rule_type: rule.type,
          $severity: candidateSeverity,
          $title: candidate.title,
          $message: candidate.message,
          $read_at: null,
          $metadata_json: JSON.stringify(candidate.metadata),
          $deliveries_json: JSON.stringify(deliveries),
          $dedupe_key: candidate.dedupeKey,
        });
        const incidentStartedAt = candidate.incidentStartedAt || timestamp;
        database.upsertNotificationIncident({
          $rule_id: rule.id,
          $incident_key: candidate.dedupeKey,
          $first_seen_at: incidentStartedAt,
          $last_seen_at: timestamp,
          $resolved_at: null,
        });
      }
    }
  }

  function dedupeCandidates(candidates: NotificationCandidate[]): NotificationCandidate[] {
    const seenKeys = new Set<string>();
    return candidates.filter((candidate) => {
      if (seenKeys.has(candidate.dedupeKey)) {
        return false;
      }
      seenKeys.add(candidate.dedupeKey);
      return true;
    });
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

  async function evaluateRule(rule: NotificationRule, now: Date, t: Translator): Promise<NotificationCandidate[]> {
    if (rule.type === 'alert-spike') {
      return evaluateAlertSpikeRule(rule, now, t);
    }
    if (rule.type === 'alert-threshold') {
      return evaluateAlertThresholdRule(rule, now, t);
    }
    if (rule.type === 'new-alert-decision') {
      return evaluateNewAlertDecisionRule(rule, now, t);
    }
    if (rule.type === 'application-update') {
      return evaluateApplicationUpdateRule(rule, t);
    }
    if (rule.type === 'lapi-availability') {
      return evaluateLapiAvailabilityRule(rule, now, t);
    }
    if (rule.type === 'ip-ban') {
      return evaluateIpBanRule(rule, now, t);
    }
    return evaluateNewCveRule(rule, now, t);
  }

  async function evaluateAlertSpikeRule(rule: NotificationRule, now: Date, t: Translator): Promise<NotificationCandidate[]> {
    const config = normalizeRuleConfig('alert-spike', rule.config);
    const windowMs = config.window_minutes * 60_000;
    const currentStart = now.getTime() - windowMs;
    const previousStart = currentStart - windowMs;
    const currentAlertCount = await countAlertsBetween(new Date(currentStart), now, config.filters);
    const previousAlertCount = await countAlertsBetween(new Date(previousStart), new Date(currentStart), config.filters);
    const baseline = Math.max(previousAlertCount, 1);
    const increasePercent = ((currentAlertCount - previousAlertCount) / baseline) * 100;

    if (
      currentAlertCount < config.minimum_current_alerts ||
      currentAlertCount <= previousAlertCount ||
      increasePercent < config.percent_increase
    ) {
      return [];
    }

    return [{
      dedupeKey: 'spike:active',
      title: t('server.notifications.alertSpike.title', { ruleName: rule.name }),
      message: t('server.notifications.alertSpike.message', {
        count: currentAlertCount,
        minutes: config.window_minutes,
        percent: Math.round(increasePercent),
        previousCount: previousAlertCount,
      }),
      metadata: {
        current_count: currentAlertCount,
        previous_count: previousAlertCount,
        increase_percent: Math.round(increasePercent),
        window_minutes: config.window_minutes,
        filters: toMetaRecord(config.filters),
      },
    }];
  }

  async function evaluateAlertThresholdRule(rule: NotificationRule, now: Date, t: Translator): Promise<NotificationCandidate[]> {
    const config = normalizeRuleConfig('alert-threshold', rule.config);
    const windowMs = config.window_minutes * 60_000;
    const alertCount = await countAlertsBetween(new Date(now.getTime() - windowMs), now, config.filters);

    if (alertCount < config.alert_threshold) {
      return [];
    }

    return [{
      dedupeKey: 'threshold:active',
      title: t('server.notifications.alertThreshold.title', { ruleName: rule.name }),
      message: t('server.notifications.alertThreshold.message', {
        count: alertCount,
        minutes: config.window_minutes,
        threshold: config.alert_threshold,
      }),
      metadata: {
        matched_alerts: alertCount,
        threshold: config.alert_threshold,
        window_minutes: config.window_minutes,
        filters: toMetaRecord(config.filters),
      },
    }];
  }

  async function evaluateNewAlertDecisionRule(rule: NotificationRule, now: Date, t: Translator): Promise<NotificationCandidate[]> {
    const config = normalizeRuleConfig('new-alert-decision', rule.config);
    const windowStart = new Date(now.getTime() - config.window_minutes * 60_000);
    const candidates: NotificationCandidate[] = [];

    if (config.event_type === 'alert' || config.event_type === 'both') {
      for (const alert of await getAlertsBetween(windowStart, now, config.filters)) {
        const alertId = String(alert.id);
        const source = getAlertSourceValue(alert);
        const scenario = String(alert.scenario || alert.reason || '—');
        const target = String(alert.target || '—');
        const description = String(alert.message || '—');

        candidates.push({
          dedupeKey: `new-alert:${encodeURIComponent(alertId)}`,
          title: t('server.notifications.newEvent.alertTitle', { ruleName: rule.name }),
          message: t('server.notifications.newEvent.alertMessage', {
            id: alertId,
            scenario,
            source,
            target,
            createdAt: alert.created_at,
            description,
          }),
          incidentStartedAt: alert.created_at,
          metadata: {
            event_type: 'alert',
            alert_id: alertId,
            uuid: typeof alert.uuid === 'string' ? alert.uuid : null,
            scenario,
            source,
            target,
            created_at: alert.created_at,
            message: description,
            simulated: alert.simulated === true,
            machine: alert.machine_alias || alert.machine_id || null,
            events_count: typeof alert.events_count === 'number' ? alert.events_count : null,
            decision_count: Array.isArray(alert.decisions) ? alert.decisions.length : 0,
            filters: toMetaRecord(config.filters),
          },
        });
      }
    }

    if (config.event_type === 'decision' || config.event_type === 'both') {
      for (const decision of await getDecisionsBetween(windowStart, now, config.filters)) {
        const createdAt = String(decision.created_at || '');

        const decisionId = String(decision.id);
        const value = String(decision.value || '—');
        const decisionType = String(decision.type || decision.action || '—');
        const scenario = String(decision.scenario || decision.reason || '—');
        const target = String(decision.target || '—');
        const stopAt = String(decision.stop_at || '—');

        candidates.push({
          dedupeKey: `new-decision:${encodeURIComponent(decisionId)}`,
          title: t('server.notifications.newEvent.decisionTitle', { ruleName: rule.name }),
          message: t('server.notifications.newEvent.decisionMessage', {
            id: decisionId,
            type: decisionType,
            value,
            scenario,
            target,
            createdAt,
            stopAt,
          }),
          incidentStartedAt: createdAt,
          metadata: {
            event_type: 'decision',
            decision_id: decisionId,
            alert_id: typeof decision.alert_id === 'string' || typeof decision.alert_id === 'number' ? decision.alert_id : null,
            type: decisionType,
            value,
            scenario,
            target,
            origin: typeof decision.origin === 'string' ? decision.origin : null,
            created_at: createdAt,
            stop_at: stopAt,
            simulated: decision.simulated === true,
            filters: toMetaRecord(config.filters),
          },
        });
      }
    }

    return candidates;
  }

  async function evaluateNewCveRule(rule: NotificationRule, now: Date, t: Translator): Promise<NotificationCandidate[]> {
    const config = normalizeRuleConfig('new-cve', rule.config);
    const alerts = await getAlertsBetween(new Date(now.getTime() - 7 * 86_400_000), now, config.filters);
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
        title: t('server.notifications.newCve.title', { ruleName: rule.name }),
        message: t('server.notifications.newCve.message', {
          cveId,
          ageDays,
          count: matchedAlerts.length,
        }),
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

  async function evaluateIpBanRule(rule: NotificationRule, now: Date, t: Translator): Promise<NotificationCandidate[]> {
    const config = normalizeRuleConfig('ip-ban', rule.config);
    const windowStart = new Date(now.getTime() - config.window_minutes * 60_000);
    return (await getDecisionsBetween(windowStart, now, config.filters, { activeAt: now }))
      .filter((decision) => normalizeDecisionType(decision) === 'ban')
      .map((decision) => {
        const decisionId = String(decision.id);
        const value = String(decision.value || 'unknown');
        const stopAt = typeof decision.stop_at === 'string' ? decision.stop_at : null;
        const scenario = typeof decision.scenario === 'string' ? decision.scenario : null;
        const origin = typeof decision.origin === 'string' ? decision.origin : null;
        const target = typeof decision.target === 'string' ? decision.target : null;
        const alertId = typeof decision.alert_id === 'string' || typeof decision.alert_id === 'number' ? decision.alert_id : null;

        return {
          dedupeKey: buildIpBanDedupeKey(decision),
          title: t('server.notifications.ipBan.title', { ruleName: rule.name }),
          message: t('server.notifications.ipBan.message', {
            value,
            scenarioDetail: scenario ? t('server.notifications.ipBan.scenarioDetail', { scenario }) : '',
            stopAtDetail: stopAt ? t('server.notifications.ipBan.stopAtDetail', { stopAt }) : '',
          }),
          incidentStartedAt: typeof decision.created_at === 'string' ? decision.created_at : undefined,
          metadata: {
            decision_id: decisionId,
            value,
            type: normalizeDecisionType(decision),
            origin,
            scenario,
            target,
            alert_id: alertId,
            created_at: typeof decision.created_at === 'string' ? decision.created_at : null,
            stop_at: stopAt,
            filters: toMetaRecord(config.filters),
          },
        } satisfies NotificationCandidate;
      });
  }

  async function evaluateApplicationUpdateRule(rule: NotificationRule, t: Translator): Promise<NotificationCandidate[]> {
    if (!updateChecker) {
      return [];
    }

    const status = await updateChecker();
    if (!status.update_available || !status.remote_version) {
      return [];
    }

    const targetVersion = status.tag === 'dev' ? `dev-${status.remote_version}` : status.remote_version;
    const currentVersion = status.local_version || t('server.notifications.currentVersion');

    return [{
      dedupeKey: `application-update:${targetVersion}`,
      title: t('server.notifications.applicationUpdate.title', { ruleName: rule.name }),
      message: t('server.notifications.applicationUpdate.message', { currentVersion, targetVersion }),
      metadata: {
        update_available: true,
        local_version: status.local_version || null,
        remote_version: status.remote_version,
        release_url: status.release_url || null,
        tag: status.tag || null,
      },
    }];
  }

  async function evaluateLapiAvailabilityRule(rule: NotificationRule, now: Date, t: Translator): Promise<NotificationCandidate[]> {
    if (!getLapiStatus) {
      return [];
    }

    const status = getLapiStatus();
    const config = normalizeRuleConfig('lapi-availability', rule.config);
    const candidates: NotificationCandidate[] = [];
    const activeIncidents = loadActiveIncidents(rule.id);
    const activeOutageIncident = activeIncidents.get('lapi-availability:offline');

    if (!status.isConnected && status.offline_since) {
      const offlineSince = new Date(status.offline_since);
      const outageDurationSeconds = Math.max(0, Math.floor((now.getTime() - offlineSince.getTime()) / 1_000));

      if (outageDurationSeconds >= config.outage_threshold_seconds) {
        candidates.push({
          dedupeKey: 'lapi-availability:offline',
          title: t('server.notifications.lapiUnavailable.title', { ruleName: rule.name }),
          message: t('server.notifications.lapiUnavailable.message', { seconds: outageDurationSeconds }),
          incidentStartedAt: status.offline_since,
          metadata: {
            offline_since: status.offline_since,
            last_check: status.lastCheck,
            last_error: status.lastError,
            outage_threshold_seconds: config.outage_threshold_seconds,
            outage_duration_seconds: outageDurationSeconds,
          },
        });
      }

      return candidates;
    }

    if (status.isConnected && config.notify_on_recovery && activeOutageIncident) {
      const recoveredAt = now.toISOString();
      const offlineSince = activeOutageIncident.firstSeenAt;
      const outageDurationSeconds = Math.max(
        0,
        Math.floor((now.getTime() - new Date(offlineSince).getTime()) / 1_000),
      );
      candidates.push({
        dedupeKey: `lapi-availability:recovery:${recoveredAt}`,
        title: t('server.notifications.lapiRecovered.title', { ruleName: rule.name }),
        message: t('server.notifications.lapiRecovered.message', { seconds: outageDurationSeconds }),
        metadata: {
          offline_since: offlineSince,
          recovered_at: recoveredAt,
          last_check: status.lastCheck,
          last_error: status.lastError,
          outage_threshold_seconds: config.outage_threshold_seconds,
          outage_duration_seconds: outageDurationSeconds,
        },
        severity: 'info',
      });
    }

    return candidates;
  }

  async function countAlertsBetween(start: Date, end: Date, filters?: NotificationFilter): Promise<number> {
    const condition = buildNotificationDataCondition('alerts', start, end, filters);
    const row = await queryWorker.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM alerts WHERE ${condition.sql}`,
      condition.params,
    );
    return Number(row?.count || 0);
  }

  async function getAlertsBetween(start: Date, end: Date, filters?: NotificationFilter): Promise<AlertRecord[]> {
    const condition = buildNotificationDataCondition('alerts', start, end, filters);
    const alerts: AlertRecord[] = [];
    let lastId = 0;
    while (true) {
      const rows = await queryWorker.all<{ id: number; raw_data: string }>(`
        SELECT id, raw_data
        FROM alerts
        WHERE ${condition.sql} AND id > ?
        ORDER BY id ASC
        LIMIT 1000
      `, [...condition.params, lastId]);
      if (rows.length === 0) break;
      for (const row of rows) {
        try {
          const alert = JSON.parse(row.raw_data) as AlertRecord;
          if (matchesAlertFilters(alert, filters)) alerts.push(alert);
        } catch {
          // Ignore malformed cached rows; the next sync can replace them.
        }
      }
      lastId = rows[rows.length - 1].id;
    }
    return alerts;
  }

  async function getDecisionsBetween(
    start: Date,
    end: Date,
    filters?: NotificationFilter,
    options: { activeAt?: Date } = {},
  ): Promise<Array<AlertDecision & Record<string, unknown>>> {
    const condition = buildNotificationDataCondition('decisions', start, end, filters, options.activeAt);
    const decisions: Array<AlertDecision & Record<string, unknown>> = [];
    let lastRowId = 0;
    while (true) {
      const rows = await queryWorker.all<{ rowid: number; raw_data: string }>(`
        SELECT rowid, raw_data
        FROM decisions
        WHERE ${condition.sql} AND rowid > ?
        ORDER BY rowid ASC
        LIMIT 1000
      `, [...condition.params, lastRowId]);
      if (rows.length === 0) break;
      for (const row of rows) {
        const decision = parseDecisionRow(row.raw_data);
        if (decision && matchesDecisionFilters(decision, filters)) decisions.push(decision);
      }
      lastRowId = rows[rows.length - 1].rowid;
    }
    return decisions;
  }

  function buildNotificationDataCondition(
    table: 'alerts' | 'decisions',
    start: Date,
    end: Date,
    filters?: NotificationFilter,
    activeAt?: Date,
  ): { sql: string; params: unknown[] } {
    const clauses = ['created_at >= ?', 'created_at < ?'];
    const params: unknown[] = [start.toISOString(), end.toISOString()];
    if (filters?.include_simulated !== true) clauses.push('simulated = 0');
    if (filters?.scenario) {
      clauses.push("LOWER(scenario) LIKE ? ESCAPE '\\'");
      params.push(`%${escapeSqlLike(filters.scenario.toLowerCase())}%`);
    }
    if (filters?.target) {
      clauses.push("LOWER(target) LIKE ? ESCAPE '\\'");
      params.push(`%${escapeSqlLike(filters.target.toLowerCase())}%`);
    }
    if (filters?.values && filters.values.length > 0) {
      const valueColumn = table === 'alerts' ? 'source_ip' : 'value';
      clauses.push(`(${filters.values.map(() => `matches_ip_search_value(${valueColumn}, ?) = 1`).join(' OR ')})`);
      params.push(...filters.values);
    }
    if (table === 'decisions' && activeAt) {
      clauses.push('stop_at > ?');
      params.push(activeAt.toISOString());
    }
    return { sql: clauses.join(' AND '), params };
  }

  function escapeSqlLike(value: string): string {
    return value.replace(/[\\%_]/g, (character) => `\\${character}`);
  }

  function parseDecisionRow(rawData: string): (AlertDecision & Record<string, unknown>) | null {
    try {
      const parsed = JSON.parse(rawData) as AlertDecision & Record<string, unknown>;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
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
    rule?: NotificationDeliveryRuleContext,
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
      logNotificationDeliveryFailure(channel, rule, error);
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

  function logNotificationDeliveryFailure(
    channel: NotificationChannel,
    rule: NotificationDeliveryRuleContext | undefined,
    error: unknown,
  ): void {
    const deliveryError = error instanceof Error ? error as NotificationDeliveryError : null;
    const contextLabel = rule?.type === 'test'
      ? 'test notification'
      : rule
        ? `rule "${rule.name}" (${rule.type})`
        : 'notification';
    const details: string[] = [];
    if (deliveryError?.status) {
      details.push(`status=${deliveryError.status}`);
    }
    if (deliveryError?.responseSnippet) {
      details.push(`response="${deliveryError.responseSnippet}"`);
    }
    if (debugPayloads && deliveryError?.requestBodySnippet) {
      details.push(`request_body="${deliveryError.requestBodySnippet}"`);
    }
    const message = deliveryError?.message || String(error);
    const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
    console.warn(
      `Notification delivery failed for ${contextLabel} to "${channel.name}" (${channel.type}): ${message}${suffix}`,
    );
  }
}

function normalizeRuleConfig(type: 'alert-spike', config: RuleConfigInput): AlertSpikeRuleConfig;
function normalizeRuleConfig(type: 'alert-threshold', config: RuleConfigInput): AlertThresholdRuleConfig;
function normalizeRuleConfig(type: 'new-alert-decision', config: RuleConfigInput): NewAlertDecisionRuleConfig;
function normalizeRuleConfig(type: 'new-cve', config: RuleConfigInput): NewCveRuleConfig;
function normalizeRuleConfig(type: 'ip-ban', config: RuleConfigInput): IpBanRuleConfig;
function normalizeRuleConfig(type: 'application-update', config: RuleConfigInput): ApplicationUpdateRuleConfig;
function normalizeRuleConfig(type: 'lapi-availability', config: RuleConfigInput): LapiAvailabilityRuleConfig;
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

  if (type === 'new-alert-decision') {
    return {
      window_minutes: normalizePositiveNumber(safeConfig.window_minutes, 5),
      event_type: normalizeNewAlertDecisionEventType(safeConfig.event_type),
      filters,
    };
  }

  if (type === 'application-update') {
    return {};
  }

  if (type === 'ip-ban') {
    return {
      window_minutes: normalizePositiveNumber(safeConfig.window_minutes, 60),
      filters,
    };
  }

  if (type === 'lapi-availability') {
    return {
      outage_threshold_seconds: normalizePositiveNumber(safeConfig.outage_threshold_seconds, 60),
      notify_on_recovery: safeConfig.notify_on_recovery === true,
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
  const rawFilters = filters as Record<string, unknown>;
  const scenario = typeof rawFilters.scenario === 'string' ? rawFilters.scenario.trim() : '';
  const target = typeof rawFilters.target === 'string' ? rawFilters.target.trim() : '';
  const values = normalizeIpRangeFilterValues(rawFilters.values);
  if (!scenario && !target && filters.include_simulated !== true && values.length === 0) {
    return undefined;
  }
  return {
    scenario: scenario || undefined,
    target: target || undefined,
    include_simulated: filters.include_simulated === true,
    values: values.length > 0 ? values : undefined,
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
  if (filters?.values && filters.values.length > 0 && !matchesIpRangeFilters(getAlertSourceValue(alert), filters.values)) {
    return false;
  }
  return true;
}

function getAlertSourceValue(alert: AlertRecord): string {
  return String(alert.source?.ip || alert.source?.range || alert.source?.value || '—');
}

function matchesDecisionFilters(decision: AlertDecision & Record<string, unknown>, filters?: NotificationFilter): boolean {
  if (filters?.include_simulated !== true && decision.simulated === true) {
    return false;
  }
  if (filters?.scenario && !String(decision.scenario || '').toLowerCase().includes(filters.scenario.toLowerCase())) {
    return false;
  }
  if (filters?.target && !String(decision.target || '').toLowerCase().includes(filters.target.toLowerCase())) {
    return false;
  }
  if (filters?.values && filters.values.length > 0 && !matchesIpRangeFilters(String(decision.value || ''), filters.values)) {
    return false;
  }
  return true;
}

function normalizeDecisionType(decision: AlertDecision & Record<string, unknown>): string {
  return String(decision.type || decision.action || '').trim().toLowerCase();
}

function buildIpBanDedupeKey(decision: AlertDecision & Record<string, unknown>): string {
  return [
    'ip-ban',
    String(decision.value || '').trim().toLowerCase(),
    String(decision.origin || '').trim().toLowerCase(),
    String(decision.scenario || '').trim().toLowerCase(),
    String(decision.target || '').trim().toLowerCase(),
  ].map(encodeURIComponent).join(':');
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
  if (
    value === 'alert-spike' ||
    value === 'alert-threshold' ||
    value === 'new-alert-decision' ||
    value === 'new-cve' ||
    value === 'ip-ban' ||
    value === 'application-update' ||
    value === 'lapi-availability'
  ) return value;
  throw new Error('Invalid notification rule type');
}

function normalizeNewAlertDecisionEventType(value: unknown): NewAlertDecisionRuleConfig['event_type'] {
  return value === 'alert' || value === 'decision' || value === 'both' ? value : 'both';
}

function normalizeSeverity(value: unknown): NotificationItem['severity'] {
  return value === 'info' || value === 'warning' || value === 'critical' ? value : 'warning';
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : fallback;
}

function normalizeIpRangeFilterValues(value: unknown): string[] {
  const rawEntries = Array.isArray(value)
    ? value.flatMap((entry) => (typeof entry === 'string' ? splitIpRangeFilterValue(entry) : []))
    : typeof value === 'string'
      ? splitIpRangeFilterValue(value)
      : [];
  const values = [...new Set(rawEntries.map((entry) => entry.trim()).filter(Boolean))];
  const invalidValue = values.find((entry) => !isValidIpOrCidr(entry));
  if (invalidValue) {
    throw new Error(`Invalid IP/range filter value: ${invalidValue}`);
  }
  return values;
}

function splitIpRangeFilterValue(value: string): string[] {
  return value.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
}

function isValidIpOrCidr(value: string): boolean {
  const [address, prefix, extra] = value.split('/');
  const version = isIP(address || '');
  if (version === 0 || extra !== undefined) {
    return false;
  }
  if (prefix === undefined) {
    return true;
  }
  if (!/^\d+$/.test(prefix)) {
    return false;
  }
  const numericPrefix = Number(prefix);
  const maxPrefix = version === 4 ? 32 : 128;
  return Number.isInteger(numericPrefix) && numericPrefix >= 0 && numericPrefix <= maxPrefix;
}

function matchesIpRangeFilters(value: string, filters: string[]): boolean {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return false;
  }

  for (const filter of filters) {
    if (normalizedValue === filter) {
      return true;
    }
    if (filter.includes('/') && !normalizedValue.includes('/') && cidrContainsIp(filter, normalizedValue)) {
      return true;
    }
  }
  return false;
}

function cidrContainsIp(cidr: string, value: string): boolean {
  const [networkAddress, prefixText] = cidr.split('/');
  const version = isIP(networkAddress || '');
  if (version === 0 || isIP(value) !== version) {
    return false;
  }
  const ipVersion = version === 4 ? 4 : 6;
  const prefix = Number(prefixText);
  const bits = ipVersion === 4 ? 32 : 128;
  const network = parseIpAddress(networkAddress || '', ipVersion);
  const address = parseIpAddress(value, ipVersion);
  if (network === null || address === null || !Number.isInteger(prefix) || prefix < 0 || prefix > bits) {
    return false;
  }

  const hostBits = BigInt(bits - prefix);
  const mask = hostBits === BigInt(bits)
    ? 0n
    : ((1n << BigInt(bits)) - 1n) ^ ((1n << hostBits) - 1n);
  return (network & mask) === (address & mask);
}

function parseIpAddress(value: string, version: 4 | 6): bigint | null {
  return version === 4 ? parseIpv4Address(value) : parseIpv6Address(value);
}

function parseIpv4Address(value: string): bigint | null {
  const parts = value.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let result = 0n;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return null;
    }
    result = (result << 8n) + BigInt(octet);
  }
  return result;
}

function parseIpv6Address(value: string): bigint | null {
  const normalized = value.toLowerCase();
  const [leftText, rightText, extraText] = normalized.split('::');
  if (extraText !== undefined) {
    return null;
  }

  const leftParts = splitIpv6Parts(leftText || '');
  const rightParts = rightText === undefined ? [] : splitIpv6Parts(rightText || '');
  if (!leftParts || !rightParts) {
    return null;
  }

  const missingParts = 8 - leftParts.length - rightParts.length;
  if (rightText === undefined ? missingParts !== 0 : missingParts < 1) {
    return null;
  }

  const parts = [...leftParts, ...Array.from({ length: missingParts }, () => 0), ...rightParts];
  if (parts.length !== 8) {
    return null;
  }

  return parts.reduce((result, part) => (result << 16n) + BigInt(part), 0n);
}

function splitIpv6Parts(value: string): number[] | null {
  if (!value) {
    return [];
  }
  const parts = value.split(':');
  const parsed: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) {
      return null;
    }
    parsed.push(Number.parseInt(part, 16));
  }
  return parsed;
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
