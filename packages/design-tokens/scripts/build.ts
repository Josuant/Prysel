// Uso: node scripts/build.ts [--check]
// --check no escribe: falla si los archivos generados no coinciden con las fuentes.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  generateCss,
  generateNames,
  generateTailwindTheme,
  mergeTokenFiles,
  type TokenFile,
} from '../src/build.ts'

const src = (file: string) => fileURLToPath(new URL(`../src/${file}`, import.meta.url))
const readJson = (file: string) => JSON.parse(readFileSync(src(file), 'utf8')) as TokenFile

const set = mergeTokenFiles(readJson('tokens.base.json'), readJson('tokens.theme.json'))
const outputs: Record<string, string> = {
  'generated/tokens.css': generateCss(set),
  'generated/tailwind-theme.css': generateTailwindTheme(set),
  'generated/names.ts': generateNames(set),
}

const check = process.argv.includes('--check')
let stale = 0
for (const [file, content] of Object.entries(outputs)) {
  const path = src(file)
  if (check) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== content) {
      console.error(`Desactualizado: ${file}`)
      stale++
    }
  } else {
    writeFileSync(path, content)
    console.log(`Escrito ${file}`)
  }
}
if (stale > 0) {
  console.error('Ejecuta `pnpm tokens` para regenerar.')
  process.exit(1)
}
