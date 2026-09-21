import { build as esbuildBuild, context as esbuildContext } from 'esbuild'
import { build as viteBuild } from 'vite'
import { cp, mkdir } from 'node:fs/promises'
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
  // tree-sitter va dentro del paquete: solo `vscode` lo pone el editor.
  external: ['vscode'],
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

/** El motor de ejecución es un archivo de Python, no código compilado: va junto al resto, en `dist/runtime`. */
async function copyRuntime() {
  await cp(resolve(root, 'runtime'), resolve(root, 'dist', 'runtime'), { recursive: true })
}

/** El runtime de tree-sitter y la gramática de Python: los únicos wasm que hacen falta (unos 660 KB). */
async function copyWasm() {
  const from = resolve(root, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm')
  await mkdir(resolve(root, 'dist', 'wasm'), { recursive: true })
  for (const file of ['tree-sitter.wasm', 'tree-sitter-python.wasm']) {
    await cp(resolve(from, file), resolve(root, 'dist', 'wasm', file))
  }
}

async function main() {
  await buildExtension()
  await copyRuntime()
  await copyWasm()
  await viteBuild({ configFile: resolve(root, 'webview/vite.config.mjs') })
  if (!watch) console.log('Prysel: extensión y webview compilados en dist/')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
