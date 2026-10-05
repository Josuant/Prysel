import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { applyEdits } from '@prysel/python/edits'
import type { AiProvider, AiRequest } from '../src/ai/provider.ts'
import { smartAsk } from '../src/jev/ask.ts'
import { ObjectStream, stepOf } from '../src/jev/build.ts'
import { WHOLE_BUDGET, contextFor, numbered, regionsOf } from '../src/jev/context.ts'
import { build, modify, summaryOf, type Shown, type Stagehand } from '../src/jev/director.ts'
import { decideCommand } from '../src/jev/engine.ts'
import { localDecider } from '../src/jev/local.ts'
import { LineMap, opOf } from '../src/jev/modify.ts'
import {
  curveOf,
  evaluate,
  formatVisual,
  parseVisual,
  tableOf,
  visualOf,
} from '../src/jev/visual.ts'

/**
 * El director, de punta a punta: un archivo en memoria, una IA de mentira que contesta a trozos (como una
 * API en streaming) y el decisor local. Lo que se comprueba es lo que se le prometió al usuario: que el
 * trabajo se hace **por partes** (varias llamadas, cada una con lo que hace falta), que el diagrama cambia
 * entre una y otra, que lo ya escrito se puede cambiar, y que nunca se queda en «hecho, en 0 pasos».
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

/** Una IA de mentira: contesta, por orden, lo que se le dé, a trozos de siete letras. */
function scripted(responses: string[]): AiProvider & { requests: AiRequest[] } {
  const requests: AiRequest[] = []
  const answer = (request: AiRequest) => {
    requests.push(request)
    return responses.shift() ?? ''
  }
  return {
    id: 'mentira',
    requests,
    generate: (request) => Promise.resolve(answer(request)),
    async stream(request, onText, signal) {
      const text = answer(request)
      for (let i = 0; i < text.length && !signal?.aborted; i += 7) {
        onText(text.slice(i, i + 7))
        await Promise.resolve()
      }
      return text
    },
  }
}

/** Un archivo en memoria que hace de documento y de lienzo. */
function stage(source: string, stopAfter?: number) {
  const control = new AbortController()
  const state = { text: source, frames: [] as string[], shown: [] as Shown[] }
  const host: Stagehand = {
    signal: control.signal,
    program: () => Promise.resolve(parse(state.text)),
    write(change) {
      const next = applyEdits(state.text, change.edits)
      if (hasError(next)) return Promise.resolve('El siguiente paso no deja un programa válido.')
      state.text = next
      state.frames.push(next)
      return Promise.resolve(null)
    },
    show(event) {
      state.shown.push(event)
      const steps = state.shown.filter((item) => item.type === 'step').length
      if (stopAfter !== undefined && steps >= stopAfter) control.abort()
      return Promise.resolve()
    },
    wait: () => Promise.resolve(),
  }
  return { host, state }
}

const jsonl = (items: unknown[]) => items.map((item) => JSON.stringify(item)).join('\n') + '\n'
const steps = (state: { shown: Shown[] }) =>
  state.shown.flatMap((event) => (event.type === 'step' ? [event] : []))
const players = (provider: AiProvider) => ({ decider: localDecider(), provider })

const SUM = [
  { nivel: 0, code: 'numero_1 = 3', say: 'El primer número.' },
  { nivel: 0, code: 'numero_2 = 5', say: 'El segundo.' },
  { nivel: 0, code: 'def sumar(a, b):', say: 'La función que los suma.' },
  { nivel: 1, code: 'return a + b', say: 'Devuelve la suma.' },
  { nivel: 0, code: 'resultado = sumar(numero_1, numero_2)', say: 'La usamos.' },
  { nivel: 0, code: 'print(resultado)', say: 'Y enseñamos el resultado.' },
]
const SUM_TEXT = [
  'numero_1 = 3',
  'numero_2 = 5',
  'def sumar(a, b):',
  '    return a + b',
  'resultado = sumar(numero_1, numero_2)',
  'print(resultado)',
  '',
].join('\n')

const direct = {
  command: 'una función que sume dos números',
  gen: 'g1',
  place: {},
  where: 'al final del programa',
  outline: false,
}

