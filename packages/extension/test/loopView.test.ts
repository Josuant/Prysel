import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { topLevelOf } from '../src/plan.ts'
import type { LoopView, RunView } from '../src/runs.ts'
import {
  curvePoints,
  curvesOf,
  enclosingLoops,
  formatValue,
  loopRefs,
  observedInLoops,
  positionOf,
} from '../webview/src/loops.ts'
import { SERIES, contentOf, type PinKey } from '../webview/src/pins.ts'
import { viewerSize } from '@prysel/ui'

/**
 * Los valores por vuelta sobre el diagrama: qué serie es de qué nodo bucle, qué vale cada nombre en la
 * vuelta que se mira, y qué se puede dibujar como curva.
 */

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))

let parse: (source: string) => Program

beforeAll(async () => {
  const parser = await createPythonParser({
    runtime: wasmDir,
    language: path.join(wasmDir, 'tree-sitter-python.wasm'),
  })
  parse = (source) => buildProgram(parser.parse(source), source)
}, 30_000)

const view = (over: Partial<LoopView> = {}): LoopView => ({
  n: 3,
  idx: [0, 1, 2],
  names: { total: [0, 1, 3], nombre: ["'a'", "'b'", "'c'"] },
  done: true,
  ...over,
})

const runsFor = (program: Program, loops: Record<string, LoopView>): Record<string, RunView> => {
  const top = topLevelOf(program)
  const statement = program.nodes.find((n) => n.kind === 'control.loop' && top.get(n.id) === n.id)
  return statement ? { [statement.id]: { state: 'fresh', hash: 'h', seq: 1, loops } } : {}
}

describe('a qué nodo bucle corresponde cada serie', () => {
  it('por línea:columna dentro de su sentencia', () => {
    const program = parse('total = 0\nfor i in range(3):\n    total += i\n')
    const refs = loopRefs(program, topLevelOf(program), runsFor(program, { '1:0': view() }))
    const loop = program.nodes.find((n) => n.kind === 'control.loop')
    expect(refs.get(loop?.id ?? '')?.key).toBe('1:0')
  })

  it('un bucle de dentro de una función, por su posición dentro de la definición', () => {
    const program = parse(
      'def f(n):\n    s = 0\n    for k in range(n):\n        s += k\n    return s\n',
    )
    const top = topLevelOf(program)
    const def = program.nodes.find((n) => n.kind === 'abstraction.collapsed')
    const refs = loopRefs(program, top, {
      [def?.id ?? '']: { state: 'fresh', hash: 'h', loops: { '3:4': view() } },
    })
    const loop = program.nodes.find((n) => n.kind === 'control.loop')
    expect(refs.get(loop?.id ?? '')).toMatchObject({ key: '3:4', statement: def?.id })
  })

  it('sin serie, no hay referencia', () => {
    const program = parse('for i in range(3):\n    pass\n')
    expect(loopRefs(program, topLevelOf(program), runsFor(program, {})).size).toBe(0)
  })

  it('los bucles que envuelven a un nodo, del más interno al más externo', () => {
    const program = parse('for i in range(2):\n    for j in range(2):\n        x = i + j\n')
    const x = program.nodes.find((n) => n.provides === 'x')
    const [inner, outer] = enclosingLoops(program).get(x?.id ?? '') ?? []
    expect(program.nodes.find((n) => n.id === inner)?.line).toBe(2)
    expect(program.nodes.find((n) => n.id === outer)?.line).toBe(1)
  })
})

describe('la vuelta que se mira', () => {
  it('por defecto la última, y siempre dentro de lo que hay', () => {
    expect(positionOf(view(), undefined)).toBe(2)
    expect(positionOf(view(), 1)).toBe(1)
    expect(positionOf(view(), 99)).toBe(2)
    expect(positionOf(view(), -4)).toBe(0)
    expect(positionOf(view({ idx: [] }), undefined)).toBe(0)
  })

  it('un valor se enseña corto', () => {
    expect(formatValue(3)).toBe('3')
    expect(formatValue(0.123456)).toBe('0.1235')
    expect(formatValue(0.00001234)).toBe('1.23e-5')
    expect(formatValue(12345678.9)).toBe('1.23e+7')
    expect(formatValue('una descripción muy larga')).toBe('una descripci…')
    expect(formatValue(null)).toBe('—')
  })
})

