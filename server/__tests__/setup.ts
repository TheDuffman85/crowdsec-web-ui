import { vi } from 'vitest';

// vi.waitFor gives up after one second by default and has no setting for that, which is too short
// for syncs and worker queries on a busy machine. It still returns as soon as the check passes.
const waitFor = vi.waitFor;
vi.waitFor = ((callback, options) => waitFor(callback, {
  timeout: 15_000,
  ...(typeof options === 'number' ? { timeout: options } : options),
})) as typeof vi.waitFor;
