import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser } from '@prysel/python'
import { Kernel } from '../src/kernel.ts'
import { parseLesson } from '../src/lesson.ts'
import { indexOf, stateAt, type Trace, type TraceIndex } from '../src/trace.ts'
import {
  clip,
  collectionModels,
  indexNames,
  maxDepth,
  memoryModel,
  stackModel,
  treeModel,
  treeStatus,
  variablesModel,
} from '../webview/src/insights.ts'
import { expectedFor, judge } from '../webview/src/predict.ts'

/**
 * Los nodos para entender, sobre la traza real de programas de clase: el factorial recursivo, Fibonacci, la
 * ordenación de burbuja y dos nombres que apuntan a la misma lista.
 */

const python = process.env['PRYSEL_PYTHON'] ?? 'python'
const available = spawnSync(python, ['-c', 'import sys'], { stdio: 'ignore' }).status === 0

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))
let parse: (source: string) => ReturnType<typeof buildProgram>
beforeAll(async () => {
  const parser = await createPythonParser({
    runtime: wasmDir,
    language: path.join(wasmDir, 'tree-sitter-python.wasm'),
  })
  parse = (source) => buildProgram(parser.parse(source), source)
}, 30_000)

const FACT =
  'def fact(n):\n    if n <= 1:\n        return 1\n    return n * fact(n - 1)\n\nr = fact(3)\nprint(r)\n'
const FIB =
  'def fib(n):\n    if n < 2:\n        return n\n    return fib(n - 1) + fib(n - 2)\n\nr = fib(4)\n'
const BUBBLE = [
  'xs = [5, 3, 8, 1]',
  'n = len(xs)',
  'for i in range(n):',
  '    for j in range(n - 1 - i):',
  '        if xs[j] > xs[j + 1]:',
  '            xs[j], xs[j + 1] = xs[j + 1], xs[j]',
  'print(xs)',
  '',
].join('\n')
const ALIAS = 'xs = [1, 2]\nys = xs\nzs = [1, 2]\nn = 7\n'

describe('texto corto', () => {
  it('recorta con puntos suspensivos y no toca lo que cabe', () => {
    expect(clip('hola', 10)).toBe('hola')
    expect(clip('abcdefghij', 5)).toBe('abcd…')
  })
})

