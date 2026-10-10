import { getKind } from '@prysel/morphology'
import {
  channelOf,
  defaultShape,
  type ArchGraph,
  type ArchLink,
  type ArchModule,
  type Architecture,
  type ModuleRole,
  type SemanticEdge,
} from '@prysel/spatial'
import type { CanvasNode } from './Canvas.tsx'

/**
 * La arquitectura de un programa, **sacada de su análisis**: qué módulos tiene (sus etapas de primer nivel) y
 * qué los une de verdad — un dato que uno deja y otro usa, o una función de uno a la que otro llama.
 *
 * Nada de esto lo dice una IA: son las conexiones que el analizador ya resolvió, recogidas en el borde de cada
 * módulo. El papel de cada uno (entrada, datos, lógica, control, salida) se estima aquí con lo que hace su
 * código; quien tenga mejor criterio (el JEV) puede corregirlo.
 */

/** Lo que el código de un módulo hace, mirado desde fuera: de aquí sale su papel. */
export interface ModuleFacts {
  id: string
  title: string
  /** Pide datos por teclado. */
  asks: boolean
  /** Escribe en pantalla. */
  prints: boolean
  /** Solo define funciones o clases. */
  defines: boolean
  /** Solo guarda valores (ni llama a nadie ni decide nada). */
  stores: boolean
  /** Repite algo en su primer nivel. */
  loops: boolean
  /** Dentro de lo que repite, decide entre caminos. */
  branches: boolean
  /** A cuántos de los demás módulos llama. */
  calls: number
}

