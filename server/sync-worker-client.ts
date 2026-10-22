import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseWorker as Worker } from './database-worker';
import { isWorkerReadyMessage, terminateWorker, type WorkerReadyMessage } from './worker-lifecycle';
import type {
  AlertInsertParams,
  DecisionInsertParams,
  IncrementalVacuumOptions,
  IncrementalVacuumResult,
  SearchIndexRebuildScope,
} from './database';

export type DatabaseWrite = <T>(operation: () => T | Promise<T>) => Promise<T>;

interface SyncAlertMutationBase {
  instanceId?: string;
  decisions: DecisionInsertParams[];
  keepDecisionIds: string[];
  reconcileDecisions?: boolean;
  updateAlertRawDataOnly?: boolean;
}

export type SyncAlertMutation = SyncAlertMutationBase & (
  | { alert: AlertInsertParams; alertId?: never }
  | { alert?: never; alertId: string | number }
);

export interface AlertDecisionComparison {
  alertId: string | number;
  instanceId: string;
  metadataHash: string | null;
  decisionIds: string[];
  inactiveDecisionIds: string[];
  observedAt: string;
  origins: string | null;
  simulated: number;
}

export interface AlertDecisionComparisonResult {
  alertId: string | number;
  decisionIdsToPersist: string[] | null;
  removedIds: string[];
  reconcileDecisions: boolean;
  updateAlertRawDataOnly: boolean;
}

export interface DatabaseTransactionOptions {
  beforeCommit?: () => void | Promise<void>;
}

type SyncWorkerRequest =
  | { type: 'set-meta'; key: string; value: string }
  | { type: 'persist-alerts'; mutations: SyncAlertMutation[] }
  | { type: 'compare-alert-decisions'; comparisons: AlertDecisionComparison[] }
  | { type: 'delete-alerts-missing-between'; start: string; end: string; keepIds: Array<string | number>; instanceId?: string }
  | { type: 'delete-cached-alerts'; ids: Array<string | number> }
  | { type: 'delete-cached-decisions'; ids: Array<string | number> }
  | { type: 'begin-deferred-search-indexes'; dropSecondaryIndexes: boolean; clearSearchIndexes: boolean }
  | { type: 'rebuild-search-indexes'; scope?: SearchIndexRebuildScope }
  | { type: 'refresh-duplicate-flags'; now: string }
  | { type: 'cleanup-old-data'; cutoff: string }
  | ({ type: 'incremental-vacuum' } & IncrementalVacuumOptions)
  | { type: 'begin-transaction' }
  | { type: 'commit-transaction' }
  | { type: 'rollback-transaction' }
  | { type: 'clear-sync-data' };

type SyncWorkerResponse = {
  id: number;
  result?: unknown;
  error?: string;
};

const DUPLICATE_REFRESH_TIMEOUT_MS = 2 * 60_000;

