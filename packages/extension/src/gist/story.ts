import type { Program } from '@prysel/python'
import { isShownList, type Shown, type Trace } from '../trace.ts'
import { functionsIn } from './facts.ts'
import { episodesOf, loopsIn, type Laps } from './laps.ts'

/**
 * La **historia** de una ejecución: no quién llama a quién, sino qué pasa, en qué orden, y qué viaja de un
 * paso al siguiente.
 *
 * Un algoritmo que se repite se entiende por su vuelta: «puntuar → elegir → cruzar → reponer, y otra vez». El
 * grafo de llamadas no lo dice (ahí «elegir» cuelga de «reponer», y lo que se hace una sola vez antes de
 * empezar parece un paso más). La traza sí: aquí se busca el bucle que lleva el programa, se mira una vuelta
 * suya y se apunta a qué funciones se llama, en orden, sea quien sea quien las llama; cuáles se usaron antes
 * de la primera vuelta y cuáles al salir; y qué valor que devolvió una acabó entrando en otra.
 *
 * Es puro y no interpreta: todo sale de lo que de verdad se ejecutó.
 */

/** Algo que viaja de un paso a otro: lo que devolvió `from` es lo que recibió `to`, con ese nombre. */
export interface Flow {
  from: string
  to: string
  /** Cómo se llama al llegar (el parámetro que lo recibe). */
  name: string
  /** Si es una colección, cuántos elementos lleva. */
  size?: number
  /** Una muestra corta de lo que es. */
  text: string
}

export interface Story {
  /** El bucle que lleva el programa: su cabecera, cuántas vueltas dio y cómo acabó. */
  loop: { line: number; head: string; laps: number; ended: Laps['ended'] }
  /** Las funciones que se usaron antes de la primera vuelta, en su orden. */
  before: string[]
  /** Las de cada vuelta, en el orden en que entran (también las que llama otra función de la vuelta). */
  ring: string[]
  /** Las que se usaron al salir del bucle. */
  after: string[]
  flows: Flow[]
}

/** Las funciones propias a las que se llama entre dos pasos de la traza, en el orden en que entran. */
function calledBetween(trace: Trace, own: ReadonlySet<string>, from: number, to: number): string[] {
  const found: string[] = []
  for (let i = Math.max(0, from); i < to && i < trace.events.length; i++) {
    const event = trace.events[i]
    if (event?.k === 'call' && event.fn !== undefined && own.has(event.fn)) {
      if (!found.includes(event.fn)) found.push(event.fn)
    }
  }
  return found
}

/** Las funciones en las que se está (aún no han devuelto) al llegar a ese paso de la traza. */
function openAt(trace: Trace, step: number): Set<string> {
  const open = new Map<number, string>()
  for (let i = 0; i < step && i < trace.events.length; i++) {
    const event = trace.events[i]
    if (event?.k === 'call' && event.fn !== undefined) open.set(event.f, event.fn)
    else if (event?.k === 'return') open.delete(event.f)
  }
  return new Set(open.values())
}

