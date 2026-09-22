import type { Program, ProgramNode } from '@prysel/python'
import type { Anchor } from './lesson.ts'

/**
 * Cómo se ata un guion a un programa: por el texto de una sentencia, no por su línea (que se mueve). Puro,
 * y compartido entre el webview (dibujar el guion) y la generación con IA (comprobar que lo que escribió
 * existe de verdad en el programa).
 */

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()
/** Lo que identifica a una sentencia por su texto: su primera línea, sin sangría ni espacios de más. */
export const anchorKey = (node: ProgramNode) =>
  squash((node.text ?? node.code).split(/\r?\n/)[0] ?? '')

/**
 * El nodo que nombra un ancla: el `nth`-ésimo (por defecto el primero) cuya primera línea es ese texto; si
 * ninguno lo es igual, el que empieza por él (para no romper un ancla por un espacio o un `:` de más).
 */
export function anchorNode(program: Program, anchor: Anchor): ProgramNode | null {
  const wanted = squash(anchor.text)
  if (wanted === '') return null
  const exact = program.nodes.filter((node) => anchorKey(node) === wanted)
  const found =
    exact.length > 0 ? exact : program.nodes.filter((node) => anchorKey(node).startsWith(wanted))
  return found[(anchor.nth ?? 1) - 1] ?? null
}