describe('los pasos se sacan de la respuesta vengan como vengan', () => {
  it('uno por línea, en una lista con sangría, entre vallas o envueltos en otro objeto', () => {
    const read = (text: string) => {
      const stream = new ObjectStream(stepOf)
      return [...text].flatMap((char) => stream.push(char)).map((step) => step.code)
    }
    expect(read('{"code": "a = 1"}\n{"code": "b = 2"}')).toEqual(['a = 1', 'b = 2'])
    expect(
      read(
        '```json\n[\n  {\n    "nivel": 0,\n    "code": "a = 1"\n  },\n  {"code": "b = 2"}\n]\n```',
      ),
    ).toEqual(['a = 1', 'b = 2'])
    expect(read('Claro, aquí va:\n{"pasos": [{"code": "a = 1"}, {"code": "b = 2"}]}')).toEqual([
      'a = 1',
      'b = 2',
    ])
    // Las llaves y las comillas de dentro de un texto no confunden.
    expect(read('{"code": "d = {\\"a\\": 1}", "say": "Un diccionario {con llaves}."}')).toEqual([
      'd = {"a": 1}',
    ])
    expect(read('Usa {esto} y "aquello".\n{"code": "x = 1"}')).toEqual(['x = 1'])
  })
})

describe('construir algo pequeño: directo a los pasos', () => {
  it('cada paso se escribe y se enseña antes del siguiente, y al final se juzga el conjunto', async () => {
    const provider = scripted([jsonl(SUM)])
    const { host, state } = stage('')
    const outcome = await build(host, players(provider), direct)
    expect(state.text).toBe(SUM_TEXT)
    expect(state.frames).toHaveLength(6)
    expect(steps(state).map((event) => `${event.index} ${event.effect} L${event.line}`)).toEqual([
      '1 born L1',
      '2 born L2',
      '3 born L3',
      '4 born L4',
      '5 born L5',
      '6 born L6',
    ])
    // Mientras piensa, dice en qué está.
    expect(state.shown[0]).toEqual({ type: 'progress', text: 'Leyendo lo que ya hay…' })
    expect(outcome).toMatchObject({ written: 6, stopped: false, trouble: null, doubt: false })
    expect(summaryOf(outcome)).toBe('Hecho, en 6 pasos.')
    expect(provider.requests).toHaveLength(1)
  })

  it('una respuesta en una lista con sangría (no una línea por paso) vale igual', async () => {
    const provider = scripted([JSON.stringify(SUM, null, 2)])
    const { host, state } = stage('')
    const outcome = await build(host, players(provider), direct)
    expect(state.text).toBe(SUM_TEXT)
    expect(outcome.written).toBe(6)
  })

  it('si la IA contesta sin pasos, se le pide otra vez; y si insiste, se dice qué contestó', async () => {
    const again = scripted(['Voy a pensarlo con calma.', jsonl(SUM)])
    const first = stage('')
    expect((await build(first.host, players(again), direct)).written).toBe(6)
    expect(again.requests).toHaveLength(2)
    expect(again.requests[1]?.prompt).toContain('no traía ningún paso')

    const stubborn = scripted(['No sé hacer eso.', 'De verdad que no.'])
    const second = stage('')
    const outcome = await build(second.host, players(stubborn), direct)
    expect(outcome.written).toBe(0)
    expect(summaryOf(outcome)).toContain('La IA no dictó ningún paso')
    expect(summaryOf(outcome)).toContain('De verdad que no.')
    expect(summaryOf(outcome)).not.toContain('Hecho')
  })

  it('se puede detener a mitad: lo escrito es un programa válido', async () => {
    const { host, state } = stage('', 3)
    const outcome = await build(host, players(scripted([jsonl(SUM)])), direct)
    expect(outcome).toMatchObject({ written: 3, stopped: true })
    expect(state.text).toBe('numero_1 = 3\nnumero_2 = 5\ndef sumar(a, b):\n    pass\n')
    expect(summaryOf(outcome)).toBe('Detenido: quedan hechos 3 pasos.')
  })

  it('un paso que no es seguro detiene la construcción', async () => {
    const risky = [SUM[0], { nivel: 0, code: 'os.remove("datos.txt")', say: 'Borra.' }, SUM[1]]
    const { host, state } = stage('')
    const outcome = await build(host, players(scripted([jsonl(risky)])), direct)
    expect(state.text).toBe('numero_1 = 3\n')
    expect(outcome.trouble).toContain('no da por seguro')
  })
})

