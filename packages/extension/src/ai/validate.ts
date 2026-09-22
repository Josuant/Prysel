import type { Program } from '@prysel/python'
import { parseLesson, type Lesson } from '../lesson.ts'
import { indexOf, type Trace } from '../trace.ts'
import { resolveBeats } from '../../webview/src/lessons.ts'
import { expectedFor } from '../../webview/src/predict.ts'

/**
 * Lo que un guion generado tiene que cumplir para no inventarse nada: el formato (`parseLesson`), que cada
 * ancla exista de verdad en el programa, que la sentencia se ejecute las veces que dice `visit`, y que una
 * pregunta se pueda responder con la traza. Puro: sin red ni modelo, para poder probarlo con cualquier JSON.
 */

export type ValidateResult = { ok: true; lesson: Lesson } | { ok: false; error: string }

export function validateGenerated(program: Program, trace: Trace, raw: unknown): ValidateResult {
  const parsed = parseLesson(raw)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const lesson = parsed.lesson
  if (lesson.beats.length === 0) return { ok: false, error: 'El guion no tiene ningún momento.' }

  const index = indexOf(trace)
  const resolved = resolveBeats(program, lesson, trace)
  for (const [i, r] of resolved.entries()) {
    const beat = lesson.beats[i]
    if (!beat) continue
    if (r.node === null) {
      return {
        ok: false,
        error: `Momento «${beat.id}»: el ancla «${beat.at.text}» no es ninguna sentencia del programa.`,
      }
    }
    if (r.step === null) {
      const where = beat.when?.text ?? beat.at.text
      const visit = beat.when?.visit
      return {
        ok: false,
        error:
          visit && visit > 1
            ? `Momento «${beat.id}»: «${where}» no se ejecuta ${visit} veces en la traza.`
            : `Momento «${beat.id}»: «${where}» no llega a ejecutarse en la traza.`,
      }
    }
    if (beat.ask) {
      const answer = expectedFor(index, r.step, beat.ask)
      if (answer === null) {
        return {
          ok: false,
          error:
            beat.ask.expect === 'value'
              ? `Momento «${beat.id}»: la pregunta pide el valor de «${beat.ask.name ?? ''}», que no existe justo ahí en la traza.`
              : `Momento «${beat.id}»: la pregunta pide lo que imprime esa línea, y esa línea no imprime nada.`,
        }
      }
    }
  }
  return { ok: true, lesson }
}
