import { isIP } from 'node:net';
import type {
  AlertRecord,
  BulkDeleteFailure,
  BulkDeleteResult,
  InstanceEntityRef,
} from '../../shared/contracts';
import type { RuntimeConfig } from '../config';
import type { CrowdsecDatabase } from '../database';
import type { LapiClient } from '../lapi';
import type { DatabaseQueryWorker } from '../query-worker-client';

type HonoContext = any;
type AnyError = Error & {
  code?: string;
  response?: { data?: unknown; status: number };
  request?: unknown;
  helpLink?: string;
  helpText?: string;
};

interface CachedDecisionRecord {
  id: string;
  value?: string;
}

interface CachedAlertRecord {
  id: string;
  sourceValue?: string;
  raw_data: string;
}

export interface DeletionServiceState {
  pendingAlertDeletionTimeout: ReturnType<typeof setTimeout> | null;
  pendingAlertDeletionPromise: Promise<void> | null;
  pendingAlertDeletionRerunRequested: boolean;
  pendingAlertDeletionStopped: boolean;
}

export interface DeletionServiceDependencies extends Record<string, any> {
  config: RuntimeConfig;
  database: CrowdsecDatabase;
  lapiClient: LapiClient;
  queryWorker: DatabaseQueryWorker;
  state: DeletionServiceState;
}