describe('lo que vale cada nombre en la vuelta que se mira', () => {
  const source = 'total = 0\nfor i in range(3):\n    total = total + i\n    nombre = str(i)\n'

  it('un nodo de dentro del bucle toma su valor en esa vuelta', () => {
    const program = parse(source)
    const refs = loopRefs(program, topLevelOf(program), runsFor(program, { '1:0': view() }))
    const node = program.nodes.find((n) => n.provides === 'total' && n.line === 3)
    const last = observedInLoops(program, refs, {}).get(node?.id ?? '')
    expect(last?.['total']).toEqual({ short: '3', long: 'vuelta 3 de 3: 3' })
    const loop = program.nodes.find((n) => n.kind === 'control.loop')
    const first = observedInLoops(program, refs, { [loop?.id ?? '']: 0 }).get(node?.id ?? '')
    expect(first?.['total']).toEqual({ short: '0', long: 'vuelta 1 de 3: 0' })
  })

  it('un nodo de fuera del bucle no lo toma', () => {
    const program = parse(source)
    const refs = loopRefs(program, topLevelOf(program), runsFor(program, { '1:0': view() }))
    const before = program.nodes.find((n) => n.provides === 'total' && n.line === 1)
    expect(observedInLoops(program, refs, {}).has(before?.id ?? '')).toBe(false)
  })

  it('un nombre que el bucle no anota, tampoco', () => {
    const program = parse(source)
    const refs = loopRefs(
      program,
      topLevelOf(program),
      runsFor(program, { '1:0': view({ names: { i: [0, 1, 2] } }) }),
    )
    const node = program.nodes.find((n) => n.provides === 'total' && n.line === 3)
    expect(observedInLoops(program, refs, {}).has(node?.id ?? '')).toBe(false)
  })
})

describe('las curvas', () => {
  it('solo los nombres con al menos dos números', () => {
    expect(curvesOf(view())).toEqual(['total'])
    expect(curvesOf(view({ names: { a: [1, 'x', null] } }))).toEqual([])
  })

  it('los puntos son los números, cada uno con su vuelta', () => {
    const v = view({ idx: [0, 5, 9], names: { y: [1, 'x', 4] } })
    expect(curvePoints(v, 'y')).toEqual([
      { at: 0, value: 1 },
      { at: 9, value: 4 },
    ])
  })

  it('un visor de una curva: sus puntos, su última, su mínimo y su máximo', () => {
    const key: PinKey = { id: 's', hash: 'h', name: `${SERIES}1:0|total` }
    const content = contentOf(
      key,
      { state: 'fresh', hash: 'h', loops: { '1:0': view() } },
      undefined,
    )
    expect(content.title).toBe('total')
    expect(content.subtitle).toBe('curva · 3 vueltas')
    expect(content.series).toEqual({ at: [0, 1, 2], values: [0, 1, 3], n: 3 })
    expect(content.text).toEqual(['última: 3', 'mín 0 · máx 3'])
  })

  it('una curva que ya no existe lo dice', () => {
    const key: PinKey = { id: 's', hash: 'h', name: `${SERIES}9:9|total` }
    const content = contentOf(key, { state: 'fresh', hash: 'h' }, undefined)
    expect(content.text?.[0]).toMatch(/ya no deja/)
  })

  it('el visor de una curva mide lo que la curva pide', () => {
    const plain = { title: 'x', text: ['a'] }
    const curve = { title: 'x', text: ['a'], series: { at: [0, 1], values: [1, 2], n: 2 } }
    expect(viewerSize(curve).h).toBeGreaterThan(viewerSize(plain).h)
    expect(viewerSize(curve).w).toBe(320)
  })
})
