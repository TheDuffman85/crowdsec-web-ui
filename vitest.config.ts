import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/backend/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage/backend',
      include: [
        'src/backend/config.ts',
        'src/backend/lapi.ts',
        'src/backend/update-check.ts',
        'src/backend/utils/**/*.ts',
      ],
      exclude: [
        'src/backend/**/*.test.ts',
      ],
    },
  },
});