export function createDeletionService(dependencies: DeletionServiceDependencies) {
  const state = dependencies.state;
  const {
    IPV4_RE,
    IPV6_RE,
    config,
    createSqlWhere,
    database,
    getAlertSourceValue,
    getIntervalName,
    invalidateDashboardStatsCache,
    lapiClient,
    normalizeAlertDetail,
    prepareOnDemandRefresh,
    queryWorker,
    runNotificationEvaluation,
    syncWorker,
    updateCacheDelta,
  } = dependencies;

function normalizeDeleteIds(ids: Array<string | number> | undefined): string[] {
  if (!Array.isArray(ids)) {
    return [];
  }

  return Array.from(
    new Set(
      ids
        .map((id) => String(id).trim())
        .filter((id) => /^\d+$/.test(id)),
    ),
  );
}

function validateInstanceEntityRefs(refs: InstanceEntityRef[]): InstanceEntityRef[] | { error: string } {
  const unique = new Map<string, InstanceEntityRef>();
  for (const candidate of refs) {
    const instanceId = String(candidate?.instance_id || '').trim();
    const id = String(candidate?.id || '').trim();
    if (!config.instances.some((instance) => instance.id === instanceId)) {
      return { error: `Unknown CrowdSec instance: ${instanceId || '(missing)'}` };
    }
    if (!/^\d+$/.test(id)) {
      return { error: 'Entity IDs must be numeric' };
    }
    unique.set(`${instanceId}\u0000${id}`, { instance_id: instanceId, id });
  }
  return Array.from(unique.values());
}

function groupInstanceEntityRefs(refs: InstanceEntityRef[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const ref of refs) {
    const ids = groups.get(ref.instance_id) || [];
    ids.push(String(ref.id));
    groups.set(ref.instance_id, ids);
  }
  return groups;
}

function normalizeNotificationIds(ids: Array<string | number> | undefined): string[] {
  if (!Array.isArray(ids)) {
    return [];
  }

  return Array.from(
    new Set(
      ids
        .map((id) => String(id).trim())
        .filter((id) => id.length > 0),
    ),
  );
}

function isValidIpOrRange(value: string): boolean {
  return IPV4_RE.test(value) || IPV6_RE.test(value);
}

function isPermissionError(error: AnyError): boolean {
  return error.response?.status === 403;
}

function getLapiErrorMessage(error: AnyError): string {
  const data = error.response?.data;
  if (typeof data === 'string') return data;
  if (!data || typeof data !== 'object') return '';

  const message = 'message' in data ? data.message : undefined;
  if (typeof message === 'string') return message;

  const errorMessage = 'error' in data ? data.error : undefined;
  return typeof errorMessage === 'string' ? errorMessage : '';
}

function isAlreadyGoneError(error: AnyError): boolean {
  const status = error.response?.status;
  if (status === 404 || status === 410) return true;

  // CrowdSec currently reports missing alerts and decisions as HTTP 500.
  // Only accept its explicit absence messages so unrelated server failures
  // remain retryable.
  return status === 500 && /\b(?:not found|doesn['’]?t exist)\b/i.test(getLapiErrorMessage(error));
}

function toFailure(kind: 'alert' | 'decision', id: string, error: AnyError): BulkDeleteFailure {
  return {
    kind,
    id,
    error: error.message || 'Delete failed',
  };
}

async function deleteAlertFromLapi(id: string): Promise<unknown> {
  try {
    return await lapiClient.deleteAlert(id);
  } catch (error) {
    const typedError = error as AnyError;
    if (isAlreadyGoneError(typedError)) {
      console.log(`Alert ${id} is already missing in LAPI; removing local cache entry.`);
      return { message: 'Deleted' };
    }
    throw typedError;
  }
}

async function deleteDecisionFromLapi(id: string): Promise<unknown> {
  try {
    return await lapiClient.deleteDecision(id);
  } catch (error) {
    const typedError = error as AnyError;
    if (isAlreadyGoneError(typedError)) {
      console.log(`Decision ${id} is already missing in LAPI; removing local cache entry.`);
      return { message: 'Deleted' };
    }
    throw typedError;
  }
}

function getCachedAlertsForDeletion(): CachedAlertRecord[] {
  const since = new Date(Date.now() - config.lookbackMs).toISOString();
  return database.getAlertsSince(since).flatMap((row) => {
    try {
      const alert = JSON.parse(row.raw_data) as AlertRecord;
      if (!alert?.id) {
        return [];
      }

      return [{
        id: String(alert.id),
        sourceValue: getAlertSourceValue(alert.source),
        raw_data: row.raw_data,
      }];
    } catch {
      return [];
    }
  });
}

function getCachedDecisionsForDeletion(): CachedDecisionRecord[] {
  const since = new Date(Date.now() - config.lookbackMs).toISOString();
  const now = new Date().toISOString();
  return database.getDecisionsSince(since, now).map((row) => ({
    id: String(row.id),
    value: typeof row.value === 'string' ? row.value : undefined,
  }));
}

function createDeleteResult(overrides: Partial<BulkDeleteResult> = {}): BulkDeleteResult {
  return {
    requested_alerts: 0,
    requested_decisions: 0,
    deleted_alerts: 0,
    deleted_decisions: 0,
    failed: [],
    ...overrides,
  };
}

function getLinkedDecisionIds(alert: CachedAlertRecord): string[] {
  return getDecisionIdsForAlertIds([alert.id]);
}

async function getAlertForDeletion(id: string): Promise<CachedAlertRecord | null> {
  const snapshot = database.getAlertDecisionSnapshot(id);
  if (!snapshot) {
    try {
      const alert = await lapiClient.getAlertById(id) as AlertRecord;
      return {
        id,
        sourceValue: getAlertSourceValue(alert.source),
        raw_data: JSON.stringify(alert),
      };
    } catch (error) {
      if (isAlreadyGoneError(error as AnyError)) return null;
      throw error;
    }
  }

  try {
    const alert = JSON.parse(snapshot.raw_data) as AlertRecord;
    return {
      id,
      sourceValue: getAlertSourceValue(alert.source),
      raw_data: snapshot.raw_data,
    };
  } catch {
    return { id, raw_data: snapshot.raw_data };
  }
}

function parsePendingDecisionIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.map(String).filter((id) => /^\d+$/.test(id))
      : [];
  } catch {
    return [];
  }
}

function clearPendingAlertDeletionTimeout(): void {
  if (!state.pendingAlertDeletionTimeout) return;
  clearTimeout(state.pendingAlertDeletionTimeout);
  state.pendingAlertDeletionTimeout = null;
}

function processPendingAlertDeletionsInBackground(source: string): void {
  void processPendingAlertDeletions(source).catch((error) => {
    console.error(`Pending alert deletion processor failed (${source}): ${(error as Error).message}`);
  });
}

function getPendingAlertDeletionNextRunAt(
  rows: ReturnType<CrowdsecDatabase['getPendingAlertDeletions']>,
  now: number,
): number | null {
  if (rows.length === 0) return null;
  const retryDelayMs = 30_000;
  return Math.min(...rows.map((row) => {
    const lastAttempt = row.last_attempt_at ? Date.parse(row.last_attempt_at) : 0;
    const retryAt = row.last_error && lastAttempt > 0 ? lastAttempt + retryDelayMs : 0;
    const requestedAt = Date.parse(row.requested_at);
    const expiresAt = config.deletionQueueMaxAgeMs > 0 && Number.isFinite(requestedAt)
      ? requestedAt + config.deletionQueueMaxAgeMs
      : Number.POSITIVE_INFINITY;
    if (!row.decisions_deleted_at) return Math.min(retryAt || now, expiresAt);
    const deleteAt = row.delete_after ? Date.parse(row.delete_after) : now;
    return Math.min(Math.max(deleteAt, retryAt), expiresAt);
  }));
}

function logPendingAlertDeletionQueue(
  rows: ReturnType<CrowdsecDatabase['getPendingAlertDeletions']>,
  context: string,
  nextRunAt: number | null = getPendingAlertDeletionNextRunAt(rows, Date.now()),
): void {
  if (rows.length === 0) {
    console.log('[deletion-queue] Queue is empty.');
    return;
  }

  const failed = rows.filter((row) => Boolean(row.last_error)).length;
  const nextRun = nextRunAt === null ? 'none' : new Date(nextRunAt).toISOString();
  console.log(
    `[deletion-queue] ${context}: ${rows.length} pending, ${failed} failed; next run ${nextRun}.`,
  );
}

function schedulePendingAlertDeletionProcessing(): void {
  clearPendingAlertDeletionTimeout();
  if (state.pendingAlertDeletionStopped) return;
  const rows = database.getPendingAlertDeletions();
  if (rows.length === 0) {
    logPendingAlertDeletionQueue(rows, 'scheduler');
    return;
  }

  const now = Date.now();
  const nextAt = getPendingAlertDeletionNextRunAt(rows, now) ?? now;
  logPendingAlertDeletionQueue(rows, 'scheduler', nextAt);
  state.pendingAlertDeletionTimeout = setTimeout(() => {
    state.pendingAlertDeletionTimeout = null;
    processPendingAlertDeletionsInBackground('scheduled retry');
  }, Math.max(0, nextAt - now));
  state.pendingAlertDeletionTimeout.unref?.();
}

async function processPendingAlertDeletions(source: string): Promise<void> {
  if (state.pendingAlertDeletionStopped) return;
  if (state.pendingAlertDeletionPromise) {
    state.pendingAlertDeletionRerunRequested = true;
    return state.pendingAlertDeletionPromise;
  }

  clearPendingAlertDeletionTimeout();
  state.pendingAlertDeletionPromise = (async () => {
    const rows = database.getPendingAlertDeletions();
    if (rows.length > 0) {
      logPendingAlertDeletionQueue(rows, `processing (${source})`);
    }

    for (const row of rows) {
      const requestedAt = Date.parse(row.requested_at);
      if (
        config.deletionQueueMaxAgeMs > 0
        && Number.isFinite(requestedAt)
        && requestedAt + config.deletionQueueMaxAgeMs <= Date.now()
      ) {
        const completedAt = new Date().toISOString();
        const maxAge = getIntervalName(config.deletionQueueMaxAgeMs);
        const expirationError = `Maximum deletion queue age of ${maxAge} exceeded${row.last_error ? `; last error: ${row.last_error}` : ''}`;
        await syncWorker.runExclusive(() => {
          database.expireAlertDeletion(row.alert_id, completedAt, expirationError);
        });
        console.error(
          `[deletion-queue] Stopped retrying alert ${row.alert_id} after ${maxAge}; its tombstone remains active.${row.last_error ? ` Last error: ${row.last_error}` : ''}`,
        );
        continue;
      }

      let decisionsDeletedAt = row.decisions_deleted_at;
      let deleteAfter = row.delete_after;

      if (!decisionsDeletedAt) {
        try {
          const decisionIds = parsePendingDecisionIds(row.decision_ids_json);
          for (const decisionId of decisionIds) {
            await deleteDecisionFromLapi(decisionId);
          }
          const deletedAt = new Date().toISOString();
          const delayMs = decisionIds.length > 0 ? config.bouncerPropagationDelayMs : 0;
          const dueAt = new Date(Date.now() + delayMs).toISOString();
          await syncWorker.runExclusive(() => {
            database.markAlertDeletionDecisionsExpired(row.alert_id, deletedAt, dueAt);
          });
          decisionsDeletedAt = deletedAt;
          deleteAfter = dueAt;
        } catch (error) {
          const typedError = error as AnyError;
          if (typedError.response?.status === 401 && await lapiClient.login('pending alert decision deletion')) {
            state.pendingAlertDeletionRerunRequested = true;
          }
          const attemptedAt = new Date().toISOString();
          await syncWorker.runExclusive(() => {
            database.recordAlertDeletionFailure(row.alert_id, attemptedAt, typedError.message || 'Decision deletion failed');
          });
          console.error(`[deletion-queue] Alert ${row.alert_id} decision deletion failed and remains queued: ${typedError.message}`);
          continue;
        }
      }

      if (!decisionsDeletedAt || (deleteAfter && Date.parse(deleteAfter) > Date.now())) {
        continue;
      }

      try {
        await deleteAlertFromLapi(row.alert_id);
        const completedAt = new Date().toISOString();
        await syncWorker.runExclusive(() => {
          database.completeAlertDeletion(row.alert_id, completedAt);
        });
        const decisionCount = parsePendingDecisionIds(row.decision_ids_json).length;
        console.log(`[deletion-queue] Deleted alert ${row.alert_id} and ${decisionCount} linked decision(s).`);
      } catch (error) {
        const typedError = error as AnyError;
        if (typedError.response?.status === 401 && await lapiClient.login('pending alert deletion')) {
          state.pendingAlertDeletionRerunRequested = true;
        }
        const attemptedAt = new Date().toISOString();
        await syncWorker.runExclusive(() => {
          database.recordAlertDeletionFailure(row.alert_id, attemptedAt, typedError.message || 'Alert deletion failed');
        });
        console.error(`[deletion-queue] Alert ${row.alert_id} deletion failed and remains queued: ${typedError.message}`);
      }
    }

    const tombstoneRetentionMs = Math.max(config.lookbackMs, config.lapiRequestTimeoutMs * 2, 60_000);
    const completedBefore = new Date(Date.now() - tombstoneRetentionMs).toISOString();
    const purged = await syncWorker.runExclusive(() => database.purgeCompletedAlertDeletions(completedBefore));
    if (purged > 0) {
      console.log(`[deletion-queue] Purged ${purged} completed deletion tombstone(s).`);
    }
  })();

  try {
    await state.pendingAlertDeletionPromise;
  } finally {
    state.pendingAlertDeletionPromise = null;
    if (state.pendingAlertDeletionStopped) {
      state.pendingAlertDeletionRerunRequested = false;
    } else if (state.pendingAlertDeletionRerunRequested) {
      state.pendingAlertDeletionRerunRequested = false;
      processPendingAlertDeletionsInBackground('queued while processor was active');
    } else {
      schedulePendingAlertDeletionProcessing();
    }
  }
}

async function queueAlertsForDeletion(linkedDecisionIdsByAlert: Map<string, string[]>): Promise<void> {
  const requestedAt = new Date().toISOString();
  await syncWorker.runExclusive(() => {
    const queue = database.transaction<Map<string, string[]>>((entries) => {
      for (const [alertId, decisionIds] of entries) {
        database.queueAlertDeletion(alertId, decisionIds, requestedAt);
        database.deleteDecisionsByAlertId(alertId);
        database.deleteAlert(alertId);
      }
    });
    try {
      queue(linkedDecisionIdsByAlert);
      database.refreshDecisionDuplicateFlags(new Date().toISOString());
    } finally {
      database.refreshAlertDeletionTombstones();
    }
  });
  const decisionCount = new Set(Array.from(linkedDecisionIdsByAlert.values()).flat()).size;
  console.log(
    `[deletion-queue] Queued ${linkedDecisionIdsByAlert.size} alert deletion(s) and ${decisionCount} decision deletion(s).`,
  );
  invalidateDashboardStatsCache();
  processPendingAlertDeletionsInBackground('new deletion request');
}

async function deleteAlertsByIds(ids: string[]): Promise<BulkDeleteResult> {
  const result = createDeleteResult({ requested_alerts: ids.length });
  const linkedDecisionIdsByAlert = new Map<string, string[]>();
  const decisionIdsToDelete = new Set<string>();

  for (const id of ids) {
    const alert = await getAlertForDeletion(id);
    const linkedDecisionIds = alert ? getLinkedDecisionIds(alert) : [];
    linkedDecisionIdsByAlert.set(id, linkedDecisionIds);
    for (const decisionId of linkedDecisionIds) decisionIdsToDelete.add(decisionId);
  }

  result.requested_decisions = decisionIdsToDelete.size;
  await queueAlertsForDeletion(linkedDecisionIdsByAlert);
  result.deleted_alerts = linkedDecisionIdsByAlert.size;
  result.deleted_decisions = decisionIdsToDelete.size;
  return result;
}

function getDecisionIdsForAlertIds(alertIds: string[]): string[] {
  const ids: string[] = [];
  const chunkSize = 900;
  for (let offset = 0; offset < alertIds.length; offset += chunkSize) {
    const chunk = alertIds.slice(offset, offset + chunkSize);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(',');
    const rows = database.db.prepare(`SELECT id FROM decisions WHERE alert_id IN (${placeholders})`).all(...chunk) as Array<{ id: string | number }>;
    ids.push(...rows.map((row) => String(row.id)));
  }
  return ids;
}

async function deleteDecisionsByIds(ids: string[]): Promise<BulkDeleteResult> {
  const result = createDeleteResult({ requested_decisions: ids.length });
  const deletedDecisionIds: string[] = [];

  for (const id of ids) {
    try {
      await deleteDecisionFromLapi(id);
      deletedDecisionIds.push(id);
    } catch (error) {
      const typedError = error as AnyError;
      if (isPermissionError(typedError)) {
        throw typedError;
      }
      result.failed.push(toFailure('decision', id, typedError));
    }
  }

  if (deletedDecisionIds.length > 0) {
    await syncWorker.runExclusive(() => {
      const removeDecisions = database.transaction<string[]>((decisionIds) => {
        for (const id of decisionIds) {
          database.deleteDecision(id);
        }
      });
      removeDecisions(deletedDecisionIds);
      database.refreshDecisionDuplicateFlags(new Date().toISOString());
    });
    invalidateDashboardStatsCache();
  }

  result.deleted_decisions = deletedDecisionIds.length;
  return result;
}

async function deleteDecisionsByIdsInChunks(ids: string[]): Promise<BulkDeleteResult> {
  const aggregate = createDeleteResult({ requested_decisions: ids.length });
  const chunkSize = 100;
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    const result = await deleteDecisionsByIds(ids.slice(offset, offset + chunkSize));
    aggregate.deleted_decisions += result.deleted_decisions;
    aggregate.failed.push(...result.failed);
  }
  return aggregate;
}

