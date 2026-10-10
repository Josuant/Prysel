import type { Point, Size } from './types.ts'

/**
 * La **arquitectura** de un programa: sus módulos (las etapas de primer nivel) colocados en el plano según
 * cómo se relacionan, no según el orden en que están escritos.
 *
 * Una lista de pasos dice en qué orden se ejecuta algo; no dice cómo funciona. Aquí cada programa se mira
 * como un grafo de módulos unidos por dos clases de relación —un **dato** que pasa de uno a otro, y uno que
 * **usa** (llama) a otro— y se busca la forma que mejor lo cuenta: una tubería, un centro con satélites, un
 * ciclo, unas capas.
 *
 * Las formas son un catálogo cerrado. Cada una **se comprueba contra el grafo** (`shapeCandidates`): solo se
 * ofrece la que el programa tiene de verdad. Entre las que cuadran elige quien llama (el JEV; sin él, la
 * primera). `capas` cuadra siempre: es la que queda cuando ninguna otra dice más.
 *
 * Cada forma trae su **figura auxiliar** (un anillo, unas bandas, un carril): un dibujo de fondo que dice la
 * forma antes de leer una sola flecha.
 */

/** El papel de un módulo en el programa. */
export type ModuleRole = 'entrada' | 'datos' | 'logica' | 'control' | 'salida'

export const MODULE_ROLES: readonly ModuleRole[] = [
  'entrada',
  'datos',
  'logica',
  'control',
  'salida',
]

export type ArchShape = 'capas' | 'tuberia' | 'centro' | 'ciclo' | 'embudo' | 'abanico'

export interface ArchModule {
  id: string
  role: ModuleRole
  /** Repite algo: es (o contiene, en su primer nivel) un bucle. */
  loop?: boolean
  /** Decide entre varios caminos (un menú que elige qué hacer). */
  branches?: boolean
}

/**
 * Una relación entre dos módulos. `data`: `from` deja un valor que `to` usa. `call`: `from` usa (llama) algo
 * que `to` define. `planned`: aún no está en el código; lo propuso el plan.
 */
export interface ArchLink {
  from: string
  to: string
  /** `next`: después de `from` viene `to` (el orden de los pasos, cuando entre ellos no viaja ningún dato). */
  kind: 'data' | 'call' | 'next'
  /** El nombre de lo que pasa (`gastos`) o de lo que se usa (`calcular_total`). */
  label?: string
  planned?: boolean
  /** Sale de la ejecución (un paso de la historia), no del análisis del texto: se dibuja siempre. */
  told?: boolean
}

/** Los módulos, en el orden del programa, y lo que los une. */
export interface ArchGraph {
  modules: readonly ArchModule[]
  links: readonly ArchLink[]
}

/** Una forma que el grafo tiene de verdad, con el módulo que la ancla (el centro, la cabeza del ciclo). */
export interface ShapeCandidate {
  shape: ArchShape
  anchor?: string
}

export interface Architecture extends ArchGraph, ShapeCandidate {
  /**
   * En un ciclo: los módulos de cada vuelta, **en el orden en que pasan** (sin la cabeza, que es `anchor`).
   * Sale de la ejecución; con él, el anillo no se reordena. Sin él, el anillo lo forman los módulos a los que
   * llama la cabeza.
   */
  order?: readonly string[]
  /** En un ciclo: lo que se dice en su centro (cuántas vueltas dio). */
  caption?: string
}

/** Un dibujo de fondo que dice la forma: no es un módulo ni una flecha. */
export interface Figure {
  id: string
  /**
   * Las de la forma, y tres marcas que se apoyan en un módulo: `start` (dónde empieza el trabajo), `gate`
   * (por dónde y cómo se sale de lo que se repite) y `spot` (dónde está ahora, al reproducirlo).
   */
  kind: 'ring' | 'band' | 'spokes' | 'track' | 'funnel' | 'fan' | 'start' | 'gate' | 'spot'
  x: number
  y: number
  w: number
  h: number
  label?: string
  /** En un embudo: lo que mide su boca estrecha (la ancha es `w`). */
  narrow?: number
}

export interface ArchLayout {
  positions: Map<string, Point>
  figures: Figure[]
  bounds: Size
}

