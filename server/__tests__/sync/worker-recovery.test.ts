import { afterEach, describe, expect, test, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseWorker as Worker } from '../../database-worker';
import { CrowdsecDatabase } from '../../database';
import { DatabaseSyncWorker } from '../../sync-worker-client';

type Request = { id: number; request: { type: string } };
type Response = { id: number; error?: string };
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createWorker(timeoutMs = 5_000) {
  const dir = mkdtempSync(path.join(tmpdir(), 'crowdsec-web-ui-sync-recovery-'));
  const database = new CrowdsecDatabase({ dbPath: path.join(dir, 'test.db') });
  const client = new DatabaseSyncWorker({ dbPath: database.dbPath, timeoutMs });
  const threads = new Set<Worker>();
  cleanups.push(async () => {
    const exits = [...threads].filter((thread) => !thread.exited).map((thread) => (
      new Promise<void>((resolve) => thread.once('exit', () => resolve()))
    ));
    client.close();
    await Promise.all(exits);
    database.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function captureThread() {
    let thread!: Worker;
    const postMessage = Worker.prototype.postMessage;
    const spy = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, value) {
      thread = this;
      threads.add(thread);
      postMessage.call(this, value);
    });
    try {
      await client.setMeta('worker_ready', 'true');
    } finally {
      spy.mockRestore();
    }
    return thread;
  }

  const thread = await captureThread();
  return { database, client, thread, captureThread };
}

// Delay acknowledgements after the real worker has executed the SQL. This
// exercises uncertain transaction state without depending on slow hardware.
function dropReply(thread: Worker, requestType: string) {
  const requests: string[] = [];
  const typesById = new Map<number, string>();
  let received!: () => void;
  const replyDropped = new Promise<void>((resolve) => { received = resolve; });
  const postMessage = thread.postMessage.bind(thread);
  vi.spyOn(thread, 'postMessage').mockImplementation((value) => {
    const message = value as Request;
    requests.push(message.request.type);
    typesById.set(message.id, message.request.type);
    postMessage(message);
  });
  const onMessage = thread.listeners('message')[0] as (message: Response) => void;
  thread.off('message', onMessage);
  thread.on('message', (message: Response) => {
    if (typesById.get(message.id) === requestType) received();
    else onMessage(message);
  });
  return { requests, replyDropped };
}

