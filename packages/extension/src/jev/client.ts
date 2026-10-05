/**
 * El cliente de Jev (TypeSafe AI): un modelo de **decisión**, no de texto. Se le manda un estado y unas
 * preguntas tipadas, y devuelve cada respuesta con su probabilidad. No escribe nada: elige entre lo que se
 * le ofrece. Es determinista (mismo estado y misma pregunta, misma respuesta) y contesta en décimas de
 * segundo, que es lo que permite ponerlo en el camino de cada orden (ver `docs/voz.md`).
 *
 * `fetchImpl` es inyectable: las pruebas nunca llaman a la red de verdad. La clave la guarda el anfitrión en
 * `SecretStorage`; aquí solo se usa.
 */

/** ¿Sí o no? Devuelve una probabilidad de 0 a 1. */
export interface NoulQuestion {
  type: 'noul'
  instructions: string
  criteria?: { true: string; false: string }
}

/** Elegir una opción de un conjunto cerrado (hasta 255): cada una, con lo que significa. */
export interface ChoiceQuestion {
  type: 'choice'
  instructions: string
  criteria: Record<string, string | null>
}

export type JevQuestion = NoulQuestion | ChoiceQuestion

export interface JevRequest {
  state: unknown
  questions: Record<string, JevQuestion>
}

export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }

export interface JevResponse {
  answers: Record<string, JevAnswer>
  /** Lo que tardó en contestar, en milisegundos: entra en el presupuesto de latencia de cada orden. */
  ms: number
}

/** Quien decide: Jev de verdad, o un decisor local con la misma forma (para las pruebas y sin red). */
export interface Decider {
  /** Un nombre corto para enseñar quién decidió (`jev-latest`, `local`). */
  readonly id: string
  decide(request: JevRequest): Promise<JevResponse>
}

/** Por qué no hubo decisión. El motivo decide qué se le dice al usuario. */
export type JevFailure = 'key' | 'request' | 'busy' | 'network' | 'timeout' | 'response'

export class JevError extends Error {
  constructor(
    readonly reason: JevFailure,
    message: string,
  ) {
    super(message)
  }
}

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
export const DEFAULT_JEV_MODEL = 'jev-latest'

/** Una pregunta admite como mucho estas opciones. */
export const MAX_CHOICES = 255

/**
 * Cuánto se espera a Jev antes de darlo por perdido. Contesta en 70–500 ms; pasado esto, la orden ya no
 * cumpliría su plazo y es mejor decirlo que dejar al usuario esperando.
 */
export const JEV_TIMEOUT_MS = 2500

/** Saturado o con el límite alcanzado (429, 529): se reintenta una vez, tras una pausa corta. */
const RETRY_AFTER_MS = 200

export interface TypesafeOptions {
  apiKey: string
  model?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

interface RawAnswer {
  type?: unknown
  noul?: unknown
  choice?: unknown
  confidence?: unknown
  probabilities?: unknown
}

const unit = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null

/** Lee una respuesta de Jev sin fiarse de su forma: lo que no se entiende, no se usa. */
export function parseAnswer(raw: unknown): JevAnswer | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { type, noul, choice, confidence, probabilities } = raw as RawAnswer
  if (type === 'noul') {
    const value = typeof noul === 'boolean' ? (noul ? 1 : 0) : unit(noul)
    return value === null ? null : { type: 'noul', noul: value }
  }
  if (type === 'choice') {
    if (typeof choice !== 'string') return null
    const table: Record<string, number> = {}
    if (typeof probabilities === 'object' && probabilities !== null) {
      for (const [option, p] of Object.entries(probabilities)) {
        const value = unit(p)
        if (value !== null) table[option] = value
      }
    }
    return {
      type: 'choice',
      choice,
      confidence: unit(confidence) ?? table[choice] ?? 0,
      probabilities: table,
    }
  }
  return null
}

function failureOf(status: number): JevFailure {
  if (status === 401 || status === 403) return 'key'
  if (status === 429 || status === 529) return 'busy'
  return 'request'
}

const MESSAGES: Record<JevFailure, string> = {
  key: 'TypeSafe no acepta la clave.',
  request: 'TypeSafe rechazó la petición.',
  busy: 'TypeSafe está saturado o se alcanzó el límite de peticiones.',
  network: 'No se pudo conectar con TypeSafe.',
  timeout: 'TypeSafe tardó demasiado en contestar.',
  response: 'TypeSafe contestó algo que no se entiende.',
}

export function typesafeDecider(options: TypesafeOptions): Decider {
  const fetchImpl = options.fetchImpl ?? fetch
  const model = options.model?.trim() || DEFAULT_JEV_MODEL
  const now = options.now ?? (() => performance.now())
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const timeoutMs = options.timeoutMs ?? JEV_TIMEOUT_MS

  const once = async (request: JevRequest): Promise<Record<string, JevAnswer>> => {
    const abort = new AbortController()
    const timer = setTimeout(() => {
      abort.abort()
    }, timeoutMs)
    let response: Response
    try {
      response = await fetchImpl(JEV_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ state: request.state, model, questions: request.questions }),
        signal: abort.signal,
      })
    } catch {
      throw abort.signal.aborted
        ? new JevError('timeout', MESSAGES.timeout)
        : new JevError('network', MESSAGES.network)
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      const reason = failureOf(response.status)
      throw new JevError(reason, `${MESSAGES[reason]} (${response.status})`)
    }
    const data = (await response.json().catch(() => null)) as { answers?: unknown } | null
    const raw = data?.answers
    if (typeof raw !== 'object' || raw === null) throw new JevError('response', MESSAGES.response)
    const answers: Record<string, JevAnswer> = {}
    for (const id of Object.keys(request.questions)) {
      const answer = parseAnswer((raw as Record<string, unknown>)[id])
      // Una respuesta de otro tipo que la pregunta no vale: no se interpreta a ciegas.
      if (!answer || answer.type !== request.questions[id]?.type) {
        throw new JevError('response', `${MESSAGES.response} (falta «${id}»)`)
      }
      answers[id] = answer
    }
    return answers
  }

  return {
    id: model,
    async decide(request) {
      const started = now()
      try {
        return { answers: await once(request), ms: Math.round(now() - started) }
      } catch (error) {
        if (!(error instanceof JevError) || error.reason !== 'busy') throw error
        await sleep(RETRY_AFTER_MS)
        return { answers: await once(request), ms: Math.round(now() - started) }
      }
    },
  }
}
