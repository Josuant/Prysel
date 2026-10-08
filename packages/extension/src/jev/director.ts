import type { Program } from '@prysel/python'
import {
  applyEdits,
  clearGenerating,
  deleteNode,
  removeSection,
  type Change,
} from '@prysel/python/edits'
import type { AiProvider, AiRequest } from '../ai/provider.ts'
import { streamText } from '../ai/stream.ts'
import {
  BuildPlan,
  MAX_BUILD_STEPS,
  MAX_STAGES,
  ObjectStream,
  STEP_THRESHOLDS,
  judgeStage,
  judgeStep,
  outlinePrompt,
  paceOf,
  stageGen,
  stageHeading,
  type BuildStep,
  type Reader,
  type Stage,
} from './build.ts'
import type { Decider } from './client.ts'
import { COMPOSE_THRESHOLDS, judgeCode } from './compose.ts'
import { WHOLE_BUDGET, contextFor } from './context.ts'
import { reachesOutside, safeEnough } from './safety.ts'
import type { Evidence, Spot } from './engine.ts'
import {
  CodeStream,
  LineStream,
  codePrompt,
  codeSystem,
  formulaOf,
  formulaSystem,
  introSystem,
  judgeChunk,
  judgeMarks,
  planSystem,
  type Chunk,
  type ChunkVerdict,
  sentenceOf,
  stageFromLine,
  tellPrompt,
  tellSystem,
} from './plain.ts'
import { formatVisual, seriesIn, visualOf } from './visual.ts'
import {
  applyOp,
  changesBetween,
  indentationOk,
  lineDelta,
  LineMap,
  MAX_OPS,
  modifyPrompt,
  modifySystem,
  opOf,
  rewritePrompt,
  rewriteSystem,
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
  /** ¿Es esto Python, sin errores de sintaxis? Para apartar lo que un modelo escribe alrededor del código. */
  parses(code: string): boolean
  /** Algo que enseñar en el lienzo (ya con el programa nuevo delante). */
  show(event: Shown): Promise<void>
  /** Espera un rato, sin pasar de que se detenga. */
  wait(ms: number): Promise<void>
  /**
   * Espera a que lo último que se enseñó **se haya dicho** en voz alta. Si no hay voz (está apagada, o no hay
   * lienzo), espera `estimate`: lo que se tardaría en leerlo.
   */
  settle(estimate: number): Promise<void>
  /**
   * Lo que hay preparado y aún sin escribir (el código de cada trozo, en orden). Es la recámara: si el
   * usuario interrumpe, con esto se decide si lo preparado sigue valiendo.
   */
  buffer?(pending: readonly string[]): void
}

export type Shown =
  /** En qué se está pensando ahora: lo que se lee mientras no hay nada nuevo que ver. */
  | { type: 'progress'; text: string }
  /** Algo que decir sin señalar ninguna pieza: el comentario de entrada. */
  /** `aside`: un comentario al margen de lo que se va escribiendo: se lee y se dice sin parar nada. */
  | { type: 'say'; say: string; aside?: boolean }
  | {
      type: 'step'
      index: number
      say: string
      /** La línea de la sentencia que aparece, cambia o se va. */
      line: number
      /**
       * `born`: aparece. `told`: ya estaba, y ahora llega su explicación (se dice, y la cámara va a ella).
       * `changed` y `leaving`: cambia, o está a punto de quitarse.
       */
      effect: 'born' | 'told' | 'changed' | 'leaving'
      /**
       * El trozo exacto del código de la pieza que se subraya mientras se dice su frase: el elegido y sus
       * suplentes, por orden (el lienzo subraya el primero que encuentra escrito en el nodo).
       */
      mark?: string[]
      /** La cámara enseña el conjunto, no solo la pieza. */
      wide?: boolean
      /** Entra en una parte del plan que se deja plegada: se señala su tarjeta, no la línea. */
      folded?: boolean
      /**
       * La línea donde se queda la cámara mientras esta pieza entra: la cabecera de lo que se está
       * construyendo (la caja de la función). Lo de dentro aparece sin que la vista salte de línea en línea.
       */
      anchor?: number
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
  /**
   * Lo que se construyó es una sola cosa con interior (una función, una clase): la línea de su cabecera. Al
   * acabar, la vista entra en ella: es donde se va a seguir trabajando.
   */
  enter?: number
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
  reading: Reader<T>,
  signal: AbortSignal,
) {
  const queue: T[] = []
  const state = { done: false, failure: null as string | null, raw: '' }
  const finished = streamText(
    provider,
    request,
    (delta) => {
      state.raw += delta
      queue.push(...reading.push(delta))
    },
    signal,
  )
    .then(() => {
      // Lo que quedó a medias al acabar (o al cortarse la respuesta) se aprovecha hasta donde llegó.
      queue.push(...reading.end())
    })
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
  /** El código escrito, trozo a trozo: lo que el JEV juzga al final. */
  code: string[]
  jevMs: number
  trouble: string | null
  /** Las cabeceras de las funciones y clases escritas (su línea), y cuántos trozos se escribieron en total. */
  heads: number[]
  chunks: number
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
  /**
   * A qué ritmo se construye. `voice` (por defecto): cada pieza espera a que se haya dicho su frase, como en
   * una clase. `stream`: al ritmo de la IA; cada pieza aparece en cuanto llega su código y el JEV la da por
   * buena, y de cada trozo se comenta una frase al margen, sin esperar a nadie.
   */
  flow?: 'voice' | 'stream'
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
    ...(tally.chunks === 1 && tally.heads.length === 1 && tally.heads[0] !== undefined
      ? { enter: tally.heads[0] }
      : {}),
  }
}

