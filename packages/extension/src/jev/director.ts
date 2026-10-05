import type { Program } from '@prysel/python'
import { applyEdits, clearGenerating, type Change } from '@prysel/python/edits'
import type { AiProvider, AiRequest } from '../ai/provider.ts'
import { streamText } from '../ai/stream.ts'
import {
  BuildPlan,
  MAX_BUILD_STEPS,
  MAX_STAGES,
  ObjectStream,
  STEP_THRESHOLDS,
  buildStepsPrompt,
  buildStepsSystem,
  judgeStep,
  outlinePrompt,
  outlineSystem,
  paceOf,
  stageGen,
  stageHeading,
  stageOf,
  stagePrompt,
  stageSystem,
  stepOf,
  teachingNote,
  type BuildStep,
  type Stage,
} from './build.ts'
import type { Decider } from './client.ts'
import { COMPOSE_THRESHOLDS, judgeCode } from './compose.ts'
import { WHOLE_BUDGET, contextFor } from './context.ts'
import type { Evidence, Spot } from './engine.ts'
import {
  LineMap,
  MAX_OPS,
  applyOp,
  lineDelta,
  modifyPrompt,
  modifySystem,
  opOf,
  type ChangeOp,
} from './modify.ts'

/**
 * El director: lleva una orden compleja de principio a fin, **por partes**, como quien piensa en voz alta.
 *
 * No hay una gran llamada al principio que lo calcule todo. Hay varias, pequeñas, cada una con lo que hace
 * falta saber en ese momento, y entre ellas el diagrama ya va cambiando:
 *
 * 1. **El contexto** (JEV): qué trozos del programa hay que leer para esta orden.
 * 2. **El plan** (IA generativa, en streaming): las etapas, a grandes rasgos. Cada una aparece en el diagrama
 *    en cuanto se dicta, como una tarjeta con su título y un hueco: primero se ve el esquema entero.
 * 3. **Cada etapa** (otra llamada a la IA, en streaming, con lo ya escrito delante): sus pasos, uno a uno.
 * 4. **Cada paso** (JEV): ¿es seguro?, ¿se enseña de cerca o en su conjunto?, ¿merece una pausa? Y se
 *    escribe, aparece y se cuenta antes de que llegue el siguiente.
 * 5. **El conjunto** (JEV): al acabar, ¿cumple lo que se pidió?
 *
 * Lo pequeño se salta el plan y va directo a los pasos. Y lo que ya está escrito no se reescribe: se cambia
 * (`modify`), también paso a paso.
 *
 * No sabe nada de VS Code ni del lienzo: habla con ellos a través de `Stagehand`. Por eso se prueba entero,
 * con un archivo en memoria, una IA de mentira y el decisor local.
 */

/** Lo que el director necesita de quien lo aloja: el archivo, el lienzo y el reloj. */
export interface Stagehand {
  /** Se corta cuando el usuario detiene la construcción (o da otra orden). */
  signal: AbortSignal
  /** El programa de ahora mismo. */
  program(): Promise<Program>
  /**
   * Escribe un cambio en el archivo, si deja un Python válido. Devuelve por qué no se escribió, o `null`.
   */
  write(change: Change): Promise<string | null>
  /** Algo que enseñar en el lienzo (ya con el programa nuevo delante). */
  show(event: Shown): Promise<void>
  /** Espera (lo que tarda en decirse una frase), sin pasar de que se detenga. */
  wait(ms: number): Promise<void>
}

export type Shown =
  /** En qué se está pensando ahora: lo que se lee mientras no hay nada nuevo que ver. */
  | { type: 'progress'; text: string }
  | {
      type: 'step'
      index: number
      say: string
      /** La línea de la sentencia que aparece, cambia o se va. */
      line: number
      effect: 'born' | 'changed' | 'leaving'
      /** La cámara enseña el conjunto, no solo la pieza. */
      wide?: boolean
    }

export interface Players {
  decider: Decider
  provider: AiProvider
}

