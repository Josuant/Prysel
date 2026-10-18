import type { Program } from '@prysel/python'
import { indexOf, stateAt, type Shown, type Trace, type TraceIndex } from '../trace.ts'
import { hashOf } from './facts.ts'
import { showValue, valueOf, type Value } from './value.ts'

/**
 * «Cómo funciona» un `try`, comprobado: la red de seguridad, una vez que se ejecutó de verdad. Qué se intentó,
 * si saltó un error (en qué línea, cuál), qué `except` lo atrapó y qué hizo con él, o que no saltó nunca; y el
 * `else` y el `finally`, si los hay. Todo sale de la traza: nada de lo que se enseña lo ha escrito una IA.
 */

export interface TryClause {
  kind: 'except' | 'else' | 'finally'
  /** La cabecera, sin los dos puntos: `except ValueError as e`, `else`, `finally`. */
  head: string
  /** Su línea y la última de su cuerpo. */
  line: number
  lineEnd: number
  /** En un `except … as e`, el nombre que recibe el error. */
  alias: string | null
}

export interface TryFacts {
  /** El id de su nodo en el programa. */
  id: string
  line: number
  lineEnd: number
  /** La última línea de lo que se intenta (antes de la primera cláusula). */
  bodyEnd: number
  clauses: TryClause[]
  code: string
  hash: string
}

/** Lo que pasó en una parte del `try` (lo que se intenta, o una cláusula). */
export interface NetPart {
  kind: 'try' | TryClause['kind']
  head: string
  /**
   * `ran`: se ejecutó y llegó al final. `raised`: saltó un error dentro. `caught`: este `except` lo atrapó.
   * `skipped`: no se ejecutó (no hizo falta, o el error no era de su tipo).
   */
  state: 'ran' | 'raised' | 'caught' | 'skipped'
  /** Con `raised`: la línea que lo lanzó, tal como está escrita. */
  at?: string
  printed?: string
  /** Lo que dejó cambiado (en un `except`, por ejemplo, el valor de reserva). */
  leaves?: { name: string; value: Value }[]
}

export interface Net {
  parts: NetPart[]
  /** El error que saltó, si saltó (`ValueError: invalid literal…`). */
  error?: string
  outcome: 'ok' | 'caught' | 'escaped' | 'cut'
  /** Cuántas veces se entró en el `try`, y cómo acabó cada una. */
  tally: { ok: number; caught: number; escaped: number }
}

/** Cuántas veces se mira un mismo `try` para elegir la que mejor lo enseña. */
const MAX_EPISODES = 40
/** Cuántas variables cambiadas se enseñan por parte: tiene que caber. */
const MAX_LEAVES = 3

