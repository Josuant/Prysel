import type { Axis, Point } from './types.ts'

/**
 * Enrutado de conexiones: ángulos de 90° que esquivan lo que hay en medio.
 *
 * Una curva directa entre dos nodos atraviesa lo que quede entre ellos — otros nodos, el
 * territorio de una función — y en un programa denso eso es el «espagueti visual». Aquí cada
 * conexión busca su camino por una rejilla dispersa, formada solo por los bordes de los
 * obstáculos (más un margen), así que el coste depende de cuántos nodos hay cerca y no del
 * tamaño del lienzo. Es un A* con penalización por giro: entre dos caminos, gana el que
 * tuerce menos, que es el que se lee mejor.
 *
 * Es una función pura sobre rectángulos: no sabe nada de React ni de qué es un nodo.
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface RouteOptions {
  axis?: Axis
  /** Distancia mínima que se guarda a cada obstáculo. */
  margin?: number
  /** Tramo recto al salir y al entrar: la conexión sale de un puerto, no de una esquina. */
  stub?: number
  /** Cuánto «cuesta» un giro, en píxeles de recorrido equivalente. */
  bendCost?: number
  /** Radio de las esquinas redondeadas. */
  radius?: number
  /** Por encima de esto no se enruta: se deja la curva simple (y el coste acotado). */
  maxObstacles?: number
}

export interface Route {
  points: Point[]
  /** El trazado SVG, con las esquinas redondeadas. */
  d: string
  /** El punto medio del recorrido: donde va la etiqueta de la conexión. */
  mid: Point
}

const DEFAULTS = { margin: 10, stub: 22, bendCost: 60, radius: 10, maxObstacles: 60 }

const round = (v: number) => Math.round(v * 10) / 10

/** Una cola de prioridad mínima. Un montículo binario: lo justo para un A*. */
class MinHeap {
  private readonly keys: number[] = []
  private readonly values: number[] = []

  get size() {
    return this.keys.length
  }

  push(key: number, value: number) {
    const { keys, values } = this
    let i = keys.length
    keys.push(key)
    values.push(value)
    while (i > 0) {
      const parent = (i - 1) >> 1
      if ((keys[parent] ?? 0) <= key) break
      keys[i] = keys[parent] ?? 0
      values[i] = values[parent] ?? 0
      i = parent
    }
    keys[i] = key
    values[i] = value
  }

  pop(): number {
    const { keys, values } = this
    const top = values[0] ?? 0
    const lastKey = keys.pop() ?? 0
    const lastValue = values.pop() ?? 0
    const n = keys.length
    if (n > 0) {
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let child = l
        if (l >= n) break
        if (r < n && (keys[r] ?? 0) < (keys[l] ?? 0)) child = r
        if ((keys[child] ?? 0) >= lastKey) break
        keys[i] = keys[child] ?? 0
        values[i] = values[child] ?? 0
        i = child
      }
      keys[i] = lastKey
      values[i] = lastValue
    }
    return top
  }
}

const unique = (values: number[]) => [...new Set(values)].sort((a, b) => a - b)

/**
 * Busca un camino ortogonal de `from` a `to` que no cruce ningún obstáculo.
 * `null` si no hay (o no compensa buscarlo): quien llama traza entonces la curva simple.
 */
