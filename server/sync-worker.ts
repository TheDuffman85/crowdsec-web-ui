import { parentPort, workerData } from 'node:worker_threads';
import { CrowdsecDatabase } from './database';
import { installTimestampedConsole } from './logging';
import type { SyncAlertMutation } from './sync-worker-client';

type WorkerRequest = {
  id: number;
  request: {
    type: string;
    [key: string]: unknown;
  };
};

installTimestampedConsole();
const workerOptions = workerData as { dbPath: string; walEnabled?: boolean };
const database = new CrowdsecDatabase({
  dbPath: String(workerOptions.dbPath),
  walEnabled: workerOptions.walEnabled ?? true,
});

parentPort?.on('message', (message: WorkerRequest) => {
  const response: { id: number; result?: unknown; error?: string } = { id: message.id };
  try {
    response.result = execute(message.request);
  } catch (error) {
    response.error = error instanceof Error ? error.message : String(error);
  }
  parentPort?.postMessage(response);
});

function execute(request: WorkerRequest['request']): unknown {
  if (request.type === 'persist-alerts') {
    const mutations = request.mutations as SyncAlertMutation[];
    database.refreshAlertDeletionTombstones();
    let changed = false;
    const persist = database.transaction<SyncAlertMutation[]>((items) => {
      for (const mutation of items) {
        const alertId = mutation.alert?.$id ?? mutation.alertId;
        if (alertId === undefined) {
          throw new Error('Split alert mutation is missing an alert ID');
        }
        if (mutation.alert) {
          changed = mutation.updateAlertRawDataOnly
            ? database.updateAlertRawData(mutation.alert.$id, mutation.alert.$raw_data, mutation.instanceId) || changed
            : database.insertAlert(mutation.alert) || changed;
        }
        for (const decision of mutation.decisions) {
          changed = database.insertDecision(decision) || changed;
        }
        if (mutation.reconcileDecisions !== false) {
          changed = database.deleteDecisionsByAlertIdExcept(
            alertId,
            mutation.keepDecisionIds,
            mutation.instanceId,
          ) > 0 || changed;
        }
      }
    });
    persist(mutations);
    return { changed };
  }

  if (request.type === 'delete-alerts-missing-between') {
    return database.deleteAlertsMissingBetween(
      String(request.start),
      String(request.end),
      request.keepIds as Array<string | number>,
      request.instanceId ? String(request.instanceId) : undefined,
    );
  }
  if (request.type === 'delete-cached-alerts') {
    return database.deleteCachedAlerts(request.ids as Array<string | number>);
  }
  if (request.type === 'delete-cached-decisions') {
    return database.deleteCachedDecisions(request.ids as Array<string | number>);
  }
  if (request.type === 'begin-deferred-search-indexes') {
    database.beginDeferredSearchIndexUpdates(
      request.dropSecondaryIndexes !== false,
      request.clearSearchIndexes !== false,
    );
    return undefined;
  }
  if (request.type === 'rebuild-search-indexes') {
    database.rebuildSearchIndexes(request.scope as Parameters<typeof database.rebuildSearchIndexes>[0]);
    return undefined;
  }
  if (request.type === 'refresh-duplicate-flags') {
    return database.refreshDecisionDuplicateFlags(String(request.now));
  }
  if (request.type === 'cleanup-old-data') {
    const cutoff = String(request.cutoff);
    return {
      alerts: database.deleteOldAlerts(cutoff),
      decisions: database.deleteOldDecisions(cutoff),
    };
  }
  if (request.type === 'clear-sync-data') {
    database.clearSyncData();
    return undefined;
  }
  throw new Error(`Unknown database sync worker operation: ${request.type}`);
}
