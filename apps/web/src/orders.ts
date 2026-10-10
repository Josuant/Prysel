import { buildProgram, type Program, type PythonParser } from '@prysel/python'
import {
  applyEdits as applyTextEdits,
  clearGenerating,
  fillGenerated,
  untouchedTemplate,
  validEdits,
  type TextEdit,
} from '@prysel/python/edits'
import type { TemplateId } from '@prysel/morphology'
import { generateLesson } from '../../../packages/extension/src/ai/generate.ts'
import type { AiProvider } from '../../../packages/extension/src/ai/provider.ts'
import { smartAsk } from '../../../packages/extension/src/jev/ask.ts'
import { JevError, type Decider } from '../../../packages/extension/src/jev/client.ts'
import { splitOrder } from '../../../packages/extension/src/jev/compose.ts'
import { contextFor } from '../../../packages/extension/src/jev/context.ts'
import {
  build,
  modify,
  summaryOf,
  type Outcome,
  type Stagehand,
} from '../../../packages/extension/src/jev/director.ts'
import {
  decideCommand,
  type Decision,
  type Directive,
  type Effect,
} from '../../../packages/extension/src/jev/engine.ts'
import {
  answerQuestion,
  explainNode,
  generateFill,
} from '../../../packages/extension/src/jev/fill.ts'
import { indentationOk } from '../../../packages/extension/src/jev/modify.ts'
import {
  DONE_THRESHOLD,
  judgeDone,
  judgeArchitecture,
  judgeCover,
  judgeHeard,
  judgeInterruption,
  type Interruption,
} from '../../../packages/extension/src/jev/plain.ts'
import type { Lesson } from '../../../packages/extension/src/lesson.ts'
import type { CommandMessage, WebviewMessage } from '../../../packages/extension/src/protocol.ts'
import type { Trace } from '../../../packages/extension/src/trace.ts'

/**
 * Las órdenes del chat en la web: lo mismo que hace la extensión en `extension.ts` (el motor JEV decide,
 * la IA generativa redacta y el director construye paso a paso mientras se explica), pero sobre el
 * documento que vive en la página. Lo que necesita del anfitrión se lo pide por `OrderPort`.
 */

export interface OrderPort {
  version(): number
  text(): string
  name(): string
  parser(): Promise<PythonParser>
  analyse(): Promise<Program>
  /** Escribe unas ediciones (y las apunta en la historia del lienzo). `false` si no se pudieron aplicar. */
  write(edits: readonly TextEdit[], remember?: boolean): boolean
  /** Vuelve a analizar y le manda al lienzo el programa nuevo. */
  refresh(): Promise<void>
  post(message: WebviewMessage): void
  provider(): AiProvider | null
  decider(): Decider
  /** A qué ritmo se construye: al de la IA (`stream`) o esperando a la voz (`voice`). */
  flow(): 'voice' | 'stream'
  trace(): Promise<Trace | null>
  setLesson(lesson: Lesson): void
}

const newGenId = () => Math.random().toString(36).slice(2, 8).padEnd(6, '0')
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const STEP_PATIENCE_MS = 3000
/** Cuántas órdenes atrás se recuerdan. */
const MAX_TURNS = 5
/** Lo más que se espera, quieto, a que el usuario acabe de hablar. */
const HOLD_PATIENCE_MS = 12_000
const STEP_PAUSE_MS = 700
const SPEECH_PATIENCE_MS = 25_000
const AFTER_SPEECH_MS = 280
const FILL_PATIENCE_MS = 30_000

interface Building {
  command: string
  pending: string[]
  done: Promise<void>
}

interface Fill {
  command: string
  template: TemplateId
  state: 'waiting' | 'running'
  at: number
}