/**
 * Lo que se dice de cada pieza de un trozo: una llamada pequeña, y de vuelta una frase por pieza (una por
 * línea, en su orden). Si faltan frases, esas piezas aparecen sin voz; nunca se deja de escribir por eso.
 */
async function tellAll(
  players: Players,
  request: { command: string; pieces: string[]; stage?: Stage; written: string; teach: boolean },
): Promise<string[]> {
  try {
    const text = await players.provider.generate({
      system: tellSystem(request.teach),
      prompt: tellPrompt(request),
      maxTokens: 120 + 70 * request.pieces.length,
    })
    const said = text
      .split('\n')
      .map((line) => sentenceOf(line.replace(/^\s*(?:\[\d+\]|\d+[.):-]|[-*•])\s*/, '')))
      .filter((line) => line !== '')
      // Si contesta de más, es que ha repasado antes lo ya escrito: las de estas piezas son las últimas.
      .slice(-request.pieces.length)
    return request.pieces.map((_, index) => said[index] ?? '')
  } catch {
    return request.pieces.map(() => '')
  }
}

/** La fórmula de una función, pedida a la IA: solo la fórmula. `null` si no contesta. */
async function formulaFor(players: Players, code: string): Promise<string | null> {
  try {
    return formulaOf(
      await players.provider.generate({ system: formulaSystem(), prompt: code, maxTokens: 80 }),
    )
  } catch {
    return null
  }
}

/**
 * Apunta la ayuda visual de una función junto a su cabecera (una marca al final de su línea), si su fórmula
 * se puede dibujar, entre los valores de x que eligió el JEV.
 */
async function addAid(
  host: Stagehand,
  formula: string,
  line: number,
  range: [number, number],
): Promise<void> {
  const program = await host.program()
  const node = program.nodes.find((n) => n.range && n.line === line)
  if (!node?.range) return
  const title = node.label.charAt(0).toUpperCase() + node.label.slice(1).replace(/_/g, ' ')
  const visual = visualOf({
    tipo: 'curva',
    titulo: title,
    y: formula,
    desde: range[0],
    hasta: range[1],
  })
  if (!visual) return
  // Al final de la línea de su cabecera, si no lleva ya un comentario.
  const source = program.source
  const head = node.range.head ?? node.range.end
  const eol = source.indexOf('\n', head)
  const rest = source.slice(head, eol < 0 ? source.length : eol)
  if (rest.trim() !== '') return
  await host.write({ edits: [{ start: head, end: head, text: `  # ${formatVisual(visual)}` }] })
}

