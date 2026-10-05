import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { applyEdits } from '@prysel/python/edits'
import { readEventStream, streamText } from '../src/ai/stream.ts'
import { deepseekProvider } from '../src/ai/deepseek.ts'
import {
  BuildPlan,
  StepStream,
  judgeStep,
  paceOf,
  parseStep,
  type BuildStep,
} from '../src/jev/build.ts'
import type { Spot } from '../src/jev/engine.ts'
import { localDecider } from '../src/jev/local.ts'

/**
 * Construir paso a paso: los pasos salen de un texto que llega a trozos, y cada uno se escribe al final de
 * lo que ya hay. Lo que se comprueba es que el Python es válido **tras cada paso** (el diagrama se rehace
 * cada vez) y que queda lo que se dictó.
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

const step = (level: number, code: string, say = ''): BuildStep => ({ level, code, say })

/** Escribe los pasos uno a uno, como el anfitrión, y devuelve cómo queda el texto tras cada uno. */
function build(source: string, steps: BuildStep[], spot: (program: Program) => Spot = () => ({})) {
  let text = source
  const plan = new BuildPlan(spot(parse(source)))
  const frames: string[] = []
  const lines: number[] = []
  for (const next of steps) {
    const placed = plan.place(parse(text), next)
    if (!placed.ok) throw new Error(placed.error)
    if (placed.change) text = applyEdits(text, placed.change.edits)
    expect(hasError(text), text).toBe(false)
    plan.commit(next, placed)
    frames.push(text)
    lines.push(placed.line)
  }
  return { text, frames, lines }
}

describe('los pasos salen del texto según llega', () => {
  it('un paso por línea, en cuanto la línea se cierra', () => {
    const stream = new StepStream()
    expect(stream.push('{"nivel": 0, "code": "a = 3", "say": "El pri')).toEqual([])
    expect(stream.push('mer número."}\n{"nivel": 0, "code": "b')).toEqual([
      { level: 0, code: 'a = 3', say: 'El primer número.' },
    ])
    expect(stream.push(' = 5", "say": "El segundo."}')).toEqual([])
    expect(stream.end()).toEqual([{ level: 0, code: 'b = 5', say: 'El segundo.' }])
  })

  it('lo que no es un paso se salta: vallas, texto suelto, líneas rotas', () => {
    const stream = new StepStream()
    const steps = stream.push(
      '```json\nAquí va:\n{"code": "x = 1"},\n{"code": 7}\n{"nivel": -2, "code": "y = 2"}\n```\n',
    )
    expect(steps).toEqual([
      { level: 0, code: 'x = 1', say: '' },
      { level: 0, code: 'y = 2', say: '' },
    ])
    expect(parseStep('{"code": "   "}')).toBeNull()
  })

  it('el texto llega a trozos desde la API (y se puede cortar)', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"{\\"code\\": "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"\\"a = 1\\"}\\n"}}]}\n\ndata: [DONE]\n\n',
    ]
    const body = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
          controller.close()
        },
      })
    const provider = deepseekProvider({
      apiKey: 'x',
      fetchImpl: (() => Promise.resolve(new Response(body()))) as typeof fetch,
    })
    const seen: string[] = []
    const stream = new StepStream()
    const steps: BuildStep[] = []
    const text = await streamText(provider, { system: 's', prompt: 'p' }, (delta) => {
      seen.push(delta)
      steps.push(...stream.push(delta))
    })
    expect(seen).toHaveLength(2)
    expect(text).toBe('{"code": "a = 1"}\n')
    expect(steps).toEqual([{ level: 0, code: 'a = 1', say: '' }])

    const stopped = new AbortController()
    stopped.abort()
    expect(
      await readEventStream(
        new Response(body()),
        () => 'x',
        () => undefined,
        stopped.signal,
      ),
    ).toBe('')
    // Un proveedor que no va por trozos lo entrega entero.
    const whole: string[] = []
    await streamText(
      { id: 'm', generate: () => Promise.resolve('todo') },
      { system: '', prompt: '' },
      (d) => whole.push(d),
    )
    expect(whole).toEqual(['todo'])
  })
})

