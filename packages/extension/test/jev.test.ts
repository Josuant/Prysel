import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { actionEdits, applyEdits, fillGenerated } from '@prysel/python/edits'
import type { AiProvider, AiRequest } from '../src/ai/provider.ts'
import {
  JEV_URL,
  JevError,
  parseAnswer,
  typesafeDecider,
  type Decider,
  type JevAnswer,
  type JevRequest,
} from '../src/jev/client.ts'
import {
  THRESHOLDS,
  decideCommand,
  nameIn,
  questionsFor,
  targetsOf,
  titleIn,
  type Directive,
  type EngineInput,
} from '../src/jev/engine.ts'
import { FILL_ATTEMPTS, checkFill, generateFill, type FillRuntime } from '../src/jev/fill.ts'
import { localDecider } from '../src/jev/local.ts'
import { parseHostMessage, parseWebviewMessage } from '../src/protocol.ts'

/**
 * El motor JEV: una orden entra, Jev decide (aquí, uno de mentira: nunca se llama a la red) y sale una
 * directiva que es una acción del lienzo. Lo que se comprueba es lo que promete `docs/voz.md`: una sola
 * petición por orden, umbrales fijos, preguntar en vez de adivinar, y más certeza para lo que destruye.
 */

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))

let parse: (source: string) => Program
let runtime: FillRuntime
beforeAll(async () => {
  const parser = await createPythonParser({
    runtime: wasmDir,
    language: path.join(wasmDir, 'tree-sitter-python.wasm'),
  })
  parse = (source: string) => buildProgram(parser.parse(source), source)
  runtime = {
    parse: (code) => {
      const tree = parser.parse(code)
      return { program: buildProgram(tree, code), hasError: tree.rootNode.hasError }
    },
  }
}, 30_000)

const lines = (...rows: string[]) => `${rows.join('\n')}\n`

const SOURCE = lines(
  'total = 0',
  'limite = 10',
  '',
  'def entrenar(poblacion):',
  '    mejor = 0',
  '    for individuo in poblacion:',
  '        mejor = max(mejor, individuo)',
  '    if mejor > limite:',
  '        print(mejor)',
  '    return mejor',
  '',
  'print(total)',
)

const idOf = (program: Program, head: string) => {
  const node = program.nodes.find((n) => n.range && (n.text ?? '').startsWith(head))
  if (!node) throw new Error(`sin nodo ${head}`)
  return node.id
}

const pick = (choice: string, confidence = 0.95): JevAnswer => ({
  type: 'choice',
  choice,
  confidence,
  probabilities: { [choice]: confidence },
})

/** Un Jev de mentira: contesta lo que diga la prueba y apunta lo que se le preguntó. */
function scripted(answers: Record<string, JevAnswer>): Decider & { requests: JevRequest[] } {
  const requests: JevRequest[] = []
  return {
    id: 'guion',
    requests,
    decide(request) {
      requests.push(request)
      const asked = Object.fromEntries(
        Object.keys(request.questions).map((id) => [
          id,
          answers[id] ?? (id === 'es_orden' ? { type: 'noul', noul: 1 } : pick('ninguno', 0.1)),
        ]),
      )
      return Promise.resolve({ answers: asked as Record<string, JevAnswer>, ms: 120 })
    },
  }
}

const input = (text: string, extra: Partial<EngineInput> = {}): EngineInput => ({
  text,
  program: parse(SOURCE),
  selected: null,
  focus: null,
  ...extra,
})

/** La acción de una directiva, aplicada al texto. */
function applied(directive: Directive, source = SOURCE): string {
  if (directive.kind !== 'do' || directive.effect.type !== 'action') {
    throw new Error(`no es una acción: ${JSON.stringify(directive)}`)
  }
  return applyEdits(source, actionEdits(parse(source), directive.effect.action).edits)
}

