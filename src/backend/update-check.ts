import type { UpdateCheckResponse } from '../../shared/contracts';
import type { FetchLike } from './lapi';

export interface UpdateCheckOptions {
  dockerImageRef: string;
  branch: string;
  commitHash: string;
  version: string;
  enabled: boolean;
  fetchImpl?: FetchLike;
}

export function createUpdateChecker(options: UpdateCheckOptions) {
  const fetchImpl = options.fetchImpl || fetch;
  const cacheDurationMs = 6 * 60 * 60 * 1_000;
  let cached: { lastCheck: number; data: UpdateCheckResponse | null } = {
    lastCheck: 0,
    data: null,
  };

  return async function checkForUpdates(): Promise<UpdateCheckResponse> {
    if (!options.enabled) {
      return { update_available: false, reason: 'no_local_hash' };
    }

    const now = Date.now();
    if (cached.data && now - cached.lastCheck < cacheDurationMs) {
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

      if (options.branch === 'dev') {
        const remoteVersion = await resolveLatestDevBuild(owner, repo, fetchImpl);
        result = {
          update_available: Boolean(options.version && remoteVersion > options.version),
          local_version: options.version || options.commitHash,
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
        const currentVersion = options.version ? options.version.replace(/^v/i, '').trim() : null;

        result = {
          update_available: Boolean(currentVersion && remoteVersion !== currentVersion),
          local_version: options.version || null,
          remote_version: remoteVersion,
          release_url: release.html_url,
          tag: 'latest',
        };
      }

      cached = { lastCheck: now, data: result };
      return result;
    } catch (error) {
      console.error('Update check failed:', error);
      return { update_available: false, error: 'Update check failed' };
    }
  };
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