describe.skipIf(!available)('con la traza real', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = await Kernel.start({ python })
  }, 30_000)
  afterAll(() => {
    kernel.dispose()
  })

  const record = async (source: string): Promise<{ trace: Trace; index: TraceIndex }> => {
    const trace = await kernel.trace(source)
    return { trace, index: indexOf(trace) }
  }
  const last = (index: TraceIndex) => index.trace.events.length - 1

  describe('el árbol de llamadas', () => {
    it('el factorial es una cadena: cada llamada cuelga de la anterior y devuelve su valor', async () => {
      const { trace } = await record(FACT)
      const tree = treeModel(trace)
      expect(tree.nodes.map((n) => n.label)).toEqual(['fact(3)', 'fact(2)', 'fact(1)'])
      expect(tree.nodes.map((n) => n.parent)).toEqual([null, tree.nodes[0]?.id, tree.nodes[1]?.id])
      expect(tree.nodes.map((n) => n.value)).toEqual(['6', '2', '1'])
      expect(tree.nodes.map((n) => n.row)).toEqual([0, 1, 2])
      expect(tree.columns).toBe(1)
      expect(tree.truncated).toBe(false)
    })

    it('Fibonacci se ramifica: nueve llamadas, la raíz centrada sobre sus dos hijos', async () => {
      const { trace } = await record(FIB)
      const tree = treeModel(trace)
      expect(tree.nodes).toHaveLength(9)
      const [root, left, right] = [
        tree.nodes[0],
        tree.nodes[1],
        tree.nodes.find((n) => n.parent === tree.nodes[0]?.id && n !== tree.nodes[1]),
      ]
      expect(left?.parent).toBe(root?.id)
      expect(root?.col).toBeCloseTo(((left?.col ?? 0) + (right?.col ?? 0)) / 2)
      // Las hojas no se pisan: cada una en su columna.
      const leaves = tree.nodes.filter((n) => !tree.nodes.some((m) => m.parent === n.id))
      expect(new Set(leaves.map((n) => n.col)).size).toBe(leaves.length)
      expect(tree.rows).toBe(4)
    })

    it('se ilumina con el paso: las llamadas futuras no se ven, las abiertas van a trazos y la actual manda', async () => {
      const { trace, index } = await record(FACT)
      const tree = treeModel(trace)
      const [a, b, c] = tree.nodes
      const at = (step: number) => {
        const state = stateAt(index, step)
        const current = state.frames[state.frames.length - 1]?.id ?? 0
        return tree.nodes.map((node) => treeStatus(node, step, current))
      }
      expect(at(0)).toEqual(['hidden', 'hidden', 'hidden'])
      // Justo al entrar en la segunda llamada.
      const second = trace.events.findIndex((e) => e.k === 'call' && e.f === b?.id)
      expect(at(second)).toEqual(['open', 'current', 'hidden'])
      // Todo devuelto al final.
      expect(at(last(index))).toEqual(['done', 'done', 'done'])
      expect([a?.ret, c?.ret].every((r) => r !== null)).toBe(true)
    })

    it('un árbol enorme se recorta, y lo que cuelga de lo recortado tampoco se dibuja', async () => {
      const { trace } = await record(
        'def f(n):\n    if n < 1:\n        return 0\n    return f(n - 1) + f(n - 1)\n\nf(7)\n',
      )
      const tree = treeModel(trace)
      expect(tree.truncated).toBe(true)
      expect(tree.nodes.length).toBeLessThanOrEqual(120)
      const ids = new Set(tree.nodes.map((n) => n.id))
      expect(tree.nodes.every((n) => n.parent === null || ids.has(n.parent))).toBe(true)
    })

    it('sin llamadas no hay árbol', async () => {
      const { trace } = await record('x = 1\n')
      expect(treeModel(trace).nodes).toEqual([])
    })
  })

  describe('la pila de llamadas', () => {
    it('crece con la recursión, con la de arriba como actual, y muestra lo que devuelve', async () => {
      const { index } = await record(FACT)
      const depth = maxDepth(index.trace)
      expect(depth).toBe(4)
      const deepest = index.trace.events.findIndex((e) => e.k === 'return' && e.v === 1)
      const model = stackModel(stateAt(index, deepest))
      expect(model.frames.map((f) => f.title)).toEqual(['fact', 'fact', 'fact', 'Programa'])
      expect(model.frames[0]?.current).toBe(true)
      expect(model.frames[0]?.returning).toBe('1')
      expect(model.frames[1]?.returning).toBeNull()
      expect(model.frames[0]?.locals[0]).toMatchObject({ name: 'n', text: '1' })
      expect(model.hidden).toBe(0)
    })

    it('una recursión profunda se resume: las de arriba y la base', async () => {
      const { index } = await record(
        'def f(n):\n    if n == 0:\n        return 0\n    return f(n - 1)\n\nf(12)\n',
      )
      const deepest = index.trace.events.findIndex((e) => e.d === 13)
      const model = stackModel(stateAt(index, deepest))
      expect(model.frames).toHaveLength(7)
      expect(model.hidden).toBe(13 + 1 - 7)
      expect(model.frames.at(-1)?.title).toBe('Programa')
      expect(model.frames[0]?.current).toBe(true)
    })
  })

  describe('la colección viva (ordenación de burbuja)', () => {
    it('los índices son los nombres que se usan entre corchetes', () => {
      expect(indexNames(parse(BUBBLE))).toEqual(new Set(['j']))
    })

    it('tras un intercambio se resaltan las dos celdas que cambiaron, y `j` marca su sitio', async () => {
      const { index } = await record(BUBBLE)
      const indexes = indexNames(parse(BUBBLE))
      // La primera vez que `xs` cambia después de definirse: el evento que sigue al primer intercambio.
      const swapped = index.trace.events.findIndex(
        (e, i) =>
          e.ch && 'xs' in e.ch && i > index.trace.events.findIndex((x) => x.ch && 'xs' in x.ch),
      )
      expect(swapped).toBeGreaterThan(0)
      const [model] = collectionModels(
        stateAt(index, swapped),
        stateAt(index, swapped - 1),
        indexes,
      )
      expect(model?.name).toBe('xs')
      expect(model?.items.map((i) => i.text)).toEqual(['3', '5', '8', '1'])
      expect(model?.items.map((i) => i.changed)).toEqual([true, true, false, false])
      expect(model?.pointers).toEqual([{ name: 'j', index: 0 }])
      expect(model?.numeric).toBe(true)
      // Las barras van de la más baja a la más alta.
      const levels = model?.items.map((i) => i.level ?? -1) ?? []
      expect(Math.min(...levels)).toBeCloseTo(0.12)
      expect(Math.max(...levels)).toBeCloseTo(1)
    })

    it('al final está ordenada, y nada aparece resaltado sin un cambio previo', async () => {
      const { index } = await record(BUBBLE)
      const end = stateAt(index, last(index))
      const [model] = collectionModels(
        end,
        stateAt(index, last(index) - 1),
        indexNames(parse(BUBBLE)),
      )
      expect(model?.items.map((i) => i.text)).toEqual(['1', '3', '5', '8'])
      expect(model?.items.every((i) => !i.changed)).toBe(true)
      expect(collectionModels(end, null, new Set())[0]?.items.every((i) => !i.changed)).toBe(true)
    })

    it('lo que no es una lista de números también se ve (celdas sin barra)', async () => {
      const { index } = await record('ws = ["a", "b"]\n')
      const [model] = collectionModels(stateAt(index, last(index)), null, new Set())
      expect(model?.numeric).toBe(false)
      expect(model?.items.map((i) => [i.text, i.level])).toEqual([
        ["'a'", null],
        ["'b'", null],
      ])
    })

    it('sin listas cortas no hay nada que enseñar', async () => {
      const { index } = await record('x = 1\ny = {"a": 1}\n')
      expect(collectionModels(stateAt(index, last(index)), null, new Set())).toEqual([])
    })
  })

  describe('la memoria', () => {
    it('dos nombres que apuntan a la misma lista son un alias; una copia es otro objeto', async () => {
      const { index } = await record(ALIAS)
      const model = memoryModel(stateAt(index, last(index)))
      const object = (name: string) => model.names.find((n) => n.name === name)?.object
      expect(object('xs')).not.toBeNull()
      expect(object('xs')).toBe(object('ys'))
      expect(object('zs')).not.toBe(object('xs'))
      expect(model.objects).toHaveLength(2)
      expect(model.objects.find((o) => o.id === object('xs'))?.owners.sort()).toEqual([
        'Programa.xs',
        'Programa.ys',
      ])
      // Un número no apunta a ningún objeto: su valor va en el propio nombre.
      expect(model.names.find((n) => n.name === 'n')).toMatchObject({ object: null, text: '7' })
    })

    it('las variables de cada llamada abierta se ven, con el nombre de su función', async () => {
      const { index } = await record(FACT)
      const deepest = index.trace.events.findIndex((e) => e.k === 'return' && e.v === 1)
      const model = memoryModel(stateAt(index, deepest))
      expect(model.names.filter((n) => n.frame === 'fact')).toHaveLength(3)
    })
  })

  describe('la tabla de variables', () => {
    it('una columna por cada momento en que algo cambió, y solo lo que cambió va resaltado', async () => {
      const { index } = await record('a = 1\nb = a + 1\na = 5\nc = 0\n')
      const model = variablesModel(index, last(index))
      expect(model.title).toBe('Programa')
      expect(model.names).toEqual(['a', 'b', 'c'])
      expect(model.columns.map((c) => c.cells.map((cell) => cell?.text ?? null))).toEqual([
        ['1', null, null],
        ['1', '2', null],
        ['5', '2', null],
        ['5', '2', '0'],
      ])
      expect(model.columns.map((c) => c.cells.map((cell) => cell?.changed ?? false))).toEqual([
        [true, false, false],
        [false, true, false],
        [true, false, false],
        [false, false, true],
      ])
    })

    it('dentro de una función, la tabla es de esa llamada', async () => {
      const { index } = await record(FACT)
      const inside = index.trace.events.findIndex((e) => e.k === 'call')
      const model = variablesModel(index, inside)
      expect(model.title).toBe('fact')
      expect(model.names).toEqual(['n'])
    })

    it('antes de empezar no hay nada, y solo caben las últimas columnas', async () => {
      const { index } = await record('a = 0\na = 1\na = 2\na = 3\na = 4\n')
      expect(variablesModel(index, -1).columns).toEqual([])
      const short = variablesModel(index, last(index), 3)
      expect(short.columns).toHaveLength(3)
      expect(short.columns.at(-1)?.cells[0]?.text).toBe('4')
    })
  })

  describe('predecir antes de ver', () => {
    const PRED = 'total = 0\nfor i in range(3):\n    total = total + i\nprint(total)\nr = 0\n'

    it('el valor esperado es el que tiene el nombre tras ejecutar esa línea', async () => {
      const { index } = await record(PRED)
      const step = (line: number, nth = 1) => {
        let seen = 0
        return index.trace.events.findIndex((e) => e.k === 'line' && e.l === line && ++seen === nth)
      }
      const ask = { text: '¿Cuánto vale total?', expect: 'value' as const, name: 'total' }
      expect(expectedFor(index, step(1), ask)).toBe('0')
      expect(expectedFor(index, step(3, 1), ask)).toBe('0')
      expect(expectedFor(index, step(3, 2), ask)).toBe('1')
      expect(expectedFor(index, step(3, 3), ask)).toBe('3')
      expect(expectedFor(index, step(1), { ...ask, name: 'nada' })).toBeNull()
    })

    it('lo que imprime una línea sale de la traza', async () => {
      const { index } = await record(PRED)
      const at = index.trace.events.findIndex((e) => e.k === 'line' && e.l === 4)
      expect(expectedFor(index, at, { text: '¿Qué imprime?', expect: 'output' })).toBe('3')
      const other = index.trace.events.findIndex((e) => e.k === 'line' && e.l === 1)
      expect(expectedFor(index, other, { text: '¿Qué imprime?', expect: 'output' })).toBeNull()
    })

    it('una línea que llama a una función espera al valor cuando vuelve al mismo marco', async () => {
      const { index } = await record(FACT)
      const at = index.trace.events.findIndex((e) => e.k === 'line' && e.l === 6)
      expect(expectedFor(index, at, { text: '¿r?', expect: 'value', name: 'r' })).toBe('6')
    })
  })
})

