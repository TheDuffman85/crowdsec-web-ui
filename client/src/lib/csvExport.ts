import type { DecisionListItem, SlimAlert } from '../types';

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | boolean | null | undefined;
}

/** Hard cap so a huge unfiltered export cannot exhaust browser memory. */
export const CSV_EXPORT_MAX_ROWS = 100_000;
export const CSV_EXPORT_PAGE_SIZE = 200;

// Spreadsheet applications run cells that start with these characters as formulas.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function escapeCsvCell(raw: string | number | boolean | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  let text = String(raw);
  if (typeof raw === 'string' && FORMULA_PREFIX.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map((column) => escapeCsvCell(column.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsvCell(column.value(row))).join(','));
  }
  // CRLF line endings and a leading BOM keep Excel happy with UTF-8.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export interface CsvPage<T> {
  data: T[];
  pagination: { total_pages: number };
}

export interface CsvCollectResult<T> {
  rows: T[];
  truncated: boolean;
}

/** Walks every page of a paginated list, stopping at the row cap. */
export async function collectAllPages<T>(
  fetchPage: (page: number) => Promise<CsvPage<T>>,
  maxRows = CSV_EXPORT_MAX_ROWS,
): Promise<CsvCollectResult<T>> {
  const rows: T[] = [];
  let page = 1;
  let totalPages: number;
  do {
    const result = await fetchPage(page);
    totalPages = result.pagination.total_pages;
    rows.push(...result.data);
    if (rows.length >= maxRows) {
      return { rows: rows.slice(0, maxRows), truncated: rows.length > maxRows || page < totalPages };
    }
    page += 1;
  } while (page <= totalPages);
  return { rows, truncated: false };
}

export function csvFilename(kind: 'alerts' | 'decisions' | 'audit-log', now = new Date()): string {
  const stamp = now.toISOString().replace(/[:T]/g, '-').slice(0, 16);
  return `crowdsec-${kind}-${stamp}.csv`;
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export const ALERT_CSV_COLUMNS: CsvColumn<SlimAlert>[] = [
  { header: 'id', value: (alert) => alert.id },
  { header: 'instance', value: (alert) => alert.instance_name ?? alert.instance_id },
  { header: 'created_at', value: (alert) => alert.created_at },
  { header: 'scenario', value: (alert) => alert.scenario },
  { header: 'kind', value: (alert) => alert.kind },
  { header: 'source', value: (alert) => alert.source?.ip ?? alert.source?.value ?? alert.source?.range },
  { header: 'country', value: (alert) => alert.source?.cn },
  { header: 'city', value: (alert) => alert.source?.city },
  { header: 'as', value: (alert) => alert.source?.as_name },
  { header: 'machine', value: (alert) => alert.machine_alias ?? alert.machine_id },
  { header: 'target', value: (alert) => alert.target },
  { header: 'events_count', value: (alert) => alert.events_count },
  { header: 'decisions', value: (alert) => alert.decisions?.length ?? 0 },
  { header: 'simulated', value: (alert) => alert.simulated === true },
  { header: 'message', value: (alert) => alert.message },
];

export const DECISION_CSV_COLUMNS: CsvColumn<DecisionListItem>[] = [
  { header: 'id', value: (decision) => decision.id },
  { header: 'instance', value: (decision) => decision.instance_name ?? decision.instance_id },
  { header: 'created_at', value: (decision) => decision.created_at },
  { header: 'value', value: (decision) => decision.value },
  { header: 'type', value: (decision) => decision.detail.type ?? decision.detail.action },
  { header: 'scenario', value: (decision) => decision.scenario },
  { header: 'origin', value: (decision) => decision.detail.origin },
  { header: 'country', value: (decision) => decision.detail.country },
  { header: 'as', value: (decision) => decision.detail.as },
  { header: 'machine', value: (decision) => decision.machine_alias ?? decision.machine ?? decision.machine_id },
  { header: 'duration', value: (decision) => decision.detail.duration },
  { header: 'expiration', value: (decision) => decision.detail.expiration },
  { header: 'expired', value: (decision) => decision.expired },
  { header: 'simulated', value: (decision) => decision.simulated === true },
  { header: 'reason', value: (decision) => decision.detail.reason },
];

export const AUDIT_CSV_COLUMNS: CsvColumn<{ time: string; user: string; role: string | null; action: string; outcome: string; target: string | null; details: Record<string, unknown> }>[] = [
  { header: 'time', value: (event) => event.time },
  { header: 'user', value: (event) => event.user },
  { header: 'role', value: (event) => event.role },
  { header: 'action', value: (event) => event.action },
  { header: 'target', value: (event) => event.target },
  { header: 'outcome', value: (event) => event.outcome },
  { header: 'details', value: (event) => JSON.stringify(event.details) },
];