export function routeOrthogonal(
  from: Point,
  to: Point,
  obstacles: Rect[],
  options: RouteOptions = {},
): Route | null {
  const { margin, stub, bendCost, radius, maxObstacles } = { ...DEFAULTS, ...options }
  const horizontal = (options.axis ?? 'horizontal') === 'horizontal'

  const start = horizontal ? { x: from.x + stub, y: from.y } : { x: from.x, y: from.y + stub }
  const goal = horizontal ? { x: to.x - stub, y: to.y } : { x: to.x, y: to.y - stub }
  // Hacia atrás no es una conexión de flujo: es un retorno, y tiene su propio trazado.
  if (horizontal ? goal.x < start.x : goal.y < start.y) return null

  // Solo cuentan los obstáculos que caen cerca del recorrido.
  const slack = 240
  const box = {
    x0: Math.min(start.x, goal.x) - slack,
    y0: Math.min(start.y, goal.y) - slack,
    x1: Math.max(start.x, goal.x) + slack,
    y1: Math.max(start.y, goal.y) + slack,
  }
  const near = obstacles
    .filter((o) => o.x + o.w >= box.x0 && o.x <= box.x1 && o.y + o.h >= box.y0 && o.y <= box.y1)
    .map((o) => ({
      x0: o.x - margin,
      y0: o.y - margin,
      x1: o.x + o.w + margin,
      y1: o.y + o.h + margin,
    }))
  if (near.length > maxObstacles) return null

  // La rejilla: los bordes de cada obstáculo, y el origen y el destino.
  const xs = unique([start.x, goal.x, ...near.flatMap((o) => [o.x0, o.x1])])
  const ys = unique([start.y, goal.y, ...near.flatMap((o) => [o.y0, o.y1])])
  const nx = xs.length
  const ny = ys.length
  const xi = (x: number) => xs.indexOf(x)
  const yi = (y: number) => ys.indexOf(y)

  // Qué tramos entre dos puntos contiguos de la rejilla atraviesan un obstáculo.
  const hBlocked = new Uint8Array(Math.max(0, nx - 1) * ny) // (i → i+1, fila j)
  const vBlocked = new Uint8Array(nx * Math.max(0, ny - 1)) // (columna i, j → j+1)
  for (const o of near) {
    for (let j = 0; j < ny; j++) {
      const y = ys[j] ?? 0
      if (y <= o.y0 || y >= o.y1) continue
      for (let i = 0; i < nx - 1; i++) {
        if ((xs[i] ?? 0) >= o.x0 && (xs[i + 1] ?? 0) <= o.x1) hBlocked[j * (nx - 1) + i] = 1
      }
    }
    for (let i = 0; i < nx; i++) {
      const x = xs[i] ?? 0
      if (x <= o.x0 || x >= o.x1) continue
      for (let j = 0; j < ny - 1; j++) {
        if ((ys[j] ?? 0) >= o.y0 && (ys[j + 1] ?? 0) <= o.y1) vBlocked[i * (ny - 1) + j] = 1
      }
    }
  }

  const sx = xi(start.x)
  const sy = yi(start.y)
  const gx = xi(goal.x)
  const gy = yi(goal.y)
  const stateOf = (i: number, j: number, dir: number) => (i * ny + j) * 2 + dir
  const best = new Float64Array(nx * ny * 2).fill(Infinity)
  const parent = new Int32Array(nx * ny * 2).fill(-1)
  const heap = new MinHeap()
  const heuristic = (i: number, j: number) =>
    Math.abs((xs[i] ?? 0) - goal.x) + Math.abs((ys[j] ?? 0) - goal.y)

  // Se sale del puerto en la dirección del eje de lectura: 0 = horizontal, 1 = vertical.
  const firstDir = horizontal ? 0 : 1
  const origin = stateOf(sx, sy, firstDir)
  best[origin] = 0
  heap.push(heuristic(sx, sy), origin)

  let reached = -1
  while (heap.size > 0) {
    const state = heap.pop()
    const dir = state % 2
    const cell = (state - dir) / 2
    const j = cell % ny
    const i = (cell - j) / ny
    const cost = best[state] ?? Infinity
    if (i === gx && j === gy) {
      // Llegar en la dirección contraria a la de entrada al puerto obliga a un giro más.
      if (dir === firstDir) {
        reached = state
        break
      }
      const turned = stateOf(i, j, firstDir)
      if (cost + bendCost < (best[turned] ?? Infinity)) {
        best[turned] = cost + bendCost
        parent[turned] = state
        heap.push(cost + bendCost, turned)
      }
      continue
    }

    const moves: [number, number, number, boolean][] = [
      [i + 1, j, 0, i + 1 < nx && !hBlocked[j * (nx - 1) + i]],
      [i - 1, j, 0, i - 1 >= 0 && !hBlocked[j * (nx - 1) + i - 1]],
      [i, j + 1, 1, j + 1 < ny && !vBlocked[i * (ny - 1) + j]],
      [i, j - 1, 1, j - 1 >= 0 && !vBlocked[i * (ny - 1) + j - 1]],
    ]
    for (const [ni, nj, ndir, open] of moves) {
      if (!open) continue
      const step = Math.abs((xs[ni] ?? 0) - (xs[i] ?? 0)) + Math.abs((ys[nj] ?? 0) - (ys[j] ?? 0))
      const next = cost + step + (ndir === dir ? 0 : bendCost)
      const target = stateOf(ni, nj, ndir)
      if (next < (best[target] ?? Infinity)) {
        best[target] = next
        parent[target] = state
        heap.push(next + heuristic(ni, nj), target)
      }
    }
  }
  if (reached < 0) return null

  // Del final al principio, y de casillas a puntos.
  const raw: Point[] = []
  for (let s = reached; s >= 0; s = parent[s] ?? -1) {
    const dir = s % 2
    const cell = (s - dir) / 2
    const j = cell % ny
    const i = (cell - j) / ny
    const point = { x: xs[i] ?? 0, y: ys[j] ?? 0 }
    const last = raw[raw.length - 1]
    if (!last || last.x !== point.x || last.y !== point.y) raw.push(point)
  }
  raw.reverse()

  return finish([from, ...raw, to], radius)
}

