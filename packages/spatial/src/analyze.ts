import { incoming } from './classify.ts'
import type { LayoutResult, Point, SemanticGraph, Size } from './types.ts'

/**
 * Medir si un diagrama se entiende.
 *
 * «¿Se lee bien?» es una opinión hasta que se mide. Estas son las propiedades que la
 * literatura de dibujo de grafos asocia a la legibilidad, y que aquí sirven de red:
 * si una se degrada al crecer el programa, el layout está fallando aunque «se vea bien»
 * en el ejemplo de seis nodos.
 */

export interface Legibility {
  nodes: number
  edges: number
  /** Pares de nodos que se pisan. Debe ser 0 siempre. */
  overlaps: number
  /** Pares de conexiones que se cruzan: la métrica clásica de legibilidad de un grafo. */
  crossings: number
  /** Cruces por conexión: lo que de verdad indica si escala. */
  crossingsPerEdge: number
  /** Conexiones de flujo que retroceden DENTRO de su fila. Solo los retornos pueden. */
  backward: number
  /**
   * Conexiones de flujo que van CONTRA el sentido de lectura: en un programa que se lee hacia abajo, las que
   * suben (`vertical`); en uno que se lee a lo ancho, las que retroceden entre filas. Debe ser 0: un paso
   * nunca puede quedar por encima del que lo precede.
   */
  against: number
  /**
   * Cuánto se aparta, de media, cada paso del eje del anterior (en el eje transversal): con 0 la secuencia es
   * una columna recta y se lee de un vistazo; cuanto más crece, más se quiebra la espina.
   */
  drift: number
  /**
   * Lo mismo, pero solo entre pasos consecutivos (las conexiones de orden): es la espina del programa. Con 0,
   * los pasos van uno bajo otro por el mismo eje, y la secuencia se lee sin seguir ningún cable.
   */
  spineDrift: number
  /** Saltos de fila: el retorno de carro del plegado. Ni son errores ni retrocesos. */
  wraps: number
  /** Filas que ocupa el programa. */
  rows: number
  /** Conexiones que saltan más de una capa: obligan al ojo a recorrer el lienzo. */
  longJumps: number
  avgEdgeLength: number
  maxEdgeLength: number
  /** Ancho / alto. Un lienzo muy apaisado o muy vertical no cabe en pantalla. */
  aspect: number
  /** Nodos en la capa más poblada: cuánto llega a crecer una columna. */
  densest: number
  /**
   * Ancho al que queda un nodo si el programa entero se encaja en una pantalla de 1920×1080.
   * Por debajo de ~90 px un nodo deja de leerse.
   */
  nodeWidthAtFit: number
  /**
   * Ancho al que queda un nodo encajando solo a lo ANCHO y recorriendo el resto hacia abajo.
   * Es la medida honesta de un lienzo plegado: un programa largo se lee como un documento,
   * no alejándose hasta verlo entero.
   */
  nodeWidthScrolling: number
  bounds: Size
}

/** Pantalla de referencia para la prueba de encaje. */
export const REFERENCE_SCREEN = { w: 1920, h: 1080 }

const centre = (p: { x: number; y: number; size: Size }): Point => ({
  x: p.x + p.size.w / 2,
  y: p.y + p.size.h / 2,
})

/** ¿Se cruzan de verdad los segmentos ab y cd? (tocarse en un extremo no cuenta). */
function crosses(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))
  const d1 = side(a, b, c)
  const d2 = side(a, b, d)
  const d3 = side(c, d, a)
  const d4 = side(c, d, b)
  return d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0 && d1 !== d2 && d3 !== d4
}

