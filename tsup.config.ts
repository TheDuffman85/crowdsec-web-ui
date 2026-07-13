import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'server/index.ts',
    'query-worker': 'server/query-worker.ts',
    'sync-worker': 'server/sync-worker.ts',
    'load-test-server': 'scripts/load-test-server.ts',
    'seed-load-test-data': 'scripts/seed-load-test-data.ts',
  },
  outDir: 'dist/server',
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  clean: true,
  sourcemap: true,
  splitting: false,
  dts: false,
  external: ['better-sqlite3'],
});
