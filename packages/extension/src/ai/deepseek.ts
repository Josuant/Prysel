import { AiUnavailableError, type AiProvider } from './provider.ts'
import { readEventStream } from './stream.ts'

/**
 * El proveedor de la API de DeepSeek (compatible con la de OpenAI: `chat/completions`). Como el de Anthropic:
 * la clave vive en `SecretStorage` (la pone el host), aquí solo se usa, y `fetchImpl` es inyectable para
 * probarlo sin red.
 */

export interface DeepseekOptions {
  apiKey: string
  model?: string
  fetchImpl?: typeof fetch
}

export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'

/** El modelo de conversación de DeepSeek; el ajuste `prysel.deepseekModel` lo cambia (p. ej. `deepseek-reasoner`). */
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat'

interface DeepseekResponse {
  choices?: { message?: { content?: string | null } }[]
  error?: { message?: string }
}

export function deepseekProvider(options: DeepseekOptions): AiProvider {
  const fetchImpl = options.fetchImpl ?? fetch
  const model = options.model?.trim() || DEFAULT_DEEPSEEK_MODEL
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${options.apiKey}`,
  }
  return {
    id: `deepseek:${model}`,
    async stream({ system, prompt, maxTokens }, onText, signal) {
      const response = await fetchImpl(DEEPSEEK_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          max_tokens: maxTokens ?? 4000,
          stream: true,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        }),
        ...(signal ? { signal } : {}),
      })
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as DeepseekResponse | null
        throw new AiUnavailableError(
          `DeepSeek respondió ${response.status}${data?.error?.message ? `: ${data.error.message}` : ''}`,
        )
      }
      return readEventStream(
        response,
        (event) =>
          (event as { choices?: { delta?: { content?: string | null } }[] }).choices?.[0]?.delta
            ?.content ?? undefined,
        onText,
        signal,
      )
    },
    async generate({ system, prompt, maxTokens }) {
      const response = await fetchImpl(DEEPSEEK_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          max_tokens: maxTokens ?? 4000,
          stream: false,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        }),
      })
      const data = (await response.json().catch(() => null)) as DeepseekResponse | null
      if (!response.ok) {
        throw new AiUnavailableError(
          `DeepSeek respondió ${response.status}${data?.error?.message ? `: ${data.error.message}` : ''}`,
        )
      }
      const text = data?.choices?.[0]?.message?.content ?? ''
      if (text === '') throw new AiUnavailableError('DeepSeek no devolvió ningún texto.')
      return text
    },
  }
}
