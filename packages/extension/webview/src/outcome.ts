import type { ModuleFacts, ModuleState, ModuleStory, ViewerContent } from '@prysel/ui'
import type { RunSummary } from '../../src/gist/gist.ts'
import type { Story } from '../../src/gist/story.ts'
import type { Progress } from '../../src/gist/progress.ts'

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

/** Cómo quedó el programa tras un cambio, dicho en una frase. `undo`: merece ofrecer deshacerlo. */
/** Cuántos momentos se enseñan de algo que va cambiando, y cuánto cabe de cada uno en una fila. */
export const PROGRESS_ROWS = 7
const PROGRESS_TEXT = 48

/**
 * El visor de **cómo avanza** el programa vuelta a vuelta: lo que se eligió mirar para este programa (ver
 * `progress.ts`), tal como se midió. De lo que se lee, unos cuantos momentos, del primero al último, con las
 * letras que ya son las del final encendidas (se ve cómo se va acercando); del número, su curva.
 */
export function progressViewer(progress: Progress): ViewerContent | null {
  const { text, number } = progress
  if (!text && !number) return null
  // Los momentos en los que lo que se lee cambió: de ahí, unos pocos repartidos, con el primero y el último.
  const moments = (text?.values ?? []).flatMap((value, at) =>
    at === 0 || value !== text?.values[at - 1] ? [{ lap: text?.laps[at] ?? at, value }] : [],
  )
  const picked =
    moments.length <= PROGRESS_ROWS
      ? moments
      : Array.from(
          { length: PROGRESS_ROWS },
          (_, k) =>
            moments[
              Math.round((k * (moments.length - 1)) / (PROGRESS_ROWS - 1))
            ] as (typeof moments)[0],
        )
  const final = picked[picked.length - 1]?.value ?? ''
  // Letra a letra solo se compara lo que mide lo mismo: una frase que se va pareciendo a otra.
  const comparable = picked.length > 1 && picked.every((one) => one.value.length === final.length)
  const steps = picked.map((one) => ({
    label: String(one.lap),
    text: clip(one.value, PROGRESS_TEXT),
    ...(comparable
      ? { lit: [...clip(one.value, PROGRESS_TEXT)].map((letter, k) => letter === final[k]) }
      : {}),
  }))
  const first = number?.values[0]
  const last = number?.values[number.values.length - 1]
  const figure = (value: number | undefined) =>
    value === undefined ? '' : Number.isInteger(value) ? String(value) : value.toFixed(2)
  return {
    title: 'Cómo avanza',
    subtitle: [text?.says, number?.says].filter(Boolean).join(' · '),
    ...(steps.length > 0 ? { steps } : {}),
    ...(number
      ? {
          series: { at: number.laps, values: number.values, n: Math.max(2, progress.total) },
          text: [`${number.says}: de ${figure(first)} a ${figure(last)}`],
        }
      : {}),
  }
}

/** Una ejecución del programa, para su historia: qué la provocó y qué dio. */
export interface RunEntry {
  /** Cuál es, contando desde la primera. */
  n: number
  cause: string
  /** Lo último que enseñó (o que falló, o que no enseñó nada). */
  said: string
  /** El último número de lo que enseñó, si enseñó alguno: con él se dibuja cómo va cambiando. */
  value: number | null
}

/** Cuántas ejecuciones enseña el visor: las últimas. */
export const RUNS_SHOWN = 6

/** Lo que se apunta de una ejecución (`null`: no llegó a ejecutarse, o se quedó pidiendo un dato). */
export function runEntry(run: RunSummary, cause: string, n: number): RunEntry | null {
  if (run.ended === 'blocked' || run.ended === 'waiting') return null
  if (run.ended === 'error') {
    return {
      n,
      cause,
      said: `falla${run.problem ? `: ${clip(run.problem, 44)}` : ''}`,
      value: null,
    }
  }
  const said = run.ended === 'idle' ? '' : lastSaid(run)
  if (said === '') return { n, cause, said: 'no enseña nada', value: null }
  const numbers = said.match(/-?\d+(?:[.,]\d+)?/g)
  const value = numbers ? Number((numbers[numbers.length - 1] ?? '').replace(',', '.')) : NaN
  return { n, cause, said, value: Number.isFinite(value) ? value : null }
}

/**
 * El visor de las **ejecuciones**: lo que fue dando el programa cada vez que se ejecutó, y qué provocó cada
 * una. Si todas enseñan lo mismo con otro número, además se dibuja cómo va cambiando. Con una sola no hay historia que
 * contar: lo dice el resultado.
 */
