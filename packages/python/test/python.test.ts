import { createRequire } from 'node:module'
import path from 'node:path'
import { analyze, layout } from '@prysel/spatial'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, toSemanticGraph, type Program } from '../src/index.ts'

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))

let parse: (source: string) => Program

beforeAll(async () => {
  const parser = await createPythonParser({
    runtime: wasmDir,
    language: path.join(wasmDir, 'tree-sitter-python.wasm'),
  })
  parse = (source: string) => buildProgram(parser.parse(source))
}, 30_000)

const SCRIPT = `import pandas as pd

THRESHOLD = 1000
sales = pd.read_csv("data/sales.csv")
big = sales[sales.amount > THRESHOLD]
summary = big.groupby("region").amount.sum()
display(summary)
`

describe('de Python a nodos', () => {
  it('reconoce cada sentencia con el tipo que le toca', () => {
    const { nodes } = parse(SCRIPT)
    const kinds = nodes.map((n) => n.kind)
    expect(kinds).toEqual([
      'external.import',
      'value.number',
      'effect.io',
      'control.condition',
      'transform.call',
      'output.display',
    ])
  })

  it('cada nodo conserva su línea y su código', () => {
    const { nodes } = parse(SCRIPT)
    expect(nodes[1]).toMatchObject({ label: 'THRESHOLD', line: 3, code: 'THRESHOLD = 1000' })
  })

  it('distingue un efecto externo de una transformación', () => {
    const { nodes } = parse('a = pd.read_csv("x")\nb = a.sum()\n')
    expect(nodes.map((n) => n.kind)).toEqual(['effect.io', 'transform.call'])
  })

  it('lo que no entiende lo marca como opaco en vez de inventárselo', () => {
    const { nodes, unsupported } = parse('match x:\n    case 1:\n        pass\n')
    expect(nodes[0]?.kind).toBe('opaque.code')
    expect(unsupported[0]?.type).toBe('match_statement')
  })

  it('aguanta código a medio escribir: es lo que permite dibujar mientras se teclea', () => {
    const { nodes } = parse('sales = pd.read_csv(\nbig = sales[')
    expect(nodes.length).toBeGreaterThan(0)
  })
})

describe('de nombres a conexiones', () => {
  it('conecta cada uso con la asignación que lo define', () => {
    const { nodes, edges } = parse(SCRIPT)
    const id = (label: string) => nodes.find((n) => n.label === label)?.id
    const between = (from?: string, to?: string) =>
      edges.find((e) => e.from === from && e.to === to)

    expect(between(id('pd'), id('sales'))?.relation).toBe('transform')
    expect(between(id('sales'), id('big'))?.relation).toBe('transform')
    expect(between(id('THRESHOLD'), id('big'))?.relation).toBe('dependency')
    expect(between(id('big'), id('summary'))?.relation).toBe('transform')
  })

  it('manda cada entrada a su puerto: el dato a un lado y el umbral al otro', () => {
    const { nodes, edges } = parse(SCRIPT)
    const id = (label: string) => nodes.find((n) => n.label === label)?.id
    const toFilter = edges.filter((e) => e.to === id('big'))
    expect(toFilter.find((e) => e.from === id('sales'))?.toPort).toBe('field')
    expect(toFilter.find((e) => e.from === id('THRESHOLD'))?.toPort).toBe('value')
  })

  it('un bucle se cierra con una conexión de retorno', () => {
    const { nodes, edges } = parse('total = 0\nfor row in rows:\n    total = total + row\n')
    const loop = nodes.find((n) => n.kind === 'control.loop')
    expect(edges.some((e) => e.relation === 'feedback' && e.to === loop?.id)).toBe(true)
    expect(loop?.contains?.length).toBe(1)
  })

  it('un if reparte sus ramas con etiqueta', () => {
    const { edges } = parse('if x > 1:\n    a = 1\nelse:\n    a = 2\n')
    const branches = edges.filter((e) => e.relation === 'branch')
    expect(branches.map((e) => e.label)).toEqual(['verdadero', 'falso'])
  })

  it('una función se queda con su cuerpo dentro', () => {
    const { nodes } = parse('def load(path):\n    a = open(path)\n    return a\n')
    const fn = nodes.find((n) => n.kind === 'abstraction.collapsed')
    expect(fn?.label).toBe('load')
    expect(fn?.contains).toHaveLength(2)
  })

  it('un import se conecta por referencia, no transporta un dato', () => {
    const { nodes, edges } = parse('import os\np = os.getcwd()\n')
    const imported = nodes.find((n) => n.kind === 'external.import')
    expect(edges.some((e) => e.from === imported?.id)).toBe(true)
  })
})

describe('el grafo resultante se puede dibujar', () => {
  it('pasa la gramática espacial sin solapes ni retrocesos', () => {
    const program = parse(SCRIPT)
    const graph = toSemanticGraph(program)
    const result = analyze(graph, layout(graph))
    expect(result.overlaps).toBe(0)
    expect(result.backward).toBe(0)
    expect(result.nodes).toBe(program.nodes.length)
  })

  it('reanalizar un archivo es lo bastante rápido para hacerlo en cada tecla', () => {
    const big = Array.from({ length: 200 }, (_, i) => `v${i} = v${Math.max(0, i - 1)} + ${i}`).join('\n')
    const started = performance.now()
    const program = parse(big)
    const elapsed = performance.now() - started
    expect(program.nodes).toHaveLength(200)
    expect(elapsed).toBeLessThan(120)
  })
})
