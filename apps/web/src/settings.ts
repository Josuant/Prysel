import { anthropicProvider } from '../../../packages/extension/src/ai/anthropic.ts'
import type { AiProvider } from '../../../packages/extension/src/ai/provider.ts'
import { typesafeDecider, type Decider } from '../../../packages/extension/src/jev/client.ts'
import { localDecider } from '../../../packages/extension/src/jev/local.ts'

/**
 * Con qué IA trabaja la web. Las claves son del usuario y se quedan en este navegador (`localStorage`):
 * no hay servidor de Prysel por medio, la página llama directamente a cada API.
 */

export interface AiSettings {
  /** Clave de la API de Anthropic: la IA que redacta (código, explicaciones, lecciones). */
  anthropicKey: string
  anthropicModel: string
  /** Clave de TypeSafe: el motor JEV que decide. Sin ella decide el motor local (sin red). */
  typesafeKey: string
}

export const ANTHROPIC_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 · el más capaz' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 · rápido y capaz' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 · el más rápido' },
] as const

const DEFAULTS: AiSettings = {
  anthropicKey: '',
  anthropicModel: 'claude-opus-5-5',
  typesafeKey: '',
}

const KEY = 'prysel.web.ai'

export function loadSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<AiSettings>
    const text = (value: unknown, fallback: string) =>
      typeof value === 'string' ? value : fallback
    return {
      anthropicKey: text(parsed.anthropicKey, ''),
      anthropicModel:
        text(parsed.anthropicModel, DEFAULTS.anthropicModel) || DEFAULTS.anthropicModel,
      typesafeKey: text(parsed.typesafeKey, ''),
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(settings: AiSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    // Sin almacenamiento (modo privado): vale para esta visita.
  }
}

/** La API de Anthropic solo acepta llamadas desde una página si se pide explícitamente. */
const browserFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string>),
      'anthropic-dangerous-direct-browser-access': 'true',
    },
  })

export function providerFrom(settings: AiSettings): AiProvider | null {
  const key = settings.anthropicKey.trim()
  if (!key) return null
  return anthropicProvider({ apiKey: key, model: settings.anthropicModel, fetchImpl: browserFetch })
}

export function deciderFrom(settings: AiSettings): Decider {
  const key = settings.typesafeKey.trim()
  return key ? typesafeDecider({ apiKey: key }) : localDecider()
}