export interface Outcome {
  /** Cuántos pasos quedaron escritos. */
  written: number
  stopped: boolean
  /** Por qué se paró antes de acabar, si se paró sola. */
  trouble: string | null
  /** El JEV duda de que el conjunto cumpla la orden. */
  doubt: boolean
  evidence: Evidence[]
  jevMs: number
}

/** Lo que se dice al acabar. */
export function summaryOf(outcome: Outcome, noun: [string, string] = ['paso', 'pasos']): string {
  const count = `${outcome.written} ${outcome.written === 1 ? noun[0] : noun[1]}`
  if (outcome.stopped) return `Detenido: quedan hechos ${count}.`
  if (outcome.written === 0) return outcome.trouble ?? 'No se hizo nada.'
  if (outcome.trouble !== null) return `${outcome.trouble} Quedan hechos ${count}.`
  if (outcome.doubt) {
    return `Hecho en ${count}, pero el JEV duda de que cumpla todo lo pedido: revísalo.`
  }
  return `Hecho, en ${count}.`
}

/** Un texto que llega a trozos, convertido en una cola de objetos que se van sacando. */
function listen<T>(
  provider: AiProvider,
  request: AiRequest,
  accept: (value: unknown) => T | null,
  signal: AbortSignal,
) {
  const objects = new ObjectStream(accept)
  const queue: T[] = []
  const state = { done: false, failure: null as string | null, raw: '' }
  const finished = streamText(
    provider,
    request,
    (delta) => {
      state.raw += delta
      queue.push(...objects.push(delta))
    },
    signal,
  )
    .catch((error: unknown) => {
      if (!signal.aborted) {
        state.failure = `La IA dejó de responder (${error instanceof Error ? error.message : String(error)}).`
      }
    })
    .finally(() => {
      state.done = true
    })
  return { queue, state, finished }
}

/** El siguiente objeto de una cola que se va llenando; `null` cuando ya no va a llegar ninguno. */
async function next<T>(source: ReturnType<typeof listen<T>>, host: Stagehand): Promise<T | null> {
  for (;;) {
    if (host.signal.aborted) return null
    const item = source.queue.shift()
    if (item !== undefined) return item
    if (source.state.done) return source.queue.shift() ?? null
    await host.wait(40)
  }
}

/** Lo que contestó el modelo, recortado, para decirlo cuando no sirvió. */
const excerpt = (raw: string) => {
  const flat = raw.replace(/\s+/g, ' ').trim()
  return flat === ''
    ? 'no contestó nada'
    : `contestó «${flat.slice(0, 120)}${flat.length > 120 ? '…' : ''}»`
}

interface Tally {
  written: number
  code: string[]
  jevMs: number
  trouble: string | null
}

/**
 * Los pasos de una llamada: se sacan del streaming uno a uno y, por cada uno, el JEV juzga, se escribe, el
 * lienzo lo enseña y se espera lo que tarda en contarse. Devuelve cuántos escribió esta llamada.
 */
