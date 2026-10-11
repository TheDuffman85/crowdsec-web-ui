import type { Worker } from 'node:worker_threads';

// Terminating a worker while it is still registering the better-sqlite3 native addon aborts the
// whole process (FATAL ERROR: Error::New napi_get_last_error_info). Workers announce when their
// database is open, and termination requested before that point is deferred until then.

export type WorkerReadyMessage = { ready: true };

const readyWorkers = new WeakSet<Worker>();
const deferredTerminations = new WeakSet<Worker>();

export function isWorkerReadyMessage(message: unknown): message is WorkerReadyMessage {
  return typeof message === 'object' && message !== null && (message as WorkerReadyMessage).ready === true;
}

export function markWorkerReady(worker: Worker): void {
  readyWorkers.add(worker);
  if (deferredTerminations.delete(worker)) {
    void worker.terminate();
  }
}

export function terminateWorker(worker: Worker): void {
  if (readyWorkers.has(worker)) {
    void worker.terminate();
    return;
  }
  deferredTerminations.add(worker);
}
