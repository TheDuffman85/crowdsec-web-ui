import { DatabaseWorker } from './database-worker';
import { isWorkerReadyMessage } from './worker-lifecycle';

// Separate instances isolate consolidation from historical reads and from all
// existing application query pools. Each process handles one request at a time.
export class StatisticsWorkerClient {
  private worker: DatabaseWorker | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private nextId = 0;
  private closed = false;

  constructor(private readonly options: { dbPath: string; timeZone?: string; readonly?: boolean; walEnabled: boolean; incrementalVacuumEnabled: boolean; journalSizeLimitBytes: number }) {}

  request<T>(request: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Statistics worker closed'));
    if (this.pending >= 8) return Promise.reject(new Error('Statistics query queue is full; retry shortly'));
    this.pending++;
    const operation = this.queue.then(() => this.dispatch<T>(request));
    this.queue = operation.catch(() => undefined).finally(() => { this.pending--; });
    return operation;
  }

  close(): void { this.closed = true; void this.worker?.terminate(); this.worker = null; }

  private dispatch<T>(request: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Statistics worker closed'));
    if (this.worker?.exited) this.worker = null;
    return new Promise((resolve, reject) => {
      const worker = this.worker ??= new DatabaseWorker(!import.meta.url.endsWith('.ts')
        ? new URL('./statistics-worker.js', import.meta.url) : new URL('./statistics-worker.ts', import.meta.url), {
        workerData: this.options,
        execArgv: import.meta.url.endsWith('.ts') ? ['--import', 'tsx'] : [],
      });
      worker.unref();
      const id = ++this.nextId;
      const cleanup = () => {
        clearTimeout(timeout);
        worker.removeListener('message', message);
        worker.removeListener('error', fail);
        worker.removeListener('exit', exited);
      };
      const fail = (error: Error) => {
        cleanup();
        if (this.worker === worker) this.worker = null;
        void worker.terminate();
        reject(error);
      };
      const exited = () => fail(new Error('Statistics worker exited'));
      const message = (response: { id?: number; error?: string; result?: T }) => {
        if (isWorkerReadyMessage(response) || response.id !== id) return;
        cleanup();
        if (response.error) reject(new Error(response.error));
        else resolve(response.result as T);
      };
      const timeout = setTimeout(() => fail(new Error('Statistics worker exceeded its 30-second timeout')), 30_000);
      worker.on('message', message);
      worker.once('error', fail);
      worker.once('exit', exited);
      try { worker.postMessage({ id, request }); } catch (error) { fail(error as Error); }
    });
  }
}
