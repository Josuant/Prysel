import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { applyEdits } from '@prysel/python/edits'
import type { AiProvider } from '../src/ai/provider.ts'
import type { JevAnswer } from '../src/jev/client.ts'
import { build, type Stagehand } from '../src/jev/director.ts'
import { decideCommand, namedBy, targetsOf } from '../src/jev/engine.ts'
import { localDecider } from '../src/jev/local.ts'
import { judgeHeard } from '../src/jev/plain.ts'

/**
 * De la primera sesión entera con el micrófono abierto (una clase animal, un perro que hereda, un gato…).
 * Lo que la torció no fue la velocidad: fue que las frases se partían por las pausas y cada trozo se cumplía
 * como una orden, y que el motor rellenaba lo que no entendía con lo que tenía más a mano. Las respuestas
 * del JEV que se usan aquí son las que dio de verdad.
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
const pick = (choice: string, confidence: number): JevAnswer => ({
  type: 'choice',
  choice,
  confidence,
  probabilities: {},
})

const ZOO = lines(
  'class animal:',
  '    pass',
  '',
  '',
  'class perro(animal):',
  '    def ladrar(self):',
  '        pass',
  'perro = perro()',
  '',
  '',
  'class gato(animal):',
  '    pass',
  'gato = gato()',
)

const recorded = (answers: Record<string, JevAnswer>) => ({
  id: 'grabado',
  decide: () => Promise.resolve({ ms: 1, answers }),
})

describe('una frase a medias no es una orden', () => {
  const whole = async (heard: string) => (await judgeHeard(localDecider(), heard)).complete

  it('el JEV dice si lo dicho está entero: lo que acaba pidiendo continuación, no', async () => {
    // Trozos que en la sesión se cumplieron como si fueran órdenes.
    expect(await whole('un objeto')).toBeLessThan(0.4)
    expect(await whole('en el programa principal manda llamar la función para')).toBeLessThan(0.4)
    expect(await whole('esa clase que se')).toBeLessThan(0.4)
    // Y las frases enteras de las que salieron.
    expect(await whole('crea una clase llamada animal')).toBeGreaterThan(0.6)
    expect(await whole('borra el objeto gato')).toBeGreaterThan(0.6)
    // Una respuesta corta sí está entera.
    expect(await whole('sí')).toBeGreaterThan(0.6)
  })
})

describe('«Crea una clase llamada animal»', () => {
  it('no hay plantilla de clase: no se pone una función con ese nombre; la escribe la IA', async () => {
    const { directive } = await decideCommand(
      {
        text: 'Crea una clase llamada animal.',
        program: parse(''),
        selected: null,
        focus: null,
        typed: true,
        genId: 'g1',
      },
      recorded({
        accion: pick('agregar', 0.62),
        alcance: pick('directo', 1),
        pieza: pick('function', 0.49),
        donde: pick('final', 0.99),
      }),
    )
    expect(directive.kind === 'do' && directive.effect.type).toBe('compose')
  })
})

describe('«Borra el objeto gato», con la clase gato seleccionada de antes', () => {
  it('entre dos que se llaman igual, es la que la orden dice que es', () => {
    const targets = targetsOf(parse(ZOO), null)
    expect(namedBy('Borra el objeto gato', targets).map((t) => t.head)).toEqual(['gato = gato()'])
    expect(namedBy('Borra la clase gato', targets).map((t) => t.head)).toEqual([
      'class gato(animal):',
    ])
  })

  it('se borra el objeto: lo que quedó seleccionado no manda si la orden no lo señala', async () => {
    const program = parse(ZOO)
    const { directive } = await decideCommand(
      {
        text: 'Borra el objeto gato.',
        program,
        selected: program.nodes.find((n) => n.range && n.line === 11)?.id ?? null,
        focus: null,
        typed: true,
        genId: 'g1',
      },
      recorded({ accion: pick('eliminar', 1), objetivo: pick('p1', 0.38) }),
    )
    const object = program.nodes.find((n) => n.range && n.line === 13)?.id
    expect(directive.kind === 'do' && directive.effect).toMatchObject({
      type: 'action',
      action: { type: 'delete', id: object },
    })
  })
})

describe('«Crea un tablero de tres por tres», mirando una función y con un bucle seleccionado de antes', () => {
  const SOURCE = lines(
    'numeros = [3, 1, 2]',
    'total = 0',
    'for n in numeros:',
    '    total = total + n',
    'print(total)',
    'def contar_vivas(matriz):',
    '    total = 0',
    '    for fila in matriz:',
    '        for valor in fila:',
    '            if valor == 1:',
    '                total = total + 1',
    '    return total',
  )
  // Lo que contestó el JEV de verdad.
  const answers = {
    sigue: { type: 'noul' as const, noul: 0.15 },
    accion: pick('componer', 0.82),
    ambito: pick('programa', 0.82),
    alcance: pick('directo', 0.7),
    pieza: pick('function', 0.49),
    donde: pick('final', 0.81),
    objetivo: pick('ninguno', 0.59),
  }
  const decide = (text: string) => {
    const program = parse(SOURCE)
    const at = (line: number) => program.nodes.find((n) => n.range && n.line === line)?.id ?? null
    return decideCommand(
      { text, program, selected: at(3), focus: at(6), typed: true, genId: 'g1' },
      recorded(answers),
    )
  }

  it('va al programa, no dentro de la función que se mira: la selección de antes no señala nada', async () => {
    const { directive } = await decide('Crea un tablero de tres por tres')
    expect(directive.kind === 'do' && directive.effect).toMatchObject({ type: 'compose' })
    expect(directive.kind === 'do' && directive.say).toContain('al final del programa')
  })

  it('si la orden sí señala lo seleccionado («después de esto»), manda eso', async () => {
    const { directive } = await decide('Crea un tablero de tres por tres después de esto')
    expect(directive.kind === 'do' && directive.say).not.toContain('al final del programa')
  })
})

describe('lo que el programa ya tiene no se vuelve a escribir', () => {
  it('si la IA repite una clase que ya existe, no se pone otra vez (ni dentro de sí misma)', async () => {
    const state = { text: ZOO }
    const host: Stagehand = {
      signal: new AbortController().signal,
      program: () => Promise.resolve(parse(state.text)),
      parses: (code) => !hasError(code),
      write(change) {
        state.text = applyEdits(state.text, change.edits)
        return Promise.resolve(null)
      },
      show: () => Promise.resolve(),
      wait: () => Promise.resolve(),
      settle: () => Promise.resolve(),
    }
    const provider: AiProvider = {
      id: 'mentira',
      generate: (request) =>
        Promise.resolve(
          request.system.includes('solo el código')
            ? lines('class perro(animal):', '    def ladrar(self):', '        pass')
            : 'Sigue.',
        ),
    }
    const outcome = await build(
      host,
      { decider: localDecider(), provider },
      {
        command: 'Calcular la edad de un perro.',
        gen: 'g1',
        place: {},
        where: 'al final del programa',
        outline: false,
        flow: 'stream',
      },
    )
    expect(state.text).toBe(ZOO)
    expect(outcome.trouble).toContain('ya está en el programa')
  })
})