const ASKS = /\binput\s*\(/

/** El papel que el código de un módulo deja ver. */
export function roleOf(facts: ModuleFacts): ModuleRole {
  // Quien repite llamando a otros, o no hace más que repartir el trabajo entre varios, manda.
  if ((facts.loops && facts.calls >= 1) || (!facts.defines && facts.calls >= 2)) return 'control'
  if (facts.stores) return 'datos'
  if (facts.asks) return 'entrada'
  if (facts.prints) return 'salida'
  return 'logica'
}

/** El nombre del valor que viaja por una conexión de datos: lo que define su origen, o su parámetro. */
function valueName(edge: SemanticEdge, from: CanvasNode | undefined): string | undefined {
  const port = edge.fromPort
  if (port?.startsWith('param:')) return port.slice('param:'.length)
  if (port?.startsWith('result:')) return port.slice('result:'.length)
  return from?.provides
}

/** Varios nombres en una sola etiqueta: los dos primeros y cuántos más. */
const several = (names: readonly string[]) =>
  names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`

/**
 * Los módulos que se ven en el primer nivel y lo que los une. `view` es lo que el lienzo dibuja (de ahí sale
 * qué etapas están arriba del todo); `all`, el programa entero con sus etapas (`withSections`), de donde sale
 * lo que cada módulo tiene dentro aunque esté plegado.
 */
export function moduleGraph(
  view: readonly CanvasNode[],
  all: readonly CanvasNode[],
  edges: readonly SemanticEdge[],
): { graph: ArchGraph; facts: ModuleFacts[] } {
  const inner = new Set(view.flatMap((node) => node.contains ?? []))
  const tops = view.filter((node) => node.section !== undefined && !inner.has(node.id))
  const byId = new Map(all.map((node) => [node.id, node]))
  const owned = new Map<string, string[]>()
  for (const node of all) {
    if (node.owner !== undefined) owned.set(node.owner, [...(owned.get(node.owner) ?? []), node.id])
  }
  const deep = (roots: readonly string[]): Set<string> => {
    const found = new Set<string>()
    const walk = (id: string) => {
      if (found.has(id)) return
      found.add(id)
      for (const child of byId.get(id)?.contains ?? []) walk(child)
      for (const child of owned.get(id) ?? []) walk(child)
    }
    for (const id of roots) walk(id)
    return found
  }
  /** Las sentencias de su primer nivel: las de la etapa, o el bucle que la encabeza. */
  const membersOf = (node: CanvasNode) =>
    node.kind === 'space.section' ? [...(node.section?.members ?? [])] : [node.id]
  const inside = new Map(tops.map((node) => [node.id, deep(membersOf(node))]))
  const moduleOf = new Map<string, string>()
  for (const [module, ids] of inside) {
    for (const id of ids) if (!moduleOf.has(id)) moduleOf.set(id, module)
  }

  // Lo que los une. Varios datos (o varias funciones) entre los mismos dos módulos son una sola flecha.
  const found = new Map<string, { link: ArchLink; names: string[] }>()
  const add = (from: string, to: string, kind: ArchLink['kind'], name: string | undefined) => {
    if (from === to) return
    const key = `${kind}|${from}|${to}`
    const entry = found.get(key) ?? { link: { from, to, kind }, names: [] }
    if (name !== undefined && !entry.names.includes(name)) entry.names.push(name)
    found.set(key, entry)
  }
  for (const edge of edges) {
    if (channelOf(edge) !== 'data') continue
    const from = moduleOf.get(edge.from)
    const to = moduleOf.get(edge.to)
    if (from === undefined || to === undefined) continue
    const source = byId.get(edge.from)
    const kind = source?.kind ?? 'opaque.code'
    if (kind === 'external.import') continue
    // Lo que sale de una función (que no sea un parámetro) es su nombre: quien lo recibe la está usando.
    if (getKind(kind).role === 'abstraction' && !edge.fromPort?.startsWith('param:')) {
      add(to, from, 'call', source?.label)
    } else {
      add(from, to, 'data', valueName(edge, source))
    }
  }
  for (const node of all) {
    const from = moduleOf.get(node.id)
    if (from === undefined) continue
    for (const sub of node.subprocesses ?? []) {
      const to = moduleOf.get(sub.id)
      if (to !== undefined) add(from, to, 'call', sub.name)
    }
  }
  const links = [...found.values()].map(({ link, names }) =>
    names.length > 0 ? { ...link, label: several(names) } : link,
  )

  const facts = tops.map((top): ModuleFacts => {
    const own = [...(inside.get(top.id) ?? [])].flatMap((id) => byId.get(id) ?? [])
    const members = membersOf(top).flatMap((id) => byId.get(id) ?? [])
    const loop = members.find((node) => node.kind === 'control.loop')
    const looped = loop ? deep([loop.id]) : new Set<string>()
    return {
      id: top.id,
      title: top.section?.title ?? top.label,
      asks: own.some((node) => ASKS.test(node.code ?? node.text ?? '')),
      prints: own.some((node) => node.kind === 'effect.io' || node.kind === 'output.display'),
      defines:
        members.length > 0 && members.every((node) => getKind(node.kind).role === 'abstraction'),
      stores:
        own.length > 0 &&
        own.every((node) => {
          const role = getKind(node.kind).role
          return (role === 'value' || role === 'data') && (node.subprocesses ?? []).length === 0
        }),
      loops: loop !== undefined,
      branches: [...looped].some((id) => byId.get(id)?.kind === 'control.condition'),
      calls: links.filter((link) => link.kind === 'call' && link.from === top.id).length,
    }
  })
  const modules = facts.map((fact): ArchModule => ({
    id: fact.id,
    role: roleOf(fact),
    ...(fact.loops ? { loop: true } : {}),
    ...(fact.branches ? { branches: true } : {}),
  }))
  return { graph: { modules, links }, facts }
}

/**
 * La arquitectura con la que se dibuja el programa si nadie dice otra cosa: sus módulos y sus flechas de
 * verdad, y la forma que más dice de las que el grafo tiene. `null` si no hay al menos dos módulos (un
 * programa sin etapas se lee como siempre).
 */
export function architectureOf(
  view: readonly CanvasNode[],
  all: readonly CanvasNode[],
  edges: readonly SemanticEdge[],
): Architecture | null {
  const { graph } = moduleGraph(view, all, edges)
  if (graph.modules.length < 2) return null
  return { ...graph, ...defaultShape(graph) }
}
