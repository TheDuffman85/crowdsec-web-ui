import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'client',
  base: './',
  define: {
    'import.meta.env.VITE_BUILD_DATE': JSON.stringify(
      process.env.VITE_BUILD_DATE || new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12),
    ),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
            return 'react-vendor';
          }
          if (id.includes('/i18next/') || id.includes('/react-i18next/')) {
            return 'i18n-vendor';
          }
          if (id.includes('/lucide-react/') || id.includes('/lucide/')) {
            return 'icons-vendor';
          }
          return undefined;
        },
      },
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
});