describe('juzgar una respuesta', () => {
  it('tolera espacios, comillas, mayúsculas y 2 frente a 2.0', () => {
    expect(judge(' 6 ', '6')).toBe(true)
    expect(judge('2.0', '2')).toBe(true)
    expect(judge('"hola"', "'hola'")).toBe(true)
    expect(judge('true', 'True')).toBe(true)
    expect(judge('[1, 2]', '[1,2]')).toBe(true)
  })

  it('no da por buena una respuesta vacía ni distinta', () => {
    expect(judge('', '')).toBe(false)
    expect(judge('  ', '0')).toBe(false)
    expect(judge('7', '6')).toBe(false)
    expect(judge('1e', '1')).toBe(false)
  })
})

describe('el guion pide nodos y preguntas', () => {
  const base = (extra: Record<string, unknown>) => ({
    version: 1,
    title: 'T',
    beats: [{ at: { text: 'x' }, note: { text: 'a' } }],
    ...extra,
  })

  it('«show» elige los nodos que se enseñan al abrir, sin repetir', () => {
    const result = parseLesson(base({ show: ['stack', 'tree', 'stack'] }))
    expect(result.ok && result.lesson.show).toEqual(['stack', 'tree'])
    expect(parseLesson(base({ show: ['pila'] })).ok).toBe(false)
    expect(parseLesson(base({ show: 'stack' })).ok).toBe(false)
  })

  it('una pregunta lleva su texto y lo que espera; por un valor, también el nombre', () => {
    const ask = (question: unknown) =>
      parseLesson(base({ beats: [{ at: { text: 'x' }, note: { text: 'a' }, ask: question }] }))
    const ok = ask({ text: '¿Cuánto vale?', expect: 'value', name: 'total' })
    expect(ok.ok && ok.lesson.beats[0]?.ask).toEqual({
      text: '¿Cuánto vale?',
      expect: 'value',
      name: 'total',
    })
    expect(ask({ text: '¿Qué imprime?', expect: 'output' }).ok).toBe(true)
    expect(ask({ text: '¿?', expect: 'value' }).ok).toBe(false)
    expect(ask({ text: '', expect: 'output' }).ok).toBe(false)
    expect(ask({ text: 'a', expect: 'otra' }).ok).toBe(false)
    expect(ask('hola').ok).toBe(false)
  })
})

describe('los nodos que conoce el guion son los del lienzo', () => {
  it('las mismas cinco', async () => {
    const { INSIGHTS } = await import('../webview/src/insights.ts')
    const { INSIGHT_IDS } = await import('../src/lesson.ts')
    expect([...INSIGHTS]).toEqual([...INSIGHT_IDS])
  })
})
