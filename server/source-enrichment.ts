import { isIP } from 'node:net';
import type { AlertRecord, AlertSource } from '../shared/contracts';
import { resolveAlertHistoryAt } from './utils/alerts';

/**
 * CrowdSec enriches alert sources (country, AS, network, coordinates) in the
 * agent's parsers. LAPI stores the alerts of manual decisions (web UI, cscli,
 * console) as sent, without that enrichment, although the same IP is usually
 * known from earlier alerts. These helpers copy the latest known enrichment of
 * a single IP onto such alerts during sync.
 *
 * A copy records when its data was observed in `copied_enrichment_at`, so it
 * ranks by the time of the alert it came from, not by the manual alert's own
 * time: a copy can never shadow real data observed after the data it copied.
 */

export const COPIED_ENRICHMENT_AT = 'copied_enrichment_at';
export const SOURCE_ENRICHMENT_LOOKUP_CHUNK_SIZE = 500;

export type SourceEnrichmentRow = {
  source_ip: string;
  /** When the enrichment was observed: a copy's original time, else the alert's time. */
  observed_at: string;
  country: string | null;
  as_name: string | null;
  source_as_number: string | null;
  source_range: string | null;
  source_scope: string | null;
  latitude: number | null;
  longitude: number | null;
};

const isMissing = (value: unknown): boolean => value === undefined || value === null || value === '';
// LAPI reports unknown coordinates as 0, 0.
const isUnknownLocation = (latitude: unknown, longitude: unknown): boolean =>
  (isMissing(latitude) || Number(latitude) === 0) && (isMissing(longitude) || Number(longitude) === 0);

/**
 * Selects the most recently observed enrichment of each given IP, from the
 * source_ip index. Copies stay candidates, so manual alerts keep their data
 * after retention removes the alerts it came from; on equal observation times
 * the original wins.
 */
export function latestSourceEnrichmentSql(count: number): string {
  const copiedAt = `CASE WHEN json_valid(source_extra_data) THEN json_extract(source_extra_data, '$.${COPIED_ENRICHMENT_AT}') END`;
  return `SELECT source_ip, observed_at, country, as_name, source_as_number, source_range, source_scope, latitude, longitude FROM (
    SELECT source_ip, observed_at, country, as_name, source_as_number, source_range, source_scope, latitude, longitude,
      ROW_NUMBER() OVER (PARTITION BY source_ip ORDER BY observed_at DESC, copied, id DESC) AS position
    FROM (
      SELECT id, source_ip, country, as_name, source_as_number, source_range, source_scope, latitude, longitude,
        COALESCE(${copiedAt}, created_at) AS observed_at, ${copiedAt} IS NOT NULL AS copied
      FROM alerts WHERE source_ip IN (${Array(count).fill('?').join(',')}) AND (country IS NOT NULL OR as_name IS NOT NULL)
    )
  ) WHERE position = 1`;
}

function pickEnrichment(fields: {
  cn: unknown; asName: unknown; asNumber: unknown; range: unknown; scope: unknown; latitude: unknown; longitude: unknown;
}): AlertSource {
  const source: AlertSource = {};
  if (!isMissing(fields.cn)) source.cn = String(fields.cn);
  if (!isMissing(fields.asName)) source.as_name = String(fields.asName);
  if (!isMissing(fields.asNumber)) source.as_number = String(fields.asNumber);
  // For an IP-scoped alert the range is its enriched network, not the decision scope.
  if (!isMissing(fields.range) && typeof fields.scope === 'string' && fields.scope.toLowerCase() === 'ip') source.range = String(fields.range);
  if (!isUnknownLocation(fields.latitude, fields.longitude) && !isMissing(fields.latitude) && !isMissing(fields.longitude)) {
    source.latitude = fields.latitude as number | string;
    source.longitude = fields.longitude as number | string;
  }
  return source;
}

export function sourceEnrichmentFromRow(row: SourceEnrichmentRow): AlertSource {
  return pickEnrichment({
    cn: row.country, asName: row.as_name, asNumber: row.source_as_number, range: row.source_range,
    scope: row.source_scope, latitude: row.latitude, longitude: row.longitude,
  });
}