describe('DatabaseSyncWorker recovery', () => {
  test.each(['begin-transaction', 'refresh-duplicate-flags'])(
    'releases locks and retries after a timed-out %s acknowledgement',
    async (requestType) => {
      const { database, client, thread, captureThread } = await createWorker();
      const { requests, replyDropped } = dropReply(thread, requestType);
      const exited = once(thread, 'exit');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const operation = vi.fn(async () => {
        await client.setMeta('uncommitted', 'true');
        await client.refreshDecisionDuplicateFlags(new Date().toISOString());
      });
      const failed = expect(client.runTransaction(operation)).rejects.toThrow('ms timeout');
      await replyDropped;
      await vi.advanceTimersByTimeAsync(requestType === 'begin-transaction' ? 5_000 : 120_000);
      await failed;
      await exited;
      vi.useRealTimers();

      expect(requests).not.toContain('rollback-transaction');
      if (requestType === 'begin-transaction') expect(operation).not.toHaveBeenCalled();
      expect(database.getMeta('uncommitted')).toBeNull();
      await client.runExclusive(() => database.setMeta('other_writer', 'available'));
      await captureThread();
      await client.runTransaction(() => client.setMeta('after_timeout', 'committed'));
      expect(database.getMeta('other_writer')?.value).toBe('available');
      expect(database.getMeta('after_timeout')?.value).toBe('committed');
    },
  );

  test('retires a connection after failed rollback and ignores its late events during the next BEGIN', async () => {
    const { database, client, thread, captureThread } = await createWorker();
    const onExit = thread.listeners('exit')[0];
    const onError = thread.listeners('error')[0];
    const onMessage = thread.listeners('message')[0];
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const postMessage = thread.postMessage.bind(thread);
    vi.spyOn(thread, 'postMessage').mockImplementation((value) => {
      const message = value as Request;
      if (message.request.type === 'rollback-transaction') {
        queueMicrotask(() => thread.emit('message', { id: message.id, error: 'injected rollback failure' }));
      } else postMessage(message);
    });
    await expect(client.runTransaction(async () => {
      await client.setMeta('uncommitted', 'true');
      throw new Error('refresh failed');
    })).rejects.toThrow('refresh failed');
    expect(log).toHaveBeenCalledWith('Failed to roll back database refresh transaction:', 'injected rollback failure');
    expect(thread.exited).toBe(true);
    expect(database.getMeta('uncommitted')).toBeNull();

    const replacement = await captureThread();
    const replacementPostMessage = replacement.postMessage.bind(replacement);
    vi.spyOn(replacement, 'postMessage').mockImplementation((value) => {
      const message = value as Request;
      replacementPostMessage(message);
      if (message.request.type === 'begin-transaction') {
        // Reproduce an old worker's callbacks arriving while the replacement
        // has a pending BEGIN. None may reject the replacement's request.
        queueMicrotask(() => {
          onExit(1);
          onError(new Error('obsolete worker failed'));
          onMessage({ id: message.id, error: 'obsolete worker response' });
        });
      }
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      await client.runTransaction(() => client.setMeta('after_failure', String(attempt)));
    }
    await client.runExclusive(() => database.setMeta('other_writer', 'available'));
    expect(database.getMeta('after_failure')?.value).toBe('2');
    expect(database.getMeta('other_writer')?.value).toBe('available');
  });

  test('does not let a swallowed worker failure continue a transaction on a new connection', async () => {
    const { database, client, thread, captureThread } = await createWorker();
    await expect(client.runTransaction(async () => {
      await client.setMeta('uncommitted', 'true');
      thread.emit('error', new Error('injected worker failure'));
      await expect(client.setMeta('escaped_write', 'true')).rejects.toThrow('no longer available');
      // Returning normally must still fail the commit of the lost transaction.
    })).rejects.toThrow('no longer available');

    expect(database.getMeta('uncommitted')).toBeNull();
    expect(database.getMeta('escaped_write')).toBeNull();
    await captureThread();
    await client.runTransaction(() => client.setMeta('after_failure', 'committed'));
    expect(database.getMeta('after_failure')?.value).toBe('committed');
  });

  test('holds queued main-thread writes until the timed-out worker has actually exited', async () => {
    const { database, client, thread } = await createWorker();
    const { replyDropped } = dropReply(thread, 'refresh-duplicate-flags');
    let releaseTermination!: () => void;
    const terminationGate = new Promise<void>((resolve) => { releaseTermination = resolve; });
    const terminate = thread.terminate.bind(thread);
    const terminateSpy = vi.spyOn(thread, 'terminate').mockImplementation(async () => {
      await terminationGate;
      return terminate();
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const failed = expect(client.runTransaction(async () => {
      await client.setMeta('uncommitted', 'true');
      await client.refreshDecisionDuplicateFlags(new Date().toISOString());
    })).rejects.toThrow('120000ms timeout');
    let wrote = false;
    const write = client.runExclusive(() => {
      expect(thread.exited).toBe(true);
      database.setMeta('other_writer', 'available');
      wrote = true;
    });
    try {
      await replyDropped;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(terminateSpy).toHaveBeenCalledOnce();
      expect(wrote).toBe(false);
      expect(database.getMeta('uncommitted')).toBeNull();
    } finally {
      releaseTermination();
      await failed;
      await write;
    }
    expect(wrote).toBe(true);
    expect(database.getMeta('other_writer')?.value).toBe('available');
  });
});


test('terminates executing native SQL, rolls back its transaction, and releases queued writes', async () => {
  const { database, client, thread, captureThread } = await createWorker(500);
  database.db.exec(`
    CREATE TRIGGER slow_meta BEFORE INSERT ON meta WHEN NEW.key = 'hang' BEGIN
      SELECT (WITH RECURSIVE c(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM c WHERE v < 1000000000000)
        SELECT COUNT(*) FROM c);
    END;
  `);
  const failed = expect(client.runTransaction(async () => {
    await client.setMeta('uncommitted', 'true');
    await client.setMeta('hang', 'true');
  })).rejects.toThrow('500ms timeout');
  const queued = client.runExclusive(() => {
    expect(thread.exited).toBe(true);
    database.setMeta('other_writer', 'available');
  });
  await failed;
  await queued;
  expect(database.getMeta('uncommitted')).toBeNull();
  expect(database.getMeta('other_writer')?.value).toBe('available');
  database.db.exec('DROP TRIGGER slow_meta');
  await captureThread();
  await client.runTransaction(() => client.setMeta('after_failure', 'committed'));
  expect(database.getMeta('after_failure')?.value).toBe('committed');
}, 10000);