describe('el cliente de Jev', () => {
  const question: JevRequest = {
    state: { orden: 'hola' },
    questions: {
      es_orden: { type: 'noul', instructions: '¿?' },
      accion: { type: 'choice', instructions: '¿?', criteria: { a: null, b: null } },
    },
  }
  const body = {
    model: 'jev-1.13.0',
    answers: {
      es_orden: { type: 'noul', noul: 0.93 },
      accion: { type: 'choice', choice: 'a', confidence: 0.8, probabilities: { a: 0.8, b: 0.2 } },
    },
  }
  const respond = (status: number, data: unknown) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

  it('manda el estado y las preguntas con la clave, y lee cada respuesta', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const decider = typesafeDecider({
      apiKey: 'clave-de-prueba',
      fetchImpl: ((url: string, init: RequestInit) => {
        calls.push({ url, init })
        return Promise.resolve(respond(200, body))
      }) as typeof fetch,
    })
    const result = await decider.decide(question)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(JEV_URL)
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      'Bearer clave-de-prueba',
    )
    const sent = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(sent.model).toBe('jev-latest')
    expect(sent.state).toEqual({ orden: 'hola' })
    expect(Object.keys(sent.questions as object)).toEqual(['es_orden', 'accion'])
    expect(result.answers.es_orden).toEqual({ type: 'noul', noul: 0.93 })
    expect(result.answers.accion).toMatchObject({ choice: 'a', confidence: 0.8 })
    expect(decider.id).toBe('jev-latest')
  })

  it('cada fallo dice su motivo: la clave, la petición, la red', async () => {
    const failing = (status: number) =>
      typesafeDecider({
        apiKey: 'x',
        fetchImpl: (() => Promise.resolve(respond(status, {}))) as typeof fetch,
        sleep: () => Promise.resolve(),
      })
    await expect(failing(401).decide(question)).rejects.toMatchObject({ reason: 'key' })
    await expect(failing(422).decide(question)).rejects.toMatchObject({ reason: 'request' })
    await expect(failing(529).decide(question)).rejects.toMatchObject({ reason: 'busy' })
    const offline = typesafeDecider({
      apiKey: 'x',
      fetchImpl: (() => Promise.reject(new Error('sin red'))) as typeof fetch,
    })
    await expect(offline.decide(question)).rejects.toBeInstanceOf(JevError)
    await expect(offline.decide(question)).rejects.toMatchObject({ reason: 'network' })
  })

  it('saturado, se reintenta una vez (y solo una)', async () => {
    let calls = 0
    const decider = typesafeDecider({
      apiKey: 'x',
      fetchImpl: (() =>
        Promise.resolve(++calls === 1 ? respond(429, {}) : respond(200, body))) as typeof fetch,
      sleep: () => Promise.resolve(),
    })
    expect((await decider.decide(question)).answers.accion).toMatchObject({ choice: 'a' })
    expect(calls).toBe(2)
  })

  it('una respuesta que no se entiende no se interpreta a ciegas', async () => {
    const odd = typesafeDecider({
      apiKey: 'x',
      fetchImpl: (() =>
        Promise.resolve(
          respond(200, { answers: { es_orden: { type: 'noul', noul: 'sí' } } }),
        )) as typeof fetch,
    })
    await expect(odd.decide(question)).rejects.toMatchObject({ reason: 'response' })
    expect(parseAnswer({ type: 'noul', noul: 4 })).toEqual({ type: 'noul', noul: 1 })
    expect(parseAnswer({ type: 'choice', choice: 3 })).toBeNull()
    expect(parseAnswer({ type: 'score', score: 2 })).toBeNull()
  })

  it('si tarda más que el plazo, se corta', async () => {
    const slow = typesafeDecider({
      apiKey: 'x',
      timeoutMs: 20,
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new Error('abortado'))
          })
        })) as typeof fetch,
    })
    await expect(slow.decide(question)).rejects.toMatchObject({ reason: 'timeout' })
  })
})