describe('construir algo grande: primero el esquema, luego cada etapa', () => {
  const OUTLINE = [
    { titulo: 'Preparar las notas', que: 'Guarda las notas de la clase.' },
    { titulo: 'Calcular la media', que: 'Suma las notas y divide.' },
    { titulo: 'Mostrar el resultado', que: 'Imprime la media.' },
  ]
  const STAGES = [
    [{ nivel: 0, code: 'notas = [7, 4, 9]', say: 'Las notas.' }],
    [
      { nivel: 0, code: 'total = 0', say: 'Empezamos de cero.' },
      { nivel: 0, code: 'for nota in notas:', say: 'Recorremos las notas.' },
      { nivel: 1, code: 'total = total + nota', say: 'Sumando cada una.' },
      { nivel: 0, code: 'media = total / len(notas)', say: 'Y dividimos.' },
    ],
    [{ nivel: 0, code: 'print(media)', say: 'La enseñamos.' }],
  ]
  const request = {
    command: 'un programa que calcule la media de unas notas',
    gen: 'g1',
    place: {},
    where: 'al final del programa',
    outline: true,
  }

  it('una llamada para el plan y una por etapa, cada una con lo ya escrito delante', async () => {
    const provider = scripted([jsonl(OUTLINE), ...STAGES.map((stage) => jsonl(stage))])
    const { host, state } = stage('')
    const outcome = await build(host, players(provider), request)
    expect(provider.requests).toHaveLength(4)
    // El esquema se ve entero antes de que exista una sola línea de código.
    expect(state.frames[2]).toBe(
      '# Preparar las notas: Guarda las notas de la clase\n...  # prysel:gen:g1s0\n\n# Calcular la media: Suma las notas y divide\n...  # prysel:gen:g1s1\n\n# Mostrar el resultado: Imprime la media\n...  # prysel:gen:g1s2\n',
    )
    expect((parse(state.frames[2] ?? '').sections ?? []).map((section) => section.title)).toEqual([
      'Preparar las notas',
      'Calcular la media',
      'Mostrar el resultado',
    ])
    expect(
      steps(state)
        .slice(0, 3)
        .map((event) => event.say),
    ).toEqual([
      'Preparar las notas. Guarda las notas de la clase.',
      'Calcular la media. Suma las notas y divide.',
      'Mostrar el resultado. Imprime la media.',
    ])
    // Cada etapa se detalla sabiendo cuál es y viendo lo que ya escribieron las anteriores.
    expect(provider.requests[2]?.prompt).toContain(
      '2. Calcular la media: Suma las notas y divide.   ◀ ESTA',
    )
    expect(provider.requests[2]?.prompt).toContain('notas = [7, 4, 9]')
    expect(state.text).toBe(
      [
        '# Preparar las notas: Guarda las notas de la clase',
        'notas = [7, 4, 9]',
        '',
        '# Calcular la media: Suma las notas y divide',
        'total = 0',
        'for nota in notas:',
        '    total = total + nota',
        'media = total / len(notas)',
        '',
        '# Mostrar el resultado: Imprime la media',
        'print(media)',
        '',
      ].join('\n'),
    )
    expect(outcome).toMatchObject({ written: 6, trouble: null })
    // Dice en qué etapa está mientras piensa sus pasos.
    expect(state.shown).toContainEqual({
      type: 'progress',
      text: 'Etapa 2 de 3 · Calcular la media: pensando sus pasos…',
    })
  })

  it('un plan de una sola etapa no es un esquema: se va directo a los pasos', async () => {
    const provider = scripted([jsonl([OUTLINE[0]]), jsonl(SUM)])
    const { host, state } = stage('')
    await build(host, players(provider), request)
    expect(state.text).toBe(SUM_TEXT)
  })

  it('detenido a mitad, ninguna etapa se queda marcada como en marcha', async () => {
    const provider = scripted([jsonl(OUTLINE), ...STAGES.map((stage) => jsonl(stage))])
    const { host, state } = stage('', 5)
    const outcome = await build(host, players(provider), request)
    expect(outcome.stopped).toBe(true)
    expect(state.text).not.toContain('prysel:gen')
    expect(hasError(state.text)).toBe(false)
  })
})

