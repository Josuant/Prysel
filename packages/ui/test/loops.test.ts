import { layout, type SemanticEdge, type SemanticNode } from '@prysel/spatial'
import { describe, expect, it } from 'vitest'
import type { CanvasNode } from '../src/Canvas.tsx'
import { isLoopTerritory, territoryHeadroom } from '../src/flow/frame.ts'
import { foldScopes, functionsOf, programView } from '../src/program.ts'

/** Un bucle con cuerpo es un territorio: envuelve lo que repite, se pliega y no es una «función». */

const node = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  kind: 'transform.operation',
  label: id,
  ...extra,
})

// def f(): for i in xs: a = 1; b = 2
const NODES = [
  node('f', { kind: 'abstraction.collapsed', contains: ['loop', 'a', 'b'] }),
  node('loop', {
    kind: 'control.loop',
    contains: ['a', 'b'],
    params: ['i'],
    control: { kind: 'loop', variable: 'i', iterable: 'xs' },
  }),
  node('a'),
  node('b'),
]
const EDGES: SemanticEdge[] = [
  { from: 'loop', to: 'a', relation: 'dependency', fromPort: 'param:i' },
]

describe('un bucle con cuerpo es un territorio', () => {
  it('lo es si tiene algo dentro; uno vacío es un nodo más', () => {
    expect(isLoopTerritory(node('l', { kind: 'control.loop', contains: ['x'] }))).toBe(true)
    expect(isLoopTerritory(node('l', { kind: 'control.loop', contains: [] }))).toBe(false)
    expect(isLoopTerritory(node('l', { kind: 'control.loop' }))).toBe(false)
    expect(isLoopTerritory(node('f', { kind: 'abstraction.collapsed', contains: ['x'] }))).toBe(
      false,
    )
  })

  it('su cabecera pide sitio para su editor, y más si además tiene documentación', () => {
    const loop = NODES[1] as CanvasNode
    const plain = territoryHeadroom(loop)
    expect(plain).toBeGreaterThan(0)
    expect(territoryHeadroom({ ...loop, note: 'Recorre la lista.' })).toBeGreaterThan(plain)
  })

  it('una función sin documentación no pide nada; sin cuerpo, tampoco', () => {
    expect(territoryHeadroom(NODES[0] as CanvasNode)).toBe(0)
    expect(territoryHeadroom(node('l', { kind: 'control.loop', control: NODES[1]?.control }))).toBe(
      0,
    )
  })

  it('no es una función: no aparece en el menú de funciones', () => {
    expect(functionsOf(NODES, EDGES).map((fn) => fn.id)).toEqual(['f'])
  })

  it('la vista de una función enseña sus bucles dentro', () => {
    const view = programView(NODES, EDGES, 'f')
    expect(view.nodes.map((n) => n.id)).toEqual(['f', 'loop', 'a', 'b'])
  })
})

describe('un bucle se pliega como una función', () => {
  it('plegado, es un solo nodo con su editor y con su chevron', () => {
    const view = foldScopes(NODES, EDGES, new Set(['loop']))
    expect(view.nodes.map((n) => n.id)).toEqual(['f', 'loop'])
    expect(view.nodes.find((n) => n.id === 'loop')?.openable).toBe(true)
  })

  it('las conexiones internas se van con él, sin puertos que ya no existen', () => {
    const view = foldScopes(NODES, EDGES, new Set(['loop']))
    expect(view.edges.every((e) => e.fromPort === undefined || e.from !== 'loop')).toBe(true)
    expect(view.edges.some((e) => e.to === 'a')).toBe(false)
  })

  it('una función plegada lleva a sus bucles consigo', () => {
    const view = foldScopes(NODES, EDGES, new Set(['f', 'loop']))
    expect(view.nodes.map((n) => n.id)).toEqual(['f'])
  })
})

describe('la gramática espacial coloca un bucle como territorio', () => {
  const SIZE = { w: 200, h: 60 }
  const graph = (territory: boolean): { nodes: SemanticNode[]; edges: SemanticEdge[] } => ({
    nodes: [
      {
        id: 'loop',
        role: 'control',
        size: SIZE,
        contains: ['a', 'b'],
        ...(territory ? { territory } : {}),
      },
      { id: 'a', role: 'transform', size: SIZE },
      { id: 'b', role: 'transform', size: SIZE },
    ],
    edges: [{ from: 'a', to: 'b', relation: 'transform' }],
  })

  it('con la marca, envuelve su cuerpo', () => {
    const result = layout(graph(true))
    expect(Object.keys(result.scopes)).toEqual(['loop'])
    const loop = result.placements.find((p) => p.id === 'loop')
    const inner = result.placements.find((p) => p.id === 'a')
    expect(loop && inner && inner.x >= loop.x && inner.y >= loop.y).toBe(true)
  })

  it('sin la marca, es un nodo más (los bucles de siempre no cambian)', () => {
    expect(layout(graph(false)).scopes).toEqual({})
  })
})
