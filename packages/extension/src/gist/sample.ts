import {
  indexOf,
  isRef,
  isRefList,
  stateAt,
  type HeapObject,
  type HeapValue,
  type Shown,
  type Trace,
  type TraceIndex,
} from '../trace.ts'
import type { Facts } from './facts.ts'
import { showValue, valueOf, type Value } from './value.ts'

/**
 * Una muestra: una vez que la función se ejecutó de verdad. Con qué entró, qué devolvió, qué imprimió y qué
 * cambió. Sale de la traza; nada de lo que lleva lo ha escrito una IA.
 */
export interface Sample {
  inputs: { name: string; value: Value }[]
  /** Lo que devolvió (si devuelve algo). */
  returned?: Value
  /** Lo que imprimió mientras duró. */
  printed?: string
  /** Lo que recibió y dejó cambiado (una lista que ordena, un diccionario que rellena). */
  changed?: { name: string; before: Value; after: Value }[]
  /** En un método: el objeto antes y después. */
  self?: { cls: string; before: Record<string, Value>; after: Record<string, Value> }
  /** Acabó con un error: cuál. */
  error?: string
  /** Cuántos pasos duró y cuántas líneas distintas de la función pisó. */
  steps: number
  lines: number
  /** La entrada no estaba en el programa: se propuso para probar. La salida es igual de real. */
  invented: boolean
  /**
   * Por dónde fue cada vuelta del bucle que recorre lo que entró (el que da una vuelta por elemento; si
   * ninguno cuadra, el más interior): las líneas propias de su cuerpo que se ejecutaron, en orden (contadas
   * desde la línea del `def`, que es la 0; sin las de un bucle de más adentro). Es lo que dice qué rama tomó
   * cada elemento, también cuando la decisión la toma otra función. Sin bucle (o con demasiadas vueltas), no
   * está.
   */
  paths?: number[][]
  /** Con `invented`: la llamada que se probó. */
  call?: string
  /** Esa llamada la escribió quien lo usa, para probar la función con sus propios datos. */
  tried?: boolean
}

/** Cuántas llamadas se miran como mucho: de sobra para elegir, y no cuesta en un bucle largo. */
const MAX_CALLS = 60
/** Hasta cuántas vueltas se guarda por dónde fue cada una. */
const MAX_LAPS = 400

const indentOf = (row: string) => row.length - row.trimStart().length

/**
 * El bucle más interior de una función (el más sangrado; entre iguales, el primero): la línea de su cabecera
 * y hasta dónde llega su cuerpo, contadas desde la del `def`. `null` si no tiene ninguno.
 */
