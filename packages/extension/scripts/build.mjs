import { build as esbuildBuild, context as esbuildContext } from 'esbuild'
import { build as viteBuild } from 'vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Compila la extensión (esbuild → CJS) y el webview (Vite → JS + CSS).
 * `node scripts/build.mjs` para una compilación única; `--watch` recompila la extensión al guardar.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const watch = process.argv.includes('--watch')

const esbuildOptions = {
  entryPoints: [resolve(root, 'src/extension.ts')],
  outfile: resolve(root, 'dist/extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  external: ['vscode', '@vscode/tree-sitter-wasm'],
  logLevel: 'info',
}

async function buildExtension() {
  if (watch) {
    const ctx = await esbuildContext(esbuildOptions)
    await ctx.watch()
    console.log('Prysel: observando la extensión (recompila al guardar).')
    return
  }
  await esbuildBuild(esbuildOptions)
}

async function main() {
  await buildExtension()
  await viteBuild({ configFile: resolve(root, 'webview/vite.config.mjs') })
  if (!watch) console.log('Prysel: extensión y webview compilados en dist/')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