/** Los vecinos distintos de un módulo por una clase de relación y un sentido. */
function neighbours(graph: ArchGraph, id: string, kind: ArchLink['kind'], way: 'out' | 'in') {
  const found = new Set<string>()
  for (const link of graph.links) {
    if (link.kind !== kind || link.from === link.to) continue
    if (way === 'out' && link.from === id) found.add(link.to)
    if (way === 'in' && link.to === id) found.add(link.from)
  }
  return found
}

/**
 * Las formas que el grafo tiene de verdad, de la que más dice a la que menos. `capas` va siempre la última.
 *
 * - **ciclo**: un módulo que repite y, en cada vuelta, usa a otros dos o más.
 * - **centro**: un módulo que usa a tres o más de los demás (un menú, un despachador).
 * - **tubería**: cada módulo le pasa un dato al siguiente, de principio a fin, sin que nadie mande.
 * - **embudo**: dos o más módulos le pasan lo suyo a uno, que lo junta o lo resume.
 * - **abanico**: un módulo cuyos datos usan tres o más de los demás, sin que nadie mande.
 */
export function shapeCandidates(graph: ArchGraph): ShapeCandidate[] {
  const { modules } = graph
  const found: ShapeCandidate[] = []
  if (modules.length >= 3) {
    const byCalls = [...modules].sort(
      (a, b) =>
        neighbours(graph, b.id, 'call', 'out').size - neighbours(graph, a.id, 'call', 'out').size,
    )
    const loop = byCalls.find(
      (module) => module.loop === true && neighbours(graph, module.id, 'call', 'out').size >= 2,
    )
    const hub = byCalls.find((module) => neighbours(graph, module.id, 'call', 'out').size >= 3)
    const store = [...modules]
      .sort(
        (a, b) =>
          neighbours(graph, b.id, 'data', 'out').size - neighbours(graph, a.id, 'data', 'out').size,
      )
      .find((module) => neighbours(graph, module.id, 'data', 'out').size >= 3)
    const cycle: ShapeCandidate[] = loop ? [{ shape: 'ciclo', anchor: loop.id }] : []
    const centre: ShapeCandidate[] = hub ? [{ shape: 'centro', anchor: hub.id }] : []
    // Un bucle que elige entre varios caminos (un menú) se cuenta mejor como un centro; uno que hace todos
    // sus pasos en cada vuelta (un juego), como un ciclo.
    found.push(...(loop?.branches ? [...centre, ...cycle] : [...cycle, ...centre]))
    const chained = modules.every((module, at) => {
      const next = modules[at + 1]
      return next === undefined || neighbours(graph, module.id, 'data', 'out').has(next.id)
    })
    if (chained && !hub) found.push({ shape: 'tuberia' })
    // Sin nadie que mande: lo que converge en uno es un embudo; lo que sale de uno hacia muchos, un abanico.
    const sink = [...modules]
      .sort(
        (a, b) =>
          neighbours(graph, b.id, 'data', 'in').size - neighbours(graph, a.id, 'data', 'in').size,
      )
      .find((module) => neighbours(graph, module.id, 'data', 'in').size >= 2)
    if (sink && !hub && !loop && !chained) found.push({ shape: 'embudo', anchor: sink.id })
    if (store && !hub && !loop) found.push({ shape: 'abanico', anchor: store.id })
  }
  return [...found, { shape: 'capas' }]
}

/** La forma con la que se queda quien no puede preguntar: la que más dice de las que cuadran. */
export function defaultShape(graph: ArchGraph): ShapeCandidate {
  return shapeCandidates(graph)[0] ?? { shape: 'capas' }
}

// ───────────────────────── la colocación ─────────────────────────

/** El aire entre dos módulos: a lo ancho cabe la pastilla con el nombre del dato que pasa. */
const GAP = { x: 88, y: 76 }
const PAD = 28
/** Lo que mide una fila de módulos si nadie dice cuánto hay: una pantalla grande. */
const DEFAULT_WIDTH = 1400

const BAND_LABEL: Record<'control' | 'proceso' | 'datos', string> = {
  control: 'Quién manda',
  proceso: 'Lo que hace',
  datos: 'Lo que guarda',
}

interface Box {
  id: string
  /** El centro. */
  x: number
  y: number
  w: number
  h: number
}

