import type { Program } from '@prysel/python'
import type { AiProvider } from '../../../packages/extension/src/ai/provider.ts'
import { functionsIn } from '../../../packages/extension/src/gist/facts.ts'
import {
  GistCache,
  asksInput,
  gistsOf,
  inputSignature,
  invent,
  proposeAnswers,
  runSummary,
  settled,
  unrunnable,
  type Gist,
  type RunSummary,
} from '../../../packages/extension/src/gist/gist.ts'
import { loopsIn } from '../../../packages/extension/src/gist/laps.ts'
import { triesIn } from '../../../packages/extension/src/gist/net.ts'
import { classesIn } from '../../../packages/extension/src/gist/blueprint.ts'
import { conditionsIn } from '../../../packages/extension/src/gist/branch.ts'
import { pickRule, verifiedRules } from '../../../packages/extension/src/gist/patterns.ts'
import type { Decider } from '../../../packages/extension/src/jev/client.ts'
import type { Trace } from '../../../packages/extension/src/trace.ts'

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
  trace(code: string, inputs?: readonly string[]): Promise<Trace | null>
  provider(): AiProvider | null
  /** Quien elige entre varias reglas que la muestra confirma por igual. */
  decider(): Decider
  /** Hay una orden construyendo o una consulta en marcha: se espera a que acabe. */
  busy(): boolean
  post(gists: Gist[], version: number, run: RunSummary | null): void
}

/** Lo que se espera, con el código quieto, antes de ejecutarlo. */
const CALM_MS = 900
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

  /** El código cambió (o algo acabó): se vuelve a mirar cuando haya calma. */
  touch() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.pass()
    }, CALM_MS)
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
    if (asksInput(text)) {
      const key = inputSignature(text)
      inputs = this.answers.get(key)
      if (!inputs && provider) {
        const proposed = await proposeAnswers(provider, text)
        if (proposed) {
          inputs = proposed
          this.answers.set(key, proposed)
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
        problem: !waiting
          ? blocked
          : provider
            ? 'Pide datos por teclado, y la IA no propuso respuestas de ejemplo.'
            : 'Pide datos por teclado. Conecta la IA para verlo funcionar con respuestas de ejemplo.',
      }
      return gistsOf(program, null)
    }
    const raw = await this.port.trace(text, inputs)
    if (raw) this.ran = runSummary(raw, inputs)
    const trace = raw ? settled(raw) : null
    const nothing =
      facts.length === 0 &&
      loopsIn(program).length === 0 &&
      triesIn(program).length === 0 &&
      classesIn(program).length === 0 &&
      conditionsIn(program).length === 0
    if (nothing) return []
    const gists = gistsOf(program, trace, inputs !== undefined)
    let invented = 0
    for (const [at, gist] of gists.entries()) {
      if (gist.status !== 'sin-muestra' || trace?.error) continue
      const fact = facts.find((candidate) => candidate.id === gist.id)
      if (!fact) continue
      const known = this.cache.get(fact)
      if (known) {
        gists[at] = { ...known, id: fact.id }
        continue
      }
      if (!provider || invented >= MAX_INVENTED) continue
      invented++
      const tried = await invent(program, fact, {
        provider,
        trace: async (code) =>
          (await this.port.trace(code, inputs)) ?? {
            events: [],
            truncated: false,
            error: null,
            output: '',
          },
      })
      this.cache.set(tried)
      gists[at] = tried
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
    return gists
  }
}
