import type { Program } from '@prysel/python'
import { indexOf, stateAt, type Trace } from '../trace.ts'
import { hashOf } from './facts.ts'
import { fieldsOf } from './sample.ts'
import { showValue, valueOf, type Value } from './value.ts'

/**
 * «Cómo funciona» una clase, comprobado: el plano y la vida de uno de sus objetos, una vez que se ejecutó de
 * verdad. Qué método se llamó y con qué, cómo quedaron sus campos tras cada llamada (y cuáles cambiaron) y qué
 * devolvió. Todo sale de la traza: nada de lo que se enseña lo ha escrito una IA.
 */

export interface ClassFacts {
  /** El id de su nodo en el programa. */
  id: string
  name: string
  line: number
  lineEnd: number
  /** Sus métodos, con sus líneas (la del `def` y la última). */
  methods: { name: string; line: number; lineEnd: number }[]
  code: string
  hash: string
}

/** Una llamada a un método del objeto, desde fuera de él. */
export interface Visit {
  method: string
  /** Cómo se llamó, con los valores que recibió: `Ave(3)` al crearlo, `saltar()`, `mover(1)`. */
  call: string
  /** Lo que valía cada campo (en el orden de `Life.fields`) al acabar la llamada; `undefined`: aún no lo tenía. */
  fields: (Value | undefined)[]
  /** Qué campos cambiaron en esta llamada. */
  changed: boolean[]
  returned?: Value
  /** Salió con un error: cuál. */
  error?: string
}

export interface Life {
  cls: string
  /** Cuántos objetos de la clase recibieron alguna llamada. */
  objects: number
  /** Cuántas llamadas recibió, en total, el objeto que se enseña. */
  total: number
  /** Los campos que se enseñan (los que más cambian, en el orden en que aparecieron). */
  fields: string[]
  visits: Visit[]
  /** Cuántas llamadas no se enseñan, y antes de qué fila. */
  skipped?: { count: number; at: number }
}

/** Cuántas llamadas se enseñan como mucho: con más, las primeras y la última. */
export const MAX_VISITS = 8
/** Cuántos campos caben en una fila. */
const MAX_FIELDS = 3
/** Cuántos argumentos y cuánto de cada uno se escribe en la llamada. */
const MAX_ARGS = 3
const MAX_ARG_TEXT = 8

/** Las clases del programa de las que se puede enseñar cómo funcionan. */
export function classesIn(program: Program): ClassFacts[] {
  const rows = program.source.split(/\r?\n/)
  const classes: ClassFacts[] = []
  for (const node of program.nodes) {
    if (node.kind !== 'abstraction.class' || !node.contains?.length) continue
    const from = node.line
    const to = node.lineEnd ?? node.line
    const methods = program.nodes
      .filter(
        (other) =>
          other.kind === 'abstraction.collapsed' &&
          other.line > from &&
          (other.lineEnd ?? other.line) <= to,
      )
      .map((other) => ({
        name: other.label,
        line: other.line,
        lineEnd: other.lineEnd ?? other.line,
      }))
    if (methods.length === 0) continue
    const code = rows.slice(from - 1, to).join('\n')
    classes.push({
      id: node.id,
      name: node.label,
      line: from,
      lineEnd: to,
      methods,
      code,
      hash: hashOf(code),
    })
  }
  return classes
}

const clipArg = (text: string) =>
  text.length <= MAX_ARG_TEXT ? text : `${text.slice(0, MAX_ARG_TEXT - 1)}…`

interface Raw {
  method: string
  call: string
  after: Record<string, Value>
  returned?: Value
  error?: string
}

/**
 * La vida del objeto de la clase que más se usó: cada llamada a uno de sus métodos desde fuera de él (una
 * llamada de un método a otro del mismo objeto es parte de la primera). `null` si ningún objeto recibió llamadas.
 */
