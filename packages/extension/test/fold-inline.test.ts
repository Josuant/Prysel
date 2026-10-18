import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { functionsOf, toCanvasNodes, viewOf, withSections } from '@prysel/ui'

/**
 * Una etapa que llama una vez a una función de otra etapa la despliega en su sitio. Antes, la función quedaba
 * reclamada por las dos etapas: al plegar, los dos grupos se solapaban, se descartaba el segundo y sus pasos
 * se quedaban fuera, sueltos (la etapa «no se dejaba plegar»). Lo encontró el recorrido automático.
 */

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))
let parse: (source: string) => Program
beforeAll(async () => {
  const parser = await createPythonParser({
    runtime: wasmDir,
    language: path.join(wasmDir, 'tree-sitter-python.wasm'),
  })
  parse = (source: string) => buildProgram(parser.parse(source), source)
}, 30_000)

const lines = (...rows: string[]) => `${rows.join('\n')}\n`

const PIANO = lines(
  'import pantalla',
  '',
  '# Dibujar el piano: las teclas',
  'def dibujar():',
  '    for i in range(3):',
  '        pantalla.rect(i * 10, 0, 8, 20, "blanco")',
  '',
  '# Poner en marcha: el lienzo y la pantalla',
  'pantalla.lienzo(100, 40)',
  'dibujar()',
  'pantalla.mostrar()',
)

describe('una etapa con una función desplegada en su sitio', () => {
  const view = (flipped: Set<string>, density: 'normal' | 'compact' = 'normal') => {
    const program = parse(PIANO)
    const all = withSections(toCanvasNodes(program.nodes), program.edges, program.sections ?? [])
    return viewOf(all, program.edges, functionsOf(all, program.edges), {
      focus: null,
      flow: true,
      density,
      flipped,
      modules: true,
    }).view.nodes.map((node) => node.id)
  }

  it('plegada, no deja nada suyo fuera; abierta, enseña sus pasos y los de la función', () => {
    const start =
      parse(PIANO).sections?.find((section) => section.title === 'Poner en marcha')?.id ?? ''
    const folded = view(new Set())
    expect(folded).toContain(start)
    expect(folded.some((id) => id.startsWith('expr:'))).toBe(false)
    const open = view(new Set([start]))
    expect(open.filter((id) => id.startsWith('expr:')).length).toBeGreaterThan(1)
    expect(open.some((id) => id.startsWith('def:'))).toBe(true)
  })

  it('también si la función está plegada en su tarjeta (lo de fuera se pliega antes que lo de dentro)', () => {
    // En «compacto» todo empieza plegado: la función también, como cuando ya tiene su tarjeta.
    const folded = view(new Set(), 'compact')
    expect(folded.some((id) => id.startsWith('expr:') || id.startsWith('def:'))).toBe(false)
  })
})
