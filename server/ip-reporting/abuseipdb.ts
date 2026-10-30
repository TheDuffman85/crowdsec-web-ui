import type { IpReportRejection } from '../../shared/contracts';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const ABUSEIPDB_API_URL = 'https://api.abuseipdb.com/api/v2';
export const ABUSEIPDB_CATEGORY_IDS = Array.from({ length: 23 }, (_, index) => index + 1);
export const ABUSEIPDB_BULK_MAX_ROWS = 9999;
export const ABUSEIPDB_COMMENT_MAX_BYTES = 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export interface AbuseIpdbReportRow {
  ip: string;
  categories: number[];
  reportDate: string;
  comment: string;
}

export interface AbuseIpdbSubmitResult {
  saved: string[];
  rejected: IpReportRejection[];
  /** Rows that were not sent because the API stopped accepting requests. */
  unsent: string[];
  error?: string;
}

interface AbuseIpdbError {
  status: number;
  detail: string;
  dailyLimit: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function buildBulkReportCsv(rows: AbuseIpdbReportRow[]): string {
  const lines = ['IP,Categories,ReportDate,Comment'];
  for (const row of rows) {
    lines.push([
      csvField(row.ip),
      csvField(row.categories.join(',')),
      csvField(row.reportDate),
      csvField(row.comment),
    ].join(','));
  }
  return `${lines.join('\n')}\n`;
}

async function readAbuseIpdbError(response: Response): Promise<AbuseIpdbError> {
  let detail = '';
  try {
    const payload = asRecord(await response.json());
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    detail = errors
      .map((entry) => asRecord(entry).detail)
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join('; ');
  } catch {
    detail = '';
  }
  const dailyLimit = response.status === 429
    && (response.headers.get('X-RateLimit-Remaining') === '0' || /daily rate limit/i.test(detail));
  return {
    status: response.status,
    detail: detail || `AbuseIPDB request failed with status ${response.status}`,
    dailyLimit,
  };
}

function requestHeaders(apiKey: string): Record<string, string> {
  return { Key: apiKey, Accept: 'application/json' };
}

export async function submitBulkReport(
  apiKey: string,
  rows: AbuseIpdbReportRow[],
  fetchImpl: FetchLike,
): Promise<AbuseIpdbSubmitResult> {
  if (rows.length === 0) return { saved: [], rejected: [], unsent: [] };

  const form = new FormData();
  form.append('csv', new Blob([buildBulkReportCsv(rows)], { type: 'text/csv' }), 'report.csv');

  let response: Response;
  try {
    response = await fetchImpl(`${ABUSEIPDB_API_URL}/bulk-report`, {
      method: 'POST',
      headers: requestHeaders(apiKey),
      body: form,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      saved: [],
      rejected: [],
      unsent: rows.map((row) => row.ip),
      error: error instanceof Error ? error.message : 'AbuseIPDB request failed',
    };
  }

  if (!response.ok) {
    const failure = await readAbuseIpdbError(response);
    return { saved: [], rejected: [], unsent: rows.map((row) => row.ip), error: failure.detail };
  }

  const data = asRecord(asRecord(await response.json().catch(() => ({}))).data);
  if (typeof data.savedReports !== 'number') {
    return { saved: [], rejected: [], unsent: rows.map((row) => row.ip), error: 'Unexpected AbuseIPDB response' };
  }
  const invalid = Array.isArray(data.invalidReports) ? data.invalidReports.map(asRecord) : [];
  const rejected = invalid.map((entry) => ({
    ip: typeof entry.input === 'string' ? entry.input : '',
    error: typeof entry.error === 'string' ? entry.error : 'Rejected',
  }));
  const rejectedIps = new Set(rejected.map((entry) => entry.ip));
  return {
    saved: rows.map((row) => row.ip).filter((ip) => !rejectedIps.has(ip)),
    rejected,
    unsent: [],
  };
}

export async function submitSingleReports(
  apiKey: string,
  rows: AbuseIpdbReportRow[],
  fetchImpl: FetchLike,
): Promise<AbuseIpdbSubmitResult> {
  const result: AbuseIpdbSubmitResult = { saved: [], rejected: [], unsent: [] };

  for (const [index, row] of rows.entries()) {
    let response: Response;
    try {
      response = await fetchImpl(`${ABUSEIPDB_API_URL}/report`, {
        method: 'POST',
        headers: { ...requestHeaders(apiKey), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          ip: row.ip,
          categories: row.categories.join(','),
          comment: row.comment,
          timestamp: row.reportDate,
        }).toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      result.unsent.push(...rows.slice(index).map((entry) => entry.ip));
      result.error = error instanceof Error ? error.message : 'AbuseIPDB request failed';
      return result;
    }

    if (response.ok) {
      await response.body?.cancel().catch(() => undefined);
      result.saved.push(row.ip);
      continue;
    }

    const failure = await readAbuseIpdbError(response);
    if (failure.dailyLimit || failure.status === 401 || failure.status === 403) {
      result.unsent.push(...rows.slice(index).map((entry) => entry.ip));
      result.error = failure.detail;
      return result;
    }
    result.rejected.push({ ip: row.ip, error: failure.detail });
  }

  return result;
}
