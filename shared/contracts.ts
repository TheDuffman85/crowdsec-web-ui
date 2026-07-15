export interface ApiErrorResponse {
  error: string;
}

export interface PaginationMeta {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  unfiltered_total: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: PaginationMeta;
  selectable_ids: Array<string | number>;
}

export type TableColumnPreferenceTable = 'alerts' | 'decisions';
export type AlertTableColumnId = 'id' | 'time' | 'scenario' | 'country' | 'region' | 'city' | 'as' | 'source' | 'machine' | 'origin' | 'decisions';
export type DecisionTableColumnId = 'id' | 'time' | 'scenario' | 'country' | 'region' | 'city' | 'as' | 'source' | 'action' | 'expiration' | 'machine' | 'origin' | 'alert';
export type TableColumnId = AlertTableColumnId | DecisionTableColumnId;

export interface TableColumnDefinition {
  id: TableColumnId;
  label: string;
  defaultVisible: boolean;
}

export type TableColumnPreferences = Record<TableColumnPreferenceTable, TableColumnId[]>;

export const TABLE_COLUMN_DEFINITIONS: Record<TableColumnPreferenceTable, TableColumnDefinition[]> = {
  alerts: [
    { id: 'id', label: 'ID', defaultVisible: false },
    { id: 'time', label: 'Time', defaultVisible: true },
    { id: 'scenario', label: 'Scenario', defaultVisible: true },
    { id: 'country', label: 'Country', defaultVisible: true },
    { id: 'region', label: 'Region', defaultVisible: false },
    { id: 'city', label: 'City', defaultVisible: false },
    { id: 'as', label: 'AS', defaultVisible: true },
    { id: 'source', label: 'IP / Range', defaultVisible: true },
    { id: 'machine', label: 'Machine', defaultVisible: false },
    { id: 'origin', label: 'Origin', defaultVisible: false },
    { id: 'decisions', label: 'Decisions', defaultVisible: true },
  ],
  decisions: [
    { id: 'id', label: 'ID', defaultVisible: false },
    { id: 'time', label: 'Time', defaultVisible: true },
    { id: 'scenario', label: 'Scenario', defaultVisible: true },
    { id: 'country', label: 'Country', defaultVisible: true },
    { id: 'region', label: 'Region', defaultVisible: false },
    { id: 'city', label: 'City', defaultVisible: false },
    { id: 'as', label: 'AS', defaultVisible: true },
    { id: 'source', label: 'IP / Range', defaultVisible: true },
    { id: 'action', label: 'Action', defaultVisible: true },
    { id: 'expiration', label: 'Expiration', defaultVisible: true },
    { id: 'machine', label: 'Machine', defaultVisible: false },
    { id: 'origin', label: 'Origin', defaultVisible: false },
    { id: 'alert', label: 'Alert', defaultVisible: true },
  ],
};

const DEFAULT_ALERT_TABLE_COLUMNS = TABLE_COLUMN_DEFINITIONS.alerts
  .filter((column) => column.defaultVisible)
  .map((column) => column.id);
const DEFAULT_DECISION_TABLE_COLUMNS = TABLE_COLUMN_DEFINITIONS.decisions
  .filter((column) => column.defaultVisible)
  .map((column) => column.id);

export const DEFAULT_TABLE_COLUMN_PREFERENCES: TableColumnPreferences = {
  alerts: [...DEFAULT_ALERT_TABLE_COLUMNS],
  decisions: [...DEFAULT_DECISION_TABLE_COLUMNS],
};

export type AlertMetaValue =
  | string
  | number
  | boolean
  | null
  | Record<string, unknown>
  | unknown[];

export interface LapiStatus {
  isConnected: boolean;
  lastCheck: string | null;
  lastError: string | null;
  offline_since: string | null;
}

export interface SyncStatus {
  isSyncing: boolean;
  progress: number;
  message: string;
  startedAt: string | null;
  completedAt: string | null;
  state?: 'idle' | 'syncing' | 'complete' | 'partial' | 'failed';
  errors?: string[];
}

export interface AlertMeta {
  key: string;
  value: AlertMetaValue;
}

export interface AlertEvent {
  meta?: AlertMeta[];
  timestamp?: string;
  [key: string]: unknown;
}