describe('lo que se le pregunta a Jev', () => {
  it('todo va en una sola petición, con conjuntos cerrados', async () => {
    const jev = scripted({ accion: pick('agregar'), pieza: pick('for'), donde: pick('final') })
    await decideCommand(input('añade un bucle'), jev)
    expect(jev.requests).toHaveLength(1)
    const { state, questions } = jev.requests[0] as JevRequest
    expect(Object.keys(questions)).toEqual(['es_orden', 'accion', 'pieza', 'donde', 'objetivo'])
    expect((state as { orden: string }).orden).toBe('añade un bucle')
    const targets = questions.objetivo
    expect(targets?.type === 'choice' && Object.values(targets.criteria)).toContain(
      'función «def entrenar(poblacion):» · línea 4',
    )
  })

  it('el catálogo pone delante lo que se está viendo, y dice dónde está cada cosa', () => {
    const program = parse(SOURCE)
    const whole = targetsOf(program, null)
    expect(whole.slice(0, 4).map((t) => t.head)).toEqual([
      'total = 0',
      'limite = 10',
      'def entrenar(poblacion):',
      'print(total)',
    ])
    expect(whole.find((t) => t.head === 'mejor = 0')?.description).toBe(
      'variable «mejor = 0» · línea 5 · en entrenar',
    )
    const inside = targetsOf(program, idOf(program, 'def entrenar'))
    expect(inside[0]?.head).toBe('def entrenar(poblacion):')
    expect(inside[1]?.head).toBe('mejor = 0')
  })

  it('lo que el usuario ya aclaró no se vuelve a preguntar', () => {
    const asked = questionsFor(
      input('añade', { forced: { intent: 'agregar', piece: 'for' } }),
      targetsOf(parse(SOURCE), null),
    )
    expect(Object.keys(asked.questions)).toEqual(['donde', 'objetivo'])
  })
})

