import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kernel } from '../src/kernel.ts'
import {
  apply,
  describeTrace,
  indexOf,
  initialState,
  stateAt,
  visibleLocals,
  type Trace,
  type TraceEvent,
} from '../src/trace.ts'

/**
 * La traza: lo que el motor graba línea a línea, y cómo se reconstruye el estado en cualquier paso (hacia
 * delante, hacia atrás o saltando) sin volver a ejecutar nada.
 */

const python = process.env['PRYSEL_PYTHON'] ?? 'python'
const available = spawnSync(python, ['-c', 'import sys'], { stdio: 'ignore' }).status === 0

// Factorial recursivo de 3, tal como lo graba el motor.
const FACT: TraceEvent[] = [
  { k: 'line', l: 1, d: 0, f: 0 },
  { k: 'line', l: 6, d: 0, f: 0 },
  { k: 'line', l: 7, d: 0, f: 0, ch: { xs: '[1, 2]' }, ids: { xs: 111 } },
  { k: 'line', l: 8, d: 0, f: 0, ch: { ys: '[1, 2]' }, ids: { ys: 111 } },
  { k: 'call', l: 1, d: 1, f: 1, fn: 'fact', ch: { n: 3 } },
  { k: 'line', l: 2, d: 1, f: 1 },
  { k: 'line', l: 4, d: 1, f: 1 },
  { k: 'call', l: 1, d: 2, f: 2, fn: 'fact', ch: { n: 2 } },
  { k: 'line', l: 2, d: 2, f: 2 },
  { k: 'line', l: 3, d: 2, f: 2 },
  { k: 'return', l: 3, d: 2, f: 2, v: 1 },
  { k: 'return', l: 4, d: 1, f: 1, v: 3 },
  { k: 'line', l: 9, d: 0, f: 0, ch: { r: 3 } },
  { k: 'end', l: 9, d: 0, f: 0, o: '3\n' },
]
const trace = (events = FACT): Trace => ({ events, truncated: false, error: null, output: '' })

