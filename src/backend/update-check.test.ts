import { describe, expect, test } from 'bun:test';
import { createUpdateChecker } from './update-check';

describe('update checker', () => {
  test('returns early when update checking is disabled or image ref is invalid', async () => {
    const disabled = createUpdateChecker({
      dockerImageRef: 'owner/repo',
      branch: 'main',
      commitHash: 'abc123',
      version: '1.0.0',
      enabled: false,
    });

    const invalid = createUpdateChecker({
      dockerImageRef: 'bad-ref',
      branch: 'main',
      commitHash: 'abc123',
      version: '1.0.0',
      enabled: true,
    });

    await expect(disabled()).resolves.toEqual({ update_available: false, reason: 'no_local_hash' });
    await expect(invalid()).resolves.toEqual({ update_available: false, reason: 'invalid_image_ref' });
  });

  test('prefers GHCR dev tags when available', async () => {
    const check = createUpdateChecker({
      dockerImageRef: 'owner/repo',
      branch: 'dev',
      commitHash: 'abc123',
      version: '202401010000',
      enabled: true,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.startsWith('https://ghcr.io/token')) {
          return Response.json({ token: 'token' });
        }
        if (url.includes('/tags/list')) {
          return Response.json({ tags: ['dev-202401010000', 'dev-202501010000'] });
        }
        throw new Error(`unexpected url ${url}`);
      },
    });

    await expect(check()).resolves.toEqual({
      update_available: true,
      local_version: '202401010000',
      remote_version: '202501010000',
      tag: 'dev',
    });

    await expect(check()).resolves.toEqual({
      update_available: true,
      local_version: '202401010000',
      remote_version: '202501010000',
      tag: 'dev',
    });
  });

  test('uses latest release for main builds', async () => {
    const check = createUpdateChecker({
      dockerImageRef: 'owner/repo',
      branch: 'main',
      commitHash: 'abc123',
      version: '1.0.0',
      enabled: true,
      fetchImpl: async () =>
        Response.json({
          tag_name: 'v1.1.0',
          html_url: 'https://example.com/release',
        }),
    });

    await expect(check()).resolves.toEqual({
      update_available: true,
      local_version: '1.0.0',
      remote_version: '1.1.0',
      release_url: 'https://example.com/release',
      tag: 'latest',
    });
  });

  test('falls back to workflow runs when GHCR lookup misses and handles errors', async () => {
    const check = createUpdateChecker({
      dockerImageRef: 'owner/repo',
      branch: 'dev',
      commitHash: 'abc123',
      version: '',
      enabled: true,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.startsWith('https://ghcr.io/token')) {
          throw new Error('ghcr unavailable');
        }
        if (url.includes('/actions/workflows/dev-build.yml/runs')) {
          return Response.json({
            workflow_runs: [{ created_at: '2025-03-05T11:04:08Z' }],
          });
        }
        throw new Error(`unexpected url ${url}`);
      },
    });

    await expect(check()).resolves.toEqual({
      update_available: false,
      local_version: 'abc123',
      remote_version: '202503051104',
      tag: 'dev',
    });

    const brokenMain = createUpdateChecker({
      dockerImageRef: 'owner/repo',
      branch: 'main',
      commitHash: 'abc123',
      version: '1.0.0',
      enabled: true,
      fetchImpl: async () => new Response('{}', { status: 500 }),
    });

    await expect(brokenMain()).resolves.toEqual({
      update_available: false,
      error: 'Update check failed',
    });
  });
});
