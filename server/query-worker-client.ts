import { Worker } from 'node:worker_threads';

type QueryMethod = 'all' | 'get';

type PendingQuery = {
  id: number;
  method: QueryMethod;
  sql: string;
  params: unknown[];
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  worker?: WorkerSlot;
};

type WorkerResponse = {
  id: number;
  rows?: unknown;
  error?: string;
};

type WorkerSlot = {
  worker: Worker;
  currentId: number | null;
};

export class QueryWorkerTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Database query exceeded ${timeoutMs}ms timeout`);
    this.name = 'QueryWorkerTimeoutError';
  }
}

export class DatabaseQueryWorker {
  private readonly dbPath: string;
  private readonly timeoutMs: number;
  private readonly maxWorkers: number;
  private nextId = 1;
  private readonly pending = new Map<number, PendingQuery>();
  private readonly queue: PendingQuery[] = [];
  private readonly workers = new Set<WorkerSlot>();

  constructor(options: { dbPath: string; timeoutMs?: number; maxWorkers?: number }) {
    this.dbPath = options.dbPath;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxWorkers = Math.max(1, options.maxWorkers ?? 3);
  }

  all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.execute<T[]>('all', sql, params);
  }

  get<T>(sql: string, params: unknown[] = []): Promise<T> {
    return this.execute<T>('get', sql, params);
  }

  close(): void {
    this.rejectPending(new Error('Database query worker closed'));
    for (const slot of this.workers) {
      void slot.worker.terminate();
    }
    this.workers.clear();
    this.queue.length = 0;
  }

  private execute<T>(method: QueryMethod, sql: string, params: unknown[]): Promise<T> {
    const id = this.nextId++;

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        this.pending.delete(id);
        const queueIndex = this.queue.indexOf(pending);
        if (queueIndex !== -1) {
          this.queue.splice(queueIndex, 1);
        }
        reject(new QueryWorkerTimeoutError(this.timeoutMs));
        if (pending.worker) {
          this.restartWorker(pending.worker);
        }
      }, this.timeoutMs);

      const pending: PendingQuery = {
        id,
        method,
        sql,
        params,
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      };

      this.pending.set(id, pending);
      this.queue.push(pending);
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (this.queue.length > 0) {
      const slot = this.getIdleWorker() || this.createWorkerIfCapacity();
      if (!slot) {
        return;
      }

      const pending = this.queue.shift();
      if (!pending || !this.pending.has(pending.id)) {
        continue;
      }

      pending.worker = slot;
      slot.currentId = pending.id;
      slot.worker.postMessage({
        id: pending.id,
        method: pending.method,
        sql: pending.sql,
        params: pending.params,
      });
    }
  }

  private getIdleWorker(): WorkerSlot | null {
    for (const slot of this.workers) {
      if (slot.currentId === null) {
        return slot;
      }
    }
    return null;
  }

  private createWorkerIfCapacity(): WorkerSlot | null {
    if (this.workers.size >= this.maxWorkers) {
      return null;
    }

    const isTsRuntime = import.meta.url.endsWith('.ts');
    const worker = new Worker(new URL(`./query-worker.${isTsRuntime ? 'ts' : 'js'}`, import.meta.url), {
      workerData: { dbPath: this.dbPath },
      execArgv: isTsRuntime ? ['--import', 'tsx'] : [],
    });
    const slot: WorkerSlot = { worker, currentId: null };

    worker.on('message', (message: WorkerResponse) => {
      this.handleWorkerMessage(slot, message);
    });

    worker.on('error', (error) => {
      this.handleWorkerFailure(slot, error);
    });

    worker.on('exit', (code) => {
      this.workers.delete(slot);
      if (code !== 0) {
        this.handleWorkerFailure(slot, new Error(`Database query worker exited with code ${code}`));
      }
      this.dispatch();
    });

    this.workers.add(slot);
    return slot;
  }

  private handleWorkerMessage(slot: WorkerSlot, message: WorkerResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      if (slot.currentId === message.id) {
        slot.currentId = null;
      }
      this.dispatch();
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (slot.currentId === message.id) {
      slot.currentId = null;
    }

    if (message.error) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.rows);
    }
    this.dispatch();
  }

  private handleWorkerFailure(slot: WorkerSlot, error: Error): void {
    this.workers.delete(slot);
    if (slot.currentId !== null) {
      const pending = this.pending.get(slot.currentId);
      if (pending) {
        this.pending.delete(slot.currentId);
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      slot.currentId = null;
    }
    this.dispatch();
  }

  private restartWorker(slot: WorkerSlot): void {
    this.workers.delete(slot);
    slot.currentId = null;
    void slot.worker.terminate();
    this.dispatch();
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
