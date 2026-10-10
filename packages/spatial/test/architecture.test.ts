import { describe, expect, it } from 'vitest'
import {
  defaultShape,
  layout,
  layoutArchitecture,
  shapeCandidates,
  type ArchGraph,
  type ArchLink,
  type ArchModule,
  type Architecture,
  type ModuleRole,
  type SemanticNode,
  type Size,
} from '../src/index.ts'

/**
 * La arquitectura: qué forma tiene un programa visto como módulos, y dónde cae cada uno. Lo que se comprueba
 * es que cada forma solo se ofrece cuando el grafo la tiene de verdad, y que la colocación no pisa nada.
 */

const mod = (id: string, role: ModuleRole, more: Partial<ArchModule> = {}): ArchModule => ({
  id,
  role,
  ...more,
})
const data = (from: string, to: string, label?: string): ArchLink => ({
  from,
  to,
  kind: 'data',
  ...(label ? { label } : {}),
})
const call = (from: string, to: string): ArchLink => ({ from, to, kind: 'call' })

/** Llevar la cuenta de los gastos: unos datos, tres funciones y un menú que elige cuál usar. */
const GASTOS: ArchGraph = {
  modules: [
    mod('datos', 'datos'),
    mod('anadir', 'entrada'),
    mod('total', 'logica'),
    mod('caro', 'logica'),
    mod('menu', 'control', { loop: true, branches: true }),
  ],
  links: [
    data('datos', 'menu', 'gastos'),
    call('menu', 'anadir'),
    call('menu', 'total'),
    call('menu', 'caro'),
  ],
}

/** Un juego: en cada vuelta se lee la jugada, se actualiza el mundo y se dibuja. */
const JUEGO: ArchGraph = {
  modules: [
    mod('mundo', 'datos'),
    mod('leer', 'entrada'),
    mod('mover', 'logica'),
    mod('dibujar', 'salida'),
    mod('bucle', 'control', { loop: true }),
  ],
  links: [
    data('mundo', 'bucle', 'mundo'),
    call('bucle', 'leer'),
    call('bucle', 'mover'),
    call('bucle', 'dibujar'),
  ],
}

/** Leer, limpiar, resumir, enseñar: cada parte le pasa lo suyo a la siguiente. */
const INFORME: ArchGraph = {
  modules: [
    mod('leer', 'entrada'),
    mod('limpiar', 'logica'),
    mod('resumir', 'logica'),
    mod('mostrar', 'salida'),
  ],
  links: [
    data('leer', 'limpiar', 'filas'),
    data('limpiar', 'resumir', 'validas'),
    data('resumir', 'mostrar', 'resumen'),
  ],
}

const SIZE: Size = { w: 220, h: 96 }
const sizesOf = (graph: ArchGraph, size = SIZE) =>
  new Map(graph.modules.map((module) => [module.id, size]))