describe('la resolución: de las respuestas a la directiva', () => {
  it('lo que no es una orden no hace nada', async () => {
    const { directive } = await decideCommand(
      input('qué frío hace hoy'),
      scripted({ es_orden: { type: 'noul', noul: 0.2 }, accion: pick('agregar') }),
    )
    expect(directive.kind).toBe('ignored')
  })

  it('añadir: la pieza, donde se pidió', async () => {
    const program = parse(SOURCE)
    const fn = targetsOf(program, null).find((t) => t.head.startsWith('def entrenar'))
    const { directive, jevMs, engine } = await decideCommand(
      input('añade un bucle dentro de entrenar'),
      scripted({
        accion: pick('agregar'),
        pieza: pick('for'),
        donde: pick('dentro'),
        objetivo: pick(fn?.ref ?? ''),
      }),
    )
    expect(directive.kind === 'do' && directive.say).toBe(
      'Añado bucle para cada dentro de función «def entrenar(poblacion):».',
    )
    // Antes del `return`: detrás nunca se ejecutaría.
    expect(applied(directive)).toContain(
      '        print(mejor)\n    for elemento in range(10):\n        pass\n    return mejor\n',
    )
    expect(jevMs).toBe(120)
    expect(engine).toBe('guion')
  })

  it('sin sitio claro, el de siempre: tras lo seleccionado, o al final de lo que se ve', async () => {
    const program = parse(SOURCE)
    const answers = { accion: pick('agregar'), pieza: pick('print'), donde: pick('final', 0.2) }
    const after = await decideCommand(
      input('imprime algo', { selected: idOf(program, 'limite = 10') }),
      scripted(answers),
    )
    expect(applied(after.directive)).toContain('limite = 10\nprint("Hola")\n')
    const end = await decideCommand(
      input('imprime algo', { focus: idOf(program, 'def entrenar') }),
      scripted(answers),
    )
    expect(applied(end.directive)).toContain('    print("Hola")\n    return mejor\n')
  })

  it('el camino del «no» de una decisión crea su else', async () => {
    const program = parse(SOURCE)
    const decision = targetsOf(program, null).find((t) => t.head.startsWith('if mejor'))
    const { directive } = await decideCommand(
      input('si no, imprime el límite'),
      scripted({
        accion: pick('agregar'),
        pieza: pick('print'),
        donde: pick('camino_no'),
        objetivo: pick(decision?.ref ?? ''),
      }),
    )
    expect(applied(directive)).toContain('        print(mejor)\n    else:\n        print("Hola")\n')
  })

  it('con una IA para escribir el contenido, la pieza nace marcada', async () => {
    const { directive } = await decideCommand(
      input('añade un bucle', { genId: 'k3f9' }),
      scripted({ accion: pick('agregar'), pieza: pick('for'), donde: pick('final') }),
    )
    expect(directive.kind === 'do' && directive.pending).toEqual({ id: 'k3f9', template: 'for' })
    expect(applied(directive)).toContain('for elemento in range(10):  # prysel:gen:k3f9\n')
    // Lo que no tiene contenido que escribir no se marca.
    const plain = await decideCommand(
      input('sal del bucle', { genId: 'k3f9' }),
      scripted({ accion: pick('agregar'), pieza: pick('break'), donde: pick('final') }),
    )
    expect(plain.directive.kind === 'do' && plain.directive.pending).toBeUndefined()
  })

  it('si no está claro qué se pide, pregunta con las dos más probables', async () => {
    const { directive } = await decideCommand(
      input('lo de total'),
      scripted({
        accion: {
          type: 'choice',
          choice: 'renombrar',
          confidence: THRESHOLDS.intent - 0.05,
          probabilities: { renombrar: 0.4, eliminar: 0.35, enfocar: 0.2, otra: 0.05 },
        },
      }),
    )
    expect(directive).toEqual({
      kind: 'ask',
      question: '¿Qué quieres hacer?',
      options: [
        { label: 'Renombrar', force: { intent: 'renombrar' } },
        { label: 'Eliminar', force: { intent: 'eliminar' } },
      ],
    })
  })

  it('si no se sabe qué pieza, pregunta cuál', async () => {
    const { directive } = await decideCommand(
      input('añade algo'),
      scripted({ accion: pick('agregar'), pieza: pick('ninguna') }),
    )
    expect(directive.kind === 'ask' && directive.question).toBe('¿Qué añado?')
    expect(directive.kind === 'ask' && directive.options[0]?.force).toMatchObject({
      intent: 'agregar',
    })
  })

  it('eliminar pide más certeza: con dudas, confirma; aclarado, lo hace', async () => {
    const program = parse(SOURCE)
    const limit = targetsOf(program, null).find((t) => t.head === 'limite = 10')
    const doubtful = await decideCommand(
      input('quita el límite'),
      scripted({ accion: pick('eliminar', 0.9), objetivo: pick(limit?.ref ?? '', 0.55) }),
    )
    expect(doubtful.directive).toEqual({
      kind: 'ask',
      question: '¿Elimino variable «limite = 10» (línea 2)?',
      options: [{ label: 'Sí, eliminar', force: { intent: 'eliminar', target: limit?.id } }],
    })
    const confirmed = await decideCommand(
      input('quita el límite', { forced: { intent: 'eliminar', target: limit?.id ?? '' } }),
      scripted({}),
    )
    expect(applied(confirmed.directive)).toBe(SOURCE.replace('limite = 10\n', ''))
    const sure = await decideCommand(
      input('quita el límite'),
      scripted({ accion: pick('eliminar', 0.9), objetivo: pick(limit?.ref ?? '', 0.9) }),
    )
    expect(applied(sure.directive)).toBe(SOURCE.replace('limite = 10\n', ''))
  })

  it('renombrar saca el nombre nuevo de la orden, y lo cambia en todos sus usos', async () => {
    const program = parse(SOURCE)
    const total = targetsOf(program, null).find((t) => t.head === 'total = 0')
    const { directive } = await decideCommand(
      input('renombra total a suma'),
      scripted({ accion: pick('renombrar'), objetivo: pick(total?.ref ?? '') }),
    )
    const text = applied(directive)
    expect(text).toContain('suma = 0\n')
    expect(text).toContain('print(suma)\n')
    const nameless = await decideCommand(
      input('renombra esto', { selected: total?.id ?? null }),
      scripted({ accion: pick('renombrar'), objetivo: pick('seleccionado') }),
    )
    expect(nameless.directive.kind).toBe('unknown')
  })

  it('lo que no toca el código: ir a verlo, plegar, ejecutar, deshacer', async () => {
    const program = parse(SOURCE)
    const fn = targetsOf(program, null).find((t) => t.head.startsWith('def entrenar'))
    const go = await decideCommand(
      input('enséñame entrenar'),
      scripted({ accion: pick('enfocar'), objetivo: pick(fn?.ref ?? '') }),
    )
    expect(go.directive).toMatchObject({ kind: 'do', effect: { type: 'focus' }, focus: fn?.id })
    const explain = await decideCommand(
      input('qué hace entrenar'),
      scripted({ accion: pick('explicar'), objetivo: pick(fn?.ref ?? '') }),
    )
    expect(explain.directive).toMatchObject({ kind: 'do', explain: fn?.id })
    const fold = await decideCommand(
      input('pliega entrenar'),
      scripted({ accion: pick('plegar'), objetivo: pick(fn?.ref ?? '') }),
    )
    expect(fold.directive).toMatchObject({ effect: { type: 'fold', id: fn?.id } })
    const run = await decideCommand(input('ejecuta'), scripted({ accion: pick('ejecutar') }))
    expect(run.directive).toMatchObject({ effect: { type: 'run', ids: 'all' } })
    const undo = await decideCommand(input('deshaz'), scripted({ accion: pick('deshacer') }))
    expect(undo.directive).toMatchObject({ effect: { type: 'undo' } })
    const lost = await decideCommand(input('ve ahí'), scripted({ accion: pick('enfocar') }))
    expect(lost.directive.kind).toBe('unknown')
  })

  it('la misma respuesta de Jev da siempre la misma directiva', async () => {
    const answers = { accion: pick('agregar'), pieza: pick('while'), donde: pick('principio') }
    const first = await decideCommand(input('añade un mientras al principio'), scripted(answers))
    const second = await decideCommand(input('añade un mientras al principio'), scripted(answers))
    expect(second).toEqual(first)
  })
})

