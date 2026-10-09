import type { Program } from '@prysel/python'
import { indexOf, stateAt, type Shown, type Trace, type TraceIndex } from '../trace.ts'
import { hashOf } from './facts.ts'
import { showValue, valueOf, type Value } from './value.ts'

/**
 * «Cómo funciona» un bucle, comprobado: una vez que se ejecutó de verdad, vuelta a vuelta. Qué elemento
 * entró en cada vuelta, cómo cambiaron las variables que el bucle va llevando (`total` 0 → 1 → 3 → 6), qué
 * imprimió, y por qué acabó (se acabaron los elementos, la condición dejó de cumplirse, un `break`). Todo sale
 * de la traza: nada de lo que se enseña lo ha escrito una IA.
 */

export interface LoopFacts {
  /** El id de su nodo en el programa. */
  id: string
  kind: 'for' | 'while'
  line: number
  lineEnd: number
  /** La cabecera, sin los dos puntos: `for x in numeros`, `while n > 0`. */
  head: string
  /** En un `for`, los nombres que toma cada vuelta (`x`, o `i, valor`). */
  targets: string[]
  /** En un `while`, su condición. */
  test: string | null
  /** Los nombres que toman los bucles de dentro: van y vienen en cada vuelta, no los lleva este. */
  inner: string[]
  /** Las líneas (desde la de la cabecera, que es la 0) que son un `break` o un `continue`. */
  breaks: number[]
  continues: number[]
  code: string
  hash: string
}

export interface Lap {
  /** Lo que tomó cada nombre de la cabecera en esta vuelta (en un `for`). */
  takes: { name: string; value: Value }[]
  /** Cómo quedaron, al acabar la vuelta, las variables que el bucle va cambiando. */
  leaves: { name: string; value: Value; changed: boolean }[]
  printed?: string
  /** La vuelta acabó con un `break` o pasó por un `continue`. */
  exit?: 'break' | 'continue'
}

export interface Laps {
  /** Las variables que el bucle va llevando, con lo que valían al entrar. */
  carried: { name: string; value: Value }[]
  /** Las vueltas que se enseñan (con muchas, las primeras y la última). */
  laps: Lap[]
  /** Cuántas vueltas dio de verdad. */
  total: number
  /** Cuántas vueltas se saltaron al enseñarlas, y dónde (antes de la vuelta con ese índice en `laps`). */
  skipped?: { count: number; at: number }
  /** Por qué acabó. */
  ended: 'done' | 'break' | 'return' | 'error' | 'cut'
  /** Con `error`: cuál. */
  error?: string
}

/** Cuántas vueltas se enseñan como mucho: más ya no se leen, se cuentan. */
export const MAX_LAPS = 8
/** Cuántas variables llevadas se enseñan, como mucho: una fila por vuelta tiene que caber. */
const MAX_CARRIED = 3
/** Cuántas ejecuciones de un mismo bucle se miran para elegir la que mejor lo enseña. */
const MAX_EPISODES = 40

const FOR = /^\s*(?:async\s+)?for\s+(.+?)\s+in\s+(.+?):\s*(?:#.*)?$/
const WHILE = /^\s*while\s+(.+?):\s*(?:#.*)?$/

/** Los nombres de la cabecera de un `for`: `x`, `i, valor`, `(a, b)`. Sin los de dentro de un desempaquetado raro. */
export function targetsOf(text: string): string[] {
  return text
    .replace(/[()[\]]/g, ' ')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z_]\w*$/.test(name))
}

const indentOf = (row: string) => row.length - row.trimStart().length

