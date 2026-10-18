import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { actionEdits, applyEdits } from '@prysel/python/edits'
import { decideCommand, namedBy, targetsOf } from '../src/jev/engine.ts'
import { localDecider } from '../src/jev/local.ts'
import { LineMap, applyOp } from '../src/jev/modify.ts'

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

  it('sin saber adónde, no se inventa un destino: lo resuelve la IA con el programa delante', async () => {
    // Antes se devolvía una pregunta («dime qué muevo y adónde»). Con una IA que cambie el programa, quien
    // pide resultados no se queda parado: es un cambio, y lo hace ella viendo el programa entero.
    const { directive } = await order('mueve la función sumar')
    expect(directive.kind === 'do' && directive.intent).toBe('modificar')
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

describe('«Ahora fusiona sumar y restar», con el JEV sin decidirse entre las piezas', () => {
  it('la acción la dice el JEV; las dos piezas, la propia orden, que las nombra', async () => {
    const source = lines(
      'def sumar(a, b):',
      '    return a + b',
      'def restar(a, b):',
      '    return a - b',
    )
    const program = parse(source)
    const pick = (choice: string, confidence: number) => ({
      type: 'choice' as const,
      choice,
      confidence,
      probabilities: {},
    })
    // Lo que contestó el JEV de verdad, mirando `restar` por dentro.
    const { directive } = await decideCommand(
      {
        text: 'Ahora fusiona sumar y restar',
        program,
        selected: null,
        focus: program.nodes.find((n) => n.range && n.line === 3)?.id ?? null,
        typed: true,
        genId: 'g1',
      },
      {
        id: 'grabado',
        decide: () =>
          Promise.resolve({
            ms: 1,
            answers: {
              accion: pick('juntar', 0.98),
              varias: { type: 'noul', noul: 0.15 },
              ambito: pick('programa', 0.22),
              objetivo: pick('ninguno', 0.36),
              mover_que: pick('ninguno', 0.19),
              mover_donde: pick('p3', 0.26),
              mover_como: pick('dentro', 0.55),
            },
          }),
      },
    )
    expect(directive.kind === 'do' && directive.say).toBe(
      'Junto función «def sumar(a, b):» con función «def restar(a, b):».',
    )
    expect(directive.kind === 'do' && directive.gesture?.kind).toBe('merge')
    expect(directive.kind === 'do' && directive.effect).toMatchObject({
      type: 'modify',
      lines: { from: 1, to: 4 },
    })
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

describe('la conversación: una orden puede retocar lo que se acaba de hacer', () => {
  const source = lines('class Calculadora:', '    pass', 'calc = Calculadora()', 'print(2 + 3)')
  const history = [
    {
      order: 'Ahora instancia un objeto de Calculadora',
      did: 'Añado llamada a función al final del programa.',
    },
    { order: 'Ahora imprime la suma de 2 y 3', did: 'Añado imprimir al final del programa.' },
  ]
  const ask = async (text: string) => {
    const program = parse(source)
    const local = localDecider()
    const seen: unknown[] = []
    const { directive } = await decideCommand(
      {
        text,
        program,
        selected: null,
        focus: null,
        typed: true,
        genId: 'g1',
        last: { from: 4, to: 4 },
        history,
      },
      {
        id: 'local',
        decide(request) {
          seen.push(request.state)
          return local.decide(request)
        },
      },
    )
    return { directive, state: seen[0] as { antes?: string[] } }
  }

  it('al JEV se le cuenta lo de antes', async () => {
    const { state } = await ask('Pero usando la clase calculadora')
    expect(state.antes).toEqual([
      '«Ahora instancia un objeto de Calculadora» → Añado llamada a función al final del programa.',
      '«Ahora imprime la suma de 2 y 3» → Añado imprimir al final del programa.',
    ])
  })

  it('«pero usando la clase calculadora» cambia lo último que se hizo; no envuelve nada en una clase', async () => {
    const { directive } = await ask('Pero usando la clase calculadora')
    expect(directive.kind === 'do' && directive.intent).toBe('modificar')
    expect(directive.kind === 'do' && directive.effect).toMatchObject({
      type: 'modify',
      lines: { from: 4, to: 4 },
      scope: 'lo último que se hizo',
    })
  })

  it('una orden nueva sigue siendo una orden nueva', async () => {
    const { directive } = await ask('una función que reste dos números')
    expect(directive.kind === 'do' && directive.effect.type).toBe('compose')
  })
})

describe('«Ahora mete sumar a una clase Calculadora», justo después de crear sumar', () => {
  it('aunque suene a retoque de lo anterior, es meterla en una clase: se ve y no pasa por la IA', async () => {
    const source = lines('def sumar(a, b):', '    return a + b')
    const program = parse(source)
    const local = localDecider()
    const { directive } = await decideCommand(
      {
        text: 'Ahora mete sumar a una clase Calculadora',
        program,
        selected: null,
        focus: null,
        typed: true,
        genId: 'g1',
        last: { from: 1, to: 2 },
        history: [{ order: 'Crea la función sumar', did: 'Lo escribo al final del programa.' }],
      },
      {
        id: 'retoque',
        async decide(request) {
          const response = await local.decide(request)
          // El JEV ve un retoque de lo de antes (como pasó de verdad).
          return {
            ...response,
            answers: { ...response.answers, sigue: { type: 'noul', noul: 0.95 } },
          }
        },
      },
    )
    expect(directive.kind === 'do' && directive.effect).toMatchObject({
      type: 'action',
      action: { type: 'wrap', with: 'class', name: 'Calculadora' },
    })
    expect(directive.kind === 'do' && directive.gesture?.kind).toBe('wrap')
  })
})

describe('cambiar línea a línea no se queda a medias por una línea que no es una sentencia', () => {
  const source = lines('class Calculadora:', '    pass')

  it('añadir «junto a» un pass lo pone en el cuerpo que lo envuelve, en su lugar', () => {
    const program = parse(source)
    const applied = applyOp(program, new LineMap(), {
      op: 'add',
      line: 2,
      inside: false,
      code: 'def sumar(self, a, b):\n    return a + b',
      say: '',
    })
    expect(applied.ok).toBe(true)
    expect(applied.ok && applyEdits(source, applied.change.edits)).toBe(
      lines('class Calculadora:', '    def sumar(self, a, b):', '        return a + b'),
    )
  })

  it('quitar lo que ya no está se da por hecho', () => {
    const applied = applyOp(parse(source), new LineMap(), { op: 'remove', line: 2, say: '' })
    expect(applied).toMatchObject({ ok: true, change: { edits: [] } })
    // Pero señalar una línea que no existe sigue siendo un error.
    expect(applyOp(parse(source), new LineMap(), { op: 'remove', line: 9, say: '' }).ok).toBe(false)
  })
})

describe('cuando el JEV no tiene clara la acción y ya hay un programa', () => {
  it('no se añade una plantilla a ciegas: se le pasa a la IA con el programa entero', async () => {
    const source = lines(
      'class CajeroAutomatico:',
      '    def __init__(self):',
      '        self.estado = "Esperando Tarjeta"',
      '',
      '    def insertar_tarjeta(self):',
      '        self.estado = "Pidiendo PIN"',
      '',
      '    def validar_pin(self, pin):',
      "        if pin == '1234':",
      "            self.estado = 'Menú Principal'",
    )
    const pick = (choice: string, confidence: number) => ({
      type: 'choice' as const,
      choice,
      confidence,
      probabilities: {},
    })
    // Lo que contestó el JEV de verdad: «agregar» al 31 %, y acabó duplicando `validar_pin` fuera de la clase.
    const { directive } = await decideCommand(
      {
        text: 'Después de meter la tarjeta debe de validar el pin introducido',
        program: parse(source),
        selected: null,
        focus: null,
        typed: true,
        genId: 'g1',
        history: [{ order: 'Añade un método para validar el PIN.', did: 'Añado función.' }],
      },
      {
        id: 'grabado',
        decide: () =>
          Promise.resolve({
            ms: 1,
            answers: {
              sigue: { type: 'noul', noul: 0.54 },
              accion: pick('agregar', 0.31),
              varias: { type: 'noul', noul: 0.2 },
              alcance: pick('directo', 0.92),
              pieza: pick('function', 0.42),
              donde: pick('despues', 0.86),
              objetivo: pick('p8', 0.34),
            },
          }),
      },
    )
    expect(directive.kind === 'do' && directive.intent).toBe('modificar')
    expect(directive.kind === 'do' && directive.effect.type).toBe('modify')
  })
})

describe('de la tercera prueba del cajero: retoques, nombres dichos de palabra y pasos sueltos', () => {
  const CAJERO = lines(
    'class CajeroAutomatico:',
    '    def __init__(self):',
    '        self.estado = "Esperando Tarjeta"',
    '',
    '    def insertar_tarjeta(self):',
    '        self.estado = "Pidiendo PIN"',
    '',
    '    def validar_pin(self, pin):',
    "        if pin == '1234':",
    '            self.estado = "Menú Principal"',
    '',
    '    def insertar_tarjeta_y_validar_pin(self, pin):',
    '        self.insertar_tarjeta()',
    '        self.validar_pin(pin)',
  )
  const pick = (choice: string, confidence: number) => ({
    type: 'choice' as const,
    choice,
    confidence,
    probabilities: {},
  })
  const noul = (value: number) => ({ type: 'noul' as const, noul: value })
  const decide = async (text: string, answers: Record<string, unknown>, focusLine?: number) => {
    const program = parse(CAJERO)
    const at = (line: number) => program.nodes.find((n) => n.range && n.line === line)?.id ?? null
    return (
      await decideCommand(
        {
          text,
          program,
          selected: null,
          focus: focusLine === undefined ? null : at(focusLine),
          typed: true,
          genId: 'g1',
          last: { from: 12, to: 14 },
          history: [
            { order: 'Después de insertar la tarjeta, se debe validar el pin', did: 'Lo cambio.' },
          ],
        },
        {
          id: 'grabado',
          decide: () => Promise.resolve({ ms: 1, answers: answers as never }),
        },
      )
    ).directive
  }

  it('un retoque con un «mover» poco seguro es un retoque: no se mueve una función entera', async () => {
    const directive = await decide(
      'No pero se debe de validar el pin en la misma función de insertar tarjeta',
      {
        sigue: noul(0.91),
        accion: pick('mover', 0.48),
        mover_que: pick('p7', 0.56),
        mover_donde: pick('p5', 0.91),
      },
    )
    expect(directive.kind === 'do' && directive.effect.type).toBe('modify')
  })

  it('un nombre se dice como se oye, y el más largo gana a los que lleva dentro', async () => {
    const targets = targetsOf(parse(CAJERO), null)
    expect(
      namedBy('ya no nos sirve la de insertar tarjeta y validar pin', targets).map((t) => t.head),
    ).toEqual(['def insertar_tarjeta_y_validar_pin(self, pin):'])
    expect(
      namedBy('mueve validar pin después de insertar tarjeta', targets).map((t) => t.head),
    ).toEqual(['def validar_pin(self, pin):', 'def insertar_tarjeta(self):'])
  })

  it('al borrar, si el JEV no sabe cuál, es la que la orden nombra; y se confirma sin enredar', async () => {
    const directive = await decide(
      'Perfe, ahora ya no nos sirve la de insertar tarjeta y validar pin',
      {
        sigue: noul(0.72),
        accion: pick('eliminar', 0.53),
        objetivo: pick('ultimo', 0.17),
      },
    )
    expect(directive).toMatchObject({
      kind: 'ask',
      question: '¿Elimino función «def insertar_tarjeta_y_validar_pin(self, pin):» (línea 12)?',
      plain: true,
    })
  })

  it('mirando una clase, un paso suelto no se pone en su cuerpo: decide la IA', async () => {
    const directive = await decide(
      'Ahora falta un paso que es pedir al usuario su pin por el teclado',
      {
        sigue: noul(0.34),
        accion: pick('agregar', 0.78),
        pieza: pick('input', 1),
        donde: pick('final', 0.69),
        ambito: pick('dentro', 0.84),
      },
      1,
    )
    expect(directive.kind === 'do' && directive.effect.type).toBe('modify')
  })
})

describe('al salir un método de su clase, las llamadas que ya había siguen funcionando', () => {
  const out = (source: string) =>
    order('mueve la función sumar después de la clase Calculadora', undefined, source)

  it('si no usa el objeto, pierde el self y se la llama sin él', async () => {
    const { moved } = await out(
      lines(
        'class Calculadora:',
        '    def sumar(self, a, b):',
        '        return a + b',
        '',
        '    def doble(self, n):',
        '        return self.sumar(n, n)',
        '',
        'calc = Calculadora()',
        'print(calc.sumar(1, 2))',
        'print(Calculadora().sumar(3, 4))',
        'otra.sumar(5, 6)  # de otro objeto: no se toca. calc.sumar(…) en un comentario, tampoco',
      ),
    )
    expect(moved).toContain(lines('def sumar(a, b):', '    return a + b'))
    expect(moved).toContain('        return sumar(n, n)')
    expect(moved).toContain('print(sumar(1, 2))')
    expect(moved).toContain('print(sumar(3, 4))')
    expect(moved).toContain(
      'otra.sumar(5, 6)  # de otro objeto: no se toca. calc.sumar(…) en un comentario, tampoco',
    )
  })

  it('si usa el objeto, lo sigue recibiendo: ahora como un argumento más', async () => {
    const { moved } = await out(
      lines(
        'class Calculadora:',
        '    def __init__(self):',
        '        self.total = 0',
        '',
        '    def sumar(self, a, b):',
        '        self.total = a + b',
        '        return self.total',
        '',
        '    def doble(self, n):',
        '        return self.sumar(n, n)',
        '',
        '    def nada(self):',
        '        return self.sumar()',
        '',
        'calc = Calculadora()',
        'print(calc.sumar(1, 2))',
      ),
    )
    expect(moved).toContain(lines('def sumar(self, a, b):', '    self.total = a + b'))
    expect(moved).toContain('        return sumar(self, n, n)')
    expect(moved).toContain('        return sumar(self)')
    expect(moved).toContain('print(sumar(calc, 1, 2))')
  })

  it('una que se llama a sí misma sigue llamándose', async () => {
    const { moved } = await out(
      lines(
        'class Calculadora:',
        '    def sumar(self, a, b):',
        '        return a if b == 0 else self.sumar(a + 1, b - 1)',
        '',
        '    def otra(self):',
        '        return 1',
      ),
    )
    expect(moved).toContain(
      lines('def sumar(a, b):', '    return a if b == 0 else sumar(a + 1, b - 1)'),
    )
  })
})
