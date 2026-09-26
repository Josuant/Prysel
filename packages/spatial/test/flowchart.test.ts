import { describe, expect, it } from 'vitest'
import {
  analyze,
  FLOW_JOIN,
  generateProgram,
  layout,
  layoutFlowchart,
  routeFlow,
  type SemanticEdge,
  type SemanticGraph,
  type SemanticNode,
} from '../src/index.ts'

const node = (id: string, w = 200, h = 50, owner?: string): SemanticNode => ({
  id,
  role: 'transform',
  size: { w, h },
  ...(owner === undefined ? {} : { owner }),
})
const seq = (from: string, to: string): SemanticEdge => ({ from, to, relation: 'sequence' })
const yes = (from: string, to: string): SemanticEdge => ({
  from,
  to,
  relation: 'branch',
  label: 'verdadero',
})
const no = (from: string, to: string): SemanticEdge => ({
  from,
  to,
  relation: 'branch',
  label: 'falso',
})

const boxes = (graph: SemanticGraph) => {
  const result = layoutFlowchart(graph)
  const at = (id: string) => {
    const p = result.placements.find((placement) => placement.id === id)
    if (!p) throw new Error(id)
    return { ...p, cx: p.x + p.size.w / 2, bottom: p.y + p.size.h, right: p.x + p.size.w }
  }
  return { result, at }
}

describe('el diagrama de flujo', () => {
  it('una secuencia baja por una sola espina, en el orden del programa', () => {
    const graph = {
      nodes: [node('a', 120), node('b', 300), node('c', 80)],
      edges: [seq('a', 'b'), seq('b', 'c')],
    }
    const { at } = boxes(graph)
    expect(at('a').cx).toBe(at('b').cx)
    expect(at('b').cx).toBe(at('c').cx)
    expect(at('a').bottom).toBeLessThan(at('b').y)
    expect(at('b').bottom).toBeLessThan(at('c').y)
  })

  it('if/else: el «sí» sigue la espina, el «no» baja a la derecha y los dos se juntan debajo', () => {
    // x = 1; if c: y ; else: z ; w
    const graph = {
      nodes: [
        node('x'),
        node('if', 260, 80),
        node('y', 200, 50, 'if'),
        node('z', 200, 50, 'if'),
        node('w'),
      ],
      edges: [seq('x', 'if'), yes('if', 'y'), no('if', 'z'), seq('y', 'w'), seq('z', 'w')],
    }
    const { at } = boxes(graph)
    const spine = at('x').cx
    expect(at('if').cx).toBe(spine)
    expect(at('y').cx).toBe(spine)
    expect(at('w').cx).toBe(spine)
    // El «no» empieza pasado el vértice derecho del rombo y sin tocar el camino «sí».
    expect(at('z').cx).toBeGreaterThan(at('if').right)
    expect(at('z').x).toBeGreaterThan(at('y').right)
    // Los dos caminos empiezan a la misma altura, bajo la decisión, y se juntan debajo de ambos.
    expect(at('y').y).toBe(at('z').y)
    expect(at('y').y).toBeGreaterThan(at('if').bottom)
    expect(at('w').y).toBeGreaterThan(Math.max(at('y').bottom, at('z').bottom) + FLOW_JOIN)
  })

  it('un if sin else deja sitio a la derecha para el carril del «no»', () => {
    const graph = {
      nodes: [node('if', 220, 80), node('y', 400, 50, 'if'), node('w')],
      edges: [yes('if', 'y'), seq('if', 'w'), seq('y', 'w')],
    }
    const { at, result } = boxes(graph)
    expect(at('y').cx).toBe(at('if').cx)
    expect(at('w').y).toBeGreaterThan(at('y').bottom)
    // El carril pasa a la derecha del camino «sí»: el lienzo lo abarca.
    expect(result.bounds.w).toBeGreaterThan(at('y').right + 20)
  })

  it('un elif es la decisión del camino «no»: la cadena escalona hacia la derecha', () => {
    // if a: p  elif b: q  else: r   → s
    const graph = {
      nodes: [
        node('if', 220, 80),
        node('p', 200, 50, 'if'),
        node('elif', 220, 80, 'if'),
        node('q', 200, 50, 'elif'),
        node('r', 200, 50, 'elif'),
        node('s'),
      ],
      edges: [
        yes('if', 'p'),
        no('if', 'elif'),
        yes('elif', 'q'),
        no('elif', 'r'),
        seq('p', 's'),
        seq('q', 's'),
        seq('r', 's'),
      ],
    }
    const { at } = boxes(graph)
    expect(at('elif').cx).toBeGreaterThan(at('if').right)
    expect(at('q').cx).toBe(at('elif').cx)
    expect(at('r').cx).toBeGreaterThan(at('elif').right)
    expect(at('s').cx).toBe(at('if').cx)
    expect(at('s').y).toBeGreaterThan(Math.max(at('p').bottom, at('q').bottom, at('r').bottom))
  })

  it('un camino que acaba en un return no se junta, y el paso de después sigue al otro', () => {
    // if c: return  else: z   → w (solo desde z)
    const graph = {
      nodes: [node('if', 220, 80), node('ret', 200, 50, 'if'), node('z', 200, 50, 'if'), node('w')],
      edges: [yes('if', 'ret'), no('if', 'z'), seq('z', 'w')],
    }
    const { at } = boxes(graph)
    expect(at('w').cx).toBe(at('if').cx)
    expect(at('w').y).toBeGreaterThan(Math.max(at('ret').bottom, at('z').bottom))
  })

  it('los datos no colocan nada: solo manda el orden', () => {
    const base = {
      nodes: [node('a'), node('b'), node('c')],
      edges: [seq('a', 'b'), seq('b', 'c')],
    }
    const withData = {
      ...base,
      edges: [
        ...base.edges,
        { from: 'c', to: 'a', relation: 'dependency' as const },
        { from: 'a', to: 'c', relation: 'transform' as const },
      ],
    }
    expect(layoutFlowchart(withData).placements).toEqual(layoutFlowchart(base).placements)
  })

  it('lo que no se encadena con nada va después, sin pisarse', () => {
    const graph = {
      nodes: [node('a'), node('suelto'), node('b')],
      edges: [seq('a', 'b')],
    }
    const { at } = boxes(graph)
    expect(at('suelto').y).toBeGreaterThan(at('b').bottom)
  })

  it('un territorio centra su contenido en la espina y queda sobre la espina de fuera', () => {
    const graph: SemanticGraph = {
      nodes: [
        node('antes'),
        { ...node('bucle', 180, 60), territory: true, contains: ['c1', 'c2'] },
        node('c1', 160, 50, 'bucle'),
        node('c2', 320, 50, 'bucle'),
        node('despues'),
      ],
      edges: [seq('antes', 'bucle'), seq('bucle', 'despues'), seq('c1', 'c2')],
    }
    const result = layout(graph, { axis: 'vertical' })
    const at = (id: string) => {
      const p = result.placements.find((placement) => placement.id === id)
      if (!p) throw new Error(id)
      return p
    }
    const centre = (id: string) => at(id).x + at(id).size.w / 2
    expect(centre('bucle')).toBe(centre('antes'))
    expect(centre('despues')).toBe(centre('antes'))
    expect(Math.abs(centre('c1') - centre('bucle'))).toBeLessThanOrEqual(1)
    expect(Math.abs(centre('c2') - centre('bucle'))).toBeLessThanOrEqual(1)
  })

  it('un territorio que crece a la derecha lleva la espina donde la tiene su contenido', () => {
    // for …: if a: p  elif b: q  else: r   — la cadena escalona a la derecha dentro del bucle.
    const graph: SemanticGraph = {
      nodes: [
        node('antes'),
        { ...node('bucle', 180, 60), territory: true, contains: ['if', 'p', 'elif', 'q', 'r'] },
        node('if', 220, 80, 'bucle'),
        node('p', 200, 50, 'if'),
        node('elif', 220, 80, 'if'),
        node('q', 200, 50, 'elif'),
        node('r', 200, 50, 'elif'),
        node('despues'),
      ],
      edges: [
        seq('antes', 'bucle'),
        seq('bucle', 'despues'),
        yes('if', 'p'),
        no('if', 'elif'),
        yes('elif', 'q'),
        no('elif', 'r'),
      ],
    }
    const result = layout(graph, { axis: 'vertical' })
    const at = (id: string) => {
      const p = result.placements.find((placement) => placement.id === id)
      if (!p) throw new Error(id)
      return p
    }
    const spine = result.spines?.['bucle']
    expect(spine).toBeDefined()
    // La espina del territorio es la de su primer paso, no su centro…
    expect(at('bucle').x + (spine ?? 0)).toBe(at('if').x + at('if').size.w / 2)
    expect(spine ?? 0).toBeLessThan(at('bucle').size.w / 2)
    // …y la de fuera pasa por ella: lo de antes y lo de después quedan alineados con el bucle.
    expect(at('antes').x + at('antes').size.w / 2).toBe(at('bucle').x + (spine ?? 0))
    expect(at('despues').x + at('despues').size.w / 2).toBe(at('bucle').x + (spine ?? 0))
  })

  it('un programa largo con decisiones y bucles no se pisa ni sube', () => {
    for (const steps of [12, 25, 50, 100]) {
      const graph = generateProgram({ steps, order: true })
      const m = analyze(graph, layout(graph, { axis: 'vertical' }))
      expect(m.overlaps).toBe(0)
      expect(m.against).toBe(0)
    }
  })
})

