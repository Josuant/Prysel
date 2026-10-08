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
  /** Con `invented`: la llamada que se probó. */
  call?: string
}

/** Cuántas llamadas se miran como mucho: de sobra para elegir, y no cuesta en un bucle largo. */
const MAX_CALLS = 60

const fieldsOf = (
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
      last = event
    }
    // La traza se cortó antes de que acabara: no hay salida que enseñar.
    if (end < 0) continue
    const before = stateAt(index, i)
    const after = stateAt(index, end)
    const entered = before.frames.find((frame) => frame.id === call.f)
    const left = after.frames.find((frame) => frame.id === call.f)
    const sample: Sample = {
      inputs: facts.takes
        .filter((name) => entered !== undefined && name in entered.locals)
        .map((name) => ({ name, value: valueOf(entered?.locals[name] as Shown) })),
      steps: end - i,
      lines: lines.size,
      invented: false,
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

/**
 * La muestra que mejor enseña la función: la que no falla, la que pisa más líneas (más ramas vistas), y
 * entre esas, la más corta y la de entrada más pequeña.
 */
export function bestSample(samples: readonly Sample[]): Sample | null {
  const ranked = [...samples].sort(
    (a, b) =>
      Number(a.error !== undefined) - Number(b.error !== undefined) ||
      b.lines - a.lines ||
      a.steps - b.steps ||
      weight(a) - weight(b),
  )
  return ranked[0] ?? null
}
