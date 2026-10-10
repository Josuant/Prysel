import { anthropicProvider } from '../../../packages/extension/src/ai/anthropic.ts'
import {
  DEEPSEEK_MODELS,
  DEFAULT_DEEPSEEK_MODEL,
  deepseekProvider,
} from '../../../packages/extension/src/ai/deepseek.ts'
import type { AiProvider } from '../../../packages/extension/src/ai/provider.ts'
import {
  JevError,
  typesafeDecider,
  type Decider,
} from '../../../packages/extension/src/jev/client.ts'
import { localDecider } from '../../../packages/extension/src/jev/local.ts'

/**
 * Con qué IA trabaja la web. Las claves son del usuario y se quedan en este navegador (`localStorage`):
 * no hay servidor de Prysel por medio, la página llama directamente a cada API.
 */

export type AiVendor = 'anthropic' | 'deepseek'

export interface AiSettings {
  /** Qué IA redacta (código, explicaciones, lecciones). Si a esa le falta la clave, se usa la otra. */
  vendor: AiVendor
  anthropicKey: string
  anthropicModel: string
  deepseekKey: string
  deepseekModel: string
  /** Clave de TypeSafe: el motor JEV que decide. Sin ella decide el motor local (sin red). */
  typesafeKey: string
  /**
   * Un intermediario para llegar a TypeSafe desde el navegador (su API no admite llamadas desde páginas web):
   * la dirección de un Worker que reenvía la petición tal cual (ver `apps/web/proxy`). Vacío: directo.
   */
  jevProxy: string
}

export const ANTHROPIC_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 · el más capaz' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 · rápido y capaz' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 · el más rápido' },
] as const

export { DEEPSEEK_MODELS }

const DEFAULTS: AiSettings = {
  vendor: 'anthropic',
  anthropicKey: '',
  anthropicModel: 'claude-opus-5-5',
  deepseekKey: '',
  deepseekModel: DEFAULT_DEEPSEEK_MODEL,
  typesafeKey: '',
  jevProxy: '',
}

const KEY = 'prysel.web.ai'
const FLOW = 'prysel.web.flow'

/**
 * A qué ritmo se construye lo que se le pide a la IA. `stream` (por defecto): al de la IA, cada pieza en
 * cuanto llega. `voice`: como en una clase, cada pieza espera a que se haya dicho su frase.
 */
export type Flow = 'stream' | 'voice'

export function loadFlow(): Flow {
  try {
    return localStorage.getItem(FLOW) === 'voice' ? 'voice' : 'stream'
  } catch {
    return 'stream'
  }
}

export function saveFlow(flow: Flow) {
  try {
    localStorage.setItem(FLOW, flow)
  } catch {
    // Sin almacenamiento (modo privado): vale para esta visita… si la página no se recarga.
  }
}

export function loadSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<AiSettings>
    const text = (value: unknown, fallback: string) =>
      typeof value === 'string' ? value : fallback
    return {
      vendor: parsed.vendor === 'deepseek' ? 'deepseek' : 'anthropic',
      anthropicKey: text(parsed.anthropicKey, ''),
      anthropicModel:
        text(parsed.anthropicModel, DEFAULTS.anthropicModel) || DEFAULTS.anthropicModel,
      deepseekKey: text(parsed.deepseekKey, ''),
      deepseekModel: text(parsed.deepseekModel, DEFAULTS.deepseekModel) || DEFAULTS.deepseekModel,
      typesafeKey: text(parsed.typesafeKey, ''),
      jevProxy: text(parsed.jevProxy, ''),
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

function anthropicFrom(settings: AiSettings): AiProvider | null {
  const key = settings.anthropicKey.trim()
  if (!key) return null
  return anthropicProvider({ apiKey: key, model: settings.anthropicModel, fetchImpl: browserFetch })
}

function deepseekFrom(settings: AiSettings): AiProvider | null {
  const key = settings.deepseekKey.trim()
  if (!key) return null
  return deepseekProvider({ apiKey: key, model: settings.deepseekModel })
}

/** La IA elegida; si le falta la clave, la otra (si la tiene). `null` si no hay ninguna. */
export function providerFrom(settings: AiSettings): AiProvider | null {
  return settings.vendor === 'deepseek'
    ? (deepseekFrom(settings) ?? anthropicFrom(settings))
    : (anthropicFrom(settings) ?? deepseekFrom(settings))
}

/** Hay alguna clave de IA guardada. */
export const hasAiKey = (settings: AiSettings) =>
  settings.anthropicKey.trim() !== '' || settings.deepseekKey.trim() !== ''

/** Las claves (y el intermediario) con los que TypeSafe resultó inalcanzable: no se vuelve a probar. */
let unreachable: string | null = null

/**
 * Quién decide: el JEV de TypeSafe si hay clave; si no, el motor local (sin red). Si TypeSafe no se deja
 * alcanzar desde el navegador, decide el local y se avisa una vez (`onFallback`): el chat no se queda parado.
 */
export function deciderFrom(
  settings: AiSettings,
  onFallback: () => void = () => undefined,
): Decider {
  const local = localDecider()
  const key = settings.typesafeKey.trim()
  if (!key) return local
  const proxy = settings.jevProxy.trim()
  const remote = typesafeDecider({
    apiKey: key,
    ...(proxy ? { fetchImpl: (_input, init) => fetch(proxy, init) } : {}),
  })
  const tag = `${key}|${proxy}`
  return {
    id: remote.id,
    async decide(request) {
      if (unreachable === tag) return local.decide(request)
      try {
        return await remote.decide(request)
      } catch (error) {
        if (!(error instanceof JevError) || error.reason !== 'network') throw error
        unreachable = tag
        onFallback()
        return local.decide(request)
      }
    },
  }
}
