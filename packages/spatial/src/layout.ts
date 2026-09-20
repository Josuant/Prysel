import { classify, incoming, outgoing } from './classify.ts'
import type {
  Axis,
  LayoutResult,
  Placement,
  Point,
  Region,
  Relation,
  SemanticGraph,
  Size,
} from './types.ts'

/**
 * Del grafo semántico a posiciones. No es un `autoLayout()` genérico:
 *
 * - El **eje principal** es el orden de ejecución. Es configurable: un programa no tiene por qué
 *   leerse siempre de izquierda a derecha, y la topología decide cuál le sienta mejor.
 * - El **eje transversal** lo reparte la estrategia que la clasificación eligió para cada región.
 * - Cuando una secuencia se hace demasiado larga, **se pliega en filas**, como un texto:
 *   sin eso, un programa de doce pasos deja de caber legible en una pantalla.
 */

export interface LayoutOptions {
  /** Separación entre capas a lo largo del eje de ejecución. */
  gapX?: number
  /** Separación mínima entre dos nodos de la misma capa. */
  gapY?: number
  padding?: number
  /** Eje de lectura. `horizontal` lee como una frase; `vertical`, como una lista de pasos. */
  axis?: Axis
  /**
   * Longitud máxima antes de plegar a la fila siguiente. `0` desactiva el plegado.
   * Por defecto, una fila cabe en una pantalla: así el programa se lee al 100 % y se recorre
   * hacia abajo, como un documento, en vez de alejarse hasta que los nodos son ilegibles.
   */
  maxRun?: number
  /** Separación entre filas plegadas. */
  gapRun?: number
}

const DEFAULTS = {
  gapX: 76,
  gapY: 32,
  padding: 28,
  axis: 'horizontal' as Axis,
  maxRun: 1680,
  gapRun: 96,
}

/** Cuánto se abre cada forma. Son las constantes que dan carácter a la gramática. */
const SPREAD = {
  /** Separación entre las ramas de una decisión: tienen que verse como caminos distintos. */
  branch: 1.35,
  /** Separación entre caminos paralelos que se comparan: más juntos, para poder compararlos. */
  parallel: 1.1,
  /** Apertura del abanico de un fan-out. */
  radial: 1.2,
  /** Cuánto se retrasa en el eje principal el extremo de un abanico, para que caiga sobre un arco. */
  radialArc: 0.28,
  /** Altura del arco que describe el cuerpo de un bucle sobre su cabecera. */
  orbit: 0.55,
}

/** Hueco al final del programa para el arco de una conexión de retorno. */
const FEEDBACK_ROOM = 86

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

/** Medidas a lo largo del eje de lectura y del transversal. */
const AXIS = {
  horizontal: { main: (s: Size) => s.w, cross: (s: Size) => s.h },
  vertical: { main: (s: Size) => s.h, cross: (s: Size) => s.w },
} as const

type Offsets = Map<string, { dMain?: number; dCross?: number }>

/** Capa de cada nodo: la distancia más larga desde una fuente, siguiendo solo el flujo hacia delante. */
export function layerize(graph: SemanticGraph): Record<string, number> {
  const layers: Record<string, number> = {}
  const visiting = new Set<string>()

  const depth = (id: string): number => {
    const cached = layers[id]
    if (cached !== undefined) return cached
    if (visiting.has(id)) return 0 // ciclo ya cortado por las conexiones de retorno
    visiting.add(id)
    const preds = incoming(graph, id)
    const value = preds.length === 0 ? 0 : Math.max(...preds.map((e) => depth(e.from) + 1))
    visiting.delete(id)
    layers[id] = value
    return value
  }

  for (const node of graph.nodes) depth(node.id)
  return layers
}

