import { incoming, outgoing } from './classify.ts'
import type { SemanticEdge, SemanticGraph, SemanticNode, Size } from './types.ts'

/**
 * Profundidad por abstracción: un programa largo no se enseña plano.
 *
 * Un grupo de nodos se sustituye por un solo nodo que los encapsula, y sus conexiones se
 * recablean al borde del grupo. Entrar en ese nodo baja un nivel. Es la otra mitad de la
 * respuesta a la densidad: el plegado hace legible un script plano, y el colapso hace
 * legible un archivo con estructura.
 *
 * De dónde salen los grupos:
 * - Hoy, del **AST**: cada `def` es un grupo con nombre propio.
 * - Más adelante, de la **IA**: ante un script largo sin funciones, propondrá dónde estaría
 *   la costura natural. Por eso una sugerencia lleva `source` y `reason`: una agrupación
 *   propuesta por un modelo tiene que poder auditarse igual que la clasificación espacial,
 *   y el usuario tiene que poder rechazarla.
 */

export interface GroupSuggestion {
  id: string
  /** Nombre del nodo colapsado: `load_sales`, «Normalizar cliente». */
  label: string
  /** Nodos del grupo, en orden de ejecución. */
  nodes: string[]
  /** Quién propuso la agrupación. La IA nunca se hace pasar por el AST. */
  source: 'ast' | 'ai' | 'manual'
  /** Por qué estos nodos van juntos. Obligatorio: una agrupación sin razón no es auditable. */
  reason: string
}

export interface CollapseResult {
  graph: SemanticGraph
  /** Qué grupos se aplicaron de verdad (los inválidos se descartan). */
  applied: GroupSuggestion[]
  /** Grupos descartados y el motivo: nunca se ignora nada en silencio. */
  rejected: { group: GroupSuggestion; why: string }[]
}

export interface CollapseOptions {
  /** Tamaño del nodo colapsado. */
  size?: Size
  /** Grupos de menos de estos nodos no merecen colapsarse. */
  minNodes?: number
}

const DEFAULTS = { size: { w: 258, h: 156 }, minNodes: 2 }

/**
 * Sustituye cada grupo por un único nodo. Las conexiones que cruzaban el borde del grupo
 * pasan a entrar o salir del nodo colapsado; las internas desaparecen con él.
 */
export function collapse(
  graph: SemanticGraph,
  groups: GroupSuggestion[],
  options: CollapseOptions = {},
): CollapseResult {
  const { size, minNodes } = { ...DEFAULTS, ...options }
  const known = new Set(graph.nodes.map((n) => n.id))
  const applied: GroupSuggestion[] = []
  const rejected: CollapseResult['rejected'] = []
  const taken = new Set<string>()

  for (const group of groups) {
    const members = group.nodes.filter((id) => known.has(id))
    if (!group.reason.trim()) {
      rejected.push({ group, why: 'la agrupación no explica por qué' })
      continue
    }
    if (members.length < minNodes) {
      rejected.push({ group, why: `solo ${members.length} nodos del grupo existen` })
      continue
    }
    if (members.some((id) => taken.has(id))) {
      rejected.push({ group, why: 'se solapa con otro grupo ya aplicado' })
      continue
    }
    for (const id of members) taken.add(id)
    applied.push({ ...group, nodes: members })
  }

  const ownerOf = new Map<string, string>()
  for (const group of applied) for (const id of group.nodes) ownerOf.set(id, group.id)
  /** Dentro de un grupo, el nodo se reemplaza por él; fuera, se queda como está. */
  const resolve = (id: string) => ownerOf.get(id) ?? id

  const nodes: SemanticNode[] = graph.nodes
    .filter((node) => !ownerOf.has(node.id))
    .map((node) => ({ ...node }))

  for (const group of applied) {
    const members = group.nodes
    // Lo que encapsula es su métrica: el tamaño de un nodo mide la complejidad que esconde.
    const ops = members.length
    nodes.push({
      id: group.id,
      role: 'abstraction',
      size,
      contains: members,
      depth: 0,
      ops,
    })
  }

  const seen = new Set<string>()
  const edges: SemanticEdge[] = []
  for (const edge of graph.edges) {
    const from = resolve(edge.from)
    const to = resolve(edge.to)
    if (from === to) continue // conexión interna: se va con el grupo
    const key = `${from}→${to}:${edge.relation}:${edge.toPort ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ ...edge, from, to })
  }

  return { graph: { nodes, edges }, applied, rejected }
}

/**
 * Los grupos que el AST puede proponer por sí solo: todo nodo que declare `contains`
 * (una función, un método) es un grupo con su propio nombre.
 */
export function groupsFromContainers(graph: SemanticGraph): GroupSuggestion[] {
  return graph.nodes
    .filter((node) => (node.contains?.length ?? 0) > 0)
    .map((node) => ({
      id: `group:${node.id}`,
      label: node.id,
      nodes: node.contains ?? [],
      source: 'ast' as const,
      reason: `el AST declara que "${node.id}" contiene estos nodos`,
    }))
}

/**
 * Corta una cadena larga en tramos, para poder enseñarla colapsada mientras no haya
 * funciones de verdad. Es un recurso de emergencia y lo dice: `source: 'manual'`.
 * La versión buena de esto es la IA proponiendo dónde está la costura natural del código.
 */
export function groupsByRun(graph: SemanticGraph, every = 6): GroupSuggestion[] {
  const entry = graph.nodes.find((n) => incoming(graph, n.id).length === 0)
  if (!entry) return []

  const chain: string[] = []
  let current: string | undefined = entry.id
  const visited = new Set<string>()
  while (current && !visited.has(current)) {
    visited.add(current)
    chain.push(current)
    const next = outgoing(graph, current)
    current = next.length === 1 ? next[0]?.to : undefined
  }

  const groups: GroupSuggestion[] = []
  for (let i = 0; i + every <= chain.length; i += every) {
    const nodes = chain.slice(i, i + every)
    groups.push({
      id: `run:${i}`,
      label: `pasos ${i + 1}–${i + every}`,
      nodes,
      source: 'manual',
      reason: `tramo de ${every} pasos consecutivos sin ramificación`,
    })
  }
  return groups
}
