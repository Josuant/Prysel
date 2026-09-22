import { AiUnavailableError, type AiProvider } from './provider.ts'

/**
 * El proveedor de la API de Anthropic: la clave vive en `SecretStorage` (la pone el host), aquí solo se usa.
 * `fetchImpl` es inyectable para poder probar esto sin red de verdad.
 */

export interface AnthropicOptions {
  apiKey: string
  model?: string
  fetchImpl?: typeof fetch
}

/**
 * Un modelo razonable por defecto; el ajuste `prysel.anthropicModel` lo cambia si la cuenta del usuario
 * tiene acceso a otro. La API de Anthropic cambia estos nombres con el tiempo: no hay uno que valga siempre.
 */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929'

interface AnthropicResponse {
  content?: { type: string; text?: string }[]
  error?: { message?: string }
}

export function anthropicProvider(options: AnthropicOptions): AiProvider {
  const fetchImpl = options.fetchImpl ?? fetch
  const model = options.model?.trim() || DEFAULT_ANTHROPIC_MODEL
  return {
    id: `anthropic:${model}`,
    async generate({ system, prompt, maxTokens }) {
      const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': options.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens ?? 4000,
          system,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      const data = (await response.json().catch(() => null)) as AnthropicResponse | null
      if (!response.ok) {
        throw new AiUnavailableError(
          `Anthropic respondió ${response.status}${data?.error?.message ? `: ${data.error.message}` : ''}`,
        )
      }
      const text = (data?.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
      if (text === '') throw new AiUnavailableError('Anthropic no devolvió ningún texto.')
      return text
    },
  }
}
