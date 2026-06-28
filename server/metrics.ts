import type {
  CrowdsecMetricsApiEntity,
  CrowdsecMetricsParserNode,
  CrowdsecMetricsParserSource,
  CrowdsecMetricsResponse,
  CrowdsecMetricsTiming,
  CrowdsecMetricsWhitelist,
} from '../shared/contracts';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface PrometheusSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

interface FetchCrowdsecMetricsOptions {
  url: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

interface ApiEntityAccumulator {
  name: string;
  requests: number;
  routes: Map<string, number>;
  decisionsOk: number;
  decisionsKo: number;
}

interface ParserSourceAccumulator {
  source: string;
  type: string;
  acquisTypes: Set<string>;
  linesRead: number | null;
  processed: number;
  parsedOk: number;
  parsedKo: number;
  pouredToBucket: number;
  whitelisted: number;
}

interface ParserNodeAccumulator {
  name: string;
  stage: string;
  source: string;
  type: string;
  acquisType: string | null;
  processed: number;
  parsedOk: number;
  parsedKo: number;
}

interface TimingAccumulator {
  source: string;
  type: string;
  count: number;
  sum: number;
}

interface AppsecEngineAccumulator {
  engine: string;
  source: string;
  requests: number;
  blocked: number;
}

interface WhitelistAccumulator {
  name: string;
  reason: string;
  hits: number;
  whitelisted: number;
}

const MAX_ROWS = 12;
const ACQUISITION_SOURCE_METRICS: Array<{ name: string; label: string }> = [
  { name: 'cs_appsec_reqs_total', label: 'source' },
  { name: 'cs_cloudwatch_stream_hits_total', label: 'stream' },
  { name: 'cs_dockersource_hits_total', label: 'source' },
  { name: 'cs_filesource_hits_total', label: 'source' },
  { name: 'cs_httpsource_hits_total', label: 'path' },
  { name: 'cs_journalctlsource_hits_total', label: 'source' },
  { name: 'cs_kafkasource_hits_total', label: 'topic' },
  { name: 'cs_kinesis_stream_hits_total', label: 'stream' },
  { name: 'cs_k8sauditsource_hits_total', label: 'source' },
  { name: 'cs_lokisource_hits_total', label: 'source' },
  { name: 'cs_s3_hits_total', label: 'bucket' },
  { name: 'cs_syslogsource_hits_total', label: 'source' },
  { name: 'cs_victorialogssource_hits_total', label: 'source' },
  { name: 'cs_winevtlogsource_hits_total', label: 'source' },
];

function parsePrometheusLabels(input: string): Record<string, string> {
  const labels: Record<string, string> = {};
  let index = 0;

  while (index < input.length) {
    while (input[index] === ',' || /\s/.test(input[index] || '')) index += 1;
    if (index >= input.length) break;

    const keyStart = index;
    while (index < input.length && input[index] !== '=') index += 1;
    const key = input.slice(keyStart, index).trim();
    index += 1;

    if (input[index] !== '"') break;
    index += 1;

    let value = '';
    while (index < input.length) {
      const char = input[index];
      if (char === '\\') {
        const next = input[index + 1];
        if (next === 'n') value += '\n';
        else if (next) value += next;
        index += 2;
        continue;
      }
      if (char === '"') {
        index += 1;
        break;
      }
      value += char;
      index += 1;
    }

    if (key) labels[key] = value;
  }

  return labels;
}

export function parsePrometheusText(text: string): PrometheusSample[] {
  const samples: PrometheusSample[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|NaN|\+?Inf|-Inf)(?:\s+\d+)?$/);
    if (!match) continue;

    const value = Number(match[3]);
    if (!Number.isFinite(value)) continue;

    samples.push({
      name: match[1],
      labels: match[2] ? parsePrometheusLabels(match[2]) : {},
      value,
    });
  }

  return samples;
}

function metric(samples: PrometheusSample[], name: string): PrometheusSample[] {
  return samples.filter((sample) => sample.name === name);
}

function mapValue(map: Map<string, number>, key: string, increment: number): void {
  map.set(key, (map.get(key) || 0) + increment);
}

function sortedTop<T>(items: T[], getValue: (item: T) => number): T[] {
  return [...items]
    .sort((left, right) => getValue(right) - getValue(left))
    .slice(0, MAX_ROWS);
}

