import { describe, expect, it } from 'vitest'
import {
  STRATEGY_FOR,
  TOPOLOGY_RULES,
  classify,
  layerize,
  layout,
  routeEdge,
  type SemanticEdge,
  type SemanticGraph,
  type SemanticNode,
  type Topology,
} from '../src/index.ts'

const SIZE = { w: 240, h: 120 }
const node = (id: string, extra: Partial<SemanticNode> = {}): SemanticNode => ({
  id,
  role: 'transform',
  size: SIZE,
  ...extra,
})
const edge = (from: string, to: string, extra: Partial<SemanticEdge> = {}): SemanticEdge => ({
  from,
  to,
  relation: 'transform',
  ...extra,
})

const graph = (nodes: SemanticNode[], edges: SemanticEdge[]): SemanticGraph => ({ nodes, edges })

const chain = (n: number) =>
  graph(
    Array.from({ length: n }, (_, i) => node(`n${i}`)),
    Array.from({ length: n - 1 }, (_, i) => edge(`n${i}`, `n${i + 1}`)),
  )

const at = (result: ReturnType<typeof layout>, id: string) => {
  const p = result.placements.find((q) => q.id === id)
  if (!p) throw new Error(`sin posición: ${id}`)
  return p
}

describe('la tabla que traduce lógica en forma', () => {
  const topologies = Object.keys(STRATEGY_FOR) as Topology[]

  it('cada topología tiene estrategia y una razón escrita', () => {
    for (const topology of topologies) {
      expect(STRATEGY_FOR[topology], topology).toBeTruthy()
      expect(TOPOLOGY_RULES[topology].why.length, topology).toBeGreaterThan(40)
    }
  })

  it('las parejas del documento de diseño se respetan', () => {
    expect(STRATEGY_FOR.pipeline).toBe('linear')
    expect(STRATEGY_FOR.branch).toBe('tree')
    expect(STRATEGY_FOR.loop).toBe('orbital')
    expect(STRATEGY_FOR.aggregation).toBe('convergent')
    expect(STRATEGY_FOR['fan-out']).toBe('radial')
    expect(STRATEGY_FOR.comparison).toBe('parallel')
    expect(STRATEGY_FOR.nesting).toBe('nested')
  })
})

describe('clasificación espacial', () => {
  it('una cadena es un pipeline', () => {
    const regions = classify(chain(4))
    expect(regions).toHaveLength(1)
    expect(regions[0]?.topology).toBe('pipeline')
  })

  it('dos salidas etiquetadas son una decisión', () => {
    const g = graph(
      [node('if', { role: 'control' }), node('a'), node('b')],
      [
        edge('if', 'a', { relation: 'branch', label: 'verdadero' }),
        edge('if', 'b', { relation: 'branch', label: 'falso' }),
      ],
    )
    const region = classify(g).find((r) => r.topology === 'branch')
    expect(region?.anchor).toBe('if')
    expect(region?.nodes).toEqual(['if', 'a', 'b'])
  })

  it('una conexión de retorno es un bucle, y su cuerpo es la región', () => {
    const g = graph(
      [node('head', { role: 'control' }), node('body'), node('tail')],
      [edge('head', 'body'), edge('body', 'tail'), edge('tail', 'head', { relation: 'feedback' })],
    )
    const region = classify(g).find((r) => r.topology === 'loop')
    expect(region?.anchor).toBe('head')
    expect(region?.nodes).toContain('body')
  })

  it('un valor que alimenta a muchos es un abanico', () => {
    const g = graph(
      [node('src', { role: 'value' }), node('a'), node('b'), node('c')],
      [edge('src', 'a'), edge('src', 'b'), edge('src', 'c')],
    )
    expect(classify(g).find((r) => r.topology === 'fan-out')?.anchor).toBe('src')
  })

  it('muchas fuentes en un destino son una agregación', () => {
    const g = graph(
      [node('a'), node('b'), node('c'), node('sum')],
      [edge('a', 'sum'), edge('b', 'sum'), edge('c', 'sum')],
    )
    expect(classify(g).find((r) => r.topology === 'aggregation')?.anchor).toBe('sum')
  })

  it('dos caminos del mismo rol entre dos puntos son una comparación', () => {
    const g = graph(
      [node('src', { role: 'data' }), node('x'), node('y'), node('dst', { role: 'output' })],
      [edge('src', 'x'), edge('src', 'y'), edge('x', 'dst'), edge('y', 'dst')],
    )
    expect(classify(g).some((r) => r.topology === 'comparison')).toBe(true)
  })

  it('lo contenido pertenece a la región de su contenedor', () => {
    const g = graph(
      [node('fn', { role: 'abstraction', contains: ['i1', 'i2'] }), node('i1'), node('i2')],
      [edge('i1', 'i2')],
    )
    const region = classify(g).find((r) => r.topology === 'nesting')
    expect(region?.anchor).toBe('fn')
    expect(region?.nodes).toEqual(['fn', 'i1', 'i2'])
  })

  it('cada región explica qué vio en el grafo, y ningún nodo queda en dos', () => {
    const g = graph(
      [node('if', { role: 'control' }), node('a'), node('b'), node('end')],
      [
        edge('if', 'a', { relation: 'branch' }),
        edge('if', 'b', { relation: 'branch' }),
        edge('a', 'end'),
        edge('b', 'end'),
      ],
    )
    const regions = classify(g)
    const all = regions.flatMap((r) => r.nodes)
    expect(new Set(all).size).toBe(all.length)
    expect(new Set(all)).toEqual(new Set(g.nodes.map((n) => n.id)))
    for (const r of regions) expect(r.evidence.length, r.id).toBeGreaterThan(10)
  })
})

