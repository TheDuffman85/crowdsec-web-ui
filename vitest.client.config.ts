import path from 'path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['client/src/**/*.test.ts', 'client/src/**/*.test.tsx'],
    setupFiles: ['./client/src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage/client',
      include: [
        'client/src/lib/basePath.ts',
        'client/src/lib/utils.ts',
        'client/src/lib/stats.ts',
        'client/src/lib/api.ts',
        'client/src/contexts/RefreshContext.tsx',
        'client/src/components/ui/Badge.tsx',
        'client/src/components/ui/Card.tsx',
        'client/src/components/TimeDisplay.tsx',
        'client/src/components/SyncOverlay.tsx',
      ],
      exclude: ['client/src/test/**', 'client/src/main.tsx', 'client/src/types/**', 'client/src/vite-env.d.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