describe('el trazado de una conexión de orden', () => {
  it('entre dos pasos de la misma espina, una recta', () => {
    const route = routeFlow({ x: 100, y: 50 }, { x: 100, y: 120 })
    expect(route.points).toEqual([
      { x: 100, y: 50 },
      { x: 100, y: 120 },
    ])
  })

  it('de otra columna, se junta justo encima del destino', () => {
    const route = routeFlow({ x: 300, y: 50 }, { x: 100, y: 200 })
    expect(route.points).toEqual([
      { x: 300, y: 50 },
      { x: 300, y: 200 - FLOW_JOIN },
      { x: 100, y: 200 - FLOW_JOIN },
      { x: 100, y: 200 },
    ])
  })

  it('el «no» sale del vértice derecho y baja a su columna', () => {
    const route = routeFlow({ x: 200, y: 40 }, { x: 360, y: 120 }, { exit: 'right' })
    expect(route.points).toEqual([
      { x: 200, y: 40 },
      { x: 360, y: 40 },
      { x: 360, y: 120 },
    ])
  })

  it('el «no» sin else rodea por su carril y vuelve a la espina', () => {
    const route = routeFlow({ x: 200, y: 40 }, { x: 100, y: 300 }, { exit: 'right', lane: 340 })
    expect(route.points).toEqual([
      { x: 200, y: 40 },
      { x: 340, y: 40 },
      { x: 340, y: 300 - FLOW_JOIN },
      { x: 100, y: 300 - FLOW_JOIN },
      { x: 100, y: 300 },
    ])
  })
})
