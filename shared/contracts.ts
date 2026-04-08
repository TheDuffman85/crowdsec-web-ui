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
}

export interface SyncStatus {
  isSyncing: boolean;
  progress: number;
  message: string;
  startedAt: string | null;
  completedAt: string | null;
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
  source: Pick<AlertSource, 'ip' | 'value' | 'range' | 'cn' | 'as_name' | 'scope'> | null;
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
  unfilteredAlertsHistory: DashboardStatsBucket[];
  unfilteredSimulatedAlertsHistory: DashboardStatsBucket[];
  unfilteredDecisionsHistory: DashboardStatsBucket[];
  unfilteredSimulatedDecisionsHistory: DashboardStatsBucket[];
}

export interface DashboardStatsResponse {
  totals: DashboardStatsTotals;
  filteredTotals: DashboardStatsTotals;
  globalTotal: number;
  topTargets: DashboardStatListItem[];
  topCountries: DashboardStatListItem[];
  allCountries: DashboardWorldMapDatum[];
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
export type NotificationRuleType = 'alert-spike' | 'alert-threshold' | 'new-cve' | 'application-update';
export type NotificationSeverity = 'info' | 'warning' | 'critical';
export type NotificationDeliveryStatus = 'delivered' | 'failed' | 'skipped';

export interface NotificationFilter {
  scenario?: string;
  target?: string;
  include_simulated?: boolean;
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

export interface NewCveRuleConfig {
  max_cve_age_days: number;
  filters?: NotificationFilter;
}

export interface ApplicationUpdateRuleConfig {}

export type NotificationRuleConfig =
  | AlertSpikeRuleConfig
  | AlertThresholdRuleConfig
  | NewCveRuleConfig
  | ApplicationUpdateRuleConfig;

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

export interface NotificationListResponse {
  notifications: NotificationItem[];
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