describe('capas: la x es el orden de ejecución', () => {
  it('una cadena avanza una capa por paso', () => {
    expect(layerize(chain(3))).toEqual({ n0: 0, n1: 1, n2: 2 })
  })

  it('las conexiones de retorno no cuentan: si no, el bucle no tendría capas', () => {
    const g = graph(
      [node('a'), node('b')],
      [edge('a', 'b'), edge('b', 'a', { relation: 'feedback' })],
    )
    expect(layerize(g)).toEqual({ a: 0, b: 1 })
  })
})

describe('layout', () => {
  it('coloca todos los nodos, una sola vez y de forma determinista', () => {
    const g = chain(5)
    const first = layout(g)
    const second = layout(g)
    expect(first.placements).toHaveLength(g.nodes.length)
    expect(first.placements).toEqual(second.placements)
  })

  it('ningún par de nodos se solapa', () => {
    const g = graph(
      [
        node('src', { role: 'value' }),
        node('a'),
        node('b'),
        node('c'),
        node('d'),
        node('sum', { role: 'output' }),
      ],
      [
        edge('src', 'a'),
        edge('src', 'b'),
        edge('src', 'c'),
        edge('src', 'd'),
        edge('a', 'sum'),
        edge('b', 'sum'),
        edge('c', 'sum'),
        edge('d', 'sum'),
      ],
    )
    const { placements } = layout(g)
    for (const p of placements) {
      for (const q of placements) {
        if (p.id >= q.id) continue
        const overlapX = p.x < q.x + q.size.w && q.x < p.x + p.size.w
        const overlapY = p.y < q.y + q.size.h && q.y < p.y + p.size.h
        expect(overlapX && overlapY, `${p.id} y ${q.id} se solapan`).toBe(false)
      }
    }
  })

  it('el flujo avanza hacia la derecha; solo el retorno va contra el tiempo', () => {
    const g = graph(
      [node('head', { role: 'control' }), node('body'), node('tail')],
      [edge('head', 'body'), edge('body', 'tail'), edge('tail', 'head', { relation: 'feedback' })],
    )
    const result = layout(g)
    expect(at(result, 'head').x).toBeLessThan(at(result, 'body').x)
    expect(at(result, 'body').x).toBeLessThan(at(result, 'tail').x)
  })

  it('una decisión separa sus ramas de verdad: la primera arriba, la segunda abajo', () => {
    const g = graph(
      [node('if', { role: 'control' }), node('si'), node('no')],
      [
        edge('if', 'si', { relation: 'branch', label: 'verdadero' }),
        edge('if', 'no', { relation: 'branch', label: 'falso' }),
      ],
    )
    const result = layout(g)
    expect(at(result, 'si').y).toBeLessThan(at(result, 'no').y)
    expect(Math.abs(at(result, 'si').y - at(result, 'no').y)).toBeGreaterThan(SIZE.h)
  })

  it('una rama arrastra a su descendencia: los caminos no se cruzan', () => {
    const g = graph(
      [node('if', { role: 'control' }), node('si'), node('no'), node('si2'), node('no2')],
      [
        edge('if', 'si', { relation: 'branch' }),
        edge('if', 'no', { relation: 'branch' }),
        edge('si', 'si2'),
        edge('no', 'no2'),
      ],
    )
    const result = layout(g)
    expect(at(result, 'si2').y).toBeLessThan(at(result, 'no2').y)
  })

  it('un abanico deja a sus consumidores sobre un arco, no en una columna recta', () => {
    const g = graph(
      [node('src', { role: 'value' }), node('a'), node('b'), node('c')],
      [edge('src', 'a'), edge('src', 'b'), edge('src', 'c')],
    )
    const result = layout(g)
    const xs = ['a', 'b', 'c'].map((id) => at(result, id).x)
    expect(new Set(xs).size).toBeGreaterThan(1)
    // El del medio es el que más se adelanta: el arco abre hacia fuera.
    expect(Math.max(...xs)).toBe(at(result, 'b').x)
  })

  it('el cuerpo de un bucle describe un arco sobre su cabecera', () => {
    const g = graph(
      [node('head', { role: 'control' }), node('b1'), node('b2'), node('b3')],
      [
        edge('head', 'b1'),
        edge('b1', 'b2'),
        edge('b2', 'b3'),
        edge('b3', 'head', { relation: 'feedback' }),
      ],
    )
    const result = layout(g)
    expect(at(result, 'b2').y).toBeLessThan(at(result, 'b1').y)
  })

  it('alinea por el centro: dos nodos de alturas distintas quedan a la misma altura visual', () => {
    const g = graph(
      [node('a', { size: { w: 200, h: 60 } }), node('b', { size: { w: 200, h: 300 } })],
      [edge('a', 'b')],
    )
    const result = layout(g)
    const centre = (id: string) => at(result, id).y + at(result, id).size.h / 2
    expect(Math.abs(centre('a') - centre('b'))).toBeLessThan(2)
  })

  it('reserva sitio bajo el programa para el arco de un retorno', () => {
    const loop = graph(
      [node('a'), node('b')],
      [edge('a', 'b'), edge('b', 'a', { relation: 'feedback' })],
    )
    const plain = graph([node('a'), node('b')], [edge('a', 'b')])
    expect(layout(loop).bounds.h).toBeGreaterThan(layout(plain).bounds.h + 40)
  })

  it('las medidas del lienzo envuelven a todos los nodos', () => {
    const { placements, bounds } = layout(chain(4))
    for (const p of placements) {
      expect(p.x + p.size.w).toBeLessThanOrEqual(bounds.w)
      expect(p.y + p.size.h).toBeLessThanOrEqual(bounds.h)
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeGreaterThanOrEqual(0)
    }
  })

  it('respeta los tamaños reales de cada nodo', () => {
    const g = graph(
      [node('small', { size: { w: 120, h: 40 } }), node('big', { size: { w: 400, h: 300 } })],
      [edge('small', 'big')],
    )
    const result = layout(g)
    expect(at(result, 'big').x).toBeGreaterThanOrEqual(at(result, 'small').x + 120)
  })
})

