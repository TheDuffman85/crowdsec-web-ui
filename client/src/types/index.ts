import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { SyncStatus } from '../../../shared/contracts';

export type {
  AddDecisionRequest,
  AlertDecision,
  AlertEvent,
  AlertMeta,
  AlertMetaValue,
  AlertRecord,
  AlertSource,
  ConfigResponse,
  DashboardGranularity,
  DashboardSimulationFilter,
  DashboardStatListItem,
  DashboardStatsBucket,
  DashboardStatsResponse,
  DashboardStatsSeries,
  DashboardStatsTotals,
  DashboardWorldMapDatum,
  CrowdsecMetricsApiEntity,
  CrowdsecMetricsAppsecEngine,
  CrowdsecMetricsLapiRoute,
  CrowdsecMetricsParserNode,
  CrowdsecMetricsParserSource,
  CrowdsecMetricsResponse,
  CrowdsecMetricsTiming,
  CrowdsecMetricsWhitelist,
  BulkDeleteRequest,
  BulkDeleteResult,
  CleanupByIpRequest,
  NotificationChannel,
  NotificationChannelType,
  DeleteResourceKind,
  NotificationDeliveryResult,
  NotificationDeliveryStatus,
  NotificationFilter,
  NotificationItem,
  NotificationListResponse,
  PaginatedResponse,
  NotificationRule,
  NotificationRuleConfig,
  NotificationRuleType,
  NotificationSeverity,
  NotificationSettingsResponse,
  BulkDeleteFailure,
  DecisionListItem,
  SlimAlert,
  SlimDecision,
  StatsAlert,
  StatsDecision,
  SyncStatus,
  TableColumnId,
  TableColumnPreferences,
  TableColumnPreferenceTable,
  TableColumnPreferenceViewport,
  TableColumnViewportPreferences,
  UpsertNotificationChannelRequest,
  UpsertNotificationRuleRequest,
  UpdateTableColumnsRequest,
  UpdateMetricsSidebarPreferenceRequest,
  UpdateCheckResponse,
} from '../../../shared/contracts';

export interface DateRangeSelection {
  start: string;
  end: string;
}

export type SimulationFilter = 'all' | 'live' | 'simulated';

export interface DashboardFilters {
  dateRange: DateRangeSelection | null;
  dateRangeSticky: boolean;
  country: string | null;
  scenario: string | null;
  as: string | null;
  ip: string | null;
  target: string | null;
  simulation: SimulationFilter;
}

export interface AggregatedChartPoint {
  date: string;
  count: number;
  label: string;
  fullDate: string;
}

export interface StatListItem {
  label: string;
  count: number;
  value?: string;
  countryCode?: string;
}

export interface WorldMapDatum {
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

export type ActivityChartSeriesPoint = AggregatedChartPoint;

export interface RefreshContextValue {
  lastUpdated: Date | null;
  setLastUpdated: Dispatch<SetStateAction<Date | null>>;
  intervalMs: number;
  setIntervalMs: (newIntervalMs: number) => Promise<void>;
  refreshSignal: number;
  syncStatus: SyncStatus | null;
}

export interface NotificationUnreadContextValue {
  unreadCount: number;
  setUnreadCount: Dispatch<SetStateAction<number>>;
  refreshUnreadCount: () => Promise<void>;
}

export interface ApiPermissionError extends Error {
  helpLink?: string;
  helpText?: string;
}

export interface WithChildren {
  children: ReactNode;
}
