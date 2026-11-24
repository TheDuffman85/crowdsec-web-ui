import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { PdfDocument, truncateToWidth } from '../../app/pdf-writer';
import {
  buildReportData,
  generateMonthlyReportIfDue,
  monthPeriod,
  previousMonth,
  renderReportPdf,
  rollingPeriod,
} from '../../app/report';
import { createController, sampleAlert, seedAlert } from './harness';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();
const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

let nextId = 1200;
function seed(database: Parameters<typeof seedAlert>[0], daysAgo: number, ip: string, extra: { cn?: string; scenario?: string; machine?: string } = {}) {
  const id = nextId++;
  seedAlert(database, sampleAlert({
    id, uuid: `rep-${id}`, created_at: iso(daysAgo), scenario: extra.scenario ?? 'crowdsecurity/ssh-bf',
    machine_alias: extra.machine ?? 'web-1', source: { ip, value: ip, cn: extra.cn ?? 'DE' },
    decisions: [{ id: id * 10, type: 'ban', value: ip, duration: '4h', created_at: iso(daysAgo), stop_at: new Date(NOW + 3_600_000).toISOString(), origin: 'crowdsec', simulated: false }],
  }));
}

/** Checks the cross-reference table so a broken offset is caught without a PDF reader. */
function verifyStructure(pdf: Buffer): { text: string; pages: number } {
  const text = pdf.toString('latin1');
  expect(text.startsWith('%PDF-1.4')).toBe(true);
  expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1]);
  expect(text.slice(startxref, startxref + 4)).toBe('xref');
  const entries = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)];
  expect(entries.length).toBeGreaterThan(4);
  entries.forEach((entry, index) => {
    expect(text.slice(Number(entry[1]), Number(entry[1]) + `${index + 1} 0 obj`.length)).toBe(`${index + 1} 0 obj`);
  });
  for (const stream of text.matchAll(/\/Length (\d+) >>\nstream\n/g)) {
    const start = stream.index! + stream[0].length;
    expect(text.slice(start + Number(stream[1]), start + Number(stream[1]) + 10)).toBe('\nendstream');
  }
  return { text, pages: Number(/\/Count (\d+)/.exec(text)![1]) };
}