describe('trazado de conexiones', () => {
  const a = { x: 0, y: 0 }
  const b = { x: 300, y: 60 }

  it('una conexión hacia delante es una curva suave', () => {
    expect(routeEdge(a, b, 'transform')).toMatch(/^M0 0C\d/)
  })

  it('un retorno se va por debajo: va contra el tiempo y tiene que verse', () => {
    const path = routeEdge({ x: 300, y: 0 }, { x: 0, y: 0 }, 'feedback', { detour: 120 })
    const ys = [...path.matchAll(/-?\d+(?:\.\d+)?/g)].map(Number).filter((_, i) => i % 2 === 1)
    expect(Math.max(...ys)).toBeGreaterThan(100)
  })

  it('una referencia apenas se curva: no transporta un dato', () => {
    const weak = routeEdge(a, b, 'reference')
    const strong = routeEdge(a, b, 'transform')
    expect(weak).not.toBe(strong)
  })

  it('un salto de fila baja y vuelve a entrar por el principio: no cruza en diagonal', () => {
    const path = routeEdge({ x: 900, y: 100 }, { x: 40, y: 400 }, 'transform', { wrap: true })
    // Un retorno de carro se dibuja con tramos rectos y esquinas redondeadas, no con una curva.
    expect(path).toContain('A')
    expect(path).not.toContain('C')
  })

  it('no produce coordenadas inválidas', () => {
    for (const relation of [
      'dependency',
      'transform',
      'branch',
      'merge',
      'reference',
      'feedback',
    ] as const) {
      expect(routeEdge(a, b, relation)).not.toMatch(/NaN|Infinity/)
    }
  })
})
