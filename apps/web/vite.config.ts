import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * La web de Prysel. `base: './'`: las rutas son relativas, así que sirve igual en la raíz de un dominio
 * que en una subcarpeta (GitHub Pages publica en `/<repositorio>/`).
 */
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: { port: 5174, strictPort: true },
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 2000 },
})
