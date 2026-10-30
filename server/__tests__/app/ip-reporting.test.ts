import { describe, expect, test, vi } from 'vitest';
import type { AlertRecord, IpReporter, IpReportPreview, IpReportRun } from '../../../shared/contracts';
import { createNotificationSecretStore } from '../../notifications/secret-store';
import { createIpReportingService } from '../../ip-reporting/service';
import { createController, destroyTempDir, sampleAlert, seedAlert } from './harness';

const API = 'http://localhost/crowdsec/api/ip-reporters';
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function detection(id: number, ip: string, scenario: string, overrides: Partial<AlertRecord> = {}): AlertRecord {
  return sampleAlert({
    id,
    uuid: `alert-${id}`,
    created_at: minutesAgo(5),
    scenario,
    source: { ip, value: ip, scope: 'Ip' },
    decisions: [{ id: id * 10, type: 'ban', value: ip, duration: '4h', origin: 'crowdsec', simulated: false }],
    ...overrides,
  });
}

function seedDetections(database: Parameters<typeof seedAlert>[0]): void {
  seedAlert(database, detection(1, '203.0.113.10', 'crowdsecurity/ssh-bf'));
  seedAlert(database, detection(2, '203.0.113.10', 'crowdsecurity/ssh-slow-bf'));
  seedAlert(database, detection(3, '198.51.100.5', 'crowdsecurity/http-sqli-probbing-detection'));
  seedAlert(database, detection(4, '192.168.1.10', 'crowdsecurity/ssh-bf'));
  seedAlert(database, detection(5, '198.51.100.44', 'crowdsecurity/ssh-bf', {
    decisions: [{ id: 50, type: 'ban', value: '198.51.100.44', duration: '4h', origin: 'CAPI', simulated: false }],
  }));
  seedAlert(database, detection(6, '203.0.113.77', 'manual/web-ui', {
    decisions: [{ id: 60, type: 'ban', value: '203.0.113.77', duration: '4h', origin: 'cscli', simulated: false }],
  }));
  seedAlert(database, detection(7, '192.0.2.64', 'crowdsecurity/ssh-bf', { simulated: true }));
}

async function createReporter(
  controller: ReturnType<typeof createController>['controller'],
  config: Record<string, unknown> = {},
): Promise<IpReporter> {
  const response = await controller.fetch(new Request(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'AbuseIPDB',
      provider: 'abuseipdb',
      enabled: true,
      config: { apiKey: 'abuse-secret-key', ...config },
    }),
  }));
  expect(response.status).toBe(201);
  return await response.json() as IpReporter;
}

