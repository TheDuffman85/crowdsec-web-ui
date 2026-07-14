import type { AlertDecision, AlertRecord } from '../shared/contracts';
import { resolveMachineName } from '../shared/machine';
import { collectDistinctOrigins } from '../shared/origin';
import { buildMetaSearch, getAlertSourceValue, getAlertTarget, resolveAlertHistoryAt, resolveAlertScenario } from './utils/alerts';
import { normalizeIsoTimestamp } from './utils/date-time';

export interface AlertIndexValues {
  historyAt: string;
  scenario: string | null;
  sourceIp: string | null;
  latitude: number | null;
  longitude: number | null;
  country: string | null;
  countryName: string | null;
  asName: string | null;
  target: string | null;
  machine: string | null;
  metaSearch: string | null;
  origins: string | null;
  simulated: number;
  searchText: string;
}

export interface DecisionIndexValues {
  country: string | null;
  countryName: string | null;
  asName: string | null;
  target: string | null;
  machine: string | null;
  simulated: number;
  searchText: string;
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const countryNameCache = new Map<string, string>();

export function deriveAlertIndexValues(rawData: string, fallback: {
  createdAt: string;
  scenario?: string | null;
  sourceIp?: string | null;
  message?: string | null;
}): AlertIndexValues {
  const alert = parseJson<AlertRecord>(rawData);
  return deriveAlertIndexValuesFromRecord(alert, fallback);
}

export function deriveAlertIndexValuesFromRecord(alert: AlertRecord | null | undefined, fallback: {
  createdAt: string;
  scenario?: string | null;
  sourceIp?: string | null;
  message?: string | null;
}): AlertIndexValues {
  const resolvedHistoryAt = alert ? resolveAlertHistoryAt(alert) : null;
  const historyAt = normalizeIsoTimestamp(
    resolvedHistoryAt && Number.isFinite(Date.parse(resolvedHistoryAt)) ? resolvedHistoryAt : fallback.createdAt,
  );
  const scenario = alert ? resolveAlertScenario(alert) || fallback.scenario || null : fallback.scenario || null;
  const sourceIp = alert ? getAlertSourceValue(alert.source) || null : fallback.sourceIp || null;
  const latitude = normalizeCoordinate(alert?.source?.latitude, -90, 90);
  const longitude = normalizeCoordinate(alert?.source?.longitude, -180, 180);
  const country = normalizeCountryCode(alert?.source?.cn);
  const asName = normalizeText(alert?.source?.as_name);
  const target = alert ? normalizeText(alert.target || getAlertTarget(alert)) : null;
  const machine = alert ? normalizeText(resolveMachineName(alert)) : null;
  const metaSearch = alert ? normalizeText(buildMetaSearch(alert.events)) : null;
  const origins = alert ? normalizeText(collectDistinctOrigins(alert.decisions).join(' ')) : null;
  const simulated = alert && isAlertSimulated(alert) ? 1 : 0;
  const countryName = country ? getCountryName(country) : null;

  return {
    historyAt,
    scenario,
    sourceIp,
    latitude,
    longitude,
    country,
    countryName,
    asName,
    target,
    machine,
    metaSearch,
    origins,
    simulated,
    searchText: normalizeSearchText([
      alert?.id,
      scenario,
      fallback.message,
      alert?.message,
      sourceIp,
      country,
      countryName,
      asName,
      target,
      machine,
      metaSearch,
      origins,
      simulated ? 'simulation simulated' : 'live',
    ]),
  };
}

export function deriveDecisionIndexValues(rawData: string, fallback: {
  value?: string | null;
  type?: string | null;
  origin?: string | null;
  scenario?: string | null;
}): DecisionIndexValues {
  const decision = parseJson<(AlertDecision & Record<string, unknown>)>(rawData);
  return deriveDecisionIndexValuesFromRecord(decision, fallback);
}

export function deriveDecisionIndexValuesFromRecord(decision: (AlertDecision & Record<string, unknown>) | null | undefined, fallback: {
  value?: string | null;
  type?: string | null;
  origin?: string | null;
  scenario?: string | null;
}): DecisionIndexValues {
  const country = normalizeCountryCode(readString(decision?.country));
  const asName = normalizeText(readString(decision?.as));
  const target = normalizeText(readString(decision?.target));
  const machine = normalizeText(readString(decision?.machine));
  const simulated = decision && normalizeDecisionSimulated(decision) ? 1 : 0;
  const countryName = country ? getCountryName(country) : null;
  const value = readString(decision?.value) || fallback.value || null;
  const scenario = readString(decision?.scenario) || fallback.scenario || null;
  const type = readString(decision?.type) || fallback.type || null;
  const origin = readString(decision?.origin) || fallback.origin || null;

  return {
    country,
    countryName,
    asName,
    target,
    machine,
    simulated,
    searchText: normalizeSearchText([
      decision?.id,
      value,
      scenario,
      country,
      countryName,
      asName,
      target,
      machine,
      type,
      origin,
      simulated ? 'simulation simulated' : 'live',
    ]),
  };
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeCoordinate(value: unknown, minimum: number, maximum: number): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const coordinate = typeof value === 'number' ? value : Number(value.trim());
  return Number.isFinite(coordinate) && coordinate >= minimum && coordinate <= maximum ? coordinate : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeCountryCode(value: unknown): string | null {
  const normalized = normalizeText(value)?.toUpperCase() || null;
  return normalized && /^[A-Z]{2}$/.test(normalized) ? normalized : normalized;
}

function normalizeSearchText(values: unknown[]): string {
  return values
    .flatMap((value) => value === undefined || value === null ? [] : [String(value)])
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getCountryName(code: string): string | null {
  const normalized = code.toUpperCase();
  const cached = countryNameCache.get(normalized);
  if (cached) return cached;
  try {
    const value = regionNames.of(normalized) || code;
    countryNameCache.set(normalized, value);
    return value;
  } catch {
    countryNameCache.set(normalized, code);
    return code;
  }
}

function parseSimulationBoolean(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function hasSimulationMarker(value: unknown): boolean {
  return typeof value === 'string' &&
    (value.trim().toLowerCase().startsWith('(simul)') || value.trim().toLowerCase().includes('simulated'));
}

function normalizeDecisionSimulated(decision: AlertDecision & Record<string, unknown>): boolean {
  const explicit = parseSimulationBoolean(decision.simulated);
  if (explicit !== null) return explicit;
  return hasSimulationMarker(decision.type) || hasSimulationMarker(decision.action) || hasSimulationMarker(decision.decisions);
}

function isAlertSimulated(alert: AlertRecord): boolean {
  const explicit = parseSimulationBoolean(alert.simulated);
  if (explicit !== null) return explicit;

  return Array.isArray(alert.decisions) &&
    alert.decisions.length > 0 &&
    alert.decisions.every((decision) => normalizeDecisionSimulated(decision as AlertDecision & Record<string, unknown>));
}