describe('cambiar lo que ya está escrito', () => {
  it('«ahora que reste»: cada cambio por su línea, y se ve cuál es', async () => {
    const provider = scripted([
      jsonl([
        {
          op: 'cambiar',
          linea: 3,
          code: 'def restar(a, b):',
          say: 'La función pasa a llamarse restar.',
        },
        { op: 'cambiar', linea: 4, code: 'return a - b', say: 'Y ahora resta.' },
        {
          op: 'cambiar',
          linea: 5,
          code: 'resultado = restar(numero_1, numero_2)',
          say: 'La llamamos por su nombre nuevo.',
        },
      ]),
    ])
    const { host, state } = stage(SUM_TEXT)
    const outcome = await modify(host, players(provider), {
      command: 'ahora que reste en lugar de sumar',
      lines: { from: 3, to: 4 },
      scope: 'función «def sumar(a, b):»',
    })
    expect(state.text).toBe(
      SUM_TEXT.replace('def sumar', 'def restar')
        .replace('a + b', 'a - b')
        .replace('= sumar(', '= restar('),
    )
    expect(steps(state).map((event) => `${event.effect} L${event.line}`)).toEqual([
      'changed L3',
      'changed L4',
      'changed L5',
    ])
    // Al modelo le llega el código con sus números de línea, y a qué se refiere la orden.
    expect(provider.requests[0]?.prompt).toContain('3| def sumar(a, b):')
    expect(provider.requests[0]?.prompt).toContain('líneas 3–4')
    expect(summaryOf(outcome, ['cambio', 'cambios'])).toBe('Hecho, en 3 cambios.')
  })

  it('quitar y añadir mueven líneas: los números del modelo siguen siendo los de antes', async () => {
    const provider = scripted([
      jsonl([
        { op: 'quitar', linea: 2, say: 'Ya no hace falta el segundo número.' },
        { op: 'añadir', tras: 1, code: 'numero_2 = 10\nnumero_3 = 20', say: 'Dos números nuevos.' },
        { op: 'cambiar', linea: 6, code: 'print("Resultado:", resultado)', say: 'Con un rótulo.' },
        {
          op: 'añadir',
          dentro: 3,
          code: 'print("sumando")',
          say: 'Un aviso dentro de la función.',
        },
      ]),
    ])
    const { host, state } = stage(SUM_TEXT)
    await modify(host, players(provider), { command: 'cámbialo' })
    expect(state.text).toBe(
      [
        'numero_1 = 3',
        'numero_2 = 10',
        'numero_3 = 20',
        'def sumar(a, b):',
        '    print("sumando")',
        '    return a + b',
        'resultado = sumar(numero_1, numero_2)',
        'print("Resultado:", resultado)',
        '',
      ].join('\n'),
    )
    // Lo que se va se enseña antes de quitarlo.
    expect(steps(state)[0]).toMatchObject({ effect: 'leaving', line: 2 })
    expect(steps(state).map((event) => event.effect)).toEqual([
      'leaving',
      'born',
      'changed',
      'born',
    ])
  })

  it('si no propone ningún cambio, o señala una línea que no existe, se dice', async () => {
    const none = stage(SUM_TEXT)
    const nothing = await modify(none.host, players(scripted(['Está bien como está.'])), {
      command: 'mejóralo',
    })
    expect(summaryOf(nothing)).toContain('no propuso ningún cambio')
    const wrong = stage(SUM_TEXT)
    const lost = await modify(
      wrong.host,
      players(scripted([jsonl([{ op: 'cambiar', linea: 40, code: 'x = 1', say: '' }])])),
      { command: 'cámbialo' },
    )
    expect(lost.trouble).toContain('línea 40')
    expect(wrong.state.text).toBe(SUM_TEXT)
  })

  it('las líneas se traducen en orden, y un cambio se lee venga como venga', () => {
    const map = new LineMap()
    map.moved(1, -1)
    map.moved(1, 2)
    expect([1, 3, 6].map((line) => map.now(line))).toEqual([1, 4, 7])
    expect(opOf({ op: 'cambiar', linea: 3, code: 'x = 1', say: 'a' })).toMatchObject({
      op: 'change',
    })
    expect(opOf({ op: 'añadir', dentro: 3, code: 'x = 1' })).toMatchObject({ inside: true })
    expect(opOf({ op: 'cambiar', linea: 3 })).toBeNull()
    expect(opOf({ op: 'bailar', linea: 3 })).toBeNull()
  })
})