export interface AlertSource {
  ip?: string;
  value?: string;
  cn?: string;
  as_name?: string;
  as_number?: string | number;
  scope?: string;
  latitude?: string | number;
  longitude?: string | number;
  city?: string;
  region?: string;
  range?: string;
  [key: string]: unknown;
}

export interface AlertDecision {
  id: string | number;
  type?: string;
  value?: string;
  duration?: string;
  stop_at?: string;
  created_at?: string;
  origin?: string;
  scenario?: string;
  expired?: boolean;
  simulated?: boolean;
  [key: string]: unknown;
}

export interface AlertRecord {
  id: string | number;
  uuid?: string;
  created_at: string;
  start_at?: string;
  stop_at?: string;
  scenario?: string;
  reason?: string;
  source?: AlertSource | null;
  message?: string;
  machine_id?: string;
  machine_alias?: string;
  events_count?: number;
  events?: AlertEvent[];
  decisions?: AlertDecision[];
  target?: string;
  meta_search?: string;
  simulated?: boolean;
  [key: string]: unknown;
}

export interface SlimDecision {
  id: string | number;
  type?: string;
  value?: string;
  duration?: string;
  stop_at?: string;
  origin?: string;
  expired?: boolean;
  simulated?: boolean;
}

export interface SlimAlert {
  id: string | number;
  created_at: string;
  scenario?: string;
  reason?: string;
  message?: string;
  events_count?: number;
  machine_id?: string;
  machine_alias?: string;
  source: AlertSource | null;
  target?: string;
  meta_search: string;
  decisions: SlimDecision[];
  simulated?: boolean;
}

export interface DecisionListDetail {
  origin: string;
  type?: string;
  reason?: string;
  action?: string;
  country?: string;
  city?: string;
  region?: string;
  as?: string;
  events_count?: number;
  duration?: string;
  expiration?: string;
  alert_id?: string | number;
  target?: string | null;
  simulated?: boolean;
}

export interface DecisionListItem {
  id: string | number;
  created_at: string;
  machine?: string;
  scenario?: string;
  value?: string;
  expired: boolean;
  is_duplicate: boolean;
  simulated?: boolean;
  detail: DecisionListDetail;
}

export interface StatsAlert {
  created_at: string;
  kind?: string;
  scenario?: string;
  source: Pick<AlertSource, 'ip' | 'value' | 'range' | 'cn' | 'city' | 'region' | 'as_name' | 'scope'> | null;
  target?: string;
  simulated?: boolean;
}

export interface StatsDecision {
  id: string | number;
  created_at: string;
  scenario?: string;
  value?: string;
  stop_at?: string;
  target?: string;
  simulated?: boolean;
}

export type DashboardGranularity = 'day' | 'hour';
export type DashboardSimulationFilter = 'all' | 'live' | 'simulated';

export interface DashboardStatsBucket {
  date: string;
  count: number;
  fullDate: string;
}

export interface DashboardStatListItem {
  label: string;
  count: number;
  value?: string;
  countryCode?: string;
}

export interface DashboardWorldMapDatum {
  label: string;
  count: number;
  countryCode: string;
  simulatedCount?: number;
  liveCount?: number;
  liveDecisionCount?: number;
  simulatedDecisionCount?: number;
  activeLiveDecisionCount?: number;
  activeSimulatedDecisionCount?: number;
}

export interface DashboardAttackLocationDatum {
  latitude: number;
  longitude: number;
  count: number;
  liveCount: number;
  simulatedCount: number;
  city?: string;
  region?: string;
  countryCode?: string;
}

export interface DashboardStatsTotals {
  alerts: number;
  decisions: number;
  simulatedAlerts: number;
  simulatedDecisions: number;
}

export interface DashboardStatsSeries {
  alertsHistory: DashboardStatsBucket[];
  simulatedAlertsHistory: DashboardStatsBucket[];
  decisionsHistory: DashboardStatsBucket[];
  simulatedDecisionsHistory: DashboardStatsBucket[];
  activeDecisionsHistory: DashboardStatsBucket[];
  activeSimulatedDecisionsHistory: DashboardStatsBucket[];
  unfilteredAlertsHistory: DashboardStatsBucket[];
  unfilteredSimulatedAlertsHistory: DashboardStatsBucket[];
  unfilteredDecisionsHistory: DashboardStatsBucket[];
  unfilteredSimulatedDecisionsHistory: DashboardStatsBucket[];
}