describe('lo que Jev no hace: sacar un nombre de la orden', () => {
  it('el nombre nuevo', () => {
    expect(nameIn('renombra total a suma')).toBe('suma')
    expect(nameIn('Llámala contador.')).toBe('contador')
    expect(nameIn('cambia el nombre por «mejor_nota»')).toBe('mejor_nota')
    expect(nameIn('renombra esto')).toBeNull()
    expect(nameIn('renómbrala a for')).toBeNull()
  })

  it('el título de una etapa', () => {
    expect(titleIn('empieza una etapa llamada población inicial')).toBe('Población inicial')
    expect(titleIn('nueva etapa «Criar»')).toBe('Criar')
    expect(titleIn('etapa: evaluar a todos.')).toBe('Evaluar a todos')
    expect(titleIn('empieza una etapa aquí')).toBeNull()
  })
})

describe('el decisor local: la tubería entera, sin red', () => {
  const order = async (text: string, extra: Partial<EngineInput> = {}) =>
    (await decideCommand(input(text, extra), localDecider())).directive

  it('de la orden al Python', async () => {
    const loop = await order('Añade un bucle dentro de entrenar')
    expect(applied(loop)).toContain(
      '    for elemento in range(10):\n        pass\n    return mejor\n',
    )
    const text = applied(await order('renombra total a suma'))
    expect(text).toContain('suma = 0')
    expect(await order('ve a la línea 8')).toMatchObject({
      kind: 'do',
      effect: { type: 'focus' },
      focus: idOf(parse(SOURCE), 'if mejor'),
    })
    expect(await order('deshaz eso')).toMatchObject({ effect: { type: 'undo' } })
    expect(await order('paso a paso')).toMatchObject({ effect: { type: 'trace' } })
  })

  it('lo que no reconoce no lo toma por una orden', async () => {
    expect((await order('hmm, a ver')).kind).toBe('ignored')
  })

  it('una etapa, con su título', async () => {
    const program = parse(SOURCE)
    const staged = await order('empieza una etapa llamada Resultado', {
      selected: idOf(program, 'print(total)'),
    })
    expect(applied(staged)).toContain('# Resultado\nprint(total)\n')
  })
})