async function runSteps(
  host: Stagehand,
  players: Players,
  command: string,
  plan: BuildPlan,
  request: AiRequest,
  tally: Tally,
): Promise<number> {
  let wrote = 0
  // Si el modelo contesta sin dar ningún paso, se le pide otra vez, diciéndole qué se espera.
  for (let attempt = 1; attempt <= 2 && wrote === 0; attempt++) {
    const source = listen(
      players.provider,
      attempt === 1
        ? request
        : {
            ...request,
            prompt: `${request.prompt}\n\nTu respuesta anterior no traía ningún paso. Responde SOLO con líneas JSON como {"nivel": 0, "code": "…", "say": "…"}, una por sentencia.`,
          },
      stepOf,
      host.signal,
    )
    for (;;) {
      if (tally.written >= MAX_BUILD_STEPS) break
      const step: BuildStep | null = await next(source, host)
      if (step === null) break
      let verdict
      try {
        verdict = await judgeStep(players.decider, command, step)
      } catch {
        tally.trouble = 'El JEV dejó de responder: me detengo aquí.'
        break
      }
      tally.jevMs += verdict.ms
      if (verdict.safe < STEP_THRESHOLDS.safe) {
        tally.trouble =
          'El JEV no da por seguro el siguiente paso (toca archivos, la red o el sistema): me detengo.'
        break
      }
      if (host.signal.aborted) break
      const placed = plan.place(await host.program(), step)
      if (!placed.ok) {
        tally.trouble = placed.error
        break
      }
      if (placed.change) {
        const refused = await host.write(placed.change)
        if (refused !== null) {
          tally.trouble = refused
          break
        }
      }
      plan.commit(step, placed)
      if (!placed.change) continue
      wrote++
      tally.written++
      tally.code.push(step.code)
      await host.show({
        type: 'step',
        index: tally.written,
        say: step.say,
        line: placed.line,
        effect: 'born',
        ...(verdict.wide ? { wide: true } : {}),
      })
      await host.wait(paceOf(step, verdict.pause))
    }
    await source.finished
    if (host.signal.aborted || tally.trouble !== null) break
    if (wrote === 0) {
      tally.trouble =
        source.state.failure ??
        `La IA no dictó ningún paso que se pudiera escribir (${excerpt(source.state.raw)}).`
      if (attempt === 1 && source.state.failure === null) tally.trouble = null
    } else if (source.state.failure !== null) tally.trouble = source.state.failure
  }
  return wrote
}

export interface BuildRequest {
  command: string
  gen: string
  place: Spot
  /** Dónde va, dicho con palabras. */
  where: string
  /** Primero el esquema de etapas y luego cada una; si no, directo a los pasos. */
  outline: boolean
  /** Lo que se quiere es entender un tema: el programa es el medio. */
  teach?: boolean
}

/** Al acabar, el JEV juzga el conjunto. */
async function conclude(
  host: Stagehand,
  players: Players,
  command: string,
  tally: Tally,
): Promise<Outcome> {
  const stopped = host.signal.aborted
  let evidence: Evidence[] = []
  let doubt = false
  if (tally.written > 0 && !stopped && tally.trouble === null) {
    try {
      const whole = await judgeCode(players.decider, command, tally.code.join('\n'))
      evidence = whole.evidence
      tally.jevMs += whole.ms
      doubt = whole.fulfils < COMPOSE_THRESHOLDS.fulfils
    } catch {
      // Sin juicio final, lo hecho se queda como está.
    }
  }
  return {
    written: tally.written,
    stopped,
    trouble: tally.trouble,
    doubt,
    evidence,
    jevMs: tally.jevMs,
  }
}

