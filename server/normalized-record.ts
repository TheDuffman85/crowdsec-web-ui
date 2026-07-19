import crypto from 'node:crypto';
import type { AlertDecision, AlertRecord, AlertSource } from '../shared/contracts';

export type NormalizedAlertRow = {
  id: string | number;
  internal_id?: string | number;
  instance_id?: string;
  uuid?: string | null;
  created_at: string;
  start_at?: string | null;
  stop_at?: string | null;
  scenario?: string | null;
  record_scenario?: string | null;
  reason?: string | null;
  source_ip?: string | null;
  source_value?: string | null;
  source_scope?: string | null;
  source_range?: string | null;
  source_as_number?: string | number | null;
  source_extra_data?: string | null;
  message?: string | null;
  machine_id?: string | null;
  machine_alias?: string | null;
  events_count?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  as_name?: string | null;
  target?: string | null;
  meta_search?: string | null;
  simulated?: number | boolean | null;
  extra_data?: string | null;
  metadata_hash?: string | null;
};

const NORMALIZED_ALERT_KEYS = new Set([
  'id', 'uuid', 'created_at', 'start_at', 'stop_at', 'scenario', 'reason',
  'source', 'message', 'machine_id', 'machine_alias', 'events_count',
  'decisions', 'target', 'meta_search', 'simulated',
]);

const NORMALIZED_SOURCE_KEYS = new Set([
  'ip', 'value', 'cn', 'as_name', 'as_number', 'scope', 'latitude',
  'longitude', 'city', 'region', 'range',
]);

export const ALERT_RECORD_COLUMNS = [
  'COALESCE(upstream_id, CAST(id AS TEXT)) AS id', 'id AS internal_id', 'instance_id', 'uuid', 'created_at', 'start_at', 'stop_at', 'scenario', 'record_scenario', 'reason',
  'source_ip', 'source_value', 'source_scope', 'source_range', 'source_as_number',
  'source_extra_data', 'message', 'machine_id', 'machine_alias', 'events_count',
  'latitude', 'longitude', 'country', 'region', 'city', 'as_name', 'target',
  'meta_search', 'simulated', 'extra_data', 'metadata_hash',
].join(', ');

export type NormalizedDecisionRow = {
  id: string | number;
  internal_id?: string | number;
  instance_id?: string;
  uuid?: string | null;
  alert_id?: string | number | null;
  created_at: string;
  stop_at: string;
  value?: string | null;
  type?: string | null;
  origin?: string | null;
  scenario?: string | null;
  duration?: string | null;
  scope?: string | null;
  country?: string | null;
  country_name?: string | null;
  region?: string | null;
  city?: string | null;
  as_name?: string | null;
  target?: string | null;
  machine?: string | null;
  simulated?: number | boolean | null;
  extra_data?: string | null;
};

const NORMALIZED_DECISION_KEYS = new Set([
  'id',
  'uuid',
  'alert_id',
  'created_at',
  'stop_at',
  'value',
  'type',
  'origin',
  'scenario',
  'duration',
  'scope',
  'country',
  'country_name',
  'region',
  'city',
  'as',
  'as_name',
  'target',
  'machine',
  'simulated',
  'expired',
  'is_duplicate',
]);

export const DECISION_RECORD_COLUMNS = [
  'COALESCE(upstream_id, CAST(id AS TEXT)) AS id',
  'id AS internal_id',
  'instance_id',
  'uuid',
  'alert_upstream_id AS alert_id',
  'created_at',
  'stop_at',
  'value',
  'type',
  'origin',
  'scenario',
  'duration',
  'scope',
  'country',
  'country_name',
  'region',
  'city',
  'as_name',
  'target',
  'machine',
  'simulated',
  'extra_data',
].join(', ');

export function parseAlertPayload(rawData: string | null | undefined): AlertRecord | null {
  if (!rawData) return null;
  try {
    const parsed = JSON.parse(rawData) as AlertRecord;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function serializeAlertExtras(alert: AlertRecord | null | undefined): string | null {
  if (!alert) return null;
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(alert)) {
    if (!NORMALIZED_ALERT_KEYS.has(key)) extras[key] = value;
  }
  return Object.keys(extras).length > 0 ? JSON.stringify(extras) : null;
}

export function serializeAlertSourceExtras(source: AlertSource | null | undefined): string | null {
  if (!source) return null;
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!NORMALIZED_SOURCE_KEYS.has(key)) extras[key] = value;
  }
  return Object.keys(extras).length > 0 ? JSON.stringify(extras) : null;
}