async function deleteEntriesByIp(ip: string): Promise<BulkDeleteResult> {
  const alerts = getCachedAlertsForDeletion().filter((alert) => alert.sourceValue === ip);
  const decisions = getCachedDecisionsForDeletion().filter((decision) => decision.value === ip);
  const linkedDecisionIdsByAlert = new Map<string, string[]>();
  const linkedDecisionIds = new Set<string>();

  for (const alert of alerts) {
    const ids = getLinkedDecisionIds(alert);
    linkedDecisionIdsByAlert.set(alert.id, ids);
    for (const decisionId of ids) linkedDecisionIds.add(decisionId);
  }

  const standaloneDecisionIds = decisions
    .map((decision) => decision.id)
    .filter((decisionId) => !linkedDecisionIds.has(decisionId));
  const requestedDecisionIds = new Set([...linkedDecisionIds, ...standaloneDecisionIds]);
  const result = createDeleteResult({
    requested_alerts: alerts.length,
    requested_decisions: requestedDecisionIds.size,
    ip,
  });

  if (linkedDecisionIdsByAlert.size > 0) {
    await queueAlertsForDeletion(linkedDecisionIdsByAlert);
  }

  const deletedStandaloneDecisionIds: string[] = [];
  for (const decisionId of standaloneDecisionIds) {
    try {
      await deleteDecisionFromLapi(decisionId);
      deletedStandaloneDecisionIds.push(decisionId);
    } catch (error) {
      const typedError = error as AnyError;
      if (isPermissionError(typedError)) throw typedError;
      result.failed.push(toFailure('decision', decisionId, typedError));
    }
  }

  if (deletedStandaloneDecisionIds.length > 0) {
    await syncWorker.runExclusive(() => {
      const removeDecisions = database.transaction<string[]>((decisionIds) => {
        for (const decisionId of decisionIds) database.deleteDecision(decisionId);
      });
      removeDecisions(deletedStandaloneDecisionIds);
      database.refreshDecisionDuplicateFlags(new Date().toISOString());
    });
    invalidateDashboardStatsCache();
  }

  result.deleted_alerts = linkedDecisionIdsByAlert.size;
  result.deleted_decisions = linkedDecisionIds.size + deletedStandaloneDecisionIds.length;
  return result;
}