export class Orders {
  private build: AbortController | null = null
  private building: Building | null = null
  private lastWork: { from: number; to: number } | null = null
  private speaking = new Map<number, (spoke: boolean) => void>()
  private speechSeq = 0
  private fills = new Map<string, Fill>()
  /** El usuario está hablando: lo que se construye se queda quieto. */
  private held = false
  /** Las últimas órdenes y lo que se hizo con cada una: la conversación. */
  private turns: { order: string; did: string }[] = []
  private heardSeq = 0
  private coverSeq = { at: 0 }
  private planSeq = { at: 0 }

  constructor(private readonly port: OrderPort) {}

  /**
   * El lienzo escribió algo por su cuenta (una pieza añadida, algo movido): son las líneas de «lo último
   * que se hizo», igual que lo que construye una orden compleja.
   */
  touched(from: number, to: number) {
    this.lastWork = { from, to }
  }

  /** El documento cambió por completo (otra lección, otro programa): lo que estaba en marcha ya no vale. */
  reset() {
    this.build?.abort()
    this.lastWork = null
    this.turns = []
    this.fills.clear()
  }

  /** Si hay una orden construyendo algo o una pieza redactándose. */
  get busy(): boolean {
    return (
      this.building !== null || [...this.fills.values()].some((fill) => fill.state === 'running')
    )
  }

  /** El lienzo terminó de decir lo que se le mandó con ese número. */
  spoken(seq: number, spoke: boolean) {
    this.speaking.get(seq)?.(spoke)
    this.speaking.delete(seq)
  }

  stop() {
    this.build?.abort()
  }

  /**
   * Una orden llega del chat. Si se está construyendo algo, es una interrupción: el JEV decide si lo
   * preparado sigue valiendo, si hay que ajustarlo o si es otra cosa.
   */
  async receive(message: CommandMessage) {
    const active = this.building
    if (!active) {
      this.held = false
      return this.handle(message)
    }
    let what: Interruption = 'otra'
    try {
      what = (
        await judgeInterruption(this.port.decider(), {
          building: active.command,
          said: message.text,
          pending: active.pending.join('\n'),
        })
      ).what
    } catch {
      what = 'otra'
    }
    // Ya se sabe qué hacer con lo que dijo: lo que estaba quieto sigue, o se corta.
    this.held = false
    if (what === 'seguir') {
      this.port.post({
        type: 'decision',
        id: message.id,
        version: this.port.version(),
        directive: { kind: 'ignored', say: 'Sigo con lo que estaba construyendo.' },
        evidence: [],
        engine: this.port.decider().id,
        jevMs: 0,
      })
      return
    }
    this.build?.abort()
    await active.done
    await this.port.refresh()
    return this.handle(
      { ...message, version: this.port.version() },
      what === 'ajustar' ? active.command : undefined,
    )
  }

  private reply(message: CommandMessage, directive: Directive) {
    this.port.post({
      type: 'decision',
      id: message.id,
      version: this.port.version(),
      directive,
      evidence: [],
      engine: '',
      jevMs: 0,
    })
  }

