import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../dist', emptyOutDir: true },
  // `npm run dev` serves the UI with hot reload and forwards the API to the demo container.
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8787' } },
})
