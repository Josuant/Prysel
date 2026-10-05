import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { addCode, applyEdits } from '@prysel/python/edits'
import { DEEPSEEK_URL, deepseekProvider } from '../src/ai/deepseek.ts'
import type { AiProvider, AiRequest } from '../src/ai/provider.ts'
import type { Decider, JevAnswer, JevRequest } from '../src/jev/client.ts'
import {
  COMPOSE_ATTEMPTS,
  checkCode,
  composeCode,
  judgeCode,
  splitOrder,
} from '../src/jev/compose.ts'
import { decideCommand, type EngineInput } from '../src/jev/engine.ts'
import type { FillRuntime } from '../src/jev/fill.ts'
import { localDecider } from '../src/jev/local.ts'

/**
 * Las órdenes complejas: la IA generativa redacta (parte una orden larga, escribe un algoritmo) y el JEV
 * decide y juzga (qué clase de orden es, dónde va, si lo escrito cumple y si es seguro). Ninguna de las dos
 * se llama de verdad: un proveedor y un decisor de mentira contestan lo que diga la prueba.
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

const SOURCE = [
  'notas = [7, 4, 9]',
  'limite = 5',
  '',
  'def media(valores):',
  '    return 0',
  '',
].join('\n')

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

/** Un JEV de mentira que juzga con las notas que se le den, por orden. */
function judge(
  verdicts: { cumple: number; seguro: number }[],
): Decider & { requests: JevRequest[] } {
  const requests: JevRequest[] = []
  return {
    id: 'juez',
    requests,
    decide(request) {
      requests.push(request)
      const verdict = verdicts.shift() ?? { cumple: 1, seguro: 1 }
      const answers: Record<string, JevAnswer> = {
        cumple: { type: 'noul', noul: verdict.cumple },
        seguro: { type: 'noul', noul: verdict.seguro },
      }
      return Promise.resolve({ answers, ms: 90 })
    },
  }
}

const ALGORITHM = [
  '# Sumar las notas',
  'total = 0',
  'for nota in notas:',
  '    total = total + nota',
  '',
  '# Calcular la media',
  'promedio = total / len(notas)',
  'print(promedio)',
].join('\n')
const GOOD = JSON.stringify({ code: ALGORITHM, say: 'Suma las notas y calcula su media.' })

const input = (text: string, extra: Partial<EngineInput> = {}): EngineInput => ({
  text,
  program: parse(SOURCE),
  selected: null,
  focus: null,
  ...extra,
})

describe('el proveedor de DeepSeek', () => {
  const request: AiRequest = { system: 'sistema', prompt: 'pregunta', maxTokens: 100 }

  it('manda el sistema y la pregunta con la clave, y devuelve el texto', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const provider = deepseekProvider({
      apiKey: 'clave-de-prueba',
      fetchImpl: ((url: string, init: RequestInit) => {
        calls.push({ url, init })
        return Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { content: 'hola' } }] })),
        )
      }) as typeof fetch,
    })
    expect(await provider.generate(request)).toBe('hola')
    expect(provider.id).toBe('deepseek:deepseek-chat')
    expect(calls[0]?.url).toBe(DEEPSEEK_URL)
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      'Bearer clave-de-prueba',
    )
    const sent = JSON.parse(String(calls[0]?.init.body)) as {
      model: string
      max_tokens: number
      messages: { role: string; content: string }[]
    }
    expect(sent.model).toBe('deepseek-chat')
    expect(sent.max_tokens).toBe(100)
    expect(sent.messages).toEqual([
      { role: 'system', content: 'sistema' },
      { role: 'user', content: 'pregunta' },
    ])
  })

  it('un error de la API, o una respuesta vacía, se dicen', async () => {
    const failing = deepseekProvider({
      apiKey: 'mala',
      model: 'deepseek-reasoner',
      fetchImpl: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'clave inválida' } }), { status: 401 }),
        )) as typeof fetch,
    })
    expect(failing.id).toBe('deepseek:deepseek-reasoner')
    await expect(failing.generate(request)).rejects.toThrow(
      'DeepSeek respondió 401: clave inválida',
    )
    const empty = deepseekProvider({
      apiKey: 'x',
      fetchImpl: (() =>
        Promise.resolve(new Response(JSON.stringify({ choices: [] })))) as typeof fetch,
    })
    await expect(empty.generate(request)).rejects.toThrow('ningún texto')
  })
})

