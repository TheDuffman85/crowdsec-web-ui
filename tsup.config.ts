import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['server/index.ts'],
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