/** Un trozo ya preparado para enseñarse: lo que decidió el JEV y lo que se va a decir de cada pieza. */
interface Prepared {
  chunk: Chunk
  /** `null`: el JEV no contestó. */
  verdict: ChunkVerdict | null
  /** La parte del plan a la que va. */
  stage: number
  /** Los momentos del trozo: cada cosa que se enseña y se cuenta por separado. */
  moments: Moment[]
  /** La frase de cada momento, en su orden. */
  says: string[]
  /** Al ritmo de la IA: la frase del trozo entero, que llega cuando llega. */
  aside?: Promise<string>
  /** El trozo exacto del código que se subraya en cada momento (`''`: ninguno). Lo elige el JEV. */
  marks: string[][]
  formula: string | null
}

/**
 * Un momento de la explicación: una pieza que aparece (un paso), o —en un bloque que se escribe entero, como
 * un `if` con sus `elif`— cada una de sus partes, que se va señalando y contando después de escrito.
 */
interface Moment {
  /** El paso del trozo al que pertenece. */
  step: number
  /** Cuántas líneas por debajo de la primera línea de ese paso está. */
  offset: number
  code: string
}

function momentsOf(chunk: Chunk): Moment[] {
  return chunk.steps.flatMap((step, index) =>
    step.parts && step.parts.length > 0
      ? step.parts.map((part) => ({ step: index, offset: part.offset, code: part.code }))
      : [{ step: index, offset: 0, code: step.code }],
  )
}

/** Entre dos piezas que aparecen sin frase: lo justo para que se vea llegar cada una. */
const QUIET_PACE_MS = 900
/** Al ritmo de la IA: lo que se deja entre pieza y pieza para que se vea entrar cada una. */
const STREAM_PACE_MS = 480
/** Tras decir una idea clave (lo decide el JEV): un respiro antes de seguir. */
const KEY_PAUSE_MS = 500

/**
 * Construir algo nuevo. A la IA se le pide solo contenido, en llamadas pequeñas: la lista de partes, el
 * código, y una frase por cada trozo. La estructura la pone el JEV (a qué parte va cada trozo, cómo se
 * enseña) y este director, que escribe cada sentencia **en cuanto llega su código**: el diagrama crece
 * mientras la IA sigue escribiendo, y la explicación de cada trozo llega detrás.
 */
