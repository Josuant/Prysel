import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { applyEdits } from '@prysel/python/edits'
import type { AiProvider } from '../src/ai/provider.ts'
import {
  modify,
  orphansOf,
  plainStagesFor,
  stagesFrom,
  type Stagehand,
} from '../src/jev/director.ts'
import { localDecider } from '../src/jev/local.ts'

/**
 * Ordenar: lo de primer nivel que queda fuera de toda etapa (antes de la primera) no es ningún módulo del
 * diagrama: se queda suelto. Al acabar una orden, se le ponen sus rótulos. Sale de una prueba real: un piano
 * cuyos datos y funciones de dibujo quedaron sin etapa.
 */

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))

let parse: (source: string) => Program
let hasError: (source: string) => boolean
beforeAll(async () => {
  const parser = await createPythonParser({
    runtime: wasmDir,
    language: path.join(wasmDir, 'tree-sitter-python.wasm'),
  })
  parse = (source: string) => buildProgram(parser.parse(source), source)
  hasError = (source: string) => parser.parse(source).rootNode.hasError
}, 30_000)

const lines = (...rows: string[]) => `${rows.join('\n')}\n`

const PIANO = lines(
  'import pantalla',
  'notas = ["do", "re", "mi"]',
  'def dibujar_teclado():',
  '    pantalla.rect(0, 0, 10, 10, "blanco")',
  'def altura(nota):',
  '    return 70',
  '',
  '# Tocar: suena cada nota',
  'def tocar():',
  '    pantalla.sonar("do")',
  '',
  '# Poner en marcha: la pantalla',
  'pantalla.boton("do", tocar)',
  'pantalla.mostrar()',
)

describe('lo que queda fuera de toda etapa', () => {
  it('es lo de primer nivel antes del primer rótulo (si el programa tiene etapas)', () => {
    expect(orphansOf(parse(PIANO)).map((node) => node.line)).toEqual([1, 2, 3, 5])
    expect(orphansOf(parse(lines('x = 1', 'print(x)')))).toEqual([])
  })

  it('sin IA: los datos por un lado y las funciones por otro', () => {
    expect(plainStagesFor(orphansOf(parse(PIANO))).map((stage) => stage.at)).toEqual([0, 2])
  })

  it('lo que propone la IA se valida: empieza en la primera, en orden, como mucho tres', () => {
    expect(stagesFrom('1 | Los datos: las notas\n3 | Dibujar: el teclado', 4)).toEqual([
      { at: 0, title: 'Los datos: las notas' },
      { at: 2, title: 'Dibujar: el teclado' },
    ])
    expect(stagesFrom('2 | Datos: las notas', 4)).toBeNull()
    expect(stagesFrom('1 | sin dos puntos', 4)).toBeNull()
    expect(stagesFrom('1 | A: b c\n1 | B: c d', 4)).toBeNull()
  })

  it('al acabar una orden se le ponen sus rótulos, como comentarios del código', async () => {
    const state = { text: PIANO }
    const host: Stagehand = {
      signal: new AbortController().signal,
      program: () => Promise.resolve(parse(state.text)),
      parses: (code) => !hasError(code),
      write(change) {
        if (change.edits.length > 0) state.text = applyEdits(state.text, change.edits)
        return Promise.resolve(null)
      },
      show: () => Promise.resolve(),
      wait: () => Promise.resolve(),
      settle: () => Promise.resolve(),
    }
    const changed = PIANO.replace('return 70', 'return 60')
    const provider = {
      id: 'mentira',
      generate(request: { system: string }) {
        if (request.system.includes('quedó sin rótulo de etapa')) {
          return Promise.resolve(
            '1 | Los datos: lo que suena\n3 | Dibujar el piano: teclas y alturas',
          )
        }
        if (request.system.includes('programa ENTERO')) return Promise.resolve(changed)
        return Promise.resolve('Cambio la altura.')
      },
    } as unknown as AiProvider
    await modify(
      host,
      { provider, decider: localDecider() },
      { command: 'cambia la altura a 60', whole: true },
    )
    expect(state.text).toContain('# Los datos: lo que suena\nimport pantalla')
    expect(state.text).toContain('\n\n# Dibujar el piano: teclas y alturas\ndef dibujar_teclado():')
    expect(orphansOf(parse(state.text))).toEqual([])
    expect(state.text).toContain('return 60')
  })
})
