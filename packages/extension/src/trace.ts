/**
 * La traza de una ejecución: qué pasó, línea a línea. Es la base de las lecciones: con ella se reproduce
 * el programa hacia delante y hacia atrás sin volver a ejecutarlo (ni siquiera con Python), y de ella
 * sale lo que se enseña en cada paso (la línea, la pila, el valor de cada variable, lo que se imprimió).
 *
 * Puro: sin motor ni `vscode`. El motor (`runtime/prysel_runner.py`) la graba; aquí se lee.
 */

/** Un valor suelto: un número, un booleano o `None` tal cual, y un texto (o el de un objeto) como su `repr`. */
export type Scalar = number | string | boolean | null

/**
 * Una lista o tupla corta de escalares, entera (hasta 40 elementos): es lo que permite verla como celdas y
 * notar que un elemento cambió aunque esté lejos. `n` es su largo; los elementos de texto van ya con comillas.
 */
export interface ShownList {
  l: Scalar[]
  n: number
  t: 'list' | 'tuple'
}

/** Lo que enseña una traza de un valor: un escalar, una lista corta entera, o un texto corto para lo demás. */
export type Shown = Scalar | ShownList

export const isShownList = (value: Shown | undefined): value is ShownList =>
  typeof value === 'object' && value !== null && Array.isArray((value as ShownList).l)

/**
 * Un atributo de un objeto del programa: una referencia a otro objeto (`{r: id}`), una lista de ellas
 * (`{rl: [...]}`, `null` en los huecos), o un valor como el de cualquier variable.
 */
export type HeapValue = Shown | { r: number } | { rl: (number | null)[] }

/** Un objeto del programa (una instancia de una de sus clases): su clase y sus atributos. */
export interface HeapObject {
  c: string
  f: Record<string, HeapValue>
}

export const isRef = (value: HeapValue | undefined): value is { r: number } =>
  typeof value === 'object' && value !== null && typeof (value as { r?: unknown }).r === 'number'

export const isRefList = (value: HeapValue | undefined): value is { rl: (number | null)[] } =>
  typeof value === 'object' && value !== null && Array.isArray((value as { rl?: unknown }).rl)

/**
 * Un paso de la ejecución. `call`: entra en una función; `line`: está a punto de ejecutarse una línea;
 * `return`: sale de una función con un valor; `exception`: se lanzó un error; `end`: el programa acabó.
 */
export interface TraceEvent {
  k: 'call' | 'line' | 'return' | 'exception' | 'end'
  /** La línea del archivo (base 1). */
  l: number
  /** La profundidad de la pila: 0 es el programa; cada llamada suma uno. */
  d: number
  /** El marco: 0 es el programa; cada llamada es uno nuevo (una recursión tiene varios de la misma función). */
  f: number
  /** El nombre de la función, en una llamada. */
  fn?: string
  /** Solo lo que cambió en las variables del marco desde su evento anterior (o las nuevas). */
  ch?: Record<string, Shown>
  /** La identidad de los objetos mutables que cambiaron: dos nombres con la misma son el mismo objeto. */
  ids?: Record<string, number>
  /** Lo que devuelve, en un retorno. */
  v?: Shown
  /** El error, en una excepción. */
  e?: string
  /** Lo que se imprimió desde el evento anterior. */
  o?: string
  /** Los objetos del programa (por su identidad) que cambiaron o aparecieron: sus atributos, enteros. */
  h?: Record<string, HeapObject>
}

export interface Trace {
  events: TraceEvent[]
  /** Se llegó al tope de pasos: la traza está cortada y el programa no acabó. */
  truncated: boolean
  error: { name: string; message: string; line: number | null } | null
  /** Todo lo que imprimió el programa (el final, si es muy largo). */
  output: string
}

/**
 * Lo que se le da de más a una traza para ver funcionar un programa sin nadie delante: las respuestas de
 * teclado, en orden (cada `input()` toma la siguiente; si se acaban, el programa se queda ahí y la traza
 * lo dice con el error `NoMoreInput`), y una semilla para que su azar salga igual cada vez.
 */
export interface TraceExtra {
  inputs?: readonly string[]
  seed?: number
}

export interface FrameState {
  id: number
  /** `null` en el programa (el marco 0). */
  fn: string | null
  /** La línea en la que está este marco. */
  line: number
  locals: Readonly<Record<string, Shown>>
  ids: Readonly<Record<string, number>>
  /** Está devolviendo este valor: en el siguiente paso el marco desaparece. */
  returned?: { value: Shown }
}

/** Cómo está el programa en un paso: la pila, lo impreso y qué acaba de pasar. */
export interface TraceState {
  /** El paso (base 0); -1 es antes de empezar. */
  step: number
  event: TraceEvent | null
  /** La pila: el programa abajo y la llamada actual arriba. */
  frames: readonly FrameState[]
  /** Lo impreso hasta este paso. */
  output: string
  /** El error que acaba de lanzarse, si este paso es una excepción. */
  error: string | null
  /** Los objetos del programa tal como están en este paso, por su identidad (la misma de `ids`). */
  heap: Readonly<Record<string, HeapObject>>
}