/** El zoom al que un plano de ese tamaño cabe entero en un lienzo. */
export function fitZoom(bounds: Size, frame: Size, pad = 24): number {
  return Math.min(
    (frame.w - pad * 2) / Math.max(1, bounds.w),
    (frame.h - pad * 2) / Math.max(1, bounds.h),
  )
}

/** Lo que separa la arquitectura de su **cola** (lo que sale al final: el resultado). */
export const TAIL_GAP = { x: 110, y: 56 }

/** Lo que ocupa la arquitectura con su cola a la derecha o debajo. */
export function withTail(bounds: Size, tail: Size, side: 'right' | 'bottom'): Size {
  return side === 'right'
    ? { w: bounds.w + TAIL_GAP.x + tail.w, h: Math.max(bounds.h, tail.h + PAD * 2) }
    : { w: Math.max(bounds.w, tail.w + PAD * 2), h: bounds.h + TAIL_GAP.y + tail.h }
}

/**
 * Dónde va la cola: a la derecha (se lee «y al final, esto») salvo que debajo el conjunto se vea claramente
 * más grande en ese lienzo (uno estrecho, o un diagrama ya muy ancho).
 */
export function tailSide(bounds: Size, tail: Size, frame: Size | undefined): 'right' | 'bottom' {
  if (!frame) return 'right'
  const right = fitZoom(withTail(bounds, tail, 'right'), frame)
  const bottom = fitZoom(withTail(bounds, tail, 'bottom'), frame)
  return Math.min(1, bottom) > Math.min(1, right) * 1.08 ? 'bottom' : 'right'
}

const overlap = (a: Box, b: Box, margin: number) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 + margin && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + margin

/** Hasta cuántos satélites se prueban todos los repartos alrededor de un centro. */
const SEARCH_MAX = 6

/** ¿Pasa por encima de `box` la recta que une los centros de `from` y `to`? */
function hits(from: Box, to: Box, box: Box): boolean {
  for (let step = 1; step < 20; step++) {
    const t = step / 20
    const x = from.x + (to.x - from.x) * t
    const y = from.y + (to.y - from.y) * t
    if (Math.abs(x - box.x) < box.w / 2 + 6 && Math.abs(y - box.y) < box.h / 2 + 6) return true
  }
  return false
}

/** Cuántas de esas flechas, tiradas rectas de centro a centro, pasan por encima de un módulo que no es suyo. */
function crossings(boxes: readonly Box[], links: readonly ArchLink[]): number {
  const at = new Map(boxes.map((box) => [box.id, box]))
  return links.filter((link) => {
    const from = at.get(link.from)
    const to = at.get(link.to)
    if (!from || !to || from === to) return false
    return boxes.some((box) => box !== from && box !== to && hits(from, to, box))
  }).length
}

/** Todas las maneras de ordenar unos pocos elementos. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]]
  return items.flatMap((item, at) =>
    permutations([...items.slice(0, at), ...items.slice(at + 1)]).map((rest) => [item, ...rest]),
  )
}

/** Si dos módulos se pisan (o se quedan sin aire), se abren todos desde el centro hasta que no. */
function spread(boxes: Box[], centre: Point, margin: number) {
  for (let round = 0; round < 24; round++) {
    const touching = boxes.some((a, i) => boxes.slice(i + 1).some((b) => overlap(a, b, margin)))
    if (!touching) return
    for (const box of boxes) {
      box.x = centre.x + (box.x - centre.x) * 1.12
      box.y = centre.y + (box.y - centre.y) * 1.12
    }
  }
}

/** Una fila de módulos, de izquierda a derecha, centrada en `cx` y con su parte de arriba en `top`. */
function row(ids: readonly string[], sizeOf: (id: string) => Size, cx: number, top: number): Box[] {
  const width = ids.reduce((sum, id) => sum + sizeOf(id).w, 0) + GAP.x * Math.max(0, ids.length - 1)
  const height = Math.max(0, ...ids.map((id) => sizeOf(id).h))
  let x = cx - width / 2
  return ids.map((id) => {
    const size = sizeOf(id)
    const box = { id, x: x + size.w / 2, y: top + height / 2, w: size.w, h: size.h }
    x += size.w + GAP.x
    return box
  })
}

