import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vitejs.dev/config/
export default defineConfig(({ mode: _mode }) => {
  return {
    base: './',
    define: {
      'import.meta.env.VITE_BUILD_DATE': JSON.stringify(
        new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12),
      ),
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, '../shared'),
      },
    },
    server: {
      proxy: {
        '/api': {
          target: process.env.BACKEND_URL || 'http://localhost:3000',
          changeOrigin: true,
        },
      },
    },
  };
});
