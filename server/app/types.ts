import type {
  DashboardGranularity,
  DashboardSimulationFilter,
  DashboardStatsTotals,
  FacetField,
} from '../../shared/contracts';
import type { DashboardAttackLocationAccumulator } from '../dashboard-locations';

export interface PageRequest {
  page: number;
  pageSize: number;
}

export interface FacetRequest {
  field: FacetField;
  search: string;
  searchValues: string[];
  offset: number;
  limit: number;
}

export interface AlertListFilters {
  instanceId: string;
  q: string;
  ip: string;
  country: string;
  scenario: string;
  as: string;
  date: string;
  dateStart: string;
  dateEnd: string;
  target: string;
  simulation: string;
  timezoneOffsetMinutes: number;
  timeZone: string | null;
}

export interface DecisionListFilters {
  instanceId: string;
  q: string;
  alertId: string;
  country: string;
  scenario: string;
  as: string;
  ip: string;
  target: string;
  dateStart: string;
  dateEnd: string;
  simulation: string;
  showDuplicates: boolean;
  timezoneOffsetMinutes: number;
  timeZone: string | null;
}

export interface DashboardStatsFilters {
  instanceId: string;
  q: string;
  decisionQ: string;
  country: string;
  scenario: string;
  as: string;
  ip: string;
  target: string;
  dateStart: string;
  dateEnd: string;
  simulation: DashboardSimulationFilter;
  granularity: DashboardGranularity;
  timezoneOffsetMinutes: number;
  timeZone: string | null;
}

export interface DashboardStatsCache {
  key: string;
  scope: string;
  primaryOnly: boolean;
  changeEpoch: number;
  changeRevision: number;
  alerts: DashboardAlertStatsRecord[];
  decisions: DashboardDecisionStatsRecord[];
  totals: DashboardStatsTotals;
}

export interface DashboardAlertStatsRecord {
  internalId: string | number;
  id: string | number;
  instanceId: string;
  createdAt: string;
  timestamp: number;
  country?: string;
  region?: string;
  city?: string;
  scenario?: string;
  kind?: string;
  asName?: string;
  ip?: string;
  sourceValue?: string;
  sourceRange?: string;
  latitude?: number;
  longitude?: number;
  target?: string;
  targets?: string[];
  machine?: string;
  machineId?: string;
  machineAlias?: string;
  origins?: string[];
  simulated: boolean;
}

export interface DashboardDecisionStatsRecord {
  internalId: string | number;
  id: string | number;
  instanceId: string;
  alertId?: string | number;
  createdAt: string;
  stopAt?: string;
  timestamp: number;
  stopTimestamp: number;
  value?: string;
  country?: string;
  region?: string;
  city?: string;
  scenario?: string;
  asName?: string;
  target?: string;
  targets?: string[];
  type?: string;
  origin?: string;
  machine?: string;
  machineId?: string;
  machineAlias?: string;
  duration?: string;
  isDuplicate: boolean;
  simulated: boolean;
}

export interface DashboardStatsAccumulator {
  alerts: number;
  liveAlerts: number;
  simulatedAlerts: number;
  countries: Map<string, { count: number; liveCount: number; simulatedCount: number }>;
  attackLocations: DashboardAttackLocationAccumulator;
  scenarios: Map<string, number>;
  asNames: Map<string, number>;
  targets: Map<string, number>;
  liveAlertBuckets: Map<string, number>;
  simulatedAlertBuckets: Map<string, number>;
}

export interface DashboardDecisionAccumulator {
  decisions: number;
  simulatedDecisions: number;
  countries: Map<string, {
    liveDecisionCount: number;
    simulatedDecisionCount: number;
    activeLiveDecisionCount: number;
    activeSimulatedDecisionCount: number;
  }>;
  liveDecisionBuckets: Map<string, number>;
  simulatedDecisionBuckets: Map<string, number>;
  activeLiveDecisionBuckets: Map<string, number>;
  activeSimulatedDecisionBuckets: Map<string, number>;
}
