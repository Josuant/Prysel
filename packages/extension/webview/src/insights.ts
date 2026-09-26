import type { Program } from '@prysel/python'
import type { Concept, Cost, Trail, TrackedSeries } from '../../src/lesson.ts'
import {
  isRef,
  isRefList,
  isShownList,
  stateAt,
  type HeapObject,
  type HeapValue,
  type FrameState,
  type Shown,
  type Trace,
  type TraceIndex,
  type TraceState,
} from '../../src/trace.ts'
import { formatShown } from './player.ts'

/**
 * Lo que enseñan los nodos para entender, calculado de la traza: la tabla de variables, la pila de llamadas,
 * el árbol de llamadas, la memoria (quién apunta a qué) y las colecciones vivas. Puro: recibe la traza (o
 * el estado de un paso) y devuelve modelos sencillos que solo hay que dibujar. Como todo sale de la traza,
 * ir hacia atrás o saltar cuesta lo mismo que avanzar, y una lección grabada se ve sin Python.
 */

export const INSIGHTS = [
  'variables',
  'stack',
  'tree',
  'memory',
  'collection',
  'evolution',
  'trail',
  'structure',
  'cost',
  'concept',
] as const
export type InsightId = (typeof INSIGHTS)[number]

export const INSIGHT_LABELS: Record<InsightId, string> = {
  variables: 'Variables',
  stack: 'Pila',
  tree: 'Árbol de llamadas',
  memory: 'Memoria',
  collection: 'Colección',
  evolution: 'Evolución',
  trail: 'Trayectoria',
  structure: 'Estructura',
  cost: 'Coste',
  concept: 'Concepto',
}

