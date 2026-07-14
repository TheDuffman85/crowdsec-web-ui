import { Worker } from 'node:worker_threads';
import type { AlertInsertParams, DecisionInsertParams } from './database';

export type DatabaseWrite = <T>(operation: () => T | Promise<T>) => Promise<T>;

interface SyncAlertMutationBase {
  decisions: DecisionInsertParams[];
  keepDecisionIds: string[];
  reconcileDecisions?: boolean;
}

export type SyncAlertMutation = SyncAlertMutationBase & (
  | { alert: AlertInsertParams; alertId?: never }
  | { alert?: never; alertId: string | number }
);

type SyncWorkerRequest =
  | { type: 'persist-alerts'; mutations: SyncAlertMutation[] }
  | { type: 'delete-alerts-missing-between'; start: string; end: string; keepIds: Array<string | number> }
  | { type: 'delete-cached-alerts'; ids: Array<string | number> }
  | { type: 'delete-cached-decisions'; ids: Array<string | number> }
  | { type: 'begin-deferred-search-indexes' }
  | { type: 'rebuild-search-indexes' }
  | { type: 'refresh-duplicate-flags'; now: string }
  | { type: 'cleanup-old-data'; cutoff: string }
  | { type: 'clear-sync-data' };

type SyncWorkerResponse = {
  id: number;
  result?: unknown;
  error?: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class DatabaseSyncWorker {
  private readonly dbPath: string;
  private readonly timeoutMs: number;
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: { dbPath: string; timeoutMs?: number }) {
    this.dbPath = options.dbPath;
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
  }

  persistAlerts(mutations: SyncAlertMutation[]): Promise<{ changed: boolean }> {
    return this.execute({ type: 'persist-alerts', mutations });
  }

  deleteAlertsMissingBetween(
    start: string,
    end: string,
    keepIds: Array<string | number>,
  ): Promise<{ alerts: number; decisions: number }> {
    return this.execute({ type: 'delete-alerts-missing-between', start, end, keepIds });
  }

  deleteCachedAlerts(ids: Array<string | number>): Promise<{ alerts: number; decisions: number }> {
    return this.execute({ type: 'delete-cached-alerts', ids });
  }

  deleteCachedDecisions(ids: Array<string | number>): Promise<number> {
    return this.execute({ type: 'delete-cached-decisions', ids });
  }

  beginDeferredSearchIndexUpdates(): Promise<void> {
    return this.execute({ type: 'begin-deferred-search-indexes' });
  }

  rebuildSearchIndexes(): Promise<void> {
    return this.execute({ type: 'rebuild-search-indexes' });
  }

  refreshDecisionDuplicateFlags(now: string): Promise<void> {
    return this.execute({ type: 'refresh-duplicate-flags', now });
  }

  cleanupOldData(cutoff: string): Promise<{ alerts: number; decisions: number }> {
    return this.execute({ type: 'cleanup-old-data', cutoff });
  }

  clearSyncData(): Promise<void> {
    return this.execute({ type: 'clear-sync-data' });
  }

  runExclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  close(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(id);
    }
    if (this.worker) {
      void this.worker.terminate();
      this.worker = null;
    }
  }

  private execute<T>(request: SyncWorkerRequest): Promise<T> {
    return this.runExclusive(() => this.dispatch<T>(request));
  }

  private dispatch<T>(request: SyncWorkerRequest): Promise<T> {
    const worker = this.getWorker();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`Database maintenance exceeded ${this.timeoutMs}ms timeout`));
        this.restartWorker();
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      worker.postMessage({ id, request });
    });
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    const isTsRuntime = import.meta.url.endsWith('.ts');
    const worker = new Worker(new URL(`./sync-worker.${isTsRuntime ? 'ts' : 'js'}`, import.meta.url), {
      workerData: { dbPath: this.dbPath },
      execArgv: isTsRuntime ? ['--import', 'tsx'] : [],
    });
    worker.on('message', (message: SyncWorkerResponse) => this.handleMessage(message));
    worker.on('error', (error) => this.handleFailure(error));
    worker.on('exit', (code) => {
      if (this.worker === worker) this.worker = null;
      if (code !== 0) this.handleFailure(new Error(`Database sync worker exited with code ${code}`));
    });
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private handleMessage(message: SyncWorkerResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  }

  private handleFailure(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private restartWorker(): void {
    const worker = this.worker;
    this.worker = null;
    if (worker) void worker.terminate();
  }
}