  private async handle(message: CommandMessage, resume?: string) {
    const { port } = this
    const changed = () => {
      void port.refresh()
      this.reply(message, { kind: 'failed', say: 'El programa cambió mientras tanto. Repítelo.' })
    }
    if (port.version() !== message.version) return changed()
    const decider = port.decider()
    const provider = port.provider()
    const now = Date.now()
    for (const [id, fill] of this.fills) {
      if (fill.state === 'waiting' && now - fill.at > FILL_PATIENCE_MS) this.fills.delete(id)
    }
    try {
      const decision = await this.decide(message, message.text, false, decider, provider)
      if (decision === null) return changed()
      if (decision.directive.kind !== 'several' || !provider) {
        await this.carryOut(message, message.text, decision, decider, provider, resume)
        return
      }
      const steps = await splitOrder(provider, message.text)
      if (!steps) {
        const single = await this.decide(message, message.text, true, decider, provider)
        if (single === null) return changed()
        await this.carryOut(message, message.text, single, decider, provider, resume)
        return
      }
      for (const [index, step] of steps.entries()) {
        const before = port.version()
        const part = await this.decide(message, step, true, decider, provider)
        if (part === null) return changed()
        const { directive } = part
        const label = `${index + 1}/${steps.length}`
        if (directive.kind !== 'do') {
          // Un paso anterior puede haberlo dejado hecho («sácalo de la función» ya lo pone en el programa):
          // si el JEV, mirando el programa, dice que está cumplido, se sigue con lo que queda en vez de
          // pararse y dejar sin hacer el resto de lo que se pidió.
          if (index > 0) {
            const done = await judgeDone(decider, step, port.text(), steps.slice(0, index)).catch(
              () => 0,
            )
            if (done >= DONE_THRESHOLD) {
              port.post({ type: 'say', text: `${label} · Eso ya estaba hecho: sigo.`, aside: true })
              continue
            }
          }
          const why = directive.kind === 'ask' ? directive.question : directive.say
          port.post({
            type: 'decision',
            id: message.id,
            version: port.version(),
            ...part,
            directive: { kind: 'unknown', say: `Me paro en el paso ${label} («${step}»): ${why}` },
          })
          return
        }
        const said = { ...directive, say: `${label} · ${directive.say}` }
        const wrote = await this.carryOut(
          message,
          step,
          { ...part, directive: said },
          decider,
          provider,
        )
        if (
          said.effect.type === 'action' ||
          said.effect.type === 'undo' ||
          said.effect.type === 'redo'
        ) {
          const until = Date.now() + STEP_PATIENCE_MS
          while (port.version() === before && Date.now() < until) await sleep(25)
        } else if (!wrote) await sleep(STEP_PAUSE_MS)
        await port.refresh()
      }
    } catch (error) {
      this.reply(message, {
        kind: 'failed',
        say: error instanceof JevError ? error.message : `No se pudo decidir. ${messageOf(error)}`,
        ...(error instanceof JevError && error.reason === 'key' ? { needsKey: true } : {}),
      })
    }
  }

  private async decide(
    message: CommandMessage,
    text: string,
    single: boolean,
    decider: Decider,
    provider: AiProvider | null,
  ): Promise<Decision | null> {
    const version = this.port.version()
    const program = await this.port.analyse()
    const decision = await decideCommand(
      {
        text,
        program,
        selected: message.selected,
        focus: message.focus,
        typed: true,
        ...(message.force && !single ? { forced: message.force } : {}),
        ...(provider ? { genId: newGenId() } : {}),
        ...(single ? { single: true } : {}),
        ...(this.lastWork ? { last: this.lastWork } : {}),
        ...(this.turns.length > 0 ? { history: this.turns } : {}),
      },
      decider,
    )
    return this.port.version() === version ? decision : null
  }

