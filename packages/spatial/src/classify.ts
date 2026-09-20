import {
  STRATEGY_FOR,
  type Region,
  type SemanticEdge,
  type SemanticGraph,
  type Topology,
} from './types.ts'

/**
 * Clasificación espacial: mira el grafo y reconoce qué forma tiene.
 * No pregunta a la interfaz ni acepta una topología declarada a mano — la deduce,
 * igual que la morfología deduce la UI de un nodo a partir de su tipo.
 */

const FORWARD: SemanticEdge['relation'][] = ['dependency', 'transform', 'branch', 'merge']

export function outgoing(graph: SemanticGraph, id: string): SemanticEdge[] {
  return graph.edges.filter((e) => e.from === id && e.relation !== 'feedback')
}

export function incoming(graph: SemanticGraph, id: string): SemanticEdge[] {
  return graph.edges.filter((e) => e.to === id && e.relation !== 'feedback')
}

export function isForward(edge: SemanticEdge): boolean {
  return FORWARD.includes(edge.relation)
}

/** Umbrales de detección. Explícitos para que la clasificación se pueda discutir y ajustar. */
export const THRESHOLDS = {
  /** A partir de cuántos consumidores un valor deja de ser una cadena y pasa a ser un abanico. */
  fanOut: 3,
  /** A partir de cuántas fuentes un destino deja de ser un paso y pasa a ser una convergencia. */
  aggregation: 3,
}

/**
 * Detecta las regiones del grafo. El orden importa: las formas más específicas
 * (bucle, decisión) reclaman sus nodos antes que las genéricas (cadena).
 */
export function classify(graph: SemanticGraph): Region[] {
  const regions: Region[] = []
  const claimed = new Set<string>()
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const take = (ids: string[]) => ids.filter((id) => byId.has(id) && !claimed.has(id))

  const push = (topology: Topology, nodes: string[], evidence: string, anchor?: string) => {
    if (nodes.length === 0) return
    regions.push({
      id: `${topology}:${anchor ?? nodes[0] ?? ''}`,
      topology,
      strategy: STRATEGY_FOR[topology],
      nodes,
      ...(anchor === undefined ? {} : { anchor }),
      evidence,
    })
    for (const id of nodes) claimed.add(id)
  }

  // 1. Anidamiento: lo que un nodo contiene se dibuja dentro de él, no al lado.
  for (const node of graph.nodes) {
    const children = take(node.contains ?? [])
    if (children.length > 0) {
      push(
        'nesting',
        [node.id, ...children],
        `"${node.id}" contiene ${children.length} nodos`,
        node.id,
      )
    }
  }

  // 2. Bucles: una conexión de retorno cierra un territorio.
  for (const edge of graph.edges.filter((e) => e.relation === 'feedback')) {
    const body = take(bodyBetween(graph, edge.to, edge.from))
    if (body.length > 0) {
      push('loop', body, `retorno de "${edge.from}" a "${edge.to}"`, edge.to)
    }
  }

  // 3. Decisiones: dos o más salidas etiquetadas desde el mismo nodo.
  for (const node of graph.nodes) {
    const branches = outgoing(graph, node.id).filter((e) => e.relation === 'branch')
    if (branches.length < 2) continue
    const targets = take(branches.map((e) => e.to))
    const nodes = take([node.id, ...targets])
    if (nodes.length > 1) {
      push('branch', nodes, `"${node.id}" tiene ${branches.length} salidas etiquetadas`, node.id)
    }
  }

  // 4. Comparación: caminos hermanos del mismo rol; su diferencia es lo único que debe destacar.
  for (const node of graph.nodes) {
    const targets = outgoing(graph, node.id).map((e) => e.to)
    const siblings = take(targets)
    if (siblings.length < 2) continue
    const roles = new Set(siblings.map((id) => byId.get(id)?.role))
    const converge = new Set(siblings.map((id) => outgoing(graph, id)[0]?.to ?? ''))
    if (roles.size === 1 && converge.size === 1 && !converge.has('')) {
      push(
        'comparison',
        siblings,
        `${siblings.length} caminos del mismo rol entre dos puntos`,
        node.id,
      )
    }
  }

  // 5. Fan-out: un valor que alimenta a muchos está en el centro de un abanico.
  for (const node of graph.nodes) {
    const targets = outgoing(graph, node.id).map((e) => e.to)
    if (targets.length < THRESHOLDS.fanOut) continue
    const nodes = take([node.id, ...targets])
    if (nodes.length >= THRESHOLDS.fanOut) {
      push('fan-out', nodes, `"${node.id}" alimenta a ${targets.length} nodos`, node.id)
    }
  }

  // 6. Agregación: muchas fuentes que desembocan en un mismo destino.
  for (const node of graph.nodes) {
    const sources = incoming(graph, node.id).map((e) => e.from)
    if (sources.length < THRESHOLDS.aggregation) continue
    const nodes = take([...sources, node.id])
    if (nodes.length >= THRESHOLDS.aggregation) {
      push('aggregation', nodes, `"${node.id}" recibe de ${sources.length} nodos`, node.id)
    }
  }

  // 7. Lo que queda es una cadena: se lee como una frase.
  const rest = graph.nodes.map((n) => n.id).filter((id) => !claimed.has(id))
  if (rest.length > 0) {
    push('pipeline', rest, `${rest.length} nodos encadenados sin ramificación`)
  }

  return regions
}

/** Nodos alcanzables desde `head` que a su vez alcanzan `tail`: el cuerpo de un bucle. */
function bodyBetween(graph: SemanticGraph, head: string, tail: string): string[] {
  const forward = new Set<string>()
  const walk = (id: string) => {
    if (forward.has(id)) return
    forward.add(id)
    for (const e of outgoing(graph, id)) walk(e.to)
  }
  walk(head)
  const backward = new Set<string>()
  const walkBack = (id: string) => {
    if (backward.has(id)) return
    backward.add(id)
    for (const e of incoming(graph, id)) walkBack(e.from)
  }
  walkBack(tail)
  return graph.nodes.map((n) => n.id).filter((id) => forward.has(id) && backward.has(id))
}