/** Un texto corto para una celda o una etiqueta: con puntos suspensivos si no cabe. */
export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`

const titleOf = (frame: FrameState): string => frame.fn ?? 'Programa'

/** Los cambios de variables que trajo el evento de este paso, en su marco. */
const changedIn = (state: TraceState, frame: FrameState): ReadonlySet<string> =>
  state.event && state.event.f === frame.id ? new Set(Object.keys(state.event.ch ?? {})) : new Set()

// ─── Variables ────────────────────────────────────────────────────────────────────────────────────

export interface VariablesModel {
  /** De qué llamada son las variables (`Programa` o el nombre de la función). */
  title: string
  names: string[]
  /** Un momento por cada vez que algo cambió en esta llamada, del más viejo al actual. */
  columns: { step: number; line: number; cells: ({ text: string; changed: boolean } | null)[] }[]
}

/**
 * La tabla de seguimiento de la llamada en la que se está: una fila por variable y una columna por cada
 * momento en que algo cambió (las últimas `columns`), como en Python Tutor. La última es el ahora.
 */
export function variablesModel(index: TraceIndex, step: number, columns = 7): VariablesModel {
  const now = stateAt(index, step)
  const frame = now.frames[now.frames.length - 1]
  if (step < 0 || !frame) return { title: 'Programa', names: [], columns: [] }
  const steps: number[] = []
  for (let s = step; s >= 0 && steps.length < columns; s--) {
    const event = index.trace.events[s]
    if (event?.f === frame.id && event.ch && Object.keys(event.ch).length > 0) steps.push(s)
  }
  steps.reverse()
  const seen: FrameState[] = steps.map((s) => {
    const found = stateAt(index, s).frames.find((f) => f.id === frame.id)
    return found ?? frame
  })
  const names: string[] = []
  for (const f of seen)
    for (const name of Object.keys(f.locals)) if (!names.includes(name)) names.push(name)
  const cols = steps.map((s, i) => {
    const locals = seen[i]?.locals ?? {}
    const before = i > 0 ? (seen[i - 1]?.locals ?? {}) : {}
    return {
      step: s,
      line: index.trace.events[s]?.l ?? 0,
      cells: names.map((name) => {
        if (!(name in locals)) return null
        const text = formatShown(locals[name] as Shown)
        const previous = before[name]
        return {
          text,
          changed: !(name in before) || formatShown(previous as Shown) !== text,
        }
      }),
    }
  })
  return { title: titleOf(frame), names, columns: cols }
}

// ─── Pila de llamadas ────────────────────────────────────────────────────────────────────────────

export interface StackFrameModel {
  id: number
  title: string
  locals: { name: string; text: string; changed: boolean }[]
  /** Está devolviendo este valor: en el siguiente paso el marco se deshace. */
  returning: string | null
  /** Es la llamada que se está ejecutando (la de arriba). */
  current: boolean
}

export interface StackModel {
  /** Del marco de arriba (la llamada actual) hacia abajo (el programa). */
  frames: StackFrameModel[]
  /** Cuántas llamadas de en medio no se enseñan por ser demasiadas. */
  hidden: number
}

/** Los marcos que se enseñan como mucho: el resto de una recursión profunda se resume. */
export const STACK_VISIBLE = 7

export function stackModel(state: TraceState): StackModel {
  const all = [...state.frames].reverse()
  const models: StackFrameModel[] = all.map((frame, i) => {
    const changed = changedIn(state, frame)
    return {
      id: frame.id,
      title: titleOf(frame),
      locals: Object.entries(frame.locals).map(([name, value]) => ({
        name,
        text: clip(formatShown(value), 28),
        changed: changed.has(name),
      })),
      returning: frame.returned && frame.fn !== null ? formatShown(frame.returned.value) : null,
      current: i === 0,
    }
  })
  if (models.length <= STACK_VISIBLE) return { frames: models, hidden: 0 }
  // De una pila profunda se enseñan las de arriba y la base (el programa).
  const keep = [...models.slice(0, STACK_VISIBLE - 1), ...models.slice(-1)]
  return { frames: keep, hidden: models.length - keep.length }
}

/** Cuántos marcos llega a tener la pila en toda la traza: es lo que fija el alto del nodo, para que no baile. */
export function maxDepth(trace: Trace): number {
  let deepest = 0
  for (const event of trace.events) deepest = Math.max(deepest, event.d)
  return deepest + 1
}

// ─── Árbol de llamadas ───────────────────────────────────────────────────────────────────────────

export interface TreeNode {
  id: number
  parent: number | null
  label: string
  /** El paso en el que se llama, y en el que vuelve (`null`: no vuelve en la traza). */
  call: number
  ret: number | null
  value: string | null
  /** Posición en la rejilla: columna (las hojas van una tras otra) y fila (la profundidad). */
  col: number
  row: number
}

export interface TreeModel {
  nodes: TreeNode[]
  columns: number
  rows: number
  /** Se enseñan solo las primeras llamadas: el resto no cabe. */
  truncated: boolean
}

/** Cuántas llamadas se dibujan como mucho. */
export const TREE_LIMIT = 120

/**
 * Las llamadas de toda la traza como un árbol (quién llamó a quién), con la posición de cada una ya
 * calculada. Se hace una vez con la traza entera: así el árbol no se recoloca al avanzar, solo se ilumina.
 */
export function treeModel(trace: Trace): TreeModel {
  const nodes: TreeNode[] = []
  const byId = new Map<number, TreeNode>()
  const open: number[] = []
  let truncated = false
  for (const [step, event] of trace.events.entries()) {
    if (event.k === 'call') {
      const parent = open[open.length - 1]
      const parentNode = parent === undefined ? undefined : byId.get(parent)
      // Una llamada cuyo padre no se dibujó tampoco se dibuja.
      if (nodes.length >= TREE_LIMIT || (parent !== undefined && !parentNode)) {
        truncated = true
        open.push(event.f)
        continue
      }
      const args = Object.values(event.ch ?? {})
        .map((v) => clip(formatShown(v), 14))
        .join(', ')
      const node: TreeNode = {
        id: event.f,
        parent: parentNode?.id ?? null,
        label: `${event.fn ?? '?'}(${args})`,
        call: step,
        ret: null,
        value: null,
        col: 0,
        row: 0,
      }
      nodes.push(node)
      byId.set(node.id, node)
      open.push(event.f)
    } else if (event.k === 'return' || event.k === 'end') {
      const node = byId.get(event.f)
      if (node && node.ret === null) {
        node.ret = step
        node.value = clip(formatShown(event.v ?? null), 14)
      }
      if (open[open.length - 1] === event.f) open.pop()
    }
  }
  // La rejilla: las hojas una tras otra, y cada padre centrado sobre sus hijos.
  const children = new Map<number | null, TreeNode[]>()
  for (const node of nodes) children.set(node.parent, [...(children.get(node.parent) ?? []), node])
  let next = 0
  let rows = 0
  const place = (node: TreeNode, row: number) => {
    node.row = row
    rows = Math.max(rows, row + 1)
    const kids = children.get(node.id) ?? []
    for (const kid of kids) place(kid, row + 1)
    const first = kids[0]
    const last = kids[kids.length - 1]
    node.col = first && last ? (first.col + last.col) / 2 : next++
  }
  for (const root of children.get(null) ?? []) place(root, 0)
  return { nodes, columns: Math.max(next, 1), rows: Math.max(rows, 1), truncated }
}

export type TreeStatus = 'hidden' | 'open' | 'current' | 'done'

/** Cómo está una llamada en un paso: aún no llamada, en curso, la que se ejecuta o ya devuelta. */
export function treeStatus(node: TreeNode, step: number, currentFrame: number): TreeStatus {
  if (node.call > step) return 'hidden'
  if (node.ret !== null && node.ret <= step) return 'done'
  return node.id === currentFrame ? 'current' : 'open'
}

// ─── Memoria ─────────────────────────────────────────────────────────────────────────────────────

export interface MemoryName {
  frame: string
  name: string
  /** El valor, si es un número o un texto; para un objeto, lo que hay dentro en pequeño. */
  text: string
  /** Si apunta a un objeto (una lista, un diccionario…): cuál. */
  object: number | null
  changed: boolean
}

export interface MemoryObject {
  id: number
  text: string
  /** Los nombres que apuntan a él: si son varios, es un alias. */
  owners: string[]
}

export interface MemoryModel {
  names: MemoryName[]
  objects: MemoryObject[]
}

/**
 * Quién apunta a qué: cada variable de cada llamada abierta, y los objetos mutables a los que se refieren
 * (con la identidad que grabó el motor). Dos nombres con la misma identidad son el mismo objeto.
 */
export function memoryModel(state: TraceState, maxNames = 14): MemoryModel {
  const names: MemoryName[] = []
  const objects = new Map<number, MemoryObject>()
  for (const frame of [...state.frames].reverse()) {
    const changed = changedIn(state, frame)
    for (const [name, value] of Object.entries(frame.locals)) {
      const id = frame.ids[name] ?? null
      const text = clip(formatShown(value), 30)
      names.push({ frame: titleOf(frame), name, text, object: id, changed: changed.has(name) })
      if (id !== null) {
        const object = objects.get(id) ?? { id, text, owners: [] }
        object.owners.push(`${titleOf(frame)}.${name}`)
        objects.set(id, object)
      }
    }
  }
  return { names: names.slice(0, maxNames), objects: [...objects.values()] }
}

// ─── Colección viva ──────────────────────────────────────────────────────────────────────────────

export interface CollectionModel {
  name: string
  items: {
    text: string
    /** 0–1 dentro del rango, o `null` si no es un número. */ level: number | null
    changed: boolean
  }[]
  /** Cuántos elementos tiene en total (por si no se graban todos). */
  size: number
  /** Las variables enteras que se usan como índice y dónde apuntan ahora: `j` en la celda 3. */
  pointers: { name: string; index: number }[]
  numeric: boolean
}

/** Los nombres que el programa usa como índice (`xs[j]`, `xs[j + 1]`): son los punteros que se enseñan. */
export function indexNames(program: Program): Set<string> {
  const names = new Set<string>()
  for (const node of program.nodes) {
    for (const bracket of (node.text ?? node.code).matchAll(/\[([^\]\n]*)\]/g)) {
      for (const word of (bracket[1] ?? '').matchAll(/[A-Za-z_]\w*/g)) names.add(word[0])
    }
  }
  return names
}

/**
 * Las listas de la llamada actual (y del programa) como celdas o barras: las que cambiaron desde el paso
 * anterior se resaltan, y las variables que se usan de índice marcan su celda. Como mucho `limit` listas.
 */
export function collectionModels(
  state: TraceState,
  previous: TraceState | null,
  indexes: ReadonlySet<string>,
  limit = 2,
): CollectionModel[] {
  const models: CollectionModel[] = []
  const seen = new Set<string>()
  for (const frame of [...state.frames].reverse()) {
    const before = previous?.frames.find((f) => f.id === frame.id)
    for (const [name, value] of Object.entries(frame.locals)) {
      if (models.length >= limit) return models
      if (!isShownList(value) || seen.has(name) || value.l.length === 0) continue
      seen.add(name)
      const old = before?.locals[name]
      const numbers = value.l.filter((item): item is number => typeof item === 'number')
      const numeric = numbers.length === value.l.length
      const low = Math.min(...numbers)
      const high = Math.max(...numbers)
      const oldItems = isShownList(old) ? old.l : null
      models.push({
        name,
        size: value.n,
        numeric,
        items: value.l.map((item, i) => ({
          text: formatShown(item),
          level:
            numeric && typeof item === 'number'
              ? high === low
                ? 0.6
                : 0.12 + (0.88 * (item - low)) / (high - low)
              : null,
          changed:
            oldItems !== null && (oldItems.length !== value.l.length || oldItems[i] !== item),
        })),
        pointers: Object.entries(frame.locals)
          .filter(
            ([other, v]) =>
              typeof v === 'number' &&
              Number.isInteger(v) &&
              v >= 0 &&
              v < value.l.length &&
              indexes.has(other) &&
              other !== name,
          )
          .map(([other, v]) => ({ name: other, index: v as number })),
      })
    }
  }
  return models
}

// ─── Evolución ───────────────────────────────────────────────────────────────────────────────────

export interface EvolutionSeries {
  label: string
  /** Un valor por cada vez que la variable cambió, hasta el paso que se mira: crece según se reproduce. */
  points: number[]
}

export interface EvolutionModel {
  series: EvolutionSeries[]
  min: number
  max: number
}

/**
 * Cómo cambian, paso a paso hasta el que se mira, unas variables numéricas que el guion señala (por
 * ejemplo, la aptitud media de cada generación): una línea por serie. Se lee directamente de los cambios
 * de la traza (`ch`), sin reconstruir el estado completo — más barato, y de sobra para un número suelto.
 */
export function evolutionModel(
  trace: Trace,
  step: number,
  tracked: readonly TrackedSeries[],
): EvolutionModel {
  const series = tracked.map((t) => ({ label: t.label, points: [] as number[] }))
  const last = Math.min(step, trace.events.length - 1)
  for (let i = 0; i <= last; i++) {
    const changes = trace.events[i]?.ch
    if (!changes) continue
    tracked.forEach((t, index) => {
      const value = changes[t.name]
      if (typeof value === 'number') series[index]?.points.push(value)
    })
  }
  const all = series.flatMap((s) => s.points)
  return {
    series,
    min: all.length > 0 ? Math.min(0, ...all) : 0,
    max: all.length > 0 ? Math.max(1, ...all) : 1,
  }
}

// ─── Trayectoria ─────────────────────────────────────────────────────────────────────────────────

export interface TrailPoint {
  step: number
  value: number
  obstacle: number | null
  gap: number | null
}

export interface TrailModel {
  points: TrailPoint[]
  min: number
  max: number
  obstacleWidth: number | null
}

/**
 * El camino de un valor numérico (una altura, una posición) a lo largo del tiempo, con el obstáculo que
 * lo acompaña si el guion lo pide. Sigue a la llamada más reciente que tiene esa variable: al entrar en
 * una llamada nueva («otro vuelo»), empieza de cero, como se ve de verdad en la traza.
 */
export function trailModel(trace: Trace, state: TraceState, spec: Trail): TrailModel {
  const obstacleWidth = spec.obstacle?.width ?? null
  const frame = [...state.frames].reverse().find((f) => spec.value in f.locals)
  if (!frame) return { points: [], min: spec.min, max: spec.max, obstacleWidth }
  const points: TrailPoint[] = []
  let obstacle: number | null = null
  let gap: number | null = null
  const last = Math.min(state.step, trace.events.length - 1)
  for (let i = 0; i <= last; i++) {
    const event = trace.events[i]
    if (!event || event.f !== frame.id || !event.ch) continue
    if (spec.obstacle) {
      const o = event.ch[spec.obstacle.name]
      if (typeof o === 'number') obstacle = o
      const g = event.ch[spec.obstacle.gap]
      if (typeof g === 'number') gap = g
    }
    const value = event.ch[spec.value]
    if (typeof value === 'number') points.push({ step: i, value, obstacle, gap })
  }
  return { points, min: spec.min, max: spec.max, obstacleWidth }
}

// ─── Estructura ───────────────────────────────────────────────────────────────────────────────────

export interface StructureField {
  name: string
  /** El valor, si no es una referencia a otro objeto. */
  text: string | null
  /** Apunta a otro objeto (o a varios, en una lista): de aquí sale una flecha. */
  ref: boolean
}

export interface StructureBox {
  id: string
  /** La clase del objeto (o `list`/`dict` si es una colección de objetos). */
  cls: string
  fields: StructureField[]
  /** Columna (la distancia desde la variable que lleva hasta él) y fila, en una rejilla. */
  col: number
  row: number
  /** Las variables que lo nombran directamente. */
  names: string[]
  /** Este paso acaba de cambiarlo (o de crearlo). */
  changed: boolean
}

export interface StructureArrow {
  from: string
  field: string
  to: string
}

export interface StructureModel {
  boxes: StructureBox[]
  arrows: StructureArrow[]
  /** Lo que parece: una cadena (lista enlazada), un árbol, o un grafo (se comparten nodos o hay ciclos). */
  shape: 'lista' | 'árbol' | 'grafo' | null
  cols: number
  rows: number
  /** Hay más objetos de los que caben: se enseñan los más cercanos a las variables. */
  truncated: boolean
}

/** Cuántos objetos dibuja como mucho la tarjeta. */
export const STRUCTURE_LIMIT = 24

const refsOf = (value: HeapValue): number[] =>
  isRef(value)
    ? [value.r]
    : isRefList(value)
      ? value.rl.filter((id): id is number => id !== null)
      : []

const fieldText = (value: HeapValue): string | null =>
  isRef(value) || isRefList(value) ? null : formatShown(value as Shown)

/**
 * Los objetos del programa tal como están en este paso, dibujados como lo que son: desde cada variable que
 * nombra uno, siguiendo sus atributos. Una cadena de `siguiente` es una lista enlazada; dos hijos por nodo,
 * un árbol; si varios apuntan al mismo, un grafo. Solo lo alcanzable desde las variables que se ven (lo que
 * ya nadie nombra no se enseña).
 */
export function structureModel(state: TraceState): StructureModel {
  const empty: StructureModel = {
    boxes: [],
    arrows: [],
    shape: null,
    cols: 0,
    rows: 0,
    truncated: false,
  }
  const heap = state.heap
  if (Object.keys(heap).length === 0) return empty
  // Las raíces: las variables (de la llamada actual hacia el programa) que nombran un objeto.
  const names = new Map<string, string[]>()
  const roots: string[] = []
  const seenName = new Set<string>()
  for (const frame of [...state.frames].reverse()) {
    for (const [name, id] of Object.entries(frame.ids)) {
      if (seenName.has(name)) continue
      seenName.add(name)
      const key = String(id)
      if (!heap[key]) continue
      names.set(key, [...(names.get(key) ?? []), name])
      if (!roots.includes(key)) roots.push(key)
    }
  }
  if (roots.length === 0) return empty

  // En anchura desde las raíces: la columna es la distancia; la fila, el orden de llegada en esa columna.
  const depth = new Map<string, number>()
  const order: string[] = []
  const queue = roots.map((id) => ({ id, d: 0 }))
  let truncated = false
  while (queue.length > 0) {
    const { id, d } = queue.shift() as { id: string; d: number }
    if (depth.has(id)) continue
    if (order.length >= STRUCTURE_LIMIT) {
      truncated = true
      break
    }
    const object: HeapObject | undefined = heap[id]
    if (!object) continue
    depth.set(id, d)
    order.push(id)
    for (const value of Object.values(object.f)) {
      for (const ref of refsOf(value)) {
        const next = String(ref)
        if (!depth.has(next) && heap[next]) queue.push({ id: next, d: d + 1 })
      }
    }
  }
  const rowsIn = new Map<number, number>()
  const changed = new Set(Object.keys(state.event?.h ?? {}))
  const boxes: StructureBox[] = order.map((id) => {
    const object = heap[id] as HeapObject
    const col = depth.get(id) ?? 0
    const row = rowsIn.get(col) ?? 0
    rowsIn.set(col, row + 1)
    return {
      id,
      cls: object.c,
      fields: Object.entries(object.f).map(([name, value]) => ({
        name,
        text: fieldText(value),
        ref: refsOf(value).length > 0,
      })),
      col,
      row,
      names: names.get(id) ?? [],
      changed: changed.has(id),
    }
  })
  const shown = new Set(order)
  const arrows: StructureArrow[] = []
  const incoming = new Map<string, number>()
  let branching = false
  for (const id of order) {
    const object = heap[id] as HeapObject
    let out = 0
    for (const [field, value] of Object.entries(object.f)) {
      for (const ref of refsOf(value)) {
        const to = String(ref)
        if (!shown.has(to)) continue
        arrows.push({ from: id, field, to })
        incoming.set(to, (incoming.get(to) ?? 0) + 1)
        out++
      }
    }
    if (out > 1) branching = true
  }
  const shared = [...incoming.values()].some((n) => n > 1)
  const shape = boxes.length < 2 ? null : shared ? 'grafo' : branching ? 'árbol' : 'lista'
  return {
    boxes,
    arrows,
    shape,
    cols: Math.max(0, ...boxes.map((b) => b.col)) + 1,
    rows: Math.max(0, ...rowsIn.values()),
    truncated,
  }
}

// ─── Coste ────────────────────────────────────────────────────────────────────────────────────────

export interface CostPoint {
  /** El tamaño de lo que recibió la llamada. */
  n: number
  /** Cuántos pasos dio, contando lo que llamó a su vez. */
  ops: number
}

export interface CostModel {
  fn: string
  /** El parámetro que da el tamaño (el que dice el guion, o el primero). */
  param: string | null
  /** Las llamadas que ya acabaron, con su tamaño (las que tienen uno legible). */
  points: CostPoint[]
  /** La llamada en curso: cuántos pasos lleva. */
  current: CostPoint | null
  /** Cómo crece, si hay llamadas de tamaños suficientes para verlo. */
  growth: string | null
}

/** El tamaño de un valor: el largo de una lista o de un texto, o el propio número. */
function sizeOf(value: Shown | undefined): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  if (isShownList(value)) return value.n
  if (typeof value === 'string' && /^(['"]).*\1$/.test(value)) return value.length - 2
  return null
}

/** Una recta por mínimos cuadrados: pendiente y lo bien que ajusta (R²). */
function fit(xs: readonly number[], ys: readonly number[]): { slope: number; r2: number } {
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] as number) - mx
    const dy = (ys[i] as number) - my
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  const slope = sxx === 0 ? 0 : sxy / sxx
  const r2 = sxx === 0 || syy === 0 ? 1 : (sxy * sxy) / (sxx * syy)
  return { slope, r2 }
}

/** Cómo crecen los pasos con el tamaño: potencia (n, n², …) o exponencial, lo que mejor ajuste. */
export function growthOf(points: readonly CostPoint[]): string | null {
  // Un punto por tamaño (el mayor de los pasos, si se repite) y tamaños de al menos 2.
  const bySize = new Map<number, number>()
  for (const p of points) if (p.n >= 2) bySize.set(p.n, Math.max(bySize.get(p.n) ?? 0, p.ops))
  if (bySize.size < 3) return null
  const ns = [...bySize.keys()]
  const ops = ns.map((n) => bySize.get(n) as number)
  const power = fit(
    ns.map((n) => Math.log(n)),
    ops.map((o) => Math.log(o)),
  )
  const exponential = fit(
    ns,
    ops.map((o) => Math.log(o)),
  )
  if (exponential.r2 > power.r2 + 0.02 && Math.exp(exponential.slope) > 1.2) {
    return `exponencial (≈ ${Math.exp(exponential.slope).toFixed(1)}ⁿ)`
  }
  const k = power.slope
  if (k < 0.35) return 'constante (≈ 1)'
  if (k < 1.35) return 'lineal (≈ n)'
  if (k < 2.35) return 'cuadrático (≈ n²)'
  if (k < 3.35) return 'cúbico (≈ n³)'
  return `≈ n^${k.toFixed(1)}`
}

/**
 * La complejidad, vista y no dicha: cada llamada a `fn` es un punto (el tamaño de lo que recibió, los pasos
 * que dio). La que está en curso cuenta en directo. Todo sale de la traza, hasta el paso actual.
 */
export function costModel(trace: Trace, step: number, spec: Cost): CostModel {
  const open = new Map<number, { start: number; n: number | null }>()
  const points: CostPoint[] = []
  let param: string | null = spec.n ?? null
  const last = Math.min(step, trace.events.length - 1)
  for (let i = 0; i <= last; i++) {
    const event = trace.events[i]
    if (!event) continue
    if (event.k === 'call' && event.fn === spec.fn) {
      const args = event.ch ?? {}
      const name = spec.n ?? Object.keys(args)[0] ?? null
      if (param === null) param = name
      open.set(event.f, { start: i, n: name === null ? null : sizeOf(args[name]) })
      continue
    }
    if (event.k === 'return' && open.has(event.f)) {
      const call = open.get(event.f) as { start: number; n: number | null }
      open.delete(event.f)
      if (call.n !== null) points.push({ n: call.n, ops: i - call.start + 1 })
    }
  }
  // La llamada en curso: la más reciente que sigue abierta.
  const running = [...open.values()].at(-1)
  const current =
    running && running.n !== null ? { n: running.n, ops: last - running.start + 1 } : null
  return { fn: spec.fn, param, points, current, growth: growthOf(points) }
}

// ─── Concepto ─────────────────────────────────────────────────────────────────────────────────────

/**
 * La idea que toca en este paso: la del último momento que ya llegó y trae una. Antes de llegar a ninguno,
 * la primera: así se puede empezar por la idea, antes que por el código.
 */
export function conceptAt(
  moments: readonly { step: number; concept?: Concept | undefined }[],
  step: number,
): Concept | null {
  const withIdea = moments.filter((m) => m.concept !== undefined)
  let found: Concept | null = null
  for (const moment of withIdea) if (moment.step <= step) found = moment.concept as Concept
  return found ?? withIdea[0]?.concept ?? null
}
