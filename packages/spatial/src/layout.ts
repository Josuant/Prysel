import { classify, incoming, outgoing } from './classify.ts'
import { layoutFlowchart } from './flowchart.ts'
import {
  SCOPE_FRAME,
  type Axis,
  type LayoutResult,
  type Placement,
  type Point,
  type Region,
  type Relation,
  type SemanticGraph,
  type SemanticNode,
  type Size,
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

/** Lo que mide de largo una fila antes de plegar a la siguiente, si no se dice otra cosa. */
export const DEFAULT_MAX_RUN = 1680

const DEFAULTS = {
  gapX: 76,
  gapY: 32,
  padding: 28,
  axis: 'horizontal' as Axis,
  maxRun: DEFAULT_MAX_RUN,
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

/** Un plano sin ámbitos: todos los nodos se colocan a la vez, en una sola superficie. */
function layoutFlat(graph: SemanticGraph, options: LayoutOptions): LayoutResult {
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
    scopes: {},
    bounds: {
      w: extent.w + (axis === 'vertical' ? feedbackRoom : 0),
      h: extent.h + (axis === 'horizontal' ? feedbackRoom : 0),
    },
  }
}

/**
 * Los ámbitos del grafo: un nodo de abstracción que tiene nodos dentro es un territorio.
 * Devuelve, para cada uno, todo lo que le pertenece — el cuerpo entero, a cualquier profundidad
 * (las ramas de un `if`, el cuerpo de un bucle) — salvo lo que pertenece a otro ámbito anidado.
 *
 * Cada nodo es de **su ámbito más interno**: se decide por tamaño, no por el orden del grafo,
 * así que el resultado no depende de cómo declare el analizador lo que contiene.
 */
function findScopes(graph: SemanticGraph): Map<string, string[]> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))

  /** Todo lo que un nodo abarca, siguiendo `contains` hacia abajo. */
  const reach = (root: string): Set<string> => {
    const found = new Set<string>()
    const walk = (id: string) => {
      for (const child of byId.get(id)?.contains ?? []) {
        if (child === root || found.has(child) || !byId.has(child)) continue
        found.add(child)
        walk(child)
      }
    }
    walk(root)
    return found
  }

  const raw = new Map<string, Set<string>>()
  for (const node of graph.nodes) {
    if (node.role !== 'abstraction' && !node.territory) continue
    const inside = reach(node.id)
    if (inside.size > 0) raw.set(node.id, inside)
  }

  // De menor a mayor: el ámbito más pequeño que contiene a un nodo es el suyo.
  const owner = new Map<string, string>()
  /** ¿Es `target` dueño de `from`, directa o indirectamente? Asignarlo cerraría un ciclo. */
  const owns = (target: string, from: string): boolean => {
    for (let up = owner.get(from); up !== undefined; up = owner.get(up))
      if (up === target) return true
    return false
  }
  for (const [scope, inside] of [...raw].sort((a, b) => a[1].size - b[1].size)) {
    for (const id of inside) {
      if (owner.has(id) || id === scope || owns(id, scope)) continue
      owner.set(id, scope)
    }
  }

  const scopes = new Map<string, string[]>()
  for (const node of graph.nodes) {
    const parent = owner.get(node.id)
    if (parent === undefined) continue
    scopes.set(parent, [...(scopes.get(parent) ?? []), node.id])
  }
  // Un ámbito sin nada propio dentro no es un territorio: es un nodo más.
  return new Map(
    graph.nodes.flatMap((n) => (scopes.has(n.id) ? [[n.id, scopes.get(n.id) ?? []]] : [])),
  )
}

/**
 * Del grafo semántico a posiciones. Si el programa tiene ámbitos (funciones con cuerpo),
 * cada uno se coloca **primero por dentro**: su contenido se ordena en su propio plano y el
 * ámbito toma el tamaño que ese contenido necesita. Después el programa de fuera trata a cada
 * ámbito como un solo bloque del tamaño justo, así que nada de lo de dentro se sale ni se
 * mezcla con lo de fuera — igual que la indentación agrupa un cuerpo en el texto.
 */
