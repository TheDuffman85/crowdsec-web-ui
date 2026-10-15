import crypto from 'node:crypto';
import { isValidDecisionScenario } from '../../shared/contracts';
import type { CrowdsecDatabase } from '../database';

const METRICS_SIDEBAR_VISIBLE_META_KEY = 'metrics_sidebar_visible';
const MANUAL_DECISION_SCENARIOS_META_KEY = 'manual_decision_scenarios';
const NOTIFICATION_SECRET_KEY_META_KEY = 'notification_secret_key';

export interface PersistedConfig {
  refresh_interval_ms?: number;
  manual_refresh_enabled?: boolean;
}

export function loadMetricsSidebarVisible(database: CrowdsecDatabase): boolean {
  try {
    const value = database.getMeta(METRICS_SIDEBAR_VISIBLE_META_KEY)?.value;
    return value !== 'false';
  } catch (error) {
    console.error('Error loading metrics sidebar preference from database:', error);
    return true;
  }
}

export function saveMetricsSidebarVisible(database: CrowdsecDatabase, visible: boolean): void {
  database.setMeta(METRICS_SIDEBAR_VISIBLE_META_KEY, visible ? 'true' : 'false');
}

export function loadManualDecisionScenarios(database: CrowdsecDatabase): string[] {
  try {
    const value = database.getMeta(MANUAL_DECISION_SCENARIOS_META_KEY)?.value;
    if (!value) return [];
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string' && isValidDecisionScenario(entry));
  } catch (error) {
    console.error('Error loading manual decision scenarios from database:', error);
    return [];
  }
}

export function saveManualDecisionScenarios(database: CrowdsecDatabase, scenarios: string[]): void {
  database.setMeta(MANUAL_DECISION_SCENARIOS_META_KEY, JSON.stringify(scenarios));
}

export function loadPersistedConfig(database: CrowdsecDatabase): PersistedConfig {
  try {
    const refreshInterval = database.getMeta('refresh_interval_ms')?.value;
    const manualRefresh = database.getMeta('manual_refresh_enabled')?.value;
    const config: PersistedConfig = {};
    if (refreshInterval !== undefined) {
      config.refresh_interval_ms = Number.parseInt(refreshInterval, 10);
    }
    if (manualRefresh !== undefined) {
      config.manual_refresh_enabled = manualRefresh === 'true';
    }
    if (Object.keys(config).length > 0) {
      console.log('Loaded persisted config from database:', config);
      return config;
    }
  } catch (error) {
    console.error('Error loading config from database:', error);
  }

  return {};
}

export function savePersistedConfig(database: CrowdsecDatabase, config: PersistedConfig): void {
  try {
    if (config.refresh_interval_ms !== undefined) {
      database.setMeta('refresh_interval_ms', String(config.refresh_interval_ms));
    }
    if (config.manual_refresh_enabled !== undefined) {
      database.setMeta('manual_refresh_enabled', String(config.manual_refresh_enabled));
    }
    console.log('Saved config to database:', config);
  } catch (error) {
    console.error('Error saving config to database:', error);
  }
}

export function resolveNotificationSecretKey(database: CrowdsecDatabase, configuredKey?: string): string {
  const trimmedConfiguredKey = configuredKey?.trim();
  if (trimmedConfiguredKey) {
    return trimmedConfiguredKey;
  }

  const persisted = database.getMeta(NOTIFICATION_SECRET_KEY_META_KEY)?.value?.trim();
  if (persisted) {
    return persisted;
  }

  const generated = crypto.randomBytes(32).toString('base64url');
  database.setMeta(NOTIFICATION_SECRET_KEY_META_KEY, generated);
  console.log('Generated a notification encryption key and stored it in application metadata.');
  return generated;
}
