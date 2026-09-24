import type { CrowdsecInstanceConfig } from './instances-config';
import { fetchCrowdsecMetricsSamples } from './metrics';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CrowdsecUpdateObservation {
  instanceId: string;
  instanceName: string;
  endpointId: string;
  endpointName: string;
  currentVersion: string | null;
  remoteVersion: string | null;
  releaseUrl: string | null;
  updateAvailable: boolean | null;
}

export type CrowdsecUpdateChecker = () => Promise<CrowdsecUpdateObservation[]>;

export interface CrowdsecUpdateCheckOptions {
  instances: ReadonlyArray<CrowdsecInstanceConfig>;
  prometheusTimeoutMs: number;
  releaseFetchImpl?: FetchLike;
  metricsFetchImpl?: FetchLike;
}

interface Release { version: string; url: string }
interface EndpointVersion { version: string | null; retryAt: number }

const RELEASE_CACHE_MS = 6 * 60 * 60_000;
const ENDPOINT_CACHE_MS = 15 * 60_000;
const FAILURE_RETRY_MS = 5 * 60_000;
const RELEASE_URL = 'https://api.github.com/repos/crowdsecurity/crowdsec/releases/latest';

export function createCrowdsecUpdateChecker(options: CrowdsecUpdateCheckOptions): CrowdsecUpdateChecker {
  const fetchImpl = options.releaseFetchImpl || fetch;
  let releaseCache: { value: Release | null; retryAt: number } | null = null;
  let releaseInFlight: Promise<Release | null> | null = null;
  const endpointCache = new Map<string, EndpointVersion>();
  const endpointInFlight = new Map<string, Promise<string | null>>();

  async function getRelease(): Promise<Release | null> {
    if (releaseCache && Date.now() < releaseCache.retryAt) return releaseCache.value;
    if (releaseInFlight) return releaseInFlight;
    releaseInFlight = (async () => {
      try {
        const response = await fetchImpl(RELEASE_URL, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'crowdsec-web-ui-update-check' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json() as { tag_name?: unknown; html_url?: unknown };
        const parsedVersion = typeof payload.tag_name === 'string' ? parseVersion(payload.tag_name) : null;
        if (typeof payload.tag_name !== 'string' || !parsedVersion || parsedVersion.prerelease.length
          || typeof payload.html_url !== 'string'
          || !payload.html_url.startsWith('https://github.com/crowdsecurity/crowdsec/releases/')) {
          throw new Error('Invalid CrowdSec release response');
        }
        const value: Release = { version: payload.tag_name, url: payload.html_url };
        releaseCache = { value, retryAt: Date.now() + RELEASE_CACHE_MS };
        return value;
      } catch (error) {
        console.warn('CrowdSec release check failed:', error);
        releaseCache = { value: null, retryAt: Date.now() + FAILURE_RETRY_MS };
        return null;
      } finally {
        releaseInFlight = null;
      }
    })();
    return releaseInFlight;
  }

  async function getEndpointVersion(instance: CrowdsecInstanceConfig, endpoint: CrowdsecInstanceConfig['prometheus'][number]): Promise<string | null> {
    const key = `${instance.id}:${endpoint.id}`;
    const cached = endpointCache.get(key);
    if (cached && Date.now() < cached.retryAt) return cached.version;
    const inFlight = endpointInFlight.get(key);
    if (inFlight) return inFlight;
    const request = (async () => {
      try {
        const samples = await fetchCrowdsecMetricsSamples({
          url: endpoint.url,
          timeoutMs: endpoint.requestTimeoutMs || options.prometheusTimeoutMs,
          auth: endpoint.auth,
          tls: endpoint.tls,
          fetchImpl: options.metricsFetchImpl,
        });
        const version = samples.find((sample) => sample.name === 'cs_info')?.labels.version
          || samples.find((sample) => sample.name === 'cs_info')?.labels.Version || null;
        const validVersion = version && parseVersion(version) ? version : null;
        endpointCache.set(key, {
          version: validVersion,
          retryAt: Date.now() + (validVersion ? ENDPOINT_CACHE_MS : FAILURE_RETRY_MS),
        });
        return validVersion;
      } catch (error) {
        console.warn(`CrowdSec version check failed for ${instance.id}/${endpoint.id}:`, error);
        endpointCache.set(key, { version: null, retryAt: Date.now() + FAILURE_RETRY_MS });
        return null;
      } finally {
        endpointInFlight.delete(key);
      }
    })();
    endpointInFlight.set(key, request);
    return request;
  }

  return async () => {
    const sources = options.instances.flatMap((instance) => instance.prometheus.map((endpoint) => ({ instance, endpoint })));
    if (sources.length === 0) return [];
    const release = await getRelease();
    if (!release) return sources.map(({ instance, endpoint }) => ({
      instanceId: instance.id, instanceName: instance.name,
      endpointId: endpoint.id, endpointName: endpoint.name,
      currentVersion: null, remoteVersion: null, releaseUrl: null, updateAvailable: null,
    }));
    return Promise.all(sources.map(async ({ instance, endpoint }) => {
      const currentVersion = await getEndpointVersion(instance, endpoint);
      return {
        instanceId: instance.id,
        instanceName: instance.name,
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        currentVersion,
        remoteVersion: release.version,
        releaseUrl: release.url,
        updateAvailable: currentVersion ? compareVersions(currentVersion, release.version) < 0 : null,
      };
    }));
  };
}

interface ParsedVersion { core: [number, number, number]; prerelease: string[] }

function parseVersion(input: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(input.trim());
  if (!match) return null;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  if (!core.every(Number.isSafeInteger) || match.slice(1, 4).some((part) => part.length > 1 && part.startsWith('0'))) return null;
  const prerelease = match[4]?.split('.') || [];
  if (prerelease.some((part) => !part || (/^\d+$/.test(part) && part.length > 1 && part.startsWith('0')))) return null;
  return { core, prerelease };
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error('Cannot compare invalid CrowdSec versions');
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return Math.sign(a.core[index] - b.core[index]);
  }
  if (a.prerelease.length === 0) return b.prerelease.length === 0 ? 0 : 1;
  if (b.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}
