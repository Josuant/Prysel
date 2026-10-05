import type { Program, ProgramNode } from '@prysel/python'
import type { Decider, JevQuestion } from './client.ts'

/**
 * El contexto que se le pasa a la IA generativa: **lo que hace falta ver para cumplir la orden, y no más**.
 *
 * Un programa corto se manda entero. Uno largo no cabe (ni conviene: lo que sobra distrae), así que se
 * parte en trozos con sentido —cada función, cada clase, cada tramo de sentencias sueltas— y se manda:
 * - un **índice** de todo el archivo (qué hay y en qué líneas), para que el modelo sepa dónde está;
 * - el texto de los trozos que **hay que** ver (donde se va a escribir, lo seleccionado, lo último que se hizo);
 * - y, de los demás, los que el **JEV** dice que hacen falta para esa orden. Se le pregunta por todos a la
 *   vez, en una sola petición: es rápido, y la misma orden sobre el mismo programa da siempre el mismo contexto.
 *
 * El código va **con sus números de línea**: es lo que deja al modelo decir «cambia la línea 12» cuando se le
 * pide modificar lo que ya está escrito.
 */

/** Hasta aquí, el programa se manda entero. */
export const WHOLE_BUDGET = 6000
/** Con un programa largo, cuánto texto de trozos se manda como mucho. */
export const REGION_BUDGET = 7000
/** A partir de aquí, el JEV considera que un trozo hace falta. */
export const RELEVANT = 0.5
/** Más trozos que estos no se le preguntan al JEV de una vez. */
const MAX_ASKED = 60

/** Un trozo del archivo con sentido propio. */
export interface Region {
  /** Su nombre corto, con el que se le pregunta al JEV (`r3`). */
  ref: string
  title: string
  from: number
  to: number
}

const isBlock = (node: ProgramNode) =>
  node.kind === 'abstraction.collapsed' || node.kind === 'abstraction.class'

/** El código con sus números de línea (`12| total = 0`), de una línea a otra (ambas incluidas). */
export function numbered(source: string, from = 1, to = Number.POSITIVE_INFINITY): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const width = String(Math.min(to, lines.length)).length
  return lines
    .map((line, index) => ({ line, n: index + 1 }))
    .filter(({ n }) => n >= from && n <= to)
    .map(({ line, n }) => `${String(n).padStart(width)}| ${line}`)
    .join('\n')
}

/**
 * Los trozos del archivo: cada función o clase de primer nivel es uno; las sentencias sueltas que hay entre
 * ellas, juntas, son otro.
 */
export function regionsOf(program: Program): Region[] {
  const top = program.nodes
    .filter((node) => node.range !== undefined && node.range.owner === undefined)
    .sort((a, b) => a.line - b.line)
  const regions: Omit<Region, 'ref'>[] = []
  let loose: { from: number; to: number; first: string } | null = null
  const flush = () => {
    if (!loose) return
    regions.push({
      title: `sentencias sueltas, desde «${loose.first}»`,
      from: loose.from,
      to: loose.to,
    })
    loose = null
  }
  for (const node of top) {
    const from = node.line
    const to = node.lineEnd ?? node.line
    const head = ((node.text ?? node.label).split(/\r?\n/)[0] ?? '').trim().slice(0, 70)
    if (isBlock(node)) {
      flush()
      regions.push({ title: head, from, to })
    } else if (loose) loose.to = to
    else loose = { from, to, first: head }
  }
  flush()
  return regions.map((region, index) => ({ ...region, ref: `r${index + 1}` }))
}

/** El índice del archivo: una línea por trozo, con sus líneas. */
export function outlineOf(regions: readonly Region[]): string {
  return regions.map((r) => `líneas ${r.from}–${r.to}: ${r.title}`).join('\n')
}

export interface ContextRequest {
  command: string
  program: Program
  /** Líneas que hay que ver sí o sí: donde se escribe, lo seleccionado, lo último que se hizo. */
  must?: readonly number[]
}

export interface Context {
  /** Lo que se pega en la petición a la IA generativa. */
  text: string
  /** Si va el programa entero, o solo una parte. */
  whole: boolean
  /** Lo que tardó el JEV en elegir los trozos (0 si no hizo falta preguntarle). */
  jevMs: number
  /** Los trozos que se mandan, cuando no va entero. */
  regions: Region[]
}

/** Lo que se le pregunta al JEV de cada trozo: ¿hace falta verlo para esta orden? */
export function regionQuestions(regions: readonly Region[]): Record<string, JevQuestion> {
  return Object.fromEntries(
    regions.map((region) => [
      region.ref,
      {
        type: 'noul',
        instructions: `Para cumplir la \`orden\` sobre un programa en Python, ¿hace falta leer este trozo? Líneas ${region.from}–${region.to}: ${region.title}`,
        criteria: {
          true: 'La orden lo nombra, lo cambia, lo usa, o lo nuevo tiene que encajar con él.',
          false: 'No tiene que ver con lo que se pide.',
        },
      } satisfies JevQuestion,
    ]),
  )
}

export async function contextFor(decider: Decider, request: ContextRequest): Promise<Context> {
  const { program, command } = request
  const source = program.source
  if (source.trim() === '') {
    return { text: 'El programa está vacío.', whole: true, jevMs: 0, regions: [] }
  }
  if (source.length <= WHOLE_BUDGET) {
    return {
      text: `El programa, con sus números de línea:\n${numbered(source)}`,
      whole: true,
      jevMs: 0,
      regions: [],
    }
  }
  const regions = regionsOf(program)
  const must = new Set(
    regions
      .filter((region) =>
        (request.must ?? []).some((line) => line >= region.from && line <= region.to),
      )
      .map((region) => region.ref),
  )
  // El JEV dice cuáles de los demás hacen falta: todos a la vez, en una petición.
  const others = regions.filter((region) => !must.has(region.ref)).slice(0, MAX_ASKED)
  const scores = new Map<string, number>()
  let jevMs = 0
  if (others.length > 0) {
    try {
      const { answers, ms } = await decider.decide({
        state: { orden: command },
        questions: regionQuestions(others),
      })
      jevMs = ms
      for (const region of others) {
        const answer = answers[region.ref]
        scores.set(region.ref, answer?.type === 'noul' ? answer.noul : 0)
      }
    } catch {
      // Sin el JEV, se manda lo imprescindible: el índice y los trozos obligados.
    }
  }
  // Primero lo obligado; luego lo que el JEV da por necesario, de más a menos, hasta llenar el cupo.
  const wanted = [
    ...regions.filter((region) => must.has(region.ref)),
    ...others
      .filter((region) => (scores.get(region.ref) ?? 0) >= RELEVANT)
      .sort((a, b) => (scores.get(b.ref) ?? 0) - (scores.get(a.ref) ?? 0)),
  ]
  const chosen: Region[] = []
  let used = 0
  for (const region of wanted) {
    const size = numbered(source, region.from, region.to).length
    if (chosen.length > 0 && used + size > REGION_BUDGET) continue
    chosen.push(region)
    used += size
  }
  chosen.sort((a, b) => a.from - b.from)
  const text = [
    `El programa es largo (${source.split('\n').length} líneas). Su índice:\n${outlineOf(regions)}`,
    chosen.length > 0
      ? `Los trozos que hacen falta, con sus números de línea:\n${chosen
          .map((region) => numbered(source, region.from, region.to))
          .join('\n   ⋮\n')}`
      : '',
  ]
    .filter((part) => part !== '')
    .join('\n\n')
  return { text, whole: false, jevMs, regions: chosen }
}
