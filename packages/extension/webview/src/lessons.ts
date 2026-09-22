import type { Program } from '@prysel/python'
import type { SemanticEdge } from '@prysel/spatial'
import { FUNCTION_CHIP, type CanvasNode } from '@prysel/ui'
import { anchorNode } from '../../src/anchor.ts'
import type { Beat, Lesson } from '../../src/lesson.ts'
import type { Trace } from '../../src/trace.ts'
import { nearestVisible, nodeAtLine, visibleCaller } from './player.ts'

/**
 * Un guion puesto sobre un programa: a qué nodo se refiere cada nota, en qué paso de la ejecución se
 * cuenta, y qué notas se ven en cada momento. Puro: recibe el programa, el guion y la traza.
 */

// El ancla (por el texto de una sentencia) es la misma que usa la generación con IA para comprobar el guion.
export { anchorNode } from '../../src/anchor.ts'

export interface ResolvedBeat {
  beat: Beat
  /** El nodo al que apunta la nota, si el ancla se encuentra en el programa. */
  node: string | null
  /** El paso de la traza en el que se cuenta, si el programa llega hasta ahí. */
  step: number | null
}

/** A qué nodo y a qué paso corresponde cada momento del guion. Sin traza, ninguno tiene paso. */
export function resolveBeats(
  program: Program,
  lesson: Lesson,
  trace: Trace | null,
): ResolvedBeat[] {
  // Qué nodo es el de cada línea: se mira una vez por línea, no por evento.
  const byLine = new Map<number, string | undefined>()
  const nodeOf = (line: number) => {
    if (!byLine.has(line)) byLine.set(line, nodeAtLine(program, line)?.id)
    return byLine.get(line)
  }
  return lesson.beats.map((beat) => {
    const at = anchorNode(program, beat.at)
    const when = beat.when ? anchorNode(program, beat.when) : at
    let step: number | null = null
    if (trace && when) {
      let visits = 0
      const wanted = beat.when?.visit ?? 1
      for (const [index, event] of trace.events.entries()) {
        if (event.k !== 'line' || nodeOf(event.l) !== when.id) continue
        if (++visits === wanted) {
          step = index
          break
        }
      }
    }
    return { beat, node: at?.id ?? null, step }
  })
}

/** Los momentos que se pueden recorrer, en el orden en que ocurren. */
export function momentsOf(resolved: readonly ResolvedBeat[]): (ResolvedBeat & { step: number })[] {
  return resolved
    .flatMap((r) => (r.step === null ? [] : [{ ...r, step: r.step }]))
    .sort((a, b) => a.step - b.step)
}

/** Los momentos cuyo paso ya llegó y el actual (el último que llegó): lo que cuenta la nota que manda. */
export function currentMoment(
  moments: readonly (ResolvedBeat & { step: number })[],
  step: number,
): (ResolvedBeat & { step: number }) | null {
  let current: (ResolvedBeat & { step: number }) | null = null
  for (const moment of moments) if (moment.step <= step) current = moment
  return current
}

export const noteNodeId = (beat: Beat) => `note:${beat.id}`

/**
 * Las notas, como nodos del lienzo con su flecha. Sin reproducción (`step` nulo) se ven todas, como una hoja
 * anotada; reproduciendo, las de los momentos que ya llegaron: la actual con toda su fuerza y las anteriores
 * retiradas. Las que aún no llegaron se marcan `hidden`: el lienzo les guarda el sitio para que al aparecer
 * no mueva nada. Una nota cuyo nodo no se ve (dentro de una función plegada) cuelga del más cercano que lo
 * envuelve y sí se ve, o de la llamada que abre la función; si no hay ninguno, no se enseña.
 */
export function lessonNotes(
  program: Program,
  resolved: readonly ResolvedBeat[],
  step: number | null,
  visible: ReadonlySet<string>,
  /** Las funciones que el diagrama enseña como chip (su definición no es un nodo que se vea). */
  functions: ReadonlySet<string> = new Set(),
): { nodes: CanvasNode[]; links: SemanticEdge[] } {
  const nodes: CanvasNode[] = []
  const links: SemanticEdge[] = []
  const current = step === null ? null : currentMoment(momentsOf(resolved), step)?.beat.id
  for (const { beat, node, step: at } of resolved) {
    if (node === null) continue
    const pending = step !== null && (at === null || at > step)
    const target = program.nodes.find((n) => n.id === node)
    // La definición de una función se enseña como su chip; lo de dentro, como la llamada que la abre.
    const anchor = !target
      ? null
      : (nearestVisible(program, target, visible) ??
        (functions.has(target.id) ? `${FUNCTION_CHIP}${target.id}` : null) ??
        visibleCaller(program, target, visible))
    if (anchor === null) continue
    const id = noteNodeId(beat)
    nodes.push({
      id,
      kind: 'output.display',
      label: beat.note.title ?? '',
      handwritten: {
        text: beat.note.text,
        style: beat.note.style,
        ...(beat.note.title ? { title: beat.note.title } : {}),
        ...(pending ? { hidden: true } : {}),
        ...(step !== null && !pending
          ? beat.id === current
            ? { current: true }
            : { past: true }
          : {}),
      },
    })
    links.push({ from: anchor, to: id, relation: 'transform' })
  }
  return { nodes, links }
}