const CLAUSE = /^\s*(except\b[^:]*|else|finally)\s*:\s*(?:#.*)?$/
const ALIAS = /\bas\s+([A-Za-z_]\w*)\s*$/
const indentOf = (row: string) => row.length - row.trimStart().length

/** Los `try` del programa de los que se puede enseñar cómo funcionan. */
export function triesIn(program: Program): TryFacts[] {
  const rows = program.source.split(/\r?\n/)
  const tries: TryFacts[] = []
  for (const node of program.nodes) {
    if (node.kind !== 'control.try' || !node.contains?.length) continue
    const from = node.line
    const to = node.lineEnd ?? node.line
    const first = rows[from - 1] ?? ''
    if (!/^\s*try\s*:/.test(first)) continue
    const own = indentOf(first)
    // Las cláusulas: las líneas con la misma sangría que el `try` que empiezan por except, else o finally.
    const heads: { line: number; head: string }[] = []
    for (let line = from + 1; line <= to; line++) {
      const row = rows[line - 1] ?? ''
      if (row.trim() === '' || indentOf(row) !== own) continue
      const clause = CLAUSE.exec(row)
      if (clause) heads.push({ line, head: (clause[1] ?? '').trim() })
    }
    if (heads.length === 0) continue
    const clauses = heads.map(({ line, head }, k): TryClause => {
      const kind = head.startsWith('except') ? 'except' : head === 'else' ? 'else' : 'finally'
      return {
        kind,
        head,
        line,
        lineEnd: (heads[k + 1]?.line ?? to + 1) - 1,
        alias: kind === 'except' ? (ALIAS.exec(head)?.[1] ?? null) : null,
      }
    })
    const code = rows.slice(from - 1, to).join('\n')
    tries.push({
      id: node.id,
      line: from,
      lineEnd: to,
      bodyEnd: (heads[0]?.line ?? to + 1) - 1,
      clauses,
      code,
      hash: hashOf(code),
    })
  }
  return tries
}

interface Episode {
  start: number
  /** El paso en el que ya se está fuera (`-1`: la traza se cortó dentro). */
  end: number
  frame: number
  /** El primer error que saltó dentro de lo que se intenta: su paso, su línea y cuál. */
  raised: { step: number; line: number; error: string } | null
  /** Por cada cláusula, el primer y el último paso que pisó su cuerpo (no la cabecera). */
  entered: Map<number, { from: number; to: number }>
  /** El paso en el que se dejó lo que se intenta (el error, o el último paso de su cuerpo). */
  bodyTo: number
  escaped: boolean
}

/** La cláusula (su índice) cuyo cuerpo contiene esta línea, o −1. */
const clauseOf = (facts: TryFacts, line: number) =>
  facts.clauses.findIndex((clause) => line > clause.line && line <= clause.lineEnd)

/** Cada vez que la ejecución entra en el `try` y sale de él. */
function episodesOf(trace: Trace, facts: TryFacts): Episode[] {
  const episodes: Episode[] = []
  const open = new Map<number, Episode>()
  const events = trace.events
  const close = (episode: Episode, at: number) => {
    episode.end = at
    episodes.push(episode)
    open.delete(episode.frame)
  }
  for (let i = 0; i < events.length && episodes.length < MAX_EPISODES; i++) {
    const event = events[i]
    if (!event) continue
    if (event.k === 'end') {
      for (const episode of [...open.values()]) close(episode, i)
      continue
    }
    const current = open.get(event.f)
    if (current) {
      const inBody = event.l > facts.line && event.l <= facts.bodyEnd
      if (event.k === 'exception' && inBody && !current.raised) {
        current.raised = { step: i, line: event.l, error: event.e ?? 'error' }
        current.bodyTo = i
        continue
      }
      if (event.k === 'return') {
        // Sale de la función con un error que nadie atrapó (o con un `return` desde dentro).
        current.escaped = current.raised !== null && !hasExcept(current)
        close(current, i)
        continue
      }
      if (event.k !== 'line') continue
      if (event.l < facts.line || event.l > facts.lineEnd) {
        close(current, i)
        continue
      }
      // Siguió por lo que se intenta después de un error: lo atrapó un `try` de más adentro, no llegó a esta
      // red. Para este `try`, no saltó nada.
      if (inBody && current.raised) current.raised = null
      if (inBody) current.bodyTo = i
      const at = clauseOf(facts, event.l)
      if (at >= 0) {
        const seen = current.entered.get(at)
        current.entered.set(at, { from: seen?.from ?? i, to: i })
      }
      continue
    }
    if (event.k === 'line' && event.l === facts.line) {
      open.set(event.f, {
        start: i,
        end: -1,
        frame: event.f,
        raised: null,
        entered: new Map(),
        bodyTo: i,
        escaped: false,
      })
    }
  }
  for (const episode of open.values()) if (episodes.length < MAX_EPISODES) episodes.push(episode)
  return episodes

  function hasExcept(episode: Episode): boolean {
    return [...episode.entered.keys()].some((at) => facts.clauses[at]?.kind === 'except')
  }
}

const localsAt = (index: TraceIndex, step: number, frame: number) =>
  stateAt(index, step).frames.find((candidate) => candidate.id === frame)?.locals ?? {}

/** Lo impreso entre dos pasos (por cualquier marco: lo que imprime una llamada desde aquí también es suyo). */
function printedBetween(trace: Trace, from: number, to: number): string {
  let text = ''
  for (let i = from + 1; i <= to; i++) text += trace.events[i]?.o ?? ''
  return text
}

const outcomeOf = (facts: TryFacts, episode: Episode): Net['outcome'] => {
  if (!episode.raised) return episode.end < 0 ? 'cut' : 'ok'
  const caught = [...episode.entered.keys()].some((at) => facts.clauses[at]?.kind === 'except')
  return caught ? 'caught' : 'escaped'
}

/** Lo que pasó en una vez que se entró en el `try`, parte a parte. */
function netOf(trace: Trace, index: TraceIndex, facts: TryFacts, episode: Episode): Net {
  const rows = facts.code.split(/\r?\n/)
  const lineText = (line: number) => (rows[line - facts.line] ?? '').trim()
  const shown = (value: Shown | undefined) => showValue(valueOf(value))
  const changes = (from: number, to: number, skip: (string | null)[]) => {
    const before = localsAt(index, from, episode.frame)
    const after = localsAt(index, to, episode.frame)
    return Object.keys(after)
      .filter((name) => !name.startsWith('__') && !skip.includes(name))
      .filter((name) => shown(after[name]) !== shown(before[name]))
      .slice(0, MAX_LEAVES)
      .map((name) => ({ name, value: valueOf(after[name]) }))
  }
  const outcome = outcomeOf(facts, episode)
  const raised = episode.raised
  const tried = printedBetween(trace, episode.start, raised ? raised.step : episode.bodyTo + 1)
  const parts: NetPart[] = [
    {
      kind: 'try',
      head: 'try',
      state: raised ? 'raised' : 'ran',
      ...(raised ? { at: lineText(raised.line) } : {}),
      ...(tried ? { printed: tried } : {}),
    },
    ...facts.clauses.map((clause, at): NetPart => {
      const span = episode.entered.get(at)
      if (!span) return { kind: clause.kind, head: clause.head, state: 'skipped' }
      // El estado en su primera línea es el de antes de ejecutarla; lo que hace la última se ve en el paso siguiente.
      const last = episode.end < 0 ? trace.events.length - 1 : episode.end
      const after = Math.min(span.to + 1, last)
      const printed = printedBetween(trace, span.from, after)
      const leaves = changes(span.from, after, [clause.alias])
      return {
        kind: clause.kind,
        head: clause.head,
        state: clause.kind === 'except' ? 'caught' : 'ran',
        ...(printed ? { printed } : {}),
        ...(leaves.length > 0 ? { leaves } : {}),
      }
    }),
  ]
  return {
    parts,
    ...(raised ? { error: raised.error } : {}),
    outcome,
    tally: { ok: 0, caught: 0, escaped: 0 },
  }
}

/**
 * La vez que mejor enseña el `try`: la que cae en la red (es para lo que está); si no, una en la que el error
 * se escapó; si no, una sin errores. Con el recuento de cómo acabaron todas. `null` si nunca se entró.
 */
export function bestNet(trace: Trace, facts: TryFacts, index = indexOf(trace)): Net | null {
  const episodes = episodesOf(trace, facts)
  if (episodes.length === 0) return null
  const tally = { ok: 0, caught: 0, escaped: 0 }
  for (const episode of episodes) {
    const outcome = outcomeOf(facts, episode)
    if (outcome !== 'cut') tally[outcome]++
  }
  const rank: Record<Net['outcome'], number> = { caught: 3, escaped: 2, ok: 1, cut: 0 }
  const best = [...episodes].sort(
    (a, b) => rank[outcomeOf(facts, b)] - rank[outcomeOf(facts, a)],
  )[0]
  if (!best) return null
  return { ...netOf(trace, index, facts, best), tally }
}
