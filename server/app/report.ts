import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import type { DashboardAuth } from '../app-auth';
import type { CrowdsecDatabase } from '../database';
import { findRepeatOffenders } from './repeat-offenders';
import { PdfDocument } from './pdf-writer';

const DAY_MS = 86_400_000;
const MAX_DAYS = 366;
const TOP = 10;

export interface ReportPeriod {
  from: string;
  to: string;
  label: string;
}

export interface ReportData {
  period: ReportPeriod;
  generated_at: string;
  total_alerts: number;
  unique_sources: number;
  decisions_created: number;
  active_decisions: number;
  repeat_offenders: number;
  daily: Array<{ date: string; count: number }>;
  top_scenarios: Array<{ name: string; count: number }>;
  top_countries: Array<{ name: string; count: number }>;
  top_sources: Array<{ name: string; count: number }>;
  top_machines: Array<{ name: string; count: number }>;
}

/** The last `days` days up to now. */
export function rollingPeriod(days: number, now = Date.now()): ReportPeriod {
  const span = Math.min(Math.max(Math.floor(days), 1), MAX_DAYS);
  return {
    from: new Date(now - span * DAY_MS).toISOString(),
    to: new Date(now).toISOString(),
    label: `Last ${span} day${span === 1 ? '' : 's'}`,
  };
}