describe('ser proactivo: lo que se escribe en la caja es una orden', () => {
  const typed = async (text: string, extra: object = {}) =>
    (
      await decideCommand(
        { text, program: parse(SUM_TEXT), selected: null, focus: null, typed: true, ...extra },
        localDecider(),
      )
    ).directive

  it('nombrar algo que programar basta: se construye, primero con su plan', async () => {
    expect(await typed('una red neuronal artificial', { genId: 'g1' })).toMatchObject({
      kind: 'do',
      intent: 'componer',
      effect: { type: 'compose', outline: true },
    })
    expect(await typed('hmm, a ver', { genId: 'g1' })).toMatchObject({ kind: 'do' })
  })

  it('lo escrito nunca se descarta por «no ser una orden»', async () => {
    expect((await typed('una red neuronal artificial')).kind).not.toBe('ignored')
    // Sin una IA que redacte no se puede construir: se dice, pero no se ignora.
    expect((await typed('una red neuronal artificial')).kind).toBe('unknown')
  })

  it('lo oído de pasada (sin escribirlo) sí puede no ser una orden', async () => {
    const heard = await decideCommand(
      { text: 'hmm, a ver', program: parse(SUM_TEXT), selected: null, focus: null, genId: 'g1' },
      localDecider(),
    )
    expect(heard.directive.kind).toBe('ignored')
  })
})

