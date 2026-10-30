import { describe, expect, test } from 'vitest';
import { DEFAULT_IP_REPORT_CATEGORY_RULES } from '../../../shared/ip-reporting';
import { buildBulkReportCsv, submitBulkReport, truncateUtf8 } from '../../ip-reporting/abuseipdb';
import {
  normalizeIpReporterConfig,
  renderReportComment,
  resolveReportCategories,
} from '../../ip-reporting/service';

describe('AbuseIPDB report formatting', () => {
  test('quotes CSV fields that contain commas, quotes, or line breaks', () => {
    const csv = buildBulkReportCsv([
      { ip: '203.0.113.10', categories: [18, 22], reportDate: '2026-10-30T10:00:00.000Z', comment: 'said "hi", then\nleft' },
      { ip: '2001:db8::1', categories: [15], reportDate: '2026-10-30T11:00:00.000Z', comment: 'plain' },
    ]);
    expect(csv).toBe([
      'IP,Categories,ReportDate,Comment',
      '203.0.113.10,"18,22",2026-10-30T10:00:00.000Z,"said ""hi"", then\nleft"',
      '2001:db8::1,15,2026-10-30T11:00:00.000Z,plain',
      '',
    ].join('\n'));
  });

  test('keeps bulk rows pending when the response has no saved report count', async () => {
    const rows = [{ ip: '198.51.100.5', categories: [15], reportDate: '2026-10-30T10:00:00.000Z', comment: 'test' }];
    const result = await submitBulkReport('key', rows, async () => new Response('<html>maintenance</html>', { status: 200 }));
    expect(result).toEqual({ saved: [], rejected: [], unsent: ['198.51.100.5'], error: 'Unexpected AbuseIPDB response' });
  });

  test('truncates comments by UTF-8 bytes without splitting characters', () => {
    expect(truncateUtf8('가나다', 7)).toBe('가나');
    expect(Buffer.byteLength(renderReportComment('{{scenarios}}', { scenarios: 'x'.repeat(2000) }))).toBe(1024);
  });

  test('maps each scenario to the first matching rule and falls back to default categories', () => {
    const rules = [...DEFAULT_IP_REPORT_CATEGORY_RULES];
    expect(resolveReportCategories(['crowdsecurity/http-bf-wordpress_bf'], rules, [15])).toEqual([18]);
    expect(resolveReportCategories(['crowdsecurity/http-crawl-non_statics'], rules, [15])).toEqual([19]);
    expect(resolveReportCategories(['crowdsecurity/ssh-bf', 'custom/odd-one'], rules, [15])).toEqual([15, 18, 22]);
  });

  test('clamps limits to what the selected AbuseIPDB endpoint accepts', () => {
    expect(normalizeIpReporterConfig({ submitMode: 'bulk', maxReportsPerRun: 50_000, intervalMinutes: 1 })).toMatchObject({
      maxReportsPerRun: 9999,
      intervalMinutes: 15,
    });
    expect(normalizeIpReporterConfig({ submitMode: 'single', maxReportsPerRun: 50_000 }).maxReportsPerRun).toBe(1000);
  });
});