export function layout(graph: SemanticGraph, options: LayoutOptions = {}): LayoutResult {
  // Leído hacia abajo, el programa es un diagrama de flujo: lo coloca su estructura, no sus capas.
  const flow = options.axis === 'vertical'
  const flat = (g: SemanticGraph, o: LayoutOptions): LayoutResult =>
    flow
      ? layoutFlowchart(g, o.padding === undefined ? {} : { padding: o.padding })
      : layoutFlat(g, o)
  const scopes = findScopes(graph)
  if (scopes.size === 0) return flat(graph, options)

  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const parentOf = new Map<string, string>()
  for (const [scope, members] of scopes) for (const id of members) parentOf.set(id, scope)
  const topOf = (id: string): string => {
    let current = id
    for (let parent = parentOf.get(current); parent; parent = parentOf.get(current)) {
      current = parent
    }
    return current
  }

  interface Frame {
    size: Size
    inner: LayoutResult
    /** Lo que mide la cabecera: el contenido empieza justo debajo. */
    top: number
    /** Lo que hay a la izquierda del contenido: el margen y, si la hay, la zona de puertos. */
    left: number
    /** Leído como diagrama de flujo: dónde cae su espina, desde su borde izquierdo. */
    spine?: number
  }
  const frames = new Map<string, Frame>()
  /** El tamaño de cada nodo tal como lo ven los de su nivel: un ámbito mide lo que abarca. */
  const sizes = new Map(graph.nodes.map((n) => [n.id, n.size]))

  // Se resuelve de dentro hacia fuera: un ámbito no sabe cuánto mide hasta conocer su contenido.
  const measure = (scope: string): Size => {
    const known = frames.get(scope)
    if (known) return known.size
    const members = new Set(scopes.get(scope))
    for (const id of members) if (scopes.has(id)) sizes.set(id, measure(id))

    const inner = flat(
      {
        nodes: [...members].flatMap((id) => {
          const node = byId.get(id)
          if (!node) return []
          // Un ámbito anidado llega ya resuelto: para su nivel es un bloque más.
          return [scopes.has(id) ? resolved(node) : node]
        }),
        edges: graph.edges.filter((e) => members.has(e.from) && members.has(e.to)),
      },
      { ...options, padding: 0 },
    )
    const own = byId.get(scope)?.size.w ?? 0
    const top = SCOPE_FRAME.top + (byId.get(scope)?.headroom ?? 0)
    let left = SCOPE_FRAME.side + (byId.get(scope)?.gutter ?? 0)
    const min = byId.get(scope)?.minSize
    const size = {
      w: Math.max(
        inner.bounds.w + left + SCOPE_FRAME.side,
        own,
        min?.w ?? 0,
        (byId.get(scope)?.headerWidth ?? 0) + left + SCOPE_FRAME.side,
      ),
      h: Math.max(
        inner.bounds.h + top + SCOPE_FRAME.bottom + (byId.get(scope)?.footroom ?? 0),
        min?.h ?? 0,
      ),
    }
    // Como diagrama de flujo, el territorio lleva su espina donde la tenga su contenido (una cadena de
    // `elif` crece a la derecha, y centrarla dejaría medio territorio vacío). Si sobra sitio, se reparte.
    let spine: number | undefined
    if (flow) {
      left += Math.max(0, Math.round((size.w - left - SCOPE_FRAME.side - inner.bounds.w) / 2))
      spine = left + (inner.spine ?? inner.bounds.w / 2)
    }
    frames.set(scope, { size, inner, top, left, ...(spine === undefined ? {} : { spine }) })
    sizes.set(scope, size)
    return size
  }
  for (const scope of scopes.keys()) measure(scope)
  /** Un ámbito ya resuelto, tal como lo ve su nivel: un bloque de su tamaño, con su espina. */
  function resolved(node: SemanticNode): SemanticNode {
    const spine = frames.get(node.id)?.spine
    return {
      ...node,
      size: sizes.get(node.id) ?? node.size,
      contains: [],
      ...(spine === undefined ? {} : { spine }),
    }
  }

  // El plano de fuera solo ve lo que no está dentro de nadie. Las conexiones que entran o
  // salen de un ámbito se recogen en su borde, y las que quedan dentro ya no cuentan aquí.
  const seen = new Set<string>()
  const outerEdges = graph.edges.flatMap((e) => {
    const from = topOf(e.from)
    const to = topOf(e.to)
    // La etiqueta cuenta: el camino «sí» y el «no» de una decisión son dos conexiones distintas.
    const key = `${from}|${to}|${e.relation}|${e.label ?? ''}`
    if (from === to || seen.has(key)) return []
    seen.add(key)
    return [
      { from, to, relation: e.relation, ...(e.label === undefined ? {} : { label: e.label }) },
    ]
  })
  const outer = flat(
    {
      nodes: graph.nodes
        .filter((n) => !parentOf.has(n.id))
        .map((n) => (scopes.has(n.id) ? resolved(n) : n)),
      edges: outerEdges,
    },
    options,
  )

  // De coordenadas relativas a absolutas, bajando por los ámbitos.
  const absolute = new Map<string, Placement>()
  const settle = (placement: Placement) => {
    absolute.set(placement.id, placement)
    const frame = frames.get(placement.id)
    if (!frame) return
    for (const child of frame.inner.placements) {
      settle({
        ...child,
        x: placement.x + frame.left + child.x,
        y: placement.y + frame.top + child.y,
      })
    }
  }
  for (const placement of outer.placements) settle(placement)

  const inners = [...frames.values()].map((f) => f.inner)
  return {
    placements: graph.nodes.flatMap((n) => {
      const placement = absolute.get(n.id)
      return placement ? [placement] : []
    }),
    regions: [...outer.regions, ...inners.flatMap((i) => i.regions)],
    layers: Object.assign({}, ...inners.map((i) => i.layers), outer.layers) as Record<
      string,
      number
    >,
    axis: outer.axis,
    rows: outer.rows,
    bounds: outer.bounds,
    scopes: Object.fromEntries(scopes),
    ...(outer.spine === undefined ? {} : { spine: outer.spine }),
    ...(flow
      ? {
          spines: Object.fromEntries(
            [...frames].flatMap(([id, frame]) =>
              frame.spine === undefined ? [] : [[id, frame.spine]],
            ),
          ),
        }
      : {}),
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

  if (options.wrap) {
    /**
     * Un salto de fila es un retorno de carro: sale por el borde, baja y vuelve a entrar
     * por el principio de la fila siguiente. Trazarlo en diagonal lo haría parecer una
     * conexión cualquiera cruzando el programa, y es justo lo contrario.
     */
    const E = 26
    const R = 14
    if (horizontal) {
      const mid = (a.y + b.y) / 2
      return (
        `M${round(a.x)} ${round(a.y)}H${round(a.x + E - R)}` +
        `A${R} ${R} 0 0 1 ${round(a.x + E)} ${round(a.y + R)}V${round(mid - R)}` +
        `A${R} ${R} 0 0 1 ${round(a.x + E - R)} ${round(mid)}H${round(b.x - E + R)}` +
        `A${R} ${R} 0 0 0 ${round(b.x - E)} ${round(mid + R)}V${round(b.y - R)}` +
        `A${R} ${R} 0 0 0 ${round(b.x - E + R)} ${round(b.y)}H${round(b.x)}`
      )
    }
    const mid = (a.x + b.x) / 2
    return (
      `M${round(a.x)} ${round(a.y)}V${round(a.y + E - R)}` +
      `A${R} ${R} 0 0 0 ${round(a.x - R)} ${round(a.y + E)}H${round(mid + R)}` +
      `A${R} ${R} 0 0 0 ${round(mid)} ${round(a.y + E - R)}V${round(b.x)}` +
      `M${round(mid)} ${round(b.y - E)}H${round(b.x)}V${round(b.y)}`
    )
  }

  if (relation === 'feedback') {
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
