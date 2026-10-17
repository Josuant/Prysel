// Copia el núcleo de Pyodide (Python compilado a WebAssembly) junto a la web: se sirve desde el mismo
// sitio, así que ejecutar Python no depende de una CDN. Los paquetes (numpy, pandas…) sí se bajan de la
// CDN de Pyodide, y solo cuando un programa los importa.
import { cpSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const from = dirname(createRequire(import.meta.url).resolve('pyodide/package.json'))
const to = join(root, 'public', 'pyodide')
const FILES = [
  'pyodide.mjs',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
]

mkdirSync(to, { recursive: true })
for (const file of FILES) cpSync(join(from, file), join(to, file))
