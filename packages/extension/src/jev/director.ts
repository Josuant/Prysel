import type { Program, ProgramNode } from '@prysel/python'
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
import type { Trace } from '../trace.ts'
import {
  consult,
  correctedPlan,
  correctionSaid,
  correctionsOf,
  EXPERT_IDS,
  EXPERTS,
  judgePlan,
  planAuditPrompt,
  planAuditSystem,
  type ExpertLevels,
  type ExpertReport,
  type Finding,
  type Presence,
} from './experts.ts'
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
  judgeEntry,
  judgeMarks,
  planSystem,
  type Chunk,
  type ChunkVerdict,
  sentenceOf,
  stageFromLine,
  tellPrompt,
  tellSystem,
  judgeRemoval,
  judgeMissing,
  judgeScreen,
  missingOf,
  SCREEN_GUIDE,
  SCREEN_THRESHOLD,
  usesScreenModule,
  reviewPrompt,
  reviewSystem,
  flavourSystem,
  flavoursOf,
  judgeFlavour,
  judgeOpen,
  OPEN_THRESHOLD,
  withFlavour,
  type Flavour,
} from './plain.ts'
import { formatVisual, seriesIn, visualOf } from './visual.ts'
import {
  diagramAuditPrompt,
  diagramAuditSystem,
  diagramCorrectionSaid,
  diagramCorrectionsOf,
  judgeDiagram,
  movedSource,
  unusedFunctions,
  type Diagram,
  type DiagramCorrection,
  type Span,
} from './diagram.ts'
import { entryOf, launchCode, looksInert } from '../gist/entry.ts'
import { callPrompt, callSystem, validCall } from '../gist/gist.ts'
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
  echoEdits,
  lostBlocks,
  restoreLost,
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
  /**
   * Ejecuta el programa de ahora, aparte y sin nadie delante (con azar repetible y, donde haga falta, en modo
   * seguro), para ver qué hace de verdad. `null`: aquí no se puede ejecutar.
   */
  run?(): Promise<Trace | null>
  /**
   * Aquí el programa se puede **usar de verdad** con la pantalla de Prysel (suena, se pulsa, dibuja): lo que
   * se pide para usarlo se construye con ella.
   */
  screen?: boolean
  /** Cuánto está cada experto (ver `experts.ts`). Sin esto, ninguno audita. */
  experts?: ExpertLevels
  /**
   * Lo que el lienzo dibuja del programa **de ahora** (su forma, sus fases con su número, sus flechas): lo
   * que mira el auditor del diagrama. `null`: no hay lienzo, o no llegó a tiempo.
   */
  diagram?(): Promise<Diagram | null>
  /** Que el lienzo lo dibuje con otra forma (una de las que el diagrama tiene de verdad). */
  reshape?(shape: string): Promise<void>
}

