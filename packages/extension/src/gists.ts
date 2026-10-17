import type { Program } from '@prysel/python'
import type { AiProvider } from './ai/provider.ts'
import { functionsIn, type Facts } from './gist/facts.ts'
import { entryOf, idleness, withLaunch } from './gist/entry.ts'
import { showValue } from './gist/value.ts'
import { storyOf } from './gist/story.ts'
import { judgeEntry } from './jev/plain.ts'
import {
  ANSWER_ROUNDS,
  GistCache,
  MAX_ANSWERS,
  asksInput,
  callPrompt,
  callSystem,
  continueAnswers,
  finalValues,
  gistsOf,
  inputSignature,
  invent,
  proposeAnswers,
  runSummary,
  settled,
  tested,
  unrunnable,
  validCall,
  type Gist,
  type RunSummary,
  mixTracer,
} from './gist/gist.ts'
import { loopsIn, type LoopFacts } from './gist/laps.ts'
import {
  MAX_WATCHES,
  autoWatches,
  measuredOf,
  pickWatches,
  progressOf,
  proposeWatches,
  wishedWatches,
  type Progress,
  type Watch,
} from './gist/progress.ts'
import { triesIn } from './gist/net.ts'
import { classesIn } from './gist/blueprint.ts'
import { conditionsIn } from './gist/branch.ts'
import { pickRule, verifiedRules } from './gist/patterns.ts'
import type { MixRule } from './gist/mechanisms.ts'
import type { Decider } from './jev/client.ts'
import type { Trace } from './trace.ts'

/**
 * «Qué hace» cada función, al día: cuando el código se asienta (nadie está escribiendo ni construyendo), se
 * ejecuta el programa, se saca de su traza una muestra de cada función, y a las que nadie llama se les
 * propone una llamada de prueba. El lienzo recibe el resultado y pliega cada función en su tarjeta.
 *
 * Nada de esto toca el código: solo lo ejecuta, aparte, y mira.
 */

export interface GistsPort {
  version(): number
  text(): string
  analyse(): Promise<Program>
  /**
   * Ejecuta un programa entero grabando su traza; `null` si no se pudo. `inputs`: las respuestas de teclado
   * de ejemplo, si el programa pide datos.
   */
  trace(
    code: string,
    inputs?: readonly string[],
    seed?: number,
    /** Sondas: unas expresiones que mirar en cada vuelta del bucle de esa línea. */
    watch?: { line: number; exprs: readonly string[] },
  ): Promise<Trace | null>
  provider(): AiProvider | null
  /** Quien elige entre varias reglas que la muestra confirma por igual. */
  decider(): Decider
  /** Hay una orden construyendo o una consulta en marcha: se espera a que acabe. */
  busy(): boolean
  post(gists: Gist[], version: number, run: RunSummary | null): void
}

/** Lo que se espera, con el código quieto, antes de ejecutarlo. */
const CALM_MS = 900
/** La suerte de la sesión de ejemplo: siempre la misma, para que sus respuestas sigan valiendo. */
const EXAMPLE_SEED = 7
/** A cuántas funciones sin llamada se les propone una prueba en cada pasada. */
const MAX_INVENTED = 6

export class Gists {
  private readonly cache = new GistCache()
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  /** El texto del que salió lo último que se mandó: si no ha cambiado, no hay nada que hacer. */
  private done: string | null = null
  private last: Gist[] = []
  /** Cómo le fue al programa la última vez que se ejecutó. */
  private ran: RunSummary | null = null
  /** Las respuestas de teclado de ejemplo, por lo que el programa pregunta: mientras pregunte lo mismo, valen. */
  private readonly answers = new Map<string, string[]>()
  /**
   * Quien lo usa está jugando el programa: sus respuestas, para lo que el programa pregunta (`key`), y la
   * suerte de esa partida. Mientras el programa pregunte lo mismo, valen en vez de las de ejemplo.
   */
  private mine: { key: string; answers: string[]; seed: number } | null = null
  private playSeq = 0
  /** La función que pondría el programa en marcha, si la última vez no hizo nada. */
  private entry: Facts | null = null
  /** Las pruebas de quien lo usa: con qué llamada quiere ver cada función (por su nombre). */
  private readonly trials = new Map<string, string>()
  /** La suerte con la que se ejecuta, si se pidió otra tirada (si no, la de siempre: se ve lo mismo cada vez). */
  private rolled: number | null = null
  /** Las mezclas vueltas a ver con datos trazadores, por el texto de su función (`null`: no hizo falta o no se pudo). */
  private readonly tracers = new Map<string, MixRule | null>()
  /**
   * Qué mirar en cada vuelta de un bucle para contar cómo avanza el programa, por el texto de ese bucle
   * (`null`: se miró y no hay nada que contar). Se decide una vez; después solo se mide.
   */
  private readonly watching = new Map<
    string,
    { text: Watch | null; number: Watch | null; wish?: string } | null
  >()
  /** Lo que quien lo usa dijo que quería ver en cada vuelta (`null`: lo que se elija solo). */
  private wish: string | null = null
  /** Lo que hace falta para decidirlo, de la última ejecución: se hace después de enseñar lo demás. */
  private toWatch: {
    text: string
    loop: LoopFacts
    output: string
    inputs: string[] | undefined
    seed: number
  } | null = null

