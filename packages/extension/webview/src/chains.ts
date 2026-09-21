import type { Program } from '@prysel/python'
import type { Summary } from '../../src/kernel.ts'
import { describeSummary, type RunView } from '../../src/runs.ts'

/**
 * Lo que se observó de cada paso de una cadena, puesto sobre su nodo: a qué cadena corresponde cada
 * nodo, y qué enseña la fila de cada paso (su tipo y su forma) y su ayuda (las columnas, las primeras
 * filas). Puro: recibe el programa y lo que el motor anotó.
 */

/** Una cadena que ya se evaluó: la sentencia que la contiene y dónde está dentro de ella. */
export interface ChainRef {
  node: string
  statement: string
  /** `línea:columna` dentro de la sentencia, como la anota el motor. */
  key: string
  /** Lo que valía tras cada paso (índice 0: el receptor); `null` si no llegó a evaluarse. */
  previews: readonly (Summary | null)[]
}

/** Las cadenas del programa que ya se evaluaron, por el id de su nodo. */
export function chainRefs(
  program: Program,
  top: ReadonlyMap<string, string>,
  runs: Readonly<Record<string, RunView>>,
): Map<string, ChainRef> {
  const byId = new Map(program.nodes.map((node) => [node.id, node]))
  const refs = new Map<string, ChainRef>()
  for (const node of program.nodes) {
    if (node.control?.kind !== 'chain' || !node.anchor) continue
    const statement = top.get(node.id)
    const outer = statement === undefined ? undefined : byId.get(statement)
    if (statement === undefined || !outer) continue
    const key = `${node.anchor.line - outer.line + 1}:${node.anchor.col}`
    const previews = runs[statement]?.chains?.[key]
    if (previews) refs.set(node.id, { node: node.id, statement, key, previews })
  }
  return refs
}

/** Lo que dice la ayuda de un paso: su tipo y su forma, y las columnas si es una tabla. */
export function describeStep(summary: Summary): string {
  const lines = [describeSummary(summary)]
  const columns = summary.table?.columns.map((column) => column.name)
  if (columns && columns.length > 0) {
    lines.push(`columnas: ${columns.slice(0, 12).join(', ')}${columns.length > 12 ? ', …' : ''}`)
  }
  if (summary.sample && summary.sample.length > 0) {
    lines.push(`${summary.sample.slice(0, 6).join(', ')}${summary.sample.length > 6 ? ', …' : ''}`)
  }
  return lines.join('\n')
}

/** ¿Hay algo que ver de este paso en un visor? Una tabla, unos elementos o una muestra. */
export const viewableStep = (summary: Summary | null | undefined): summary is Summary =>
  summary !== null &&
  summary !== undefined &&
  (summary.table !== undefined ||
    summary.sample !== undefined ||
    summary.items !== undefined ||
    summary.repr !== undefined)