describe('IP reporting', () => {
  test('stores the API key encrypted and keeps it when the masked value is sent back', async () => {
    const { controller, database } = createController();
    try {
      const reporter = await createReporter(controller);
      expect(reporter.config.apiKey).toBe('(stored)');
      expect(reporter.configured_secrets).toEqual(['apiKey']);
      const stored = database.getIpReporterById(reporter.id);
      expect(stored?.config_json.startsWith('enc:v1:')).toBe(true);
      expect(stored?.config_json).not.toContain('abuse-secret-key');

      const update = await controller.fetch(new Request(`${API}/${reporter.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...reporter, config: { ...reporter.config, cooldownHours: 48 } }),
      }));
      expect(update.status).toBe(200);
      expect((await update.json() as IpReporter).config).toMatchObject({ apiKey: '(stored)', cooldownHours: 48 });
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('rejects unknown comment variables and a missing API key', async () => {
    const { controller, database } = createController();
    try {
      const badTemplate = await controller.fetch(new Request(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'x', provider: 'abuseipdb', enabled: true, config: { apiKey: 'k', commentTemplate: 'Seen {{hostname}}' } }),
      }));
      expect(badTemplate.status).toBe(400);
      expect(await badTemplate.json()).toEqual({ error: 'Unknown comment variable: {{hostname}}' });

      const missingKey = await controller.fetch(new Request(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'x', provider: 'abuseipdb', enabled: true, config: {} }),
      }));
      expect(missingKey.status).toBe(400);
      expect(await missingKey.json()).toEqual({ error: 'AbuseIPDB API key is required' });
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('previews only public IPs from local CrowdSec detections with mapped categories', async () => {
    const { controller, database } = createController();
    try {
      seedDetections(database);
      const response = await controller.fetch(new Request(`${API}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'draft', provider: 'abuseipdb', enabled: true, config: {} }),
      }));
      expect(response.status).toBe(200);
      const preview = await response.json() as IpReportPreview;

      expect(preview.total).toBe(2);
      expect(preview.rows.map((row) => row.ip)).toEqual(['203.0.113.10', '198.51.100.5']);
      expect(preview.rows[0]).toMatchObject({
        alerts: 2,
        categories: [18, 22],
        scenarios: ['crowdsecurity/ssh-bf', 'crowdsecurity/ssh-slow-bf'],
      });
      expect(preview.rows[0].comment).toContain('CrowdSec detected crowdsecurity/ssh-bf, crowdsecurity/ssh-slow-bf (2 alerts');
      expect(preview.rows[1].categories).toEqual([16, 21]);
      expect(preview.skipped).toMatchObject({ not_public: 1, cooldown: 0 });
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('sends one bulk CSV, records rejected rows, and skips reported IPs during the cooldown', async () => {
    const requests: Array<{ url: string; headers: Headers; csv: string }> = [];
    const { controller, database } = createController({
      ipReportFetchResolver: async (url, init) => {
        const form = init?.body as FormData;
        requests.push({ url, headers: new Headers(init?.headers), csv: await (form.get('csv') as Blob).text() });
        return Response.json({
          data: { savedReports: 1, invalidReports: [{ error: 'Duplicate IP', input: '198.51.100.5', rowNumber: 3 }] },
        });
      },
    });
    try {
      seedDetections(database);
      const reporter = await createReporter(controller, { excludeScenarios: ['*slow*'] });

      const runResponse = await controller.fetch(new Request(`${API}/${reporter.id}/run`, { method: 'POST' }));
      expect(runResponse.status).toBe(200);
      const run = await runResponse.json() as IpReportRun;
      expect(run).toMatchObject({
        status: 'partial',
        trigger: 'manual',
        candidates: 2,
        submitted: 2,
        saved: 1,
        rejected: [{ ip: '198.51.100.5', error: 'Duplicate IP' }],
      });

      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe('https://api.abuseipdb.com/api/v2/bulk-report');
      expect(requests[0].headers.get('Key')).toBe('abuse-secret-key');
      const lines = requests[0].csv.trim().split('\n');
      expect(lines[0]).toBe('IP,Categories,ReportDate,Comment');
      expect(lines).toHaveLength(3);
      expect(lines.find((line) => line.startsWith('203.0.113.10,'))).toMatch(/^203\.0\.113\.10,"18,22",\d{4}-\d{2}-\d{2}T[^,]+,"CrowdSec detected crowdsecurity\/ssh-bf \(1 alerts, last seen /);

      seedAlert(database, detection(8, '203.0.113.10', 'crowdsecurity/ssh-bf', { created_at: minutesAgo(1) }));
      const preview = await controller.fetch(new Request(`${API}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: reporter.id, name: 'AbuseIPDB', provider: 'abuseipdb', enabled: true, config: reporter.config }),
      }));
      const next = await preview.json() as IpReportPreview;
      expect(next.rows.map((row) => row.ip)).toEqual(['198.51.100.5']);
      expect(next.skipped.cooldown).toBe(1);

      const runs = await controller.fetch(new Request(`${API}/${reporter.id}/runs`));
      expect((await runs.json() as { runs: IpReportRun[] }).runs).toHaveLength(1);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('reports alerts that reach the database after a later run, but only once', async () => {
    const csvs: string[] = [];
    const { controller, database } = createController({
      ipReportFetchResolver: async (_url, init) => {
        csvs.push(await ((init?.body as FormData).get('csv') as Blob).text());
        return Response.json({ data: { savedReports: 1, invalidReports: [] } });
      },
    });
    const run = async (id: string) => await (await controller.fetch(new Request(`${API}/${id}/run`, { method: 'POST' }))).json() as IpReportRun;
    try {
      const reporter = await createReporter(controller);
      expect((await run(reporter.id)).status).toBe('empty');

      seedAlert(database, detection(9, '203.0.113.10', 'crowdsecurity/ssh-bf', { created_at: minutesAgo(90) }));
      expect(await run(reporter.id)).toMatchObject({ status: 'success', saved: 1 });
      expect(csvs).toHaveLength(1);
      expect(csvs[0]).toContain('\n203.0.113.10,');

      expect((await run(reporter.id)).status).toBe('empty');
      expect(csvs).toHaveLength(1);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('single reports stop at the daily limit and leave the rest for the next run', async () => {
    const reported: string[] = [];
    const { controller, database } = createController({
      ipReportFetchResolver: (_url, init) => {
        const ip = new URLSearchParams(String(init?.body)).get('ip') || '';
        if (reported.length > 0) {
          return Response.json(
            { errors: [{ detail: 'Daily rate limit of 1000 requests exceeded for this endpoint.', status: 429 }] },
            { status: 429, headers: { 'X-RateLimit-Remaining': '0' } },
          );
        }
        reported.push(ip);
        return Response.json({ data: { ipAddress: ip, abuseConfidenceScore: 100 } });
      },
    });
    try {
      seedDetections(database);
      const reporter = await createReporter(controller, { submitMode: 'single' });

      const run = await (await controller.fetch(new Request(`${API}/${reporter.id}/run`, { method: 'POST' }))).json() as IpReportRun;
      expect(run).toMatchObject({ status: 'partial', candidates: 2, submitted: 1, saved: 1 });
      expect(run.error).toContain('Daily rate limit');
      expect(reported).toEqual(['203.0.113.10']);
      expect(database.getIpReporterById(reporter.id)?.last_success_at).toBeNull();
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });

  test('runs enabled reporters only when their interval has elapsed', async () => {
    const { controller, database } = createController();
    const urls: string[] = [];
    const onReportersChanged = vi.fn();
    const service = createIpReportingService({
      database,
      secretStore: createNotificationSecretStore('test-key'),
      instances: [{ id: 'default', name: 'Default' }],
      fetchImpl: async (input) => {
        urls.push(String(input));
        return Response.json({ data: { savedReports: 1, invalidReports: [] } });
      },
      onReportersChanged,
    });
    try {
      seedDetections(database);
      const disabled = await service.createReporter({ name: 'Disabled', provider: 'abuseipdb', enabled: false, config: { apiKey: 'k' } });
      expect(service.hasEnabledReporters()).toBe(false);
      const reporter = await service.createReporter({
        name: 'Scheduled',
        provider: 'abuseipdb',
        enabled: true,
        config: { apiKey: 'k', intervalMinutes: 60 },
      });
      expect(service.hasEnabledReporters()).toBe(true);
      expect(onReportersChanged).toHaveBeenCalledTimes(2);

      const now = new Date();
      await service.runDueReporters(now);
      expect(urls).toHaveLength(1);
      await service.runDueReporters(new Date(now.getTime() + 30 * 60_000));
      expect(urls).toHaveLength(1);
      await service.runDueReporters(new Date(now.getTime() + 61 * 60_000));
      expect(service.listRuns(reporter.id).map((run) => run.trigger)).toEqual(['schedule', 'schedule']);
      expect(service.listRuns(disabled.id)).toEqual([]);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      destroyTempDir();
    }
  });
});
