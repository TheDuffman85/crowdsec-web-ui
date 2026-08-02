import { describe, expect, test } from 'vitest';
import { parsePrometheusText, summarizeCrowdsecMetrics } from '../../metrics';

describe('CrowdSec Prometheus metrics parsing', () => {
  test('summarizes bouncer, machine, and parser metrics', () => {
    const samples = parsePrometheusText(`
# HELP cs_lapi_bouncer_requests_total number of calls
# TYPE cs_lapi_bouncer_requests_total counter
cs_lapi_bouncer_requests_total{bouncer="firewall",route="/v1/decisions",method="GET"} 12
cs_lapi_bouncer_requests_total{bouncer="firewall",route="/v1/decisions/stream",method="GET"} 4
cs_lapi_bouncer_requests_total{bouncer="nginx",route="/v1/decisions",method="GET"} 6
cs_lapi_decisions_ok_total{bouncer="firewall"} 10
cs_lapi_decisions_ko_total{bouncer="firewall"} 2
cs_lapi_machine_requests_total{machine="edge-1",route="/v1/alerts",method="POST"} 5
cs_lapi_machine_requests_total{machine="edge-1",route="/v1/watchers/login",method="POST"} 1
cs_lapi_request_duration_seconds_count{endpoint="/v1/alerts",method="POST"} 4
cs_lapi_request_duration_seconds_sum{endpoint="/v1/alerts",method="POST"} 0.8
cs_appsec_reqs_total{source="0.0.0.0:7422",appsec_engine="appsec"} 100
cs_appsec_block_total{source="0.0.0.0:7422",appsec_engine="appsec"} 7
cs_filesource_hits_total{source="/var/log/auth.log"} 110
cs_parser_hits_total{source="/var/log/auth.log",type="syslog"} 100
cs_parser_hits_ok_total{source="/var/log/auth.log",type="syslog",acquis_type="file"} 95
cs_parser_hits_ko_total{source="/var/log/auth.log",type="syslog",acquis_type="file"} 5
cs_bucket_poured_total{name="crowdsecurity/ssh-bf",source="/var/log/auth.log",type="syslog"} 40
cs_node_wl_hits_ok_total{name="crowdsecurity/whitelists",source="/var/log/auth.log",type="syslog",reason="private",stage="s02-enrich",acquis_type="file"} 3
cs_node_wl_hits_total{name="crowdsecurity/whitelists",source="/var/log/auth.log",type="syslog",reason="private",stage="s02-enrich",acquis_type="file"} 12
cs_node_hits_total{name="crowdsecurity/sshd-logs",source="/var/log/auth.log",type="syslog",stage="s01-parse",acquis_type="file"} 80
cs_node_hits_ok_total{name="crowdsecurity/sshd-logs",source="/var/log/auth.log",type="syslog",stage="s01-parse",acquis_type="file"} 78
cs_node_hits_ko_total{name="crowdsecurity/sshd-logs",source="/var/log/auth.log",type="syslog",stage="s01-parse",acquis_type="file"} 2
cs_node_hits_total{name="child-crowdsecurity/sshd-logs",source="/var/log/auth.log",type="syslog",stage="s01-parse",acquis_type="file"} 30
cs_node_hits_ok_total{name="child-crowdsecurity/sshd-logs",source="/var/log/auth.log",type="syslog",stage="s01-parse",acquis_type="file"} 10
cs_node_hits_ko_total{name="child-crowdsecurity/sshd-logs",source="/var/log/auth.log",type="syslog",stage="s01-parse",acquis_type="file"} 20
cs_parsing_time_seconds_count{source="/var/log/auth.log",type="syslog"} 100
cs_parsing_time_seconds_sum{source="/var/log/auth.log",type="syslog"} 0.25
`);

    const summary = summarizeCrowdsecMetrics(samples);

    expect(summary.totals).toMatchObject({
      bouncerRequests: 22,
      machineRequests: 6,
      appsecRequests: 100,
      appsecBlocked: 7,
      parserProcessed: 100,
      parserOk: 95,
      parserKo: 5,
      parserSuccessRate: 0.95,
      parserAverageSeconds: 0.0025,
      whitelistHits: 12,
      whitelisted: 3,
    });
    expect(summary.bouncers[0]).toMatchObject({
      name: 'firewall',
      requests: 16,
      topRoute: '/v1/decisions',
      topMethod: 'GET',
      decisionsOk: 10,
      decisionsKo: 2,
    });
    expect(summary.machines[0]).toMatchObject({
      name: 'edge-1',
      requests: 6,
      topRoute: '/v1/alerts',
      topMethod: 'POST',
    });
    expect(summary.parserSources[0]).toMatchObject({
      source: '/var/log/auth.log',
      type: 'syslog',
      acquisTypes: ['file'],
      linesRead: 110,
      processed: 100,
      parsedOk: 95,
      parsedKo: 5,
      pouredToBucket: 40,
      whitelisted: 3,
      successRate: 0.95,
    });
    expect(summary.whitelists[0]).toMatchObject({
      name: 'crowdsecurity/whitelists',
      reason: 'private',
      hits: 12,
      whitelisted: 3,
    });
    expect(summary.parserNodes[0]).toMatchObject({
      name: 'crowdsecurity/sshd-logs',
      stage: 's01-parse',
      processed: 80,
      parsedOk: 78,
      parsedKo: 2,
      isChild: false,
      successRate: 0.975,
    });
    expect(summary.parserNodes.find((node) => node.name === 'child-crowdsecurity/sshd-logs')).toMatchObject({
      isChild: true,
      processed: 30,
      parsedOk: 10,
      parsedKo: 20,
      successRate: 10 / 30,
    });
    expect(summary.parserTimings[0]).toMatchObject({
      source: '/var/log/auth.log',
      type: 'syslog',
      count: 100,
      averageSeconds: 0.0025,
    });
    expect(summary.lapiRoutes?.[0]).toMatchObject({
      method: 'POST',
      route: '/v1/alerts',
      requests: 4,
      averageSeconds: 0.2,
    });
    expect(summary.appsecEngines?.[0]).toMatchObject({
      engine: 'appsec',
      source: '0.0.0.0:7422',
      requests: 100,
      blocked: 7,
      blockRate: 0.07,
    });
  });

  test('separates log processor activity, identifies bouncer mode, and includes scenarios', () => {
    const summary = summarizeCrowdsecMetrics(parsePrometheusText(`
cs_info{version="v1.7.8"} 1
process_start_time_seconds 1782813600
cs_active_decisions{reason="ssh",origin="crowdsec",action="ban"} 4
cs_alerts{reason="ssh"} 3
cs_lapi_bouncer_requests_total{bouncer="stream-firewall",route="/v1/decisions/stream",method="GET"} 20
cs_lapi_machine_requests_total{machine="processor-1",route="/v1/alerts",method="POST"} 7
cs_lapi_machine_requests_total{machine="processor-1",route="/v1/heartbeat",method="GET"} 5
cs_lapi_machine_requests_total{machine="processor-1",route="/v1/watchers/login",method="POST"} 1
cs_machines_last_heartbeat_timestamp{machine="processor-1"} 1782813660
cs_lapi_route_requests_total{route="/v1/alerts",method="POST"} 7
cs_lapi_request_duration_seconds_count{endpoint="/v1/alerts",method="POST"} 7
cs_lapi_request_duration_seconds_sum{endpoint="/v1/alerts",method="POST"} 0.7
cs_buckets{name="crowdsecurity/ssh-bf"} 2
cs_bucket_instantiation_total{name="crowdsecurity/ssh-bf"} 8
cs_bucket_overflowed_total{name="crowdsecurity/ssh-bf"} 3
cs_bucket_underflowed_total{name="crowdsecurity/ssh-bf"} 1
cs_bucket_canceled_total{name="crowdsecurity/ssh-bf"} 1
cs_bucket_poured_total{name="crowdsecurity/ssh-bf",source="/var/log/auth.log",type="syslog"} 12
`));

    expect(summary.crowdsecVersion).toBe('v1.7.8');
    expect(summary.crowdsecStartedAt).toBe(new Date(1782813600 * 1000).toISOString());
    expect(summary.totals).toMatchObject({
      machineRequests: 13,
      machineAlertRequests: 7,
      machineHeartbeatRequests: 5,
      activeDecisions: 4,
      alerts: 3,
    });
    expect(summary.bouncers[0]).toMatchObject({
      name: 'stream-firewall',
      mode: 'stream',
      requests: 20,
    });
    expect(summary.machines[0]).toMatchObject({
      name: 'processor-1',
      requests: 13,
      alertRequests: 7,
      heartbeatRequests: 5,
      lastHeartbeatAt: new Date(1782813660 * 1000).toISOString(),
      otherRequests: 1,
    });
    expect(summary.lapiRoutes?.[0]).toMatchObject({
      method: 'POST',
      route: '/v1/alerts',
      requests: 7,
    });
    expect(summary.lapiRoutes?.[0].averageSeconds).toBeCloseTo(0.1);
    expect(summary.scenarios?.[0]).toMatchObject({
      name: 'crowdsecurity/ssh-bf',
      current: 2,
      instantiations: 8,
      overflows: 3,
      underflows: 1,
      canceled: 1,
      poured: 12,
    });
  });

  test('supports legacy scenario metrics, preserves totals beyond the display limit, and joins invalid routes', () => {
    const machineSamples = Array.from({ length: 13 }, (_, index) => {
      const requests = index + 1;
      return `cs_lapi_machine_requests_total{machine="machine-${index}",route="/v1/alerts",method="POST"} ${requests}`;
    });
    const summary = summarizeCrowdsecMetrics(parsePrometheusText(`
cs_bucket_created_total{name="crowdsecurity/ssh-bf"} 8
${machineSamples.join('\n')}
cs_lapi_route_requests_total{route="invalid-endpoint",method="GET"} 1
cs_lapi_request_duration_seconds_count{endpoint="",method="GET"} 1
cs_lapi_request_duration_seconds_sum{endpoint="",method="GET"} 0.1
`));

    expect(summary.scenarios).toEqual([expect.objectContaining({
      name: 'crowdsecurity/ssh-bf',
      instantiations: 8,
    })]);
    expect(summary.machines).toHaveLength(12);
    expect(summary.totals).toMatchObject({
      machineRequests: 91,
      machineAlertRequests: 91,
      machineHeartbeatRequests: 0,
    });
    expect(summary.lapiRoutes).toEqual([{
      method: 'GET',
      route: 'invalid-endpoint',
      requests: 1,
      averageSeconds: 0.1,
    }]);
  });

});
