import { describe, expect, it } from 'vitest'
import {
  CHANNEL_OF,
  SCOPE_FRAME,
  channelOf,
  layout,
  type Placement,
  type SemanticEdge,
  type SemanticGraph,
  type SemanticNode,
} from '../src/index.ts'

const SIZE = { w: 200, h: 44 }
const node = (id: string, extra: Partial<SemanticNode> = {}): SemanticNode => ({
  id,
  role: 'transform',
  size: SIZE,
  ...extra,
})
const scope = (id: string, contains: string[]): SemanticNode =>
  node(id, { role: 'abstraction', contains, size: { w: 210, h: 48 } })
const edge = (from: string, to: string, extra: Partial<SemanticEdge> = {}): SemanticEdge => ({
  from,
  to,
  relation: 'transform',
  ...extra,
})

const at = (result: ReturnType<typeof layout>, id: string): Placement => {
  const placement = result.placements.find((p) => p.id === id)
  if (!placement) throw new Error(`sin posición para ${id}`)
  return placement
}
const inside = (inner: Placement, outer: Placement) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.size.w <= outer.x + outer.size.w &&
  inner.y + inner.size.h <= outer.y + outer.size.h
const overlap = (a: Placement, b: Placement) =>
  a.x < b.x + b.size.w && b.x < a.x + a.size.w && a.y < b.y + b.size.h && b.y < a.y + a.size.h

describe('un ámbito envuelve físicamente su cuerpo', () => {
  // def suma(a, b): total = a + b; return total     — y, fuera, un programa que la usa
  const program: SemanticGraph = {
    nodes: [
      node('a'),
      node('b'),
      scope('suma', ['total', 'ret']),
      node('total'),
      node('ret', { role: 'control' }),
      node('call'),
      node('show', { role: 'output' }),
    ],
    edges: [
      edge('suma', 'total'), // un parámetro alimenta el cuerpo: pasa dentro del ámbito
      edge('total', 'ret'),
      edge('a', 'call'),
      edge('b', 'call'),
      edge('suma', 'call'),
      edge('call', 'show'),
    ],
  }
  const result = layout(program)

  it('el contenedor abarca a todo lo que contiene', () => {
    const frame = at(result, 'suma')
    expect(inside(at(result, 'total'), frame)).toBe(true)
    expect(inside(at(result, 'ret'), frame)).toBe(true)
  })

  it('deja el margen del marco: cabecera arriba, aire a los lados', () => {
    const frame = at(result, 'suma')
    const body = ['total', 'ret'].map((id) => at(result, id))
    expect(Math.min(...body.map((p) => p.y)) - frame.y).toBeGreaterThanOrEqual(SCOPE_FRAME.top)
    expect(Math.min(...body.map((p) => p.x)) - frame.x).toBeGreaterThanOrEqual(SCOPE_FRAME.side)
    const right = Math.max(...body.map((p) => p.x + p.size.w))
    expect(frame.x + frame.size.w - right).toBeGreaterThanOrEqual(SCOPE_FRAME.side)
  })

  it('lo de fuera no se cuela dentro', () => {
    const frame = at(result, 'suma')
    for (const id of ['a', 'b', 'call', 'show']) {
      expect(overlap(at(result, id), frame), `${id} pisa el ámbito`).toBe(false)
    }
  })

  it('dentro tampoco se pisan entre sí', () => {
    expect(overlap(at(result, 'total'), at(result, 'ret'))).toBe(false)
  })

  it('el ámbito crece con lo que contiene', () => {
    const small = layout({ nodes: [scope('f', ['x']), node('x')], edges: [] })
    const big = layout({
      nodes: [scope('f', ['x', 'y', 'z']), node('x'), node('y'), node('z')],
      edges: [edge('x', 'y'), edge('y', 'z')],
    })
    expect(at(big, 'f').size.w).toBeGreaterThan(at(small, 'f').size.w)
  })

  it('dice qué ámbitos hay y qué encierran', () => {
    expect(result.scopes).toEqual({ suma: ['total', 'ret'] })
  })

  it('un programa sin ámbitos no tiene territorios', () => {
    const flat: SemanticGraph = {
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('a', 'b'), edge('b', 'c')],
    }
    expect(layout(flat).scopes).toEqual({})
    expect(layout(flat).placements).toHaveLength(3)
  })
})

