import type { DatabaseWorker } from './database-worker';

export type WorkerReadyMessage = { ready: true };

export function isWorkerReadyMessage(message: unknown): message is WorkerReadyMessage {
  return typeof message === 'object' && message !== null && (message as WorkerReadyMessage).ready === true;
}

export function terminateWorker(worker: DatabaseWorker): void {
  void worker.terminate();
}