describe('reconstruir el estado de un paso', () => {
  it('antes de empezar solo hay el programa, vacío', () => {
    const state = initialState()
    expect(state.step).toBe(-1)
    expect(state.frames).toHaveLength(1)
    expect(state.frames[0]).toMatchObject({ id: 0, fn: null, locals: {} })
  })

  it('cada paso guarda la línea en la que está y lo que cambió', () => {
    const index = indexOf(trace())
    const at = stateAt(index, 2)
    expect(at.event?.l).toBe(7)
    expect(at.frames[0]?.line).toBe(7)
    expect(at.frames[0]?.locals).toEqual({ xs: '[1, 2]' })
  })

  it('una llamada apila un marco con sus argumentos, y una recursión, uno por vuelta', () => {
    const index = indexOf(trace())
    const inner = stateAt(index, 8)
    expect(inner.frames.map((f) => [f.fn, f.line, f.locals])).toEqual([
      [null, 8, { xs: '[1, 2]', ys: '[1, 2]' }],
      ['fact', 4, { n: 3 }],
      ['fact', 2, { n: 2 }],
    ])
  })

  it('un retorno enseña el valor y en el paso siguiente el marco desaparece', () => {
    const index = indexOf(trace())
    const returning = stateAt(index, 10)
    expect(returning.frames.at(-1)).toMatchObject({ fn: 'fact', returned: { value: 1 } })
    const after = stateAt(index, 11)
    expect(after.frames.map((f) => f.fn)).toEqual([null, 'fact'])
    expect(after.frames.at(-1)?.returned).toEqual({ value: 3 })
    expect(stateAt(index, 12).frames.map((f) => f.fn)).toEqual([null])
  })

  it('lo que se imprime se acumula', () => {
    const index = indexOf(trace())
    expect(stateAt(index, 12).output).toBe('')
    expect(stateAt(index, 13).output).toBe('3\n')
  })

  it('las variables visibles: de la llamada actual hacia el programa, sin repetir nombres', () => {
    const state = stateAt(indexOf(trace()), 8)
    expect(visibleLocals(state).map((v) => `${v.name}@${v.frame}`)).toEqual(['n@2', 'xs@0', 'ys@0'])
  })

  it('dos nombres con la misma identidad son el mismo objeto; al cambiar de tipo la pierden', () => {
    const state = stateAt(indexOf(trace()), 3)
    expect(state.frames[0]?.ids).toEqual({ xs: 111, ys: 111 })
    const rebound = apply(state, { k: 'line', l: 9, d: 0, f: 0, ch: { ys: 5 } })
    expect(rebound.frames[0]?.ids).toEqual({ xs: 111 })
  })

  it('un paso no modifica el anterior', () => {
    const index = indexOf(trace())
    const before = stateAt(index, 3)
    const snapshot = JSON.stringify(before)
    stateAt(index, 13)
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

describe('saltar por la traza', () => {
  const long = (n: number): TraceEvent[] =>
    Array.from({ length: n }, (_, i) => ({
      k: 'line' as const,
      l: (i % 5) + 1,
      d: 0,
      f: 0,
      ch: { i },
    }))

  it('ir hacia atrás y saltar dan lo mismo que ir hacia delante', () => {
    const index = indexOf(trace(long(300)), 16)
    const forward = (step: number) => {
      let state = initialState()
      for (const event of index.trace.events.slice(0, step + 1)) state = apply(state, event)
      return state
    }
    for (const step of [0, 15, 16, 17, 127, 128, 250, 299, 100, 3]) {
      expect(stateAt(index, step), String(step)).toEqual(forward(step))
    }
  })

  it('fuera de rango se queda en los extremos', () => {
    const index = indexOf(trace(long(10)))
    expect(stateAt(index, -5).step).toBe(-1)
    expect(stateAt(index, 999).step).toBe(9)
  })

  it('un resumen de la traza', () => {
    expect(describeTrace(trace())).toEqual({ steps: 14, calls: 2, depth: 2, lines: 8 })
  })
})

describe.skipIf(!available)('grabar la traza con el motor', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = await Kernel.start({ python })
  }, 30_000)
  afterAll(() => {
    kernel.dispose()
  })

  const FACT_SOURCE =
    'def fact(n):\n    if n <= 1:\n        return 1\n    return n * fact(n - 1)\n\nxs = [1, 2]\nys = xs\nr = fact(3)\nprint(r)\n'

  it('graba el factorial recursivo: llamadas, marcos, retornos y lo impreso', async () => {
    const result = await kernel.trace(FACT_SOURCE)
    expect(result.error).toBeNull()
    expect(result.truncated).toBe(false)
    expect(result.output).toBe('6\n')
    const calls = result.events.filter((e) => e.k === 'call')
    expect(calls.map((e) => [e.fn, e.d, e.ch])).toEqual([
      ['fact', 1, { n: 3 }],
      ['fact', 2, { n: 2 }],
      ['fact', 3, { n: 1 }],
    ])
    // Cada llamada es un marco distinto.
    expect(new Set(calls.map((e) => e.f)).size).toBe(3)
    expect(result.events.filter((e) => e.k === 'return').map((e) => e.v)).toEqual([1, 2, 6])
    expect(result.events.at(-1)).toMatchObject({ k: 'end', l: 9 })
  })

  it('lo que se graba se reconstruye: la pila llega a tres marcos y vuelve al programa', async () => {
    const result = await kernel.trace(FACT_SOURCE)
    const index = indexOf(result)
    const depths = result.events.map((_, i) => stateAt(index, i).frames.length)
    expect(Math.max(...depths)).toBe(4)
    expect(stateAt(index, result.events.length - 1).frames).toHaveLength(1)
    expect(stateAt(index, result.events.length - 1).frames[0]?.locals['r']).toBe(6)
    expect(stateAt(index, result.events.length - 1).output).toBe('6\n')
  })

  it('un alias se ve como tal: los dos nombres llevan la misma identidad', async () => {
    const result = await kernel.trace(FACT_SOURCE)
    const state = stateAt(indexOf(result), result.events.length - 1)
    const ids = state.frames[0]?.ids ?? {}
    expect(ids['xs']).toBeDefined()
    expect(ids['xs']).toBe(ids['ys'])
    // Un número no tiene identidad que enseñar.
    expect(ids['r']).toBeUndefined()
  })

  it('lo que se imprime llega con el paso siguiente al que lo imprimió', async () => {
    const result = await kernel.trace('print("a")\nprint("b")\nx = 1\n')
    expect(result.events.map((e) => [e.k, e.l, e.o ?? ''])).toEqual([
      ['line', 1, ''],
      ['line', 2, 'a\n'],
      ['line', 3, 'b\n'],
      ['end', 3, ''],
    ])
  })

  it('no enseña las definiciones (funciones, módulos, clases), solo los datos', async () => {
    const result = await kernel.trace(
      'import math\ndef f(): pass\nclass C: pass\nx = 1\n_ = math.pi\n',
    )
    const names = new Set(result.events.flatMap((e) => Object.keys(e.ch ?? {})))
    expect(names).toEqual(new Set(['x', '_']))
  })

  it('los valores se enseñan cortos: números tal cual, colecciones recortadas', async () => {
    const result = await kernel.trace(
      'a = 3\nb = 2.5\nc = "hola"\nd = list(range(100))\ne = {"k": [1, 2]}\nf = None\ng = True\n',
    )
    const state = stateAt(indexOf(result), result.events.length - 1)
    const locals = state.frames[0]?.locals ?? {}
    expect(locals['a']).toBe(3)
    expect(locals['b']).toBe(2.5)
    expect(locals['c']).toBe("'hola'")
    // Más de 40 elementos: texto recortado.
    expect(String(locals['d'])).toMatch(/^\[0, 1, 2, 3, 4, 5, 6, 7, .*\]$/)
    expect(String(locals['d']).length).toBeLessThanOrEqual(70)
    expect(locals['e']).toBe("{'k': [1, 2]}")
    expect(locals['f']).toBeNull()
    expect(locals['g']).toBe(true)
  })

  it('una excepción queda grabada con su línea, y el programa acaba', async () => {
    const result = await kernel.trace('def f(x):\n    return 1 / x\n\nf(0)\nprint("no llega")\n')
    expect(result.error).toMatchObject({ name: 'ZeroDivisionError', line: 2 })
    const failure = result.events.find((e) => e.k === 'exception')
    expect(failure).toMatchObject({ l: 2, e: 'ZeroDivisionError: division by zero' })
    expect(result.output).toBe('')
  })

  it('un programa que no acaba se corta al llegar al tope de pasos', async () => {
    const result = await kernel.trace('n = 0\nwhile True:\n    n += 1\n', 200)
    expect(result.truncated).toBe(true)
    expect(result.events.length).toBe(200)
  })

  it('una comprensión no añade marcos ni ruido', async () => {
    const result = await kernel.trace('xs = [i * 2 for i in range(3)]\ntotal = sum(xs)\n')
    expect(result.events.some((e) => e.k === 'call')).toBe(false)
    expect(result.events.map((e) => e.l)).toEqual([1, 2, 2])
  })

  it('el código de la biblioteca estándar no se traza: solo el del programa', async () => {
    const result = await kernel.trace('import json\ns = json.dumps({"a": 1})\n')
    expect(result.events.every((e) => e.l >= 1 && e.l <= 2)).toBe(true)
    expect(result.events.some((e) => e.k === 'call')).toBe(false)
  })

  it('un error de sintaxis se cuenta, no rompe el motor', async () => {
    const result = await kernel.trace('x = (1 +\n')
    expect(result.error?.name).toBe('SyntaxError')
    expect(result.events).toEqual([])
    expect((await kernel.run('1 + 1')).result?.repr).toBe('2')
  })

  it('la traza no toca el espacio de nombres de las ejecuciones', async () => {
    await kernel.reset()
    await kernel.run('valor = 1')
    await kernel.trace('valor = 99\notro = 5\n')
    const after = await kernel.run('valor')
    expect(after.result?.repr).toBe('1')
    expect((await kernel.run('"otro" in globals()')).result?.repr).toBe('False')
  })

  it('el programa se ejecuta como principal: `if __name__ == "__main__"` corre', async () => {
    const result = await kernel.trace('if __name__ == "__main__":\n    print("hola")\n')
    expect(result.output).toBe('hola\n')
  })
})

describe.skipIf(!available)('modo seguro: código que nadie del usuario escribió', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = await Kernel.start({ python })
  }, 30_000)
  afterAll(() => {
    kernel.dispose()
  })

  it('sin `safe`, todo corre igual que siempre', async () => {
    const result = await kernel.trace('import os\nprint(os.name)\n')
    expect(result.error).toBeNull()
  })

  it('un módulo fuera de la lista corta ni se compila: llega como error, sin ejecutar nada', async () => {
    const result = await kernel.trace('import os\nprint(os.name)\n', 5000, true)
    expect(result.events).toEqual([])
    expect(result.output).toBe('')
    expect(result.error).toMatchObject({ name: 'UnsafeCode' })
    expect(result.error?.message).toMatch(/«os».*no está permitido en modo seguro/)
  })

  it('`open`, `eval` y compañía se rechazan aunque no haga falta importar nada', async () => {
    const abre = await kernel.trace('f = open("x.txt")\n', 5000, true)
    expect(abre.error?.name).toBe('UnsafeCode')
    const evalua = await kernel.trace('eval("1 + 1")\n', 5000, true)
    expect(evalua.error?.name).toBe('UnsafeCode')
  })

  it('la vía clásica de escape (subclasses de object) también se corta', async () => {
    const result = await kernel.trace(
      'fuga = ().__class__.__bases__[0].__subclasses__()\n',
      5000,
      true,
    )
    expect(result.error).toMatchObject({ name: 'UnsafeCode' })
    expect(result.error?.message).toContain('__subclasses__')
  })

  it('los módulos de la lista corta, y una clase con `__init__`, corren normal', async () => {
    const result = await kernel.trace(
      [
        'import math, random',
        'random.seed(1)',
        'class Punto:',
        '    def __init__(self, x, y):',
        '        self.x = x',
        '        self.y = y',
        'p = Punto(1, 2)',
        'print(math.hypot(p.x, p.y))',
        'if __name__ == "__main__":',
        '    print(random.random())',
      ].join('\n'),
      5000,
      true,
    )
    expect(result.error).toBeNull()
    expect(result.truncated).toBe(false)
  })

  it('el tope de pasos sigue cortando un bucle sin fin, aunque sea seguro', async () => {
    const result = await kernel.trace('n = 0\nwhile True:\n    n += 1\n', 200, true)
    expect(result.truncated).toBe(true)
    expect(result.events.length).toBe(200)
  })
})