type EnrichmentQuery = (sql: string, params: string[]) => SourceEnrichmentRow[] | Promise<SourceEnrichmentRow[]>;
type DatedEnrichment = { at: number; source: AlertSource };

async function loadLatestDatedEnrichment(ips: string[], query: EnrichmentQuery): Promise<Map<string, DatedEnrichment>> {
  const result = new Map<string, DatedEnrichment>();
  for (let offset = 0; offset < ips.length; offset += SOURCE_ENRICHMENT_LOOKUP_CHUNK_SIZE) {
    const chunk = ips.slice(offset, offset + SOURCE_ENRICHMENT_LOOKUP_CHUNK_SIZE);
    for (const row of await query(latestSourceEnrichmentSql(chunk.length), chunk)) {
      const at = Date.parse(row.observed_at);
      if (Number.isFinite(at)) result.set(row.source_ip, { at, source: sourceEnrichmentFromRow(row) });
    }
  }
  return result;
}

function getSingleSourceIp(source: AlertSource): string | undefined {
  if (typeof source.scope === 'string' && source.scope.toLowerCase() !== 'ip') return undefined;
  const value = [source.ip, source.value].find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
  return value && isIP(value) !== 0 ? value : undefined;
}

/** The single IP of an IP-scoped source that carries neither country nor AS data. */
export function getUnenrichedSourceIp(source: AlertSource | null | undefined): string | undefined {
  if (!source || !isMissing(source.cn) || !isMissing(source.as_name)) return undefined;
  return getSingleSourceIp(source);
}

/**
 * Fills only missing source fields, so the alert's own data and scope always
 * win, and records when the copied data was observed.
 */
export function withSourceEnrichment(alert: AlertRecord, enrichment: AlertSource, observedAt: number): AlertRecord {
  const source: AlertSource = { ...alert.source };
  for (const key of ['cn', 'as_name', 'as_number', 'range']) {
    if (isMissing(source[key]) && !isMissing(enrichment[key])) source[key] = enrichment[key];
  }
  if (isUnknownLocation(source.latitude, source.longitude) && !isUnknownLocation(enrichment.latitude, enrichment.longitude)) {
    source.latitude = enrichment.latitude;
    source.longitude = enrichment.longitude;
  }
  source[COPIED_ENRICHMENT_AT] = new Date(observedAt).toISOString();
  return { ...alert, source };
}

/**
 * Copies the most recently observed enrichment onto alerts whose single-IP
 * source has none, from the cache or from enriched alerts of the same batch,
 * which are not cached yet on a first import. The result only changes when
 * enrichment observed later appears for that IP, so the metadata fingerprint
 * taken afterwards stays stable across syncs.
 */
export async function enrichAlertSourcesFromCache(alerts: AlertRecord[], query: EnrichmentQuery): Promise<AlertRecord[]> {
  const ips = new Set<string>();
  for (const alert of alerts) {
    const ip = getUnenrichedSourceIp(alert.source);
    if (ip) ips.add(ip);
  }
  // Almost every sync has no manual alerts, so it skips the lookup entirely.
  if (ips.size === 0) return alerts;
  const latest = await loadLatestDatedEnrichment([...ips], query);
  for (const alert of alerts) {
    // Incoming alerts come from LAPI, so an enriched one is original data.
    const source = alert.source;
    if (!source || (isMissing(source.cn) && isMissing(source.as_name))) continue;
    const ip = getSingleSourceIp(source);
    if (!ip || !ips.has(ip)) continue;
    const at = Date.parse(resolveAlertHistoryAt(alert) || '');
    const known = latest.get(ip);
    // On equal times the batch copy of a cached alert matches the cached one.
    if (!Number.isFinite(at) || (known && known.at >= at)) continue;
    latest.set(ip, {
      at,
      source: pickEnrichment({
        cn: source.cn, asName: source.as_name, asNumber: source.as_number, range: source.range,
        scope: source.scope, latitude: source.latitude, longitude: source.longitude,
      }),
    });
  }
  if (latest.size === 0) return alerts;
  return alerts.map((alert) => {
    const ip = getUnenrichedSourceIp(alert.source);
    const known = ip ? latest.get(ip) : undefined;
    return known ? withSourceEnrichment(alert, known.source, known.at) : alert;
  });
}
