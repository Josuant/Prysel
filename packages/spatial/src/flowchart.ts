import type { LayoutResult, Placement, Point, SemanticEdge, SemanticGraph, Size } from './types.ts'

/**
 * El programa como **diagrama de flujo**, leído de arriba abajo.
 *
 * No reparte capas de un grafo cualquiera: reconstruye la estructura del código (un bloque es una lista de
 * pasos; una decisión tiene un camino «sí», uno «no» y un punto en el que se vuelven a juntar) y la dibuja
 * como la dibujaría una persona:
 *
 * - Cada bloque es una columna. Sus pasos bajan uno debajo de otro, centrados en una misma **espina**.
 * - Una decisión sigue la espina con su camino «sí» (debajo) y abre el «no» a la derecha. Sin `else`, el
 *   «no» es un carril que rodea el camino «sí» por la derecha. Los dos caminos se juntan justo encima del
 *   paso que sigue a la decisión, que vuelve a la espina.
 * - Un `elif` es la decisión del camino «no» de la anterior: la cadena escalona hacia la derecha.
 *
 * Solo manda el **orden de ejecución** (`sequence` y `branch`). Los datos no colocan nada: las variables
 * viajan como chips, no como cables.
 */

export interface FlowchartOptions {
  /** Hueco entre dos pasos seguidos: el sitio de la flecha y, bajo una decisión, el de la unión. */
  gapY?: number
  /** Hueco entre el camino «sí» y el «no» de una decisión. */
  gapX?: number
  padding?: number
}

const DEFAULTS = { gapY: 40, gapX: 44, padding: 28 }

/** Lo que el «no» de una decisión se aparta, como mínimo, del vértice derecho del rombo. */
const SIDE_MIN = 34
/** El carril del «no» sin `else`: lo que se aparta del camino «sí» que rodea. */
const LANE = 26
/** Entre dos trozos del programa que no se encadenan (algo inalcanzable, una definición suelta). */
const SECTION_GAP = 1.6

/** Un paso de un bloque: un nodo, o una decisión con sus dos caminos. */
type Item =
  | { kind: 'node'; id: string }
  | { kind: 'decision'; id: string; yes: Item[]; no: Item[]; bypass: boolean }

/** Lo que mide algo a cada lado de su espina, y de alto. */
interface Extent {
  left: number
  right: number
  h: number
}

const YES = new Set(['verdadero', 'sí', 'si', 'true', 'yes'])
const NO = new Set(['falso', 'no', 'false'])

/** ¿Es el camino «no» de una decisión? Por su etiqueta o, sin ella, por el puerto alternativo. */
const isNoBranch = (edge: SemanticEdge) =>
  NO.has(edge.label?.toLowerCase() ?? '') || edge.fromPort === 'alt' || edge.fromPort === 'order-no'
const isYesBranch = (edge: SemanticEdge) =>
  YES.has(edge.label?.toLowerCase() ?? '') || (!isNoBranch(edge) && edge.relation === 'branch')