  private async carryOut(
    message: CommandMessage,
    text: string,
    decision: Decision,
    decider: Decider,
    provider: AiProvider | null,
    resume?: string,
  ): Promise<boolean> {
    const { port } = this
    const { directive } = decision
    if (directive.kind === 'do' && directive.pending) {
      this.fills.set(directive.pending.id, {
        command: text,
        template: directive.pending.template,
        state: 'waiting',
        at: Date.now(),
      })
    }
    port.post({ type: 'decision', id: message.id, version: port.version(), ...decision })
    // La conversación se recuerda: lo que se pidió y lo que se decidió hacer con ello.
    const earlier = this.turns
    if (directive.kind === 'do') {
      this.turns = [...this.turns, { order: text, did: directive.say }].slice(-MAX_TURNS)
    }
    if (directive.kind !== 'do') {
      if (!message.force) await this.askBetter(message, text, decision, decider, provider)
      return false
    }
    const { effect } = directive
    if (!provider && (effect.type === 'compose' || effect.type === 'modify')) {
      port.post({
        type: 'say',
        text: 'Para escribir y explicar esto hace falta una IA: añade tu clave de Anthropic o de DeepSeek en Ajustes.',
      })
      return false
    }
    if ((effect.type === 'compose' || effect.type === 'modify') && provider) {
      // A la IA también se le cuenta lo de antes: «pero usando la clase» no dice nada por sí solo.
      const before =
        earlier.length === 0
          ? ''
          : `\n(Para situarte, esto es lo que se ha ido pidiendo antes, ya hecho, de lo más antiguo a lo más reciente:\n${earlier
              .map((turn) => `- «${turn.order}» → ${turn.did}`)
              .join(
                '\n',
              )}\nLa orden de ahora puede referirse a ello: haz lo necesario para que se cumpla de verdad —añadir un método que falte, usar el objeto que se creó—, tocando lo que haga falta del programa.)`
      const asked =
        (resume === undefined
          ? text
          : `${text}\n(Se estaba construyendo «${resume}» y se dejó a medias al oír esto. Tenlo en cuenta: termina lo que falte o cámbialo, sin repetir lo que ya está escrito.)`) +
        before
      return this.runDirected(decider, provider, asked, effect, text)
    }
    if (effect.type === 'lesson') {
      if (provider) await this.explainFile(provider)
      else {
        port.post({
          type: 'say',
          text: 'Para generar la lección hace falta una IA: añade tu clave de Anthropic o de DeepSeek en Ajustes.',
        })
      }
      return false
    }
    if (directive.explain !== undefined && provider) {
      const program = await port.analyse()
      const node = program.nodes.find((n) => n.id === directive.explain)
      const said = node ? await explainNode(provider, program, node) : null
      if (said && node) port.post({ type: 'say', text: said, focus: node.id })
    }
    // Una pregunta sobre el programa: se contesta mirándolo, y se señala dónde lo decide.
    if (directive.answer && provider) {
      const program = await port.analyse()
      // Lo seleccionado puede ser un paso o una etapa entera (que no es una sentencia: son sus líneas).
      const step = program.nodes.find((n) => n.id === message.selected)
      const stage = (program.sections ?? []).find((item) => item.id === message.selected)
      const chosen = step
        ? { line: step.line, lineEnd: step.lineEnd ?? step.line }
        : stage
          ? { line: stage.line, lineEnd: stage.lineEnd }
          : undefined
      const answer = await answerQuestion(
        provider,
        program,
        text,
        chosen ? { from: chosen.line, to: chosen.lineEnd } : undefined,
      )
      if (answer) {
        // La sentencia más interior que abarca esa línea.
        const at = answer.line
        const node =
          at === null
            ? undefined
            : program.nodes
                .filter((n) => n.range && n.line <= at && (n.lineEnd ?? n.line) >= at)
                .sort((a, b) => b.line - a.line)[0]
        port.post({ type: 'say', text: answer.said, ...(node ? { focus: node.id } : {}) })
      } else port.post({ type: 'say', text: 'No he sabido contestar a eso mirando el programa.' })
    }
    return false
  }

  /** La lección del programa que hay escrito: se traza (la verdad sobre la que se narra) y la IA la explica. */
  private async explainFile(provider: AiProvider) {
    const { port } = this
    const gen = newGenId()
    port.post({ type: 'progress', gen, text: 'Ejecutando el programa para ver qué hace…' })
    const program = await port.analyse()
    const trace = await port.trace()
    if (!trace) {
      port.post({ type: 'say', text: 'No pude ejecutar el programa para explicarlo.' })
      return
    }
    port.post({ type: 'progress', gen, text: 'Escribiendo la lección…' })
    const result = await generateLesson(program, trace, provider, {
      source: port.name(),
      lang: 'es',
    })
    if (!result.ok || !result.lesson) {
      port.post({
        type: 'say',
        text: `La lección no salió bien tras ${result.attempts} intento(s). ${result.error ?? ''}`,
      })
      return
    }
    port.setLesson(result.lesson)
    port.post({
      type: 'say',
      text: `Lista: «${result.lesson.title}». Pulsa reproducir para verla.`,
    })
  }

