import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import {
  architectureOf,
  functionsOf,
  moduleGraph,
  toCanvasNodes,
  viewOf,
  withSections,
} from '@prysel/ui'
import { layout, type SemanticNode } from '@prysel/spatial'

/**
 * La arquitectura de un programa, sacada de su análisis: qué módulos tiene, qué papel hace cada uno, qué los
 * une de verdad (un dato que pasa, o uno que usa a otro) y qué forma sale de ahí. Con tres programas como los
 * que pide quien construye hablando: un menú sobre unos datos, una cadena de pasos y un bucle de juego.
 */

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))
const fixture = (name: string) =>
  readFileSync(path.resolve(__dirname, `fixtures/arch/${name}.py`), 'utf8')

let parse: (source: string) => Program
beforeAll(async () => {
  const parser = await createPythonParser({
    runtime: wasmDir,
    language: path.join(wasmDir, 'tree-sitter-python.wasm'),
  })
  parse = (source: string) => buildProgram(parser.parse(source), source)
}, 30_000)

/** Lo que se ve de un programa como arquitectura, y lo que sale de él. */
function seen(name: string) {
  const program = parse(fixture(name))
  const all = withSections(toCanvasNodes(program.nodes), program.edges, program.sections ?? [])
  const { view } = viewOf(all, program.edges, functionsOf(all, program.edges), {
    focus: null,
    flow: true,
    density: 'normal',
    modules: true,
  })
  const { graph, facts } = moduleGraph(view.nodes, all, program.edges)
  const title = new Map(facts.map((fact) => [fact.id, fact.title]))
  const named = (id: string) => title.get(id) ?? id
  return {
    program,
    all,
    view,
    graph,
    roles: Object.fromEntries(graph.modules.map((module) => [named(module.id), module.role])),
    links: graph.links
      .map((link) => `${named(link.from)} ${link.kind === 'data' ? '→' : '⇢'} ${named(link.to)}`)
      .sort(),
    labels: Object.fromEntries(
      graph.links.map((link) => [
        `${named(link.from)} ${link.kind === 'data' ? '→' : '⇢'} ${named(link.to)}`,
        link.label,
      ]),
    ),
    architecture: architectureOf(view.nodes, all, program.edges),
    named,
  }
}

describe('un menú sobre unos datos', () => {
  it('cada etapa de arriba es un módulo, plegado en su tarjeta, con el papel que su código deja ver', () => {
    const { view, roles } = seen('gastos')
    expect(roles).toEqual({
      'Lista de gastos': 'datos',
      'Añadir gasto': 'entrada',
      'Mostrar total': 'salida',
      'Buscar más caro': 'salida',
      Menú: 'control',
    })
    // Nada de lo de dentro a la vista: solo los cinco módulos.
    expect(view.nodes.filter((node) => node.section)).toHaveLength(5)
    expect(view.nodes.some((node) => node.kind === 'abstraction.collapsed')).toBe(false)
  })

  it('lo que los une sale del análisis: el menú usa a las tres funciones, y las tres usan los datos', () => {
    const { links, labels } = seen('gastos')
    expect(links).toEqual([
      'Lista de gastos → Añadir gasto',
      'Lista de gastos → Buscar más caro',
      'Lista de gastos → Mostrar total',
      'Menú ⇢ Añadir gasto',
      'Menú ⇢ Buscar más caro',
      'Menú ⇢ Mostrar total',
    ])
    expect(labels['Lista de gastos → Mostrar total']).toBe('gastos')
    expect(labels['Menú ⇢ Mostrar total']).toBe('mostrar_total')
  })

  it('su forma es un centro: el menú reparte el trabajo', () => {
    const { architecture, named } = seen('gastos')
    expect(architecture?.shape).toBe('centro')
    expect(named(architecture?.anchor ?? '')).toBe('Menú')
  })
})

describe('una cadena de pasos', () => {
  it('cada parte le pasa lo suyo a la siguiente: una tubería', () => {
    const { links, labels, architecture, roles } = seen('informe')
    expect(links).toEqual(['Leer ventas → Limpiar', 'Limpiar → Resumir', 'Resumir → Mostrar'])
    expect(labels['Resumir → Mostrar']).toBe('total, media')
    expect(architecture?.shape).toBe('tuberia')
    expect(roles['Leer ventas']).toBe('datos')
    expect(roles.Mostrar).toBe('salida')
  })
})

describe('un bucle de juego', () => {
  it('el bucle manda y en cada vuelta usa a los demás: un ciclo', () => {
    const { links, architecture, named, roles } = seen('juego')
    expect(links).toEqual([
      'Bucle del juego ⇢ Dibujar',
      'Bucle del juego ⇢ Leer jugada',
      'Bucle del juego ⇢ Mover',
      'Mundo → Bucle del juego',
    ])
    expect(roles['Bucle del juego']).toBe('control')
    expect(roles.Mundo).toBe('datos')
    expect(architecture?.shape).toBe('ciclo')
    expect(named(architecture?.anchor ?? '')).toBe('Bucle del juego')
  })
})

describe('lo que no es arquitectura se queda como estaba', () => {
  it('un programa sin etapas, o con una sola, no tiene arquitectura', () => {
    const program = parse('a = 1\nb = a + 1\nprint(b)\n')
    const all = withSections(toCanvasNodes(program.nodes), program.edges, program.sections ?? [])
    expect(architectureOf(all, all, program.edges)).toBeNull()
  })

  it('sin pedirla, las etapas se pliegan como siempre (las que guardan tarjetas, abiertas)', () => {
    const program = parse(fixture('gastos'))
    const all = withSections(toCanvasNodes(program.nodes), program.edges, program.sections ?? [])
    const plain = viewOf(all, program.edges, functionsOf(all, program.edges), {
      focus: null,
      flow: true,
      density: 'normal',
    })
    const modules = viewOf(all, program.edges, functionsOf(all, program.edges), {
      focus: null,
      flow: true,
      density: 'normal',
      modules: true,
    })
    expect(plain.view.nodes.length).toBe(modules.view.nodes.length)
    expect([...plain.folded].sort()).toEqual([...modules.folded].sort())
  })
})

describe('medidas: la arquitectura cabe a un tamaño que se lee', () => {
  const SIZE = { w: 264, h: 112 }
  const asNodes = (ids: readonly string[]): SemanticNode[] =>
    ids.map((id) => ({ id, role: 'container', size: SIZE }))

  it.each(['gastos', 'informe', 'juego'])(
    '%s: cabe entero en un lienzo de 836 px a un tamaño que se lee',
    (name) => {
      const { architecture, graph } = seen(name)
      if (!architecture) throw new Error('sin arquitectura')
      const ids = graph.modules.map((module) => module.id)
      const edges = ids.slice(1).map((id, at) => ({
        from: ids[at] ?? '',
        to: id,
        relation: 'sequence' as const,
      }))
      const plane = layout(
        { nodes: asNodes(ids), edges },
        { axis: 'vertical', architecture, architectureWidth: 1040 },
      )
      // El zoom al que cabe entero en 836×640 (con 24 px de margen y 280 a un lado para la cajita).
      const fits = (bounds: { w: number; h: number }) =>
        Math.min(1, (836 - 48) / (bounds.w + 280), (640 - 48) / bounds.h)
      // (La columna de tarjetas plegadas es más estrecha y cabe a más tamaño: la arquitectura gasta sitio en
      // decir qué une a los módulos. Lo que se le pide es que siga leyéndose.)
      expect(fits(plane.bounds)).toBeGreaterThanOrEqual(0.6)
    },
  )
})