describe('la medida: lo que tarda todo lo que no es Jev (RNF-01)', () => {
  /**
   * El plazo es de 800 ms y Jev contesta en 70–500 ms. Lo demás —montar las preguntas, resolver, calcular
   * la edición y reanalizar el archivo— tiene que caber de sobra en lo que queda. Se mide sobre el ejemplo
   * grande (`flappy_ga.py`), ya en caliente, y se le pide menos de 150 ms (en la práctica son unos pocos).
   */
  it('en flappy_ga.py, del final de la orden al programa reanalizado', async () => {
    const source = readFileSync(
      path.join(import.meta.dirname, '../../../examples/lecciones/flappy_ga.py'),
      'utf8',
    )
    const once = async () => {
      const program = parse(source)
      const { directive } = await decideCommand(
        { text: 'añade un bucle dentro de entrenar', program, selected: null, focus: null },
        localDecider(),
      )
      if (directive.kind !== 'do' || directive.effect.type !== 'action')
        throw new Error('sin acción')
      const text = applyEdits(source, actionEdits(program, directive.effect.action).edits)
      return parse(text)
    }
    const warm = await once()
    expect(warm.nodes.length).toBeGreaterThan(parse(source).nodes.length)
    const started = performance.now()
    const rounds = 5
    for (let i = 0; i < rounds; i++) await once()
    const each = (performance.now() - started) / rounds
    expect(each).toBeLessThan(150)
  })
})