export interface DashboardStatsResponse {
  pending?: boolean;
  retryAfterMs?: number;
  totals: DashboardStatsTotals;
  filteredTotals: DashboardStatsTotals;
  globalTotal: number;
  topTargets: DashboardStatListItem[];
  topCountries: DashboardStatListItem[];
  allCountries: DashboardWorldMapDatum[];
  attackLocations: DashboardAttackLocationDatum[];
  topScenarios: DashboardStatListItem[];
  topAS: DashboardStatListItem[];
  series: DashboardStatsSeries;
}

export interface UpdateCheckResponse {
  update_available: boolean;
  reason?: string;
  local_version?: string | null;
  remote_version?: string | null;
  release_url?: string;
  tag?: string;
  error?: string;
}

export type NotificationChannelType = 'ntfy' | 'gotify' | 'email' | 'mqtt' | 'webhook';
export type NotificationRuleType = 'alert-spike' | 'alert-threshold' | 'new-alert-decision' | 'new-cve' | 'ip-ban' | 'application-update' | 'lapi-availability';
export type NotificationSeverity = 'info' | 'warning' | 'critical';
export type NotificationDeliveryStatus = 'delivered' | 'failed' | 'skipped';

export interface NotificationFilter {
  scenario?: string;
  target?: string;
  include_simulated?: boolean;
  values?: string[];
}

export interface AlertSpikeRuleConfig {
  window_minutes: number;
  percent_increase: number;
  minimum_current_alerts: number;
  filters?: NotificationFilter;
}

export interface AlertThresholdRuleConfig {
  window_minutes: number;
  alert_threshold: number;
  filters?: NotificationFilter;
}

export type NewAlertDecisionEventType = 'alert' | 'decision' | 'both';

export interface NewAlertDecisionRuleConfig {
  window_minutes: number;
  event_type: NewAlertDecisionEventType;
  filters?: NotificationFilter;
}

export interface NewCveRuleConfig {
  max_cve_age_days: number;
  filters?: NotificationFilter;
}

export interface IpBanRuleConfig {
  window_minutes: number;
  filters?: NotificationFilter;
}

export interface ApplicationUpdateRuleConfig {}

export interface LapiAvailabilityRuleConfig {
  outage_threshold_seconds: number;
  notify_on_recovery: boolean;
}

export type NotificationRuleConfig =
  | AlertSpikeRuleConfig
  | AlertThresholdRuleConfig
  | NewAlertDecisionRuleConfig
  | NewCveRuleConfig
  | IpBanRuleConfig
  | ApplicationUpdateRuleConfig
  | LapiAvailabilityRuleConfig;

export interface NotificationChannel {
  id: string;
  name: string;
  type: NotificationChannelType;
  enabled: boolean;
  config: Record<string, AlertMetaValue>;
  configured_secrets: string[];
  created_at: string;
  updated_at: string;
}

export interface NotificationRule {
  id: string;
  name: string;
  type: NotificationRuleType;
  enabled: boolean;
  severity: NotificationSeverity;
  channel_ids: string[];
  config: NotificationRuleConfig;
  created_at: string;
  updated_at: string;
}

export interface NotificationDeliveryResult {
  channel_id: string;
  channel_name: string;
  channel_type: NotificationChannelType;
  status: NotificationDeliveryStatus;
  attempted_at: string;
  error?: string;
}

export interface NotificationItem {
  id: string;
  rule_id: string;
  rule_name: string;
  rule_type: NotificationRuleType;
  severity: NotificationSeverity;
  title: string;
  message: string;
  created_at: string;
  read_at: string | null;
  metadata: Record<string, AlertMetaValue>;
  deliveries: NotificationDeliveryResult[];
}

export interface NotificationListResponse extends PaginatedResponse<NotificationItem> {
  unread_count: number;
}

export interface NotificationSettingsResponse {
  channels: NotificationChannel[];
  rules: NotificationRule[];
}