/** Construir algo nuevo: primero el esquema (si hace falta), luego cada etapa, paso a paso. */
export async function build(
  host: Stagehand,
  players: Players,
  request: BuildRequest,
): Promise<Outcome> {
  const { command, gen } = request
  const tally: Tally = { written: 0, code: [], jevMs: 0, trouble: null }
  const start = await host.program()
  const anchor = start.nodes.find((n) => n.id === (request.place.after ?? request.place.into))
  await host.show({ type: 'progress', text: 'Leyendo lo que ya hay…' })
  const context = await contextFor(players.decider, {
    command,
    program: start,
    ...(anchor ? { must: [anchor.line, anchor.lineEnd ?? anchor.line] } : {}),
  })
  tally.jevMs += context.jevMs

  // ── El plan: las etapas, a grandes rasgos. Cada una aparece en cuanto se dicta. ──
  const stages: Stage[] = []
  if (request.outline && !host.signal.aborted) {
    await host.show({ type: 'progress', text: 'Pensando el plan, a grandes rasgos…' })
    const source = listen(
      players.provider,
      {
        system: outlineSystem(request.teach === true),
        prompt: outlinePrompt({ command, where: request.where, context: context.text }),
        maxTokens: 600,
      },
      stageOf,
      host.signal,
    )
    const skeleton = new BuildPlan(request.place)
    /** Una sola etapa no es un esquema: la primera espera a que llegue la segunda para dibujarse. */
    let held: Stage | null = null
    const draw = async (stage: Stage): Promise<boolean> => {
      const index = stages.length
      const step: BuildStep = {
        level: 0,
        code: `${stageHeading(stage)}\n...  # prysel:gen:${stageGen(gen, index)}`,
        say: stage.goal || stage.title,
      }
      const placed = skeleton.place(await host.program(), step)
      if (!placed.ok || !placed.change) return false
      if ((await host.write(placed.change)) !== null) return false
      skeleton.commit(step, placed)
      stages.push(stage)
      await host.show({
        type: 'step',
        index: stages.length,
        say: `${stage.title}. ${stage.goal}`.trim(),
        line: placed.line,
        effect: 'born',
        wide: true,
      })
      await host.wait(Math.min(2200, 500 + stage.title.length * 40))
      return true
    }
    for (;;) {
      if (stages.length >= MAX_STAGES) break
      const stage = await next(source, host)
      if (stage === null) break
      if (held === null && stages.length === 0) {
        held = stage
        continue
      }
      if (held !== null) {
        const first = held
        held = null
        if (!(await draw(first))) break
      }
      if (!(await draw(stage))) break
    }
    await source.finished
  }

  if (stages.length >= 2) {
    // ── Cada etapa, con lo ya escrito delante: otra llamada, más pequeña y mejor informada. ──
    for (const [index, stage] of stages.entries()) {
      if (host.signal.aborted || tally.trouble !== null) break
      await host.show({
        type: 'progress',
        text: `Etapa ${index + 1} de ${stages.length} · ${stage.title}: pensando sus pasos…`,
      })
      const now = await host.program()
      const mark = stageGen(gen, index)
      const hole = now.nodes.find((n) => n.generating === mark)
      if (!hole) continue
      const around = await contextFor(players.decider, {
        command,
        program: now,
        must: [hole.line],
      })
      tally.jevMs += around.jevMs
      const wrote = await runSteps(
        host,
        players,
        command,
        new BuildPlan({}, mark),
        {
          system: stageSystem(request.teach === true),
          prompt: stagePrompt({ command, stages, index, context: around.text }),
          maxTokens: 1800,
        },
        tally,
      )
      // Una etapa que se quedó sin pasos no se queda diciendo que algo está en marcha.
      if (wrote === 0 && !host.signal.aborted) {
        const left = clearGenerating(await host.program(), mark)
        if (left.edits.length > 0) await host.write(left)
      }
    }
    // Lo que no llegó a detallarse (se detuvo antes) deja de estar marcado como en marcha.
    for (const [index] of stages.entries()) {
      const left = clearGenerating(await host.program(), stageGen(gen, index))
      if (left.edits.length > 0) await host.write(left)
    }
  } else if (!host.signal.aborted) {
    // ── Directo: unos pocos pasos, sin esquema. ──
    await host.show({ type: 'progress', text: 'Pensando el primer paso…' })
    await runSteps(
      host,
      players,
      command,
      new BuildPlan(request.place),
      {
        system: request.teach ? `${buildStepsSystem()}\n${teachingNote()}` : buildStepsSystem(),
        prompt: buildStepsPrompt({
          command,
          where: request.where,
          context: context.text,
          ...(anchor?.scope ? { scope: anchor.scope } : {}),
        }),
        maxTokens: 3000,
      },
      tally,
    )
  }
  return conclude(host, players, command, tally)
}

export interface ModifyRequest {
  command: string
  /** A qué se refiere, si se sabe: las líneas de lo que se nombró, lo seleccionado o lo último que se hizo. */
  lines?: { from: number; to: number }
  /** Y cómo se dice eso («función sumar», «lo último que se construyó»). */
  scope?: string
}

const lineAt = (source: string, offset: number) => source.slice(0, offset).split('\n').length