describe('entender un tema: «explícame cómo funciona la reproducción humana»', () => {
  const TOPIC = 'Explícame cómo funciona la reproducción humana'
  const choose = (option: string, confidence = 0.9) => ({
    type: 'choice' as const,
    choice: option,
    confidence,
    probabilities: { [option]: confidence },
  })
  /** Un JEV de mentira que contesta lo que se le diga a cada pregunta. */
  const jev = (answers: Record<string, ReturnType<typeof choose>>) => ({
    id: 'guion',
    decide: (request: { questions: Record<string, unknown> }) =>
      Promise.resolve({
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => [
            id,
            answers[id] ??
              (id === 'varias' ? { type: 'noul' as const, noul: 0 } : choose('ninguno')),
          ]),
        ),
        ms: 100,
      }),
  })
  const ask = async (decider: Parameters<typeof decideCommand>[1], extra: object = {}) =>
    (
      await decideCommand(
        {
          text: TOPIC,
          program: parse(SUM_TEXT),
          selected: null,
          focus: null,
          typed: true,
          genId: 'g1',
          ...extra,
        },
        decider,
      )
    ).directive

  it('no es una pregunta sobre el programa: se explica construyendo un modelo, con su plan', async () => {
    const expected = {
      kind: 'do',
      intent: 'componer',
      effect: { type: 'compose', teach: true, outline: true, place: {} },
      say: 'Te lo explico construyendo un pequeño modelo, paso a paso, al final del programa.',
    }
    // El JEV lo lee como un tema…
    expect(await ask(jev({ accion: choose('ensenar') }))).toMatchObject(expected)
    // …o como «explicar» a secas, sin señalar nada del programa: es lo mismo. Antes contestaba
    // «Dime a qué te refieres: selecciónalo o nómbralo».
    expect(await ask(jev({ accion: choose('explicar') }))).toMatchObject(expected)
    // Tampoco se confunde con lo que casualmente esté seleccionado.
    const selected = parse(SUM_TEXT).nodes.find((n) => n.label === 'sumar')?.id ?? null
    expect(await ask(jev({ accion: choose('explicar') }), { selected })).toMatchObject(expected)
    // Y el decisor local, sin red, llega a lo mismo.
    expect(await ask(localDecider())).toMatchObject(expected)
  })

  it('si lo que se quiere entender sí está en el programa, se explica ese elemento', async () => {
    const program = parse(SUM_TEXT)
    const fn = program.nodes.find((n) => n.label === 'sumar')
    const directive = await ask(jev({ accion: choose('ensenar'), objetivo: choose('p3') }))
    expect(directive).toMatchObject({
      kind: 'do',
      intent: 'explicar',
      explain: fn?.id,
      focus: fn?.id,
    })
    // «Explícame esto», con algo seleccionado, sigue siendo sobre lo seleccionado.
    expect(
      await ask(jev({ accion: choose('explicar'), objetivo: choose('seleccionado') }), {
        selected: fn?.id ?? null,
      }),
    ).toMatchObject({ intent: 'explicar', explain: fn?.id })
  })

  it('sin una IA que redacte, se dice qué falta (no «¿a qué te refieres?»)', async () => {
    const directive = (
      await decideCommand(
        { text: TOPIC, program: parse(SUM_TEXT), selected: null, focus: null, typed: true },
        localDecider(),
      )
    ).directive
    expect(directive).toEqual({
      kind: 'unknown',
      say: 'Para explicarte eso construyendo un modelo hace falta una IA generativa: elige un modelo.',
    })
  })

  it('a la IA se le pide que enseñe el tema, no que escriba un programa cualquiera', async () => {
    const provider = scripted([
      jsonl([
        {
          titulo: 'Las células que se unen',
          que: 'Un óvulo y un espermatozoide, cada uno con 23 cromosomas.',
        },
        { titulo: 'La fecundación', que: 'Se unen y forman una célula con 46 cromosomas.' },
      ]),
      jsonl([{ nivel: 0, code: 'cromosomas_ovulo = 23', say: 'El óvulo aporta 23 cromosomas.' }]),
      jsonl([
        {
          nivel: 0,
          code: 'cigoto = cromosomas_ovulo + 23',
          say: 'Al unirse suman 46: es el cigoto.',
        },
      ]),
    ])
    const { host, state } = stage('')
    const outcome = await build(host, players(provider), {
      command: TOPIC,
      gen: 'g1',
      place: {},
      where: 'al final del programa',
      outline: true,
      teach: true,
    })
    expect(outcome.written).toBe(2)
    for (const request of provider.requests) {
      expect(request.system).toContain('quiere ENTENDER un tema')
      expect(request.prompt).toContain(TOPIC)
    }
    expect(state.text).toBe(
      [
        '# Las células que se unen: Un óvulo y un espermatozoide, cada uno con 23 cromosomas',
        'cromosomas_ovulo = 23',
        '',
        '# La fecundación: Se unen y forman una célula con 46 cromosomas',
        'cigoto = cromosomas_ovulo + 23',
        '',
      ].join('\n'),
    )
  })
})

