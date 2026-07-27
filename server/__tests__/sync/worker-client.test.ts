import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CrowdsecDatabase } from '../../database';
import { DatabaseSyncWorker } from '../../sync-worker-client';

const tempDirs: string[] = [];
const workers: DatabaseSyncWorker[] = [];

afterEach(() => {
  for (const worker of workers.splice(0)) worker.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('DatabaseSyncWorker', () => {
  test('keeps rollback journal mode when WAL is disabled', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-sync-worker-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'test.db');
    const database = new CrowdsecDatabase({ dbPath, walEnabled: false });
    const worker = new DatabaseSyncWorker({ dbPath, walEnabled: false });
    workers.push(worker);

    await worker.clearSyncData();

    expect(database.db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    worker.close();
    database.close();
  });

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

  test('persists split alert decisions and reconciles stale rows only on the final fragment', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-sync-worker-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'test.db');
    const database = new CrowdsecDatabase({ dbPath });
    const worker = new DatabaseSyncWorker({ dbPath });
    workers.push(worker);
    const alert = {
      $id: 1,
      $uuid: 'blocklist-alert',
      $created_at: '2026-07-14T00:00:00.000Z',
      $message: 'Blocklist import',
      $raw_data: JSON.stringify({ id: 1, decisions: [{ id: 'new-1' }, { id: 'new-2' }] }),
    };
    const decision = (id: string) => ({
      $id: id,
      $uuid: id,
      $alert_id: 1,
      $created_at: '2026-07-14T00:00:00.000Z',
      $stop_at: '2026-07-15T00:00:00.000Z',
      $value: '198.51.100.1',
      $type: 'ban',
      $origin: 'lists',
      $scenario: 'crowdsecurity/blocklist-import',
      $raw_data: JSON.stringify({ id, alert_id: 1 }),
    });

    database.insertAlert(alert);
    database.insertDecision(decision('stale'));

    await worker.persistAlerts([{
      alert,
      decisions: [decision('new-1')],
      keepDecisionIds: [],
      reconcileDecisions: false,
    }]);
    expect(database.getDecisionById('stale')).not.toBeNull();

    await worker.persistAlerts([{
      alertId: 1,
      decisions: [decision('new-2')],
      keepDecisionIds: ['new-1', 'new-2'],
      reconcileDecisions: true,
    }]);
    expect(database.getDecisionById('new-1')).not.toBeNull();
    expect(database.getDecisionById('new-2')).not.toBeNull();
    expect(database.getDecisionById('stale')).toBeNull();

    database.close();
  });

  test('updates reconciled decision references without recalculating alert indexes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-sync-worker-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'test.db');
    const database = new CrowdsecDatabase({ dbPath });
    const worker = new DatabaseSyncWorker({ dbPath });
    workers.push(worker);
    database.insertAlert({
      $id: 1,
      $uuid: 'active-alert',
      $created_at: '2026-07-14T00:00:00.000Z',
      $message: 'indexed message',
      $raw_data: JSON.stringify({ id: 1, decisions: [{ id: 'old' }] }),
    });

    await worker.persistAlerts([{
      alert: {
        $id: 1,
        $uuid: 'active-alert',
        $created_at: '2026-07-14T00:00:00.000Z',
        $message: 'must not replace indexed fields',
        $raw_data: JSON.stringify({ id: 1, decisions: [{ id: 'new' }] }),
      },
      decisions: [],
      keepDecisionIds: [],
      reconcileDecisions: false,
      updateAlertRawDataOnly: true,
    }]);

    expect(database.db.prepare('SELECT message, raw_data FROM alerts WHERE id = 1').get()).toEqual({
      message: 'indexed message',
      raw_data: null,
    });
    database.close();
  });

  test('keeps readers on the committed revision until a refresh transaction commits', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-sync-worker-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'test.db');
    const database = new CrowdsecDatabase({ dbPath });
    const worker = new DatabaseSyncWorker({ dbPath });
    workers.push(worker);
    const mutation = {
      alert: {
        $id: 1,
        $uuid: 'transaction-alert',
        $created_at: '2026-07-14T00:00:00.000Z',
        $message: 'Atomic refresh alert',
        $raw_data: JSON.stringify({ id: 1 }),
      },
      decisions: [],
      keepDecisionIds: [],
    };

    await worker.runTransaction(async () => {
      await worker.persistAlerts([mutation]);
      expect(database.countAlerts()).toBe(0);
    });
    expect(database.countAlerts()).toBe(1);

    await expect(worker.runTransaction(async () => {
      await worker.persistAlerts([{
        ...mutation,
        alert: { ...mutation.alert, $id: 2, $uuid: 'rolled-back-alert' },
      }]);
      expect(database.countAlerts()).toBe(1);
      throw new Error('abort refresh');
    })).rejects.toThrow('abort refresh');
    expect(database.countAlerts()).toBe(1);

    database.close();
  });

  test('compares large alert decision membership exactly in the sync worker', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-sync-worker-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'test.db');
    const database = new CrowdsecDatabase({ dbPath });
    const worker = new DatabaseSyncWorker({ dbPath });
    workers.push(worker);
    database.insertAlert({
      $id: 1,
      $instance_id: 'default',
      $uuid: 'blocklist-alert',
      $created_at: '2026-07-14T00:00:00.000Z',
      $message: 'Blocklist import',
      $record: {
        id: 1,
        uuid: 'blocklist-alert',
        created_at: '2026-07-14T00:00:00.000Z',
        message: 'Blocklist import',
        decisions: [],
      },
    });
    for (const id of ['keep', 'remove']) {
      database.insertDecision({
        $id: id,
        $instance_id: 'default',
        $uuid: id,
        $alert_id: 1,
        $created_at: '2026-07-14T00:00:00.000Z',
        $stop_at: '2026-08-14T00:00:00.000Z',
        $value: `198.51.100.${id === 'keep' ? 1 : 2}`,
        $type: 'ban',
        $origin: 'lists',
        $scenario: 'crowdsecurity/blocklist-import',
        $record: { id, alert_id: 1, origin: 'lists' },
      });
    }
    const snapshot = database.getAlertDecisionSnapshot(1, 'default');
    expect(snapshot).not.toBeNull();
    const comparison = {
      alertId: 1,
      instanceId: 'default',
      metadataHash: snapshot!.metadata_hash,
      decisionIds: ['keep', 'remove'],
      inactiveDecisionIds: [],
      observedAt: '2026-07-15T00:00:00.000Z',
      origins: snapshot!.origins,
      simulated: snapshot!.simulated,
    };

    await expect(worker.compareAlertDecisions([comparison])).resolves.toEqual([null]);
    await expect(worker.compareAlertDecisions([{
      ...comparison,
      decisionIds: ['keep', 'add'],
    }])).resolves.toEqual([{
      alertId: 1,
      decisionIdsToPersist: ['add'],
      removedIds: ['remove'],
      reconcileDecisions: false,
      updateAlertRawDataOnly: true,
    }]);

    database.close();
  });
});
