import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CrowdsecDatabase } from './database';
import { DatabaseSyncWorker } from './sync-worker-client';

const tempDirs: string[] = [];
const workers: DatabaseSyncWorker[] = [];

afterEach(() => {
  for (const worker of workers.splice(0)) worker.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('DatabaseSyncWorker', () => {
  test('serializes authentication, settings, and notification writes with alert sync', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-sync-worker-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'test.db');
    const database = new CrowdsecDatabase({ dbPath });
    const worker = new DatabaseSyncWorker({ dbPath });
    workers.push(worker);
    const mutations = Array.from({ length: 250 }, (_, index) => ({
      alert: {
        $id: index + 1,
        $uuid: `alert-${index + 1}`,
        $created_at: '2026-07-13T00:00:00.000Z',
        $message: `Concurrent sync alert ${index + 1}`,
        $raw_data: JSON.stringify({ id: index + 1, message: `Concurrent sync alert ${index + 1}` }),
      },
      decisions: [],
      keepDecisionIds: [],
    }));

    const [syncResult, writes] = await Promise.all([
      worker.persistAlerts(mutations),
      worker.runExclusive(() => {
        const passwordUserId = database.createAuthUser({
          username: 'password-user',
          passwordHash: 'password-hash',
          role: 'admin',
          authProvider: 'password',
        });
        database.updateAuthUserTotpLastStep(passwordUserId, 1234);
        const credentialId = database.createWebAuthnCredential({
          userId: passwordUserId,
          credentialId: 'credential-1',
          publicKey: 'public-key',
          signCount: 0,
          transports: null,
          name: 'Primary passkey',
        });
        database.updateWebAuthnCredentialCounter(credentialId, 1);
        database.setMeta('refresh_interval_ms', '30000');
        const oidcUser = database.upsertOidcUser({
          username: 'oidc-user',
          role: 'admin',
          issuer: 'https://idp.example.com',
          subject: 'subject-1',
        });
        database.upsertNotificationChannel({
          $id: 'channel-1',
          $created_at: '2026-07-13T00:00:00.000Z',
          $updated_at: '2026-07-13T00:00:00.000Z',
          $name: 'Webhook',
          $type: 'webhook',
          $enabled: 1,
          $config_json: '{}',
        });
        return { passwordUserId, oidcUser };
      }),
    ]);

    expect(syncResult.changed).toBe(true);
    expect(writes.oidcUser).toEqual(expect.objectContaining({
      username: 'oidc-user',
      oidc_issuer: 'https://idp.example.com',
      oidc_subject: 'subject-1',
    }));
    expect(database.getAllAlerts()).toHaveLength(250);
    expect(database.getAuthUserById(writes.passwordUserId)).toEqual(expect.objectContaining({
      username: 'password-user',
      totp_last_step: 1234,
    }));
    expect(database.listWebAuthnCredentialsByUser(writes.passwordUserId)[0]?.sign_count).toBe(1);
    expect(database.getMeta('refresh_interval_ms')?.value).toBe('30000');
    expect(database.getAuthUserById(writes.oidcUser.id)?.username).toBe('oidc-user');
    expect(database.listNotificationChannels()).toEqual([
      expect.objectContaining({ id: 'channel-1', name: 'Webhook' }),
    ]);

    database.close();
  });
});