describe('ayudas visuales: nodos que no son del programa, pero lo explican', () => {
  it('una fórmula se lee sin ejecutar nada', () => {
    expect(evaluate('1/(1+exp(-x))', 0)).toBe(0.5)
    expect(evaluate('max(0, x)', -3)).toBe(0)
    expect(evaluate('np.tanh(x) ** 2 + 2*x - pi', 0)).toBeCloseTo(-Math.PI)
    expect(evaluate('x^2', 3)).toBe(9)
    expect(evaluate('-x**2', 3)).toBe(-9)
    // Nada que no sea aritmética: ni nombres sueltos, ni llamadas a otra cosa, ni código.
    expect(evaluate('__import__("os").system("x")', 1)).toBeNull()
    expect(evaluate('open(x)', 1)).toBeNull()
    expect(evaluate('y + 1', 1)).toBeNull()
    expect(evaluate('1/0', 1)).toBeNull()
    expect(evaluate('(1 + ', 1)).toBeNull()
  })

  it('lo que propone la IA se guarda como una marca en el código, y se vuelve a leer', () => {
    const curve = visualOf({
      tipo: 'curva',
      titulo: 'Sigmoide',
      y: '1/(1+exp(-x))',
      desde: -6,
      hasta: 6,
    })
    expect(curve && formatVisual(curve)).toBe(
      'prysel:ver curva «Sigmoide» y = 1/(1+exp(-x)), x de -6 a 6',
    )
    expect(curve && parseVisual(formatVisual(curve).replace('prysel:ver ', ''))).toEqual(curve)
    const table = visualOf({ tipo: 'tabla', titulo: 'ReLU', y: 'max(0, x)', x: [-2, 0, 2] })
    expect(table && formatVisual(table)).toBe('prysel:ver tabla «ReLU» y = max(0, x), x en -2 0 2')
    expect(table && parseVisual('tabla «ReLU» y = max(0, x), x en -2 0 2')).toEqual(table)
    expect(table?.kind === 'tabla' && tableOf(table)).toEqual([
      ['-2', '0'],
      ['0', '0'],
      ['2', '2'],
    ])
    expect(curve?.kind === 'curva' && curveOf(curve, 3).values).toEqual([
      1 / (1 + Math.exp(6)),
      0.5,
      1 / (1 + Math.exp(-6)),
    ])
    // Lo que no se puede dibujar no se propone.
    expect(visualOf({ tipo: 'curva', titulo: 'Rara', y: 'borrar(x)' })).toBeNull()
    expect(visualOf({ tipo: 'curva', titulo: '', y: 'x' })).toBeNull()
  })

  it('un paso con su ayuda la deja escrita junto a su sentencia, y el analizador la reconoce', async () => {
    const provider = scripted([
      jsonl([
        {
          nivel: 0,
          code: 'def sigmoide(x):',
          say: 'La función de activación.',
          ver: { tipo: 'curva', titulo: 'Sigmoide', y: '1/(1+exp(-x))', desde: -6, hasta: 6 },
        },
        {
          nivel: 1,
          code: 'return 1 / (1 + math.exp(-x))',
          say: 'Aplasta cualquier número entre 0 y 1.',
        },
      ]),
    ])
    const { host, state } = stage('import math\n')
    await build(host, players(provider), { ...direct, command: 'la función sigmoide' })
    expect(state.text).toBe(
      'import math\ndef sigmoide(x):  # prysel:ver curva «Sigmoide» y = 1/(1+exp(-x)), x de -6 a 6\n    return 1 / (1 + math.exp(-x))\n',
    )
    const fn = parse(state.text).nodes.find((n) => n.label === 'sigmoide')
    expect(fn?.aid).toBe('curva «Sigmoide» y = 1/(1+exp(-x)), x de -6 a 6')
    // No es una nota del código, ni estorba al programa.
    expect(fn?.note).toBeUndefined()
    expect(hasError(state.text)).toBe(false)
  })
})

describe('el contexto: lo que hace falta ver, y no más', () => {
  it('un programa corto va entero, con sus números de línea', async () => {
    const context = await contextFor(localDecider(), { command: 'x', program: parse(SUM_TEXT) })
    expect(context.whole).toBe(true)
    expect(context.text).toContain('1| numero_1 = 3')
    expect(context.text).toContain('6| print(resultado)')
    expect(numbered('a\nb\nc\n', 2, 3)).toBe('2| b\n3| c')
  })

  it('de uno largo va el índice, lo obligado y lo que el JEV da por necesario', async () => {
    const filler = (name: string) =>
      [
        `def ${name}(datos):`,
        ...Array.from({ length: 60 }, (_, i) => `    paso_${i} = datos + ${i}`),
        '    return datos',
        '',
      ].join('\n')
    const source = [
      'limite = 5',
      '',
      filler('cargar'),
      filler('limpiar'),
      filler('calcular_media'),
      filler('dibujar'),
      'print(calcular_media(limite))',
      '',
    ].join('\n')
    expect(source.length).toBeGreaterThan(WHOLE_BUDGET)
    const program = parse(source)
    expect(regionsOf(program).map((region) => region.title)).toEqual([
      'sentencias sueltas, desde «limite = 5»',
      'def cargar(datos):',
      'def limpiar(datos):',
      'def calcular_media(datos):',
      'def dibujar(datos):',
      'sentencias sueltas, desde «print(calcular_media(limite))»',
    ])
    const context = await contextFor(localDecider(), {
      command: 'haz que calcular_media redondee el resultado',
      program,
      must: [1],
    })
    expect(context.whole).toBe(false)
    // El índice nombra todo; el texto, solo lo obligado (línea 1) y lo que la orden nombra.
    expect(context.text).toContain('def dibujar(datos):')
    expect(context.regions.map((region) => region.title)).toEqual([
      'sentencias sueltas, desde «limite = 5»',
      'def calcular_media(datos):',
      'sentencias sueltas, desde «print(calcular_media(limite))»',
    ])
    expect(context.text).not.toContain('192| def dibujar(datos):')
    expect(context.text.length).toBeLessThan(source.length / 2)
  })
})

