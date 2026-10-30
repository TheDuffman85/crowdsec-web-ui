export interface LoadTestFleetMetricsOptions {
  bouncers: number;
  machines: number;
  seed: number;
  now: number;
}

const BOUNCER_KINDS = ['firewall', 'nginx', 'traefik', 'haproxy', 'caddy'] as const;
const FLEET_SCENARIO_COUNT = 30;

function hash32(value: number, seed: number): number {
  let next = Math.imul(value ^ seed, 0x45d9f3b);
  next ^= next >>> 16;
  next = Math.imul(next, 0x45d9f3b);
  next ^= next >>> 16;
  return next >>> 0;
}

function padIndex(index: number, total: number): string {
  return String(index + 1).padStart(String(total).length, '0');
}

// Synthetic per-component LAPI counters for a central LAPI with many remote
// log processors and remediation components (issue #561). Heartbeat
// timestamps are relative to `now`, so the generated fleet always contains
// online, stale, and timestamp-less machines. Each machine also contributes
// a parser source, parser nodes, and parser timing; every third machine an
// AppSec listener and every fourth a whitelist, and any machines add a fixed
// set of scenarios, so every list on the Metrics page exceeds its collapsed
// row count.
export function buildLoadTestFleetMetrics(options: LoadTestFleetMetricsOptions): string {
  const lines: string[] = [];
  const nowSeconds = options.now / 1_000;

  for (let index = 0; index < options.bouncers; index += 1) {
    const value = hash32(index, options.seed);
    const kind = BOUNCER_KINDS[value % BOUNCER_KINDS.length];
    const name = `${kind}-node-${padIndex(index, options.bouncers)}`;
    const requests = 50 + (value % 2_000);
    const mode = (value >>> 8) % 3;
    if (mode !== 1) {
      lines.push(`cs_lapi_bouncer_requests_total{bouncer="${name}",route="/v1/decisions/stream",method="GET"} ${requests}`);
    }
    if (mode !== 0) {
      const liveRequests = Math.max(1, Math.floor(requests / 2));
      const nonEmpty = (value >>> 16) % Math.max(1, Math.floor(liveRequests / 10));
      lines.push(`cs_lapi_bouncer_requests_total{bouncer="${name}",route="/v1/decisions",method="GET"} ${liveRequests}`);
      lines.push(`cs_lapi_decisions_ok_total{bouncer="${name}"} ${nonEmpty}`);
      lines.push(`cs_lapi_decisions_ko_total{bouncer="${name}"} ${liveRequests - nonEmpty}`);
    }
  }

  for (let index = 0; index < options.machines; index += 1) {
    const value = hash32(index + 1_000_000, options.seed);
    const name = `agent-${padIndex(index, options.machines)}`;
    const heartbeats = 10 + (value % 3_000);
    const alerts = (value >>> 8) % 200;
    const status = index % 10;
    lines.push(`cs_lapi_machine_requests_total{machine="${name}",route="/v1/heartbeat",method="GET"} ${heartbeats}`);
    if (alerts > 0) {
      lines.push(`cs_lapi_machine_requests_total{machine="${name}",route="/v1/alerts",method="POST"} ${alerts}`);
    }
    lines.push(`cs_lapi_machine_requests_total{machine="${name}",route="/v1/watchers/login",method="POST"} ${1 + (value >>> 16) % 20}`);
    // 70% online, 20% stale, 10% without a heartbeat timestamp.
    if (status < 7) {
      lines.push(`cs_machines_last_heartbeat_timestamp{machine="${name}"} ${(nowSeconds - (value % 60)).toFixed(3)}`);
    } else if (status < 9) {
      lines.push(`cs_machines_last_heartbeat_timestamp{machine="${name}"} ${(nowSeconds - 900 - (value % 86_400)).toFixed(3)}`);
    }

    const source = `/var/log/${name}/auth.log`;
    const sourceLabels = `source="${source}",type="file"`;
    const read = 1_000 + (value % 50_000);
    const unparsed = (value >>> 4) % Math.max(1, Math.floor(read / 20));
    const parsed = read - unparsed;
    lines.push(`cs_filesource_hits_total{source="${source}"} ${read}`);
    lines.push(`cs_parser_hits_total{${sourceLabels}} ${read}`);
    lines.push(`cs_parser_hits_ok_total{${sourceLabels}} ${parsed}`);
    lines.push(`cs_parser_hits_ko_total{${sourceLabels}} ${unparsed}`);
    lines.push(`cs_node_hits_total{name="crowdsecurity/syslog-logs",stage="s00-raw",${sourceLabels}} ${read}`);
    lines.push(`cs_node_hits_ok_total{name="crowdsecurity/syslog-logs",stage="s00-raw",${sourceLabels}} ${read}`);
    lines.push(`cs_node_hits_ko_total{name="crowdsecurity/syslog-logs",stage="s00-raw",${sourceLabels}} 0`);
    lines.push(`cs_node_hits_total{name="crowdsecurity/sshd-logs",stage="s01-parse",${sourceLabels}} ${read}`);
    lines.push(`cs_node_hits_ok_total{name="crowdsecurity/sshd-logs",stage="s01-parse",${sourceLabels}} ${parsed}`);
    lines.push(`cs_node_hits_ko_total{name="crowdsecurity/sshd-logs",stage="s01-parse",${sourceLabels}} ${unparsed}`);
    lines.push(`cs_parsing_time_seconds_count{${sourceLabels}} ${read}`);
    lines.push(`cs_parsing_time_seconds_sum{${sourceLabels}} ${(read * (0.0002 + ((value >>> 12) % 50) / 10_000)).toFixed(6)}`);

    if (index % 3 === 0) {
      const appsecRequests = 100 + ((value >>> 6) % 20_000);
      lines.push(`cs_appsec_reqs_total{source="${name}:7422",appsec_engine="appsec"} ${appsecRequests}`);
      lines.push(`cs_appsec_block_total{source="${name}:7422",appsec_engine="appsec"} ${(value >>> 10) % Math.max(1, Math.floor(appsecRequests / 10))}`);
    }

    if (index % 4 === 0) {
      const whitelistLabels = `name="loadtest/${name}-allowlist",reason="${name} trusted ranges",${sourceLabels},stage="s02-enrich"`;
      const hits = 10 + ((value >>> 14) % 5_000);
      lines.push(`cs_node_wl_hits_total{${whitelistLabels}} ${hits}`);
      lines.push(`cs_node_wl_hits_ok_total{${whitelistLabels}} ${Math.floor(hits / 3)}`);
    }
  }

  if (options.machines > 0) {
    for (let index = 0; index < FLEET_SCENARIO_COUNT; index += 1) {
      const value = hash32(index + 2_000_000, options.seed);
      const name = `loadtest/fleet-scenario-${padIndex(index, FLEET_SCENARIO_COUNT)}`;
      const instantiations = 10 + (value % 5_000);
      lines.push(`cs_buckets{name="${name}"} ${value % 20}`);
      lines.push(`cs_bucket_instantiation_total{name="${name}"} ${instantiations}`);
      const pouredFrom = `agent-${padIndex(index % options.machines, options.machines)}`;
      lines.push(`cs_bucket_poured_total{name="${name}",source="/var/log/${pouredFrom}/auth.log",type="file"} ${instantiations * 3}`);
      lines.push(`cs_bucket_overflowed_total{name="${name}"} ${(value >>> 8) % Math.max(1, Math.floor(instantiations / 10))}`);
      lines.push(`cs_bucket_underflowed_total{name="${name}"} ${Math.floor(instantiations / 2)}`);
      lines.push(`cs_bucket_canceled_total{name="${name}"} 0`);
    }
  }

  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}
