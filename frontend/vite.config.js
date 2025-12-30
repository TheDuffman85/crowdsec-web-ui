import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    define: {
      'import.meta.env.VITE_BUILD_DATE': JSON.stringify(
        new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
      )
    },
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        '/api': {
          target: process.env.BACKEND_URL || 'http://localhost:3000',
          changeOrigin: true
        }
      }
    }
  }
})
