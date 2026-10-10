import type { ModuleFacts, ViewerContent } from '@prysel/ui'
import type { RunSummary } from '../../src/gist/gist.ts'

/**
 * Los dos extremos de la arquitectura, sacados de cómo le fue al programa al ejecutarlo: **dónde empieza** el
 * trabajo y **qué sale** al final. Es lo que hace que el diagrama diga «esto funciona, y da esto», no solo
 * «estas son las piezas».
 *
 * No interpreta nada: el resultado es lo último que salió por pantalla, tal cual, y viene de los módulos
 * cuyas líneas lo escribieron. Si el programa aún no hace nada, se dice; y si su función principal se probó
 * aparte, se enseña esa prueba como lo que daría.
 */

/** Cuántas líneas de la salida se enseñan en el nodo del resultado (las últimas). */
const RESULT_LINES = 5
const clip = (text: string, max = 46) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

export interface Outcome {
  result: { content: ViewerContent; from: string[]; planned?: boolean } | null
  start: { at: string; label: string } | null
}

const SAID: Partial<Record<RunSummary['ended'], string>> = {
  done: 'Lo último que salió por pantalla',
  waiting: 'Hasta donde llegó: espera otra respuesta',
  cut: 'Hasta donde llegó: era muy largo',
  error: 'Hasta donde llegó: falló',
}

/**
 * `entryLine`: la línea donde está definida la función que arrancaría el programa (si no hace nada y se sabe
 * cuál es): la prueba aparte sale del módulo que la contiene.
 */
export function outcomeOf(
  run: RunSummary,
  modules: readonly ModuleFacts[],
  entryLine?: number,
): Outcome {
  const moduleAt = (line: number | null | undefined) =>
    line === null || line === undefined
      ? undefined
      : modules.find((fact) => line >= fact.line && line <= fact.lineEnd)?.id
  const at = moduleAt(run.start)
  const start = at === undefined ? null : { at, label: 'Empieza aquí' }

  if (run.ended === 'idle') {
    const from = moduleAt(entryLine)
    if (run.trial) {
      const printed = (run.trial.printed ?? '').replace(/\n$/, '')
      return {
        start,
        result: {
          planned: true,
          from: from === undefined ? [] : [from],
          content: {
            title: 'Resultado',
            subtitle: 'Lo que daría: probado aparte con un ejemplo',
            text: [
              clip(run.trial.call),
              ...(printed === ''
                ? []
                : printed
                    .split('\n')
                    .slice(-3)
                    .map((row) => clip(row))),
              ...(run.trial.returned === undefined ? [] : [clip(`→ ${run.trial.returned}`)]),
            ],
          },
        },
      }
    }
    return {
      start,
      result: {
        planned: true,
        from: [],
        content: {
          title: 'Resultado',
          subtitle: 'Todavía no hay',
          stale: true,
          text: [
            run.idle === 'mute'
              ? 'Trabaja, pero no enseña nada.'
              : 'Nadie arranca el programa todavía.',
          ],
        },
      },
    }
  }

  if (run.ended === 'blocked' || run.output.trim() === '') return { start, result: null }
  const rows = run.output.replace(/\n$/, '').split('\n')
  const shown = rows.slice(-RESULT_LINES)
  const sources = (run.sources ?? []).slice(-shown.length)
  const from = [...new Set(sources.flatMap((line) => moduleAt(line) ?? []))]
  return {
    start,
    result: {
      from,
      content: {
        title: 'Resultado',
        subtitle: SAID[run.ended] ?? '',
        text: shown.map((row) => clip(row)),
      },
    },
  }
}
