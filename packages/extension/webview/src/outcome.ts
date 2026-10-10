import type { ModuleFacts, ModuleState, ModuleStory, ViewerContent } from '@prysel/ui'
import type { RunSummary } from '../../src/gist/gist.ts'
import type { Story } from '../../src/gist/story.ts'

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

/**
 * El **estado de cada módulo** tras ejecutar el programa: cuántas veces se usó, si nadie lo usa, si no llegó a
 * ejecutarse, o si es donde falló. Sale de lo que se usó de verdad (`RunSummary.usage`): un módulo de
 * funciones, por las veces que se entró en ellas; uno con código suelto, por si se pisó alguna de sus líneas.
 *
 * Si la traza se dejó de grabar antes del final, las veces son «al menos» y de lo que no aparece no se dice
 * que no se use: pudo usarse después.
 */
export function moduleStates(
  run: RunSummary | null,
  nodes: readonly { kind: string; line: number }[],
  modules: readonly ModuleFacts[],
): Record<string, ModuleState> {
  const usage = run?.usage
  if (!run || !usage || run.ended === 'blocked') return {}
  const states: Record<string, ModuleState> = {}
  const defs = nodes.filter((node) => node.kind === 'abstraction.collapsed').map((n) => n.line)
  for (const fact of modules) {
    const within = (line: number) => line >= fact.line && line <= fact.lineEnd
    if (run.ended === 'error' && run.line !== undefined && within(run.line)) {
      states[fact.id] = {
        tone: 'failed',
        label: 'falló aquí',
        title: run.problem ? `Aquí se paró: ${run.problem}` : 'Aquí se paró el programa.',
      }
      continue
    }
    const own = defs.filter(within)
    if (fact.defines && own.length > 0) {
      const times = own.reduce((sum, line) => sum + (usage.calls[line] ?? 0), 0)
      if (times > 0) {
        states[fact.id] = {
          tone: 'ran',
          label: `×${times}${usage.partial ? '+' : ''}`,
          title: usage.partial
            ? `Se usó al menos ${times} ${times === 1 ? 'vez' : 'veces'} (luego se dejó de contar).`
            : `Se usó ${times} ${times === 1 ? 'vez' : 'veces'} al ejecutar el programa.`,
        }
      } else if (!usage.partial && run.ended !== 'error') {
        states[fact.id] = {
          tone: 'unused',
          label: 'sin usar',
          title: 'El programa no llegó a usarlo: nadie lo llama.',
        }
      }
      continue
    }
    // Código suelto: o se pisó alguna de sus líneas (sin contar las que solo definen algo), o no llegó.
    const ran = usage.lines.some((line) => within(line) && !own.includes(line))
    if (!ran && !usage.partial && run.ended !== 'error') {
      states[fact.id] = {
        tone: 'idle',
        label: 'no se ejecutó',
        title: 'El programa acabó sin pasar por aquí.',
      }
    }
  }
  return states
}

/** Cuántas vueltas dio, dicho sin prometer de más: si no se le vio salir, son «más de» las que se contaron. */
export const lapsSaid = (loop: Pick<Story['loop'], 'laps' | 'ended'>): string =>
  loop.ended === 'cut' ? `más de ${loop.laps}` : String(loop.laps)

/**
 * Cómo se salió del ciclo, con palabras. Es un hecho de la ejecución (se acabaron sus vueltas, dejó de
 * cumplirse la condición, se cortó desde dentro…), no una interpretación de para qué sirve.
 */
export function exitOf(loop: Story['loop']): string {
  const lap = `en la vuelta ${loop.laps}`
  switch (loop.ended) {
    case 'done':
      return loop.kind === 'for'
        ? 'sale al acabar sus vueltas'
        : 'sale cuando deja de cumplirse su condición'
    case 'break':
      return `sale antes de acabar, ${lap}`
    case 'return':
      return `sale con el resultado, ${lap}`
    case 'cut':
      // No se vio salir: la traza deja de mirar a partir de cierto punto (el programa puede haber seguido).
      return 'siguió dando vueltas: aquí se dejó de mirar'
    case 'error':
      return `se paró por un error, ${lap}`
  }
}

/**
 * La historia de la ejecución, dicha con los módulos del diagrama: cada función, en el módulo donde está
 * definida; el bucle, en el suyo. `null` si el bucle no cae en ningún módulo (no hay a quién contársela).
 */
export function moduleStory(
  story: Story,
  nodes: readonly { kind: string; label: string; line: number }[],
  modules: readonly ModuleFacts[],
): ModuleStory | null {
  const moduleAt = (line: number | undefined) =>
    line === undefined
      ? undefined
      : modules.find((fact) => line >= fact.line && line <= fact.lineEnd)?.id
  const defined = new Map(
    nodes.filter((node) => node.kind === 'abstraction.collapsed').map((n) => [n.label, n.line]),
  )
  const moduleOf = (fn: string) => moduleAt(defined.get(fn))
  const anchor = moduleAt(story.loop.line)
  if (anchor === undefined) return null
  const all = (fns: readonly string[]) => fns.flatMap((fn) => moduleOf(fn) ?? [])
  const { laps } = story.loop
  return {
    anchor,
    ring: all(story.ring),
    before: all(story.before),
    flows: story.flows.flatMap((flow) => {
      const from = moduleOf(flow.from)
      const to = moduleOf(flow.to)
      if (from === undefined || to === undefined) return []
      // Con palabras, no como se escribe en el código (`mejor_nota` → «mejor nota»); y una colección, con
      // cuántos lleva: «poblacion ×20».
      const name = flow.name.replace(/_+/g, ' ').trim() || flow.name
      return [{ from, to, label: flow.size === undefined ? name : `${name} ×${flow.size}` }]
    }),
    caption: `${lapsSaid(story.loop)} ${laps === 1 ? 'vuelta' : 'vueltas'}`,
    exit: exitOf(story.loop),
  }
}