/** Los bucles del programa de los que se puede enseñar cómo funcionan. */
export function loopsIn(program: Program): LoopFacts[] {
  const rows = program.source.split(/\r?\n/)
  const loops: LoopFacts[] = []
  for (const node of program.nodes) {
    if (node.kind !== 'control.loop' || !node.contains?.length) continue
    const from = node.line
    const to = node.lineEnd ?? node.line
    const first = rows[from - 1] ?? ''
    const isFor = FOR.exec(first)
    const isWhile = isFor ? null : WHILE.exec(first)
    if (!isFor && !isWhile) continue
    const code = rows.slice(from - 1, to).join('\n')
    const own = indentOf(first)
    const body = rows.slice(from, to)
    // Un `break` o un `continue` de un bucle de dentro no es de este.
    const nested = (at: number): boolean => {
      for (let k = at - 1; k >= 0; k--) {
        const row = body[k] ?? ''
        if (row.trim() === '' || indentOf(row) >= indentOf(body[at] ?? '')) continue
        if (indentOf(row) <= own) return false
        if (/^\s*(?:async\s+)?(?:for|while)\b/.test(row)) return true
      }
      return false
    }
    const marks = (word: string) =>
      body.flatMap((row, at) =>
        new RegExp(`^\\s*${word}\\s*(?:#.*)?$`).test(row) && !nested(at) ? [at + 1] : [],
      )
    loops.push({
      id: node.id,
      kind: isFor ? 'for' : 'while',
      line: from,
      lineEnd: to,
      head: first.trim().replace(/:\s*(?:#.*)?$/, ''),
      targets: isFor ? targetsOf(isFor[1] ?? '') : [],
      inner: body.flatMap((row) => {
        const head = FOR.exec(row)
        return head ? targetsOf(head[1] ?? '') : []
      }),
      test: isWhile ? (isWhile[1] ?? null) : null,
      breaks: marks('break'),
      continues: marks('continue'),
      code,
      hash: hashOf(code),
    })
  }
  return loops
}

interface Episode {
  /** El paso en el que se entra en el bucle (la primera vez que se llega a su cabecera). */
  start: number
  /** Los pasos en los que se pasa por la cabecera. */
  heads: number[]
  /** El paso en el que ya se está fuera (`-1`: la traza se cortó dentro). */
  end: number
  /** La última línea que se pisó dentro, antes de salir. */
  lastLine: number
  ended: Laps['ended']
  error?: string
  frame: number
}

/** Cada vez que la ejecución entra en el bucle y sale de él. */
function episodesOf(trace: Trace, facts: LoopFacts): Episode[] {
  const episodes: Episode[] = []
  const open = new Map<number, Episode>()
  const events = trace.events
  for (let i = 0; i < events.length && episodes.length < MAX_EPISODES; i++) {
    const event = events[i]
    if (!event) continue
    // El programa acabó: lo que quedaba abierto acaba aquí (desde la cabecera, o desde dentro).
    if (event.k === 'end') {
      for (const episode of open.values()) {
        episode.end = i
        episode.ended = episode.lastLine === facts.line ? 'done' : 'break'
        episodes.push(episode)
      }
      open.clear()
      continue
    }
    const current = open.get(event.f)
    const inside = event.l >= facts.line && event.l <= facts.lineEnd
    if (current) {
      if (event.k === 'exception' && event.f === current.frame) current.error = event.e ?? 'error'
      if (event.k === 'return') {
        current.end = i
        // La función acaba justo tras el bucle (era lo último que hacía): si se sale desde la cabecera, el
        // bucle terminó por sí mismo, como cuando después viene otra línea. Solo es un `return` si se sale
        // desde dentro.
        const fromHead = current.lastLine === facts.line
        current.ended = current.error !== undefined ? 'error' : fromHead ? 'done' : 'return'
        episodes.push(current)
        open.delete(event.f)
        continue
      }
      if (event.k !== 'line') continue
      // Siguió adelante tras un error: lo atrapó un `try` de dentro. No es un fallo del bucle.
      delete current.error
      if (event.l === facts.line) {
        current.heads.push(i)
        current.lastLine = facts.line
      } else if (inside) current.lastLine = event.l
      else {
        current.end = i
        // Se sale desde la cabecera (sin elementos, o la condición ya no se cumple), o desde dentro: un `break`.
        const fromHead = current.lastLine === facts.line
        current.ended = fromHead ? 'done' : 'break'
        episodes.push(current)
        open.delete(event.f)
      }
      continue
    }
    if (event.k === 'line' && event.l === facts.line) {
      open.set(event.f, {
        start: i,
        heads: [i],
        end: -1,
        lastLine: facts.line,
        ended: 'cut',
        frame: event.f,
      })
    }
  }
  for (const episode of open.values()) if (episodes.length < MAX_EPISODES) episodes.push(episode)
  return episodes
}

const localsAt = (index: TraceIndex, step: number, frame: number) =>
  stateAt(index, step).frames.find((candidate) => candidate.id === frame)?.locals ?? {}

/** Lo impreso entre dos pasos (por cualquier marco: lo que imprime una llamada desde el bucle también es suyo). */
function printedBetween(trace: Trace, from: number, to: number): string {
  let text = ''
  for (let i = from + 1; i <= to; i++) text += trace.events[i]?.o ?? ''
  return text
}

/** Las vueltas de una ejecución del bucle, con lo que tomó y dejó cada una. */
function lapsOf(trace: Trace, index: TraceIndex, facts: LoopFacts, episode: Episode): Laps {
  const { heads, frame } = episode
  const close = episode.end < 0 ? trace.events.length - 1 : episode.end
  // Una vuelta va de una pasada por la cabecera a la siguiente (o a la salida, si salió desde dentro).
  const spans: { from: number; to: number }[] = []
  for (const [k, head] of heads.entries()) {
    const next = heads[k + 1] ?? close
    // Tras la última cabecera, si se salió desde ella, no hubo vuelta: fue la comprobación final.
    if (k === heads.length - 1 && episode.ended === 'done') break
    spans.push({ from: head, to: next })
  }
  const opening = localsAt(index, episode.start, frame)
  const shown = (value: Shown | undefined) => showValue(valueOf(value))
  // Lo que el bucle va llevando: lo que cambia de una vuelta a otra y no es el elemento de la cabecera.
  const carried: string[] = []
  let before = opening
  const ends = spans.map((span) => localsAt(index, span.to, frame))
  for (const after of ends) {
    for (const name of Object.keys(after)) {
      if (facts.targets.includes(name) || facts.inner.includes(name)) continue
      if (carried.includes(name) || name.startsWith('__')) continue
      if (shown(after[name]) !== shown(before[name])) carried.push(name)
    }
    before = after
  }
  const kept = carried.slice(0, MAX_CARRIED)
  const lineOf = (step: number) => trace.events[step]?.l ?? 0
  const laps: Lap[] = spans.map((span, k) => {
    // El elemento de la vuelta ya está asignado en el primer paso dentro del cuerpo.
    const into = localsAt(index, Math.min(span.from + 1, span.to), frame)
    const out = ends[k] ?? {}
    const was = k === 0 ? opening : (ends[k - 1] ?? {})
    const printed = printedBetween(trace, span.from, span.to)
    const visited = new Set<number>()
    for (let i = span.from; i <= span.to; i++) {
      const event = trace.events[i]
      if (event?.f === frame && event.k === 'line') visited.add(event.l - facts.line)
    }
    const breaks =
      k === spans.length - 1 &&
      episode.ended === 'break' &&
      facts.breaks.includes(lineOf(span.to - 1) - facts.line)
    const continues = facts.continues.some((at) => visited.has(at))
    return {
      takes: facts.targets
        .filter((name) => name in into)
        .map((name) => ({ name, value: valueOf(into[name]) })),
      leaves: kept.map((name) => ({
        name,
        value: valueOf(out[name]),
        changed: shown(out[name]) !== shown(was[name]),
      })),
      ...(printed ? { printed } : {}),
      ...(breaks ? { exit: 'break' as const } : continues ? { exit: 'continue' as const } : {}),
    }
  })
  const total = laps.length
  const shownLaps =
    total <= MAX_LAPS ? laps : [...laps.slice(0, MAX_LAPS - 2), ...laps.slice(total - 1)]
  return {
    carried: kept
      .filter((name) => name in opening)
      .map((name) => ({ name, value: valueOf(opening[name]) })),
    laps: shownLaps,
    total,
    ...(total > MAX_LAPS ? { skipped: { count: total - (MAX_LAPS - 1), at: MAX_LAPS - 2 } } : {}),
    ended: episode.ended,
    ...(episode.error !== undefined ? { error: episode.error } : {}),
  }
}

/**
 * La ejecución que mejor enseña el bucle: la que da varias vueltas sin ser larga (de 2 a 8), cambiando algo;
 * si no, la más corta que dé alguna. `null` si nunca dio ninguna vuelta.
 */
export function bestLaps(trace: Trace, facts: LoopFacts, index = indexOf(trace)): Laps | null {
  const all = episodesOf(trace, facts).map((episode) => lapsOf(trace, index, facts, episode))
  const score = (laps: Laps) =>
    (laps.total >= 2 && laps.total <= MAX_LAPS ? 100 : 0) +
    (laps.carried.length > 0 || laps.laps.some((lap) => lap.printed) ? 50 : 0) +
    (laps.ended === 'cut' || laps.ended === 'error' ? -40 : 0) +
    Math.min(laps.total, MAX_LAPS)
  const ranked = all.filter((laps) => laps.total > 0).sort((a, b) => score(b) - score(a))
  return ranked[0] ?? null
}