export function bestLife(trace: Trace, facts: ClassFacts, index = indexOf(trace)): Life | null {
  const events = trace.events
  const byObject = new Map<number, Raw[]>()
  /** Las llamadas abiertas de cada objeto: mientras haya una, las de dentro no cuentan. */
  const open = new Map<number, number>()
  /** El marco de cada llamada que se está siguiendo: su objeto y el paso en el que empezó. */
  const frames = new Map<number, { self: number; at: number; method: string; error?: string }>()
  /** Los marcos de las llamadas de dentro (de un método a otro del mismo objeto): su objeto. */
  const nested = new Map<number, number>()
  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (!event) continue
    if (event.k === 'call') {
      const method = facts.methods.find(
        (candidate) =>
          candidate.name === event.fn && event.l >= candidate.line && event.l <= candidate.lineEnd,
      )
      if (!method) continue
      const frame = stateAt(index, i).frames.find((candidate) => candidate.id === event.f)
      const self = frame?.ids['self']
      if (self === undefined) continue
      const depth = open.get(self) ?? 0
      open.set(self, depth + 1)
      if (depth > 0) {
        nested.set(event.f, self)
        continue
      }
      frames.set(event.f, { self, at: i, method: method.name })
      continue
    }
    const tracked = frames.get(event.f)
    if (event.k === 'exception' && tracked) {
      tracked.error = event.e ?? 'error'
      continue
    }
    if (event.k === 'line' && tracked) {
      // Siguió adelante tras el error: lo atrapó un `try` del propio método.
      delete tracked.error
      continue
    }
    if (event.k !== 'return') continue
    // Cerrar también las anidadas: cuentan para saber cuándo vuelve a estar libre el objeto.
    const self = tracked?.self ?? nested.get(event.f)
    nested.delete(event.f)
    if (self !== undefined && (open.get(self) ?? 0) > 0) open.set(self, (open.get(self) ?? 1) - 1)
    if (!tracked) continue
    frames.delete(event.f)
    const entered = stateAt(index, tracked.at)
    const locals = entered.frames.find((frame) => frame.id === event.f)?.locals ?? {}
    const args = Object.entries(locals)
      .filter(([name]) => name !== 'self' && !name.startsWith('__'))
      .slice(0, MAX_ARGS)
      .map(([, value]) => clipArg(showValue(valueOf(value))))
    const creating = tracked.method === '__init__'
    const after = fieldsOf(stateAt(index, i).heap[String(tracked.self)], stateAt(index, i).heap)
    const raw: Raw = {
      method: tracked.method,
      call: `${creating ? facts.name : tracked.method}(${args.join(', ')})`,
      after,
      ...(tracked.error ? { error: tracked.error } : {}),
    }
    if (
      !creating &&
      !tracked.error &&
      event.v !== undefined &&
      event.v !== null &&
      event.v !== 'None'
    )
      raw.returned = valueOf(event.v)
    const list = byObject.get(tracked.self) ?? []
    list.push(raw)
    byObject.set(tracked.self, list)
  }
  if (byObject.size === 0) return null
  const score = (raws: Raw[]) =>
    (raws.length >= 2 && raws.length <= MAX_VISITS ? 100 : 0) + Math.min(raws.length, MAX_VISITS)
  const chosen = [...byObject.values()].sort((a, b) => score(b) - score(a))[0]
  if (!chosen) return null
  // Los campos: en el orden en que aparecen; si son muchos, los que más cambian.
  const order: string[] = []
  const changes = new Map<string, number>()
  let previous: Record<string, Value> = {}
  for (const raw of chosen) {
    for (const name of Object.keys(raw.after)) {
      if (!order.includes(name)) order.push(name)
      if (
        showValue(raw.after[name] as Value) !==
        showValue(previous[name] ?? { kind: 'opaque', text: '' })
      )
        changes.set(name, (changes.get(name) ?? 0) + 1)
    }
    previous = raw.after
  }
  const kept = [...order]
    .sort((a, b) => (changes.get(b) ?? 0) - (changes.get(a) ?? 0))
    .slice(0, MAX_FIELDS)
  const fields = order.filter((name) => kept.includes(name))
  let before: Record<string, Value> = {}
  const visits: Visit[] = chosen.map((raw) => {
    const visit: Visit = {
      method: raw.method,
      call: raw.call,
      fields: fields.map((name) => raw.after[name]),
      changed: fields.map((name) => {
        const is = raw.after[name]
        const was = before[name]
        return is !== undefined && (was === undefined || showValue(is) !== showValue(was))
      }),
      ...(raw.returned ? { returned: raw.returned } : {}),
      ...(raw.error ? { error: raw.error } : {}),
    }
    before = raw.after
    return visit
  })
  const total = visits.length
  return {
    cls: facts.name,
    objects: byObject.size,
    total,
    fields,
    visits:
      total <= MAX_VISITS
        ? visits
        : [...visits.slice(0, MAX_VISITS - 2), ...visits.slice(total - 1)],
    ...(total > MAX_VISITS
      ? { skipped: { count: total - (MAX_VISITS - 1), at: MAX_VISITS - 2 } }
      : {}),
  }
}