describe('cada paso se escribe al final de lo que ya hay', () => {
  it('una función que suma dos números: los datos, la función, el resultado', () => {
    const { text, frames, lines } = build('', [
      step(0, 'numero_1 = 3'),
      step(0, 'numero_2 = 5'),
      step(0, 'def sumar(a, b):'),
      step(1, 'return a + b'),
      step(0, 'resultado = sumar(numero_1, numero_2)'),
      step(0, 'print(resultado)'),
    ])
    expect(text).toBe(
      [
        'numero_1 = 3',
        'numero_2 = 5',
        'def sumar(a, b):',
        '    return a + b',
        'resultado = sumar(numero_1, numero_2)',
        'print(resultado)',
        '',
      ].join('\n'),
    )
    // La cabecera nace con un `pass`, que su primer paso de dentro sustituye.
    expect(frames[2]).toContain('def sumar(a, b):\n    pass\n')
    expect(lines).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('bloques dentro de bloques, y volver a salir', () => {
    const { text } = build('', [
      step(0, 'total = 0'),
      step(0, 'for n in range(5):'),
      step(1, 'if n % 2 == 0:'),
      step(2, 'total = total + n'),
      step(2, 'print(n)'),
      step(1, 'print("vuelta")'),
      step(0, 'print(total)'),
    ])
    expect(text).toBe(
      [
        'total = 0',
        'for n in range(5):',
        '    if n % 2 == 0:',
        '        total = total + n',
        '        print(n)',
        '    print("vuelta")',
        'print(total)',
        '',
      ].join('\n'),
    )
  })

  it('el «no» de una decisión, con varias sentencias en su orden', () => {
    const { text, lines } = build('nota = 7\n', [
      step(0, 'if nota >= 5:'),
      step(1, 'print("aprobado")'),
      step(0, 'else:'),
      step(1, 'print("suspenso")'),
      step(1, 'print("a repasar")'),
      step(0, 'print("fin")'),
    ])
    expect(text).toBe(
      [
        'nota = 7',
        'if nota >= 5:',
        '    print("aprobado")',
        'else:',
        '    print("suspenso")',
        '    print("a repasar")',
        'print("fin")',
        '',
      ].join('\n'),
    )
    expect(lines).toEqual([2, 3, 2, 5, 6, 7])
  })

  it('dentro de una función que ya existe, antes de su return, y sin mover lo de después', () => {
    const source = 'def media(valores):\n    return 0\n\nprint("fin")\n'
    const { text } = build(
      source,
      [step(0, 'total = 0'), step(0, 'for v in valores:'), step(1, 'total = total + v')],
      (program) => ({ into: program.nodes.find((n) => n.label === 'media')?.id ?? '' }),
    )
    expect(text).toBe(
      'def media(valores):\n    total = 0\n    for v in valores:\n        total = total + v\n    return 0\n\nprint("fin")\n',
    )
  })

  it('con etapas: el rótulo va encima de su sentencia, separado de lo anterior', () => {
    const { text, lines } = build('', [
      step(0, '# Preparar los datos\nnotas = [7, 4, 9]'),
      step(0, 'total = 0'),
      step(0, '# Sumar\nfor nota in notas:'),
      step(1, 'total = total + nota'),
    ])
    expect(text).toBe(
      '# Preparar los datos\nnotas = [7, 4, 9]\ntotal = 0\n\n# Sumar\nfor nota in notas:\n    total = total + nota\n',
    )
    expect(lines).toEqual([2, 3, 6, 7])
    expect((parse(text).sections ?? []).map((section) => section.title)).toEqual([
      'Preparar los datos',
      'Sumar',
    ])
  })

  it('un paso más hondo de lo que hay abierto va donde se pueda; lo que no se arma así se dice', () => {
    const { text } = build('', [step(0, 'x = 1'), step(3, 'y = 2')])
    expect(text).toBe('x = 1\ny = 2\n')
    const plan = new BuildPlan({})
    expect(plan.place(parse(''), step(0, 'try:'))).toMatchObject({ ok: false })
    expect(plan.place(parse(''), step(0, 'else:'))).toMatchObject({ ok: false })
    expect(plan.place(parse(''), step(0, '# solo un comentario'))).toMatchObject({ ok: false })
  })
})

describe('lo que el JEV decide de cada paso', () => {
  it('si es seguro, cómo se enseña y cuánto detenerse', async () => {
    const data = await judgeStep(
      localDecider(),
      'suma dos números',
      step(0, 'a = 3', 'El primero.'),
    )
    expect(data).toMatchObject({ wide: false, pause: false })
    expect(data.safe).toBeGreaterThan(0.7)
    const fn = await judgeStep(localDecider(), 'suma dos números', step(0, 'def sumar(a, b):'))
    expect(fn).toMatchObject({ wide: true, pause: true })
    const risky = await judgeStep(localDecider(), 'suma', step(0, 'os.remove("datos.txt")'))
    expect(risky.safe).toBeLessThan(0.7)
  })

  it('el ritmo sale de lo que se tarda en decir la frase', () => {
    const short = paceOf(step(0, 'a = 3', 'El primero.'), false)
    const long = paceOf(
      step(0, 'a = 3', 'Guardamos el primer número en una variable con nombre.'),
      false,
    )
    expect(long).toBeGreaterThan(short)
    expect(paceOf(step(0, 'a = 3', 'El primero.'), true)).toBeGreaterThan(short)
    expect(paceOf(step(0, 'a = 3', 'x'.repeat(900)), false)).toBe(5000)
  })
})