function strategyOffsets(
  region: Region,
  graph: SemanticGraph,
  crossOf: (id: string) => number,
  gapY: number,
): Offsets {
  const offsets: Offsets = new Map()
  const anchor = region.anchor
  const others = region.nodes.filter((id) => id !== anchor)
  const band = (ids: string[], factor: number) => {
    const extent = Math.max(...ids.map((id) => crossOf(id)), 1)
    const step = extent * factor + gapY
    return ids.map((id, i) => ({ id, dCross: (i - (ids.length - 1) / 2) * step }))
  }

  switch (region.strategy) {
    case 'linear':
      break

    case 'tree': {
      // Las ramas salen en el orden en que las declara el programa: la primera arriba.
      const targets = anchor
        ? outgoing(graph, anchor)
            .map((e) => e.to)
            .filter((id) => others.includes(id))
        : others
      for (const { id, dCross } of band(targets, SPREAD.branch)) offsets.set(id, { dCross })
      break
    }

    case 'parallel':
      for (const { id, dCross } of band(
        others.length > 0 ? others : region.nodes,
        SPREAD.parallel,
      )) {
        offsets.set(id, { dCross })
      }
      break

    case 'radial': {
      // Los consumidores se reparten sobre un arco: todos a la misma distancia del origen.
      const spread = band(others, SPREAD.radial)
      const reach = Math.max(...spread.map((s) => Math.abs(s.dCross)), 1)
      for (const { id, dCross } of spread) {
        const t = dCross / reach
        offsets.set(id, { dCross, dMain: -Math.abs(t) * reach * SPREAD.radialArc })
      }
      break
    }

    case 'convergent': {
      // Las fuentes se abren y el destino queda en el centro: las líneas se juntan donde se juntan los datos.
      const sources = anchor
        ? incoming(graph, anchor)
            .map((e) => e.from)
            .filter((id) => others.includes(id))
        : others
      for (const { id, dCross } of band(sources, SPREAD.parallel)) offsets.set(id, { dCross })
      if (anchor) offsets.set(anchor, { dCross: 0 })
      break
    }

    case 'orbital': {
      // El cuerpo describe un arco sobre la cabecera; la conexión de retorno lo cierra por detrás.
      const body = region.nodes.filter((id) => id !== anchor)
      const extent = Math.max(...body.map((id) => crossOf(id)), 1)
      body.forEach((id, i) => {
        const t = body.length === 1 ? 0.5 : i / (body.length - 1)
        offsets.set(id, { dCross: -Math.sin(Math.PI * t) * extent * SPREAD.orbit })
      })
      break
    }

    case 'nested':
      // El contenido se coloca dentro del contenedor: lo resuelve el propio nodo, no el plano.
      for (const id of others) offsets.set(id, { dCross: 0 })
      break
  }
  return offsets
}

/** Reparte los nodos de una capa sin que se toquen, conservando su orden y su centro. */
function separate(
  ids: string[],
  cross: Record<string, number>,
  crossOf: (id: string) => number,
  gap: number,
) {
  if (ids.length < 2) return
  const sorted = [...ids].sort((a, b) => (cross[a] ?? 0) - (cross[b] ?? 0))
  const before = sorted.reduce((sum, id) => sum + (cross[id] ?? 0), 0) / sorted.length

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const curr = sorted[i]
    if (!prev || !curr) continue
    const min = (cross[prev] ?? 0) + crossOf(prev) / 2 + gap + crossOf(curr) / 2
    if ((cross[curr] ?? 0) < min) cross[curr] = min
  }
  const after = sorted.reduce((sum, id) => sum + (cross[id] ?? 0), 0) / sorted.length
  const shift = before - after
  for (const id of sorted) cross[id] = (cross[id] ?? 0) + shift
}

