import { Worker } from 'node:worker_threads';

type QueryMethod = 'all' | 'get';

type PendingQuery = {
  id: number;
  method: QueryMethod;
  sql: string;
  params: unknown[];
  label: string;
  queuedAt: number;
  startedAt?: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | null;
  worker?: WorkerSlot;
  signal?: AbortSignal;
  abortListener?: () => void;
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

type QueryOptions = {
  label?: string;
  signal?: AbortSignal;
};

export class QueryWorkerTimeoutError extends Error {
  readonly stage: 'queue' | 'execution';
  readonly label: string;

  constructor(timeoutMs: number, options: { stage?: 'queue' | 'execution'; label?: string } = {}) {
    const stage = options.stage ?? 'execution';
    const label = options.label || 'database query';
    super(stage === 'queue'
      ? `${label} waited more than ${timeoutMs}ms for a database query worker`
      : `${label} exceeded ${timeoutMs}ms execution timeout`);
    this.name = 'QueryWorkerTimeoutError';
    this.stage = stage;
    this.label = label;
  }
}

export class DatabaseQueryWorker {
  private readonly dbPath: string;
  private readonly timeoutMs: number;
  private readonly queueTimeoutMs: number;
  private readonly maxWorkers: number;
  private nextId = 1;
  private readonly pending = new Map<number, PendingQuery>();
  private readonly queue: PendingQuery[] = [];
  private readonly workers = new Set<WorkerSlot>();

  constructor(options: {
    dbPath: string;
    timeoutMs?: number;
    queueTimeoutMs?: number;
    maxWorkers?: number;
  }) {
    this.dbPath = options.dbPath;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.queueTimeoutMs = options.queueTimeoutMs ?? this.timeoutMs;
    this.maxWorkers = Math.max(1, options.maxWorkers ?? 3);
  }

  all<T>(sql: string, params: unknown[] = [], options: QueryOptions = {}): Promise<T[]> {
    return this.execute<T[]>('all', sql, params, options);
  }

  get<T>(sql: string, params: unknown[] = [], options: QueryOptions = {}): Promise<T> {
    return this.execute<T>('get', sql, params, options);
  }

  close(): void {
    this.rejectPending(new Error('Database query worker closed'));
    for (const slot of this.workers) {
      void slot.worker.terminate();
    }
    this.workers.clear();
    this.queue.length = 0;
  }

  private execute<T>(method: QueryMethod, sql: string, params: unknown[], options: QueryOptions): Promise<T> {
    const id = this.nextId++;
    const label = options.label?.trim() || describeQuery(sql);

    return new Promise<T>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(createAbortError());
        return;
      }
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending || pending.worker) return;
        this.pending.delete(id);
        this.removeAbortListener(pending);
        const queueIndex = this.queue.indexOf(pending);
        if (queueIndex !== -1) {
          this.queue.splice(queueIndex, 1);
        }
        const waitedMs = Date.now() - pending.queuedAt;
        console.warn(
          `[query-worker] ${pending.label} timed out in queue after ${waitedMs}ms `
          + `(queued=${this.queue.length}, active=${this.activeWorkerCount()}/${this.maxWorkers}).`,
        );
        reject(new QueryWorkerTimeoutError(this.queueTimeoutMs, {
          stage: 'queue',
          label: pending.label,
        }));
      }, this.queueTimeoutMs);

      const pending: PendingQuery = {
        id,
        method,
        sql,
        params,
        label,
        queuedAt: Date.now(),
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
        signal: options.signal,
      };
      if (options.signal) {
        pending.abortListener = () => this.abortPending(id);
        options.signal.addEventListener('abort', pending.abortListener, { once: true });
      }

      this.pending.set(id, pending);
      this.queue.push(pending);
      if (options.signal?.aborted) {
        this.abortPending(id);
        return;
      }
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
      pending.startedAt = Date.now();
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.timeout = setTimeout(() => {
        if (!this.pending.delete(pending.id)) return;
        this.removeAbortListener(pending);
        const executedMs = Date.now() - (pending.startedAt || pending.queuedAt);
        console.warn(
          `[query-worker] ${pending.label} timed out during execution after ${executedMs}ms `
          + `(queued=${this.queue.length}, active=${this.activeWorkerCount()}/${this.maxWorkers}).`,
        );
        pending.reject(new QueryWorkerTimeoutError(this.timeoutMs, {
          stage: 'execution',
          label: pending.label,
        }));
        this.restartWorker(slot);
      }, this.timeoutMs);
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
    if (pending.timeout) clearTimeout(pending.timeout);
    this.removeAbortListener(pending);
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
        if (pending.timeout) clearTimeout(pending.timeout);
        this.removeAbortListener(pending);
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
      if (pending.timeout) clearTimeout(pending.timeout);
      this.removeAbortListener(pending);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private abortPending(id: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timeout) clearTimeout(pending.timeout);
    this.removeAbortListener(pending);

    if (pending.worker) {
      const slot = pending.worker;
      if (slot.currentId === id) {
        this.workers.delete(slot);
        slot.currentId = null;
        void slot.worker.terminate();
      }
    } else {
      const queueIndex = this.queue.indexOf(pending);
      if (queueIndex !== -1) this.queue.splice(queueIndex, 1);
    }

    pending.reject(createAbortError());
    this.dispatch();
  }

  private removeAbortListener(pending: PendingQuery): void {
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener('abort', pending.abortListener);
      pending.abortListener = undefined;
    }
  }

  private activeWorkerCount(): number {
    let active = 0;
    for (const slot of this.workers) {
      if (slot.currentId !== null) active += 1;
    }
    return active;
  }
}

function createAbortError(): Error {
  const error = new Error('Database query aborted');
  error.name = 'AbortError';
  return error;
}

function describeQuery(sql: string): string {
  const normalized = sql.replace(/\s+/g, ' ').trim();
  const operation = normalized.match(/\b(?:FROM|UPDATE|INTO|DELETE FROM)\s+([A-Za-z0-9_]+)/i)?.[1];
  return operation ? `${operation} query` : 'database query';
}
