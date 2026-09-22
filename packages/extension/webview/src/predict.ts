import type { Ask } from '../../src/lesson.ts'
import { stateAt, type Shown, type TraceIndex } from '../../src/trace.ts'
import { formatShown } from './player.ts'

/**
 * Predecir antes de ver: «¿qué valdrá `total` tras esta línea?», «¿qué imprimirá?». La respuesta correcta
 * sale de la traza (no la inventa nadie), y se compara con lo que escribió el alumno con tolerancia a
 * espacios, comillas y `2` frente a `2.0`.
 */

/**
 * Lo que de verdad pasa al ejecutar la línea del paso `step`: el valor que tiene el nombre justo después
 * (al volver a un evento del mismo marco, aunque la línea haya llamado a funciones) o lo que imprimió.
 * `null` si la traza no lo dice (el nombre no existe, o no se imprimió nada).
 */
export function expectedFor(index: TraceIndex, step: number, ask: Ask): string | null {
  const events = index.trace.events
  const at = events[step]
  if (!at) return null
  let next = -1
  for (let i = step + 1; i < events.length; i++) {
    if (events[i]?.f === at.f) {
      next = i
      break
    }
  }
  if (next < 0) return null
  const after = stateAt(index, next)
  if (ask.expect === 'output') {
    const printed = after.output.slice(stateAt(index, step).output.length).trim()
    return printed === '' ? null : printed
  }
  const frame = after.frames.find((f) => f.id === at.f)
  const value = frame && ask.name !== undefined ? frame.locals[ask.name] : undefined
  return value === undefined ? null : formatShown(value as Shown)
}

/** Una respuesta comparable: sin espacios, sin comillas y en minúsculas. */
const plain = (text: string): string =>
  text
    .trim()
    .replace(/['"\s]/g, '')
    .toLowerCase()

/** ¿Acertó? Los números se comparan como números (`2` y `2.0` son lo mismo). */
export function judge(answer: string, expected: string): boolean {
  const a = plain(answer)
  const b = plain(expected)
  if (a === '') return false
  if (a === b) return true
  const na = Number(a)
  const nb = Number(b)
  return Number.isFinite(na) && Number.isFinite(nb) && a !== '' && b !== '' && na === nb
}