export function layout(graph: SemanticGraph, options: LayoutOptions = {}): LayoutResult {
  const { gapX, gapY, padding, axis, maxRun, gapRun } = { ...DEFAULTS, ...options }
  const metrics = AXIS[axis]
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const sizeOf = (id: string): Size => byId.get(id)?.size ?? { w: 0, h: 0 }
  const mainOf = (id: string) => metrics.main(sizeOf(id))
  const crossOf = (id: string) => metrics.cross(sizeOf(id))

  const layers = layerize(graph)
  const regions = classify(graph)
  const layerIds = [...new Set(Object.values(layers))].sort((a, b) => a - b)
  const inLayer = (layer: number) => graph.nodes.filter((n) => layers[n.id] === layer)

  // ── Eje de ejecución, plegado en filas ──
  // Una secuencia larga se lee como un texto: cuando la línea se acaba, salta a la siguiente.
  const layerMain: Record<number, number> = {}
  const layerRun: Record<number, number> = {}
  let cursor = 0
  let run = 0
  for (const layer of layerIds) {
    const widest = Math.max(...inLayer(layer).map((n) => mainOf(n.id)), 0)
    if (maxRun > 0 && cursor > 0 && cursor + widest > maxRun) {
      run++
      cursor = 0
    }
    layerMain[layer] = cursor
    layerRun[layer] = run
    cursor += widest + gapX
  }

  // ── Eje transversal: la estrategia de cada región, y después el resto por baricentro ──
  const cross: Record<string, number> = {}
  const dMain: Record<string, number> = {}
  const fixed = new Set<string>()
  // Un empujón sobre el eje principal no puede comerse el hueco entre capas.
  const maxNudge = Math.max(0, gapX - 16)
  for (const region of regions) {
    const offsets = strategyOffsets(region, graph, crossOf, gapY)
    const anchorCross = region.anchor ? (cross[region.anchor] ?? 0) : 0
    for (const [id, off] of offsets) {
      cross[id] = anchorCross + (off.dCross ?? 0)
      if (off.dMain !== undefined) dMain[id] = clamp(off.dMain, -maxNudge, maxNudge)
      fixed.add(id)
    }
  }

  // Los nodos sin posición propia siguen a sus vecinos: así una rama arrastra a su descendencia.
  for (let pass = 0; pass < 4; pass++) {
    for (const node of graph.nodes) {
      if (fixed.has(node.id)) continue
      const neighbours = [
        ...incoming(graph, node.id).map((e) => e.from),
        ...outgoing(graph, node.id).map((e) => e.to),
      ]
      const known = neighbours.map((id) => cross[id]).filter((v): v is number => v !== undefined)
      cross[node.id] = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : 0
    }
  }

  for (const layer of layerIds) {
    separate(
      inLayer(layer).map((n) => n.id),
      cross,
      crossOf,
      gapY,
    )
  }

  // ── Las filas se apilan una debajo de otra, cada una centrada en sí misma ──
  const runs = [...new Set(Object.values(layerRun))].sort((a, b) => a - b)
  const runOffset: Record<number, number> = {}
  let runCursor = 0
  for (const r of runs) {
    const ids = graph.nodes.filter((n) => layerRun[layers[n.id] ?? 0] === r).map((n) => n.id)
    const min = Math.min(...ids.map((id) => (cross[id] ?? 0) - crossOf(id) / 2))
    const max = Math.max(...ids.map((id) => (cross[id] ?? 0) + crossOf(id) / 2))
    runOffset[r] = runCursor - min
    runCursor += max - min + gapRun
  }

  // ── A coordenadas absolutas ──
  const regionOf = new Map<string, string>()
  for (const region of regions) for (const id of region.nodes) regionOf.set(id, region.id)

  const placements: Placement[] = graph.nodes.map((node) => {
    const layer = layers[node.id] ?? 0
    const row = layerRun[layer] ?? 0
    const main = (layerMain[layer] ?? 0) + (dMain[node.id] ?? 0)
    // La estrategia razona con centros; el lienzo dibuja desde la esquina superior izquierda.
    const crossValue = (cross[node.id] ?? 0) - crossOf(node.id) / 2 + (runOffset[row] ?? 0)
    const [x, y] = axis === 'horizontal' ? [main, crossValue] : [crossValue, main]
    return {
      id: node.id,
      size: node.size,
      region: regionOf.get(node.id) ?? 'pipeline',
      row,
      x: Math.round(x + padding),
      y: Math.round(y + padding),
    }
  })

  // Un retorno se dibuja por detrás de todo: el lienzo tiene que reservarle sitio.
  const feedbackRoom = graph.edges.some((e) => e.relation === 'feedback') ? FEEDBACK_ROOM : 0
  const extent = {
    w: Math.round(Math.max(...placements.map((p) => p.x + p.size.w), 0) + padding),
    h: Math.round(Math.max(...placements.map((p) => p.y + p.size.h), 0) + padding),
  }

  return {
    placements,
    regions,
    layers,
    axis,
    rows: runs.length,
    bounds: {
      w: extent.w + (axis === 'vertical' ? feedbackRoom : 0),
      h: extent.h + (axis === 'horizontal' ? feedbackRoom : 0),
    },
  }
}

/**
 * El trazado de una conexión. La curvatura no es estética: dice qué clase de relación es.
 * Una dependencia va directa; un retorno se va por detrás, porque va contra el tiempo;
 * un salto de fila barre hacia atrás, como el retorno de carro de un texto.
 */
export function routeEdge(
  a: Point,
  b: Point,
  relation: Relation,
  options: { detour?: number; axis?: Axis; wrap?: boolean } = {},
): string {
  const round = (v: number) => Math.round(v * 10) / 10
  const axis = options.axis ?? 'horizontal'
  const horizontal = axis === 'horizontal'

  if (relation === 'feedback' || options.wrap) {
    const detour = options.detour ?? 110
    const [c1, c2] = horizontal
      ? [
          { x: a.x + 70, y: a.y + detour },
          { x: b.x - 70, y: b.y + detour },
        ]
      : [
          { x: a.x + detour, y: a.y + 70 },
          { x: b.x + detour, y: b.y - 70 },
        ]
    return (
      `M${round(a.x)} ${round(a.y)}` +
      `C${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(b.x)} ${round(b.y)}`
    )
  }

  // Una referencia apenas se curva: no transporta un dato, solo alude a algo.
  const strength = relation === 'reference' ? 0.25 : 0.5
  const span = horizontal ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y)
  const d = clamp(span * strength, 36, 180)
  const [c1, c2] = horizontal
    ? [
        { x: a.x + d, y: a.y },
        { x: b.x - d, y: b.y },
      ]
    : [
        { x: a.x, y: a.y + d },
        { x: b.x, y: b.y - d },
      ]
  return (
    `M${round(a.x)} ${round(a.y)}` +
    `C${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(b.x)} ${round(b.y)}`
  )
}
