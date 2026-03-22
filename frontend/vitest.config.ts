import path from 'path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      include: [
        'src/lib/basePath.ts',
        'src/lib/utils.ts',
        'src/lib/stats.ts',
        'src/lib/api.ts',
        'src/contexts/RefreshContext.tsx',
        'src/components/ui/Badge.tsx',
        'src/components/ui/Card.tsx',
        'src/components/TimeDisplay.tsx',
        'src/components/SyncOverlay.tsx',
      ],
      exclude: ['src/test/**', 'src/main.tsx', 'src/types/**', 'src/vite-env.d.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