describe('los ámbitos se anidan', () => {
  // def externa(): def interna(): x = 1;  y = 2
  const nested: SemanticGraph = {
    nodes: [
      scope('externa', ['interna', 'y']),
      scope('interna', ['x']),
      node('x'),
      node('y'),
      node('fuera'),
    ],
    edges: [edge('x', 'y'), edge('fuera', 'externa')],
  }
  const result = layout(nested)

  it('cada nivel envuelve al siguiente', () => {
    expect(inside(at(result, 'x'), at(result, 'interna'))).toBe(true)
    expect(inside(at(result, 'interna'), at(result, 'externa'))).toBe(true)
    expect(inside(at(result, 'y'), at(result, 'externa'))).toBe(true)
  })

  it('el contenido de un ámbito anidado pertenece a él y no al de fuera', () => {
    expect(result.scopes['interna']).toEqual(['x'])
    expect(result.scopes['externa']).not.toContain('x')
  })

  it('no pierde ni duplica ningún nodo', () => {
    expect(result.placements.map((p) => p.id).sort()).toEqual(
      ['externa', 'fuera', 'interna', 'x', 'y'].sort(),
    )
  })
})

describe('el cuerpo de un bucle dentro de una función sigue dentro de la función', () => {
  const graph: SemanticGraph = {
    nodes: [
      scope('fn', ['for']),
      node('for', { role: 'control', contains: ['paso'] }),
      node('paso'),
    ],
    edges: [edge('for', 'paso')],
  }
  const result = layout(graph)

  it('lo transitivo se contiene', () => {
    expect(result.scopes['fn']).toEqual(['for', 'paso'])
    expect(inside(at(result, 'paso'), at(result, 'fn'))).toBe(true)
  })
})

describe('una función colapsada es un nodo más', () => {
  it('sin su cuerpo en el plano, no hay territorio', () => {
    // El grupo colapsado conserva `contains`, pero sus miembros ya no están en el grafo.
    const result = layout({
      nodes: [node('a'), scope('fn', ['ya-no-existe']), node('b')],
      edges: [edge('a', 'fn'), edge('fn', 'b')],
    })
    expect(result.scopes).toEqual({})
    expect(at(result, 'fn').size).toEqual({ w: 210, h: 48 })
  })
})

describe('canales de conexión', () => {
  it('el orden de ejecución es control; el paso de valores, datos', () => {
    expect(CHANNEL_OF.branch).toBe('control')
    expect(CHANNEL_OF.feedback).toBe('control')
    expect(CHANNEL_OF.dependency).toBe('data')
    expect(CHANNEL_OF.transform).toBe('data')
  })

  it('un canal explícito manda sobre el de la relación', () => {
    expect(channelOf({ relation: 'transform' })).toBe('data')
    expect(channelOf({ relation: 'transform', channel: 'control' })).toBe('control')
  })
})

describe('la cabecera de un ámbito puede pedir más sitio (su documentación)', () => {
  const plain = layout({ nodes: [scope('f', ['x']), node('x')], edges: [] })
  const documented = layout({
    nodes: [{ ...scope('f', ['x']), headroom: 40 }, node('x')],
    edges: [],
  })

  it('el ámbito crece lo que pide, y no más', () => {
    expect(at(documented, 'f').size.h - at(plain, 'f').size.h).toBe(40)
  })

  it('el contenido empieza justo debajo de la cabecera ampliada', () => {
    const offset = (result: ReturnType<typeof layout>) => at(result, 'x').y - at(result, 'f').y
    expect(offset(documented) - offset(plain)).toBe(40)
  })

  it('lo de dentro sigue dentro', () => {
    expect(inside(at(documented, 'x'), at(documented, 'f'))).toBe(true)
  })
})
