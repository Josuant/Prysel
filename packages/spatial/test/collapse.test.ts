import { describe, expect, it } from 'vitest'
import {
  analyze,
  collapse,
  generateProgram,
  groupsByRun,
  groupsFromContainers,
  layout,
  type GroupSuggestion,
  type SemanticGraph,
} from '../src/index.ts'

const SIZE = { w: 258, h: 156 }
const graph = (ids: string[], edges: [string, string][]): SemanticGraph => ({
  nodes: ids.map((id) => ({ id, role: 'transform' as const, size: SIZE })),
  edges: edges.map(([from, to]) => ({ from, to, relation: 'transform' as const })),
})

const group = (extra: Partial<GroupSuggestion> = {}): GroupSuggestion => ({
  id: 'g',
  label: 'grupo',
  nodes: ['b', 'c'],
  source: 'ai',
  reason: 'tres pasos que solo se usan entre sí',
  ...extra,
})

describe('colapso por abstracción', () => {
  const base = graph(
    ['a', 'b', 'c', 'd'],
    [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
    ],
  )

  it('sustituye el grupo por un nodo y recablea lo que cruzaba su borde', () => {
    const { graph: result } = collapse(base, [group()])
    expect(result.nodes.map((n) => n.id).sort()).toEqual(['a', 'd', 'g'])
    expect(result.edges).toEqual([
      { from: 'a', to: 'g', relation: 'transform' },
      { from: 'g', to: 'd', relation: 'transform' },
    ])
  })

  it('el nodo colapsado recuerda lo que esconde', () => {
    const node = collapse(base, [group()]).graph.nodes.find((n) => n.id === 'g')
    expect(node?.contains).toEqual(['b', 'c'])
    expect(node?.ops).toBe(2)
    expect(node?.role).toBe('abstraction')
  })

  it('una agrupación sin razón se rechaza: la IA no puede agrupar a ciegas', () => {
    const { applied, rejected } = collapse(base, [group({ reason: '  ' })])
    expect(applied).toHaveLength(0)
    expect(rejected[0]?.why).toMatch(/por qué/)
  })

  it('dos grupos que se pisan: se aplica el primero y se dice por qué el otro no', () => {
    const { applied, rejected } = collapse(base, [group(), group({ id: 'h', nodes: ['c', 'd'] })])
    expect(applied.map((g) => g.id)).toEqual(['g'])
    expect(rejected[0]?.why).toMatch(/solapa/)
  })

  it('no colapsa lo que no merece la pena', () => {
    const { applied } = collapse(base, [group({ nodes: ['b'] })])
    expect(applied).toHaveLength(0)
  })

  it('el AST propone un grupo por cada contenedor', () => {
    const withContainer: SemanticGraph = {
      nodes: [
        { id: 'fn', role: 'abstraction', size: SIZE, contains: ['x', 'y'] },
        { id: 'x', role: 'transform', size: SIZE },
        { id: 'y', role: 'transform', size: SIZE },
      ],
      edges: [{ from: 'x', to: 'y', relation: 'transform' }],
    }
    const groups = groupsFromContainers(withContainer)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.source).toBe('ast')
    // El contenedor entra en su propio grupo: se queda con su identidad y absorbe el cuerpo.
    expect(groups[0]?.nodes).toEqual(['fn', 'x', 'y'])
    expect(groups[0]?.id).toBe('fn')

    const { graph: folded } = collapse(withContainer, groups)
    expect(folded.nodes.map((n) => n.id)).toEqual(['fn'])
  })
})

describe('el colapso es lo que hace legible un programa grande', () => {
  it('reduce drásticamente lo que hay que recorrer', () => {
    const flat = generateProgram({ steps: 60 })
    const before = analyze(flat, layout(flat))
    const { graph: folded, applied } = collapse(flat, groupsByRun(flat, 6))
    const after = analyze(folded, layout(folded))

    expect(applied.length).toBeGreaterThan(0)
    expect(after.nodes).toBeLessThan(before.nodes)
    expect(after.bounds.h).toBeLessThan(before.bounds.h)
    // Lo importante: el programa entero vuelve a caber de un vistazo.
    expect(after.nodeWidthAtFit).toBeGreaterThan(before.nodeWidthAtFit)
  })

  it('deja el grafo en un estado válido para volver a colocarlo', () => {
    const flat = generateProgram({ steps: 40 })
    const { graph: collapsed } = collapse(flat, groupsByRun(flat, 5))
    const result = analyze(collapsed, layout(collapsed))
    expect(result.overlaps).toBe(0)
    expect(result.backward).toBe(0)
  })
})
