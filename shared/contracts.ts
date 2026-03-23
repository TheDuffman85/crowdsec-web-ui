export interface ApiErrorResponse {
  error: string;
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
  scenario?: string;
  value?: string;
  expired: boolean;
  is_duplicate: boolean;
  simulated?: boolean;
  detail: DecisionListDetail;
}

export interface StatsAlert {
  created_at: string;
  scenario?: string;
  source: Pick<AlertSource, 'ip' | 'value' | 'cn' | 'as_name'> | null;
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

export interface UpdateCheckResponse {
  update_available: boolean;
  reason?: string;
  local_version?: string | null;
  remote_version?: string | null;
  release_url?: string;
  tag?: string;
  error?: string;
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

export interface DeleteResult {
  message: string;
}