const heightOf = (boxes: readonly Box[]) => Math.max(0, ...boxes.map((box) => box.h))

/**
 * Los módulos repartidos sobre una elipse, en el sentido del reloj y empezando por arriba. La elipse es más
 * alta que ancha para lo que mide una tarjeta (que es apaisada): así el de arriba y el de al lado se libran
 * por la altura y el anillo no se estira a lo ancho. Si aun así se pisan, `spread` lo abre.
 */
function ring(ids: readonly string[], sizeOf: (id: string) => Size): Box[] {
  const sizes = ids.map(sizeOf)
  const rx = Math.max(120, ...sizes.map((size) => size.w)) * 0.68
  const ry = Math.max(60, ...sizes.map((size) => size.h)) + 44
  return ids.map((id, at) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * at) / ids.length
    const size = sizeOf(id)
    return { id, x: Math.cos(angle) * rx, y: Math.sin(angle) * ry, w: size.w, h: size.h }
  })
}

/** Entre dos pasos seguidos del anillo que van uno al lado del otro: cabe la pastilla de lo que se pasan. */
const RING_GAP_X = 124
/** Lo alto que se prueba el anillo, sobre lo mínimo: de apaisado a bien alto. */
const RING_TALL = [1, 1.4, 1.8, 2.3, 2.9, 3.6]

/**
 * El anillo a esa altura, **lo más estrecho que se pueda**: cada módulo en su ángulo, y la elipse tan cerrada
 * a lo ancho como deje que ninguno pise a otro y que entre dos seguidos quede el tramo de su flecha (con su
 * pastilla, si van uno al lado del otro). Un anillo alto y estrecho cabe más grande en un lienzo que no es
 * muy apaisado. `null` si a esa altura no hay manera.
 */
function ringAt(ids: readonly string[], sizeOf: (id: string) => Size, ry: number): Box[] | null {
  const count = ids.length
  const gapX = (a: Box, b: Box) => Math.abs(a.x - b.x) - (a.w + b.w) / 2
  const gapY = (a: Box, b: Box) => Math.abs(a.y - b.y) - (a.h + b.h) / 2
  const clear = (boxes: readonly Box[]) =>
    boxes.every((a, i) =>
      boxes.every((b, j) => {
        if (j <= i) return true
        const next = j === i + 1 || (i === 0 && j === count - 1)
        // Seguidos: sitio para la flecha (en vertical) o para la flecha con su pastilla (en horizontal).
        return next
          ? gapY(a, b) >= 44 || gapX(a, b) >= RING_GAP_X
          : gapY(a, b) >= 20 || gapX(a, b) >= 28
      }),
    )
  for (let rx = 0; rx <= 1400; rx += 8) {
    const boxes = ids.map((id, at) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * at) / count
      const size = sizeOf(id)
      return { id, x: Math.cos(angle) * rx, y: Math.sin(angle) * ry, w: size.w, h: size.h }
    })
    if (clear(boxes)) return boxes
  }
  return null
}

