import { afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import type { AlertDecision, AlertRecord, LapiStatus, UpdateCheckResponse } from '../../../shared/contracts';
import { CrowdsecDatabase } from '../../database';
import { createNotificationService } from '../../notifications';
import { createNotificationSecretStore } from '../../notifications/secret-store';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

export function createTestDatabase(): CrowdsecDatabase {
  const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-notifications-'));
  tempDirs.push(dir);
  return new CrowdsecDatabase({ dbPath: path.join(dir, 'test.db') });
}

export function createAlert(id: number, createdAt: string, overrides: Partial<AlertRecord> = {}): AlertRecord {
  return { id, uuid: `alert-${id}`, created_at: createdAt, scenario: 'crowdsecurity/ssh-bf', message: 'Blocked ssh bruteforce', source: { ip: '1.2.3.4', value: '1.2.3.4' }, target: 'ssh', events: [], decisions: [], simulated: false, ...overrides };
}

export function insertAlert(database: CrowdsecDatabase, alert: AlertRecord): void {
  database.insertAlert({ $id: alert.id, $instance_id: alert.instance_id, $uuid: alert.uuid || `alert-${alert.id}`, $created_at: alert.created_at, $scenario: alert.scenario, $source_ip: alert.source?.ip || alert.source?.value || '', $message: alert.message || '', $raw_data: JSON.stringify(alert) });
}

export function createDecision(id: string, createdAt: string, overrides: Partial<AlertDecision & Record<string, unknown>> = {}): AlertDecision & Record<string, unknown> {
  return { id, created_at: createdAt, stop_at: '2026-03-28T13:00:00.000Z', value: '1.2.3.4', type: 'ban', origin: 'crowdsec', scenario: 'crowdsecurity/ssh-bf', target: 'ssh', alert_id: 1, simulated: false, ...overrides };
}

export function insertDecision(database: CrowdsecDatabase, decision: AlertDecision & Record<string, unknown>): void {
  database.insertDecision({ $id: String(decision.id), $instance_id: typeof decision.instance_id === 'string' ? decision.instance_id : undefined, $uuid: String(decision.id), $alert_id: typeof decision.alert_id === 'string' || typeof decision.alert_id === 'number' ? decision.alert_id : 1, $created_at: String(decision.created_at || ''), $stop_at: String(decision.stop_at || ''), $value: typeof decision.value === 'string' ? decision.value : undefined, $type: typeof decision.type === 'string' ? decision.type : undefined, $origin: typeof decision.origin === 'string' ? decision.origin : undefined, $scenario: typeof decision.scenario === 'string' ? decision.scenario : undefined, $raw_data: JSON.stringify(decision) });
}

export function createService(options: { fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>; updateChecker?: () => Promise<UpdateCheckResponse>; getLapiStatus?: () => LapiStatus; getLapiStatuses?: () => Array<{ instanceId: string; instanceName: string; status: LapiStatus }>; debugPayloads?: boolean; instanceAware?: boolean; instances?: Array<{ id: string; name: string }> } = {}) {
  const database = createTestDatabase();
  const service = createNotificationService({ database, fetchImpl: options.fetchImpl, updateChecker: options.updateChecker, getLapiStatus: options.getLapiStatus, getLapiStatuses: options.getLapiStatuses, outboundGuard: { assertHostAllowed: async () => {}, assertUrlAllowed: async () => {} }, secretStore: createNotificationSecretStore(), debugPayloads: options.debugPayloads, instanceAware: options.instanceAware, instances: options.instances });
  return { database, service };
}
