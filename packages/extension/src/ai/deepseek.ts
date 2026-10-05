import { AiUnavailableError, type AiProvider, type AiRequest } from './provider.ts'
import { readEventStream } from './stream.ts'

/**
 * El proveedor de la API de DeepSeek (compatible con la de OpenAI: `chat/completions`). Como el de Anthropic:
 * la clave vive en `SecretStorage` (la pone el host), aquí solo se usa, y `fetchImpl` es inyectable para
 * probarlo sin red.
 */

export interface DeepseekOptions {
  apiKey: string
  model?: string
  /**
   * Dejar que el modelo razone antes de contestar. En la API viene activado por defecto; aquí, apagado:
   * Prysel hace muchas consultas pequeñas (una frase, un trozo de código) y razonar cada una las hace
   * lentas y les come el cupo de la respuesta. Se enciende con el ajuste `prysel.deepseekThinking`.
   */
  thinking?: boolean
  fetchImpl?: typeof fetch
}

export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'

/**
 * El modelo de DeepSeek por defecto; el ajuste `prysel.deepseekModel` lo cambia. Los nombres son los de su
 * documentación (api-docs.deepseek.com, consultada en octubre de 2026): `deepseek-flash` y `deepseek-v4-pro`.
 * Cambian con el tiempo: por eso el modelo es un ajuste, y se puede escribir a mano.
 */
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash'
/** Los que se ofrecen en el selector. */
export const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const

/**
 * El cupo mínimo de una respuesta. Los modelos de DeepSeek que **razonan antes de contestar** gastan su cupo
 * (`max_tokens`) también en ese razonamiento, que no forma parte del texto: con un cupo pequeño (el que
 * bastaría para «una frase») se lo comen entero pensando y devuelven el texto vacío. El cupo es un tope,
 * no un gasto: pedir más no cuesta si no se usa.
 */
export const MIN_DEEPSEEK_TOKENS = 2000
/** Y si aun así se quedó sin cupo antes de escribir nada, se repite una vez con este. */
export const RETRY_DEEPSEEK_TOKENS = 8000

interface DeepseekResponse {
  choices?: {
    message?: { content?: string | null; reasoning_content?: string | null }
    finish_reason?: string | null
  }[]
  error?: { message?: string }
}

interface StreamEvent {
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null }
    finish_reason?: string | null
  }[]
}

export function deepseekProvider(options: DeepseekOptions): AiProvider {
  const fetchImpl = options.fetchImpl ?? fetch
  const model = options.model?.trim() || DEFAULT_DEEPSEEK_MODEL
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${options.apiKey}`,
  }
  const bodyOf = ({ system, prompt }: AiRequest, tokens: number, stream: boolean) =>
    JSON.stringify({
      model,
      max_tokens: tokens,
      stream,
      thinking: { type: options.thinking ? 'enabled' : 'disabled' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    })
  const budget = (request: AiRequest) => Math.max(request.maxTokens ?? 4000, MIN_DEEPSEEK_TOKENS)
  const refused = async (response: Response) => {
    const data = (await response.json().catch(() => null)) as DeepseekResponse | null
    return new AiUnavailableError(
      `DeepSeek respondió ${response.status}${data?.error?.message ? `: ${data.error.message}` : ''}`,
    )
  }
  /** Por qué vino vacío, dicho de forma que se entienda al verlo en la pestaña «Consultas». */
  const empty = (thought: boolean, reason: string | null | undefined) =>
    new AiUnavailableError(
      thought || reason === 'length'
        ? 'DeepSeek gastó todo el cupo de la respuesta razonando y no llegó a escribir el texto.'
        : `DeepSeek no devolvió ningún texto${reason ? ` (terminó por «${reason}»)` : ''}.`,
    )

  const once = async (request: AiRequest, tokens: number) => {
    const response = await fetchImpl(DEEPSEEK_URL, {
      method: 'POST',
      headers,
      body: bodyOf(request, tokens, false),
    })
    if (!response.ok) throw await refused(response)
    const data = (await response.json().catch(() => null)) as DeepseekResponse | null
    const choice = data?.choices?.[0]
    return {
      text: choice?.message?.content ?? '',
      thought: (choice?.message?.reasoning_content ?? '') !== '',
      reason: choice?.finish_reason,
    }
  }

  return {
    id: `deepseek:${model}`,
    async stream(request, onText, signal) {
      const run = async (tokens: number) => {
        const response = await fetchImpl(DEEPSEEK_URL, {
          method: 'POST',
          headers,
          body: bodyOf(request, tokens, true),
          ...(signal ? { signal } : {}),
        })
        if (!response.ok) throw await refused(response)
        const seen = { thought: false, reason: null as string | null }
        const text = await readEventStream(
          response,
          (event) => {
            const choice = (event as StreamEvent).choices?.[0]
            if (choice?.delta?.reasoning_content) seen.thought = true
            if (choice?.finish_reason) seen.reason = choice.finish_reason
            return choice?.delta?.content ?? undefined
          },
          onText,
          signal,
        )
        return { text, ...seen }
      }
      const first = await run(budget(request))
      if (first.text !== '' || signal?.aborted) return first.text
      // Se quedó sin cupo pensando: otra vez, con más. (No se había entregado nada todavía.)
      if (first.thought || first.reason === 'length') {
        const second = await run(RETRY_DEEPSEEK_TOKENS)
        if (second.text !== '' || signal?.aborted) return second.text
        throw empty(second.thought, second.reason)
      }
      throw empty(first.thought, first.reason)
    },
    async generate(request) {
      const first = await once(request, budget(request))
      if (first.text !== '') return first.text
      if (first.thought || first.reason === 'length') {
        const second = await once(request, RETRY_DEEPSEEK_TOKENS)
        if (second.text !== '') return second.text
        throw empty(second.thought, second.reason)
      }
      throw empty(first.thought, first.reason)
    },
  }
}
