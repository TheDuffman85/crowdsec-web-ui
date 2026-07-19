import { performance } from 'node:perf_hooks';

const baseUrl = (process.env.LOADTEST_BASE_URL || 'http://127.0.0.1:3133').replace(/\/$/, '');
const samplesPerRun = Number(process.env.LOADTEST_BENCHMARK_SAMPLES || 5);
const runs = 3;

const requests = [
  ['primary alerts', '/api/alerts?paginated=true&page=1&page_size=50&instance=primary'],
  ['primary decisions', '/api/decisions?paginated=true&page=1&page_size=50&instance=primary'],
  ['primary search', '/api/alerts?paginated=true&page=1&page_size=50&instance=primary&q=scenario%3Assh'],
  ['primary dashboard', '/api/dashboard/stats?instance=primary'],
  ['Combined alerts', '/api/alerts?paginated=true&page=1&page_size=50&instance=all'],
  ['Combined decisions', '/api/decisions?paginated=true&page=1&page_size=50&instance=all'],
  ['Combined search', '/api/alerts?paginated=true&page=1&page_size=50&instance=all&q=scenario%3Assh'],
  ['Combined dashboard', '/api/dashboard/stats?instance=all'],
];

function percentile(values, percentileValue) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * percentileValue) - 1)];
}

async function timedRequest(path) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`);
  await response.arrayBuffer();
  const elapsed = performance.now() - startedAt;
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return elapsed;
}

for (const [, path] of requests) await timedRequest(path);

const measurements = new Map(requests.map(([name]) => [name, []]));
for (let run = 1; run <= runs; run += 1) {
  for (const [name, path] of requests) {
    const runSamples = [];
    for (let sample = 0; sample < samplesPerRun; sample += 1) runSamples.push(await timedRequest(path));
    measurements.get(name).push(...runSamples);
    console.log(`run ${run} | ${name} | p95 ${percentile(runSamples, 0.95).toFixed(1)} ms`);
  }
}

console.log('\nAggregate warmed results');
for (const [name, values] of measurements) {
  console.log(`${name} | p50 ${percentile(values, 0.5).toFixed(1)} ms | p95 ${percentile(values, 0.95).toFixed(1)} ms`);
}
