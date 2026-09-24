import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CrowdsecInstanceConfig } from '../../instances-config';
import { compareVersions, createCrowdsecUpdateChecker } from '../../crowdsec-update-check';

function instance(id: string, endpoints: string[]): CrowdsecInstanceConfig {
  return {
    id,
    name: 'Instance ' + id,
    prometheus: endpoints.map((endpointId) => ({
      id: endpointId,
      name: 'Endpoint ' + endpointId,
      url: 'https://metrics.example/' + id + '/' + endpointId,
      auth: { type: 'none' },
      tls: {},
    })),
  } as CrowdsecInstanceConfig;
}

afterEach(() => vi.restoreAllMocks());

describe('CrowdSec update checker', () => {
  test('compares stable and prerelease versions with semantic precedence', () => {
    expect(compareVersions('v1.7.9', 'v1.8.0')).toBeLessThan(0);
    expect(compareVersions('1.8.0', 'v1.8.0')).toBe(0);
    expect(compareVersions('v1.8.1', 'v1.8.0')).toBeGreaterThan(0);
    expect(compareVersions('v1.8.0-rc.2', 'v1.8.0')).toBeLessThan(0);
    expect(compareVersions('v1.8.0-rc.10', 'v1.8.0-rc.2')).toBeGreaterThan(0);
    expect(() => compareVersions('nightly', 'v1.8.0')).toThrow();
  });

  test('checks every endpoint and caches release and metric observations', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let releaseVersion = 'v1.8.0';
    const releaseFetch = vi.fn(async () => Response.json({
      tag_name: releaseVersion,
      html_url: 'https://github.com/crowdsecurity/crowdsec/releases/tag/' + releaseVersion,
    }));
    const versions = new Map([
      ['https://metrics.example/a/one', 'v1.7.8'],
      ['https://metrics.example/a/two', 'v1.8.0'],
      ['https://metrics.example/b/one', 'v1.8.1'],
      ['https://metrics.example/b/two', 'v1.8.0-rc.1'],
      ['https://metrics.example/b/three', 'nightly'],
    ]);
    const metricsFetch = vi.fn(async (input: string | URL | Request) => new Response(
      'cs_info{version="' + versions.get(String(input)) + '"} 1\n',
    ));
    const check = createCrowdsecUpdateChecker({
      instances: [instance('a', ['one', 'two']), instance('b', ['one', 'two', 'three'])],
      prometheusTimeoutMs: 1_000,
      releaseFetchImpl: releaseFetch,
      metricsFetchImpl: metricsFetch,
    });

    const result = await check();
    expect(result.map((item) => [item.instanceId, item.endpointId, item.updateAvailable])).toEqual([
      ['a', 'one', true],
      ['a', 'two', false],
      ['b', 'one', false],
      ['b', 'two', true],
      ['b', 'three', null],
    ]);
    expect(result[0]).toMatchObject({
      instanceName: 'Instance a',
      endpointName: 'Endpoint one',
      currentVersion: 'v1.7.8',
      remoteVersion: 'v1.8.0',
      releaseUrl: 'https://github.com/crowdsecurity/crowdsec/releases/tag/v1.8.0',
    });
    await check();
    expect(releaseFetch).toHaveBeenCalledTimes(1);
    expect(metricsFetch).toHaveBeenCalledTimes(5);

    now += 15 * 60_000 + 1;
    versions.set('https://metrics.example/a/one', 'v1.8.0');
    expect((await check())[0].updateAvailable).toBe(false);
    expect(releaseFetch).toHaveBeenCalledTimes(1);
    expect(metricsFetch).toHaveBeenCalledTimes(10);

    now += 6 * 60 * 60_000 + 1;
    releaseVersion = 'v1.8.1';
    expect((await check())[0].remoteVersion).toBe('v1.8.1');
    expect(releaseFetch).toHaveBeenCalledTimes(2);
  });

  test('marks checks unknown on temporary failures and retries them', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let releaseFails = true;
    let metricsFail = true;
    const releaseFetch = vi.fn(async () => releaseFails
      ? new Response('', { status: 503 })
      : Response.json({
        tag_name: 'v1.8.0',
        html_url: 'https://github.com/crowdsecurity/crowdsec/releases/tag/v1.8.0',
      }));
    const metricsFetch = vi.fn(async () => metricsFail
      ? new Response('', { status: 503 })
      : new Response('cs_info{version="v1.7.8"} 1\n'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const check = createCrowdsecUpdateChecker({
      instances: [instance('a', ['one'])],
      prometheusTimeoutMs: 1_000,
      releaseFetchImpl: releaseFetch,
      metricsFetchImpl: metricsFetch,
    });

    expect((await check())[0].updateAvailable).toBeNull();
    releaseFails = false;
    await check();
    expect(releaseFetch).toHaveBeenCalledTimes(1);
    now += 5 * 60_000 + 1;
    expect((await check())[0].updateAvailable).toBeNull();
    metricsFail = false;
    await check();
    expect(metricsFetch).toHaveBeenCalledTimes(1);
    now += 5 * 60_000 + 1;
    expect((await check())[0].updateAvailable).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});