  constructor(private readonly port: GistsPort) {}

  /** Lo último que se supo, para exportarlo con los registros. */
  get all(): readonly Gist[] {
    return this.last
  }

  /** Lo que salió al ejecutar el programa la última vez, para exportarlo con los registros. */
  get run(): RunSummary | null {
    return this.ran
  }

  /** Queda algo por mirar: está esperando a que haya calma, o ejecutando. */
  get pending(): boolean {
    return this.timer !== null || this.running
  }

  /**
   * Otra tirada: el programa se vuelve a ejecutar con otra suerte (otra semilla para su azar), y todo lo que
   * se enseña de él se rehace con esa ejecución. El código no cambia.
   */
  reroll() {
    this.rolled = 1 + Math.floor(Math.random() * 100_000)
    this.done = null
    this.touch()
  }

  /**
   * Quien lo usa dice qué quiere ver avanzar (`''`: lo que se elija solo). Lo decidido hasta ahora se olvida
   * y el programa se vuelve a mirar: la IA propone cómo medir eso, y se mide.
   */
  rewatch(text: string) {
    this.wish = text.trim() === '' ? null : text.trim()
    this.watching.clear()
    this.done = null
    this.touch()
  }

  /** El código cambió (o algo acabó): se vuelve a mirar cuando haya calma. */
  touch() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.pass()
    }, CALM_MS)
  }

  /**
   * Jugar el programa: se ejecuta con las respuestas que quien lo usa lleva dadas y se para en la siguiente
   * pregunta. La pantalla se manda enseguida; las tarjetas se rehacen con esa partida cuando acaba.
   * `null`: volver a la sesión de ejemplo. `fresh`: partida nueva, con otra suerte.
   */
  async play(answers: readonly string[] | null, fresh = false) {
    const turn = ++this.playSeq
    if (answers === null) {
      this.mine = null
      this.done = null
      return this.touch()
    }
    const text = this.port.text()
    if (!asksInput(text)) return
    const version = this.port.version()
    const seed = fresh ? 1 + Math.floor(Math.random() * 100_000) : (this.mine?.seed ?? EXAMPLE_SEED)
    this.mine = { key: inputSignature(text), answers: [...answers], seed }
    const raw = await this.port.trace(text, answers, seed).catch(() => null)
    // Mientras se ejecutaba llegó otra respuesta, o el código cambió: esto ya no es lo último.
    if (!raw || turn !== this.playSeq || this.port.version() !== version) return
    this.ran = runSummary(raw, answers, true)
    this.port.post(this.last, version, this.ran)
    // La partida acabó: las tarjetas se rehacen con lo que de verdad pasó en ella.
    if (this.ran.ended !== 'waiting') {
      this.done = null
      this.touch()
    }
  }

  /**
   * Probar una función con otros datos: la llamada se ejecuta ya, y su tarjeta cambia. Se guarda: mientras
   * la función exista, su tarjeta enseña esa prueba. `null`: volver a la muestra del programa.
   */
  async tryCall(id: string, call: string | null) {
    const known = this.last.find((gist) => gist.id === id)
    if (!known || known.block) return
    const key = `${known.owner ?? ''}.${known.name}`
    if (call === null) {
      this.trials.delete(key)
      this.done = null
      return this.touch()
    }
    const version = this.port.version()
    const program = await this.port.analyse()
    const fact = functionsIn(program).find((candidate) => candidate.id === id)
    if (!fact) return
    const inputs = this.inputsNow(program.source)
    const gist = await tested(program, fact, call, (code) => this.traced(code, inputs))
    if (!gist || this.port.version() !== version) return
    this.trials.set(key, call)
    this.last = this.last.map((one) => (one.id === id ? gist : one))
    this.port.post(this.last, version, this.ran)
  }

  /** Las respuestas de teclado con las que se ejecuta ahora el programa, si las pide. */
  private inputsNow(text: string): { answers: string[]; seed: number } | undefined {
    if (!asksInput(text)) return undefined
    const key = inputSignature(text)
    if (this.mine?.key === key) return { answers: this.mine.answers, seed: this.mine.seed }
    const answers = this.answers.get(key)
    return answers ? { answers, seed: EXAMPLE_SEED } : undefined
  }

  private async traced(code: string, inputs?: { answers: string[]; seed: number }): Promise<Trace> {
    return (
      (await this.port.trace(code, inputs?.answers, inputs?.seed ?? EXAMPLE_SEED)) ?? {
        events: [],
        truncated: false,
        error: null,
        output: '',
      }
    )
  }

  /** La función que pondría el programa en marcha: la que destaca o, si empatan varias, la que diga el JEV. */
  private async findEntry(program: Program): Promise<Facts | null> {
    const found = entryOf(program)
    if (found.entry || found.tied.length === 0) return found.entry
    const chosen = await judgeEntry(
      this.port.decider(),
      found.tied.map((fact) => fact.name),
    ).catch(() => null)
    // Sin su criterio, la última del archivo: lo principal suele escribirse al final.
    return found.tied[chosen ?? found.tied.length - 1] ?? null
  }

  /** La prueba de la función que arranca, apuntada junto a cómo le fue al programa. */
  private noteTrial(gist: Gist | undefined) {
    const sample = gist?.sample
    if (!sample?.call || !this.ran) return
    this.ran = {
      ...this.ran,
      trial: {
        call: sample.call,
        ...(sample.error !== undefined
          ? { returned: sample.error }
          : sample.returned !== undefined
            ? { returned: showValue(sample.returned) }
            : {}),
        ...(sample.printed ? { printed: sample.printed } : {}),
      },
    }
  }

  /**
   * Arrancar el programa: el texto que hay que añadirle al final para que llame a su función principal con
   * un ejemplo y enseñe lo que da. Usa la llamada con la que ya se probó; si no la hay y hace falta
   * inventarla, se le pide a la IA. `null` si no se sabe qué llamar o con qué.
   */
  async launchEdit(): Promise<{ start: number; end: number; text: string } | null> {
    const source = this.port.text()
    const program = await this.port.analyse()
    const entry = this.entry ?? (await this.findEntry(program))
    if (!entry) return null
    const fact = functionsIn(program).find((candidate) => candidate.id === entry.id)
    if (!fact) return null
    // Para arrancarlo de verdad se pide una llamada con valores con los que se vea funcionar (la de la
    // prueba aparte es mínima a propósito). Sin IA, vale la de la prueba; sin nada que recibir, ninguna.
    let call = fact.takes.length === 0 ? `${fact.name}()` : null
    const provider = this.port.provider()
    if (call === null && provider) {
      const answer = await provider
        .generate({ system: callSystem(true), prompt: callPrompt(program, fact), maxTokens: 200 })
        .catch(() => '')
      call = validCall(answer, fact)
    }
    call ??= this.last.find((gist) => gist.id === fact.id)?.sample?.call ?? null
    if (call === null) return null
    const body = source.replace(/\s+$/, '')
    return {
      start: body.length,
      end: source.length,
      text: withLaunch(source, call, fact.returns).slice(body.length),
    }
  }

  /** Lo que se decidió mirar en un bucle vale mientras su texto no cambie (y haya, o no, IA que proponga). */
  private watchKey(loop: LoopFacts): string {
    return `${this.port.provider() ? 'ia' : 'solo'}:${loop.hash}`
  }

  /**
   * Decide qué mirar en el bucle principal para contar cómo avanza el programa, y lo mide. La IA propone
   * expresiones (además se prueban las variables que el bucle cambia); el programa se ejecuta otra vez, igual
   * que antes, midiéndolas; y el JEV elige entre las que dejan ver un avance. Si al mirar el programa diera
   * otra cosa, no se enseña nada: mirar no puede cambiar lo que pasa.
   */
  private async decideWatch(pending: NonNullable<Gists['toWatch']>): Promise<Progress | null> {
    const { text, loop, output, inputs, seed } = pending
    const key = this.watchKey(loop)
    const provider = this.port.provider()
    const auto = autoWatches(text, loop)
    const wish = this.wish ?? undefined
    const proposed = provider
      ? await proposeWatches(
          provider,
          text,
          loop,
          auto.map((one) => one.expr),
          wish,
        )
      : []
    const watches = [
      ...proposed,
      ...auto.filter((one) => !proposed.some((other) => other.expr === one.expr)),
    ].slice(0, MAX_WATCHES)
    if (watches.length === 0) {
      this.watching.set(key, null)
      return null
    }
    const again = await this.port.trace(text, inputs, seed, {
      line: loop.line,
      exprs: watches.map((one) => one.expr),
    })
    if (!again?.probe || again.output !== output) {
      this.watching.set(key, null)
      return null
    }
    const measured = measuredOf(again.probe, watches)
    // Si quien lo usa dijo qué quería ver, es eso (lo que la IA propuso para ello y se pudo medir); si no
    // se pudo, o no dijo nada, elige el JEV entre todo lo medido.
    const wished = wish ? wishedWatches(measured) : null
    const picked = wished ?? (await pickWatches(this.port.decider(), loop.head, measured))
    this.watching.set(
      key,
      picked.text || picked.number
        ? {
            text: picked.text?.watch ?? null,
            number: picked.number?.watch ?? null,
            ...(wished && wish ? { wish } : {}),
          }
        : null,
    )
    const progress = progressOf(again.probe, picked)
    return progress && wished && wish ? { ...progress, wish } : progress
  }

  private async pass() {
    if (this.running || this.port.busy()) return this.touch()
    const text = this.port.text()
    if (text === this.done) return
    const version = this.port.version()
    this.running = true
    try {
      const gists = await this.compute(text)
      // Mientras se ejecutaba, el código cambió: esto ya no corresponde; se mirará otra vez.
      if (gists === null || this.port.version() !== version) return this.touch()
      this.done = text
      this.last = gists
      this.port.post(gists, version, this.ran)
      // Cómo avanza vuelta a vuelta: la primera vez hay que decidir qué mirar (lo propone la IA, se mide,
      // elige el JEV). Tarda un poco, así que llega después de lo demás.
      const pending = this.toWatch
      this.toWatch = null
      if (pending && this.ran) {
        const progress = await this.decideWatch(pending).catch(() => null)
        if (progress && this.port.version() === version && this.done === text) {
          this.ran = { ...this.ran, progress }
          this.port.post(gists, version, this.ran)
        }
      }
    } catch {
      // Sin «qué hace» el lienzo sigue como siempre: no es motivo para molestar.
    } finally {
      this.running = false
    }
  }

  private async compute(text: string): Promise<Gist[] | null> {
    this.ran = null
    if (text.trim() === '') return []
    const program = await this.port.analyse()
    const facts = functionsIn(program)
    const provider = this.port.provider()
    // Un programa que pide datos por teclado se ejecuta con unas respuestas de ejemplo: las propone la IA
    // una vez, y valen mientras el programa siga preguntando lo mismo.
    let inputs: string[] | undefined
    // Si quien lo usa lo está jugando, valen sus respuestas (y su suerte), no las de ejemplo.
    const mine = asksInput(text) && this.mine?.key === inputSignature(text) ? this.mine : null
    const seed = mine?.seed ?? this.rolled ?? EXAMPLE_SEED
    if (mine) inputs = mine.answers
    else if (asksInput(text)) {
      const key = inputSignature(text)
      inputs = this.answers.get(key)
      if (!inputs && provider) {
        const proposed = await proposeAnswers(provider, text)
        if (proposed) {
          // Si el programa tira de azar, a ciegas solo se dan las primeras: el resto las propone la IA
          // después, viendo ya lo que el programa contestó y lo que eligió (para que la sesión acabe bien).
          inputs = /\brandom\b/.test(text) ? proposed.slice(0, 2) : proposed
          this.answers.set(key, inputs)
        }
      }
    }
    const blocked = unrunnable(text, inputs !== undefined)
    if (blocked !== null) {
      // Pide datos y no hay respuestas de ejemplo: se dice qué falta para verlo funcionar.
      const waiting = asksInput(text) && inputs === undefined
      this.ran = {
        output: '',
        ended: 'blocked',
        ...(waiting ? { asks: true } : {}),
        problem: !waiting
          ? blocked
          : provider
            ? 'Pide datos por teclado, y la IA no propuso respuestas de ejemplo.'
            : 'Pide datos por teclado: juégalo tú, o conecta la IA para verlo con respuestas de ejemplo.',
      }
      return gistsOf(program, null)
    }
    // Si ya se sabe qué mirar en su bucle principal para contar cómo avanza, se mide en esta misma ejecución.
    const watched = loopsIn(program).flatMap((loop) => {
      const known = this.watching.get(this.watchKey(loop))
      const exprs = known ? [known.text, known.number].flatMap((one) => (one ? [one] : [])) : []
      return known && exprs.length > 0 ? [{ loop, known, exprs }] : []
    })[0]
    const watch = watched
      ? { line: watched.loop.line, exprs: watched.exprs.map((one) => one.expr) }
      : undefined
    this.toWatch = null
    let raw = await this.port.trace(text, inputs, seed, watch)
    // La sesión de ejemplo se quedó esperando otra respuesta: la IA ve lo que ha salido y la continúa, hasta
    // que el programa acabe (o unas pocas rondas). Las respuestas que la llevan al final se guardan.
    if (inputs && provider && !mine) {
      const key = inputSignature(text)
      for (let round = 0; round < ANSWER_ROUNDS; round++) {
        if (raw?.error?.name !== 'NoMoreInput' || inputs.length >= MAX_ANSWERS) break
        const more = await continueAnswers(provider, text, inputs, raw.output, finalValues(raw))
        if (!more) break
        inputs = [...inputs, ...more].slice(0, MAX_ANSWERS)
        this.answers.set(key, inputs)
        raw = await this.port.trace(text, inputs, seed, watch)
      }
    }
    // El anfitrión solo lo ejecuta solo en modo seguro (en VS Code corre en el equipo de verdad), y esto no lo
    // cumple: no se ejecuta, y se dice por qué y que lo ejecute quien lo usa.
    if (raw?.error?.name === 'UnsafeCode') {
      this.ran = {
        output: '',
        ended: 'blocked',
        problem: `Para ejecutarlo solo uso un modo seguro, y aquí ${raw.error.message}${
          raw.error.line === null ? '' : ` (línea ${raw.error.line})`
        }. Puede tocar tu equipo: ejecútalo tú cuando quieras.`,
      }
      return gistsOf(program, null)
    }
    if (raw) {
      const story = storyOf(program, raw)
      // El avance: medido ya (si se sabía qué mirar en ese bucle), o por decidir tras enseñar lo demás.
      const loop = story ? loopsIn(program).find((one) => one.line === story.loop.line) : undefined
      let progress: Progress | null = null
      if (loop && watched?.loop.line === loop.line && raw.probe) {
        const measured = measuredOf(raw.probe, watched.exprs)
        const of = (one: Watch | null) =>
          (one && measured.find((item) => item.watch.expr === one.expr)) ?? null
        const told = progressOf(raw.probe, {
          text: of(watched.known.text),
          number: of(watched.known.number),
        })
        progress = told && watched.known.wish ? { ...told, wish: watched.known.wish } : told
      } else if (loop && !raw.error && !this.watching.has(this.watchKey(loop))) {
        this.toWatch = { text, loop, output: raw.output, inputs, seed }
      }
      this.ran = {
        ...runSummary(raw, inputs, mine !== null),
        ...(story ? { story } : {}),
        ...(progress ? { progress } : {}),
      }
    }
    // ¿Hizo algo que se vea? Si no, se dice por qué; y si es que nadie lo arranca, quién lo arrancaría.
    this.entry = null
    const idle = raw ? idleness(program, raw) : null
    if (idle && this.ran) {
      if (idle === 'inert') this.entry = await this.findEntry(program)
      this.ran = {
        ...this.ran,
        ended: 'idle',
        idle,
        ...(this.entry ? { entry: this.entry.name } : {}),
      }
    }
    const entry = this.entry
    const trace = raw ? settled(raw) : null
    const nothing =
      facts.length === 0 &&
      loopsIn(program).length === 0 &&
      triesIn(program).length === 0 &&
      classesIn(program).length === 0 &&
      conditionsIn(program).length === 0
    if (nothing) return []
    const gists = gistsOf(program, trace, inputs !== undefined)
    // Lo que quien lo usa quiso probar manda sobre la muestra del programa: su tarjeta sigue con sus datos.
    for (const [at, gist] of gists.entries()) {
      const call = gist.block ? undefined : this.trials.get(`${gist.owner ?? ''}.${gist.name}`)
      const fact = call ? facts.find((candidate) => candidate.id === gist.id) : undefined
      if (!call || !fact || trace?.error) continue
      const mine = await tested(program, fact, call, (code) =>
        this.traced(code, inputs ? { answers: inputs, seed } : undefined),
      )
      if (mine) gists[at] = mine
    }
    let invented = 0
    // La función que arranca el programa se prueba la primera, y no gasta el cupo de las demás: es la que
    // dice si el conjunto funciona.
    const inOrder = [...gists.entries()].sort(
      ([, a], [, b]) => Number(b.id === entry?.id) - Number(a.id === entry?.id),
    )
    for (const [at, gist] of inOrder) {
      if (gist.status !== 'sin-muestra' || trace?.error) continue
      const fact = facts.find((candidate) => candidate.id === gist.id)
      if (!fact) continue
      const leads = fact.id === entry?.id
      const known = this.cache.get(fact)
      if (known) {
        gists[at] = { ...known, id: fact.id, ...(leads ? {} : { unused: true }) }
        if (leads) this.noteTrial(gists[at])
        continue
      }
      // Sin nada que recibir, su llamada no hay que inventarla.
      if (leads && fact.takes.length === 0) {
        const plain = await tested(program, fact, `${fact.name}()`, (code) =>
          this.traced(code, inputs ? { answers: inputs, seed } : undefined),
        )
        if (plain) {
          gists[at] = plain
          this.noteTrial(plain)
          continue
        }
      }
      if (!provider || (!leads && invented >= MAX_INVENTED)) continue
      if (!leads) invented++
      const tried = await invent(program, fact, {
        provider,
        trace: async (code) =>
          (await this.port.trace(code, inputs, seed)) ?? {
            events: [],
            truncated: false,
            error: null,
            output: '',
          },
      })
      this.cache.set(tried)
      if (leads) this.noteTrial(tried)
      // Nadie la llamaba (y no es por donde arranca el programa): se dice, es un dato del programa.
      gists[at] = leads ? tried : { ...tried, unused: true }
    }
    // Casi siempre hay una regla o ninguna. Si la muestra confirma varias, el JEV dice cuál es la intención.
    for (const [at, gist] of gists.entries()) {
      const fact = facts.find((candidate) => candidate.id === gist.id)
      if (!fact || !gist.sample) continue
      const rules = verifiedRules(fact.code, gist.sample)
      if (rules.length < 2) continue
      try {
        const rule = await pickRule(this.port.decider(), fact, rules)
        if (rule) gists[at] = { ...gist, rule }
      } catch {
        // Sin respuesta queda la más concreta, que también es verdad.
      }
    }
    // Una mezcla de dos padres que se parecen no deja ver de quién viene cada cosa: se vuelve a ejecutar con
    // datos que se distinguen (una vez por función, mientras no cambie su texto).
    for (const [at, gist] of gists.entries()) {
      if (gist.rule?.kind !== 'mix' || trace?.error) continue
      const fact = facts.find((candidate) => candidate.id === gist.id)
      if (!fact) continue
      const key = `${fact.owner ?? ''}.${fact.name}:${fact.hash}`
      let tracer = this.tracers.get(key)
      if (tracer === undefined) {
        try {
          tracer = await mixTracer(program, fact, gist, (code) =>
            this.traced(code, inputs ? { answers: inputs, seed } : undefined),
          )
        } catch {
          tracer = null
        }
        this.tracers.set(key, tracer)
      }
      if (tracer) gists[at] = { ...gist, tracer }
    }
    return gists
  }
}
