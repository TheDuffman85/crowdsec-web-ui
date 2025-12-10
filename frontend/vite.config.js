import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:3000',
          changeOrigin: true,
          configure: (proxy, options) => {
            if (env.CROWDSEC_USER && env.CROWDSEC_PASSWORD) {
              options.auth = `${env.CROWDSEC_USER}:${env.CROWDSEC_PASSWORD}`;
            }
          }
        }
      }
    }
  }
})