export function layoutFlowchart(
  graph: SemanticGraph,
  options: FlowchartOptions = {},
): LayoutResult {
  const { gapY, gapX, padding } = { ...DEFAULTS, ...options }
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const rank = new Map(graph.nodes.map((node, i) => [node.id, i]))
  const byRank = (a: string, b: string) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0)
  const sizeOf = (id: string): Size => byId.get(id)?.size ?? { w: 0, h: 0 }
  /** Dónde cae la espina de un paso: en su centro, o donde diga (un territorio, donde la tenga su contenido). */
  const spineOf = (id: string) => byId.get(id)?.spine ?? sizeOf(id).w / 2

  // El orden: lo que sigue a cada paso, y los dos caminos de cada decisión. Un grafo sin orden (solo datos,
  // como los de las ilustraciones) se lee siguiendo su flujo de datos: es lo más parecido que tiene.
  const hasOrder = graph.edges.some((e) => e.relation === 'sequence')
  const isOrder = (e: SemanticEdge) =>
    hasOrder
      ? e.relation === 'sequence'
      : e.relation === 'transform' || e.relation === 'merge' || e.relation === 'dependency'
  const next = new Map<string, string[]>()
  const yesOf = new Map<string, string>()
  const noOf = new Map<string, string>()
  const entered = new Set<string>()
  for (const edge of graph.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to) || edge.from === edge.to) continue
    if (edge.relation === 'branch') {
      const map = isNoBranch(edge) ? noOf : isYesBranch(edge) ? yesOf : null
      if (map && !map.has(edge.from)) map.set(edge.from, edge.to)
      entered.add(edge.to)
    } else if (isOrder(edge)) {
      next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to])
      entered.add(edge.to)
    }
  }
  for (const list of next.values()) list.sort(byRank)
  const isDecision = (id: string) => yesOf.has(id) || noOf.has(id)

  /** Lo alcanzable desde un paso siguiendo el orden (sin retornos). */
  const reachCache = new Map<string, Set<string>>()
  const reach = (start: string | undefined): Set<string> => {
    if (start === undefined) return new Set()
    const cached = reachCache.get(start)
    if (cached) return cached
    const found = new Set<string>()
    const stack = [start]
    while (stack.length > 0) {
      const id = stack.pop() as string
      if (found.has(id)) continue
      found.add(id)
      stack.push(...(next.get(id) ?? []))
      const yes = yesOf.get(id)
      const no = noOf.get(id)
      if (yes) stack.push(yes)
      if (no) stack.push(no)
    }
    reachCache.set(start, found)
    return found
  }

  const usesOwners = graph.nodes.some((node) => node.owner !== undefined)
  /** La decisión y los `elif` que cuelgan de ella: lo que pertenece a cualquiera de ellos es de sus caminos. */
  const family = (decision: string): Set<string> => {
    const found = new Set([decision])
    for (let at = noOf.get(decision); at && isDecision(at); at = noOf.get(at)) {
      if (byId.get(at)?.owner !== decision) break
      found.add(at)
    }
    return found
  }

  const visited = new Set<string>()

  /**
   * Los pasos de un bloque desde `start`, hasta salir de la decisión `within` (si la hay). Devuelve también
   * dónde se salió: el paso que sigue a la decisión, en el que se juntan sus caminos.
   */
  const chain = (
    start: string | undefined,
    within?: { family: Set<string>; other: Set<string> },
  ): { items: Item[]; exit: string | undefined } => {
    const items: Item[] = []
    let current = start
    while (current !== undefined) {
      if (visited.has(current)) return { items, exit: within ? current : undefined }
      if (within) {
        const owner = byId.get(current)?.owner
        const inside = usesOwners
          ? owner !== undefined && within.family.has(owner)
          : !within.other.has(current)
        if (!inside) return { items, exit: current }
      }
      visited.add(current)
      if (isDecision(current)) {
        const item = decision(current)
        items.push(item.item)
        current = item.merge
      } else {
        items.push({ kind: 'node', id: current })
        current = (next.get(current) ?? []).find((id) => !visited.has(id) || within !== undefined)
      }
    }
    return { items, exit: undefined }
  }

  const decision = (id: string): { item: Item; merge: string | undefined } => {
    const yesStart = yesOf.get(id)
    const noStart = noOf.get(id)
    // Sin `else`, la decisión sigue directamente con lo que viene después: ese es su camino «no».
    const bypass = noStart === undefined ? (next.get(id) ?? [])[0] : undefined
    const fam = family(id)
    const yes = chain(yesStart, { family: fam, other: reach(noStart ?? bypass) })
    const no =
      noStart === undefined
        ? { items: [], exit: undefined }
        : chain(noStart, { family: fam, other: reach(yesStart) })
    return {
      item: { kind: 'decision', id, yes: yes.items, no: no.items, bypass: noStart === undefined },
      merge: yes.exit ?? no.exit ?? bypass,
    }
  }

  // Se empieza por lo que nada precede, en el orden del programa; lo que quede suelto, después.
  const sections: Item[][] = []
  const starts = [
    ...graph.nodes.filter((node) => !entered.has(node.id)).map((node) => node.id),
    ...graph.nodes.map((node) => node.id),
  ]
  for (const start of starts) {
    if (visited.has(start)) continue
    const { items } = chain(start)
    if (items.length > 0) sections.push(items)
  }

  // ── Medidas, de dentro hacia fuera ──
  const extents = new Map<Item, Extent & { offset?: number }>()
  const measureBlock = (items: Item[]): Extent => {
    let left = 0
    let right = 0
    let h = 0
    items.forEach((item, i) => {
      const e = measure(item)
      left = Math.max(left, e.left)
      right = Math.max(right, e.right)
      h += e.h + (i > 0 ? gapY : 0)
    })
    return { left, right, h }
  }
  const measure = (item: Item): Extent => {
    const known = extents.get(item)
    if (known) return known
    const size = sizeOf(item.id)
    let extent: Extent & { offset?: number }
    if (item.kind === 'node') {
      const spine = spineOf(item.id)
      extent = { left: spine, right: size.w - spine, h: size.h }
    } else {
      const yes = measureBlock(item.yes)
      const no = measureBlock(item.no)
      const half = size.w / 2
      const left = Math.max(half, yes.left)
      let right = Math.max(half, yes.right)
      let offset: number | undefined
      if (item.no.length > 0) {
        // El camino «no» baja a la derecha: pasado el vértice del rombo y sin tocar el camino «sí».
        offset = Math.max(half + SIDE_MIN + no.left, yes.right + gapX + no.left)
        right = Math.max(right, offset + no.right)
      } else if (item.bypass) {
        offset = Math.max(half + LANE, yes.right + LANE)
        right = Math.max(right, offset + 8)
      }
      const body = Math.max(yes.h, no.h)
      extent = {
        left,
        right,
        h: size.h + (body > 0 ? gapY + body : 0),
        ...(offset === undefined ? {} : { offset }),
      }
    }
    extents.set(item, extent)
    return extent
  }

  // ── Posiciones: cada bloque sobre su espina ──
  const positions = new Map<string, Point>()
  const placeBlock = (items: Item[], spine: number, top: number) => {
    let y = top
    for (const item of items) {
      place(item, spine, y)
      y += measure(item).h + gapY
    }
  }
  const place = (item: Item, spine: number, top: number) => {
    const size = sizeOf(item.id)
    positions.set(item.id, { x: spine - spineOf(item.id), y: top })
    if (item.kind === 'node') return
    const below = top + size.h + gapY
    placeBlock(item.yes, spine, below)
    const offset = extents.get(item)?.offset
    if (item.no.length > 0 && offset !== undefined) placeBlock(item.no, spine + offset, below)
  }

  const blocks = sections.map(measureBlock)
  const spine = Math.max(0, ...blocks.map((b) => b.left))
  let y = 0
  sections.forEach((items, i) => {
    placeBlock(items, spine, y)
    y += (blocks[i]?.h ?? 0) + gapY * SECTION_GAP
  })

  const placements: Placement[] = graph.nodes.map((node) => {
    const at = positions.get(node.id) ?? { x: 0, y: 0 }
    return {
      id: node.id,
      size: node.size,
      region: 'flow',
      row: 0,
      x: Math.round(at.x + padding),
      y: Math.round(at.y + padding),
    }
  })
  // La capa de cada paso es su puesto al bajar: lo que usa quien quiera saber qué va antes.
  const layers: Record<string, number> = {}
  ;[...placements]
    .sort((a, b) => a.y - b.y)
    .forEach((p, i) => {
      layers[p.id] = i
    })

  // A lo ancho cuenta también el carril de un «no» sin `else`, que no es ningún nodo.
  const width = Math.max(
    Math.max(0, ...placements.map((p) => p.x + p.size.w)) + padding,
    spine + Math.max(0, ...blocks.map((b) => b.right)) + padding * 2,
  )
  const height = Math.max(0, ...placements.map((p) => p.y + p.size.h)) + padding
  return {
    placements,
    regions:
      graph.nodes.length === 0
        ? []
        : [
            {
              id: 'pipeline:flow',
              topology: 'pipeline',
              strategy: 'linear',
              nodes: graph.nodes.map((n) => n.id),
              evidence: 'el orden de ejecución, leído como diagrama de flujo',
            },
          ],
    layers,
    axis: 'vertical',
    rows: 1,
    scopes: {},
    spine: Math.round(spine + padding),
    bounds: { w: Math.round(width), h: Math.round(height) },
  }
}