export function innerLoop(code: string): { head: number; to: number } | null {
  const rows = code.split('\n')
  let head = -1
  for (const [at, row] of rows.entries()) {
    if (!/^\s*(?:for|while)\b.*:\s*(?:#.*)?$/.test(row)) continue
    if (head < 0 || indentOf(row) > indentOf(rows[head] ?? '')) head = at
  }
  if (head < 0) return null
  const indent = indentOf(rows[head] ?? '')
  let to = head
  for (let at = head + 1; at < rows.length; at++) {
    const row = rows[at] ?? ''
    if (row.trim() === '') continue
    if (indentOf(row) <= indent) break
    to = at
  }
  return to > head ? { head, to } : null
}

/** Todos los bucles de una función: la línea de su cabecera y la última de su cuerpo (desde la del `def`). */
export function loopsOf(code: string): { head: number; to: number }[] {
  const rows = code.split('\n')
  const loops: { head: number; to: number }[] = []
  for (const [head, row] of rows.entries()) {
    if (!/^\s*(?:for|while)\b.*:\s*(?:#.*)?$/.test(row)) continue
    const indent = indentOf(row)
    let to = head
    for (let at = head + 1; at < rows.length; at++) {
      const below = rows[at] ?? ''
      if (below.trim() === '') continue
      if (indentOf(below) <= indent) break
      to = at
    }
    if (to > head) loops.push({ head, to })
  }
  return loops
}

/** Cuántos valores sueltos lleva un valor (una rejilla, celda a celda); 0 si no es una colección. */
const atomsIn = (value: Value): number =>
  value.kind === 'list'
    ? value.items.reduce(
        (sum, item) => sum + (item.kind === 'list' ? atomsIn(item) : item.kind === 'atom' ? 1 : 0),
        0,
      )
    : 0

export const fieldsOf = (
  object: HeapObject | undefined,
  heap: Readonly<Record<string, HeapObject>>,
): Record<string, Value> => {
  const shown = (value: HeapValue): Value => {
    if (isRef(value)) return { kind: 'opaque', text: `→ ${heap[String(value.r)]?.c ?? 'objeto'}` }
    if (isRefList(value))
      return {
        kind: 'list',
        shape: 'list',
        more: false,
        items: value.rl.map((ref) =>
          ref === null
            ? ({ kind: 'atom', type: 'none', text: 'None' } as const)
            : ({ kind: 'opaque', text: `→ ${heap[String(ref)]?.c ?? 'objeto'}` } as const),
        ),
      }
    return valueOf(value)
  }
  return Object.fromEntries(
    Object.entries(object?.f ?? {}).map(([name, value]) => [name, shown(value)]),
  )
}

const same = (a: Record<string, Value>, b: Record<string, Value>): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

/**
 * Las veces que esa función se ejecutó en la traza, cada una como una muestra. `from`: solo las que
 * empiezan a partir de ese paso (para quedarse con la llamada que se añadió para probar).
 */
export function samplesIn(
  trace: Trace,
  facts: Facts,
  options: { from?: number; index?: TraceIndex } = {},
): Sample[] {
  const index = options.index ?? indexOf(trace)
  const events = trace.events
  const samples: Sample[] = []
  // Quién llamó a cada marco: una vuelta de una recursión no es la muestra, lo es la llamada de fuera.
  const fnOf = new Map<number, string>()
  const stack: number[] = []
  for (let i = 0; i < events.length && samples.length < MAX_CALLS; i++) {
    const call = events[i]
    if (!call) continue
    if (call.k === 'return' && stack.at(-1) === call.f) stack.pop()
    if (call.k !== 'call') continue
    const parent = fnOf.get(stack.at(-1) ?? 0)
    fnOf.set(call.f, call.fn ?? '')
    stack.push(call.f)
    if (call.fn !== facts.name || call.l < facts.line || call.l > facts.lineEnd) continue
    if (parent === facts.name || i < (options.from ?? 0)) continue
    // Hasta que ese marco devuelve: lo impreso entre medias (también por lo que llama) es suyo.
    let printed = ''
    // Las vueltas de cada bucle de la función: cada vez que se pasa por su cabecera empieza una. De cada
    // vuelta se guardan las líneas propias de su cuerpo (no las de un bucle de más adentro: esas van y
    // vienen un número de veces distinto en cada vuelta y no dicen por qué rama se fue).
    const loops = loopsOf(facts.code).slice(0, 8)
    const tracked = loops.map((loop) => ({
      loop,
      inner: loops.filter((other) => other.head > loop.head && other.to <= loop.to),
      laps: [] as number[][],
      lap: null as number[] | null,
    }))
    let last = call
    let end = -1
    const lines = new Set<number>()
    for (let j = i + 1; j < events.length; j++) {
      const event = events[j]
      if (!event) continue
      if (event.o) printed += event.o
      if (event.f !== call.f) continue
      if (event.k === 'return') {
        end = j
        break
      }
      if (event.k === 'line') lines.add(event.l)
      if (event.k === 'line') {
        const at = event.l - facts.line
        for (const track of tracked) {
          if (at === track.loop.head) {
            if (track.lap && track.lap.length > 0) track.laps.push(track.lap)
            track.lap = []
          } else if (at > track.loop.head && at <= track.loop.to) {
            const nested = track.inner.some((other) => at >= other.head && at <= other.to)
            if (!nested && track.lap && track.lap.length < 40 && track.lap.at(-1) !== at)
              track.lap.push(at)
          } else {
            if (track.lap && track.lap.length > 0) track.laps.push(track.lap)
            track.lap = null
          }
        }
      }
      last = event
    }
    for (const track of tracked) if (track.lap && track.lap.length > 0) track.laps.push(track.lap)
    // La traza se cortó antes de que acabara: no hay salida que enseñar.
    if (end < 0) continue
    const before = stateAt(index, i)
    const after = stateAt(index, end)
    const entered = before.frames.find((frame) => frame.id === call.f)
    const left = after.frames.find((frame) => frame.id === call.f)
    const inputs = facts.takes
      .filter((name) => entered !== undefined && name in entered.locals)
      .map((name) => ({ name, value: valueOf(entered?.locals[name] as Shown) }))
    // El bucle que cuenta: el que da una vuelta por cada elemento de lo que entró (en una rejilla, el de las
    // celdas, aunque dentro tenga otro que mire a los vecinos). Si ninguno cuadra, el más interior.
    const sizes = new Set(inputs.map((input) => atomsIn(input.value)).filter((size) => size > 1))
    const usable = tracked.filter((track) => track.laps.length > 1 && track.laps.length <= MAX_LAPS)
    const inner = innerLoop(facts.code)
    const laps = (
      usable.find((track) => sizes.has(track.laps.length)) ??
      usable.find((track) => track.loop.head === inner?.head)
    )?.laps
    const sample: Sample = {
      inputs,
      steps: end - i,
      lines: lines.size,
      invented: false,
      ...(laps ? { paths: laps } : {}),
    }
    if (last.k === 'exception') sample.error = last.e ?? 'error'
    else if (facts.returns || (events[end]?.v ?? null) !== null)
      sample.returned = valueOf(events[end]?.v)
    if (printed !== '') sample.printed = printed
    // Lo que recibió y sigue siendo el mismo objeto, pero ya no vale lo mismo.
    const changed = facts.takes.flatMap((name) => {
      const was = entered?.locals[name]
      const is = left?.locals[name]
      if (was === undefined || is === undefined) return []
      if (entered?.ids[name] === undefined || entered.ids[name] !== left?.ids[name]) return []
      const [a, b] = [valueOf(was), valueOf(is)]
      return showValue(a) === showValue(b) ? [] : [{ name, before: a, after: b }]
    })
    if (changed.length > 0) sample.changed = changed
    const self = facts.owner === null ? undefined : entered?.ids['self']
    if (self !== undefined) {
      const key = String(self)
      const was = fieldsOf(before.heap[key], before.heap)
      const is = fieldsOf(after.heap[key], after.heap)
      const cls = after.heap[key]?.c ?? facts.owner ?? ''
      if (Object.keys(is).length > 0 || !same(was, is))
        sample.self = { cls, before: was, after: is }
    }
    samples.push(sample)
  }
  return samples
}

/** Cuánto ocupa lo que entra: entre dos muestras que enseñan lo mismo, la más pequeña se lee mejor. */
const weight = (sample: Sample): number =>
  sample.inputs.reduce((sum, input) => sum + showValue(input.value).length, 0)

/** Hasta cuántos pasos una muestra sigue siendo «pequeña»: se lee de un vistazo. */
const SMALL = 60

/**
 * La muestra que mejor enseña la función: la que no falla y la que pisa más líneas (más ramas vistas). Entre
 * esas, la que más hace sin dejar de ser pequeña: `factorial(3)` enseña más que `factorial(1)`, que acaba en
 * el primer `return`. Si todas son largas, la más corta. Y a igualdad, la de entrada más pequeña.
 */
export function bestSample(samples: readonly Sample[]): Sample | null {
  const reach = (sample: Sample) => (sample.steps <= SMALL ? sample.steps : -sample.steps)
  const ranked = [...samples].sort(
    (a, b) =>
      Number(a.error !== undefined) - Number(b.error !== undefined) ||
      b.lines - a.lines ||
      reach(b) - reach(a) ||
      weight(a) - weight(b),
  )
  return ranked[0] ?? null
}