  private async askBetter(
    message: CommandMessage,
    text: string,
    decision: Decision,
    decider: Decider,
    provider: AiProvider | null,
  ) {
    const { port } = this
    const { directive } = decision
    if (!provider || (directive.kind !== 'ask' && directive.kind !== 'unknown')) return
    // Una confirmación de sí o no ya es concreta: mejorarla solo la enreda.
    if (directive.kind === 'ask' && directive.plain) return
    const version = port.version()
    const program = await port.analyse()
    const chosen = program.nodes.find((n) => n.id === message.selected)
    const context = await contextFor(decider, {
      command: text,
      program,
      ...(chosen ? { must: [chosen.line] } : {}),
    })
    const better = await smartAsk(provider, decider, {
      input: {
        text,
        program,
        selected: message.selected,
        focus: message.focus,
        typed: true,
        genId: newGenId(),
        ...(this.lastWork ? { last: this.lastWork } : {}),
      },
      context: context.text,
      directive,
      evidence: decision.evidence,
      ...(chosen
        ? { selected: `línea ${chosen.line}: ${(chosen.text ?? chosen.label).split('\n')[0]}` }
        : {}),
    })
    if (!better || port.version() !== version) return
    const [only] = better.options
    if (directive.kind === 'unknown' && better.options.length === 1 && only?.order !== undefined) {
      const clear = await this.decide(message, only.order, true, decider, provider)
      if (clear?.directive.kind === 'do') {
        await this.carryOut(message, only.order, clear, decider, provider)
        return
      }
    }
    port.post({
      type: 'decision',
      id: message.id,
      version: port.version(),
      ...decision,
      directive: better,
    })
  }

  private async pauseFor(ms: number, signal: AbortSignal) {
    const until = Date.now() + ms
    while (!signal.aborted && Date.now() < until) await sleep(Math.min(40, ms))
    // El usuario está hablando: lo que se construye espera a oír qué dice (con un tope, por si el micrófono
    // se quedó abierto sin nadie).
    const patience = Date.now() + HOLD_PATIENCE_MS
    while (this.held && !signal.aborted && Date.now() < patience) await sleep(60)
    if (this.held && Date.now() >= patience) this.held = false
  }

  /** El usuario empezó a hablar, sigue hablando (`text`: lo que lleva dicho) o lo dejó sin decir nada. */
  listening(on: boolean, text?: string) {
    this.held = on && this.building !== null
    if (!on || text === undefined) return
    // Con cada palabra nueva, el JEV adelanta qué se está pidiendo. Si llega tarde (ya dijo más), no vale.
    const turn = ++this.heardSeq
    void judgeHeard(this.port.decider(), text)
      .then(({ kind, complete }) => {
        if (turn === this.heardSeq) this.port.post({ type: 'preview', kind, text, complete })
      })
      .catch(() => undefined)
  }

  /** El papel de cada módulo y la forma del programa: lo dice el JEV; la respuesta lleva la clave de la pregunta. */
  arch(key: string, modules: { title: string; does: string }[], shapes: string[]) {
    void judgeArchitecture(this.port.decider(), modules, shapes)
      .then(({ roles, shape }) => {
        this.port.post({ type: 'arched', key, roles, shape })
      })
      .catch(() => undefined)
  }

  /** Qué pieza del programa cubre cada parte de lo que se pidió: lo dice el JEV; si llega tarde, no vale. */
  cover(what: string, parts: string[], pieces: string[], plan = false) {
    // Lo escrito y lo planeado se preguntan por separado: una respuesta no deja vieja a la otra.
    const seq = plan ? this.planSeq : this.coverSeq
    const turn = ++seq.at
    void judgeCover(this.port.decider(), what, parts, pieces, plan)
      .then((by) => {
        if (turn !== seq.at) return
        this.port.post({ type: 'covered', parts, pieces, by, ...(plan ? { plan: true } : {}) })
      })
      .catch(() => undefined)
  }