/** Cambiar lo que ya está escrito: la IA dicta los cambios, uno a uno, y cada uno se juzga, se escribe y se ve. */
export async function modify(
  host: Stagehand,
  players: Players,
  request: ModifyRequest,
): Promise<Outcome> {
  const { command } = request
  const tally: Tally = { written: 0, code: [], jevMs: 0, trouble: null }
  const start = await host.program()
  await host.show({ type: 'progress', text: 'Leyendo lo que hay que cambiar…' })
  const context = await contextFor(players.decider, {
    command,
    program: start,
    ...(request.lines ? { must: [request.lines.from, request.lines.to] } : {}),
  })
  tally.jevMs += context.jevMs
  if (host.signal.aborted) return conclude(host, players, command, tally)
  await host.show({ type: 'progress', text: 'Pensando qué hay que cambiar…' })
  const source = listen(
    players.provider,
    {
      system: modifySystem(),
      prompt: modifyPrompt({
        command,
        scope: request.lines
          ? `La orden se refiere a ${request.scope ?? 'esto'}: líneas ${request.lines.from}–${request.lines.to}. Cambia fuera de ahí solo lo que haga falta para que el programa siga siendo coherente.`
          : '',
        context: context.text,
      }),
      maxTokens: 2500,
    },
    opOf,
    host.signal,
  )
  const map = new LineMap()
  for (;;) {
    if (tally.written >= MAX_OPS) break
    const op: ChangeOp | null = await next(source, host)
    if (op === null) break
    const code = op.op === 'remove' ? '' : op.code
    let verdict = { safe: 1, wide: false, pause: false, ms: 0 }
    if (code !== '') {
      try {
        verdict = await judgeStep(players.decider, command, { level: 0, code, say: op.say })
      } catch {
        tally.trouble = 'El JEV dejó de responder: me detengo aquí.'
        break
      }
      tally.jevMs += verdict.ms
      if (verdict.safe < STEP_THRESHOLDS.safe) {
        tally.trouble =
          'El JEV no da por seguro el siguiente cambio (toca archivos, la red o el sistema): me detengo.'
        break
      }
    }
    if (host.signal.aborted) break
    const program = await host.program()
    const applied = applyOp(program, map, op)
    if (!applied.ok) {
      tally.trouble = applied.error
      break
    }
    const index = tally.written + 1
    // Lo que se va se enseña antes de quitarlo: se ve qué desaparece, y por qué.
    if (applied.effect === 'leaving') {
      await host.show({ type: 'step', index, say: op.say, line: applied.line, effect: 'leaving' })
      await host.wait(700)
      if (host.signal.aborted) break
    }
    const [first] = applied.change.edits
    if (first) {
      const refused = await host.write(applied.change)
      if (refused !== null) {
        tally.trouble = refused
        break
      }
      const begins = lineAt(program.source, first.start)
      const above = applied.effect === 'leaving' || (first.start === 0 && first.end === 0)
      map.moved(
        above ? begins - 1 : begins,
        lineDelta(program.source, applyEdits(program.source, applied.change.edits)),
      )
    }
    tally.written++
    tally.code.push(op.op === 'remove' ? `# se quita la línea ${op.line}` : op.code)
    if (applied.effect !== 'leaving') {
      await host.show({
        type: 'step',
        index,
        say: op.say,
        line: applied.line,
        effect: applied.effect,
        ...(verdict.wide ? { wide: true } : {}),
      })
    }
    await host.wait(paceOf({ level: 0, code, say: op.say }, verdict.pause))
  }
  await source.finished
  if (!host.signal.aborted && tally.trouble === null) {
    if (source.state.failure !== null) tally.trouble = source.state.failure
    else if (tally.written === 0) {
      tally.trouble = `La IA no propuso ningún cambio (${excerpt(source.state.raw)}).`
    }
  }
  // El juicio final mira cómo quedó el programa, no la lista de cambios.
  const after = await host.program()
  if (tally.written > 0 && after.source.length <= WHOLE_BUDGET) tally.code = [after.source]
  return conclude(host, players, command, tally)
}
