import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage/server',
      include: [
        'server/config.ts',
        'server/lapi.ts',
        'server/update-check.ts',
        'server/utils/**/*.ts',
      ],
      exclude: ['server/**/*.test.ts'],
    },
  },
});