export async function build(
  host: Stagehand,
  players: Players,
  request: BuildRequest,
): Promise<Outcome> {
  const { command, gen } = request
  const teach = request.teach === true
  const streaming = request.flow === 'stream'
  const tally: Tally = { written: 0, code: [], jevMs: 0, trouble: null, heads: [], chunks: 0 }
  const start = await host.program()
  const anchor = start.nodes.find((n) => n.id === (request.place.after ?? request.place.into))
  await host.show({ type: 'progress', text: 'Leyendo lo que ya hay…' })
  const context = await contextFor(players.decider, {
    command,
    program: start,
    ...(anchor ? { must: [anchor.line, anchor.lineEnd ?? anchor.line] } : {}),
  })
  tally.jevMs += context.jevMs

  // ── El plan: una lista de partes. Cada una aparece en el diagrama en cuanto llega su línea. ──
  const stages: Stage[] = []
  if (request.outline && !host.signal.aborted) {
    await host.show({ type: 'progress', text: 'Pensando el plan, a grandes rasgos…' })
    const intro = players.provider
      .generate({
        system: introSystem(teach),
        prompt: `Lo que se pidió: ${command}`,
        maxTokens: 200,
      })
      .then((text) => sentenceOf(text, 260))
      .catch(() => '')
    const source = listen(
      players.provider,
      {
        system: planSystem(teach),
        prompt: outlinePrompt({ command, where: request.where, context: context.text }),
        maxTokens: 700,
      },
      new LineStream(stageFromLine),
      host.signal,
    )
    // El comentario de entrada: qué se va a hacer. Se pide a la vez que el plan y se dice antes de enseñarlo.
    const opening = await intro
    if (opening !== '' && !host.signal.aborted) {
      await host.show({ type: 'say', say: opening })
      // Al ritmo de la IA, el plan se dibuja mientras se dice.
      if (!streaming) await host.settle(paceOf({ level: 0, code: '', say: opening }, false))
    }
    const skeleton = new BuildPlan(request.place)
    /** Una sola parte no es un plan: la primera espera a que llegue la segunda para dibujarse. */
    let held: Stage | null = null
    const draw = async (stage: Stage): Promise<boolean> => {
      const step: BuildStep = {
        level: 0,
        code: `${stageHeading(stage)}\n...  # prysel:gen:${stageGen(gen, stages.length)}`,
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
        // Del plan se dice solo el título de cada parte: lo demás se lee en su caja.
        say: streaming ? '' : stage.title,
        line: placed.line,
        effect: 'born',
        wide: true,
      })
      if (streaming) await host.wait(STREAM_PACE_MS)
      else await host.settle(Math.min(2200, 500 + stage.title.length * 40))
      return true
    }
    for (;;) {
      if (stages.length >= MAX_STAGES) break
      const stage = await next(source, host)
      if (stage === null) break
      // El JEV mira cada parte según llega: la que no pinta nada en lo que se pidió se queda fuera.
      try {
        const fit = await judgeStage(players.decider, command, stage)
        tally.jevMs += fit.ms
        if (fit.fits < STEP_THRESHOLDS.stage) continue
      } catch {
        // Sin su juicio, la parte entra: es mejor un plan con una parte de más que quedarse sin plan.
      }
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
  const planned = stages.length >= 2

  // ── El código: una sola llamada, y de vuelta Python tal cual. Cada sentencia se escribe al llegar. ──
  let current = 0
  let plan = planned ? new BuildPlan({}, stageGen(gen, 0)) : new BuildPlan(request.place)
  const used = new Set<number>()
  const plans = new Map<number, BuildPlan>()
  if (!host.signal.aborted) {
    await host.show({
      type: 'progress',
      text: planned
        ? `Escribiendo el código · ${stages[0]?.title ?? ''}…`
        : 'Escribiendo el código…',
    })
    const source = listen(
      players.provider,
      {
        system: codeSystem(teach),
        prompt: codePrompt({
          command,
          where: request.where,
          context: context.text,
          stages: planned ? stages : [],
          ...(anchor?.scope ? { scope: anchor.scope } : {}),
        }),
        maxTokens: 3000,
      },
      new CodeStream(),
      host.signal,
    )
    // Mientras se enseña un trozo, el siguiente se prepara: el JEV lo juzga y la IA escribe lo que se va a
    // decir de cada una de sus piezas. Así nada aparece sin su explicación, y entre trozo y trozo no hay huecos.
    const ready: Prepared[] = []
    // `stop`: ya no se va a escribir nada más (algo falló, o se llegó al tope): no se prepara más.
    const prep = { done: false, stop: false }
    /** Lo que se está preparando, dicho en el momento: cada respuesta de un modelo se nota en el lienzo. */
    const note = (text: string) => host.show({ type: 'progress', text }).catch(() => undefined)
    const titleOf = (code: string) => {
      const row = code.split('\n').find((line) => line.trim() !== '') ?? ''
      return row.trim().length > 44 ? `${row.trim().slice(0, 43)}…` : row.trim()
    }
    const preparing = (async () => {
      const seen: string[] = []
      let stage = 0
      for (;;) {
        const chunk = await next(source, host)
        if (chunk === null || prep.stop) break
        // Lo que no es Python (una frase suelta que el modelo puso alrededor) no es parte del programa.
        if (!host.parses(chunk.code)) continue
        await note(`Llegó código: ${titleOf(chunk.code)} · lo mira el JEV…`)
        let verdict: ChunkVerdict | null = null
        try {
          verdict = await judgeChunk(
            players.decider,
            command,
            chunk.code,
            planned ? stages : [],
            seen.join('\n'),
          )
          tally.jevMs += verdict.ms
        } catch {
          verdict = null
        }
        const safe = verdict !== null && safeEnough(chunk.code, verdict.safe)
        // El código va hacia delante: un trozo puede abrir una parte posterior del plan, nunca volver atrás.
        if (
          planned &&
          verdict?.stage != null &&
          verdict.stage > stage &&
          verdict.stage < stages.length
        ) {
          stage = verdict.stage
        }
        // Salvo una función o una clase: se puede definir en cualquier parte del archivo, así que si el modelo
        // la dicta fuera de orden vuelve a la parte del plan que le toca, en vez de quedarse esa parte vacía.
        const back =
          planned &&
          verdict?.stage != null &&
          verdict.stage < stage &&
          /^(?:@|def |async def |class )/.test(
            chunk.code.split('\n').find((row) => row.trim() !== '' && !row.startsWith('#')) ?? '',
          )
        const home = back && verdict?.stage != null ? verdict.stage : stage
        const planStage = planned ? stages[home] : undefined
        const moments = momentsOf(chunk)
        if (prep.stop) break
        await note(
          safe
            ? planned
              ? `JEV ✓ · va en «${stages[home]?.title ?? ''}» · pensando cómo contarlo…`
              : 'JEV ✓ · pensando cómo contarlo…'
            : verdict === null
              ? 'El JEV no contestó.'
              : 'JEV ✗ · este trozo no se escribe.',
        )
        // Al ritmo de la IA no se espera a las frases: el trozo se escribe ya, y de él se pide una sola frase,
        // que se dirá al margen cuando llegue.
        const aside =
          streaming && safe
            ? tellAll(players, {
                command,
                pieces: [chunk.code],
                ...(planStage ? { stage: planStage } : {}),
                written: seen.join('\n'),
                teach,
              }).then(([say]) => say ?? '')
            : undefined
        const [says, formula] =
          safe && !streaming
            ? await Promise.all([
                tellAll(players, {
                  command,
                  pieces: moments.map((moment) => moment.code),
                  ...(planStage ? { stage: planStage } : {}),
                  written: seen.join('\n'),
                  teach,
                }),
                verdict?.aid ? formulaFor(players, chunk.code) : Promise.resolve(null),
              ])
            : [[], null]
        seen.push(chunk.code)
        // Una lista de números se ve mejor dibujada: su ayuda sale del propio código.
        const [only] = chunk.steps
        const series = chunk.steps.length === 1 && only ? seriesIn(only.code) : null
        if (series && only) only.visual = series
        // Y el JEV elige, de cada frase, de qué trozo exacto del código habla: es lo que se subrayará.
        let marks: string[][] = []
        if (safe && !streaming) {
          try {
            const chosen = await judgeMarks(
              players.decider,
              moments.map((moment, index) => ({ code: moment.code, say: says[index] ?? '' })),
            )
            marks = chosen.marks
            tally.jevMs += chosen.ms
          } catch {
            marks = []
          }
        }
        ready.push({
          chunk,
          verdict,
          stage: home,
          moments,
          says,
          marks,
          formula,
          ...(aside ? { aside } : {}),
        })
        // Lo preparado y aún sin escribir: lo que hay «en la recámara» si el usuario interrumpe.
        host.buffer?.(ready.map((item) => item.chunk.code))
        // Tras un trozo que no se va a escribir no se prepara nada más.
        if (!safe) break
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        prep.done = true
      })

    for (;;) {
      if (tally.written >= MAX_BUILD_STEPS) break
      let item: Prepared | undefined
      for (;;) {
        if (host.signal.aborted) break
        item = ready.shift()
        if (item || prep.done) break
        await host.wait(40)
      }
      item ??= ready.shift()
      if (!item || host.signal.aborted) break
      host.buffer?.(ready.map((waiting) => waiting.chunk.code))
      const { chunk, verdict } = item
      if (verdict === null) {
        tally.trouble = 'El JEV dejó de responder: me detengo aquí.'
        break
      }
      if (!safeEnough(chunk.code, verdict.safe)) {
        // Se dice por qué: o el trozo tiene con qué salir del programa, o el JEV lo rechaza de plano.
        tally.trouble = reachesOutside(chunk.code)
          ? 'El JEV no da por seguro el siguiente trozo, que puede tocar archivos, la red o el sistema: me detengo.'
          : 'El JEV da por arriesgado el siguiente trozo: me detengo.'
        break
      }
      if (planned && item.stage !== current) {
        current = item.stage
        // Cada parte del plan guarda por dónde iba: se puede volver a una que ya tenía algo escrito.
        plan = plans.get(current) ?? new BuildPlan({}, stageGen(gen, current))
      }
      if (planned) plans.set(current, plan)
      if (planned) used.add(current)
      // El comentario del trozo se dice al margen en cuanto llega, sin parar lo que se está escribiendo.
      void item.aside
        ?.then((say) => {
          if (say !== '' && !host.signal.aborted) {
            return host.show({ type: 'say', say, aside: true })
          }
        })
        .catch(() => undefined)
      // Cada pieza aparece con su frase, y la siguiente espera a que esa frase se haya dicho.
      let first: number | null = null
      for (const [index, step] of chunk.steps.entries()) {
        const before = await host.program()
        const placed = plan.place(before, step)
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
          // Lo escrito empuja hacia abajo lo que las otras partes del plan tenían más abajo.
          for (const edit of placed.change.edits) {
            const lines = (text: string) => text.split('\n').length - 1
            const at = lines(before.source.slice(0, edit.start)) + 1
            const delta = lines(edit.text) - lines(before.source.slice(edit.start, edit.end))
            for (const other of plans.values()) if (other !== plan) other.shift(at, delta)
          }
        }
        plan.commit(step, placed)
        if (!placed.change) continue
        tally.written++
        // La curva de una función se apunta con su cabecera: aparece con ella.
        if (first === null && item.formula && verdict.aid) {
          await addAid(host, item.formula, placed.line, verdict.aid)
        }
        first ??= placed.line
        // Lo que se enseña y se cuenta de este paso: él mismo o, si es un bloque entero, cada una de sus
        // partes (las ramas de un `if`/`elif`), una detrás de otra, ya escritas.
        let shown = 0
        for (const [at, moment] of item.moments.entries()) {
          if (moment.step !== index) continue
          const say = item.says[at] ?? ''
          const mark = item.marks[at] ?? []
          await host.show({
            type: 'step',
            index: tally.written,
            say,
            line: placed.line + moment.offset,
            effect: shown === 0 ? 'born' : 'told',
            // El conjunto se enseña al llegar el trozo (su cabecera); lo de dentro, de cerca.
            ...(verdict.wide && shown === 0 && index === 0 ? { wide: true } : {}),
            // Al ritmo de la IA se sigue el plan, no cada línea: se ve llenarse la tarjeta de cada parte.
            ...(streaming && planned ? { folded: true } : {}),
            // Y la cámara no persigue cada línea: se queda en la caja de lo que se está construyendo.
            ...(streaming && first !== placed.line ? { anchor: first } : {}),
            ...(mark.length === 0 ? {} : { mark }),
          })
          shown++
          // Lo siguiente no aparece hasta que esto se haya dicho… salvo al ritmo de la IA, que solo deja
          // el tiempo justo para que se vea entrar cada pieza.
          if (streaming) await host.wait(STREAM_PACE_MS)
          else if (say === '') await host.wait(QUIET_PACE_MS)
          else {
            await host.settle(paceOf({ level: 0, code: moment.code, say }, false))
            // Una idea clave se deja reposar un momento.
            if (verdict.pause && index === 0 && shown === 1) await host.wait(KEY_PAUSE_MS)
          }
          if (host.signal.aborted) break
        }
        if (host.signal.aborted) break
      }
      if (tally.trouble !== null) break
      tally.code.push(chunk.code)
      tally.chunks++
      if (
        first !== null &&
        /^(?:@|def |async def |class )/.test(
          chunk.code.split('\n').find((row) => row.trim() !== '' && !row.startsWith('#')) ?? '',
        )
      ) {
        tally.heads.push(first)
      }
    }
    prep.stop = true
    await preparing
    // Si algo falló, no se espera a que la IA acabe de dictar lo que ya no se va a escribir.
    if (tally.trouble === null) await source.finished
    if (!host.signal.aborted && tally.trouble === null) {
      if (source.state.failure !== null) tally.trouble = source.state.failure
      else if (tally.written === 0) {
        tally.trouble = `La IA no escribió código que se pudiera usar (${excerpt(source.state.raw)}).`
      }
    }
  }

  // ── Los huecos del plan que quedaron: ninguno se queda diciendo que algo está en marcha. ──
  for (const [index] of stages.entries()) {
    const mark = stageGen(gen, index)
    const program = await host.program()
    const hole = program.nodes.find((n) => n.generating === mark)
    if (!hole) continue
    const section = (program.sections ?? []).find((item) => item.members.includes(hole.id))
    // Una parte a la que no fue ningún código, si se llegó a escribir algo, sobra: se quita con su rótulo.
    if (tally.written > 0 && !used.has(index) && section) {
      await host.write(removeSection(program, section.id))
      const after = await host.program()
      const left = after.nodes.find((n) => n.generating === mark)
      if (left) await host.write(deleteNode(after, left.id))
    } else {
      const left = clearGenerating(program, mark)
      if (left.edits.length > 0) await host.write(left)
    }
  }
  return conclude(host, players, command, tally)
}

export interface ModifyRequest {
  command: string
  /** A qué se refiere, si se sabe: las líneas de lo que se nombró, lo seleccionado o lo último que se hizo. */
  lines?: { from: number; to: number }
  /** Y cómo se dice eso («función sumar», «lo último que se construyó»). */
  scope?: string
  /**
   * Si el programa es pequeño, pedir a la IA el programa entero ya cambiado (código, sin formato) y
   * escribirlo de una vez, en lugar de una lista de cambios línea a línea: no hay números de línea que
   * fallen, ni sangrías que componer, ni estados a medias.
   */
  whole?: boolean
}

/** El código de una respuesta, sin la valla (```python … ```) que el modelo le pone a veces alrededor. */
const unfenced = (text: string) => {
  const fenced = /```(?:python|py)?[ \t]*\n([\s\S]*?)\n?```/.exec(text)
  return (fenced?.[1] ?? text).replace(/\r\n/g, '\n').replace(/\s+$/, '')
}

/**
 * Cambiar un programa pequeño reescribiéndolo: la IA devuelve el programa entero con el cambio hecho; se
 * comprueba (que sea Python, que su sangría tenga sentido, que el JEV lo dé por seguro) y se escribe **de
 * una vez**. Después se enseña cada tramo que cambió. Si algo no vale, no se toca nada.
 */
async function rewrite(
  host: Stagehand,
  players: Players,
  request: ModifyRequest,
  start: Program,
): Promise<Outcome> {
  const { command } = request
  const before = start.source
  const failed = (trouble: string, jevMs = 0): Outcome => ({
    written: 0,
    stopped: host.signal.aborted,
    trouble,
    doubt: false,
    evidence: [],
    jevMs,
  })
  await host.show({ type: 'progress', text: 'Pensando el cambio…' })
  let answer = ''
  try {
    answer = await players.provider.generate({
      system: rewriteSystem(),
      prompt: rewritePrompt({
        command,
        source: before.replace(/\r\n/g, '\n'),
        ...(request.scope ? { scope: request.scope } : {}),
      }),
      maxTokens: 3500,
    })
  } catch (error) {
    return failed(`La IA no contestó. ${error instanceof Error ? error.message : String(error)}`)
  }
  if (host.signal.aborted) return failed('')
  const eol = before.includes('\r\n') ? '\r\n' : '\n'
  const body = unfenced(answer)
  const after = (body === '' ? '' : `${body}\n`).replace(/\n/g, eol)
  if (body === '') return failed('La IA no devolvió el programa.')
  if (after.trimEnd() === before.trimEnd()) return failed('La IA no propuso ningún cambio.')
  if (!host.parses(after) || !indentationOk(after)) {
    return failed('El cambio que propuso la IA no deja un programa válido: no toco nada.')
  }
  await host.show({ type: 'progress', text: 'Llegó el cambio · lo mira el JEV…' })
  let verdict: Awaited<ReturnType<typeof judgeCode>>
  try {
    verdict = await judgeCode(players.decider, command, after)
  } catch {
    return failed('El JEV dejó de responder: no toco nada.')
  }
  if (!safeEnough(after, verdict.safe)) {
    return failed(
      reachesOutside(after)
        ? 'El JEV no da por seguro el cambio, que puede tocar archivos, la red o el sistema: no toco nada.'
        : 'El JEV da por arriesgado el cambio: no toco nada.',
      verdict.ms,
    )
  }
  const { edit, hunks } = changesBetween(
    before.replace(/\r\n/g, '\n'),
    after.replace(/\r\n/g, '\n'),
  )
  if (!edit) return failed('La IA no propuso ningún cambio.', verdict.ms)
  // Se escribe por tramos, de arriba abajo, para que se vea crecer: cada tramo que cambia entra, se señala
  // y deja paso al siguiente. Pero nunca queda a medias: un tramo solo se escribe si con él el programa
  // sigue siendo válido; si no, espera al siguiente y entran juntos. El último deja el programa final.
  const target = after.replace(/\r\n/g, '\n').split('\n')
  let current = before.replace(/\r\n/g, '\n').split('\n')
  let shift = 0
  let written = 0
  let waiting: typeof hunks = []
  for (const [index, hunk] of hunks.entries()) {
    if (host.signal.aborted) break
    // Todo lo de arriba ya es como en el programa nuevo: el tramo cae en su línea de allí.
    current = [
      ...current.slice(0, hunk.line - 1),
      ...target.slice(hunk.line - 1, hunk.line - 1 + hunk.added),
      ...current.slice(hunk.line - 1 + hunk.removed),
    ]
    waiting.push(hunk)
    const last = index === hunks.length - 1
    const text = (last ? target : current).join(eol)
    if (!last && !(host.parses(text) && indentationOk(text))) continue
    const live = (await host.program()).source
    const refused = await host.write({
      edits: [{ start: 0, end: live.length, text }],
      select: { line: waiting[0]?.line ?? 1 },
    })
    if (refused !== null) return failed(refused, verdict.ms)
    shift++
    const now = await host.program()
    for (const shown of waiting) {
      if (shown.added === 0) continue
      const end = shown.line + shown.added - 1
      const node =
        now.nodes
          .filter((item) => item.range && item.line >= shown.line && item.line <= end)
          .sort((x, y) => x.line - y.line)[0] ??
        now.nodes
          .filter((item) => item.range && item.line <= shown.line)
          .sort((x, y) => y.line - x.line)[0]
      if (!node) continue
      written++
      await host.show({
        type: 'step',
        index: written,
        say: '',
        line: node.line,
        effect: shown.removed === 0 ? 'born' : 'changed',
      })
      await host.wait(STREAM_PACE_MS)
    }
    waiting = []
  }
  if (shift === 0) return failed('No se pudo escribir el cambio.', verdict.ms)
  await host.show({ type: 'progress', text: 'JEV ✓ · cambio escrito' })
  // Una frase, al margen, de lo que se ha hecho.
  const changed = after
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((_, index) =>
      hunks.some((hunk) => index + 1 >= hunk.line && index + 1 < hunk.line + hunk.added),
    )
    .join('\n')
  try {
    const say = sentenceOf(
      await players.provider.generate({
        system:
          'Acabas de cambiar un programa. Di en UNA sola frase corta (menos de veinte palabras), en español y sin código, qué has cambiado. Solo la frase: se leerá en voz alta.',
        prompt: `Lo que se pidió: ${command}\n\nLas líneas nuevas o cambiadas:\n${changed.slice(0, 1500)}`,
        maxTokens: 120,
      }),
      220,
    )
    if (say !== '' && !host.signal.aborted) await host.show({ type: 'say', say, aside: true })
  } catch {
    // Sin frase, el cambio se queda igual de hecho.
  }
  return {
    written: Math.max(1, written),
    stopped: host.signal.aborted,
    trouble: null,
    doubt: verdict.fulfils < COMPOSE_THRESHOLDS.fulfils,
    evidence: verdict.evidence,
    jevMs: verdict.ms,
  }
}

const lineAt = (source: string, offset: number) => source.slice(0, offset).split('\n').length

/** Cambiar lo que ya está escrito: la IA dicta los cambios, uno a uno, y cada uno se juzga, se escribe y se ve. */
export async function modify(
  host: Stagehand,
  players: Players,
  request: ModifyRequest,
): Promise<Outcome> {
  const { command } = request
  const tally: Tally = { written: 0, code: [], jevMs: 0, trouble: null, heads: [], chunks: 0 }
  const start = await host.program()
  // Un programa que cabe entero se cambia reescribiéndolo: es más fiable que dictar cambios línea a línea.
  if (request.whole && start.source.length <= WHOLE_BUDGET) {
    return rewrite(host, players, request, start)
  }
  await host.show({ type: 'progress', text: 'Leyendo lo que hay que cambiar…' })
  const context = await contextFor(players.decider, {
    command,
    program: start,
    ...(request.lines ? { must: [request.lines.from, request.lines.to] } : {}),
  })
  tally.jevMs += context.jevMs
  if (host.signal.aborted) return conclude(host, players, command, tally)
  await host.show({ type: 'progress', text: 'Pensando qué hay que cambiar…' })
  const ops = new ObjectStream(opOf)
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
    // Los cambios siguen llegando como objetos: se leen vengan como vengan.
    { push: (delta) => ops.push(delta), end: () => [] },
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
      if (!safeEnough(code, verdict.safe)) {
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
    await host.settle(paceOf({ level: 0, code, say: op.say }, verdict.pause))
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