const ROOT: FrameState = { id: 0, fn: null, line: 1, locals: {}, ids: {} }
const NO_HEAP: Readonly<Record<string, HeapObject>> = {}

export const initialState = (): TraceState => ({
  step: -1,
  event: null,
  frames: [ROOT],
  output: '',
  error: null,
  heap: NO_HEAP,
})

/** Las variables del marco con lo que cambió: lo nuevo entra, y lo que dejó de ser un objeto pierde su identidad. */
function merged(frame: FrameState, event: TraceEvent): FrameState {
  if (!event.ch && !event.ids) return frame
  const locals = { ...frame.locals, ...event.ch }
  // Lo que cambió pierde su identidad anterior y toma la nueva, si sigue siendo un objeto.
  const changed = new Set(Object.keys(event.ch ?? {}))
  const ids = Object.fromEntries(Object.entries(frame.ids).filter(([name]) => !changed.has(name)))
  for (const name of changed) {
    const id = event.ids?.[name]
    if (id !== undefined) ids[name] = id
  }
  return { ...frame, locals, ids }
}

/** El estado tras un evento. No modifica el anterior: cada paso conserva el suyo. */
export function apply(state: TraceState, event: TraceEvent): TraceState {
  // Un marco que devolvió un valor se enseñó en su paso; ahora desaparece.
  let frames = state.frames
  const top = frames[frames.length - 1]
  if (top?.returned && frames.length > 1) frames = frames.slice(0, -1)

  if (event.k === 'call') {
    const fresh: FrameState = {
      id: event.f,
      fn: event.fn ?? null,
      line: event.l,
      locals: {},
      ids: {},
    }
    frames = [...frames, merged(fresh, event)]
  } else {
    const at = frames.findLastIndex((frame) => frame.id === event.f)
    const target = frames[at]
    if (target) {
      let next = merged({ ...target, line: event.l }, event)
      if (event.k === 'return' || event.k === 'end')
        next = { ...next, returned: { value: event.v ?? null } }
      frames = [...frames.slice(0, at), next, ...frames.slice(at + 1)]
    }
  }
  return {
    step: state.step + 1,
    event,
    frames,
    output: event.o ? state.output + event.o : state.output,
    error: event.k === 'exception' ? (event.e ?? 'error') : null,
    // Solo cambia si el paso trae objetos nuevos o cambiados: si no, se comparte con el anterior.
    heap: event.h ? { ...state.heap, ...event.h } : state.heap,
  }
}

/** Una traza lista para saltar a cualquier paso: guarda el estado cada cierto número de pasos. */
export interface TraceIndex {
  trace: Trace
  every: number
  /** El estado tras el paso `i * every - 1` (el 0 es el inicial). */
  checkpoints: TraceState[]
}

export function indexOf(trace: Trace, every = 64): TraceIndex {
  const checkpoints = [initialState()]
  let state = checkpoints[0] as TraceState
  for (const event of trace.events) {
    state = apply(state, event)
    if ((state.step + 1) % every === 0) checkpoints.push(state)
  }
  return { trace, every, checkpoints }
}

/** El estado tras el paso `step` (−1: antes de empezar). Ir hacia atrás o saltar cuesta lo mismo que ir hacia delante. */
export function stateAt(index: TraceIndex, step: number): TraceState {
  const last = index.trace.events.length - 1
  const wanted = Math.max(-1, Math.min(step, last))
  const from = Math.floor((wanted + 1) / index.every)
  let state = index.checkpoints[from] ?? (index.checkpoints[0] as TraceState)
  for (let i = state.step + 1; i <= wanted; i++) {
    const event = index.trace.events[i]
    if (event) state = apply(state, event)
  }
  return state
}

/** El nombre y el valor de las variables visibles, de la llamada actual hacia el programa. */
export function visibleLocals(state: TraceState): { name: string; value: Shown; frame: number }[] {
  const seen = new Set<string>()
  const found: { name: string; value: Shown; frame: number }[] = []
  for (const frame of [...state.frames].reverse()) {
    for (const [name, value] of Object.entries(frame.locals)) {
      if (seen.has(name)) continue
      seen.add(name)
      found.push({ name, value, frame: frame.id })
    }
  }
  return found
}

/** Un resumen de la traza para enseñarlo: cuántos pasos, cuántas llamadas y qué profundidad alcanza. */
export function describeTrace(trace: Trace): {
  steps: number
  calls: number
  depth: number
  lines: number
} {
  let calls = 0
  let depth = 0
  const lines = new Set<number>()
  for (const event of trace.events) {
    if (event.k === 'call') calls++
    depth = Math.max(depth, event.d)
    if (event.k === 'line') lines.add(event.l)
  }
  return { steps: trace.events.length, calls, depth, lines: lines.size }
}