export function analyze(graph: SemanticGraph, result: LayoutResult): Legibility {
  const byId = new Map(result.placements.map((p) => [p.id, p]))
  const at = (id: string) => byId.get(id)

  let overlaps = 0
  for (let i = 0; i < result.placements.length; i++) {
    for (let j = i + 1; j < result.placements.length; j++) {
      const p = result.placements[i]
      const q = result.placements[j]
      if (!p || !q) continue
      if (
        p.x < q.x + q.size.w &&
        q.x < p.x + p.size.w &&
        p.y < q.y + q.size.h &&
        q.y < p.y + p.size.h
      ) {
        overlaps++
      }
    }
  }

  const segments = graph.edges
    .map((edge) => {
      const from = at(edge.from)
      const to = at(edge.to)
      if (!from || !to) return null
      return { edge, a: centre(from), b: centre(to) }
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)

  let crossings = 0
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const s = segments[i]
      const t = segments[j]
      if (!s || !t) continue
      // Dos conexiones que comparten nodo no "se cruzan": nacen o mueren en el mismo sitio.
      const shared =
        s.edge.from === t.edge.from ||
        s.edge.from === t.edge.to ||
        s.edge.to === t.edge.from ||
        s.edge.to === t.edge.to
      if (shared) continue
      if (crosses(s.a, s.b, t.a, t.b)) crossings++
    }
  }

  const lengths = segments.map((s) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y))
  const rowOf = (id: string) => at(id)?.row ?? 0
  const flow = segments.filter((s) => s.edge.relation !== 'feedback')
  // Un salto de fila no es un retroceso: es el retorno de carro del plegado.
  const wraps = flow.filter((s) => rowOf(s.edge.to) > rowOf(s.edge.from)).length
  // Retroceder es ir contra el eje de lectura, sea cual sea.
  const backward = flow.filter((s) =>
    result.axis === 'vertical'
      ? s.b.y < s.a.y - 0.5
      : rowOf(s.edge.from) === rowOf(s.edge.to) && s.b.x < s.a.x,
  ).length
  const vertical = result.axis === 'vertical'
  const against = flow.filter((s) =>
    vertical ? s.b.y < s.a.y - 0.5 : rowOf(s.edge.to) < rowOf(s.edge.from),
  ).length
  const offset = (s: { a: Point; b: Point }) => Math.abs(vertical ? s.b.x - s.a.x : s.b.y - s.a.y)
  const mean = (values: number[]) =>
    values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
  const drift = mean(flow.map(offset))
  const spineDrift = mean(flow.filter((s) => s.edge.relation === 'sequence').map(offset))
  const longJumps = graph.edges.filter((e) => {
    if (e.relation === 'feedback') return false
    const from = result.layers[e.from]
    const to = result.layers[e.to]
    return from !== undefined && to !== undefined && to - from > 1
  }).length

  const perLayer = new Map<number, number>()
  for (const node of graph.nodes) {
    const layer = result.layers[node.id] ?? 0
    perLayer.set(layer, (perLayer.get(layer) ?? 0) + 1)
  }

  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    overlaps,
    crossings,
    crossingsPerEdge: graph.edges.length === 0 ? 0 : crossings / graph.edges.length,
    backward,
    against,
    drift,
    spineDrift,
    wraps,
    rows: result.rows,
    longJumps,
    avgEdgeLength: lengths.length === 0 ? 0 : lengths.reduce((a, b) => a + b, 0) / lengths.length,
    maxEdgeLength: lengths.length === 0 ? 0 : Math.max(...lengths),
    aspect: result.bounds.h === 0 ? 0 : result.bounds.w / result.bounds.h,
    densest: Math.max(...perLayer.values(), 0),
    nodeWidthAtFit: Math.round(
      (result.placements[0]?.size.w ?? 0) *
        Math.min(
          1,
          REFERENCE_SCREEN.w / (result.bounds.w || 1),
          REFERENCE_SCREEN.h / (result.bounds.h || 1),
        ),
    ),
    nodeWidthScrolling: Math.round(
      (result.placements[0]?.size.w ?? 0) *
        Math.min(1, REFERENCE_SCREEN.w / (result.bounds.w || 1)),
    ),
    bounds: result.bounds,
  }
}

/** Nodos sin ninguna entrada: los puntos por donde se empieza a leer el programa. */
export function entryPoints(graph: SemanticGraph): string[] {
  return graph.nodes.filter((n) => incoming(graph, n.id).length === 0).map((n) => n.id)
}
