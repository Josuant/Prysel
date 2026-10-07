import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { actionEdits, applyEdits } from '@prysel/python/edits'
import { decideCommand } from '../src/jev/engine.ts'
import { localDecider } from '../src/jev/local.ts'

/**
 * Mover algo que ya existe: el JEV dice qué se mueve, adónde y cómo queda; el código cambia de sitio (y una
 * función que entra en una clase pasa a ser un método).
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

const SOURCE = lines(
  'def sumar(a, b):',
  '    return a + b',
  '',
  'class Calculadora:',
  '    def __init__(self):',
  '        self.total = 0',
  '',
  'x = 1',
  'y = 2',
)

async function order(text: string, source = SOURCE) {
  const program = parse(source)
  const { directive } = await decideCommand(
    { text, program, selected: null, focus: null, typed: true },
    localDecider(),
  )
  const effect = directive.kind === 'do' ? directive.effect : null
  const moved =
    effect?.type === 'action' ? applyEdits(source, actionEdits(program, effect.action).edits) : null
  return { directive, moved }
}

describe('mover algo que ya existe', () => {
  it('una función dentro de una clase: viaja, y pasa a ser un método', async () => {
    const { directive, moved } = await order(
      'mueve la función sumar dentro de la clase Calculadora',
    )
    expect(directive.kind === 'do' && directive.say).toBe(
      'Muevo función «def sumar(a, b):» dentro de clase «class Calculadora:».',
    )
    expect(moved).toBe(
      lines(
        'class Calculadora:',
        '    def __init__(self):',
        '        self.total = 0',
        '',
        '    def sumar(self, a, b):',
        '        return a + b',
        '',
        'x = 1',
        'y = 2',
      ),
    )
  })

  it('antes o después de otra cosa, a su misma altura', async () => {
    const { directive, moved } = await order(
      'mueve la función sumar después de la clase Calculadora',
    )
    expect(directive.kind === 'do' && directive.say).toContain('después de clase')
    expect(moved?.indexOf('class Calculadora')).toBeLessThan(
      moved?.indexOf('def sumar(a, b)') ?? -1,
    )
  })

  it('sin saber qué o adónde, lo pregunta en vez de inventarlo', async () => {
    const { directive } = await order('mueve la función sumar')
    expect(directive.kind).toBe('unknown')
  })
})
