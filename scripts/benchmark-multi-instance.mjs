import { performance } from 'node:perf_hooks';

const baseUrl = (process.env.LOADTEST_BASE_URL || 'http://127.0.0.1:3133').replace(/\/$/, '');
const scopeId = process.env.LOADTEST_BENCHMARK_INSTANCE || 'default';
const scopeName = `Scoped (${scopeId})`;
const samplesPerRun = Number(process.env.LOADTEST_BENCHMARK_SAMPLES || 5);
const runs = 3;
const warmFacetLimitMs = 500;
const coldFacetLimitMs = 2_000;

const listRequests = [
  [`${scopeName} alerts`, `/api/alerts?paginated=true&page=1&page_size=50&instance=${encodeURIComponent(scopeId)}`],
  [`${scopeName} decisions`, `/api/decisions?paginated=true&page=1&page_size=50&instance=${encodeURIComponent(scopeId)}`],
  [`${scopeName} search`, `/api/alerts?paginated=true&page=1&page_size=50&instance=${encodeURIComponent(scopeId)}&q=scenario%3Assh`],
  [`${scopeName} dashboard`, `/api/dashboard/stats?instance=${encodeURIComponent(scopeId)}`],
  ['Combined alerts', '/api/alerts?paginated=true&page=1&page_size=50&instance=all'],
  ['Combined decisions', '/api/decisions?paginated=true&page=1&page_size=50&instance=all'],
  ['Combined search', '/api/alerts?paginated=true&page=1&page_size=50&instance=all&q=scenario%3Assh'],
  ['Combined dashboard', '/api/dashboard/stats?instance=all'],
];

const facetRequests = [
  [`${scopeName} alert country facet`, `/api/alerts/facets?field=country&instance=${encodeURIComponent(scopeId)}&limit=10`],
  [`${scopeName} alert decision facet`, `/api/alerts/facets?field=decision&instance=${encodeURIComponent(scopeId)}&limit=10`],
  [`${scopeName} alert IP facet`, `/api/alerts/facets?field=ip&instance=${encodeURIComponent(scopeId)}&limit=10`],
  [`${scopeName} alert target facet`, `/api/alerts/facets?field=target&instance=${encodeURIComponent(scopeId)}&limit=10`],
  [`${scopeName} decision status facet`, `/api/decisions/facets?field=status&instance=${encodeURIComponent(scopeId)}&limit=10`],
  [`${scopeName} decision IP facet`, `/api/decisions/facets?field=ip&instance=${encodeURIComponent(scopeId)}&limit=10`],
  [`${scopeName} decision target facet`, `/api/decisions/facets?field=target&instance=${encodeURIComponent(scopeId)}&limit=10`],
  ['Combined alert country facet', '/api/alerts/facets?field=country&instance=all&limit=10'],
  ['Combined alert decision facet', '/api/alerts/facets?field=decision&instance=all&limit=10'],
  ['Combined alert IP facet', '/api/alerts/facets?field=ip&instance=all&limit=10'],
  ['Combined alert target facet', '/api/alerts/facets?field=target&instance=all&limit=10'],
  ['Combined decision status facet', '/api/decisions/facets?field=status&instance=all&limit=10'],
  ['Combined decision IP facet', '/api/decisions/facets?field=ip&instance=all&limit=10'],
  ['Combined decision target facet', '/api/decisions/facets?field=target&instance=all&limit=10'],
];

const requests = [...listRequests, ...facetRequests];

function percentile(values, percentileValue) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * percentileValue) - 1)];
}

async function timedRequest(path, facet = false) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`);
  const body = facet ? await response.json() : await response.arrayBuffer();
  const elapsed = performance.now() - startedAt;
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  if (facet && (!Array.isArray(body.values) || body.values.length > 50)) {
    throw new Error(`${path} returned an invalid or unbounded facet response`);
  }
  return elapsed;
}

const failures = [];
console.log('Cold facet results');
for (const [name, path] of facetRequests) {
  const elapsed = await timedRequest(path, true);
  console.log(`${name} | ${elapsed.toFixed(1)} ms`);
  if (elapsed > coldFacetLimitMs) {
    failures.push(`${name} cold latency ${elapsed.toFixed(1)} ms exceeds ${coldFacetLimitMs} ms`);
  }
}

for (const [, path] of listRequests) await timedRequest(path);

const measurements = new Map(requests.map(([name]) => [name, []]));
for (let run = 1; run <= runs; run += 1) {
  for (const [name, path] of requests) {
    const isFacet = name.includes(' facet');
    const runSamples = [];
    for (let sample = 0; sample < samplesPerRun; sample += 1) {
      runSamples.push(await timedRequest(path, isFacet));
    }
    measurements.get(name).push(...runSamples);
    console.log(`run ${run} | ${name} | p95 ${percentile(runSamples, 0.95).toFixed(1)} ms`);
  }
}

console.log('\nAggregate warmed results');
for (const [name, values] of measurements) {
  const p95 = percentile(values, 0.95);
  console.log(`${name} | p50 ${percentile(values, 0.5).toFixed(1)} ms | p95 ${p95.toFixed(1)} ms`);
  if (name.includes(' facet') && p95 > warmFacetLimitMs) {
    failures.push(`${name} warm p95 ${p95.toFixed(1)} ms exceeds ${warmFacetLimitMs} ms`);
  }
}

const mixedPaths = {
  list: listRequests[0][1],
  search: listRequests[2][1],
  facet: facetRequests[2][1],
};
const mixedMeasurements = { list: [], search: [], facet: [] };
for (let sample = 0; sample < runs * samplesPerRun; sample += 1) {
  const coldFacetPath = `${mixedPaths.facet}&search=${encodeURIComponent(`benchmark-${sample}`)}`;
  const [list, search, facet] = await Promise.all([
    timedRequest(mixedPaths.list),
    timedRequest(mixedPaths.search),
    timedRequest(coldFacetPath, true),
  ]);
  mixedMeasurements.list.push(list);
  mixedMeasurements.search.push(search);
  mixedMeasurements.facet.push(facet);
}

console.log('\nMixed concurrency results');
for (const [name, values] of Object.entries(mixedMeasurements)) {
  console.log(`${name} | p50 ${percentile(values, 0.5).toFixed(1)} ms | p95 ${percentile(values, 0.95).toFixed(1)} ms`);
}

for (const [mixedName, baselineName] of [
  ['list', `${scopeName} alerts`],
  ['search', `${scopeName} search`],
]) {
  const baselineP95 = percentile(measurements.get(baselineName), 0.95);
  const mixedP95 = percentile(mixedMeasurements[mixedName], 0.95);
  if (mixedP95 > baselineP95 * 1.25) {
    failures.push(`${mixedName} p95 regressed by more than 25% with one concurrent cold facet`);
  }
}

for (const [name, envName] of [
  [`${scopeName} alerts`, 'LOADTEST_ALERTS_BASELINE_P95_MS'],
  [`${scopeName} search`, 'LOADTEST_SEARCH_BASELINE_P95_MS'],
]) {
  const historicalBaseline = Number(process.env[envName]);
  if (!Number.isFinite(historicalBaseline) || historicalBaseline <= 0) continue;
  const currentP95 = percentile(measurements.get(name), 0.95);
  if (currentP95 > historicalBaseline * 1.1) {
    failures.push(`${name} p95 regressed by more than 10% from ${envName}`);
  }
}

if (failures.length > 0) {
  console.error('\nBenchmark gates failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('\nAll configured benchmark gates passed.');
}
