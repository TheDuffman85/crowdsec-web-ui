// Isolated A/B benchmark: never opens the application's configured data folder.
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { createApp } from '../server/app';
import { createRuntimeConfig } from '../server/config';
import { CrowdsecDatabase } from '../server/database';
import { LapiClient } from '../server/lapi';
import type { AlertRecord } from '../shared/contracts';

const count = Number(process.env.STATISTICS_BENCHMARK_RECORDS || 10_000);
const runs = Number(process.env.STATISTICS_BENCHMARK_RUNS || 5);
const samples = Number(process.env.STATISTICS_BENCHMARK_SAMPLES || 30);
const quiet = console.log;
console.log = () => {};
console.warn = () => {};
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
const root = mkdtempSync(path.join(tmpdir(), 'crowdsec-statistics-benchmark-'));
const paths = ['/api/alerts?paginated=true&page_size=50&include_decisions=false', '/api/decisions?paginated=true&page_size=50', '/api/alerts?paginated=true&page_size=50&q=scenario%3Assh', '/api/dashboard/stats'];
const results: Array<{ profile: string; enabled: boolean; insertMs: number; reads: Record<string, number>; statisticsMs: number | null; cacheBytes: number; statisticsBytes: number; backlog: number }> = [];
try {
  for (const profile of ['repeated', 'high-cardinality']) {
    for (let run = 0; run < runs; run++) {
      for (const enabled of run % 2 ? [true, false] : [false, true]) {
        const dir = path.join(root, `${profile}-${run}-${enabled}`);
        const config = createRuntimeConfig({ CONFIG_STORAGE_DATA_DIR: dir, CONFIG_AUTH_ENABLED: 'false', CONFIG_CROWDSEC_SYNC_REFRESH_INTERVAL: '0', CONFIG_CROWDSEC_SYNC_HEARTBEAT_INTERVAL: '0', CONFIG_STATISTICS_ENABLED: String(enabled), CONFIG_CROWDSEC_SYNC_LOOKBACK: '90d' }, { defaultConfigFile: path.join(dir, 'config.yaml') });
        const database = new CrowdsecDatabase({ dataDir: dir });
        const lapiClient = new LapiClient({ crowdsecUrl: 'http://benchmark.invalid', auth: { mode: 'password', username: 'benchmark', password: 'benchmark' }, lookbackPeriod: '90d', version: 'benchmark', fetchImpl: async () => Response.json({ code: 200, token: 'benchmark' }) });
        const controller = createApp({ config, database, lapiClient, initialCacheState: { isInitialized: true, isComplete: true } });
        try {
          // Measure recurring background work after one-time worker/schema startup.
          if (enabled) await controller.statistics.run();
          const now = Date.now();
          const insert = database.transaction((offset: number) => {
            for (let i = offset; i < Math.min(count, offset + 100); i++) {
              const ipIndex = profile === 'repeated' ? i % 50 : i;
              const ip = `198.${Math.floor(ipIndex / 65536) % 256}.${Math.floor(ipIndex / 256) % 256}.${ipIndex % 256}`;
              const at = new Date(now - i % 30 * 86_400_000).toISOString();
              const record: AlertRecord = { id: i + 1, uuid: `benchmark-${i}`, created_at: at, scenario: i % 2 ? 'ssh' : 'http', source: { ip, cn: 'DE', as_number: 42, as_name: 'Example network' }, machine_id: `machine-${i % 10}`, machine_alias: `Machine ${i % 10}`, events_count: 10, message: 'Example attack details that must never be retained in long-term statistics', events: [{ meta: [{ key: 'request', value: 'GET /login HTTP/1.1' }] }] };
              database.insertAlert({ $id: i + 1, $uuid: record.uuid!, $created_at: at, $message: record.message!, $record: record });
              database.insertDecision({ $id: String(i + 1), $uuid: String(i + 1), $alert_id: i + 1, $created_at: at, $stop_at: new Date(now + 86_400_000).toISOString(), $record: { id: i + 1, type: 'ban', origin: 'crowdsec', value: ip }, $value: ip, $type: 'ban', $origin: 'crowdsec' });
            }
          });
          const began = performance.now();
          for (let offset = 0; offset < count; offset += 100) insert(offset);
          const insertMs = performance.now() - began;
          const read = async (url: string) => {
            const response = await controller.fetch(new Request(`http://localhost${url}`));
            if (!response.ok) throw new Error(`Benchmark request failed: ${url} (${response.status})`);
            await response.arrayBuffer();
          };
          for (let warm = 0; warm < 4; warm++) for (const url of paths) await read(url);
          if (enabled) await read('/api/statistics');
          const job = enabled ? controller.statistics.run() : Promise.resolve();
          const times = Object.fromEntries(paths.map((url) => [url, [] as number[]]));
          let historicalRead: Promise<void> | null = null;
          const historicalReads: Promise<void>[] = [];
          for (let sample = 0; sample < samples; sample++) {
            if (enabled && sample % 5 === 0 && !historicalRead) {
              historicalRead = read('/api/statistics').finally(() => { historicalRead = null; });
              historicalReads.push(historicalRead);
            }
            for (const url of paths) { const start = performance.now(); await read(url); times[url].push(performance.now() - start); }
          }
          await Promise.all([job, ...historicalReads]);
          if (controller.statistics.configuration().status.error) throw new Error(controller.statistics.configuration().status.error!);
          let statisticsMs: number | null = null;
          if (enabled) {
            const timing = performance.now(); await read('/api/statistics?limit=50'); statisticsMs = performance.now() - timing;
          }
          for (const file of ['cache.db', ...(enabled ? ['statistics.db'] : [])]) {
            const connection = new Database(path.join(dir, file)); connection.pragma('wal_checkpoint(TRUNCATE)'); connection.close();
          }
          const size = (file: string) => existsSync(path.join(dir, file)) ? statSync(path.join(dir, file)).size : 0;
          console.error(`Statistics benchmark: ${profile}, run ${run + 1}/${runs}, collection ${enabled ? 'on' : 'off'}`);
          results.push({ profile, enabled, insertMs, reads: Object.fromEntries(paths.map((url) => [url, percentile(times[url], 0.95)])), statisticsMs, cacheBytes: size('cache.db'), statisticsBytes: size('statistics.db'), backlog: controller.statistics.configuration().status.backlog });
        } finally { controller.stopBackgroundTasks(); database.close(); }
      }
    }
  }
  const summary = ['repeated', 'high-cardinality'].map((profile) => {
    const median = (enabled: boolean, field: (row: typeof results[number]) => number) => percentile(results.filter((r) => r.profile === profile && r.enabled === enabled).map(field), 0.5);
    const overhead = (field: (row: typeof results[number]) => number) => (median(true, field) / median(false, field) - 1) * 100;
    return { profile, records: count, runs, captureMedianMs: { disabled: median(false, (r) => r.insertMs), enabled: median(true, (r) => r.insertMs) }, foregroundP95Ms: Object.fromEntries(paths.map((url) => [url, { disabled: median(false, (r) => r.reads[url]), enabled: median(true, (r) => r.reads[url]) }])), captureOverheadPercent: overhead((r) => r.insertMs), foregroundP95ChangePercent: Object.fromEntries(paths.map((url) => [url, overhead((r) => r.reads[url])])), statisticsQueryMedianMs: median(true, (r) => r.statisticsMs!), statisticsBytes: median(true, (r) => r.statisticsBytes), sourceCacheBytes: median(false, (r) => r.cacheBytes), maxRemainingBacklog: Math.max(...results.filter((r) => r.profile === profile).map((r) => r.backlog)) };
  });
  quiet(JSON.stringify({ summary, investigationGatePercent: 5, warmWorkers: true, concurrentHistoricalReads: true, results }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