describe('el JEV reparte: una pieza, un algoritmo, o varias órdenes', () => {
  const order = async (text: string, extra: Partial<EngineInput> = {}) =>
    (await decideCommand(input(text, { genId: 'g1', ...extra }), localDecider())).directive

  it('una pieza sencilla sigue por el camino rápido', async () => {
    expect(await order('añade una variable')).toMatchObject({
      kind: 'do',
      intent: 'agregar',
      effect: { type: 'action' },
    })
  })

  it('lo que pide lógica propia se manda escribir, con su sitio ya decidido', async () => {
    const program = parse(SOURCE)
    const fn = program.nodes.find((n) => n.label === 'media')
    expect(await order('escribe un algoritmo que calcule la media dentro de media')).toEqual({
      kind: 'do',
      intent: 'componer',
      effect: {
        type: 'compose',
        gen: 'g1',
        place: { into: fn?.id },
        where: 'dentro de función «def media(valores):»',
        outline: true,
      },
      say: 'Lo escribo dentro de función «def media(valores):».',
    })
  })

  it('añadir algo que no es una pieza de las de siempre también se escribe (en vez de preguntar)', async () => {
    expect(await order('añade lo necesario para saludar')).toMatchObject({
      effect: { type: 'compose', place: {} },
    })
    // Sin una IA generativa, se pregunta qué pieza, como antes.
    const asked = await decideCommand(input('añade lo necesario para saludar'), localDecider())
    expect(asked.directive.kind).toBe('ask')
  })

  it('sin una IA generativa, una orden compleja se dice que no se puede', async () => {
    const { directive } = await decideCommand(
      input('escribe un algoritmo que ordene las notas'),
      localDecider(),
    )
    expect(directive.kind).toBe('unknown')
  })

  it('varias órdenes en una se parten; un trozo ya partido no se vuelve a partir', async () => {
    expect((await order('añade una variable y luego ejecuta')).kind).toBe('several')
    expect((await order('añade una variable y luego ejecuta', { single: true })).kind).toBe('do')
  })

  it('pedir la lección narrada', async () => {
    expect(await order('hazme una lección de este programa')).toMatchObject({
      effect: { type: 'lesson' },
    })
  })
})

describe('partir una orden larga', () => {
  it('en órdenes sencillas, en su orden', async () => {
    const provider = fake([
      JSON.stringify({ steps: ['añade una variable contador', 'renombra contador a veces'] }),
    ])
    expect(
      await splitOrder(provider, 'añade una variable contador y luego renómbrala a veces'),
    ).toEqual(['añade una variable contador', 'renombra contador a veces'])
    expect(provider.requests[0]?.prompt).toContain('renómbrala')
  })

  it('lo que no es una lista de 2 a 6 frases no vale', async () => {
    expect(await splitOrder(fake(['no es json']), 'x')).toBeNull()
    expect(await splitOrder(fake([JSON.stringify({ steps: ['una sola'] })]), 'x')).toBeNull()
    expect(await splitOrder(fake([JSON.stringify({ steps: ['a', 3] })]), 'x')).toBeNull()
    expect(
      await splitOrder(
        fake([JSON.stringify({ steps: Array.from({ length: 9 }, () => 'a') })]),
        'x',
      ),
    ).toBeNull()
  })
})

