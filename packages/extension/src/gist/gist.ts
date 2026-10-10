import type { Program } from '@prysel/python'
import type { AiProvider } from '../ai/provider.ts'
import { indexOf, stateAt, type Trace, type TraceIndex } from '../trace.ts'
import { functionsIn, reaches, type Facts } from './facts.ts'
import { bestLaps, loopsIn, type Laps } from './laps.ts'
import { bestNet, triesIn, type Net } from './net.ts'
import { bestLife, classesIn, type Life } from './blueprint.ts'
import { bestSwitch, conditionsIn, type Switch } from './branch.ts'
import { tracerCall, verifiedMechanisms, type MixRule } from './mechanisms.ts'
import { ruleFor, ruleTells, type Rule } from './patterns.ts'
import { bestSample, rankSamples, samplesIn, withRolls, type Sample } from './sample.ts'
import { parseCall } from './value.ts'
import type { Idleness } from './entry.ts'
import type { Story } from './story.ts'

/**
 * «Qué hace» una función, comprobado: su nombre, y una vez que se ejecutó de verdad (con qué entró y qué
 * salió). Es lo que deja revisar lo que escribió una IA sin leer el código. La IA solo puede proponer con qué
 * probarla; lo que sale lo dice el programa al ejecutarse.
 */
export type GistStatus =
  /** Hay una muestra ejecutada. */
  | 'ok'
  /** Nadie la llama y no se ha podido probar. */
  | 'sin-muestra'
  /** No se ejecuta sola: pide datos por teclado, o tiene con qué tocar el equipo. */
  | 'no-ejecutable'

export interface Gist {
  /** El id del nodo de la función. */
  id: string
  name: string
  owner: string | null
  /** El texto de la función cuando se calculó: si cambia, esto ya no vale. */
  hash: string
  /** Lo que el código dice que hace, si lo dice. */
  title: string | null
  status: GistStatus
  sample: Sample | null
  /** Su regla («si es 1, un asterisco; si no, un punto»), cuando la tiene y la muestra la confirma. */
  rule?: Rule
  /** El programa nunca la llama: su muestra es una prueba aparte, con un ejemplo. */
  unused?: boolean
  /**
   * Su mezcla, vuelta a ver con **datos trazadores**: otra llamada, con dos entradas que se distinguen del
   * todo, donde cada posición del resultado dice de quién viene (en la muestra, los padres se parecían).
   */
  tracer?: MixRule
  /** Con otro estado que `ok`: por qué no hay muestra. */
  why?: string
  /** Qué bloque es: una función (por defecto), un bucle, un `try` o una clase. */
  block?: 'function' | 'loop' | 'try' | 'class' | 'condition'
  /** En un bucle: sus vueltas, tal como se ejecutaron. */
  laps?: Laps
  /** En un `try`: qué se intentó, si saltó un error y qué red lo atrapó. */
  net?: Net
  /** En una clase: la vida de uno de sus objetos, llamada a llamada. */
  life?: Life
  /** En un `if`: por qué rama siguió cada vez, y con qué valores. */
  branches?: Switch
}