/** Quita los puntos que no giran y traza el resultado con las esquinas redondeadas. */
function finish(input: Point[], radius: number): Route {
  const points: Point[] = []
  for (const p of input) {
    const a = points[points.length - 2]
    const b = points[points.length - 1]
    if (b && b.x === p.x && b.y === p.y) continue
    // Tres puntos alineados: el del medio sobra.
    if (a && b && ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y))) points.pop()
    points.push(p)
  }

  let d = `M${round(points[0]?.x ?? 0)} ${round(points[0]?.y ?? 0)}`
  for (let k = 1; k < points.length; k++) {
    const prev = points[k - 1]
    const curr = points[k]
    const next = points[k + 1]
    if (!prev || !curr) continue
    if (!next) {
      d += `L${round(curr.x)} ${round(curr.y)}`
      continue
    }
    // Una esquina: se llega un poco antes, se curva y se sale un poco después.
    const lengthIn = Math.abs(curr.x - prev.x) + Math.abs(curr.y - prev.y)
    const lengthOut = Math.abs(next.x - curr.x) + Math.abs(next.y - curr.y)
    const r = Math.min(radius, lengthIn / 2, lengthOut / 2)
    const inDir = { x: Math.sign(curr.x - prev.x), y: Math.sign(curr.y - prev.y) }
    const outDir = { x: Math.sign(next.x - curr.x), y: Math.sign(next.y - curr.y) }
    d +=
      `L${round(curr.x - inDir.x * r)} ${round(curr.y - inDir.y * r)}` +
      `Q${round(curr.x)} ${round(curr.y)} ${round(curr.x + outDir.x * r)} ${round(curr.y + outDir.y * r)}`
  }

  // El punto medio, medido sobre el recorrido.
  const lengths = points.slice(1).map((p, k) => {
    const q = points[k]
    return q ? Math.abs(p.x - q.x) + Math.abs(p.y - q.y) : 0
  })
  let remaining = lengths.reduce((sum, l) => sum + l, 0) / 2
  let mid = points[0] ?? { x: 0, y: 0 }
  for (let k = 0; k < lengths.length; k++) {
    const l = lengths[k] ?? 0
    const p = points[k]
    const q = points[k + 1]
    if (!p || !q) continue
    if (remaining <= l) {
      const t = l === 0 ? 0 : remaining / l
      mid = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }
      break
    }
    remaining -= l
  }

  return { points, d, mid: { x: round(mid.x), y: round(mid.y) } }
}

/** Por dónde sale una conexión de un paso en un diagrama de flujo: por abajo, o por el vértice derecho del rombo. */
export type FlowExit = 'bottom' | 'right'

export interface FlowRouteOptions {
  /** Por dónde sale. */
  exit?: FlowExit
  /**
   * La x del carril por el que baja un «no» sin `else`: rodea el camino «sí» por la derecha antes de volver
   * a la espina.
   */
  lane?: number
  /** A qué distancia por encima del destino se juntan los caminos que llegan a él. */
  join?: number
  radius?: number
}

/** A qué altura, por encima del paso al que llegan, se juntan los caminos (y se dibuja el punto de unión). */
export const FLOW_JOIN = 16

/**
 * El trazado de una conexión de orden en un diagrama de flujo, leído hacia abajo. No busca camino: la
 * colocación ya dejó el hueco, así que basta con la forma de siempre en ángulos rectos:
 *
 * - Hacia abajo, entre dos pasos de la misma espina: una recta.
 * - Hacia abajo, de otra columna: baja hasta justo encima del destino, cruza y entra; todos los caminos que
 *   llegan al mismo paso se juntan a esa misma altura.
 * - Del vértice derecho de un rombo (el «no») a un paso de su derecha: sale en horizontal y baja.
 * - Del vértice derecho a lo que sigue a la decisión (sin `else`): rodea por su carril y vuelve a la espina.
 */
export function routeFlow(a: Point, b: Point, options: FlowRouteOptions = {}): Route {
  const join = options.join ?? FLOW_JOIN
  const radius = options.radius ?? 8
  const exit = options.exit ?? 'bottom'
  const above = b.y - join
  if (exit === 'right') {
    const straight = options.lane === undefined && b.x > a.x + 12 && b.y > a.y
    if (straight) return finish([a, { x: b.x, y: a.y }, b], radius)
    const lane = Math.max(options.lane ?? a.x + 24, a.x + 12)
    const down = Math.max(above, a.y + 12)
    return finish([a, { x: lane, y: a.y }, { x: lane, y: down }, { x: b.x, y: down }, b], radius)
  }
  if (Math.abs(a.x - b.x) < 1 && b.y >= a.y) return finish([a, { x: a.x, y: b.y }], radius)
  // Un paso que quedó más arriba (lo movió el usuario): sale un poco, cruza y entra desde arriba.
  const down = b.y > a.y + join ? above : a.y + 12
  return finish([a, { x: a.x, y: down }, { x: b.x, y: down }, b], radius)
}