/** Un valor con el que tiene sentido seguir la pista: una colección, o un texto de verdad. */
const traceable = (value: Shown): boolean =>
  isShownList(value)
    ? value.n > 0
    : typeof value === 'string' && /^['"]/.test(value) && value.length >= 5

const clip = (text: string, max = 28) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

function tokenOf(value: Shown): Pick<Flow, 'size' | 'text'> {
  if (isShownList(value)) {
    const shown = value.l.slice(0, 2).map((item) => String(item))
    return {
      size: value.n,
      text: clip(`${shown.join(', ')}${value.n > shown.length ? ', …' : ''}`),
    }
  }
  return { text: clip(String(value)) }
}

/**
 * Lo que viaja: cada vez que una función propia recibe un valor que otra acababa de devolver. Se compara lo
 * que la traza enseña de cada valor, así que solo cuentan los que dicen algo (una colección, un texto).
 */
function flowsIn(trace: Trace, own: ReadonlySet<string>, to: number): Flow[] {
  const fnOf = new Map<number, string>()
  /** Lo último que devolvió cada cosa, por cómo se ve: quién fue. */
  const returned = new Map<string, string>()
  const flows: Flow[] = []
  for (let i = 0; i < to && i < trace.events.length; i++) {
    const event = trace.events[i]
    if (!event) continue
    if (event.k === 'call' && event.fn !== undefined) {
      fnOf.set(event.f, event.fn)
      if (!own.has(event.fn)) continue
      for (const [name, value] of Object.entries(event.ch ?? {})) {
        if (!traceable(value)) continue
        const from = returned.get(JSON.stringify(value))
        if (from === undefined || from === event.fn) continue
        if (
          flows.some((flow) => flow.from === from && flow.to === event.fn && flow.name === name)
        ) {
          continue
        }
        flows.push({ from, to: event.fn, name, ...tokenOf(value) })
      }
    } else if (event.k === 'return' && event.v !== undefined) {
      const fn = fnOf.get(event.f)
      if (fn === undefined || !own.has(fn)) continue
      if (traceable(event.v)) returned.set(JSON.stringify(event.v), fn)
      // Lo que se devuelve en un par («los dos padres») se reparte luego en dos nombres: cada uno cuenta.
      if (isShownList(event.v) && event.v.t === 'tuple' && event.v.l.length <= 4) {
        for (const part of event.v.l) {
          if (traceable(part)) returned.set(JSON.stringify(part), fn)
        }
      }
    }
  }
  return flows
}

/**
 * La historia del programa tal como se ejecutó, o `null` si no la lleva un bucle que use al menos dos de sus
 * funciones en cada vuelta (un programa que no se repite se cuenta de otra manera).
 */
export function storyOf(program: Program, trace: Trace): Story | null {
  const own = new Set(functionsIn(program).map((fact) => fact.name))
  if (own.size < 2) return null
  let best: { story: Story; start: number } | null = null
  for (const loop of loopsIn(program)) {
    // De las veces que se entró en este bucle, la que más vueltas dio.
    const episode = episodesOf(trace, loop).sort((a, b) => b.heads.length - a.heads.length)[0]
    if (!episode || episode.heads.length === 0) continue
    const end = episode.end < 0 ? trace.events.length : episode.end
    const bounds = [...episode.heads, end]
    // La vuelta que mejor lo cuenta: de las primeras, la que usa más funciones (la primera puede salir pronto).
    let ring: string[] = []
    let chosen = 0
    for (let lap = 0; lap < Math.min(4, episode.heads.length); lap++) {
      const called = calledBetween(trace, own, bounds[lap] ?? 0, bounds[lap + 1] ?? end)
      if (called.length > ring.length) {
        ring = called
        chosen = lap
      }
    }
    if (ring.length < 2) continue
    // Si empatan, el de más fuera (el que empezó antes): los de dentro son parte de sus pasos.
    if (
      best &&
      (ring.length < best.story.ring.length ||
        (ring.length === best.story.ring.length && episode.start >= best.start))
    ) {
      continue
    }
    // Lo que viaja se mira hasta la vuelta siguiente a la elegida: así se ve también lo que una vuelta le
    // deja a la que viene.
    const upTo = bounds[chosen + 2] ?? end
    const relevant = new Set(ring)
    // Las funciones en las que ya se estaba al llegar al bucle (la que lo contiene, y quien la llamó) no son
    // «lo de antes»: son donde ocurre todo.
    const around = openAt(trace, episode.start)
    const before = calledBetween(trace, own, 0, episode.start).filter((fn) => !around.has(fn))
    best = {
      start: episode.start,
      story: {
        loop: {
          line: loop.line,
          head: loop.head,
          // Pasar por la cabecera una vez más de las que se entra es lo normal: la última comprueba y sale.
          laps: Math.max(
            1,
            episode.ended === 'done' ? episode.heads.length - 1 : episode.heads.length,
          ),
          ended: episode.ended,
        },
        before: before.filter((fn) => !relevant.has(fn)),
        ring,
        after: calledBetween(trace, own, end, trace.events.length).filter(
          (fn) => !relevant.has(fn) && !before.includes(fn),
        ),
        flows: flowsIn(trace, own, upTo).filter(
          (flow) => relevant.has(flow.to) || relevant.has(flow.from),
        ),
      },
    }
  }
  return best?.story ?? null
}