describe('escribir un algoritmo: la IA redacta y el JEV juzga', () => {
  const request = () => ({
    command: 'calcula la media de las notas e imprímela',
    program: parse(SOURCE),
    where: 'al final del programa',
  })

  it('lo que cumple y es seguro se acepta, y llega al diagrama partido en etapas', async () => {
    const jev = judge([{ cumple: 0.92, seguro: 0.97 }])
    const provider = fake([GOOD])
    const result = await composeCode(provider, jev, runtime, request())
    expect(result).toMatchObject({ ok: true, attempts: 1, jevMs: 90 })
    expect(result.evidence.map((item) => `${item.question}: ${item.answer}`)).toEqual([
      'cumple: sí',
      'seguro: sí',
    ])
    // Al JEV se le enseña la orden y el código: juzga lo escrito, no lo prometido.
    expect(jev.requests[0]?.state).toEqual({ orden: request().command, codigo: ALGORITHM })
    expect(provider.requests[0]?.prompt).toContain('al final del programa')
    if (!result.ok) return
    const program = parse(SOURCE)
    const text = applyEdits(SOURCE, addCode(program, {}, result.code).edits)
    expect(text.endsWith(`${ALGORITHM}\n`)).toBe(true)
    expect((parse(text).sections ?? []).map((section) => section.title)).toEqual([
      'Sumar las notas',
      'Calcular la media',
    ])
  })

  it('lo que no cumple se manda corregir una vez, diciendo por qué', async () => {
    const half = JSON.stringify({ code: 'total = 0', say: 'Empieza.' })
    const provider = fake([half, GOOD])
    const result = await composeCode(
      provider,
      judge([
        { cumple: 0.2, seguro: 0.9 },
        { cumple: 0.9, seguro: 0.9 },
      ]),
      runtime,
      request(),
    )
    expect(result).toMatchObject({ ok: true, attempts: 2, jevMs: 180 })
    expect(provider.requests[1]?.prompt).toContain('No hace todo lo que pide la orden')
    const stubborn = await composeCode(
      fake([half, half, half]),
      judge([
        { cumple: 0.2, seguro: 0.9 },
        { cumple: 0.2, seguro: 0.9 },
      ]),
      runtime,
      request(),
    )
    expect(stubborn).toMatchObject({ ok: false, attempts: COMPOSE_ATTEMPTS })
  })

  it('lo que no es seguro no se escribe, ni se le da otra oportunidad', async () => {
    const risky = JSON.stringify({ code: 'import os\nos.remove("notas.txt")', say: 'Borra.' })
    const provider = fake([risky, GOOD])
    const result = await composeCode(provider, localDecider(), runtime, request())
    expect(result).toMatchObject({ ok: false, attempts: 1 })
    expect(!result.ok && result.error).toContain('no lo da por seguro')
    expect(provider.requests).toHaveLength(1)
  })

  it('lo que no es Python no llega ni al JEV', async () => {
    const jev = judge([])
    const broken = JSON.stringify({ code: 'for x in', say: 'Roto.' })
    const result = await composeCode(fake([broken, broken]), jev, runtime, request())
    expect(result.ok).toBe(false)
    expect(jev.requests).toHaveLength(0)
    expect(checkCode(runtime, '# solo un comentario')).toBe('El código no tiene ninguna sentencia.')
    expect(checkCode(runtime, '    x = 1')).toContain('sangría')
  })

  it('el juicio, suelto', async () => {
    const verdict = await judgeCode(judge([{ cumple: 0.4, seguro: 0.95 }]), 'orden', 'x = 1')
    expect(verdict).toMatchObject({ fulfils: 0.4, safe: 0.95, ms: 90 })
    expect(verdict.evidence[0]).toEqual({ question: 'cumple', answer: 'no', confidence: 0.4 })
  })
})

describe('escribir código ya redactado en su sitio', () => {
  it('dentro de una función, con su sangría y antes de su return', () => {
    const program = parse(SOURCE)
    const fn = program.nodes.find((n) => n.label === 'media')
    const text = applyEdits(
      SOURCE,
      addCode(program, { into: fn?.id ?? '' }, 'total = 0\nfor v in valores:\n    total += v')
        .edits,
    )
    expect(text).toContain(
      'def media(valores):\n    total = 0\n    for v in valores:\n        total += v\n    return 0\n',
    )
  })

  it('detrás de un paso, al principio, y en un archivo vacío', () => {
    const program = parse(SOURCE)
    const limit = program.nodes.find((n) => n.label === 'limite')
    expect(
      applyEdits(SOURCE, addCode(program, { after: limit?.id ?? '' }, 'x = 1').edits),
    ).toContain('limite = 5\nx = 1\n')
    expect(
      applyEdits(SOURCE, addCode(program, { at: 'start' }, 'x = 1').edits).startsWith('x = 1\n'),
    ).toBe(true)
    expect(applyEdits('', addCode(parse(''), {}, 'x = 1\ny = 2').edits)).toBe('x = 1\ny = 2\n')
    expect(addCode(program, {}, '   \n').edits).toEqual([])
  })
})
