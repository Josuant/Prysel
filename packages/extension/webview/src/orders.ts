import type { Evidence, Forced } from '../../src/jev/engine.ts'
import { pickVoice } from './useNarration.ts'

/**
 * Las órdenes del lienzo (ver `docs/voz.md`): lo que se enseña de cada una mientras el motor JEV decide y
 * cuando ya ha decidido, y la voz que lo dice. Sin React: es lo que se puede probar solo.
 */

/** RNF-01: de que se acaba la orden a que el cambio se ve, como mucho esto. */
export const BUDGET_MS = 800

export interface AskOption {
  label: string
  force?: Forced
  order?: string
}

export type OrderState =
  | { phase: 'idle' }
  /** La orden salió y aún no hay decisión. */
  | { phase: 'deciding'; text: string }
  /** El motor no lo tiene claro: pregunta, y cada respuesta vuelve a mandar la orden ya aclarada. */
  | {
      phase: 'ask'
      text: string
      question: string
      /** Cada salida aclara la orden (`force`) o es otra orden, ya completa (`order`). */
      options: AskOption[]
    }
  | {
      phase: 'done'
      text: string
      /** Lo que se hizo (o por qué no). */
      say: string
      tone: 'ok' | 'muted' | 'error'
      /** Falta la clave de TypeSafe: se ofrece guardarla. */
      needsKey?: boolean
      engine?: string
      /** Lo que tardó el motor en decidir. */
      jevMs?: number
      /** De pulsar Intro a que el cambio está pintado. Sin él, aún no se ha visto. */
      totalMs?: number
      evidence?: Evidence[]
      /** Lo que pasa después, en segundo plano: el contenido de la pieza se está escribiendo, o ya llegó. */
      note?: string
      /** Se está construyendo paso a paso: se puede detener. */
      building?: boolean
    }

export const formatMs = (ms: number) => `${Math.round(ms)} ms`

/** ¿Cumplió el plazo? `null` mientras no se sabe cuánto tardó. */
export const withinBudget = (state: OrderState): boolean | null =>
  state.phase === 'done' && state.totalMs !== undefined ? state.totalMs <= BUDGET_MS : null

/** Lo que contestó el motor a cada pregunta, en una línea: por qué hizo lo que hizo. */
export function evidenceLine(evidence: readonly Evidence[]): string {
  return evidence
    .map((item) => `${item.question}: ${item.answer} (${Math.round(item.confidence * 100)} %)`)
    .join(' · ')
}

/** Dice un texto en voz alta, cortando lo que se estuviera diciendo: lo último manda. */
export function speak(text: string, lang = 'es', queue = false): void {
  if (typeof window === 'undefined' || !window.speechSynthesis || text.trim() === '') return
  // `queue`: se dice cuando acabe lo que se está diciendo, sin cortarlo.
  if (!queue) window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = lang
  const voice = pickVoice(lang)
  if (voice) utterance.voice = voice
  window.speechSynthesis.speak(utterance)
}

/** Calla: quien escribe (o habla) tiene la palabra. */
export function hush(): void {
  if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel()
}