export interface UpsertNotificationChannelRequest {
  name: string;
  type: NotificationChannelType;
  enabled: boolean;
  config: Record<string, AlertMetaValue>;
}

export interface UpsertNotificationRuleRequest {
  name: string;
  type: NotificationRuleType;
  enabled: boolean;
  severity: NotificationSeverity;
  channel_ids: string[];
  config: NotificationRuleConfig;
}

export interface ConfigResponse {
  lookback_period: string;
  lookback_hours: number;
  lookback_days: number;
  refresh_interval: number;
  current_interval_name: string;
  lapi_status: LapiStatus;
  sync_status: SyncStatus;
  simulations_enabled: boolean;
  machine_features_enabled: boolean;
  origin_features_enabled: boolean;
  time_zone?: string | null;
  time_format?: 'browser' | '12h' | '24h';
  metrics_enabled?: boolean;
  metrics_sidebar_visible?: boolean;
  deployment_mode?: 'load-test';
  permissions?: {
    mode: 'admin' | 'read-only';
    can_manage_enforcement: boolean;
    can_manage_settings?: boolean;
  };
}

export interface UpdateMetricsSidebarPreferenceRequest {
  visible: boolean;
}

export interface CrowdsecMetricsApiEntity {
  name: string;
  requests: number;
  topRoute: string | null;
  topMethod: string | null;
  decisionsOk?: number;
  decisionsKo?: number;
}

export interface CrowdsecMetricsParserSource {
  source: string;
  type: string;
  acquisTypes: string[];
  linesRead: number | null;
  processed: number;
  parsedOk: number;
  parsedKo: number;
  pouredToBucket: number;
  whitelisted: number;
  successRate: number | null;
}

export interface CrowdsecMetricsParserNode {
  name: string;
  stage: string;
  source: string;
  type: string;
  acquisType: string | null;
  isChild: boolean;
  processed: number;
  parsedOk: number;
  parsedKo: number;
  successRate: number | null;
}

export interface CrowdsecMetricsTiming {
  source: string;
  type: string;
  count: number;
  averageSeconds: number | null;
}

export interface CrowdsecMetricsWhitelist {
  name: string;
  reason: string;
  hits: number;
  whitelisted: number;
}

export interface CrowdsecMetricsLapiRoute {
  method: string;
  route: string;
  requests: number;
  averageSeconds: number | null;
}

export interface CrowdsecMetricsAppsecEngine {
  engine: string;
  source: string;
  requests: number;
  blocked: number;
  blockRate: number | null;
}

export interface CrowdsecMetricsResponse {
  fetched_at: string;
  totals: {
    bouncerRequests: number;
    machineRequests: number;
    appsecRequests: number;
    appsecBlocked: number;
    parserProcessed: number;
    parserOk: number;
    parserKo: number;
    parserSuccessRate: number | null;
    parserAverageSeconds: number | null;
    whitelistHits: number;
    whitelisted: number;
  };
  bouncers: CrowdsecMetricsApiEntity[];
  machines: CrowdsecMetricsApiEntity[];
  parserSources: CrowdsecMetricsParserSource[];
  parserNodes: CrowdsecMetricsParserNode[];
  whitelists: CrowdsecMetricsWhitelist[];
  parserTimings: CrowdsecMetricsTiming[];
  lapiRoutes?: CrowdsecMetricsLapiRoute[];
  appsecEngines?: CrowdsecMetricsAppsecEngine[];
}

export interface AddDecisionRequest {
  ip: string;
  duration?: string;
  reason?: string;
  type?: 'ban' | 'captcha';
}

export interface RefreshIntervalRequest {
  interval: 'manual' | '0' | '5s' | '30s' | '1m' | '5m';
}

export interface BulkDeleteRequest {
  ids: Array<string | number>;
}

export interface CleanupByIpRequest {
  ip: string;
}

export type DeleteResourceKind = 'alert' | 'decision';

export interface BulkDeleteFailure {
  kind: DeleteResourceKind;
  id: string;
  error: string;
}

export interface BulkDeleteResult {
  requested_alerts: number;
  requested_decisions: number;
  deleted_alerts: number;
  deleted_decisions: number;
  failed: BulkDeleteFailure[];
  ip?: string;
}

export interface DeleteResult {
  message: string;
}