/** Los pares de módulos que se pisan. */
function collisions(
  positions: ReadonlyMap<string, { x: number; y: number }>,
  sizes: ReadonlyMap<string, Size>,
) {
  const boxes = [...positions].map(([id, at]) => ({ id, ...at, ...(sizes.get(id) ?? SIZE) }))
  return boxes.flatMap((a, i) =>
    boxes
      .slice(i + 1)
      .filter((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
      .map((b) => `${a.id}×${b.id}`),
  )
}

describe('qué forma tiene un programa', () => {
  it('un menú que elige entre varias cosas es un centro; también cuadra como ciclo, pero dice menos', () => {
    expect(shapeCandidates(GASTOS)).toEqual([
      { shape: 'centro', anchor: 'menu' },
      { shape: 'ciclo', anchor: 'menu' },
      { shape: 'capas' },
    ])
  })

  it('un bucle que hace todos sus pasos en cada vuelta es un ciclo', () => {
    expect(defaultShape(JUEGO)).toEqual({ shape: 'ciclo', anchor: 'bucle' })
  })

  it('una cadena en la que cada parte le pasa un dato a la siguiente es una tubería', () => {
    expect(shapeCandidates(INFORME)).toEqual([{ shape: 'tuberia' }, { shape: 'capas' }])
    // Si un eslabón no le pasa nada al siguiente, ya no lo es.
    const broken = { ...INFORME, links: INFORME.links.slice(0, 2) }
    expect(shapeCandidates(broken)).toEqual([{ shape: 'capas' }])
  })

  it('un dato que usan casi todos hace de centro, si nadie manda', () => {
    const graph: ArchGraph = {
      modules: [mod('datos', 'datos'), mod('a', 'logica'), mod('b', 'logica'), mod('c', 'salida')],
      links: [data('datos', 'a'), data('datos', 'b'), data('datos', 'c')],
    }
    expect(defaultShape(graph)).toEqual({ shape: 'centro', anchor: 'datos' })
  })

  it('con dos módulos, o sin nada que los una, son capas: es la forma que cuadra siempre', () => {
    expect(shapeCandidates({ modules: GASTOS.modules.slice(0, 2), links: [] })).toEqual([
      { shape: 'capas' },
    ])
    expect(shapeCandidates({ modules: GASTOS.modules, links: [] })).toEqual([{ shape: 'capas' }])
  })
})

describe('dónde va cada módulo', () => {
  const shaped = (
    graph: ArchGraph,
    shape: Architecture['shape'],
    anchor?: string,
  ): Architecture => ({
    ...graph,
    shape,
    ...(anchor ? { anchor } : {}),
  })
  const cases: [string, Architecture][] = [
    ['capas', shaped(GASTOS, 'capas')],
    ['centro', shaped(GASTOS, 'centro', 'menu')],
    ['ciclo', shaped(JUEGO, 'ciclo', 'bucle')],
    ['tubería', shaped(INFORME, 'tuberia')],
  ]

  it.each(cases)('%s: todos colocados, sin pisarse, dentro de sus límites', (_, architecture) => {
    const sizes = sizesOf(architecture)
    const { positions, bounds, figures } = layoutArchitecture(architecture, sizes)
    expect([...positions.keys()].sort()).toEqual(architecture.modules.map((m) => m.id).sort())
    expect(collisions(positions, sizes)).toEqual([])
    for (const [id, at] of positions) {
      const size = sizes.get(id) ?? SIZE
      expect(at.x).toBeGreaterThanOrEqual(0)
      expect(at.y).toBeGreaterThanOrEqual(0)
      expect(at.x + size.w).toBeLessThanOrEqual(bounds.w)
      expect(at.y + size.h).toBeLessThanOrEqual(bounds.h)
    }
    for (const figure of figures) {
      expect(figure.x).toBeGreaterThanOrEqual(0)
      expect(figure.x + figure.w).toBeLessThanOrEqual(bounds.w)
      expect(figure.y + figure.h).toBeLessThanOrEqual(bounds.h)
    }
  })

  it('las capas ponen arriba a quien manda y abajo lo que se guarda; en medio, de la entrada a la salida', () => {
    const { positions, figures } = layoutArchitecture(shaped(GASTOS, 'capas'), sizesOf(GASTOS))
    const y = (id: string) => positions.get(id)?.y ?? 0
    const x = (id: string) => positions.get(id)?.x ?? 0
    expect(y('menu')).toBeLessThan(y('total'))
    expect(y('total')).toBeLessThan(y('datos'))
    expect(y('anadir')).toBe(y('total'))
    expect(x('anadir')).toBeLessThan(x('total'))
    expect(figures.map((figure) => figure.label)).toEqual([
      'Quién manda',
      'Lo que hace',
      'Lo que guarda',
    ])
  })

  it('el centro queda rodeado: sus satélites caen a todos sus lados', () => {
    const sizes = sizesOf(GASTOS)
    const { positions, figures } = layoutArchitecture(shaped(GASTOS, 'centro', 'menu'), sizes)
    const centre = positions.get('menu') ?? { x: 0, y: 0 }
    const others = [...positions].filter(([id]) => id !== 'menu').map(([, at]) => at)
    expect(others.some((at) => at.x < centre.x)).toBe(true)
    expect(others.some((at) => at.x > centre.x)).toBe(true)
    expect(others.some((at) => at.y < centre.y)).toBe(true)
    expect(others.some((at) => at.y > centre.y)).toBe(true)
    expect(figures.map((figure) => figure.kind)).toEqual(['spokes'])
  })

  it('el ciclo pone en el anillo la cabeza y lo que usa; lo que se prepara antes espera a su izquierda', () => {
    const { positions, figures } = layoutArchitecture(
      shaped(JUEGO, 'ciclo', 'bucle'),
      sizesOf(JUEGO),
    )
    const ring = figures.find((figure) => figure.kind === 'ring')
    expect(ring).toBeDefined()
    const x = (id: string) => positions.get(id)?.x ?? 0
    for (const id of ['bucle', 'leer', 'mover', 'dibujar']) expect(x('mundo')).toBeLessThan(x(id))
    // La cabeza, arriba del todo.
    const y = (id: string) => positions.get(id)?.y ?? 0
    for (const id of ['leer', 'mover', 'dibujar']) expect(y('bucle')).toBeLessThan(y(id))
  })

  it('un módulo abierto (más grande) empuja a los demás en vez de taparlos', () => {
    for (const [, architecture] of cases) {
      const sizes = sizesOf(architecture)
      const first = architecture.modules[1]?.id ?? ''
      sizes.set(first, { w: 520, h: 420 })
      expect(collisions(layoutArchitecture(architecture, sizes).positions, sizes)).toEqual([])
    }
  })

  it('más ancho que alto: la tubería de cuatro cabe en una fila', () => {
    const { bounds } = layoutArchitecture(shaped(INFORME, 'tuberia'), sizesOf(INFORME))
    expect(bounds.w).toBeGreaterThan(bounds.h * 2)
  })
})

describe('el plano de fuera, con arquitectura', () => {
  const node = (id: string, more: Partial<SemanticNode> = {}): SemanticNode => ({
    id,
    role: 'container',
    size: SIZE,
    ...more,
  })

  it('los módulos van a su forma y lo suelto baja debajo; sin arquitectura, la columna de siempre', () => {
    const nodes = [...GASTOS.modules.map((m) => node(m.id)), node('suelto', { role: 'transform' })]
    const edges = nodes.slice(1).map((n, at) => ({
      from: nodes[at]?.id ?? '',
      to: n.id,
      relation: 'sequence' as const,
    }))
    const column = layout({ nodes, edges }, { axis: 'vertical' })
    expect(new Set(column.placements.map((p) => p.x + p.size.w / 2)).size).toBe(1)
    expect(column.figures).toBeUndefined()

    const architecture: Architecture = { ...GASTOS, shape: 'centro', anchor: 'menu' }
    const plane = layout({ nodes, edges }, { axis: 'vertical', architecture })
    expect(plane.figures?.map((figure) => figure.kind)).toEqual(['spokes'])
    const at = (id: string) => plane.placements.find((p) => p.id === id) ?? { x: 0, y: 0 }
    const lowest = Math.max(...GASTOS.modules.map((m) => at(m.id).y + SIZE.h))
    expect(at('suelto').y).toBeGreaterThan(lowest)
    expect(plane.bounds.w).toBeGreaterThan(column.bounds.w)
  })

  it('un módulo abierto conserva lo de dentro colocado como diagrama de flujo', () => {
    const nodes = [
      node('datos'),
      node('menu', { contains: ['a', 'b'], territory: true }),
      node('a', { role: 'transform', owner: 'menu' }),
      node('b', { role: 'transform', owner: 'menu' }),
      node('total'),
    ]
    const architecture: Architecture = {
      modules: [mod('datos', 'datos'), mod('menu', 'control'), mod('total', 'logica')],
      links: [],
      shape: 'capas',
    }
    const plane = layout(
      { nodes, edges: [{ from: 'a', to: 'b', relation: 'sequence' }] },
      { axis: 'vertical', architecture },
    )
    const at = (id: string) => plane.placements.find((p) => p.id === id) ?? { x: 0, y: 0 }
    // Dentro, uno debajo de otro; y los dos dentro del marco de su módulo.
    expect(at('b').y).toBeGreaterThan(at('a').y)
    expect(at('a').x).toBeGreaterThan(at('menu').x)
    expect(plane.scopes.menu).toEqual(['a', 'b'])
  })
})
