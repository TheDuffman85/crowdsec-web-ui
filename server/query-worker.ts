import BetterSqlite3 from 'better-sqlite3';
import { parentPort, workerData } from 'node:worker_threads';
import { matchesIpSearchValue } from '../shared/search';
import { installTimestampedConsole } from './logging';

type WorkerRequest = {
  id: number;
  method: 'all' | 'get';
  sql: string;
  params: unknown[];
};

type WorkerResponse = {
  id: number;
  rows?: unknown;
  error?: string;
};

type WorkerData = {
  dbPath: string;
};

const { dbPath } = workerData as WorkerData;
installTimestampedConsole();
const database = new BetterSqlite3(dbPath, {
  fileMustExist: true,
  readonly: true,
  timeout: 1_000,
});

database.pragma('foreign_keys = ON');
database.pragma('query_only = ON');
database.pragma('busy_timeout = 1000');
database.pragma('cache_size = -32000');
database.pragma('temp_store = MEMORY');
database.pragma('mmap_size = 268435456');

try {
  database.function('matches_ip_search_value', { deterministic: true }, (candidate: unknown, value: unknown) =>
    matchesIpSearchValue(candidate as string | number | null | undefined, String(value ?? '')) ? 1 : 0,
  );
} catch {
  // Older better-sqlite3 builds may not expose custom functions; SQL callers also keep LIKE fallbacks.
}

parentPort?.on('message', (request: WorkerRequest) => {
  const response: WorkerResponse = { id: request.id };
  try {
    const statement = database.prepare(request.sql);
    response.rows = request.method === 'all'
      ? statement.all(...request.params)
      : statement.get(...request.params);
  } catch (error) {
    response.error = error instanceof Error ? error.message : String(error);
  }
  parentPort?.postMessage(response);
});