function routeKey(labels: Record<string, string>): string {
  return `${labels.method || 'GET'} ${labels.route || labels.endpoint || 'unknown'}`;
}

function successRate(successful: number, failed: number, processed: number): number | null {
  const denominator = successful + failed || processed;
  if (denominator <= 0) return null;
  return successful / denominator;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

function sourceKey(source: string, type: string): string {
  return `${source}\u0000${type}`;
}

function sourceMatches(sampleSource: string, source: ParserSourceAccumulator): boolean {
  return sampleSource === source.source || `${source.type}:${sampleSource}` === source.source;
}

function aggregateApiEntities(
  requestSamples: PrometheusSample[],
  entityLabel: 'bouncer' | 'machine',
  decisionOkSamples: PrometheusSample[] = [],
  decisionKoSamples: PrometheusSample[] = [],
): CrowdsecMetricsApiEntity[] {
  const entities = new Map<string, ApiEntityAccumulator>();

  const getEntity = (name: string): ApiEntityAccumulator => {
    const normalizedName = name || 'unknown';
    let entity = entities.get(normalizedName);
    if (!entity) {
      entity = { name: normalizedName, requests: 0, routes: new Map(), decisionsOk: 0, decisionsKo: 0 };
      entities.set(normalizedName, entity);
    }
    return entity;
  };

  for (const sample of requestSamples) {
    const entity = getEntity(sample.labels[entityLabel]);
    entity.requests += sample.value;
    mapValue(entity.routes, routeKey(sample.labels), sample.value);
  }

  for (const sample of decisionOkSamples) {
    getEntity(sample.labels.bouncer).decisionsOk += sample.value;
  }

  for (const sample of decisionKoSamples) {
    getEntity(sample.labels.bouncer).decisionsKo += sample.value;
  }

  return sortedTop(Array.from(entities.values()), (entity) => entity.requests + entity.decisionsOk + entity.decisionsKo)
    .map((entity) => {
      const topRouteEntry = Array.from(entity.routes.entries()).sort((left, right) => right[1] - left[1])[0];
      const [topMethod, ...topRouteParts] = topRouteEntry?.[0].split(' ') || [];
      return {
        name: entity.name,
        requests: entity.requests,
        topRoute: topRouteParts.length > 0 ? topRouteParts.join(' ') : null,
        topMethod: topMethod || null,
        decisionsOk: entity.decisionsOk || undefined,
        decisionsKo: entity.decisionsKo || undefined,
      };
    });
}

function aggregateParserSources(samples: PrometheusSample[]): CrowdsecMetricsParserSource[] {
  const sources = new Map<string, ParserSourceAccumulator>();

  const getSource = (sample: PrometheusSample): ParserSourceAccumulator => {
    const source = sample.labels.source || 'unknown';
    const type = sample.labels.type || 'unknown';
    const key = sourceKey(source, type);
    let accumulator = sources.get(key);
    if (!accumulator) {
      accumulator = {
        source,
        type,
        acquisTypes: new Set(),
        linesRead: null,
        processed: 0,
        parsedOk: 0,
        parsedKo: 0,
        pouredToBucket: 0,
        whitelisted: 0,
      };
      sources.set(key, accumulator);
    }
    if (sample.labels.acquis_type) accumulator.acquisTypes.add(sample.labels.acquis_type);
    return accumulator;
  };

  for (const sample of metric(samples, 'cs_parser_hits_total')) {
    getSource(sample).processed += sample.value;
  }

  for (const sample of metric(samples, 'cs_parser_hits_ok_total')) {
    getSource(sample).parsedOk += sample.value;
  }

  for (const sample of metric(samples, 'cs_parser_hits_ko_total')) {
    getSource(sample).parsedKo += sample.value;
  }

  for (const acquisitionMetric of ACQUISITION_SOURCE_METRICS) {
    for (const sample of metric(samples, acquisitionMetric.name)) {
      const sampleSource = sample.labels[acquisitionMetric.label];
      if (!sampleSource) continue;

      for (const source of sources.values()) {
        if (sourceMatches(sampleSource, source)) {
          source.linesRead = (source.linesRead || 0) + sample.value;
        }
      }
    }
  }

  for (const sample of metric(samples, 'cs_bucket_poured_total')) {
    getSource(sample).pouredToBucket += sample.value;
  }

  for (const sample of metric(samples, 'cs_node_wl_hits_ok_total')) {
    getSource(sample).whitelisted += sample.value;
  }

  return sortedTop(Array.from(sources.values()), (source) => source.linesRead ?? (source.processed || source.parsedOk + source.parsedKo))
    .map((source) => ({
      source: source.source,
      type: source.type,
      acquisTypes: Array.from(source.acquisTypes).sort(),
      linesRead: source.linesRead,
      processed: source.processed,
      parsedOk: source.parsedOk,
      parsedKo: source.parsedKo,
      pouredToBucket: source.pouredToBucket,
      whitelisted: source.whitelisted,
      successRate: successRate(source.parsedOk, source.parsedKo, source.processed),
    }));
}

function aggregateParserNodes(samples: PrometheusSample[]): CrowdsecMetricsParserNode[] {
  const nodes = new Map<string, ParserNodeAccumulator>();

  const getNode = (sample: PrometheusSample): ParserNodeAccumulator => {
    const name = sample.labels.name || 'unknown';
    const stage = sample.labels.stage || 'unknown';
    const source = sample.labels.source || 'unknown';
    const type = sample.labels.type || 'unknown';
    const acquisType = sample.labels.acquis_type || null;
    const key = `${name}\u0000${stage}\u0000${source}\u0000${type}\u0000${acquisType || ''}`;
    let accumulator = nodes.get(key);
    if (!accumulator) {
      accumulator = { name, stage, source, type, acquisType, processed: 0, parsedOk: 0, parsedKo: 0 };
      nodes.set(key, accumulator);
    }
    return accumulator;
  };

  for (const sample of metric(samples, 'cs_node_hits_total')) {
    getNode(sample).processed += sample.value;
  }

  for (const sample of metric(samples, 'cs_node_hits_ok_total')) {
    getNode(sample).parsedOk += sample.value;
  }

  for (const sample of metric(samples, 'cs_node_hits_ko_total')) {
    getNode(sample).parsedKo += sample.value;
  }

  return sortedTop(Array.from(nodes.values()), (node) => node.processed || node.parsedOk + node.parsedKo)
    .map((node) => ({
      ...node,
      successRate: successRate(node.parsedOk, node.parsedKo, node.processed),
    }));
}

function aggregateParserTimings(samples: PrometheusSample[]): CrowdsecMetricsTiming[] {
  const timings = new Map<string, TimingAccumulator>();

  const getTiming = (sample: PrometheusSample): TimingAccumulator => {
    const source = sample.labels.source || 'unknown';
    const type = sample.labels.type || 'unknown';
    const key = `${source}\u0000${type}`;
    let accumulator = timings.get(key);
    if (!accumulator) {
      accumulator = { source, type, count: 0, sum: 0 };
      timings.set(key, accumulator);
    }
    return accumulator;
  };

  for (const sample of metric(samples, 'cs_parsing_time_seconds_count')) {
    getTiming(sample).count += sample.value;
  }

  for (const sample of metric(samples, 'cs_parsing_time_seconds_sum')) {
    getTiming(sample).sum += sample.value;
  }

  return sortedTop(Array.from(timings.values()), (timing) => timing.count)
    .map((timing) => ({
      source: timing.source,
      type: timing.type,
      count: timing.count,
      averageSeconds: timing.count > 0 ? timing.sum / timing.count : null,
    }));
}

function aggregateAppsecEngines(samples: PrometheusSample[]): AppsecEngineAccumulator[] {
  const engines = new Map<string, AppsecEngineAccumulator>();

  const getEngine = (sample: PrometheusSample): AppsecEngineAccumulator => {
    const engine = sample.labels.appsec_engine || 'unknown';
    const source = sample.labels.source || 'unknown';
    const key = `${engine}\u0000${source}`;
    let accumulator = engines.get(key);
    if (!accumulator) {
      accumulator = { engine, source, requests: 0, blocked: 0 };
      engines.set(key, accumulator);
    }
    return accumulator;
  };

  for (const sample of metric(samples, 'cs_appsec_reqs_total')) {
    getEngine(sample).requests += sample.value;
  }

  for (const sample of metric(samples, 'cs_appsec_block_total')) {
    getEngine(sample).blocked += sample.value;
  }

  return sortedTop(Array.from(engines.values()), (engine) => engine.requests || engine.blocked);
}

function aggregateWhitelists(samples: PrometheusSample[]): CrowdsecMetricsWhitelist[] {
  const whitelists = new Map<string, WhitelistAccumulator>();

  const getWhitelist = (sample: PrometheusSample): WhitelistAccumulator => {
    const name = sample.labels.name || 'unknown';
    const reason = sample.labels.reason || 'unknown';
    const key = `${name}\u0000${reason}`;
    let accumulator = whitelists.get(key);
    if (!accumulator) {
      accumulator = { name, reason, hits: 0, whitelisted: 0 };
      whitelists.set(key, accumulator);
    }
    return accumulator;
  };

  for (const sample of metric(samples, 'cs_node_wl_hits_total')) {
    getWhitelist(sample).hits += sample.value;
  }

  for (const sample of metric(samples, 'cs_node_wl_hits_ok_total')) {
    getWhitelist(sample).whitelisted += sample.value;
  }

  return sortedTop(Array.from(whitelists.values()), (whitelist) => whitelist.hits || whitelist.whitelisted);
}

export function summarizeCrowdsecMetrics(samples: PrometheusSample[]): CrowdsecMetricsResponse {
  const parserOk = metric(samples, 'cs_parser_hits_ok_total').reduce((sum, sample) => sum + sample.value, 0);
  const parserKo = metric(samples, 'cs_parser_hits_ko_total').reduce((sum, sample) => sum + sample.value, 0);
  const parserProcessed = metric(samples, 'cs_parser_hits_total').reduce((sum, sample) => sum + sample.value, 0);
  const parserTimingCount = metric(samples, 'cs_parsing_time_seconds_count').reduce((sum, sample) => sum + sample.value, 0);
  const parserTimingSum = metric(samples, 'cs_parsing_time_seconds_sum').reduce((sum, sample) => sum + sample.value, 0);

  const bouncers = aggregateApiEntities(
    metric(samples, 'cs_lapi_bouncer_requests_total'),
    'bouncer',
    metric(samples, 'cs_lapi_decisions_ok_total'),
    metric(samples, 'cs_lapi_decisions_ko_total'),
  );
  const machines = aggregateApiEntities(metric(samples, 'cs_lapi_machine_requests_total'), 'machine');
  const appsecEngines = aggregateAppsecEngines(samples);
  const whitelists = aggregateWhitelists(samples);

  return {
    fetched_at: new Date().toISOString(),
    totals: {
      bouncerRequests: bouncers.reduce((sum, entity) => sum + entity.requests, 0),
      machineRequests: machines.reduce((sum, entity) => sum + entity.requests, 0),
      appsecRequests: appsecEngines.reduce((sum, engine) => sum + engine.requests, 0),
      appsecBlocked: appsecEngines.reduce((sum, engine) => sum + engine.blocked, 0),
      parserProcessed,
      parserOk,
      parserKo,
      parserSuccessRate: successRate(parserOk, parserKo, parserProcessed),
      parserAverageSeconds: parserTimingCount > 0 ? parserTimingSum / parserTimingCount : null,
      whitelistHits: whitelists.reduce((sum, whitelist) => sum + whitelist.hits, 0),
      whitelisted: whitelists.reduce((sum, whitelist) => sum + whitelist.whitelisted, 0),
    },
    bouncers,
    machines,
    parserSources: aggregateParserSources(samples),
    parserNodes: aggregateParserNodes(samples),
    whitelists,
    parserTimings: aggregateParserTimings(samples),
  };
}

export async function fetchCrowdsecMetrics(options: FetchCrowdsecMetricsOptions): Promise<CrowdsecMetricsResponse> {
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetchImpl(options.url, {
      headers: { Accept: 'text/plain' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Prometheus endpoint returned HTTP ${response.status}`);
    }

    const text = await response.text();
    return summarizeCrowdsecMetrics(parsePrometheusText(text));
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`Prometheus endpoint timed out after ${options.timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
