import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { SyncStatus } from '@shared/contracts';

export type {
  AddDecisionRequest,
  AlertDecision,
  AlertEvent,
  AlertMeta,
  AlertMetaValue,
  AlertRecord,
  AlertSource,
  ConfigResponse,
  DecisionListItem,
  SlimAlert,
  SlimDecision,
  StatsAlert,
  StatsDecision,
  SyncStatus,
  UpdateCheckResponse,
} from '@shared/contracts';

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

export interface ApiPermissionError extends Error {
  helpLink?: string;
  helpText?: string;
}

export interface WithChildren {
  children: ReactNode;
}
