import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * Build del webview. Vite emite `webview.js` y `webview.css` en `../dist/webview`;
 * la extensión los carga con CSP estricta y un nonce.
 */

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(root, '../dist/webview'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(root, 'index.html'),
      output: {
        entryFileNames: 'webview.js',
        assetFileNames: 'webview.[ext]',
        chunkFileNames: 'webview-[name].js',
      },
    },
  },
})
