import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/**/*.test.ts'],
    setupFiles: ['./server/__tests__/setup.ts'],
    // These tests start the whole app, its workers, and real SQLite databases on disk, so a busy
    // machine can take several times as long as an idle one without anything being wrong.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage/server',
      include: [
        'server/config.ts',
        'server/env-secrets.ts',
        'server/lapi.ts',
        'server/update-check.ts',
        'server/utils/**/*.ts',
      ],
      exclude: ['server/**/*.test.ts'],
    },
  },
});
