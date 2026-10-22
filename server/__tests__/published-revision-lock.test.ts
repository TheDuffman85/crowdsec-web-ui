import { afterEach, expect, test, vi } from 'vitest';
import { PublishedRevisionLock } from '../published-revision-lock';

afterEach(() => vi.useRealTimers());

test('removes timed-out writers without blocking readers or acquiring a late lock', async () => {
  vi.useFakeTimers();
  const lock = new PublishedRevisionLock(1000);
  const read = await lock.acquireRead();
  const failure = expect(lock.acquireWrite()).rejects.toThrow('Cache publication waited');
  const waitingRead = lock.acquireRead();
  await vi.advanceTimersByTimeAsync(1000);
  await failure;
  const readAgain = await waitingRead;
  read();
  readAgain();
  const write = await lock.acquireWrite();
  write();
  (await lock.acquireRead())();
  expect(vi.getTimerCount()).toBe(0);
});

test('preserves writer ordering and only releases readers after the committed revision', async () => {
  vi.useFakeTimers();
  const lock = new PublishedRevisionLock(1000);
  const first = await lock.acquireWrite();
  const second = lock.acquireWrite();
  let readAcquired = false;
  const read = lock.acquireRead().then(release => { readAcquired = true; return release; });
  first();
  first();
  const releaseSecond = await second;
  expect(readAcquired).toBe(false);
  releaseSecond();
  (await read)();
  expect(vi.getTimerCount()).toBe(0);
});