export function alertMetadataFingerprint(alert: AlertRecord | null | undefined): string | null {
  if (!alert) return null;
  const { decisions: _decisions, ...metadata } = alert;
  return crypto.createHash('sha256').update(stableSerialize(metadata)).digest('hex');
}

export function alertFromRow(row: NormalizedAlertRow): AlertRecord {
  const alert = {
    ...parseExtras(row.extra_data),
    id: normalizeRecordId(row.id),
    instance_id: row.instance_id || 'default',
    created_at: row.created_at,
    simulated: row.simulated === true || row.simulated === 1,
  } as AlertRecord;
  assignDefined(alert, 'uuid', row.uuid);
  assignDefined(alert, 'start_at', row.start_at);
  assignDefined(alert, 'stop_at', row.stop_at);
  assignDefined(alert, 'scenario', row.record_scenario ?? row.scenario);
  assignDefined(alert, 'reason', row.reason);
  assignDefined(alert, 'message', row.message);
  assignDefined(alert, 'machine_id', row.machine_id);
  assignDefined(alert, 'machine_alias', row.machine_alias);
  assignDefined(alert, 'events_count', row.events_count);
  assignDefined(alert, 'target', row.target);
  assignDefined(alert, 'meta_search', row.meta_search);

  const source = { ...parseExtras(row.source_extra_data) } as AlertSource;
  assignDefined(source, 'ip', row.source_ip);
  assignDefined(source, 'value', row.source_value);
  assignDefined(source, 'scope', row.source_scope);
  assignDefined(source, 'range', row.source_range);
  assignDefined(source, 'as_number', row.source_as_number);
  assignDefined(source, 'latitude', row.latitude);
  assignDefined(source, 'longitude', row.longitude);
  assignDefined(source, 'cn', row.country);
  assignDefined(source, 'region', row.region);
  assignDefined(source, 'city', row.city);
  assignDefined(source, 'as_name', row.as_name);
  if (Object.keys(source).length > 0) alert.source = source;
  return alert;
}

export function parseDecisionPayload(rawData: string | null | undefined): (AlertDecision & Record<string, unknown>) | null {
  if (!rawData) return null;
  try {
    const parsed = JSON.parse(rawData) as AlertDecision & Record<string, unknown>;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function serializeDecisionExtras(decision: (AlertDecision & Record<string, unknown>) | null | undefined): string | null {
  if (!decision) return null;
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(decision)) {
    if (!NORMALIZED_DECISION_KEYS.has(key)) extras[key] = value;
  }
  return Object.keys(extras).length > 0 ? JSON.stringify(extras) : null;
}

export function decisionFromRow(row: NormalizedDecisionRow): AlertDecision & Record<string, unknown> {
  const extras = parseExtras(row.extra_data);
  const decision: AlertDecision & Record<string, unknown> = {
    ...extras,
    id: normalizeRecordId(row.id),
    instance_id: row.instance_id || 'default',
    created_at: row.created_at,
    stop_at: row.stop_at,
    simulated: row.simulated === true || row.simulated === 1,
  };

  assignDefined(decision, 'uuid', row.uuid);
  assignDefined(decision, 'alert_id', row.alert_id === undefined || row.alert_id === null ? row.alert_id : normalizeRecordId(row.alert_id));
  assignDefined(decision, 'value', row.value);
  assignDefined(decision, 'type', row.type);
  assignDefined(decision, 'origin', row.origin);
  assignDefined(decision, 'scenario', row.scenario);
  assignDefined(decision, 'duration', row.duration);
  assignDefined(decision, 'scope', row.scope);
  assignDefined(decision, 'country', row.country);
  assignDefined(decision, 'country_name', row.country_name);
  assignDefined(decision, 'region', row.region);
  assignDefined(decision, 'city', row.city);
  assignDefined(decision, 'as', row.as_name);
  assignDefined(decision, 'target', row.target);
  assignDefined(decision, 'machine', row.machine);
  return decision;
}

function normalizeRecordId(value: string | number): string | number {
  if (typeof value === 'number') return value;
  if (!/^\d+$/.test(value)) return value;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : value;
}

export function decisionRowToJson(row: NormalizedDecisionRow): string {
  return JSON.stringify(decisionFromRow(row));
}

function parseExtras(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function assignDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null) target[key] = value;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
