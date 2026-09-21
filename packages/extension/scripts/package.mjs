import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Genera el `.vsix` de la extensión: compila todo y lo empaqueta con `vsce`. No lleva dependencias en
 * tiempo de ejecución (tree-sitter va dentro de `dist/extension.js`, sus wasm en `dist/wasm` y el motor
 * de Python en `dist/runtime`), así que se empaqueta sin mirar `node_modules`.
 *
 * `node scripts/package.mjs [ruta/de/salida.vsix]`
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = process.argv[2] ?? resolve(root, 'prysel.vsix')

const run = (command, args) => {
  // Una sola cadena: en Windows `vsce` es un `.cmd` y hace falta el intérprete de comandos.
  const result = spawnSync([command, ...args].join(' '), {
    cwd: root,
    stdio: 'inherit',
    shell: true,
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('node', ['scripts/build.mjs'])
run('vsce', [
  'package',
  '--no-dependencies',
  '--skip-license',
  '--allow-missing-repository',
  '--out',
  JSON.stringify(out),
])
console.log(`Prysel: ${out}`)
