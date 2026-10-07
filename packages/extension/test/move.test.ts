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

describe('al entrar una función en una clase, las llamadas que ya había siguen funcionando', () => {
  const move = (source: string) =>
    order('mueve la función sumar dentro de la clase Calculadora', undefined, source)

  it('fuera de la clase, sin objeto a mano: se crea uno para llamarla', async () => {
    const { moved } = await move(
      lines(
        'def sumar(a, b):',
        '    return a + b',
        '',
        'class Calculadora:',
        '    def doble(self, n):',
        '        return sumar(n, n)',
        '',
        'print(sumar(1, 2))',
      ),
    )
    expect(moved).toBe(
      lines(
        'class Calculadora:',
        '    def doble(self, n):',
        '        return self.sumar(n, n)',
        '',
        '    def sumar(self, a, b):',
        '        return a + b',
        '',
        'print(Calculadora().sumar(1, 2))',
      ),
    )
  })

  it('si ya hay un objeto de esa clase, se llama por él', async () => {
    const { moved } = await move(
      lines(
        'def sumar(a, b):',
        '    return a + b',
        '',
        'class Calculadora:',
        '    pass',
        '',
        'calc = Calculadora()',
        'print(sumar(1, 2))  # sumar(…) en un comentario no se toca',
      ),
    )
    expect(moved).toContain('print(calc.sumar(1, 2))  # sumar(…) en un comentario no se toca')
    expect(moved).toContain('    def sumar(self, a, b):')
  })

  it('si crear un objeto pide datos que no se tienen, entra como función de la clase', async () => {
    const { moved } = await move(
      lines(
        'def sumar(a, b):',
        '    return a + b',
        '',
        'class Calculadora:',
        '    def __init__(self, marca):',
        '        self.marca = marca',
        '',
        'print(sumar(1, 2))',
      ),
    )
    expect(moved).toContain(
      lines('    @staticmethod', '    def sumar(a, b):', '        return a + b'),
    )
    expect(moved).toContain('print(Calculadora.sumar(1, 2))')
  })

  it('una función que se llama a sí misma sigue llamándose', async () => {
    const { moved } = await move(
      lines(
        'def sumar(a, b):',
        '    return a if b == 0 else sumar(a + 1, b - 1)',
        '',
        'class Calculadora:',
        '    pass',
      ),
    )
    expect(moved).toContain('        return a if b == 0 else self.sumar(a + 1, b - 1)')
  })
})

describe('«mete la función sumar en una clase Calculadora»', () => {
  const ALONE = lines('def sumar(a, b):', '    return a + b', '', 'print(sumar(1, 2))')

  it('si la clase no existe, se crea alrededor de la función (nunca un try)', async () => {
    const { directive, moved } = await order(
      'mete la función sumar en una clase calculadora',
      undefined,
      ALONE,
    )
    expect(directive.kind === 'do' && directive.say).toBe(
      'Creo la clase Calculadora con función «def sumar(a, b):» dentro.',
    )
    expect(moved).toBe(
      lines(
        'class Calculadora:',
        '    def sumar(self, a, b):',
        '        return a + b',
        '',
        'print(Calculadora().sumar(1, 2))',
      ),
    )
  })

  it('aunque el JEV conteste «intento» con poca seguridad, la orden dice «clase»', async () => {
    const local = localDecider()
    const program = parse(ALONE)
    const { directive } = await decideCommand(
      {
        text: 'mete la función sumar en una clase calculadora',
        program,
        selected: null,
        focus: null,
        typed: true,
        genId: 'g1',
      },
      {
        id: 'dudoso',
        async decide(request) {
          const response = await local.decide(request)
          return {
            ...response,
            answers: {
              ...response.answers,
              envolver_en: {
                type: 'choice',
                choice: 'intento',
                confidence: 0.4,
                probabilities: {},
              },
            },
          }
        },
      },
    )
    expect(directive.kind === 'do' && directive.effect).toMatchObject({
      type: 'action',
      action: { type: 'wrap', with: 'class', name: 'Calculadora' },
    })
  })

  it('si la clase ya existe, la función se mueve dentro de ella', async () => {
    const { directive, moved } = await order('mete la función sumar en una clase calculadora')
    expect(directive.kind === 'do' && directive.intent).toBe('mover')
    expect(moved).toContain('    def sumar(self, a, b):')
    expect(moved?.match(/class Calculadora/g)).toHaveLength(1)
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

describe('mirando una función por dentro, pedir otra función', () => {
  const source = lines('def sumar(a, b):', '    return a + b')
  const viewing = async (text: string) => {
    const program = parse(source)
    const fn = program.nodes.find((n) => n.range && n.line === 1)?.id ?? null
    const { directive } = await decideCommand(
      { text, program, selected: null, focus: fn, typed: true, genId: 'g1' },
      localDecider(),
    )
    return directive.kind === 'do' ? directive.say : null
  }

  it('es algo aparte: va al programa, no dentro de la que se mira', async () => {
    expect(await viewing('ahora crea una función restar')).toContain('al final del programa')
    expect(await viewing('un programa que calcule la media de unas notas')).toContain(
      'al final del programa',
    )
  })

  it('aunque el JEV conteste un «después» a medias, sin nada a lo que referirse', async () => {
    // Lo que contestó el JEV de verdad a «Ahora crea la función restar» mirando `sumar`.
    const program = parse(source)
    const fn = program.nodes.find((n) => n.range && n.line === 1)?.id ?? null
    const pick = (choice: string, confidence: number) => ({
      type: 'choice' as const,
      choice,
      confidence,
      probabilities: {},
    })
    const { directive } = await decideCommand(
      {
        text: 'Ahora crea la función restar',
        program,
        selected: null,
        focus: fn,
        typed: true,
        genId: 'g1',
      },
      {
        id: 'grabado',
        decide: () =>
          Promise.resolve({
            ms: 1,
            answers: {
              accion: pick('componer', 0.76),
              varias: { type: 'noul', noul: 0.07 },
              ambito: pick('programa', 0.98),
              alcance: pick('directo', 1),
              pieza: pick('function', 0.99),
              donde: pick('despues', 0.47),
              objetivo: pick('ninguno', 0.45),
              envolver_en: pick('clase', 0.9),
              mover_que: pick('ninguno', 0.99),
              mover_donde: pick('ninguno', 0.82),
            },
          }),
      },
    )
    expect(directive.kind === 'do' && directive.say).toBe('Lo escribo al final del programa.')
    expect(directive.kind === 'do' && directive.effect).toMatchObject({
      type: 'compose',
      place: {},
    })
  })

  it('si dice «aquí» o es un paso más, va dentro', async () => {
    expect(await viewing('añade aquí un bucle')).toContain('al final de sumar')
  })
})