export function runsViewer(entries: readonly RunEntry[]): ViewerContent | null {
  if (entries.length < 2) return null
  const shown = entries.slice(-RUNS_SHOWN)
  const values = shown.flatMap((entry) => (entry.value === null ? [] : [entry.value]))
  // La curva compara lo mismo de una vez a otra: solo si todas dicen la misma frase con otro número («tras
  // 41 generaciones», «tras 38 generaciones»). Si lo que enseña cambió, sus números no se comparan.
  const shape = (said: string) => said.replace(/-?\d+(?:[.,]\d+)?/g, '#')
  const alike = shown.every((entry) => shape(entry.said) === shape(shown[0]?.said ?? ''))
  return {
    title: 'Ejecuciones',
    subtitle: 'qué cambió y qué dio',
    ...(values.length === shown.length && alike
      ? { series: { at: shown.map((_, at) => at), values, n: shown.length } }
      : {}),
    text: shown.map((entry) => `${entry.n}. ${entry.cause} → ${entry.said}`),
  }
}

export interface Health {
  tone: 'ok' | 'muted' | 'error'
  text: string
  undo?: boolean
  /** Falla al ejecutarlo: lo que dijo el error, para pedir que se arregle. */
  fix?: string
}

/** Lo último que salió por pantalla, corto: es por lo que se reconoce «da lo mismo» o «ahora da otra cosa». */
const lastSaid = (run: RunSummary): string => {
  const rows = run.output.split('\n').filter((row) => row.trim() !== '')
  return clip(rows[rows.length - 1]?.trim() ?? '', 56)
}

/**
 * La **salud** del programa tras una orden (o tras mover una perilla): se volvió a ejecutar, y esto es lo que
 * pasó comparado con antes. ¿Sigue funcionando? ¿Da lo mismo o cambió? ¿Se rompió? Es un hecho de la
 * ejecución, no una opinión sobre el código.
 *
 * `before`: cómo le fue antes del cambio (`null`: no había programa). `how`: si lo que cambió fue una orden,
 * una perilla, o solo la suerte (otra tirada). `null`: no hay nada que decir (pide datos por teclado y no se
 * ha ejecutado).
 */
export function healthOf(
  before: RunSummary | null,
  after: RunSummary,
  how: 'order' | 'knob' | 'roll' = 'order',
): Health | null {
  if (after.ended === 'blocked' || after.ended === 'waiting') return null
  const worked = (run: RunSummary | null) =>
    run !== null && (run.ended === 'done' || run.ended === 'cut' || run.ended === 'idle')
  if (after.ended === 'error') {
    const what = after.problem ? `: ${clip(after.problem, 90)}` : '.'
    const fix = after.problem ? { fix: clip(after.problem, 160) } : {}
    return worked(before)
      ? {
          tone: 'error',
          text: `Antes funcionaba y ahora falla al ejecutarlo${what}`,
          undo: true,
          ...fix,
        }
      : { tone: 'error', text: `Falla al ejecutarlo${what}`, ...fix }
  }
  if (after.ended === 'idle') {
    return {
      tone: 'muted',
      text:
        after.idle === 'mute'
          ? 'Se ejecuta sin fallos, pero no enseña nada en pantalla.'
          : 'Todavía no hace nada al ejecutarlo: nadie lo arranca.',
      ...(worked(before) && before?.ended !== 'idle' ? { undo: true } : {}),
    }
  }
  if (after.ended === 'cut')
    return { tone: 'muted', text: 'Se ejecuta, pero no llegó a acabar: se cortó por largo.' }
  const now = lastSaid(after)
  if (how === 'roll')
    return {
      tone: 'ok',
      text: now ? `Con otra tirada da «${now}».` : 'Con otra tirada, sin fallos.',
    }
  if (before === null || before.ended === 'blocked' || before.output.trim() === '') {
    return before?.ended === 'error'
      ? { tone: 'ok', text: now ? `Ya no falla: da «${now}».` : 'Ya no falla.' }
      : {
          tone: 'ok',
          text: now ? `Funciona: se ejecuta y da «${now}».` : 'Funciona: se ejecuta sin fallos.',
        }
  }
  if (before.ended === 'error')
    return { tone: 'ok', text: now ? `Ya no falla: da «${now}».` : 'Ya no falla.' }
  if (before.output === after.output)
    return { tone: 'ok', text: 'Sigue funcionando, y da lo mismo que antes.' }
  const was = lastSaid(before)
  return {
    tone: 'ok',
    text:
      was === now
        ? 'Sigue funcionando; lo que enseña cambió por el camino, pero acaba igual.'
        : `Sigue funcionando. Antes daba «${was}»; ahora, «${now}».`,
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
      return [
        {
          from,
          to,
          label: flow.size === undefined ? name : `${name} ×${flow.size}`,
          // Lo que se vio pasar, para la sonda de su flecha.
          ...(flow.text ? { sample: flow.text } : {}),
        },
      ]
    }),
    caption: `${lapsSaid(story.loop)} ${laps === 1 ? 'vuelta' : 'vueltas'}`,
    exit: exitOf(story.loop),
  }
}
