import { useEffect } from 'react'
import { plainNote } from '@prysel/ui'

/**
 * Narración con voz sincronizada (Fase E, docs/lecciones.md §3.4): lee en voz alta la nota del momento
 * actual, con la síntesis de voz del navegador — comprobado que funciona dentro de un webview de VS Code
 * (Electron trae Chromium entero, con `speechSynthesis` de verdad, no un cascarón vacío).
 *
 * Apagado por defecto (nadie espera que la extensión hable sin pedirlo): quien la activa ya tiene
 * `aria-live="polite"` en el subtítulo para los lectores de pantalla; esto es un canal aparte, para quien
 * quiere oírlo sin depender de uno.
 */

/** Lo que se lee de una nota: el título, si tiene, y el texto sin las marcas (`**negrita**`, `` `código` ``). */
export function speakableNote(note: { title?: string; text: string }): string {
  const spoken = plainNote(note.text)
  return note.title ? `${note.title}. ${spoken}` : spoken
}

/** La voz que mejor casa con el idioma pedido: exacta, o el mismo idioma sin variante regional. */
export function pickVoice(lang: string | undefined): SpeechSynthesisVoice | undefined {
  if (!lang || typeof window === 'undefined' || !window.speechSynthesis) return undefined
  const voices = window.speechSynthesis.getVoices()
  const short = lang.split('-')[0]
  return (
    voices.find((voice) => voice.lang === lang) ??
    voices.find((voice) => voice.lang.split('-')[0] === short)
  )
}

export interface NarrationOptions {
  enabled: boolean
  /** Código de idioma del guion (`es`, `en`…): decide la voz, si hay una que case. */
  lang?: string
  /** Lo que se lee. `null`: nada que leer (sin momento actual, o la narración está apagada). */
  text: string | null
  /**
   * Cambia solo cuando hay que volver a leer (llegar a un momento nuevo, o volver a uno anterior al
   * rebobinar): normalmente el id del momento. Sin esto, quedarse varios pasos en el mismo momento no
   * repetiría la nota (correcto), pero tampoco la leería dos veces al volver atrás y adelante (también
   * correcto: solo se lee al LLEGAR, no en cada paso que se queda dentro de su alcance).
   */
  key: string | null
}

export function useNarration({ enabled, lang, text, key }: NarrationOptions): void {
  useEffect(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return
    window.speechSynthesis.cancel()
    if (!enabled || !text || key === null) return
    const utterance = new SpeechSynthesisUtterance(text)
    if (lang) utterance.lang = lang
    const voice = pickVoice(lang)
    if (voice) utterance.voice = voice
    window.speechSynthesis.speak(utterance)
    return () => {
      window.speechSynthesis.cancel()
    }
    // `text` no entra en las dependencias a propósito: cambia con cada re-render de React (nueva cadena
    // aunque diga lo mismo) y volvería a leer de más; lo que de verdad marca «hay que leer esto» es `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, lang, key])
}
