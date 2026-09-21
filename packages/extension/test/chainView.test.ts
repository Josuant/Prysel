import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import type { Summary } from '../src/kernel.ts'
import { topLevelOf } from '../src/plan.ts'
import type { RunView } from '../src/runs.ts'
import { chainRefs, describeStep, viewableStep } from '../webview/src/chains.ts'
import { STEP, contentOf, type PinKey } from '../webview/src/pins.ts'

/**
 * Lo que se observó de cada paso de una cadena, sobre su nodo: qué cadena es de qué nodo, qué dice la
 * fila y la ayuda de cada paso, y qué enseña el visor de un paso.
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

const frame: Summary = {
  type: 'DataFrame',
  module: 'pandas',
  shape: [12, 2],
  table: {
    columns: [
      { name: 'mes', dtype: 'int64' },
      { name: 'monto', dtype: 'float64' },
    ],
    rows: [
      [1, 10.5],
      [2, null],
    ],
  },
}
const grouped: Summary = { type: 'DataFrameGroupBy', module: 'pandas' }

const runsOf = (program: Program, chains: Record<string, (Summary | null)[]>) => {
  const top = topLevelOf(program)
  const first = program.nodes.find((n) => top.get(n.id) === n.id)
  return first ? { [first.id]: { state: 'fresh', hash: 'h', seq: 1, chains } as RunView } : {}
}

describe('a qué nodo corresponde cada cadena', () => {
  it('por línea:columna dentro de su sentencia', () => {
    const program = parse('por_mes = df.groupby("mes").sum()\n')
    const refs = chainRefs(
      program,
      topLevelOf(program),
      runsOf(program, { '1:10': [frame, grouped, frame] }),
    )
    const node = program.nodes[0]
    expect(refs.get(node?.id ?? '')).toMatchObject({ key: '1:10', statement: node?.id })
    expect(refs.get(node?.id ?? '')?.previews).toHaveLength(3)
  })

  it('una cadena de dentro de una función, por su posición dentro de la definición', () => {
    const program = parse('def f(df):\n    r = df.groupby("a").sum()\n    return r\n')
    const def = program.nodes.find((n) => n.kind === 'abstraction.collapsed')
    const top = topLevelOf(program)
    const refs = chainRefs(program, top, {
      [def?.id ?? '']: { state: 'fresh', hash: 'h', chains: { '2:8': [frame, grouped, frame] } },
    })
    const chain = program.nodes.find((n) => n.control?.kind === 'chain')
    expect(refs.get(chain?.id ?? '')).toMatchObject({ key: '2:8', statement: def?.id })
  })

  it('sin lo que anotó el motor, no hay referencia', () => {
    const program = parse('r = df.a().b()\n')
    expect(chainRefs(program, topLevelOf(program), runsOf(program, {})).size).toBe(0)
  })

  it('una clave que no es de esta cadena, tampoco', () => {
    const program = parse('r = df.a().b()\n')
    expect(chainRefs(program, topLevelOf(program), runsOf(program, { '9:9': [frame] })).size).toBe(
      0,
    )
  })
})

describe('lo que dice cada paso', () => {
  it('la ayuda: tipo y forma, columnas y una muestra', () => {
    expect(describeStep(frame)).toBe('DataFrame 12×2\ncolumnas: mes, monto')
    expect(
      describeStep({
        type: 'ndarray',
        module: 'numpy',
        shape: [3],
        dtype: 'int64',
        sample: [1, 2, 3],
      }),
    ).toBe('ndarray (3) int64\n1, 2, 3')
    expect(describeStep(grouped)).toBe('DataFrameGroupBy')
  })

  it('muchas columnas se recortan', () => {
    const wide: Summary = {
      type: 'DataFrame',
      module: 'pandas',
      table: {
        columns: Array.from({ length: 20 }, (_, i) => ({ name: `c${i}`, dtype: 'int64' })),
        rows: [],
      },
    }
    expect(describeStep(wide)).toContain('c11, …')
    expect(describeStep(wide)).not.toContain('c12')
  })

  it('solo se puede ver lo que tiene algo que enseñar', () => {
    expect(viewableStep(frame)).toBe(true)
    expect(viewableStep({ type: 'int', module: 'builtins', repr: '3' })).toBe(true)
    expect(viewableStep(grouped)).toBe(false)
    expect(viewableStep(null)).toBe(false)
    expect(viewableStep(undefined)).toBe(false)
  })
})

describe('el visor de un paso', () => {
  const key = (name: string): PinKey => ({ id: 's', hash: 'h', name })
  const view = (over: Partial<RunView> = {}): RunView => ({
    state: 'fresh',
    hash: 'h',
    chains: { '1:10': [frame, grouped, frame] },
    ...over,
  })

  it('enseña la tabla que quedó tras ese paso', () => {
    const content = contentOf(key(`${STEP}1:10|2`), view(), undefined)
    expect(content.title).toBe('paso 2')
    expect(content.subtitle).toBe('DataFrame 12×2')
    expect(content.table?.rows).toEqual([
      [1, 10.5],
      [2, null],
    ])
  })

  it('una fila aplanada a texto por el camino no rompe el visor', () => {
    const flat: Summary = {
      type: 'Tabla',
      module: 'x',
      table: { columns: [{ name: 'a', dtype: 'int64' }], rows: ['[1, 2]' as unknown as unknown[]] },
    }
    const content = contentOf(
      key(`${STEP}1:10|1`),
      view({ chains: { '1:10': [frame, flat] } }),
      undefined,
    )
    expect(content.table?.rows).toEqual([['[1, 2]']])
  })

  it('el índice 0 es el receptor', () => {
    expect(contentOf(key(`${STEP}1:10|0`), view(), undefined).title).toBe('receptor')
  })

  it('un paso que ya no se evaluó lo dice; y uno desactualizado se marca', () => {
    expect(contentOf(key(`${STEP}1:10|9`), view(), undefined).text?.[0]).toMatch(/ya no se evaluó/)
    expect(contentOf(key(`${STEP}1:10|1`), view({ state: 'stale' }), undefined).stale).toBe(true)
  })

  it('sin ejecutar, el visor conserva su nombre', () => {
    expect(contentOf(key(`${STEP}1:10|2`), view({ state: 'never' }), undefined).title).toBe(
      'paso 2',
    )
    expect(contentOf(key(`${STEP}1:10|0`), view({ state: 'never' }), undefined).title).toBe(
      'receptor',
    )
  })

  it('sin ejecutar, lo dice', () => {
    expect(contentOf(key(`${STEP}1:10|1`), view({ state: 'never' }), undefined).subtitle).toBe(
      'sin ejecutar',
    )
  })
})
