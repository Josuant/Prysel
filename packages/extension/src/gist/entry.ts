import type { Program } from '@prysel/python'
import type { Trace } from '../trace.ts'
import { functionsIn, type Facts } from './facts.ts'

/**
 * Si un programa **hace algo que se vea**, y por dónde arranca.
 *
 * Quien pide «un algoritmo genético» espera verlo funcionar. Un programa que solo define funciones y no llama
 * a ninguna termina sin error y sin enseñar nada: «terminó bien» es verdad y no le sirve a nadie. Aquí se
 * distingue ese caso (y el de un programa que trabaja pero no enseña el resultado), y se busca la función que
 * lo pone todo en marcha, para poder arrancarlo con un ejemplo.
 *
 * Es puro: lee el análisis del programa y la traza de su ejecución; no llama a ningún modelo.
 */

/**
 * `inert`: no llegó a hacer nada (define, pero nadie arranca). `mute`: ejecutó lo suyo, pero no enseñó nada.
 */
export type Idleness = 'inert' | 'mute'

/** A qué funciones del programa llama cada una (por su id), y a cuáles se llama desde el nivel de arriba. */
function callsOf(program: Program, facts: readonly Facts[]) {
  const known = new Set(facts.map((fact) => fact.id))
  const inside = (line: number) => facts.find((fact) => line >= fact.line && line <= fact.lineEnd)
  const from = new Map<string, Set<string>>(facts.map((fact) => [fact.id, new Set<string>()]))
  const top = new Set<string>()
  for (const node of program.nodes) {
    const callees = (node.callees ?? []).filter((id) => known.has(id))
    if (callees.length === 0) continue
    const owner = inside(node.line)
    for (const id of callees) {
      if (owner === undefined) top.add(id)
      else from.get(owner.id)?.add(id)
    }
  }
  return { from, top }
}

/** A cuántas funciones llega una, siguiendo sus llamadas. */
function reach(id: string, from: ReadonlyMap<string, ReadonlySet<string>>): number {
  const seen = new Set<string>()
  const walk = (at: string) => {
    for (const next of from.get(at) ?? []) {
      if (seen.has(next) || next === id) continue
      seen.add(next)
      walk(next)
    }
  }
  walk(id)
  return seen.size
}

/**
 * La función que pone el programa en marcha: de las que nadie llama, la que llega a más funciones. `entry` es
 * esa, si destaca; `tied`, las que empatan en cabeza (entonces tiene que elegir alguien con más criterio).
 * Solo funciones sueltas: un método necesita su objeto.
 */
export function entryOf(program: Program): { entry: Facts | null; tied: Facts[] } {
  const facts = functionsIn(program).filter((fact) => fact.owner === null)
  const { from, top } = callsOf(program, facts)
  const called = new Set([...top, ...[...from.values()].flatMap((set) => [...set])])
  const free = facts.filter((fact) => !called.has(fact.id))
  if (free.length === 0) return { entry: null, tied: [] }
  const scored = free
    .map((fact) => ({ fact, reach: reach(fact.id, from) }))
    .sort((a, b) => b.reach - a.reach)
  const most = scored[0]?.reach ?? 0
  const tied = scored.filter((one) => one.reach === most).map((one) => one.fact)
  return { entry: tied.length === 1 ? (tied[0] ?? null) : null, tied }
}

/**
 * Si el programa, tal como se ejecutó, no enseña nada, y por qué. `null` si enseñó algo, si falló o se cortó
 * (eso ya tiene su nombre), o si no hay nada que echar de menos (unas variables sueltas).
 */
export function idleness(program: Program, trace: Trace): Idleness | null {
  if (trace.error !== null || (trace.truncated && trace.finished !== true)) return null
  if (trace.output.trim() !== '') return null
  const worked = trace.events.some((event) => event.k === 'call')
  if (worked) return 'mute'
  const defines = program.nodes.some(
    (node) => node.kind === 'abstraction.collapsed' || node.kind === 'abstraction.class',
  )
  if (defines) return 'inert'
  // Sin funciones: si repite o decide algo y no lo enseña, trabaja en silencio.
  const works = program.nodes.some(
    (node) => node.kind === 'control.loop' || node.kind === 'control.condition',
  )
  return works ? 'mute' : null
}

/**
 * Lo mismo, mirando solo el texto (para quien no puede ejecutarlo): el programa define funciones, pero desde
 * el nivel de arriba no llama a ninguna ni enseña nada. Tal cual, no haría nada.
 */
export function looksInert(program: Program): boolean {
  const facts = functionsIn(program)
  if (facts.length === 0) return false
  const { top } = callsOf(program, facts)
  if (top.size > 0) return false
  const inside = (line: number) => facts.some((fact) => line >= fact.line && line <= fact.lineEnd)
  const classes = program.nodes
    .filter((node) => node.kind === 'abstraction.class')
    .map((node) => ({ from: node.line, to: node.lineEnd ?? node.line }))
  const loose = program.nodes.filter(
    (node) =>
      !inside(node.line) && !classes.some((cls) => node.line >= cls.from && node.line <= cls.to),
  )
  // Algo que se ve o que trabaja a la altura del archivo: un `print`, un bucle, una llamada cualquiera.
  return !loose.some(
    (node) =>
      node.kind === 'effect.io' ||
      node.kind === 'output.display' ||
      node.kind === 'control.loop' ||
      /\bprint\s*\(|\binput\s*\(/.test(node.code),
  )
}

/**
 * La etapa que arranca el programa con esa llamada de ejemplo y enseña lo que da: su rótulo y sus líneas,
 * listas para añadir al final. Si la función no devuelve nada, basta con llamarla (ya enseñará lo suyo).
 */
export function launchCode(call: string, returns: boolean): string {
  const lines = returns ? [`resultado = ${call}`, 'print("Resultado:", resultado)'] : [call]
  return ['# Arrancar: prueba con un ejemplo', ...lines].join('\n')
}

/** El programa con su etapa de arranque añadida al final, separada por una línea en blanco. */
export function withLaunch(source: string, call: string, returns: boolean): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const body = source.replace(/\s+$/, '')
  return `${body}${eol}${eol}${launchCode(call, returns).split('\n').join(eol)}${eol}`
}