describe('preguntar bien: la IA propone salidas, y el JEV comprueba que se pueden cumplir', () => {
  it('solo se ofrecen las órdenes que el motor sabría cumplir', async () => {
    const program = parse(SUM_TEXT)
    const input = { text: 'lo de sumar', program, selected: null, focus: null, genId: 'g9' }
    const first = await decideCommand(input, localDecider())
    expect(first.directive.kind).toBe('ignored')
    const provider = scripted([
      JSON.stringify({
        question: '¿Qué quieres hacer con la función sumar?',
        options: [
          { label: 'Que reste', order: 'cambia la función sumar para que reste' },
          { label: 'Verla', order: 've a la función sumar' },
          { label: 'Nada claro', order: 'hmm, no sé' },
        ],
      }),
    ])
    const better = await smartAsk(provider, localDecider(), {
      input,
      context: numbered(SUM_TEXT),
      directive: { kind: 'unknown', say: 'No entendí qué quieres que haga.' },
      evidence: first.evidence,
    })
    expect(better).toEqual({
      kind: 'ask',
      question: '¿Qué quieres hacer con la función sumar?',
      options: [
        { label: 'Que reste', order: 'cambia la función sumar para que reste' },
        { label: 'Verla', order: 've a la función sumar' },
      ],
    })
    expect(provider.requests[0]?.prompt).toContain('Lo que dijo el usuario: lo de sumar')
    expect(provider.requests[0]?.prompt).toContain('3| def sumar(a, b):')
  })

  it('si no propone nada que valga, se queda la pregunta de siempre', async () => {
    const program = parse(SUM_TEXT)
    const input = { text: 'eso', program, selected: null, focus: null }
    const directive = { kind: 'unknown' as const, say: 'No entendí.' }
    expect(
      await smartAsk(scripted(['no es json']), localDecider(), {
        input,
        context: '',
        directive,
        evidence: [],
      }),
    ).toBeNull()
    const useless = scripted([
      JSON.stringify({ question: '¿Qué?', options: [{ label: 'x', order: 'bla bla' }] }),
    ])
    expect(
      await smartAsk(useless, localDecider(), { input, context: '', directive, evidence: [] }),
    ).toBeNull()
  })
})

describe('el motor reparte: cambiar lo escrito, y con esquema o directo', () => {
  const order = async (text: string, extra: object = {}) =>
    (
      await decideCommand(
        { text, program: parse(SUM_TEXT), selected: null, focus: null, genId: 'g1', ...extra },
        localDecider(),
      )
    ).directive

  it('«ahora haz que multiplique»: es un cambio, sobre lo último que se hizo', async () => {
    expect(await order('ahora haz que multiplique', { last: { from: 3, to: 4 } })).toMatchObject({
      kind: 'do',
      intent: 'modificar',
      effect: { type: 'modify', lines: { from: 3, to: 4 }, scope: 'lo último que se hizo' },
    })
    expect(await order('refactoriza la función sumar')).toMatchObject({
      effect: { type: 'modify', lines: { from: 3, to: 4 }, scope: 'función «def sumar(a, b):»' },
    })
    expect(await order('simplifica el código')).toMatchObject({ effect: { type: 'modify' } })
  })

  it('lo grande se piensa primero por etapas; lo pequeño va directo', async () => {
    expect(await order('escribe un programa que ordene una lista de nombres')).toMatchObject({
      effect: { type: 'compose', outline: true },
    })
    expect(await order('escribe una función que reste dos números')).toMatchObject({
      effect: { type: 'compose', outline: false },
    })
  })
})
