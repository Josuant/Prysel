import { describe, expect, it } from 'vitest'
import type { SemanticEdge } from '@prysel/spatial'
import type { CanvasNode } from '../src/Canvas.tsx'
import { checkConnection } from '../src/connect.ts'
import { territoryAt } from '../src/drag.ts'
import { foldReturns } from '../src/program.ts'

const node = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  kind: 'transform.operation',
  label: id,
  ...extra,
})
const edge = (from: string, to: string, extra: Partial<SemanticEdge> = {}): SemanticEdge => ({
  from,
  to,
  relation: 'dependency',
  ...extra,
})
const ret = (id: string, value: string): CanvasNode =>
  node(id, {
    kind: 'control.return',
    label: 'devolver',
    control: { kind: 'args', target: '', args: [{ name: 'valor', value }] },
  })

// def sumar(a, b): suma = a + b; return suma
const NODES = [
  node('sumar', { kind: 'abstraction.collapsed', params: ['a', 'b'], contains: ['suma', 'ret'] }),
  node('suma', { provides: 'suma' }),
  ret('ret', 'suma'),
]
const EDGES = [
  edge('sumar', 'suma', { fromPort: 'param:a', toPort: 'left' }),
  edge('suma', 'ret', { toPort: 'arg:valor' }),
]

describe('el retorno de una función es su salida, no un nodo más', () => {
  const folded = foldReturns(NODES, EDGES)

  it('un return que solo devuelve una variable no se dibuja', () => {
    expect(folded.nodes.map((n) => n.id)).toEqual(['sumar', 'suma'])
  })

  it('el cable va de donde se calcula al puerto de retorno de la función', () => {
    const cable = folded.edges.find((e) => e.to === 'sumar')
    expect(cable).toMatchObject({ from: 'suma', toPort: 'return', via: 'ret' })
  })

  it('la función recibe un puerto de retorno y ya no cuenta el return entre lo suyo', () => {
    const def = folded.nodes.find((n) => n.id === 'sumar')
    expect(def?.inputs).toContain('return')
    expect(def?.contains).toEqual(['suma'])
  })

  it('el resto de conexiones se conserva', () => {
    expect(folded.edges.some((e) => e.fromPort === 'param:a' && e.toPort === 'left')).toBe(true)
  })

  it('un return de una operación se dibuja como operación, con su salida a la función', () => {
    const op = node('ret', {
      kind: 'control.return',
      label: 'devolver',
      control: { kind: 'expression', left: 'a', operator: '+', right: 'b', operators: ['+'] },
    })
    const view = foldReturns(
      [node('f', { kind: 'abstraction.collapsed', contains: ['x', 'ret'] }), node('x'), op],
      [],
    )
    const shown = view.nodes.find((n) => n.id === 'ret')
    expect(shown).toMatchObject({ kind: 'transform.operation', label: 'devuelve', returns: 'f' })
    expect(view.edges).toContainEqual(
      expect.objectContaining({ from: 'ret', to: 'f', toPort: 'return' }),
    )
  })

  it('un return al que llega un cable de control (una decisión) se queda', () => {
    const view = foldReturns(
      [
        node('f', { kind: 'abstraction.collapsed', contains: ['x', 'ret'] }),
        node('x', { provides: 'x' }),
        ret('ret', 'x'),
      ],
      [edge('x', 'ret', { relation: 'branch', toPort: 'arg:valor' })],
    )
    expect(view.nodes.map((n) => n.id)).toContain('ret')
  })

  it('una función cuyo cuerpo sería solo su return lo conserva: sin nada dentro no hay territorio', () => {
    const view = foldReturns(
      [node('f', { kind: 'abstraction.collapsed', contains: ['ret'] }), ret('ret', 'a')],
      [edge('f', 'ret', { fromPort: 'param:a', toPort: 'arg:valor' })],
    )
    expect(view.nodes.map((n) => n.id)).toContain('ret')
  })

  it('una función plegada (sin su cuerpo a la vista) no se toca', () => {
    const view = foldReturns([node('f', { kind: 'abstraction.collapsed', contains: ['ret'] })], [])
    expect(view.nodes[0]?.inputs).toBeUndefined()
  })
})

describe('conectar al retorno de una función', () => {
  const view = foldReturns(NODES, EDGES)
  const byId = new Map(view.nodes.map((n) => [n.id, n]))

  it('vale lo que se calcula dentro de ella', () => {
    expect(checkConnection(byId, { from: 'suma', to: 'sumar', slot: 'return' }).ok).toBe(true)
  })

  it('vale uno de sus parámetros', () => {
    expect(
      checkConnection(byId, { from: 'sumar', port: 'param:a', to: 'sumar', slot: 'return' }).ok,
    ).toBe(true)
  })

  it('no vale lo de fuera', () => {
    const outside = new Map(byId).set('otro', node('otro', { provides: 'otro' }))
    expect(checkConnection(outside, { from: 'otro', to: 'sumar', slot: 'return' }).ok).toBe(false)
  })

  it('no vale un nodo que no define nada', () => {
    const def = byId.get('sumar')
    if (!def) throw new Error('sin función')
    const withMute = new Map(byId)
      .set('sumar', { ...def, contains: ['suma', 'mudo'] })
      .set('mudo', node('mudo'))
    expect(checkConnection(withMute, { from: 'mudo', to: 'sumar', slot: 'return' }).ok).toBe(false)
  })
})

describe('a qué función pertenece un punto', () => {
  const territories = [
    { id: 'fuera', x: 0, y: 0, w: 500, h: 400 },
    { id: 'dentro', x: 100, y: 100, w: 200, h: 200 },
  ]

  it('la más interna, si están anidadas', () => {
    expect(territoryAt({ x: 150, y: 150 }, territories)).toBe('dentro')
    expect(territoryAt({ x: 400, y: 350 }, territories)).toBe('fuera')
  })

  it('ninguna, si cae fuera de todas', () => {
    expect(territoryAt({ x: 900, y: 900 }, territories)).toBeNull()
  })

  it('no cuenta las excluidas: ni la propia función que se arrastra ni lo que lleva dentro', () => {
    expect(territoryAt({ x: 150, y: 150 }, territories, new Set(['dentro']))).toBe('fuera')
    expect(territoryAt({ x: 150, y: 150 }, territories, new Set(['dentro', 'fuera']))).toBeNull()
  })
})
