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

/** `line`: lo que está seleccionado en el lienzo al dar la orden («esto»). */
async function order(text: string, line?: number, source = SOURCE) {
  const program = parse(source)
  const selected =
    line === undefined ? null : (program.nodes.find((n) => n.range && n.line === line)?.id ?? null)
  const { directive } = await decideCommand(
    { text, program, selected, focus: null, typed: true, genId: 'g1' },
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

describe('otras cosas que se le hacen a lo que ya existe, cada una con su gesto', () => {
  it('envolver: la sentencia pasa dentro de un bucle, una decisión o un intento', async () => {
    const loop = await order('envuelve esto en un bucle', 8)
    expect(loop.directive.kind === 'do' && loop.directive.gesture?.kind).toBe('wrap')
    expect(loop.moved).toContain(lines('for _ in range(3):', '    x = 1', 'y = 2'))
    const guard = await order('mete esto en un intento por si da error', 8)
    expect(guard.moved).toContain(
      lines('try:', '    x = 1', 'except Exception as error:', '    print(error)', 'y = 2'),
    )
  })

  it('duplicar: una copia justo debajo', async () => {
    const { directive, moved } = await order('duplica la función sumar')
    expect(directive.kind === 'do' && directive.gesture?.kind).toBe('copy')
    expect(moved?.match(/def sumar\(a, b\):/g)).toHaveLength(2)
  })

  it('juntar y extraer los reescribe la IA; el JEV dice con qué piezas, y qué gesto toca', async () => {
    const merge = await order('junta la función sumar con la clase Calculadora')
    expect(merge.directive.kind === 'do' && merge.directive.gesture).toMatchObject({
      kind: 'merge',
    })
    expect(merge.directive.kind === 'do' && merge.directive.effect).toMatchObject({
      type: 'modify',
      lines: { from: 1, to: 6 },
    })
    const extract = await order('extrae esto a una función', 8)
    expect(extract.directive.kind === 'do' && extract.directive.gesture?.kind).toBe('extract')
    expect(extract.directive.kind === 'do' && extract.directive.effect).toMatchObject({
      type: 'modify',
      lines: { from: 8, to: 8 },
    })
  })
})