describe.skipIf(!available)('las listas cortas se graban enteras', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = await Kernel.start({ python })
  }, 30_000)
  afterAll(() => {
    kernel.dispose()
  })

  const SWAP = 'xs = [5, 3, 8, 1, 9, 2, 7, 4, 6, 0]\nxs[9], xs[0] = xs[0], xs[9]\nt = (1, "a")\n'

  it('una lista de escalares llega con todos sus elementos, aunque sean más de los que caben en un repr', async () => {
    const result = await kernel.trace(SWAP)
    const state = stateAt(indexOf(result), result.events.length - 1)
    expect(state.frames[0]?.locals['xs']).toEqual({
      l: [0, 3, 8, 1, 9, 2, 7, 4, 6, 5],
      n: 10,
      t: 'list',
    })
    expect(state.frames[0]?.locals['t']).toEqual({ l: [1, "'a'"], n: 2, t: 'tuple' })
  })

  it('un cambio lejos del principio (un intercambio en la cola) cuenta como cambio', async () => {
    const result = await kernel.trace(
      'xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]\nxs[9] = 0\nxs[9] = 99\n',
    )
    // Un evento por línea, y las dos escrituras son cambios de `xs`.
    const changed = result.events.filter((e) => e.ch && 'xs' in e.ch)
    expect(changed).toHaveLength(3)
  })

  it('una lista con objetos dentro, o larguísima, se enseña como texto corto', async () => {
    const result = await kernel.trace(
      'a = [[1], [2]]\nb = list(range(41))\nc = [1.5, float("nan")]\n',
    )
    const locals = stateAt(indexOf(result), result.events.length - 1).frames[0]?.locals ?? {}
    expect(typeof locals['a']).toBe('string')
    expect(typeof locals['b']).toBe('string')
    // Un `nan` no es JSON: se cuenta como texto.
    expect(locals['c']).toEqual({ l: [1.5, 'nan'], n: 2, t: 'list' })
  })
})