/** A whole UTC calendar month, `month` as `YYYY-MM`; null when it is not a valid month. */
export function monthPeriod(month: string): ReportPeriod | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  return {
    from: new Date(Date.UTC(year, index, 1)).toISOString(),
    to: new Date(Date.UTC(year, index + 1, 1)).toISOString(),
    label: new Date(Date.UTC(year, index, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  };
}

export function previousMonth(now = Date.now()): string {
  const date = new Date(now);
  const previous = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`;
}

function top(database: CrowdsecDatabase, column: string, period: ReportPeriod): Array<{ name: string; count: number }> {
  return database.db.query(`
    SELECT ${column} AS name, COUNT(*) AS count FROM alerts
    WHERE simulated = 0 AND created_at >= ? AND created_at < ? AND ${column} IS NOT NULL AND ${column} <> ''
    GROUP BY ${column} ORDER BY count DESC, name LIMIT ${TOP}
  `).all(period.from, period.to) as Array<{ name: string; count: number }>;
}

export function buildReportData(database: CrowdsecDatabase, period: ReportPeriod, now = Date.now()): ReportData {
  const one = (sql: string, ...params: string[]) => (database.db.query(sql).get(...params) as { count: number }).count;
  const days = new Map((database.db.query(`
    SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count FROM alerts
    WHERE simulated = 0 AND created_at >= ? AND created_at < ? GROUP BY day
  `).all(period.from, period.to) as Array<{ day: string; count: number }>).map((row) => [row.day, row.count]));
  const daily: ReportData['daily'] = [];
  const end = Date.parse(period.to);
  const firstDay = new Date(period.from);
  firstDay.setUTCHours(0, 0, 0, 0);
  for (let cursor = firstDay.getTime(); cursor < end && daily.length <= MAX_DAYS; cursor += DAY_MS) {
    const date = new Date(cursor).toISOString().slice(0, 10);
    daily.push({ date, count: days.get(date) ?? 0 });
  }
  return {
    period,
    generated_at: new Date(now).toISOString(),
    total_alerts: one('SELECT COUNT(*) AS count FROM alerts WHERE simulated = 0 AND created_at >= ? AND created_at < ?', period.from, period.to),
    unique_sources: one(`SELECT COUNT(DISTINCT source_ip) AS count FROM alerts WHERE simulated = 0 AND created_at >= ? AND created_at < ? AND source_ip <> ''`, period.from, period.to),
    decisions_created: one(`SELECT COUNT(*) AS count FROM decisions WHERE simulated = 0 AND created_at >= ? AND created_at < ?`, period.from, period.to),
    active_decisions: one('SELECT COUNT(*) AS count FROM decisions WHERE simulated = 0 AND stop_at > ?', new Date(now).toISOString()),
    repeat_offenders: findRepeatOffenders(database, { limit: 200, now }).length,
    daily,
    top_scenarios: top(database, 'scenario', period),
    top_countries: top(database, 'country', period),
    top_sources: top(database, 'source_ip', period),
    top_machines: top(database, 'machine', period),
  };
}

export function renderReportPdf(data: ReportData, options: { appName?: string } = {}): Buffer {
  const appName = options.appName || 'CrowdSec Web UI';
  const pdf = new PdfDocument(`${appName} security report - generated ${data.generated_at.slice(0, 16).replace('T', ' ')} UTC`);
  pdf.title('Security report', `${data.period.label} (${data.period.from.slice(0, 10)} to ${data.period.to.slice(0, 10)}, UTC)`);
  pdf.keyFigures([
    { label: 'Alerts', value: data.total_alerts.toLocaleString('en-GB') },
    { label: 'Unique sources', value: data.unique_sources.toLocaleString('en-GB') },
    { label: 'Decisions created', value: data.decisions_created.toLocaleString('en-GB') },
    { label: 'Active decisions now', value: data.active_decisions.toLocaleString('en-GB') },
  ]);
  pdf.paragraph(`${data.repeat_offenders} address${data.repeat_offenders === 1 ? ' was' : 'es were'} banned more than once in the retained history.`);

  pdf.heading('Alerts per day');
  pdf.barChart(data.daily.map((entry) => ({ label: entry.date, value: entry.count })));

  const width = pdf.contentWidth;
  const ranked = (items: Array<{ name: string; count: number }>) => items.map((item, index) => [String(index + 1), item.name, item.count.toLocaleString('en-GB')]);
  const columns = [28, width - 28 - 80, 80];
  pdf.heading('Top scenarios');
  pdf.table(['#', 'Scenario', 'Alerts'], ranked(data.top_scenarios), columns);
  pdf.heading('Top source countries');
  pdf.table(['#', 'Country', 'Alerts'], ranked(data.top_countries), columns);
  pdf.heading('Top source addresses');
  pdf.table(['#', 'Address', 'Alerts'], ranked(data.top_sources), columns);
  if (data.top_machines.length > 0) {
    pdf.heading('Busiest detection hosts');
    pdf.table(['#', 'Host', 'Alerts'], ranked(data.top_machines), columns);
  }
  return pdf.toBuffer();
}

export function reportFilename(period: ReportPeriod, monthKey?: string): string {
  return monthKey ? `security-report-${monthKey}.pdf` : `security-report-${period.to.slice(0, 10)}.pdf`;
}

/** Writes last month's report to `directory` unless it already exists; returns the file path when one was written. */
export function generateMonthlyReportIfDue(options: {
  database: CrowdsecDatabase;
  directory: string;
  appName?: string;
  now?: number;
}): string | null {
  const now = options.now ?? Date.now();
  const month = previousMonth(now);
  const period = monthPeriod(month)!;
  const target = path.join(options.directory, reportFilename(period, month));
  if (existsSync(target)) return null;
  mkdirSync(options.directory, { recursive: true });
  writeFileSync(target, renderReportPdf(buildReportData(options.database, period, now), { appName: options.appName }));
  return target;
}

/** Hourly check that writes last month's report to disk. It never sends anything anywhere. */
export function startMonthlyReportSchedule(options: {
  database: CrowdsecDatabase;
  directory: string;
  appName?: string;
}): () => void {
  const run = () => {
    try {
      const written = generateMonthlyReportIfDue(options);
      if (written) console.log(`[report] Wrote monthly security report to ${written}`);
    } catch (error) {
      console.error('[report] Could not write the monthly security report:', error instanceof Error ? error.message : error);
    }
  };
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, 3_600_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

export function registerReportRoutes(options: {
  app: Hono;
  basePath: string;
  database: CrowdsecDatabase;
  auth: DashboardAuth;
  appName: () => string | undefined;
}): void {
  const { app, basePath, database, auth, appName } = options;
  const resolvePeriod = (query: (name: string) => string | undefined): ReportPeriod | null => {
    const month = query('month');
    if (month) return monthPeriod(month);
    const days = Number.parseInt(query('days') ?? '30', 10);
    return Number.isFinite(days) && days > 0 ? rollingPeriod(days) : null;
  };

  app.get(`${basePath}/api/report`, auth.ensureAuth, (context) => {
    const period = resolvePeriod((name) => context.req.query(name));
    if (!period) return context.json({ error: 'Use days=1..366 or month=YYYY-MM' }, 400);
    return context.json(buildReportData(database, period));
  });

  app.get(`${basePath}/api/report.pdf`, auth.ensureAuth, (context) => {
    const period = resolvePeriod((name) => context.req.query(name));
    if (!period) return context.json({ error: 'Use days=1..366 or month=YYYY-MM' }, 400);
    const pdf = renderReportPdf(buildReportData(database, period), { appName: appName() });
    const month = context.req.query('month');
    return new Response(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${reportFilename(period, month || undefined)}"`,
        'Cache-Control': 'no-store',
      },
    });
  });
}