  /** Una orden compleja la lleva el director (`jev/director.ts`), por partes, mientras el diagrama cambia. */
  private async runDirected(
    decider: Decider,
    provider: AiProvider,
    command: string,
    effect: Extract<Effect, { type: 'compose' | 'modify' }>,
    said?: string,
  ): Promise<boolean> {
    const { port } = this
    this.build?.abort()
    const control = new AbortController()
    this.build = control
    const { signal } = control
    const state: Building = { command: said ?? command, pending: [], done: Promise.resolve() }
    let finish: () => void = () => undefined
    state.done = new Promise<void>((resolve) => {
      finish = resolve
    })
    this.building = state
    const parser = await port.parser()
    let heard: Promise<boolean> | null = null
    let span: { from: number; to: number } | null = null
    const host: Stagehand = {
      signal,
      program: () => port.analyse(),
      parses: (code) => !parser.parse(code).rootNode.hasError,
      async write(change) {
        const before = port.text()
        const { edits } = change
        if (edits.length === 0) return null
        if (!validEdits(edits, before.length)) {
          return 'El siguiente paso no deja un programa válido: me detengo.'
        }
        // El analizador tolera una sangría sin sentido; Python no. Se comprueban las dos cosas.
        const next = applyTextEdits(before, edits)
        if (parser.parse(next).rootNode.hasError || !indentationOk(next)) {
          return 'El siguiente paso no deja un programa válido: me detengo.'
        }
        return port.write(edits) ? null : 'No se pudo escribir en el programa.'
      },
      show: async (event) => {
        if (event.type === 'step' && event.effect !== 'leaving') {
          span = span
            ? { from: Math.min(span.from, event.line), to: Math.max(span.to, event.line) }
            : { from: event.line, to: event.line }
        }
        if (event.type === 'progress') {
          port.post({ type: 'progress', gen: effect.gen, text: event.text })
          return
        }
        if (event.type === 'architecture') {
          port.post({ type: 'architecture', modules: event.modules })
          return
        }
        const seq = event.say === '' ? undefined : ++this.speechSeq
        heard =
          seq === undefined
            ? null
            : new Promise<boolean>((resolve) => {
                this.speaking.set(seq, resolve)
              })
        if (event.type === 'say') {
          port.post({
            type: 'say',
            text: event.say,
            ...(seq === undefined ? {} : { seq }),
            ...(event.aside ? { aside: true } : {}),
          })
          return
        }
        await port.refresh()
        port.post({
          type: 'step',
          gen: effect.gen,
          index: event.index,
          say: event.say,
          line: event.line,
          effect: event.effect,
          ...(event.wide ? { wide: true } : {}),
          ...(event.mark ? { mark: event.mark } : {}),
          ...(event.folded ? { folded: true } : {}),
          ...(event.anchor === undefined ? {} : { anchor: event.anchor }),
          ...(seq === undefined ? {} : { seq }),
        })
      },
      wait: (ms) => this.pauseFor(ms, signal),
      buffer(pending) {
        state.pending = [...pending]
      },
      settle: async (estimate) => {
        const started = Date.now()
        const pending = heard
        heard = null
        if (!pending) return this.pauseFor(estimate, signal)
        const spoke = await Promise.race([
          pending,
          this.pauseFor(Math.max(SPEECH_PATIENCE_MS, estimate * 4), signal).then(() => false),
        ])
        await this.pauseFor(
          spoke ? AFTER_SPEECH_MS : Math.max(0, estimate - (Date.now() - started)),
          signal,
        )
      },
    }
    let outcome: Outcome
    try {
      outcome =
        effect.type === 'compose'
          ? await build(
              host,
              { decider, provider },
              {
                command,
                gen: effect.gen,
                place: effect.place,
                where: effect.where,
                outline: effect.outline,
                ...(effect.teach ? { teach: true } : {}),
                flow: port.flow(),
              },
            )
          : await modify(
              host,
              { decider, provider },
              {
                command,
                ...(effect.lines ? { lines: effect.lines } : {}),
                ...(effect.scope ? { scope: effect.scope } : {}),
                whole: true,
              },
            )
    } catch (error) {
      outcome = {
        written: 0,
        stopped: signal.aborted,
        trouble: `Algo falló a mitad. ${messageOf(error)}`,
        doubt: false,
        evidence: [],
        jevMs: 0,
      }
    }
    control.abort()
    if (this.build === control) this.build = null
    if (this.building === state) this.building = null
    finish()
    if (span) {
      const { from, to } = span as { from: number; to: number }
      const tail = (await port.analyse()).nodes.find((n) => n.range && n.line === to)
      this.lastWork = { from, to: tail?.lineEnd ?? to }
    }
    await port.refresh()
    port.post({
      type: 'generated',
      gen: effect.gen,
      ok: outcome.written > 0,
      say: summaryOf(outcome, effect.type === 'modify' ? ['cambio', 'cambios'] : ['paso', 'pasos']),
      ...(outcome.evidence.length > 0 ? { evidence: outcome.evidence } : {}),
      jevMs: outcome.jevMs,
      done: true,
      ...(outcome.enter === undefined ? {} : { enter: outcome.enter }),
    })
    return outcome.written > 0
  }