async function handleApiError(
  error: AnyError,
  context: HonoContext,
  action: string,
  replayCallback: (() => Promise<Response>) | null,
): Promise<Response> {
  if (error.response?.status === 401) {
    console.log(`Received 401 during ${action}, attempting re-login...`);
    const success = await lapiClient.login(`401 recovery: ${action}`);
    if (success && replayCallback) {
      try {
        return await replayCallback();
      } catch (retryError) {
        console.error(`Retry failed for ${action}: ${(retryError as AnyError).message}`);
        error = retryError as AnyError;
      }
    }
  }

  if (error.response) {
    console.error(`Error ${action}: ${error.response.status}`);
    return context.json({ error: `Request failed with status ${error.response.status}` }, error.response.status);
  }
  if (error.request) {
    console.error(`Error ${action}: No response received`);
    return context.json({ error: 'Bad Gateway: No response from CrowdSec LAPI' }, 502);
  }
  console.error(`Error ${action}: ${error.message}`);
  return context.json({ error: 'Internal server error' }, 500);
}



  return {
    normalizeDeleteIds,
    validateInstanceEntityRefs,
    groupInstanceEntityRefs,
    normalizeNotificationIds,
    isValidIpOrRange,
    isPermissionError,
    getLapiErrorMessage,
    toFailure,
    deleteAlertFromLapi,
    deleteDecisionFromLapi,
    createDeleteResult,
    clearPendingAlertDeletionTimeout,
    processPendingAlertDeletions,
    deleteAlertsByIds,
    deleteDecisionsByIdsInChunks,
    deleteEntriesByIp,
    handleApiError,
  };
}