describe('periods', () => {
  test('builds rolling and calendar periods', () => {
    expect(rollingPeriod(7, NOW)).toEqual({ from: iso(7), to: iso(0), label: 'Last 7 days' });
    expect(rollingPeriod(0, NOW).label).toBe('Last 1 day');
    expect(rollingPeriod(9999, NOW).label).toBe('Last 366 days');
    expect(monthPeriod('2026-10')).toEqual({ from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z', label: 'October 2026' });
    expect(monthPeriod('2026-12')!.to).toBe('2027-01-01T00:00:00.000Z');
    expect(monthPeriod('2026-13')).toBeNull();
    expect(monthPeriod('nope')).toBeNull();
    expect(previousMonth(NOW)).toBe('2026-10');
    expect(previousMonth(Date.parse('2027-01-05T00:00:00Z'))).toBe('2026-12');
  });
});

describe('report data', () => {
  test('summarises alerts, sources and decisions inside the period only', () => {
    const { controller } = createController();
    const { database } = controller;
    seed(database, 1, '203.0.113.1', { cn: 'CN' });
    seed(database, 2, '203.0.113.1', { cn: 'CN', scenario: 'crowdsecurity/http-probing', machine: 'web-2' });
    seed(database, 3, '203.0.113.2');
    seed(database, 40, '203.0.113.3'); // before the period
    const data = buildReportData(database, rollingPeriod(7, NOW), NOW);
    expect(data).toMatchObject({ total_alerts: 3, unique_sources: 2, decisions_created: 3, active_decisions: 4 });
    expect(data.daily).toHaveLength(8);
    expect(data.daily.reduce((sum, day) => sum + day.count, 0)).toBe(3);
    expect(data.top_countries).toEqual([{ name: 'CN', count: 2 }, { name: 'DE', count: 1 }]);
    expect(data.top_sources[0]).toEqual({ name: '203.0.113.1', count: 2 });
    expect(data.top_scenarios[0]).toEqual({ name: 'crowdsecurity/ssh-bf', count: 2 });
    expect(data.top_machines).toEqual([{ name: 'web-1', count: 2 }, { name: 'web-2', count: 1 }]);
  });
});

describe('pdf output', () => {
  test('renders a structurally valid PDF with the headline numbers', () => {
    const { controller } = createController();
    seed(controller.database, 1, '203.0.113.1', { scenario: 'crowdsecurity/(odd) \\ scenario' });
    const pdf = renderReportPdf(buildReportData(controller.database, rollingPeriod(30, NOW), NOW), { appName: 'Home Lab' });
    const { text, pages } = verifyStructure(pdf);
    expect(pages).toBe(1);
    expect(text).toContain('(Security report)');
    expect(text).toContain('Home Lab security report');
    expect(text).toContain('crowdsecurity/\\(odd\\) \\\\ scenario');
    expect(text).toContain('203.0.113.1');
  });

  test('flows long content onto further pages and keeps non-Latin text printable', () => {
    const pdf = new PdfDocument('footer');
    pdf.title('Many rows', 'subtitle');
    pdf.table(['#', 'Name', 'Count'], Array.from({ length: 120 }, (_, index) => [String(index), `Row ${index} Zürich – «naïve» 日本`, String(index * 3)]));
    pdf.paragraph('word '.repeat(400));
    const { text, pages } = verifyStructure(pdf.toBuffer());
    expect(pages).toBeGreaterThan(2);
    expect(pdf.pageCount).toBe(pages);
    expect(text).toContain('Page 2 of');
    expect(text).toContain('Z\xfcrich - \xabna\xefve\xbb ??');
  });

  test('truncates cells that do not fit', () => {
    expect(truncateToWidth('short', 200, 9)).toBe('short');
    const shortened = truncateToWidth('a very long scenario name that cannot possibly fit in the column', 80, 9);
    expect(shortened.endsWith('...')).toBe(true);
    expect(shortened.length).toBeLessThan(40);
  });
});

describe('monthly report', () => {
  test('writes last month once and leaves existing files alone', () => {
    const { controller } = createController();
    seed(controller.database, 25, '203.0.113.9'); // 2026-10-26
    const directory = path.join(mkdtempSync(path.join(tmpdir(), 'report-')), 'reports');
    tempDirs.push(path.dirname(directory));

    const written = generateMonthlyReportIfDue({ database: controller.database, directory, now: NOW });
    expect(written).toBe(path.join(directory, 'security-report-2026-10.pdf'));
    expect(readdirSync(directory)).toEqual(['security-report-2026-10.pdf']);
    const { text } = verifyStructure(readFileSync(written!));
    expect(text).toContain('October 2026');
    expect(text).toContain('203.0.113.9');
    expect(generateMonthlyReportIfDue({ database: controller.database, directory, now: NOW })).toBeNull();
    expect(generateMonthlyReportIfDue({ database: controller.database, directory, now: Date.parse('2026-12-02T00:00:00Z') })).toBe(path.join(directory, 'security-report-2026-11.pdf'));
  });
});

describe('report API', () => {
  const get = async (controller: ReturnType<typeof createController>['controller'], pathAndQuery: string): Promise<Response> =>
    await controller.fetch(new Request(`http://localhost/crowdsec/api/${pathAndQuery}`));

  test('downloads a PDF and previews JSON', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'false' } });
    seed(controller.database, 1, '203.0.113.1');
    const pdf = await get(controller, 'report.pdf?days=14');
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.headers.get('content-disposition')).toMatch(/^attachment; filename="security-report-\d{4}-\d{2}-\d{2}\.pdf"$/);
    verifyStructure(Buffer.from(await pdf.arrayBuffer()));

    const month = await get(controller, 'report.pdf?month=2026-10');
    expect(month.headers.get('content-disposition')).toContain('security-report-2026-10.pdf');
    const json = await get(controller, 'report?days=14').then((response) => response.json()) as { total_alerts: number };
    expect(json.total_alerts).toBe(1);
    expect((await get(controller, 'report?month=2026-99')).status).toBe(400);
    expect((await get(controller, 'report.pdf?days=abc')).status).toBe(400);
  });

  test('requires authentication when enabled', async () => {
    const { controller } = createController({ env: { AUTH_ENABLED: 'true' } });
    expect((await get(controller, 'report.pdf')).status).toBe(401);
  });
});
