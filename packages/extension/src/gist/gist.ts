import type { Program } from '@prysel/python'
import type { AiProvider } from '../ai/provider.ts'
import { indexOf, type Trace } from '../trace.ts'
import { functionsIn, reaches, type Facts } from './facts.ts'
import { ruleFor, type Rule } from './patterns.ts'
import { bestSample, samplesIn, type Sample } from './sample.ts'
import { parseCall } from './value.ts'

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
  /** Con otro estado que `ok`: por qué no hay muestra. */
  why?: string
}

/** Por qué un programa no se ejecuta solo para sacar muestras; `null` si se puede. */
export function unrunnable(source: string): string | null {
  const bare = source.replace(/"[^"\n]*"|'[^'\n]*'/g, '""').replace(/#.*$/gm, '')
  if (/\binput\s*\(/.test(bare)) return 'Pide datos por teclado.'
  if (reaches(source)) return 'Puede tocar archivos, la red o el sistema.'
  return null
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
export function gistsOf(program: Program, trace: Trace | null): Gist[] {
  const blocked = unrunnable(program.source)
  const index = trace ? indexOf(trace) : null
  return functionsIn(program).map((facts) => {
    const sample = trace && index ? bestSample(samplesIn(trace, facts, { index })) : null
    if (sample) return proven(facts, sample)
    if (blocked !== null)
      return { ...base(facts), status: 'no-ejecutable', sample: null, why: blocked }
    const why = trace?.error ? `${trace.error.name}: ${trace.error.message}` : 'Nadie la llama.'
    return { ...base(facts), status: 'sin-muestra', sample: null, why }
  })
}

// ─── Proponer con qué probarla ────────────────────────────────────────────────────────────────────

export function callSystem(): string {
  return [
    'Eres parte de una herramienta que enseña qué hace una función de Python ejecutándola con un ejemplo.',
    'Te doy un programa y el nombre de una función o método. Escribe UNA sola línea: una llamada de ejemplo.',
    'Reglas estrictas:',
    '- Para una función: nombre(argumentos). Para un método: Clase(argumentos).metodo(argumentos).',
    '- Los argumentos son solo literales: números, textos, True, False, None, listas, tuplas, diccionarios.',
    '- Nada de variables, ni otras llamadas, ni operaciones.',
    '- El ejemplo es pequeño (una lista de 3 a 6 elementos, una rejilla de hasta 4×5) y variado: que pase',
    '  por todos los casos que la función distingue.',
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
  const { code, line } = withCall(program.source, call)
  const trace = await port.trace(code)
  // Solo vale lo que pasó desde la llamada añadida: lo de antes es del programa.
  const from = trace.events.findIndex(
    (event) => event.k === 'line' && event.d === 0 && event.l === line,
  )
  const sample = from < 0 ? null : bestSample(samplesIn(trace, facts, { from }))
  if (!sample) {
    const why = trace.error
      ? `${trace.error.name}: ${trace.error.message}`
      : 'El ejemplo no llegó a ejecutarse.'
    return { ...base(facts), status: 'sin-muestra', sample: null, why }
  }
  return proven(facts, { ...sample, invented: true, call })
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
