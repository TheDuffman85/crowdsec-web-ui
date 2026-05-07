import type { UpdateCheckResponse } from '../shared/contracts';
import type { FetchLike } from './lapi';

export interface UpdateCheckOptions {
  dockerImageRef: string;
  branch: string;
  commitHash: string;
  version: string;
  enabled: boolean;
  fetchImpl?: FetchLike;
}

export interface UpdateCheckOverrides {
  branch?: string;
  commitHash?: string;
  version?: string;
}

export type UpdateChecker = (overrides?: UpdateCheckOverrides) => Promise<UpdateCheckResponse>;

export function createUpdateChecker(options: UpdateCheckOptions) {
  const fetchImpl: FetchLike = options.fetchImpl || ((input, init) => fetch(input, init as RequestInit));
  const cacheDurationMs = 6 * 60 * 60 * 1_000;
  let cached: { key: string; lastCheck: number; data: UpdateCheckResponse | null } = {
    key: '',
    lastCheck: 0,
    data: null,
  };

  return async function checkForUpdates(overrides: UpdateCheckOverrides = {}): Promise<UpdateCheckResponse> {
    if (!options.enabled) {
      return { update_available: false, reason: 'no_local_hash' };
    }

    const local = {
      branch: normalizeLocalValue(overrides.branch) || options.branch,
      commitHash: normalizeLocalValue(overrides.commitHash) || options.commitHash,
      version: normalizeLocalValue(overrides.version) || options.version,
    };
    const cacheKey = JSON.stringify([options.dockerImageRef, local.branch, local.commitHash, local.version]);
    const now = Date.now();
    if (cached.data && cached.key === cacheKey && now - cached.lastCheck < cacheDurationMs) {
      return cached.data;
    }

    const parts = options.dockerImageRef.split('/');
    let owner: string | undefined;
    let repo: string | undefined;

    if (parts.length === 2) {
      [owner, repo] = parts;
    } else if (parts.length === 3) {
      owner = parts[1];
      repo = parts[2];
    } else {
      return { update_available: false, reason: 'invalid_image_ref' };
    }

    try {
      let result: UpdateCheckResponse;

      if (local.branch === 'dev') {
        const remoteVersion = await resolveLatestDevBuild(owner, repo, fetchImpl);
        result = {
          update_available: Boolean(local.version && remoteVersion > local.version),
          local_version: local.version || local.commitHash,
          remote_version: remoteVersion,
          tag: 'dev',
        };
      } else {
        const response = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'crowdsec-web-ui-update-check',
          },
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const release = await response.json() as { tag_name: string; html_url: string };
        const remoteVersion = release.tag_name.replace(/^v/i, '').trim();
        const currentVersion = local.version ? local.version.replace(/^v/i, '').trim() : null;

        result = {
          update_available: Boolean(currentVersion && compareReleaseVersions(remoteVersion, currentVersion) > 0),
          local_version: local.version || null,
          remote_version: remoteVersion,
          release_url: release.html_url,
          tag: 'latest',
        };
      }

      cached = { key: cacheKey, lastCheck: now, data: result };
      return result;
    } catch (error) {
      console.error('Update check failed:', error);
      return { update_available: false, error: 'Update check failed' };
    }
  };
}

function normalizeLocalValue(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function compareReleaseVersions(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number(part));
  const rightParts = right.split('.').map((part) => Number(part));
  const canCompareNumerically = leftParts.every(Number.isFinite) && rightParts.every(Number.isFinite);

  if (!canCompareNumerically) {
    return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
  }

  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index] || 0;
    const rightPart = rightParts[index] || 0;
    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }

  return 0;
}

async function resolveLatestDevBuild(owner: string, repo: string, fetchImpl: FetchLike): Promise<string> {
  try {
    const tokenResponse = await fetchImpl(`https://ghcr.io/token?scope=repository:${owner}/${repo}:pull`, {
      headers: { 'User-Agent': 'crowdsec-web-ui-update-check' },
      signal: AbortSignal.timeout(10_000),
    });

    if (tokenResponse.ok) {
      const tokenData = await tokenResponse.json() as { token?: string };
      if (tokenData.token) {
        const tagsResponse = await fetchImpl(`https://ghcr.io/v2/${owner}/${repo}/tags/list`, {
          headers: {
            Authorization: `Bearer ${tokenData.token}`,
            'User-Agent': 'crowdsec-web-ui-update-check',
          },
          signal: AbortSignal.timeout(10_000),
        });

        if (tagsResponse.ok) {
          const tagsData = await tagsResponse.json() as { tags?: string[] };
          const devTags = (tagsData.tags || []).filter((tag) => /^dev-\d{12}$/.test(tag)).sort();
          if (devTags.length > 0) {
            return devTags[devTags.length - 1].replace('dev-', '');
          }
        }
      }
    }
  } catch (error) {
    console.warn('GHCR tag lookup failed, falling back to workflow API:', error);
  }

  const runsResponse = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/dev-build.yml/runs?branch=dev&status=success&per_page=1`,
    {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'crowdsec-web-ui-update-check',
      },
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!runsResponse.ok) {
    throw new Error(`HTTP ${runsResponse.status}`);
  }

  const payload = await runsResponse.json() as {
    workflow_runs?: Array<{ run_started_at?: string; created_at: string }>;
  };

  const latestRun = payload.workflow_runs?.[0];
  if (!latestRun) {
    return '';
  }

  const runDate = new Date(latestRun.run_started_at || latestRun.created_at);
  return `${runDate.getUTCFullYear()}${String(runDate.getUTCMonth() + 1).padStart(2, '0')}${String(runDate.getUTCDate()).padStart(2, '0')}${String(runDate.getUTCHours()).padStart(2, '0')}${String(runDate.getUTCMinutes()).padStart(2, '0')}`;
}