describe('el contenido: lo escribe la IA, y se comprueba', () => {
  function fake(responses: string[]): AiProvider & { requests: AiRequest[] } {
    const requests: AiRequest[] = []
    return {
      id: 'mentira',
      requests,
      generate(request: AiRequest) {
        requests.push(request)
        return Promise.resolve(responses.shift() ?? '{}')
      },
    }
  }
  const placed = () => {
    const program = parse(SOURCE)
    const change = actionEdits(program, {
      type: 'add',
      template: 'for',
      into: idOf(program, 'def entrenar'),
      pending: 'k3f9',
    })
    return parse(applyEdits(SOURCE, change.edits))
  }
  const GOOD = JSON.stringify({
    code: 'for individuo in poblacion:\n    total += individuo',
    say: 'Recorre la población y va sumando cada individuo al total.',
  })

  it('tiene que ser la pieza que decidió el JEV', () => {
    expect(checkFill(runtime, 'for', 'for x in y:\n    print(x)')).toBeNull()
    expect(checkFill(runtime, 'for', 'while x:\n    x -= 1')).toContain('Bucle para cada')
    expect(checkFill(runtime, 'for', 'for x in y:\n    pass\nprint(1)')).toContain(
      'única sentencia',
    )
    expect(checkFill(runtime, 'for', 'for x in y print(x)')).toBe('El código no es Python válido.')
    expect(checkFill(runtime, 'variable', 'contador = len(datos)')).toBeNull()
    expect(checkFill(runtime, 'variable', 'print(1)')).toContain('asignación')
    expect(checkFill(runtime, 'print', 'print(total)')).toBeNull()
    expect(checkFill(runtime, 'for', '    for x in y:\n        pass')).toContain('sangría')
  })

  it('lo generado sustituye a la plantilla, y trae lo que se dice de ello', async () => {
    const program = placed()
    const provider = fake([GOOD])
    const result = await generateFill(provider, runtime, {
      command: 'añade un bucle que sume la población',
      template: 'for',
      program,
      genId: 'k3f9',
    })
    expect(result).toMatchObject({ ok: true, attempts: 1 })
    expect(provider.requests[0]?.prompt).toContain('añade un bucle que sume la población')
    expect(provider.requests[0]?.prompt).toContain('# prysel:gen:k3f9')
    if (!result.ok) return
    expect(result.say).toContain('Recorre la población')
    const text = applyEdits(program.source, fillGenerated(program, 'k3f9', result.code).edits)
    expect(text).toContain(
      '    for individuo in poblacion:\n        total += individuo\n    return mejor\n',
    )
    expect(text).not.toContain('prysel:gen')
  })

  it('si no vale, se le dice por qué y se le deja corregir; si insiste, la plantilla se queda', async () => {
    const bad = JSON.stringify({ code: 'while True:\n    pass', say: 'Un bucle.' })
    const repaired = fake([bad, GOOD])
    const result = await generateFill(repaired, runtime, {
      command: 'un bucle',
      template: 'for',
      program: placed(),
      genId: 'k3f9',
    })
    expect(result).toMatchObject({ ok: true, attempts: 2 })
    expect(repaired.requests[1]?.prompt).toContain('no vale')
    const stubborn = await generateFill(fake([bad, bad, bad]), runtime, {
      command: 'un bucle',
      template: 'for',
      program: placed(),
      genId: 'k3f9',
    })
    expect(stubborn).toMatchObject({ ok: false, attempts: FILL_ATTEMPTS })
  })
})

describe('los mensajes de las órdenes se validan', () => {
  it('una orden del lienzo', () => {
    const message = {
      type: 'command',
      id: 1,
      text: ' añade un bucle ',
      version: 3,
      selected: null,
      focus: null,
    }
    expect(parseHostMessage(message)).toEqual({ ...message, text: 'añade un bucle' })
    expect(
      parseHostMessage({ ...message, force: { intent: 'agregar', piece: 'for' } }),
    ).toMatchObject({
      force: { intent: 'agregar', piece: 'for' },
    })
    expect(parseHostMessage({ ...message, text: '   ' })).toBeNull()
    expect(parseHostMessage({ ...message, text: 'x'.repeat(401) })).toBeNull()
    expect(parseHostMessage({ ...message, force: { intent: 'formatear el disco' } })).toBeNull()
    expect(parseHostMessage({ ...message, selected: 7 })).toBeNull()
    expect(parseHostMessage({ type: 'jevKey' })).toEqual({ type: 'jevKey' })
  })

  it('una decisión del motor, y lo que llega después', () => {
    const decision = {
      type: 'decision',
      id: 1,
      version: 3,
      directive: { kind: 'do', intent: 'deshacer', effect: { type: 'undo' }, say: 'Deshecho.' },
      evidence: [],
      engine: 'local',
      jevMs: 0,
    }
    expect(parseWebviewMessage(decision)).toEqual(decision)
    expect(parseWebviewMessage({ ...decision, directive: { kind: 'do', say: 'x' } })).toBeNull()
    expect(
      parseWebviewMessage({ ...decision, directive: { kind: 'inventada', say: 'x' } }),
    ).toBeNull()
    expect(
      parseWebviewMessage({ type: 'generated', gen: 'k3f9', ok: true, say: 'Ya.' }),
    ).toMatchObject({
      ok: true,
    })
    expect(parseWebviewMessage({ type: 'generated', gen: 'k3f9' })).toBeNull()
    expect(parseWebviewMessage({ type: 'say', text: '' })).toBeNull()
  })
})
