import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// During development the RAG service runs on port 8001; /api calls are proxied to it.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8001', '/retrieve': 'http://127.0.0.1:8001', '/health': 'http://127.0.0.1:8001' } },
})