type PendingRequest = {
  worker: Worker;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class DatabaseSyncWorker {
  private readonly dbPath: string;
  private readonly walEnabled: boolean;
  private readonly incrementalVacuumEnabled: boolean;
  private readonly journalSizeLimitBytes: number;
  private readonly timeoutMs: number;
  private worker: Worker | null = null;
  private workerShutdown: Promise<void> | null = null;
  private closed = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly transactionContext = new AsyncLocalStorage<{ worker: Worker; active: boolean }>();

  constructor(options: {
    dbPath: string;
    walEnabled?: boolean;
    incrementalVacuumEnabled?: boolean;
    journalSizeLimitBytes?: number;
    timeoutMs?: number;
  }) {
    this.dbPath = options.dbPath;
    this.walEnabled = options.walEnabled ?? true;
    this.incrementalVacuumEnabled = options.incrementalVacuumEnabled ?? true;
    this.journalSizeLimitBytes = options.journalSizeLimitBytes ?? 128 * 1024 * 1024;
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
  }

  persistAlerts(mutations: SyncAlertMutation[]): Promise<{ changed: boolean }> {
    return this.execute({ type: 'persist-alerts', mutations });
  }

  compareAlertDecisions(
    comparisons: AlertDecisionComparison[],
  ): Promise<Array<AlertDecisionComparisonResult | null>> {
    return this.execute({ type: 'compare-alert-decisions', comparisons });
  }

  deleteAlertsMissingBetween(
    start: string,
    end: string,
    keepIds: Array<string | number>,
    instanceId?: string,
  ): Promise<{ alerts: number; decisions: number }> {
    return this.execute({ type: 'delete-alerts-missing-between', start, end, keepIds, instanceId });
  }

  deleteCachedAlerts(ids: Array<string | number>): Promise<{ alerts: number; decisions: number }> {
    return this.execute({ type: 'delete-cached-alerts', ids });
  }

  deleteCachedDecisions(ids: Array<string | number>): Promise<number> {
    return this.execute({ type: 'delete-cached-decisions', ids });
  }

  beginDeferredSearchIndexUpdates(dropSecondaryIndexes = true, clearSearchIndexes = true): Promise<void> {
    return this.execute({ type: 'begin-deferred-search-indexes', dropSecondaryIndexes, clearSearchIndexes });
  }

  rebuildSearchIndexes(scope?: SearchIndexRebuildScope): Promise<void> {
    return this.execute({ type: 'rebuild-search-indexes', scope });
  }

  refreshDecisionDuplicateFlags(now: string): Promise<void> {
    return this.execute({ type: 'refresh-duplicate-flags', now }, DUPLICATE_REFRESH_TIMEOUT_MS);
  }

  cleanupOldData(cutoff: string): Promise<{ alerts: number; decisions: number }> {
    return this.execute({ type: 'cleanup-old-data', cutoff });
  }

  runIncrementalVacuum(options: IncrementalVacuumOptions): Promise<IncrementalVacuumResult> {
    return this.execute({ type: 'incremental-vacuum', ...options });
  }

  clearSyncData(): Promise<void> {
    return this.execute({ type: 'clear-sync-data' });
  }

  setMeta(key: string, value: string): Promise<void> {
    return this.execute({ type: 'set-meta', key, value });
  }

  runExclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.operationQueue.then(() => {
      // Main-thread writes share this queue too. They must wait until a failed
      // worker has closed its SQLite connection and released its write lock.
      const run = () => {
        if (this.closed) throw new Error('Database sync worker is closed');
        return operation();
      };
      return this.workerShutdown ? this.workerShutdown.then(run) : run();
    });
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  runTransaction<T>(operation: () => Promise<T>, options: DatabaseTransactionOptions = {}): Promise<T> {
    return this.runExclusive(async () => {
      const worker = this.getWorker();
      const context = { worker, active: true };
      let began = false;
      try {
        await this.dispatch<void>({ type: 'begin-transaction' }, this.timeoutMs, worker);
        began = true;
        const result = await this.transactionContext.run(context, operation);
        await options.beforeCommit?.();
        await this.dispatch<void>({ type: 'commit-transaction' }, this.timeoutMs, worker);
        return result;
      } catch (error) {
        context.active = false;
        // A replacement connection cannot roll back this transaction. A timeout
        // or worker failure already retires the connection that owned it.
        if (this.worker === worker) {
          if (began) {
            try {
              await this.dispatch<void>({ type: 'rollback-transaction' }, this.timeoutMs, worker);
            } catch (rollbackError) {
              console.error(
                'Failed to roll back database refresh transaction:',
                rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
              );
            }
          }
          // Reload in-memory duplicate/index tracking from committed data after
          // an abort, even when SQL rollback succeeded.
          this.retireWorker(worker, error instanceof Error ? error : new Error(String(error)));
        }
        if (this.workerShutdown) await this.workerShutdown;
        throw error;
      } finally {
        context.active = false;
      }
    });
  }

  close(): void {
    this.closed = true;
    if (this.worker) this.retireWorker(this.worker, new Error('Database sync worker is closed'));
  }

  private execute<T>(request: SyncWorkerRequest, timeoutMs = this.timeoutMs): Promise<T> {
    const context = this.transactionContext.getStore();
    if (context) {
      if (!context.active) return Promise.reject(new Error('Database refresh transaction is no longer active'));
      return this.dispatch<T>(request, timeoutMs, context.worker);
    }
    return this.runExclusive(() => this.dispatch<T>(request, timeoutMs, this.getWorker()));
  }

  private dispatch<T>(request: SyncWorkerRequest, timeoutMs: number, worker: Worker): Promise<T> {
    if (this.closed || this.worker !== worker) {
      return Promise.reject(new Error('Database refresh worker is no longer available'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.retireWorker(worker, new Error(`Database maintenance exceeded ${timeoutMs}ms timeout (${request.type})`));
      }, timeoutMs);
      this.pending.set(id, {
        worker,
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      try {
        worker.postMessage({ id, request });
      } catch (error) {
        this.retireWorker(worker, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    const isTsRuntime = import.meta.url.endsWith('.ts');
    const worker = new Worker(new URL(`./sync-worker.${isTsRuntime ? 'ts' : 'js'}`, import.meta.url), {
      workerData: {
        dbPath: this.dbPath,
        walEnabled: this.walEnabled,
        incrementalVacuumEnabled: this.incrementalVacuumEnabled,
        journalSizeLimitBytes: this.journalSizeLimitBytes,
      },
      execArgv: isTsRuntime ? ['--import', 'tsx'] : [],
    });
    worker.on('message', (message: SyncWorkerResponse | WorkerReadyMessage) => {
      if (isWorkerReadyMessage(message)) return;
      this.handleMessage(worker, message);
    });
    worker.on('error', (error) => this.retireWorker(worker, error));
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.rejectPending(worker, new Error(`Database sync worker exited with code ${code}`));
    });
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private handleMessage(worker: Worker, message: SyncWorkerResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending || pending.worker !== worker) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  }

  private rejectPending(worker: Worker, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.worker !== worker) continue;
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private retireWorker(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    if (!this.closed) console.warn(`Retiring database sync worker: ${error.message}`);
    const shutdown = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
    this.workerShutdown = shutdown;
    void shutdown.then(() => {
      if (this.workerShutdown === shutdown) this.workerShutdown = null;
    });
    this.rejectPending(worker, error);
    terminateWorker(worker);
  }
}