/** El rectángulo que abarca unos módulos, por sus centros (para un anillo) o por sus bordes. */
function frame(boxes: readonly Box[], by: 'centre' | 'edge') {
  const half = (box: Box, axis: 'w' | 'h') => (by === 'edge' ? box[axis] / 2 : 0)
  const left = Math.min(...boxes.map((box) => box.x - half(box, 'w')))
  const right = Math.max(...boxes.map((box) => box.x + half(box, 'w')))
  const top = Math.min(...boxes.map((box) => box.y - half(box, 'h')))
  const bottom = Math.max(...boxes.map((box) => box.y + half(box, 'h')))
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/**
 * Dónde va cada módulo y qué figuras lo acompañan. Mide con los tamaños que se le dan (los de verdad), así
 * que un módulo abierto en su sitio empuja a los demás en vez de taparlos. Los módulos de la arquitectura que
 * no tengan tamaño (no se dibujan) se ignoran.
 */
export function layoutArchitecture(
  architecture: Architecture,
  sizes: ReadonlyMap<string, Size>,
  options: {
    /** Lo más ancho que puede ser una fila de módulos: a partir de ahí, se parte en dos (como un texto). */
    maxWidth?: number
    /**
     * El lienzo en el que se va a ver. Con él, donde la forma admite varias colocaciones (el ciclo: más alto
     * o más ancho, con lo de antes a su izquierda o encima), se queda con la que se ve más grande ahí.
     */
    frame?: Size
    /** Lo que irá a la cola (el resultado): cuenta para saber cuánto cabe. */
    tail?: Size
  } = {},
): ArchLayout {
  const maxWidth = options.maxWidth ?? DEFAULT_WIDTH
  const modules = architecture.modules.filter((module) => sizes.has(module.id))
  const sizeOf = (id: string): Size => sizes.get(id) ?? { w: 0, h: 0 }
  const ids = modules.map((module) => module.id)
  const anchor = modules.find((module) => module.id === architecture.anchor)?.id
  const of = (role: ModuleRole) => modules.filter((m) => m.role === role).map((m) => m.id)
  let boxes: Box[] = []
  const figures: Figure[] = []
  /** Los módulos en filas que caben en el ancho que hay: cada fila, los que entren (uno al menos). */
  const packed = (line: readonly string[], limit = maxWidth): string[][] => {
    const rows: string[][] = []
    let width = 0
    for (const id of line) {
      const own = sizeOf(id).w
      const last = rows[rows.length - 1]
      if (last && width + GAP.x + own <= limit) {
        last.push(id)
        width += GAP.x + own
      } else {
        rows.push([id])
        width = own
      }
    }
    return rows
  }

  const layers = () => {
    // Por papel: quién manda arriba; en medio, lo que entra → lo que se hace → lo que sale; abajo, los datos.
    const bands: { key: keyof typeof BAND_LABEL; rows: string[][] }[] = [
      { key: 'control', rows: packed(of('control')) },
      {
        key: 'proceso',
        rows: packed([...of('entrada'), ...of('logica'), ...of('salida')]),
      },
      { key: 'datos', rows: packed(of('datos')) },
    ]
    let top = 0
    const placed: { key: keyof typeof BAND_LABEL; boxes: Box[] }[] = []
    for (const band of bands) {
      if (band.rows.length === 0) continue
      const own: Box[] = []
      for (const line of band.rows) {
        const made = row(line, sizeOf, 0, top)
        own.push(...made)
        top += heightOf(made) + GAP.y * 0.6
      }
      top += GAP.y * 0.9
      placed.push({ key: band.key, boxes: own })
    }
    boxes = placed.flatMap((band) => band.boxes)
    // Las bandas solo dicen algo si hay más de una.
    if (placed.length > 1) {
      const all = frame(boxes, 'edge')
      for (const band of placed) {
        const own = frame(band.boxes, 'edge')
        figures.push({
          id: `band:${band.key}`,
          kind: 'band',
          x: all.x - 28,
          y: own.y - 26,
          w: all.w + 56,
          h: own.h + 44,
          label: BAND_LABEL[band.key],
        })
      }
    }
  }

  if (architecture.shape === 'tuberia') {
    let top = 0
    for (const line of packed(ids)) {
      const made = row(line, sizeOf, 0, top)
      boxes.push(...made)
      const own = frame(made, 'centre')
      figures.push({
        id: `track:${figures.length}`,
        kind: 'track',
        x: own.x,
        y: own.y - 9,
        w: own.w,
        h: 18,
      })
      top += heightOf(made) + GAP.y
    }
  } else if (architecture.shape === 'centro' && anchor !== undefined) {
    // Alrededor del centro, en filas por encima y por debajo: así el conjunto queda compacto y cada radio es
    // corto. Arriba, lo que entra y lo que manda; abajo, lo que sale y lo que se guarda.
    const ORDER: ModuleRole[] = ['entrada', 'control', 'logica', 'salida', 'datos']
    const around = ORDER.flatMap((role) => of(role)).filter((id) => id !== anchor)
    const centre = sizeOf(anchor)
    const half = Math.ceil(around.length / 2)
    /** Unas filas apiladas desde el centro hacia arriba (`-1`) o hacia abajo (`1`). */
    const stack = (lines: string[][], way: 1 | -1): Box[] => {
      const placed: Box[] = []
      let edge = centre.h / 2 + GAP.y
      for (const line of way === 1 ? lines : [...lines].reverse()) {
        const made = row(line, sizeOf, 0, 0)
        const tall = heightOf(made)
        for (const box of made) box.y += way === 1 ? edge : -(edge + tall)
        placed.push(...made)
        edge += tall + GAP.y * 0.6
      }
      return placed
    }
    const place = (order: readonly string[], above: number): Box[] => [
      ...stack(packed(order.slice(0, above)), -1),
      ...stack(packed(order.slice(above)), 1),
    ]
    // Dos satélites que se pasan algo entre sí no deberían tener el centro en medio: se busca el reparto
    // (quién arriba, quién abajo y en qué orden) en el que menos flechas entre satélites cruzan a alguien.
    // Entre los que empatan, el más parejo y el que menos se aparta del orden por papeles.
    const between = architecture.links.filter(
      (link) => around.includes(link.from) && around.includes(link.to) && link.from !== link.to,
    )
    let satellites = place(around, half)
    if (between.length > 0 && around.length <= SEARCH_MAX) {
      const hub: Box = { id: anchor, x: 0, y: 0, w: centre.w, h: centre.h }
      const crossed = (boxes: readonly Box[]) => {
        const at = new Map(boxes.map((box) => [box.id, box]))
        return between.filter((link) => {
          const from = at.get(link.from)
          const to = at.get(link.to)
          if (!from || !to) return false
          const others = [hub, ...boxes.filter((box) => box !== from && box !== to)]
          return others.some((box) => hits(from, to, box))
        }).length
      }
      let best = { cost: crossed(satellites), uneven: 0, moved: 0 }
      for (const order of permutations(around)) {
        const moved = order.reduce((sum, id, at) => sum + Math.abs(at - around.indexOf(id)), 0)
        for (let above = 1; above < order.length; above++) {
          const boxes = place(order, above)
          const tried = { cost: crossed(boxes), uneven: Math.abs(above - half), moved }
          const better =
            tried.cost !== best.cost
              ? tried.cost < best.cost
              : tried.uneven !== best.uneven
                ? tried.uneven < best.uneven
                : tried.moved < best.moved
          if (better) {
            best = tried
            satellites = boxes
          }
        }
      }
    }
    boxes = [{ id: anchor, x: 0, y: 0, w: centre.w, h: centre.h }, ...satellites]
    const halo = frame(satellites, 'centre')
    figures.push({ id: 'spokes', kind: 'spokes', ...halo })
  } else if (architecture.shape === 'ciclo' && anchor !== undefined) {
    // En el anillo, la cabeza del ciclo y lo que usa en cada vuelta, en su orden; lo demás (lo que se prepara
    // antes) espera a su izquierda.
    const used = new Set(
      architecture.links
        .filter((link) => link.kind === 'call' && link.from === anchor)
        .map((link) => link.to),
    )
    // Si se sabe en qué orden pasan de verdad, ese es el anillo (y no se toca); si no, a quién llama la cabeza.
    const told = architecture.order?.filter((id) => ids.includes(id) && id !== anchor)
    const fixed = told !== undefined && told.length > 0
    const turning = fixed ? told : ids.filter((id) => used.has(id) && id !== anchor)
    const waiting = ids.filter((id) => id !== anchor && !turning.includes(id))
    /**
     * El anillo con ese orden y los que esperan en ese otro: a su izquierda, en columna, o encima, en filas.
     * `tall`: lo alto que es el anillo sobre lo mínimo (`null`: el apaisado de siempre).
     */
    const place = (
      ringOrder: readonly string[],
      columnOrder: readonly string[],
      tall: number | null = null,
      side: 'left' | 'top' = 'left',
    ) => {
      const members = [anchor, ...ringOrder]
      const lowest = Math.max(60, ...members.map((id) => sizeOf(id).h)) + 44
      let circle = tall === null ? null : ringAt(members, sizeOf, lowest * tall)
      if (!circle) {
        circle = ring(members, sizeOf)
        spread(circle, { x: 0, y: 0 }, 28)
      }
      const edge = frame(circle, 'edge')
      const column: Box[] = []
      if (side === 'top') {
        // Encima, en filas no más anchas que el anillo: así no lo ensanchan.
        const lines = packed(columnOrder, Math.max(edge.w, 520))
        let bottom = edge.y - GAP.y * 0.8
        for (const line of [...lines].reverse()) {
          const made = row(line, sizeOf, edge.x + edge.w / 2, 0)
          const high = heightOf(made)
          for (const box of made) box.y += bottom - high
          column.push(...made)
          bottom -= high + GAP.y * 0.6
        }
        return { circle, column }
      }
      let top = 0
      for (const id of columnOrder) {
        const size = sizeOf(id)
        column.push({ id, x: 0, y: top + size.h / 2, w: size.w, h: size.h })
        top += size.h + GAP.y * 0.7
      }
      // Arriba, a la altura de la cabeza del ciclo: es a ella a quien le dan lo suyo, y así su flecha no
      // cruza el anillo.
      const wide = Math.max(0, ...column.map((box) => box.w))
      for (const box of column) {
        box.x = edge.x - GAP.x - wide / 2
        box.y += edge.y
      }
      return { circle, column }
    }
    const searchable =
      (fixed || turning.length <= SEARCH_MAX - 1) &&
      waiting.length <= 4 &&
      architecture.links.length > 0
    const moved = (order: readonly string[], from: readonly string[]) =>
      order.reduce((sum, id, at) => sum + Math.abs(at - from.indexOf(id)), 0)
    /**
     * Con esa geometría, el orden: el del programa manda, salvo que con otro haya menos flechas pasando por
     * encima de un módulo. Se prueban los órdenes del anillo y de los que esperan y se queda el que menos
     * cruza (y, entre esos, el que menos se aparta del orden del programa).
     */
    const arranged = (tall: number | null, side: 'left' | 'top') => {
      let found = place(turning, waiting, tall, side)
      let least = {
        cost: crossings([...found.circle, ...found.column], architecture.links),
        moved: 0,
      }
      if (searchable) {
        for (const ringOrder of fixed ? [turning] : permutations(turning)) {
          for (const columnOrder of permutations(waiting)) {
            if (least.cost === 0) break
            const tried = place(ringOrder, columnOrder, tall, side)
            const got = {
              cost: crossings([...tried.circle, ...tried.column], architecture.links),
              moved: moved(ringOrder, turning) + moved(columnOrder, waiting),
            }
            if (got.cost < least.cost || (got.cost === least.cost && got.moved < least.moved)) {
              least = got
              found = tried
            }
          }
        }
      }
      return { ...found, cost: least.cost }
    }
    let best: { circle: Box[]; column: Box[] } = arranged(null, 'left')
    const room = options.frame
    if (room) {
      // Con el lienzo a la vista: de las colocaciones posibles, la que se ve más grande en él (contando el
      // resultado, a su lado o debajo). Una flecha que cruza a un módulo resta; y a igualdad, la de siempre.
      const scoreOf = (tried: { circle: Box[]; column: Box[]; cost: number }) => {
        const all = frame([...tried.circle, ...tried.column], 'edge')
        // Con sus márgenes, y el sitio de la marca de salida sobre la cabeza del ciclo.
        const bounds = { w: all.w + PAD * 2, h: all.h + PAD * 2 + 26 }
        const zoom = options.tail
          ? Math.max(
              fitZoom(withTail(bounds, options.tail, 'right'), room),
              fitZoom(withTail(bounds, options.tail, 'bottom'), room),
            )
          : fitZoom(bounds, room)
        return Math.min(1, zoom) * 0.88 ** tried.cost
      }
      let top = scoreOf(best as { circle: Box[]; column: Box[]; cost: number })
      for (const side of waiting.length > 0 ? (['left', 'top'] as const) : (['left'] as const)) {
        for (const tall of [null, ...RING_TALL]) {
          if (tall === null && side === 'left') continue
          const tried = arranged(tall, side)
          const score = scoreOf(tried)
          if (score > top * 1.03) {
            top = score
            best = tried
          }
        }
      }
    }
    figures.push({
      id: 'ring',
      kind: 'ring',
      ...frame(best.circle, 'centre'),
      ...(architecture.caption ? { label: architecture.caption } : {}),
    })
    boxes = [...best.circle, ...best.column]
  } else if (architecture.shape === 'embudo' && anchor !== undefined) {
    // Arriba, a lo ancho, lo que entra; debajo, donde se junta; y más abajo, lo que sale de ahí.
    const feeds = new Set(
      architecture.links
        .filter((link) => link.kind === 'data' && link.to === anchor)
        .map((link) => link.from),
    )
    const sources = ids.filter((id) => feeds.has(id))
    const after = ids.filter((id) => id !== anchor && !feeds.has(id))
    let top = 0
    const mouth: Box[] = []
    for (const line of packed(sources)) {
      const made = row(line, sizeOf, 0, top)
      mouth.push(...made)
      top += heightOf(made) + GAP.y * 0.6
    }
    top += GAP.y * 0.6
    const neck = row([anchor], sizeOf, 0, top)
    top += heightOf(neck) + GAP.y
    const tail: Box[] = []
    for (const line of packed(after)) {
      const made = row(line, sizeOf, 0, top)
      tail.push(...made)
      top += heightOf(made) + GAP.y * 0.6
    }
    boxes = [...mouth, ...neck, ...tail]
    const wide = frame(mouth, 'edge')
    const narrow = frame(neck, 'edge')
    figures.push({
      id: 'funnel',
      kind: 'funnel',
      x: wide.x - 22,
      y: wide.y - 18,
      w: wide.w + 44,
      h: narrow.y + narrow.h + 14 - (wide.y - 18),
      narrow: narrow.w + 36,
    })
  } else if (architecture.shape === 'abanico' && anchor !== undefined) {
    // A la izquierda, de dónde sale; a la derecha, en arco, quienes lo usan; lo demás, debajo.
    const takes = new Set(
      architecture.links
        .filter((link) => link.kind === 'data' && link.from === anchor)
        .map((link) => link.to),
    )
    const users = ids.filter((id) => takes.has(id))
    const rest = ids.filter((id) => id !== anchor && !takes.has(id))
    const source = sizeOf(anchor)
    const arc: Box[] = []
    let top = 0
    for (const id of users) {
      const size = sizeOf(id)
      arc.push({ id, x: 0, y: top + size.h / 2, w: size.w, h: size.h })
      top += size.h + GAP.y * 0.45
    }
    const tall = Math.max(0, top - GAP.y * 0.45)
    const widest = Math.max(0, ...arc.map((box) => box.w))
    for (const box of arc) {
      // Los del medio, un poco más lejos: el conjunto dibuja un arco.
      const off = tall === 0 ? 0 : Math.abs(box.y - tall / 2) / (tall / 2)
      box.x = source.w / 2 + GAP.x * 1.4 + widest / 2 + (1 - off) * 46
      box.y -= tall / 2
    }
    const below: Box[] = []
    let under = tall / 2 + GAP.y
    for (const line of packed(rest)) {
      const made = row(line, sizeOf, 0, under)
      below.push(...made)
      under += heightOf(made) + GAP.y * 0.6
    }
    boxes = [{ id: anchor, x: 0, y: 0, w: source.w, h: source.h }, ...arc, ...below]
    const span = frame(arc, 'edge')
    figures.push({
      id: 'fan',
      kind: 'fan',
      x: source.w / 2,
      y: span.y - 10,
      w: span.x - source.w / 2 + 12,
      h: span.h + 20,
    })
  } else {
    layers()
  }

  // De centros sueltos a un plano que empieza en el margen.
  const everything = [
    ...boxes.map((box) => ({ x: box.x - box.w / 2, y: box.y - box.h / 2, w: box.w, h: box.h })),
    ...figures,
  ]
  const left = Math.min(0, ...everything.map((item) => item.x))
  const top = Math.min(0, ...everything.map((item) => item.y))
  const shift = { x: PAD - left, y: PAD - top }
  const positions = new Map(
    boxes.map((box) => [
      box.id,
      { x: Math.round(box.x - box.w / 2 + shift.x), y: Math.round(box.y - box.h / 2 + shift.y) },
    ]),
  )
  const moved = figures.map((figure) => ({
    ...figure,
    x: Math.round(figure.x + shift.x),
    y: Math.round(figure.y + shift.y),
    w: Math.round(figure.w),
    h: Math.round(figure.h),
  }))
  return {
    positions,
    figures: moved,
    bounds: {
      w: Math.round(Math.max(0, ...everything.map((item) => item.x + item.w)) + shift.x + PAD),
      h: Math.round(Math.max(0, ...everything.map((item) => item.y + item.h)) + shift.y + PAD),
    },
  }
}