export type Shown =
  /** En qué se está pensando ahora: lo que se lee mientras no hay nada nuevo que ver. */
  | { type: 'progress'; text: string }
  /**
   * La arquitectura planeada: los módulos que va a tener lo que se construye y de cuáles necesita algo cada
   * uno. El lienzo los coloca según su forma antes de que exista su código.
   */
  | {
      type: 'architecture'
      modules: { title: string; needs: string[] }[]
      /** El plan ya está entero: no llegan más partes. Es el momento de decidir su forma, una sola vez. */
      complete?: boolean
    }
  /**
   * La petición era abierta y se eligió una versión concreta: cuáles se propusieron y cuál se hace. El lienzo
   * la dice y deja cambiar a otra.
   */
  | { type: 'flavours'; options: Flavour[]; chosen: number }
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
  /** La orden tal como se entendió al final (con la versión elegida, si se eligió una). */
  asked?: string
  /** Con cuánta certeza dice el JEV que lo hecho cumple la orden (si llegó a juzgarlo). */
  fulfils?: number
  /**
   * La revisión automática, si el JEV dudó: lo que la IA echó en falta de lo pedido (y el JEV confirmó), y si
   * quedó completado. `missing` vacío: se revisó y no falta nada.
   */
  review?: {
    missing: string[]
    done: boolean
    /** Lo completado rompió el programa (que antes funcionaba) y se arregló. */
    repaired?: boolean
    /** Y si no se pudo arreglar: el fallo con el que se quedó. */
    broken?: string
  }
  /**
   * La auditoría de los expertos, si alguno está presente: lo que vio cada uno (lo aplicado, lo que propone y
   * lo que solo observa). `mended`/`broken`: lo aplicado rompió algo que funcionaba y se arregló (o no).
   */
  /** Lo que dijo el auditor del plan (antes de escribir), si miró. */
  planAudit?: ExpertReport
  /** Lo que dijo el mismo auditor del diagrama que quedó (al acabar), si miró. */
  diagramAudit?: ExpertReport
  audit?: {
    experts: ExpertReport[]
    /** Cuántas veces miraron, y por qué pararon: nada nuevo, daban vueltas, o el tope de rondas. */
    rounds?: number
    stop?: 'limpio' | 'vueltas' | 'tope'
    mended?: boolean
    broken?: string
  }
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
  const { review } = outcome
  if (review && review.missing.length > 0) {
    const what = review.missing.map((item) => `«${lowerFirst(item)}»`).join(', ')
    if (review.broken !== undefined) {
      return `Hecho en ${count}. Al revisarlo faltaba ${what}; al añadirlo dejó de funcionar (${review.broken}) y no lo he podido arreglar: revísalo.`
    }
    const mended = review.repaired ? ' (y arreglado un fallo que causó al añadirlo)' : ''
    return review.done && !outcome.doubt
      ? `Hecho, en ${count}. Al revisarlo faltaba ${what}: ya está añadido${mended}.`
      : `Hecho en ${count}, pero puede que aún falte ${what}: revísalo.`
  }
  if (outcome.doubt) {
    return `Hecho en ${count}, pero el JEV duda de que cumpla todo lo pedido: revísalo.`
  }
  if (review)
    return `Hecho, en ${count}. Lo revisé con la IA y no falta nada de lo pedido.${auditSaid(outcome)}`
  return `Hecho, en ${count}.${auditSaid(outcome)}`
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
  /** Cuántos trozos no se escribieron porque repetían algo que el programa ya tenía. */
  repeated: number
  /** Lo que dijo el auditor del plan, si miró. */
  planReport?: ExpertReport
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
  /**
   * La versión concreta que se quiere, ya elegida (quien lo usa cambió a otra de las propuestas): se hace esa,
   * sin volver a proponer.
   */
  flavour?: Flavour
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
  let fulfils: number | undefined
  if (tally.written > 0 && !stopped && tally.trouble === null) {
    try {
      const whole = await judgeCode(players.decider, command, tally.code.join('\n'))
      evidence = whole.evidence
      tally.jevMs += whole.ms
      doubt = whole.fulfils < COMPOSE_THRESHOLDS.fulfils
      fulfils = whole.fulfils
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
    asked: command,
    ...(fulfils === undefined ? {} : { fulfils }),
    ...(tally.planReport ? { planAudit: tally.planReport } : {}),
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
  const done = await tidy(host, players, await buildOnce(host, players, request))
  const audited = await audit(
    host,
    players,
    request.command,
    await review(host, players, request.command, done),
  )
  return withAuditor(await auditDiagram(host, players, request.command, audited))
}

/**
 * Lo del auditor interno (el plan, antes de escribir; el diagrama, al acabar) va el primero en el informe de
 * los expertos, como un solo experto: fue lo primero que se miró y lo último.
 */
function withAuditor(outcome: Outcome): Outcome {
  const { planAudit, diagramAudit } = outcome
  if (!planAudit && !diagramAudit) return outcome
  const report: ExpertReport = {
    id: 'plan',
    level: (planAudit ?? diagramAudit)?.level ?? 3,
    findings: [...(planAudit?.findings ?? []), ...(diagramAudit?.findings ?? [])],
  }
  return {
    ...outcome,
    audit: {
      ...(outcome.audit ?? { experts: [] }),
      experts: [report, ...(outcome.audit?.experts ?? [])],
    },
  }
}

/**
 * **El auditor del plan** (un experto interno): mira el plan entero antes de escribir nada. La IA propone
 * correcciones (quitar, unir, cambiar o añadir partes) para que sea congruente y cada parte aporte algo; el
 * JEV decide cuáles mejoran el plan sin apartarse de lo pedido. Si corrige (lo de partida), devuelve el plan
 * corregido; si solo observa, lo cuenta.
 */
async function auditPlan(
  host: Stagehand,
  players: Players,
  command: string,
  stages: readonly Stage[],
  level: Presence,
): Promise<{ report: ExpertReport; parts: Stage[] | null; ms: number }> {
  await host.show({
    type: 'progress',
    text: 'El auditor revisa el plan: que sus partes encajen y cada una aporte algo…',
  })
  let corrections: ReturnType<typeof correctionsOf> = null
  try {
    corrections = correctionsOf(
      await players.provider.generate({
        system: planAuditSystem(),
        prompt: planAuditPrompt(command, stages),
        maxTokens: 400,
      }),
      stages.length,
    )
  } catch {
    corrections = null
  }
  if (corrections === null) {
    return { report: { id: 'plan', level, findings: [], silent: true }, parts: null, ms: 0 }
  }
  const asked = corrections
  const judged = await judgePlan(players.decider, command, stages, asked).catch(() => ({
    accepted: asked.map(() => false),
    ms: 0,
  }))
  const accepted = asked.filter((_, at) => judged.accepted[at])
  const apply = level === 3 && accepted.length > 0
  const findings: Finding[] = asked.flatMap((correction, at) =>
    judged.accepted[at]
      ? [
          {
            severity: 'mejora' as const,
            what: correction.why || correctionSaid(correction, stages),
            fix: correctionSaid(correction, stages),
            verdict: 'aplicar' as const,
            ...(apply ? { applied: true } : {}),
          },
        ]
      : [],
  )
  if (apply) {
    await host.show({
      type: 'say',
      say: `El auditor ajusta el plan: ${accepted.map((correction) => lowerFirst(correctionSaid(correction, stages))).join('; ')}.`,
      aside: true,
    })
  }
  return {
    report: { id: 'plan', level, findings },
    parts: apply ? correctedPlan(stages, accepted) : null,
    ms: judged.ms,
  }
}

async function buildOnce(
  host: Stagehand,
  players: Players,
  request: BuildRequest,
): Promise<Outcome> {
  const { gen } = request
  let { command } = request
  const teach = request.teach === true
  const streaming = request.flow === 'stream'
  const tally: Tally = {
    written: 0,
    code: [],
    jevMs: 0,
    trouble: null,
    heads: [],
    chunks: 0,
    repeated: 0,
  }
  const start = await host.program()
  const anchor = start.nodes.find((n) => n.id === (request.place.after ?? request.place.into))
  await host.show({ type: 'progress', text: 'Leyendo lo que ya hay…' })
  const context = await contextFor(players.decider, {
    command,
    program: start,
    ...(anchor ? { must: [anchor.line, anchor.lineEnd ?? anchor.line] } : {}),
  })
  tally.jevMs += context.jevMs

  // ── La versión: una petición abierta («un algoritmo genético») se hace concreta antes de planear nada. ──
  // Se elige una que se vea funcionar y se dice cuál; las otras quedan a mano, para cambiar.
  if (request.flavour) command = withFlavour(command, request.flavour)
  else if (request.outline && start.nodes.length === 0 && !host.signal.aborted) {
    try {
      const open = await judgeOpen(players.decider, command)
      tally.jevMs += open.ms
      if (open.open >= OPEN_THRESHOLD) {
        await host.show({ type: 'progress', text: 'Eligiendo qué versión hacer…' })
        const options = flavoursOf(
          await players.provider.generate({
            system: flavourSystem(),
            prompt: `Lo que se pidió: ${command}`,
            maxTokens: 260,
          }),
        )
        if (options.length >= 2 && !host.signal.aborted) {
          const picked = await judgeFlavour(players.decider, command, options)
          tally.jevMs += picked.ms
          const chosen = options[picked.chosen]
          if (chosen) {
            await host.show({ type: 'flavours', options, chosen: picked.chosen })
            command = withFlavour(command, chosen)
          }
        }
      }
    } catch {
      // Sin versiones se hace lo que se dijo, como siempre: elegir es una ayuda, no un requisito.
    }
  }

  // ── ¿Algo que se usa de verdad (suena, se toca, se juega)? Entonces se hace con la pantalla, donde la hay. ──
  const screen = !host.signal.aborted && (await screenFor(host, players, command, start))

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
        system: planSystem(teach, screen),
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
    let skeleton = new BuildPlan(request.place)
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
      // El plan, tal como va: el lienzo ya puede decir qué necesita cada parte de las demás.
      await host.show({
        type: 'architecture',
        modules: stages.map((one) => ({ title: one.title, needs: one.needs ?? [] })),
      })
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
    // ── El auditor del plan: antes de escribir nada, que las partes encajen y cada una aporte algo. ──
    const auditing = host.experts?.plan ?? 0
    if (auditing > 0 && stages.length >= 2 && !host.signal.aborted) {
      const audited = await auditPlan(host, players, command, stages, auditing)
      tally.jevMs += audited.ms
      tally.planReport = audited.report
      if (audited.parts && !host.signal.aborted) {
        // El plan corregido se dibuja de nuevo: lo dibujado del plan se quita (aún no hay código) y se pone
        // el nuevo, parte a parte, como el primero.
        const drawn = await host.program()
        await host.write({ edits: [{ start: 0, end: drawn.source.length, text: start.source }] })
        skeleton = new BuildPlan(request.place)
        stages.length = 0
        for (const part of audited.parts) if (!(await draw(part))) break
      }
    }
    // El plan está entero: con todas sus partes a la vista se decide qué forma tiene, y ya no cambia.
    if (stages.length >= 2 && !host.signal.aborted) {
      await host.show({
        type: 'architecture',
        modules: stages.map((one) => ({ title: one.title, needs: one.needs ?? [] })),
        complete: true,
      })
    }
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
        system: codeSystem(teach, screen),
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
    // Las clases y funciones que el programa ya tenía antes de empezar.
    const existing = new Set(
      [...start.source.matchAll(/^[ \t]*(?:async\s+)?(?:def|class)\s+(\w+)/gm)].map(
        (match) => match[1] ?? '',
      ),
    )
    const preparing = (async () => {
      const seen: string[] = []
      let stage = 0
      for (;;) {
        const chunk = await next(source, host)
        if (chunk === null || prep.stop) break
        // Lo que no es Python (una frase suelta que el modelo puso alrededor) no es parte del programa.
        if (!host.parses(chunk.code)) continue
        // Tampoco lo que ya existe: si el modelo vuelve a escribir una clase o una función que el programa
        // ya tiene, no se pone otra vez (quedaría duplicada, o una dentro de otra).
        const defined = /^(?:async\s+)?(?:def|class)\s+(\w+)/.exec(
          chunk.code.split('\n').find((row) => row.trim() !== '' && !row.startsWith('#')) ?? '',
        )?.[1]
        if (defined !== undefined && existing.has(defined)) {
          tally.repeated++
          await note(`«${defined}» ya está en el programa: no la repito.`)
          continue
        }
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
    if (tally.written === 0 && tally.repeated > 0 && tally.trouble === null) {
      tally.trouble = 'Eso ya está en el programa: no lo he vuelto a escribir.'
    }
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
  // El comentario con el que la IA abre el código de una etapa, cuando solo repite su rótulo, sobra.
  if (tally.written > 0) {
    const echoes = echoEdits((await host.program()).source)
    if (echoes.length > 0) await host.write({ edits: echoes })
  }
  // Un programa entero que solo define funciones no hace nada: se arranca con un ejemplo, para verlo.
  if (planned && start.nodes.length === 0 && tally.trouble === null && !host.signal.aborted) {
    await launchIfInert(host, players, tally)
  }
  return conclude(host, players, command, tally)
}

/**
 * La red de seguridad de un programa entero: si al acabar define funciones pero nadie las llama, se le añade
 * una etapa final que lo arranca con un ejemplo y enseña lo que da. La IA solo propone la llamada (una línea,
 * con valores sueltos: se comprueba); cuál es la función principal sale del programa o lo dice el JEV.
 */
async function launchIfInert(host: Stagehand, players: Players, tally: Tally): Promise<void> {
  const program = await host.program()
  if (!looksInert(program)) return
  const found = entryOf(program)
  let entry = found.entry
  if (!entry && found.tied.length > 0) {
    const chosen = await judgeEntry(
      players.decider,
      found.tied.map((fact) => fact.name),
    ).catch(() => null)
    entry = found.tied[chosen ?? found.tied.length - 1] ?? null
  }
  if (!entry) return
  await host.show({ type: 'progress', text: `Arrancando ${entry.name} con un ejemplo…` })
  let call = entry.takes.length === 0 ? `${entry.name}()` : null
  if (call === null) {
    const answer = await players.provider
      .generate({ system: callSystem(true), prompt: callPrompt(program, entry), maxTokens: 200 })
      .catch(() => '')
    call = validCall(answer, entry)
  }
  if (call === null || host.signal.aborted) return
  const source = program.source
  const body = source.replace(/\s+$/, '')
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const launch = launchCode(call, entry.returns)
  const failed = await host.write({
    edits: [
      {
        start: body.length,
        end: source.length,
        text: `${eol}${eol}${launch.split('\n').join(eol)}${eol}`,
      },
    ],
  })
  if (failed !== null) return
  tally.written++
  tally.code.push(launch)
  await host.show({
    type: 'step',
    index: tally.written,
    say: 'Lo arranco con un ejemplo, para verlo funcionar.',
    line: body.split('\n').length + 2,
    effect: 'born',
    wide: true,
  })
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
      system: withScreen(rewriteSystem(), await screenFor(host, players, request.command, start)),
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
  let body = unfenced(answer)
  if (body === '') return failed('La IA no devolvió el programa.')
  // Lo que estaba y ya no está: si la orden no pedía quitarlo (lo dice el JEV), vuelve a su sitio. Una IA
  // que arregla una función a veces devuelve solo las funciones y se deja fuera los datos y lo demás.
  const lost = lostBlocks(before, body)
  if (lost.length > 0) {
    await host.show({ type: 'progress', text: 'Al cambio le faltan trozos · lo mira el JEV…' })
    const wanted = await judgeRemoval(
      players.decider,
      command,
      lost.map((block) => block.head),
    ).catch(() => 0)
    if (wanted < 0.5) body = restoreLost(before, body).replace(/\s+$/, '')
  }
  const after = `${body}\n`.replace(/\n/g, eol)
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
    asked: command,
    fulfils: verdict.fulfils,
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
  const done = await tidy(host, players, await modifyOnce(host, players, request))
  const audited = await audit(
    host,
    players,
    request.command,
    await review(host, players, request.command, done),
  )
  return withAuditor(await auditDiagram(host, players, request.command, audited))
}

// ───────────────────────── los expertos ─────────────────────────

/** Cuántas veces, como mucho, se vuelve a mirar lo arreglado por los expertos que corrigen. */
export const MAX_ROUNDS = 3
/** Lo que se le recuerda a la IA al reescribir el programa entero: los rótulos de las fases son el diagrama. */
const KEEP_STAGES =
  'Conserva cada comentario que abre una fase («# Título: qué hace»), con una línea en blanco delante y encima de su código: son las fases del diagrama.'

/** Cuántos arreglos de los expertos se aplican, como mucho, en una ronda. */
export const MAX_FIXES = 5

/** El programa, sin lo que no cambia nada (espacios al final, líneas en blanco de más): para notar si vuelve. */
const shapeOf = (source: string) =>
  source
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line !== '')
    .join('\n')

/**
 * **La auditoría**: al acabar, los expertos presentes miran lo que quedó (el programa, lo que hace al
 * ejecutarlo y su pantalla), cada uno en lo suyo y a la vez. El JEV decide de cada hallazgo si se arregla, se
 * sugiere o se descarta. Lo de los expertos que corrigen (lo de partida) se aplica —todo lo que el JEV no
 * descarta—, en un solo cambio que se ve y se deshace; si rompe lo que funcionaba, se arregla una vez. Y se
 * vuelve a mirar, hasta `MAX_ROUNDS` rondas, mientras salga algo nuevo. Se para antes si se nota que se dan
 * vueltas: el JEV ve que un arreglo deshace o vuelve a pedir otro de antes, o el programa vuelve a una
 * versión que ya tuvo.
 */
async function audit(
  host: Stagehand,
  players: Players,
  command: string,
  outcome: Outcome,
): Promise<Outcome> {
  const levels = host.experts
  if (!levels || outcome.stopped || outcome.trouble !== null || outcome.written === 0)
    return outcome
  const present = EXPERT_IDS.filter((id) => levels[id] > 0)
  if (present.length === 0 || host.signal.aborted) return outcome
  const asked = outcome.asked ?? command
  const merged = new Map<string, ExpertReport>()
  const applied: string[] = []
  const seen = new Set<string>([shapeOf((await host.program()).source)])
  let jevMs = outcome.jevMs
  let written = outcome.written
  let rounds = 0
  let stop: 'limpio' | 'vueltas' | 'tope' = 'limpio'
  let repairs: { mended?: boolean; broken?: string } = {}
  for (let round = 1; round <= MAX_ROUNDS && !host.signal.aborted; round++) {
    // En la primera ronda miran todos; después, solo los que corrigen (los demás ya dijeron lo suyo).
    const looking = round === 1 ? present : present.filter((id) => levels[id] === 3)
    if (looking.length === 0) break
    rounds = round
    await host.show({
      type: 'progress',
      text:
        round === 1
          ? `Los expertos lo revisan: ${looking.map((id) => EXPERTS[id].name).join(', ')}…`
          : `Los expertos vuelven a mirar lo arreglado (ronda ${round})…`,
    })
    const program = await host.program()
    const before = await ranOf(host)
    const consulted = await Promise.all(
      looking.map((id) =>
        consult(players.provider, players.decider, id, levels[id], {
          command: asked,
          source: program.source.slice(0, REVIEW_BUDGET),
          ...(before ? { ran: before.said } : {}),
          ...(usesScreenModule(program.source) ? { guide: SCREEN_GUIDE } : {}),
          applied,
        }),
      ),
    )
    jevMs += consulted.reduce((sum, one) => sum + one.ms, 0)
    for (const { report } of consulted) {
      const known = merged.get(report.id)
      merged.set(
        report.id,
        known ? { ...known, findings: [...known.findings, ...report.findings] } : report,
      )
    }
    const fresh = consulted.flatMap(({ report }) => (report.level === 3 ? report.findings : []))
    // Lo que deshace o vuelve a pedir un arreglo de antes no se aplica: se están dando vueltas.
    const looping = fresh.some((finding) => finding.verdict === 'vuelta')
    // Unos pocos cada vez (lo grave y lo que el JEV manda arreglar, primero): muchos cambios a la vez rompen
    // con facilidad. Lo que no cabe queda propuesto, y si sigue haciendo falta vuelve en la ronda siguiente.
    const rank = (finding: Finding) =>
      (finding.severity === 'grave' ? 0 : 2) + (finding.verdict === 'aplicar' ? 0 : 1)
    const toApply = fresh
      .filter((finding) => finding.verdict === 'aplicar' || finding.verdict === 'sugerir')
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, MAX_FIXES)
    if (toApply.length === 0) {
      stop = looping ? 'vueltas' : 'limpio'
      break
    }
    await host.show({
      type: 'say',
      say: `Los expertos arreglan: ${toApply.map((finding) => lowerFirst(finding.fix)).join('; ')}.`,
      aside: true,
    })
    const fixed = await modifyOnce(host, players, {
      command: `Mejora el programa como dicen los expertos, sin cambiar lo que hace ni lo que se pidió («${asked}»): ${toApply.map((finding) => finding.fix).join('; ')}. ${KEEP_STAGES}`,
      whole: true,
    })
    jevMs += fixed.jevMs
    written += fixed.written
    const done = !fixed.stopped && fixed.trouble === null && fixed.written > 0
    for (const finding of toApply) finding.applied = done
    if (!done) break
    applied.push(...toApply.map((finding) => finding.fix))
    const mended = await mend(host, players, asked, before)
    written += mended.written
    jevMs += mended.jevMs
    if (mended.repaired) repairs = { mended: true }
    if (mended.broken !== undefined) {
      // Se aplicó sin preguntar: si deja un fallo que no se arregla, se deshace (quedan como recomendación).
      await restore(host, program.source)
      for (const finding of toApply) finding.applied = false
      applied.splice(applied.length - toApply.length, toApply.length)
      repairs = { broken: mended.broken }
      break
    }
    // El programa vuelve a una versión que ya tuvo: lo que se arregla en una ronda se deshace en otra.
    const now = shapeOf((await host.program()).source)
    if (seen.has(now) || looping) {
      stop = 'vueltas'
      break
    }
    seen.add(now)
    if (round === MAX_ROUNDS) stop = 'tope'
  }
  return {
    ...outcome,
    written,
    jevMs,
    audit: { experts: [...merged.values()], rounds, stop, ...repairs },
  }
}

// ───────────────────────── el auditor del diagrama ─────────────────────────

/** Cuántas veces, como mucho, mira el auditor el diagrama (la segunda, lo ya corregido). */
export const DIAGRAM_ROUNDS = 2

/** Lo que distingue un diagrama de otro (por posiciones, no por líneas): si vuelve uno ya visto, se dan vueltas. */
function diagramPrint(diagram: Diagram): string {
  const at = new Map(diagram.modules.map((module, index) => [module.id, index]))
  return JSON.stringify([
    diagram.shape,
    diagram.modules.map((module) => `${module.title}:${module.subtitle ?? ''}`),
    diagram.links.map((link) => `${at.get(link.from)}>${at.get(link.to)}:${link.kind}`).sort(),
  ])
}

/**
 * **El auditor del diagrama**: al acabar (después de los expertos), el auditor interno mira el diagrama tal como
 * lo dibuja el lienzo —su forma, los nombres de las fases, sus números y sus flechas— y propone cómo hacer que
 * ayude más a entender el programa. El JEV decide cada corrección; si el auditor corrige (lo de partida), se
 * aplica y se vuelve a mirar una vez. Se para si nada cambia, si el JEV nota que se deshace lo de antes o si
 * vuelve un diagrama que ya se vio.
 */
export async function auditDiagram(
  host: Stagehand,
  players: Players,
  command: string,
  outcome: Outcome,
): Promise<Outcome> {
  const level = host.experts?.plan ?? 0
  if (
    level === 0 ||
    !host.diagram ||
    outcome.stopped ||
    outcome.trouble !== null ||
    outcome.written === 0 ||
    host.signal.aborted
  )
    return outcome
  const asked = outcome.asked ?? command
  const findings: Finding[] = []
  const applied: string[] = []
  const seen = new Set<string>()
  let { jevMs, written } = outcome
  for (let round = 1; round <= DIAGRAM_ROUNDS && !host.signal.aborted; round++) {
    const diagram = await host.diagram().catch(() => null)
    if (!diagram || diagram.modules.length < 2) break
    const print = diagramPrint(diagram)
    if (seen.has(print)) break
    seen.add(print)
    await host.show({
      type: 'progress',
      text:
        round === 1
          ? 'El auditor mira el diagrama: su forma, los nombres de las fases, sus números y sus flechas…'
          : 'El auditor vuelve a mirar el diagrama, ya corregido…',
    })
    const program = await host.program()
    let corrections: DiagramCorrection[] | null = null
    try {
      corrections = diagramCorrectionsOf(
        await players.provider.generate({
          system: diagramAuditSystem(),
          prompt: diagramAuditPrompt(
            asked,
            diagram,
            program.source.slice(0, REVIEW_BUDGET),
            applied,
            contentsOf(program),
          ),
          maxTokens: 500,
        }),
        diagram,
      )
    } catch {
      corrections = null
    }
    if (!corrections || corrections.length === 0) break
    const asking = corrections
    const judged = await judgeDiagram(
      players.decider,
      asked,
      diagram,
      asking,
      applied,
      contentsOf(program),
    ).catch(() => ({ verdicts: asking.map(() => 'descartar' as const), ms: 0 }))
    jevMs += judged.ms
    const kept = asking.flatMap((correction, at) => {
      const verdict = judged.verdicts[at] ?? 'descartar'
      if (verdict === 'descartar') return []
      const fix = diagramCorrectionSaid(correction, diagram)
      const finding: Finding = { severity: 'mejora', what: correction.why || fix, fix, verdict }
      return [{ correction, finding }]
    })
    findings.push(...kept.map((one) => one.finding))
    const accepted = kept
      .filter((one) => one.finding.verdict === 'aplicar')
      .map((one) => one.correction)
    if (level < 3 || accepted.length === 0) break
    await host.show({
      type: 'say',
      say: `El auditor ajusta el diagrama: ${accepted.map((correction) => lowerFirst(diagramCorrectionSaid(correction, diagram))).join('; ')}.`,
      aside: true,
    })
    const done = await applyDiagram(host, players, asked, diagram, program, accepted)
    written += done.written
    jevMs += done.jevMs
    for (const { correction, finding } of kept) {
      if (done.applied.includes(correction)) finding.applied = true
    }
    if (done.applied.length === 0) break
    applied.push(...done.applied.map((correction) => diagramCorrectionSaid(correction, diagram)))
    // Lo que deshacía lo de antes no se aplicó, pero dice que ya se están dando vueltas: no se mira más.
    if (kept.some((one) => one.finding.verdict === 'vuelta')) break
  }
  if (seen.size === 0) return outcome
  return { ...outcome, written, jevMs, diagramAudit: { id: 'plan', level, findings } }
}

/** Lo que tiene cada etapa en su primer nivel: la primera línea de cada sentencia, por el id de la etapa. */
function contentsOf(program: Program): Map<string, string[]> {
  const rows = program.source.split('\n')
  const lines = new Map(program.nodes.map((node) => [node.id, node.line]))
  return new Map(
    (program.sections ?? []).map((section) => [
      section.id,
      section.members.flatMap((id) => {
        const row = rows[(lines.get(id) ?? 0) - 1]?.trim()
        return row ? [row.length > 70 ? `${row.slice(0, 69)}…` : row] : []
      }),
    ]),
  )
}

/** Dónde empieza una línea (base 1) en el texto. */
function offsetOfLine(source: string, line: number): number {
  let offset = 0
  for (let row = 1; row < line; row++) {
    const next = source.indexOf('\n', offset)
    if (next === -1) return source.length
    offset = next + 1
  }
  return offset
}

const lineStart = (source: string, offset: number) => source.lastIndexOf('\n', offset - 1) + 1
const lineAfter = (source: string, offset: number) => {
  const end = source.indexOf('\n', offset)
  return end === -1 ? source.length : end + 1
}
const plainTitle = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

/**
 * Aplica lo que el JEV aceptó del auditor del diagrama. Mover una fase cambia de sitio su tramo del archivo,
 * solo si no puede cambiar lo que hace (o ella o las que salta solo definen funciones) y, si se puede
 * ejecutar, comprobando que sigue sin fallar. Renombrar y unir (dos seguidas) reescriben sus rótulos. La forma
 * se le pide al lienzo. Y una conexión que el código no deja ver se le pide a la IA, como un cambio más.
 */
async function applyDiagram(
  host: Stagehand,
  players: Players,
  asked: string,
  diagram: Diagram,
  program: Program,
  accepted: readonly DiagramCorrection[],
): Promise<{ applied: DiagramCorrection[]; written: number; jevMs: number }> {
  const done: DiagramCorrection[] = []
  let written = 0
  let jevMs = 0
  const before = await ranOf(host)
  const topsOf = (from: Program) =>
    (from.sections ?? []).filter((one) => one.owner === undefined).sort((a, b) => a.line - b.line)
  /** El orden de ahora de las fases del diagrama (sus números de antes). */
  let order = diagram.modules.map((_, index) => index + 1)
  let current = program

  // ── Mover: solo una, y solo si sus números son los de las etapas del programa. ──
  const move = accepted.find(
    (one): one is Extract<DiagramCorrection, { kind: 'mover' }> => one.kind === 'mover',
  )
  const tops = topsOf(current)
  const same =
    tops.length === diagram.modules.length &&
    tops.every((section, index) => section.id === diagram.modules[index]?.id)
  if (move && same && !host.signal.aborted) {
    const source = current.source
    const blocks: Span[] = tops.map((section, index) => {
      const next = tops[index + 1]
      return {
        start: lineStart(source, section.heading.start),
        end: next ? lineStart(source, next.heading.start) : source.length,
      }
    })
    const kinds = new Map(current.nodes.map((node) => [node.id, node.kind]))
    const defines = (n: number) =>
      (tops[n - 1]?.members ?? []).every((id) => {
        const kind = kinds.get(id) ?? ''
        return kind.startsWith('abstraction.') || kind === 'external.import'
      })
    const jumped =
      move.after < move.at ? order.slice(move.after, move.at - 1) : order.slice(move.at, move.after)
    const next = movedSource(source, blocks, move.at, move.after)
    if (
      next !== null &&
      // Sin poder ejecutarlo, solo lo que no puede cambiar nada: ella o las que salta solo definen.
      (before !== null || defines(move.at) || jumped.every(defines)) &&
      host.parses(next) &&
      (await host.write({ edits: [{ start: 0, end: source.length, text: next }] })) === null
    ) {
      if (!(await sameDoing(host, before, source))) {
        // Al moverla hace otra cosa (o falla): se deja como estaba.
        await restore(host, source)
      } else {
        const moved = order.filter((n) => n !== move.at)
        moved.splice(move.after === 0 ? 0 : moved.indexOf(move.after) + 1, 0, move.at)
        order = moved
        done.push(move)
        written++
        current = await host.program()
      }
    }
  }

  // ── Renombrar y unir: se reescriben los rótulos, todo en un solo cambio. ──
  const now = topsOf(current)
  const sectionOf = (n: number) => {
    const section = now[order.indexOf(n)]
    const module = diagram.modules[n - 1]
    // Por si el programa no es el que se dibujó: la fase tiene que seguir llamándose igual.
    return section && module && plainTitle(section.title) === plainTitle(module.title)
      ? section
      : undefined
  }
  const source = current.source
  const edits: { start: number; end: number; text: string }[] = []
  const touched = new Set<string>()
  const renamed: DiagramCorrection[] = []
  const rowsOf = source.split('\n')
  const lineOf = new Map(current.nodes.map((node) => [node.id, node]))
  for (const correction of accepted) {
    if (correction.kind === 'separar') {
      const section = sectionOf(correction.at)
      if (!section || touched.has(section.id)) continue
      // La sentencia de su primer nivel que empieza por lo dicho (no la primera: eso no parte nada).
      const wanted = correction.from.replace(/\s+/g, ' ').slice(0, 40)
      const member = section.members
        .slice(1)
        .map((id) => lineOf.get(id))
        .find(
          (node) =>
            node && (rowsOf[node.line - 1] ?? '').trim().replace(/\s+/g, ' ').startsWith(wanted),
        )
      if (!member) continue
      const at = lineStart(source, offsetOfLine(source, member.line))
      const blank = (rowsOf[member.line - 2] ?? '').trim() === ''
      edits.push({
        start: at,
        end: at,
        text: `${blank ? '' : '\n'}# ${correction.part.title}: ${correction.part.goal}\n`,
      })
      touched.add(section.id)
      renamed.push(correction)
      continue
    }
    if (correction.kind !== 'renombrar' && correction.kind !== 'unir') continue
    const section = sectionOf(correction.at)
    if (!section || touched.has(section.id)) continue
    const other = correction.kind === 'unir' ? sectionOf(correction.with) : undefined
    if (correction.kind === 'unir') {
      if (!other || touched.has(other.id)) continue
      // La que se une va justo detrás: su rótulo se quita y sus sentencias pasan a la de delante.
      if (order.indexOf(correction.with) !== order.indexOf(correction.at) + 1) continue
      edits.push({
        start: lineStart(source, other.heading.start),
        end: lineAfter(source, other.heading.end),
        text: '',
      })
      touched.add(other.id)
    }
    edits.push({
      start: section.textAt.start,
      end: section.textAt.end,
      text: `${correction.part.title}: ${correction.part.goal}`,
    })
    touched.add(section.id)
    renamed.push(correction)
  }
  if (edits.length > 0 && !host.signal.aborted) {
    edits.sort((a, b) => a.start - b.start)
    if ((await host.write({ edits })) === null) {
      done.push(...renamed)
      written++
    }
  }

  // ── La forma: la dibuja el lienzo. ──
  const shape = accepted.find((one) => one.kind === 'forma')
  if (shape?.kind === 'forma' && host.reshape && !host.signal.aborted) {
    await host.reshape(shape.shape)
    done.push(shape)
  }

  // ── Las conexiones que el código no deja ver: un cambio más, que se ve y se deshace. ──
  const links = accepted.filter((one) => one.kind === 'conectar')
  if (links.length > 0 && !host.signal.aborted) {
    const prior = (await host.program()).source
    const fixed = await modifyOnce(host, players, {
      command: `Para que cada fase (cada comentario de etapa) tenga lo que dice su nombre y se vea cómo pasan los datos de una a otra, sin cambiar lo que hace el programa ni lo que se pidió («${asked}»): ${links.map((one) => (one.kind === 'conectar' ? one.fix : '')).join('; ')}. ${KEEP_STAGES}`,
      whole: true,
    })
    jevMs += fixed.jevMs
    written += fixed.written
    if (!fixed.stopped && fixed.trouble === null && fixed.written > 0) {
      // Es para que se entienda, no para que haga otra cosa: si cambia lo que hace, falla o deja una
      // función que nadie usa, se deshace.
      if (await sameDoing(host, before, prior)) done.push(...links)
      else await restore(host, prior)
    }
  }
  return { applied: done, written, jevMs }
}

/** Vuelve a dejar el programa como estaba (`text`). */
async function restore(host: Stagehand, text: string): Promise<void> {
  const now = await host.program()
  if (now.source !== text) await host.write({ edits: [{ start: 0, end: now.source.length, text }] })
}

/**
 * ¿El programa de ahora hace lo mismo que el de antes (`prior`, que al ejecutarlo dijo `before`)? Lo mismo al
 * ejecutarlo (con el azar repetible, la salida es la misma), sin fallos, y sin funciones nuevas que nadie usa.
 */
async function sameDoing(
  host: Stagehand,
  before: { broken: string | null; said: string } | null,
  prior: string,
): Promise<boolean> {
  const now = await host.program()
  const unused = new Set(unusedFunctions(prior))
  if (unusedFunctions(now.source).some((name) => !unused.has(name))) return false
  if (before === null) return true
  const after = await ranOf(host)
  return after !== null && after.broken === before.broken && after.said === before.said
}

/** Lo que se dice de la auditoría al final: lo arreglado, en cuántas rondas, y lo que queda por ver. */
function auditSaid(outcome: Outcome): string {
  const audit = outcome.audit
  if (!audit) return ''
  const findings = audit.experts.flatMap((report) => report.findings)
  const applied = findings.filter((finding) => finding.applied).length
  const open = findings.filter(
    (finding) =>
      !finding.applied && finding.verdict !== 'vuelta' && finding.verdict !== 'descartar',
  ).length
  if (findings.length === 0) return ' Los expertos no ven nada que mejorar.'
  const parts = [
    ...(applied > 0 ? [`arreglaron ${applied} ${applied === 1 ? 'cosa' : 'cosas'}`] : []),
    ...(open > 0 ? [`tienen ${open} ${open === 1 ? 'recomendación' : 'recomendaciones'}`] : []),
  ]
  const rounds = (audit.rounds ?? 1) > 1 ? ` en ${audit.rounds} rondas` : ''
  const why =
    audit.stop === 'vueltas'
      ? ' y pararon al notar que daban vueltas'
      : audit.stop === 'tope'
        ? ` y pararon tras ${audit.rounds} rondas`
        : ''
  const broken = audit.broken
    ? ` (lo que aplicaron dejaba un fallo y se deshizo: ${audit.broken})`
    : ''
  return ` Los expertos ${parts.join(' y ') || 'miraron'}${rounds}${why}${broken}: míralo en «Expertos».`
}

/**
 * Si un cambio hecho sin que nadie lo pidiera (completar lo que faltaba, lo de los expertos) dejó de
 * funcionar donde antes funcionaba, se arregla una vez, con el fallo de verdad.
 */
async function mend(
  host: Stagehand,
  players: Players,
  asked: string,
  before: { broken: string | null } | null,
): Promise<{ written: number; jevMs: number; repaired?: boolean; broken?: string }> {
  if (before === null || before.broken !== null || host.signal.aborted)
    return { written: 0, jevMs: 0 }
  const after = await ranOf(host)
  if (!after?.broken) return { written: 0, jevMs: 0 }
  await host.show({
    type: 'progress',
    text: `Al cambiarlo dejó de funcionar (${after.broken}): lo arreglo…`,
  })
  const repair = await modifyOnce(host, players, {
    command: `Al ejecutar el programa falla: ${after.broken}. Arréglalo sin quitar nada de lo que hace (lo que se pidió: «${asked}»).`,
    whole: true,
  })
  const still = await ranOf(host)
  return {
    written: repair.written,
    jevMs: repair.jevMs,
    ...(still?.broken ? { broken: still.broken } : { repaired: true }),
  }
}

// ───────────────────────── ordenar: nada fuera de una etapa ─────────────────────────

/**
 * Lo de primer nivel que quedó **fuera de toda etapa** en un programa que sí las tiene: lo que va antes de su
 * primer rótulo (lo de después es siempre de alguna). En el diagrama eso no es ningún módulo: se queda suelto
 * debajo, y la idea del programa no lo cuenta.
 */
export function orphansOf(program: Program): ProgramNode[] {
  const top = (program.sections ?? []).filter((section) => section.owner === undefined)
  if (top.length === 0) return []
  const first = Math.min(...top.map((section) => section.line))
  // (Los `import` del principio no cuentan: van arriba del todo, como es costumbre, sin etapa propia.)
  return program.nodes
    .filter((node) => node.range && node.range.owner === undefined && node.line < first)
    .filter((node) => node.kind !== 'external.import')
    .sort((a, b) => a.line - b.line)
}

/** Cómo se ordena, sin IA: los datos (lo que se importa y se guarda) por un lado y las funciones por otro. */
export function plainStagesFor(orphans: readonly ProgramNode[]): { at: number; title: string }[] {
  const isPiece = (node: ProgramNode) =>
    node.kind === 'abstraction.collapsed' || node.kind === 'abstraction.class'
  const firstPiece = orphans.findIndex(isPiece)
  if (firstPiece <= 0) {
    return [
      {
        at: 0,
        title:
          firstPiece === 0
            ? 'Las piezas: las funciones que usa el programa'
            : 'Preparar los datos: lo que usa el programa',
      },
    ]
  }
  return [
    { at: 0, title: 'Preparar los datos: lo que usa el programa' },
    { at: firstPiece, title: 'Las piezas: las funciones que usa el programa' },
  ]
}

/** Lee la propuesta de la IA: líneas «N | Título: qué hace», la primera en 1, en orden, como mucho tres. */
export function stagesFrom(text: string, count: number): { at: number; title: string }[] | null {
  const stages: { at: number; title: string }[] = []
  for (const line of text.split('\n')) {
    const found = /^\s*(\d+)\s*[|:)-]\s*(.+?)\s*$/.exec(line)
    if (!found) continue
    const at = Number(found[1]) - 1
    const title = (found[2] ?? '').replace(/^#+\s*/, '').replace(/^[«"]|[»"]$/g, '')
    if (!/^[^:]{2,40}:\s+\S.{2,80}$/.test(title)) return null
    if (at < 0 || at >= count || (stages.length > 0 && at <= (stages.at(-1)?.at ?? -1))) return null
    stages.push({ at, title })
  }
  return stages.length >= 1 && stages.length <= 3 && stages[0]?.at === 0 ? stages : null
}

/**
 * **Ordenar**: si al acabar una orden queda código de primer nivel fuera de toda etapa, se le ponen sus
 * rótulos (la IA los propone, agrupando lo que va junto; si no contesta, datos por un lado y funciones por
 * otro). Son comentarios en el código, como los demás: se ven, se renombran y se pueden deshacer.
 */
async function tidy(host: Stagehand, players: Players, outcome: Outcome): Promise<Outcome> {
  if (outcome.stopped || outcome.written === 0 || host.signal.aborted) return outcome
  const program = await host.program()
  const orphans = orphansOf(program)
  if (orphans.length === 0) return outcome
  await host.show({ type: 'progress', text: 'Pongo en su etapa lo que quedó suelto…' })
  const listed = orphans
    .map((node, at) => `${at + 1}. ${(node.text ?? node.label).split('\n')[0]?.slice(0, 90) ?? ''}`)
    .join('\n')
  let stages: { at: number; title: string }[] | null = null
  try {
    stages = stagesFrom(
      await players.provider.generate({
        system: [
          'Este es el principio de un programa en Python, que quedó sin rótulo de etapa: sus sentencias de primer nivel, numeradas (la primera línea de cada una).',
          'Agrúpalas en 1 a 3 etapas SEGUIDAS, según lo que hacen juntas (los datos que usa, las piezas que dibujan algo, las que calculan…).',
          'Responde solo con una línea por etapa: «N | Título: qué hace», donde N es el número de la sentencia con la que empieza (la primera, 1), el título tiene de dos a cuatro palabras y lo que hace, menos de diez. Sin nada más.',
        ].join('\n'),
        prompt: listed,
        maxTokens: 200,
      }),
      orphans.length,
    )
  } catch {
    stages = null
  }
  stages ??= plainStagesFor(orphans)
  const source = program.source
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const edits = stages.flatMap(({ at, title }) => {
    const node = orphans[at]
    const start = node?.range ? (node.range.lead ?? node.range.start) : undefined
    if (start === undefined) return []
    // Una línea en blanco delante (salvo al principio del archivo), como entre las demás etapas.
    const before = source.slice(0, start)
    const gap = start === 0 || /\n\s*\n$/.test(before) ? '' : eol
    return [{ start, end: start, text: `${gap}# ${title}${eol}` }]
  })
  if (edits.length === 0) return outcome
  // (Si no se pudiera escribir, lo hecho sigue igual de hecho: solo queda sin ordenar.)
  await host.write({ edits })
  return outcome
}

/**
 * **La revisión**: si al acabar el JEV duda de que se haya hecho todo lo pedido, no se deja en «revísalo».
 * La IA lee el programa entero contra la orden y dice qué falta; el JEV decide qué de eso pedía de verdad la
 * orden (para no añadir lo que nadie pidió); y lo que falte se completa una vez, como un cambio más (se ve
 * hacerse, y se puede deshacer). Si la revisión no ve nada que falte, eso es lo que se dice.
 */
async function review(
  host: Stagehand,
  players: Players,
  command: string,
  outcome: Outcome,
): Promise<Outcome> {
  // Se revisa si el JEV duda, y también si no está claramente seguro: visto de verdad, dio por cumplida una
  // orden de varias partes a la que le faltaba una entera.
  const unsure = outcome.doubt || (outcome.fulfils !== undefined && outcome.fulfils < REVIEW_BELOW)
  if (!unsure || outcome.stopped || outcome.trouble !== null || outcome.written === 0) {
    return outcome
  }
  if (host.signal.aborted) return outcome
  const asked = outcome.asked ?? command
  await host.show({
    type: 'progress',
    text: outcome.doubt
      ? 'El JEV duda de que esté todo: lo reviso con la IA…'
      : 'Reviso con la IA que esté todo lo pedido…',
  })
  const program = await host.program()
  // Lo que hace de verdad al ejecutarlo: quien revisa lo ve (lo que se pidió ver tiene que salir ahí), y sirve
  // para saber si lo que se complete rompe algo que funcionaba.
  const before = await ranOf(host)
  let missing: string[] | null
  try {
    missing = missingOf(
      await players.provider.generate({
        // (Con la pantalla, quien revisa sabe cómo funciona: no echa en falta lo que ya hace.)
        system: usesScreenModule(program.source)
          ? `${reviewSystem()}

El programa usa la pantalla de Prysel, que funciona así:
${SCREEN_GUIDE}`
          : reviewSystem(),
        prompt: reviewPrompt(asked, program.source.slice(0, REVIEW_BUDGET), before?.said),
        maxTokens: 300,
      }),
    )
  } catch {
    missing = null
  }
  // Sin respuesta que se entienda, se queda la duda, como estaba.
  if (missing === null || host.signal.aborted) return outcome
  const judged = await judgeMissing(players.decider, asked, missing).catch(() => null)
  if (judged === null) return outcome
  const jevMs = outcome.jevMs + judged.ms
  if (judged.asked.length === 0) {
    // La IA no ve nada que falte (o lo que ve no lo pedía la orden): la duda queda resuelta.
    return { ...outcome, doubt: false, jevMs, review: { missing: [], done: true } }
  }
  await host.show({
    type: 'say',
    say: `Al revisarlo falta: ${judged.asked.map(lowerFirst).join('; ')}. Lo completo.`,
    aside: true,
  })
  if (host.signal.aborted) return { ...outcome, jevMs }
  const fixed = await modifyOnce(host, players, {
    command: `Completa lo que falta de lo que se pidió («${asked}»): ${judged.asked.join('; ')}.`,
    whole: true,
  })
  const done = !fixed.stopped && fixed.trouble === null && fixed.written > 0
  let written = outcome.written + fixed.written
  let jevTotal = jevMs + fixed.jevMs
  let repairs: { repaired?: boolean; broken?: string } = {}
  // Si al completarlo dejó de funcionar lo que funcionaba, se arregla una vez, sin esperar a nadie.
  if (done) {
    const mended = await mend(host, players, asked, before)
    written += mended.written
    jevTotal += mended.jevMs
    if (mended.repaired) repairs = { repaired: true }
    else if (mended.broken !== undefined) repairs = { broken: mended.broken }
  }
  return {
    ...fixed,
    written,
    asked,
    // (El programa ya no es el de antes: lo que dice el JEV es de cómo quedó.)
    evidence: fixed.evidence.length > 0 ? fixed.evidence : outcome.evidence,
    jevMs: jevTotal,
    review: { missing: judged.asked, done, ...repairs },
    ...(outcome.enter === undefined ? {} : { enter: outcome.enter }),
    // Lo que dijo el auditor del plan sigue valiendo: el plan es el mismo.
    ...(outcome.planAudit ? { planAudit: outcome.planAudit } : {}),
  }
}

/**
 * Lo que hace el programa de ahora al ejecutarlo, si quien lo aloja sabe ejecutarlo: con qué falla (`null` si
 * no falla) y, dicho para quien revisa, lo que imprime y cómo acaba.
 */
async function ranOf(host: Stagehand): Promise<{ broken: string | null; said: string } | null> {
  if (!host.run) return null
  const trace = await host.run().catch(() => null)
  // (Lo que el modo seguro no deja ejecutar no es un fallo del programa: simplemente, aquí no se ve.)
  if (!trace || trace.error?.name === 'UnsafeCode') return null
  const waiting = trace.error?.name === 'NoMoreInput'
  const broken =
    trace.error && !waiting
      ? `${trace.error.name}: ${trace.error.message}${trace.error.line === null ? '' : ` (línea ${trace.error.line})`}`
      : null
  const output = trace.output.length > 1800 ? `…${trace.output.slice(-1800)}` : trace.output
  const said = [
    output.trim() === ''
      ? 'Al ejecutarlo (sin nadie delante) no imprime nada.'
      : `Al ejecutarlo (sin nadie delante) imprime:\n${output.replace(/\s+$/, '')}`,
    ...(waiting ? ['Y se queda esperando a que se teclee algo.'] : []),
    ...(broken ? [`Y falla: ${broken}`] : []),
    ...(trace.truncated && trace.finished !== true ? ['No llegó a acabar: era muy largo.'] : []),
    // Un hecho, no una opinión: lo que se usa existe (si no, habría fallado). Quien revisa no lo discute.
    ...(!broken && !waiting
      ? [
          'Se ejecutó entero sin ningún fallo: todo lo que usa (notas, colores, funciones) existe y funciona; si algo no existiera, habría fallado aquí.',
        ]
      : []),
  ].join('\n')
  return { broken, said }
}

/** Por debajo de esta certeza del JEV en que se cumplió la orden, lo hecho se revisa con la IA. */
export const REVIEW_BELOW = 0.85

/**
 * ¿Se hace con la pantalla (para usarlo de verdad)? Solo donde la hay: si el programa ya la usa, sí; si no, lo
 * dice el JEV de lo pedido.
 */
async function screenFor(
  host: Stagehand,
  players: Players,
  command: string,
  program: Program,
): Promise<boolean> {
  if (host.screen !== true) return false
  if (usesScreenModule(program.source)) return true
  const judged = await judgeScreen(players.decider, command).catch(() => null)
  return judged !== null && judged.uses >= SCREEN_THRESHOLD
}

const withScreen = (system: string, screen: boolean) =>
  screen ? `${system}\n\n${SCREEN_GUIDE}` : system

/** Hasta cuánto programa lee la revisión (un programa enorme se revisa por su principio). */
const REVIEW_BUDGET = 24_000

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

async function modifyOnce(
  host: Stagehand,
  players: Players,
  request: ModifyRequest,
): Promise<Outcome> {
  const { command } = request
  const tally: Tally = {
    written: 0,
    code: [],
    jevMs: 0,
    trouble: null,
    heads: [],
    chunks: 0,
    repeated: 0,
  }
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
      system: withScreen(modifySystem(), await screenFor(host, players, command, start)),
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
