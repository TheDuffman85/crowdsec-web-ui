import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi, type MockInstance } from 'vitest';
import {
  createController,
  destroyTempDir,
  sampleAlert,
  seedAlert,
  tempDir,
} from './harness';

function auditEntries(logSpy: MockInstance): Array<Record<string, unknown>> {
  return logSpy.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith('[audit] '))
    .map((line) => JSON.parse(line.slice('[audit] '.length)) as Record<string, unknown>);
}

describe('audit log', () => {
  test('records added decisions with the authenticated user', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { controller, database, lapiClient } = createController({
      env: { AUTH_ENABLED: 'true' },
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
    });
    try {
      const setupResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'tommy', password: 'Password1' }),
      }));
      expect(setupResponse.status).toBe(200);
      const sessionCookie = String(setupResponse.headers.get('set-cookie')).split(';')[0];

      await lapiClient.login();
      const response = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
        body: JSON.stringify({ ip: '5.6.7.8', duration: '4h', type: 'ban', reason: 'manual' }),
      }));
      expect(response.status).toBe(200);

      expect(auditEntries(logSpy)).toEqual([expect.objectContaining({
        time: expect.any(String),
        user: 'tommy',
        role: 'admin',
        action: 'decision.add',
        ip: '5.6.7.8',
        type: 'ban',
        duration: '4h',
        reason: 'manual',
        instances: ['CrowdSec'],
        outcome: 'success',
      })]);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      logSpy.mockRestore();
      destroyTempDir();
    }
  });

  test('records single decision deletions with the banned value from the cache', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { controller, database, lapiClient } = createController();
    try {
      seedAlert(database, sampleAlert());
      await lapiClient.login();

      const response = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions/10', {
        method: 'DELETE',
      }));
      expect(response.status).toBe(200);

      expect(auditEntries(logSpy)).toEqual([expect.objectContaining({
        user: 'disabled-auth',
        action: 'decision.delete',
        decision_ids: ['10'],
        values: ['1.2.3.4'],
        outcome: 'success',
      })]);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      logSpy.mockRestore();
      destroyTempDir();
    }
  });

  test('records bulk decision deletions with resolved values and counters', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { controller, database, lapiClient } = createController();
    try {
      seedAlert(database, sampleAlert());
      await lapiClient.login();

      const response = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ['10'] }),
      }));
      expect(response.status).toBe(200);

      expect(auditEntries(logSpy)).toEqual([expect.objectContaining({
        action: 'decision.delete',
        decision_ids: ['10'],
        values: ['1.2.3.4'],
        requested_decisions: 1,
        deleted_decisions: 1,
        outcome: 'success',
      })]);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      logSpy.mockRestore();
      destroyTempDir();
    }
  });

  test('records alert deletions with the deleted entity counters', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { controller, database, lapiClient } = createController();
    try {
      seedAlert(database, sampleAlert());
      await lapiClient.login();

      const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/1', {
        method: 'DELETE',
      }));
      expect(response.status).toBe(200);

      expect(auditEntries(logSpy)).toEqual([expect.objectContaining({
        action: 'alert.delete',
        alert_ids: ['1'],
        deleted_alerts: 1,
        deleted_decisions: 1,
        outcome: 'success',
      })]);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      logSpy.mockRestore();
      destroyTempDir();
    }
  });

  test('records bulk alert deletions requested through instance refs', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { controller, database, lapiClient } = createController();
    try {
      seedAlert(database, sampleAlert());
      await lapiClient.login();

      const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refs: [{ instance_id: 'default', id: '1' }] }),
      }));
      expect(response.status).toBe(200);

      expect(auditEntries(logSpy)).toEqual([expect.objectContaining({
        action: 'alert.delete',
        alert_ids: ['default:1'],
        requested_alerts: 1,
        deleted_alerts: 1,
        outcome: 'success',
      })]);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      logSpy.mockRestore();
      destroyTempDir();
    }
  });

  test('records per-IP cleanups with the deleted entity counters', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { controller, database, lapiClient } = createController();
    try {
      seedAlert(database, sampleAlert());
      await lapiClient.login();

      const response = await controller.fetch(new Request('http://localhost/crowdsec/api/cleanup/by-ip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: '1.2.3.4' }),
      }));
      expect(response.status).toBe(200);

      expect(auditEntries(logSpy)).toEqual([expect.objectContaining({
        action: 'cleanup.by-ip',
        ip: '1.2.3.4',
        instances: ['CrowdSec'],
        deleted_alerts: 1,
        deleted_decisions: 1,
        outcome: 'success',
      })]);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      logSpy.mockRestore();
      destroyTempDir();
    }
  });

  test('stays silent when audit logging is disabled', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { controller, database, lapiClient } = createController({
      env: { CONFIG_AUDIT_ENABLED: 'false' },
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
    });
    try {
      await lapiClient.login();
      const response = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: '5.6.7.8', duration: '4h', type: 'ban', reason: 'manual' }),
      }));
      expect(response.status).toBe(200);

      expect(auditEntries(logSpy)).toEqual([]);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      logSpy.mockRestore();
      destroyTempDir();
    }
  });

  test('appends audit entries to the configured log file', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logFile = path.join(tempDir, 'logs', 'audit.log');
    const { controller, database, lapiClient } = createController({
      env: { CONFIG_AUDIT_LOG_FILE: logFile },
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
    });
    try {
      await lapiClient.login();
      const response = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: '5.6.7.8', duration: '4h', type: 'ban', reason: 'manual' }),
      }));
      expect(response.status).toBe(200);

      const lines = readFileSync(logFile, 'utf8').trimEnd().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual(expect.objectContaining({
        user: 'disabled-auth',
        action: 'decision.add',
        ip: '5.6.7.8',
        outcome: 'success',
      }));
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      logSpy.mockRestore();
      destroyTempDir();
    }
  });
});