/** Si el programa pide datos por teclado. */
export function asksInput(source: string): boolean {
  const bare = source.replace(/"[^"\n]*"|'[^'\n]*'/g, '""').replace(/#.*$/gm, '')
  return /\binput\s*\(/.test(bare)
}

/**
 * Por qué un programa no se ejecuta solo para sacar muestras; `null` si se puede. `scripted`: hay respuestas
 * de teclado de ejemplo, así que pedir datos ya no lo impide.
 */
export function unrunnable(source: string, scripted = false): string | null {
  if (!scripted && asksInput(source)) return 'Pide datos por teclado.'
  if (reaches(source)) return 'Puede tocar archivos, la red o el sistema.'
  return null
}

/** Entre cuántas de las veces que se ejecutó se busca la que mejor la enseña. */
const MAX_SHOWN = 16

/**
 * De las veces que la función se ejecutó, la que mejor cuenta lo que hace: la de siempre (la que pisa más
 * líneas sin ser larga), salvo que otra deje ver más de su regla. Una mutación que esa vez no cambió nada, o
 * un cruce de dos padres iguales, son verdad pero no enseñan: si otra vez sí se vio, se enseña esa.
 */
function showing(facts: Facts, samples: readonly Sample[]): Sample | null {
  const ranked = rankSamples(samples)
  let best = ranked[0]
  if (!best) return null
  let top = ruleTells(ruleFor(facts.code, best))
  for (const sample of ranked.slice(1, MAX_SHOWN)) {
    if (sample.error !== undefined) continue
    const tells = ruleTells(ruleFor(facts.code, sample))
    if (tells > top) {
      best = sample
      top = tells
    }
  }
  return withRolls(best, samples)
}

/**
 * La mezcla de una función, vuelta a ver con datos trazadores (ver `tracerCall`): se ejecuta esa otra llamada
 * de verdad y, si ahí cada posición del resultado dice de qué entrada viene, eso es lo que se devuelve.
 * `null` si no hace falta, no se puede, o tampoco así se deja ver.
 */
export async function mixTracer(
  program: Program,
  facts: Facts,
  gist: Gist,
  run: (code: string) => Promise<Trace>,
): Promise<MixRule | null> {
  if (gist.rule?.kind !== 'mix' || !gist.sample || facts.owner !== null) return null
  const call = tracerCall(facts.name, gist.sample, gist.rule)
  const valid = call === null ? null : validCall(call, facts)
  if (valid === null) return null
  const { sample } = await sampleOfCall(program, facts, valid, run)
  if (!sample) return null
  const found = verifiedMechanisms(facts.code, sample).find(
    (rule): rule is MixRule => rule.kind === 'mix',
  )
  return found && !found.from.includes('both') ? found : null
}

/** La función con su muestra y, si la muestra la confirma, su regla. */
const proven = (facts: Facts, sample: Sample): Gist => {
  const rule = ruleFor(facts.code, sample)
  return { ...base(facts), status: 'ok', sample, ...(rule ? { rule } : {}) }
}

const base = (facts: Facts): Omit<Gist, 'status' | 'sample'> => ({
  id: facts.id,
  name: facts.name,
  owner: facts.owner,
  hash: facts.hash,
  title: facts.note,
})

/**
 * Lo que se sabe de cada función con la traza del programa tal como está (`null`: no se ha ejecutado). Las
 * que el programa ya llama salen con su muestra; las demás quedan pendientes de que se les proponga una.
 */
export function gistsOf(program: Program, trace: Trace | null, scripted = false): Gist[] {
  const blocked = unrunnable(program.source, scripted)
  const index = trace ? indexOf(trace) : null
  const functions = functionsIn(program).map((facts): Gist => {
    const sample = trace && index ? showing(facts, samplesIn(trace, facts, { index })) : null
    if (sample) return proven(facts, sample)
    if (blocked !== null)
      return { ...base(facts), status: 'no-ejecutable', sample: null, why: blocked }
    const why = trace?.error ? `${trace.error.name}: ${trace.error.message}` : 'Nadie la llama.'
    return { ...base(facts), status: 'sin-muestra', sample: null, why }
  })
  return [
    ...functions,
    ...loopGists(program, trace, index),
    ...tryGists(program, trace, index),
    ...classGists(program, trace, index),
    ...conditionGists(program, trace, index),
  ]
}

/**
 * Los bucles que llegaron a dar alguna vuelta, con la ejecución que mejor los enseña. Los que no se
 * ejecutaron no llevan tarjeta: se ven como siempre, con su diagrama.
 */
function loopGists(program: Program, trace: Trace | null, index: TraceIndex | null): Gist[] {
  if (!trace || !index) return []
  return loopsIn(program).flatMap((facts) => {
    const laps = bestLaps(trace, facts, index)
    if (!laps) return []
    return [
      {
        id: facts.id,
        name: facts.head,
        owner: null,
        hash: facts.hash,
        title: null,
        status: 'ok' as const,
        sample: null,
        block: 'loop' as const,
        laps,
      },
    ]
  })
}

/**
 * Los `try` en los que llegó a entrar la ejecución, con la vez que mejor los enseña (la que cae en la red,
 * si alguna cayó). Los que no se ejecutaron se ven como siempre, con su diagrama.
 */
function tryGists(program: Program, trace: Trace | null, index: TraceIndex | null): Gist[] {
  if (!trace || !index) return []
  return triesIn(program).flatMap((facts) => {
    const net = bestNet(trace, facts, index)
    if (!net) return []
    const handlers = facts.clauses
      .filter((clause) => clause.kind === 'except')
      .map((clause) => clause.head.replace(/\s+as\s+\w+$/, ''))
    return [
      {
        id: facts.id,
        name: handlers.length > 0 ? `try · ${handlers.join(' · ')}` : 'try',
        owner: null,
        hash: facts.hash,
        title: null,
        status: 'ok' as const,
        sample: null,
        block: 'try' as const,
        net,
      },
    ]
  })
}

/**
 * Las clases de las que algún objeto recibió llamadas, con la vida del que más se usó. Las que no se usaron se
 * ven como siempre, con su diagrama.
 */
function classGists(program: Program, trace: Trace | null, index: TraceIndex | null): Gist[] {
  if (!trace || !index) return []
  return classesIn(program).flatMap((facts) => {
    const life = bestLife(trace, facts, index)
    if (!life) return []
    return [
      {
        id: facts.id,
        name: facts.name,
        owner: null,
        hash: facts.hash,
        title: null,
        status: 'ok' as const,
        sample: null,
        block: 'class' as const,
        life,
      },
    ]
  })
}

/** Los `if` a los que llegó la ejecución, con cada visita. Los que no se ejecutaron, con su diagrama. */
function conditionGists(program: Program, trace: Trace | null, index: TraceIndex | null): Gist[] {
  if (!trace || !index) return []
  return conditionsIn(program).flatMap((facts) => {
    const branches = bestSwitch(trace, facts, index)
    if (!branches) return []
    return [
      {
        id: facts.id,
        name: facts.arms[0]?.head ?? 'if',
        owner: null,
        hash: facts.hash,
        title: null,
        status: 'ok' as const,
        sample: null,
        block: 'condition' as const,
        branches,
      },
    ]
  })
}

// ─── El programa entero, ejecutado ────────────────────────────────────────────────────────────────

/**
 * Cómo le fue al programa al ejecutarlo: lo que salió por pantalla y cómo acabó. Es lo primero que quiere ver
 * quien lo está construyendo: que funciona, y qué hace.
 */
export interface RunSummary {
  /** Lo que se vio en la pantalla (lo último, si es mucho). Con respuestas de ejemplo, también lo tecleado. */
  output: string
  /**
   * `done`: acabó. `waiting`: se quedó pidiendo otro dato (se acabaron las respuestas de ejemplo). `cut`: era
   * demasiado largo y se cortó. `error`: falló. `blocked`: no se ejecutó. `idle`: acabó sin error, pero sin
   * hacer nada que se vea (ver `idle`).
   */
  ended: 'done' | 'waiting' | 'cut' | 'error' | 'blocked' | 'idle'
  /**
   * Con `idle`, por qué: `inert`, define cosas pero nadie las arranca; `mute`, trabaja pero no enseña nada.
   */
  idle?: Idleness
  /** Con `inert`: la función que lo pondría en marcha, si se sabe cuál es. */
  entry?: string
  /**
   * Con `inert`: esa función, probada aparte con una llamada de ejemplo (sin tocar el programa). Lo que
   * devolvió y lo que imprimió, tal como salió.
   */
  trial?: { call: string; returned?: string; printed?: string }
  /**
   * Si lo lleva un bucle: qué pasa en cada vuelta y en qué orden, qué se hizo antes, y qué viaja de un paso a
   * otro. Sale de la traza (ver `story.ts`); es lo que hace que el diagrama cuente cómo funciona.
   */
  story?: Story
  /**
   * La línea del programa donde empieza el trabajo: la primera, a la altura del archivo, que llama a una
   * función propia. Es donde el diagrama marca «empieza aquí».
   */
  start?: number
  /**
   * Lo que se usó de verdad al ejecutarlo: cuántas veces se entró en cada función (por la línea de su `def`)
   * y qué líneas del programa (fuera de toda función) se pisaron. `partial`: se dejó de grabar antes de que
   * acabara, así que son «al menos» (y lo que no aparece puede haberse usado después).
   */
  usage?: Usage
  /** Con `error`: cuál, y en qué línea. Con `blocked`: por qué. */
  problem?: string
  line?: number
  /** Las respuestas de teclado que se le dieron, en orden (si pide datos). */
  typed?: string[]
  /** Esas respuestas las tecleó quien lo usa (está jugando el programa): no son las de ejemplo. */
  mine?: boolean
  /** El programa pide datos por teclado: se puede jugar escribiendo las respuestas. */
  asks?: boolean
  /**
   * De dónde salió cada línea de `output`: la línea del programa que se estaba ejecutando cuando se escribió
   * (`null` si no se sabe). Es lo que une la pantalla con el diagrama: pinchar una línea lleva a su paso.
   */
  sources?: (number | null)[]
}

/**
 * Qué línea del programa escribió cada línea de la salida. Lo impreso viaja en el evento siguiente al que lo
 * produjo, así que es de la línea que se estaba ejecutando justo antes.
 */
export function outputSources(trace: Trace): (number | null)[] {
  const sources: (number | null)[] = []
  let running: number | null = null
  let fresh = true
  for (const event of trace.events) {
    for (const char of event.o ?? '') {
      if (fresh) sources.push(running)
      fresh = char === '\n'
    }
    if (event.k === 'line' || event.k === 'call') running = event.l
  }
  return sources
}

/** El resumen de una ejecución, a partir de su traza. */
export interface Usage {
  calls: Record<number, number>
  lines: number[]
  partial?: boolean
}

/** Lo que se usó al ejecutar el programa: ver `RunSummary.usage`. */
export function usageOf(trace: Trace): Usage {
  const calls: Record<number, number> = {}
  const lines = new Set<number>()
  for (const event of trace.events) {
    if (event.k === 'call') calls[event.l] = (calls[event.l] ?? 0) + 1
    else if (event.k === 'line' && event.f === 0) lines.add(event.l)
  }
  return {
    calls,
    lines: [...lines].sort((a, b) => a - b),
    ...(trace.truncated ? { partial: true } : {}),
  }
}

export function runSummary(trace: Trace, typed?: readonly string[], mine = false): RunSummary {
  const waiting = trace.error?.name === 'NoMoreInput'
  const failed = trace.error !== null && !waiting
  return {
    output: trace.output,
    ended: failed
      ? 'error'
      : waiting
        ? 'waiting'
        : trace.truncated && trace.finished !== true
          ? 'cut'
          : 'done',
    ...(failed && trace.error
      ? {
          problem: `${trace.error.name}: ${trace.error.message}`,
          ...(trace.error.line !== null ? { line: trace.error.line } : {}),
        }
      : {}),
    ...(typed ? { typed: [...typed], asks: true } : {}),
    ...(mine ? { mine: true } : {}),
    ...startOf(trace),
    sources: alignedSources(trace),
    usage: usageOf(trace),
  }
}

/** Dónde empieza el trabajo: la línea de arriba que se estaba ejecutando cuando se llamó a la primera función. */
function startOf(trace: Trace): { start?: number } {
  let top: number | null = null
  for (const event of trace.events) {
    if (event.k === 'line' && event.d === 0) top = event.l
    if (event.k === 'call') return top === null ? {} : { start: top }
  }
  return {}
}

/** Las fuentes de las líneas de `trace.output` (que puede ser solo el final de todo lo impreso). */
function alignedSources(trace: Trace): (number | null)[] {
  const all = outputSources(trace)
  const shown = trace.output.replace(/\n$/, '').split('\n').length
  return all.slice(Math.max(0, all.length - shown))
}

/** La traza, sin contar como fallo que se acabaran las respuestas de ejemplo: el programa iba bien. */
export function settled(trace: Trace): Trace {
  return trace.error?.name === 'NoMoreInput' ? { ...trace, error: null } : trace
}

export function answersSystem(): string {
  return [
    'Eres parte de una herramienta que enseña cómo funciona un programa de Python ejecutándolo.',
    'El programa pide datos por teclado. Escribe lo que teclearía una persona en UNA sesión de ejemplo, corta y',
    'representativa: en el orden en que el programa lo va a pedir, una respuesta por cada vez que pregunte.',
    'Reglas:',
    '- Entre 1 y 12 respuestas. Que la sesión llegue al final del programa si se puede.',
    '- Si pregunta si se quiere seguir o repetir, contesta que no cuando toque, para que termine.',
    '- Si hay que acertar algo que el programa elige al azar, prueba valores razonables y distintos.',
    '- Respuestas realistas y cortas: lo que se teclea, sin comillas de más.',
    'Devuelve SOLO un array JSON de textos, por ejemplo: ["50", "75", "n"].',
  ].join('\n')
}

/** Las respuestas de teclado propuestas, si de verdad son una lista corta de textos; `null` si no. */
export function validAnswers(answer: string): string[] | null {
  const found = /\[[\s\S]*\]/.exec(answer.replace(/```\w*/g, ''))?.[0]
  if (!found) return null
  try {
    const parsed: unknown = JSON.parse(found)
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    const texts = parsed
      .filter(
        (item): item is string | number => typeof item === 'string' || typeof item === 'number',
      )
      .map((item) =>
        String(item)
          .replace(/[\r\n]+/g, ' ')
          .slice(0, 60),
      )
    return texts.length === parsed.length ? texts.slice(0, 12) : null
  } catch {
    return null
  }
}

/** Le pide a la IA las respuestas de teclado de una sesión de ejemplo. `null` si no las dio bien. */
export async function proposeAnswers(
  provider: AiProvider,
  source: string,
): Promise<string[] | null> {
  try {
    const answer = await provider.generate({
      system: answersSystem(),
      prompt: `El programa:\n\n${source.trimEnd()}\n\nEscribe las respuestas de teclado de la sesión de ejemplo.`,
      maxTokens: 300,
    })
    return validAnswers(answer)
  } catch {
    return null
  }
}

/**
 * Sigue una sesión de ejemplo que se quedó a medias: la IA ve lo que ha salido por pantalla hasta ahora (lo
 * que el programa contestó a cada cosa) y dice qué teclearía a continuación. Así una partida de adivinar un
 * número va hacia el número, en vez de probar a ciegas. `null` si no dio nada que añadir.
 */
export async function continueAnswers(
  provider: AiProvider,
  source: string,
  typed: readonly string[],
  output: string,
  values: Readonly<Record<string, string>> = {},
): Promise<string[] | null> {
  try {
    const answer = await provider.generate({
      system: [
        answersSystem(),
        '',
        'Ahora la sesión ya ha empezado: te doy lo que se ha visto en la pantalla hasta este momento (las',
        'preguntas del programa, lo que se tecleó y lo que contestó). El programa está esperando otra respuesta.',
        'Lee lo que ha ido contestando y sigue con sentido: si te dice «más alto» o «más bajo», hazle caso.',
        'También te doy lo que valen ahora las variables del programa. Si guarda algo que hay que acertar (un',
        'número secreto, una palabra), úsalo para que la sesión acabe bien: acércate con sentido en una o dos',
        'respuestas más y acierta. Es una demostración: tiene que verse cómo termina.',
        'Devuelve SOLO un array JSON con las respuestas SIGUIENTES (no repitas las ya tecleadas), las justas',
        'para que la sesión llegue a su final.',
      ].join('\n'),
      prompt: `El programa:\n\n${source.trimEnd()}\n\nYa tecleado: ${JSON.stringify(typed)}\n\nLas variables ahora: ${JSON.stringify(values)}\n\nLa pantalla hasta ahora:\n${output.slice(-1500)}`,
      maxTokens: 300,
    })
    return validAnswers(answer)
  } catch {
    return null
  }
}

/** Lo que valen, al acabar la traza, las variables sueltas del programa (números, textos cortos). */
export function finalValues(trace: Trace): Record<string, string> {
  const index = indexOf(trace)
  const locals = stateAt(index, trace.events.length - 1).frames[0]?.locals ?? {}
  return Object.fromEntries(
    Object.entries(locals)
      .filter(([, value]) => ['number', 'string', 'boolean'].includes(typeof value))
      .map(([name, value]) => [name, String(value).slice(0, 40)] as const)
      .slice(0, 12),
  )
}

/** Cuántas veces se le pide a la IA que siga una sesión de ejemplo, y cuántas respuestas caben en total. */
export const ANSWER_ROUNDS = 3
export const MAX_ANSWERS = 24

/**
 * Lo que identifica lo que el programa pregunta por teclado: sus `input(…)`, tal como están escritos. Mientras
 * no cambien, valen las mismas respuestas de ejemplo (aunque cambie el resto del programa).
 */
export function inputSignature(source: string): string {
  return [...source.matchAll(/\binput\s*\(([^)\n]*)\)/g)].map((match) => match[1] ?? '').join('|')
}

// ─── Proponer con qué probarla ────────────────────────────────────────────────────────────────────

/**
 * `launch`: la llamada no es para enseñar una pieza con un ejemplo mínimo, sino para **arrancar el programa
 * entero** y verlo funcionar: valores con los que le dé tiempo a llegar a un buen resultado.
 */
export function callSystem(launch = false): string {
  return [
    'Eres parte de una herramienta que enseña qué hace una función de Python ejecutándola con un ejemplo.',
    'Te doy un programa y el nombre de una función o método. Escribe UNA sola línea: una llamada de ejemplo.',
    'Reglas estrictas:',
    '- Para una función: nombre(argumentos). Para un método: Clase(argumentos).metodo(argumentos).',
    '- Los argumentos son solo literales: números, textos, True, False, None, listas, tuplas, diccionarios.',
    '- Nada de variables, ni otras llamadas, ni operaciones.',
    ...(launch
      ? [
          '- Esta función es la que pone en marcha el programa entero. Elige valores realistas, con los que',
          '  se vea que FUNCIONA: que le dé tiempo a llegar a un buen resultado (bastantes vueltas, una',
          '  población o unos datos suficientes), pero que acabe en un par de segundos como mucho.',
        ]
      : [
          '- El ejemplo es pequeño (una lista de 3 a 6 elementos, una rejilla de hasta 4×5) y variado: que pase',
          '  por todos los casos que la función distingue.',
        ]),
    'Responde solo con la llamada, sin comillas alrededor, sin explicación y sin bloque de código.',
  ].join('\n')
}

export function callPrompt(program: Program, facts: Facts): string {
  const what = facts.owner
    ? `el método «${facts.name}» de la clase «${facts.owner}»`
    : `la función «${facts.name}»`
  return `El programa:\n\n${program.source.trimEnd()}\n\nEscribe la llamada de ejemplo para ${what}.`
}

/**
 * La llamada propuesta, si de verdad es lo que se pidió: una sola llamada a esa función (o a ese método, sobre
 * un objeto recién creado de su clase) escrita solo con literales. Así, por sí misma, no puede hacer nada
 * que el programa no hiciera ya. `null` si no lo es.
 */
export function validCall(answer: string, facts: Facts): string | null {
  // Una sola línea (se le perdona el bloque de código alrededor): con dos, ya no es «una llamada».
  const rows = answer
    .replace(/```\w*/g, '')
    .split('\n')
    .map((row) => row.trim())
    .filter((row) => row !== '')
  const call = rows.length === 1 ? parseCall((rows[0] ?? '').replace(/^`|`$/g, '')) : null
  if (!call) return null
  if (facts.owner === null)
    return call.method === undefined && call.name === facts.name ? call.text : null
  return call.name === facts.owner && call.method === facts.name ? call.text : null
}

/** El programa con esa llamada añadida al final, y la línea en la que queda. */
export function withCall(source: string, call: string): { code: string; line: number } {
  const body = source.trimEnd()
  const code = `${body}\n\n${call}\n`
  return { code, line: body.split('\n').length + 2 }
}

export interface GistPort {
  provider: AiProvider
  /** Ejecuta un programa entero grabando su traza. */
  trace(code: string): Promise<Trace>
}

/**
 * Prueba una función que el programa no llama: la IA propone una llamada, se comprueba que solo lleva
 * literales, y se ejecuta el programa con ella. La muestra es lo que pasó de verdad.
 */
export async function invent(program: Program, facts: Facts, port: GistPort): Promise<Gist> {
  const blocked = unrunnable(program.source)
  if (blocked !== null)
    return { ...base(facts), status: 'no-ejecutable', sample: null, why: blocked }
  const answer = await port.provider.generate({
    system: callSystem(),
    prompt: callPrompt(program, facts),
    maxTokens: 200,
  })
  const call = validCall(answer, facts)
  if (call === null)
    return {
      ...base(facts),
      status: 'sin-muestra',
      sample: null,
      why: 'No hubo un ejemplo válido.',
    }
  const { sample, why } = await sampleOfCall(program, facts, call, port.trace)
  if (!sample) return { ...base(facts), status: 'sin-muestra', sample: null, why }
  return proven(facts, sample)
}

/** Lo que pasó al ejecutar el programa con esa llamada añadida al final: la muestra, o por qué no la hay. */
async function sampleOfCall(
  program: Program,
  facts: Facts,
  call: string,
  run: (code: string) => Promise<Trace>,
): Promise<{ sample: Sample | null; why: string }> {
  const { code, line } = withCall(program.source, call)
  const trace = await run(code)
  // Solo vale lo que pasó desde la llamada añadida: lo de antes es del programa.
  const from = trace.events.findIndex(
    (event) => event.k === 'line' && event.d === 0 && event.l === line,
  )
  const sample = from < 0 ? null : bestSample(samplesIn(trace, facts, { from }))
  const why = trace.error
    ? `${trace.error.name}: ${trace.error.message}`
    : 'El ejemplo no llegó a ejecutarse.'
  return { sample: sample ? { ...sample, invented: true, call } : null, why }
}

/**
 * Probar una función con los datos de quien la usa: su llamada (solo literales, como las propuestas) se
 * ejecuta de verdad con el programa, y la tarjeta enseña lo que pasó. Si la llamada ni siquiera llega a
 * entrar en la función (le sobran o le faltan datos), la muestra es ese error: también es lo que pasó.
 * `null` si la llamada no es una llamada a esa función escrita con valores.
 */
export async function tested(
  program: Program,
  facts: Facts,
  call: string,
  run: (code: string) => Promise<Trace>,
): Promise<Gist | null> {
  const valid = validCall(call, facts)
  if (valid === null) return null
  const { sample, why } = await sampleOfCall(program, facts, valid, run)
  return proven(
    facts,
    sample
      ? { ...sample, tried: true }
      : { inputs: [], error: why, steps: 0, lines: 0, invented: true, call: valid, tried: true },
  )
}

/** Lo ya calculado, por el texto de cada función: mientras no cambie, no se vuelve a ejecutar ni a preguntar. */
export class GistCache {
  private readonly known = new Map<string, Gist>()

  get(facts: Pick<Facts, 'name' | 'owner' | 'hash'>): Gist | undefined {
    return this.known.get(`${facts.owner ?? ''}.${facts.name}:${facts.hash}`)
  }

  set(gist: Gist) {
    this.known.set(`${gist.owner ?? ''}.${gist.name}:${gist.hash}`, gist)
  }
}