  // ── piezas que nacen «generándose» ──────────────────────────────────────

  /** Tras cada análisis: las piezas que acaban de llegar al código empiezan a redactarse. */
  tend(program: Program) {
    for (const node of program.nodes) {
      const gen = node.generating
      if (gen === undefined) continue
      const fill = this.fills.get(gen)
      if (fill?.state === 'waiting') {
        fill.state = 'running'
        void this.runFill(gen)
      } else if (!fill && this.building === null) {
        // Una marca sin nadie que la esté redactando (se recargó la página a medias): se retira. Mientras se
        // construye, no: los huecos del plan llevan esa marca, y es por ella por donde entra el código.
        // Y se vuelve a enseñar: si no, el lienzo se queda con la versión anterior del programa y rechaza
        // todo lo que se le pida después («El programa cambió mientras tanto»).
        void this.change((current) => clearGenerating(current, gen).edits, false).then((wrote) => {
          if (wrote) return this.port.refresh()
        })
        return
      }
    }
  }

  private async change(make: (program: Program) => TextEdit[], remember = true) {
    const edits = make(await this.port.analyse())
    if (edits.length === 0 || !validEdits(edits, this.port.text().length)) return false
    return this.port.write(edits, remember)
  }

  private async runFill(gen: string) {
    const fill = this.fills.get(gen)
    if (!fill) return
    const { port } = this
    let code = ''
    let finished = false
    const finish = async (say: string | null, error?: string) => {
      if (finished) return
      finished = true
      this.fills.delete(gen)
      let line: number | undefined
      const written =
        say !== null &&
        (await this.change((program) => {
          if (!untouchedTemplate(program, gen, fill.template)) return []
          const change = fillGenerated(program, gen, code)
          line = change.select?.line
          return change.edits
        }))
      if (!written) await this.change((program) => clearGenerating(program, gen).edits)
      await port.refresh()
      port.post({
        type: 'generated',
        gen,
        ok: written,
        ...(written && say !== null ? { say } : {}),
        ...(written || error === undefined ? {} : { error }),
        ...(line === undefined ? {} : { line }),
      })
    }
    try {
      const provider = port.provider()
      if (!provider)
        return await finish(
          null,
          'Falta la clave de una IA (Anthropic o DeepSeek) para escribir el contenido.',
        )
      const parser = await port.parser()
      const result = await generateFill(
        provider,
        {
          parse: (text) => {
            const tree = parser.parse(text)
            return { program: buildProgram(tree, text), hasError: tree.rootNode.hasError }
          },
        },
        {
          command: fill.command,
          template: fill.template,
          program: await port.analyse(),
          genId: gen,
        },
      )
      if (!result.ok) return await finish(null, result.error)
      code = result.code
      await finish(result.say)
    } catch (error) {
      await finish(null, messageOf(error))
    }
  }
}
