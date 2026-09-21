import type { Program } from '@prysel/python'
import type { LoopView, RunView } from '../../src/runs.ts'

/**
 * Los valores por vuelta de un bucle, puestos sobre el diagrama: qué serie corresponde a cada nodo
 * bucle, qué vale cada nombre en la vuelta que se está mirando, y qué nombres se pueden dibujar como
 * curva. Puro: recibe el programa y lo que el motor anotó.
 */

/** A qué serie corresponde un bucle: la sentencia de primer nivel que lo contiene y dónde está dentro de ella. */
export interface LoopRef {
  /** El id del nodo bucle. */
  node: string
  statement: string
  /** `línea:columna` dentro de la sentencia, como la anota el motor. */
  key: string
  view: LoopView
}

/** Los bucles del programa que ya dieron vueltas, con su serie. */
export function loopRefs(
  program: Program,
  top: ReadonlyMap<string, string>,
  runs: Readonly<Record<string, RunView>>,
): Map<string, LoopRef> {
  const byId = new Map(program.nodes.map((node) => [node.id, node]))
  const refs = new Map<string, LoopRef>()
  for (const node of program.nodes) {
    if (node.kind !== 'control.loop' || !node.range) continue
    const statement = top.get(node.id)
    const outer = statement === undefined ? undefined : byId.get(statement)
    if (statement === undefined || !outer) continue
    const key = `${node.line - outer.line + 1}:${node.range.indent}`
    const view = runs[statement]?.loops?.[key]
    if (view) refs.set(node.id, { node: node.id, statement, key, view })
  }
  return refs
}

/** Los bucles que envuelven a un nodo, del más interno al más externo. */
export function enclosingLoops(program: Program): Map<string, string[]> {
  const byId = new Map(program.nodes.map((node) => [node.id, node]))
  const chains = new Map<string, string[]>()
  for (const node of program.nodes) {
    const chain: string[] = []
    let owner = node.range?.owner
    while (owner !== undefined) {
      const parent = byId.get(owner)
      if (!parent) break
      if (parent.kind === 'control.loop') chain.push(parent.id)
      owner = parent.range?.owner
    }
    chains.set(node.id, chain)
  }
  return chains
}

/** La posición de la vuelta que se mira: la elegida, o la última. */
export function positionOf(view: LoopView, chosen: number | undefined): number {
  const last = Math.max(0, view.idx.length - 1)
  return chosen === undefined ? last : Math.min(Math.max(0, chosen), last)
}

/** Un valor de una vuelta, corto: un número con pocas cifras, o su descripción recortada. */
export function formatValue(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return String(value)
    const abs = Math.abs(value)
    return abs !== 0 && (abs < 0.001 || abs >= 1e6)
      ? value.toExponential(2)
      : String(Number(value.toPrecision(4)))
  }
  return value.length > 14 ? `${value.slice(0, 13)}…` : value
}

/**
 * Lo que se observó de los nombres que define cada nodo de dentro de un bucle, en la vuelta que se mira.
 * Un nodo toma el valor de su bucle más interno que anota ese nombre.
 */
export function observedInLoops(
  program: Program,
  refs: ReadonlyMap<string, LoopRef>,
  scrub: Readonly<Record<string, number>>,
): Map<string, Record<string, { short: string; long: string }>> {
  const chains = enclosingLoops(program)
  const found = new Map<string, Record<string, { short: string; long: string }>>()
  for (const node of program.nodes) {
    const names = node.results ?? (node.provides === undefined ? [] : [node.provides])
    if (names.length === 0) continue
    const observed: Record<string, { short: string; long: string }> = {}
    for (const name of names) {
      for (const loop of chains.get(node.id) ?? []) {
        const ref = refs.get(loop)
        const series = ref?.view.names[name]
        if (!ref || !series) continue
        const at = positionOf(ref.view, scrub[loop])
        const shown = formatValue(series[at])
        observed[name] = {
          short: shown,
          long: `vuelta ${(ref.view.idx[at] ?? at) + 1} de ${ref.view.n}: ${shown}`,
        }
        break
      }
    }
    if (Object.keys(observed).length > 0) found.set(node.id, observed)
  }
  return found
}

/** Los nombres de un bucle que se pueden dibujar como curva: los que tienen al menos dos números. */
export function curvesOf(view: LoopView): string[] {
  return Object.entries(view.names)
    .filter(([, values]) => values.filter((v) => typeof v === 'number').length >= 2)
    .map(([name]) => name)
}

/** Los puntos de una curva: solo los números, con su vuelta. */
export function curvePoints(view: LoopView, name: string): { at: number; value: number }[] {
  const values = view.names[name] ?? []
  return values.flatMap((value, i) =>
    typeof value === 'number' ? [{ at: view.idx[i] ?? i, value }] : [],
  )
}
