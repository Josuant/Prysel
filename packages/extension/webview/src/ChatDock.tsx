import { useEffect, useRef, useState } from 'react'
import { Icon } from '@prysel/ui'
import { MAX_COMMAND } from '../../src/protocol.ts'
import './chat.css'
import type { AskOption } from './orders.ts'

/**
 * El chat con la IA, abajo del diagrama: lo que se pide y lo que contesta, como una conversación. Es la
 * misma tubería que la caja de órdenes (el motor JEV decide y la IA redacta), pensada para el móvil: una
 * línea para escribir (o dictar), la última respuesta a la vista, y la conversación entera al desplegarla.
 */

export interface ChatEntry {
  id: number
  role: 'user' | 'ai'
  text: string
  /** Lo que se fue contando mientras se construía o se explicaba, frase a frase. */
  lines?: string[]
  tone?: 'ok' | 'muted' | 'error'
  /** En marcha: se está decidiendo, escribiendo o explicando. */
  busy?: boolean
  /** Lo que pasa ahora mismo, en segundo plano. */
  note?: string
  /** El motor pregunta: cada opción vuelve a mandar la orden aclarada. */
  options?: AskOption[]
  needsKey?: boolean
}

export interface ChatDockProps {
  entries: ChatEntry[]
  /** Se está construyendo algo paso a paso: se puede detener. */
  building: boolean
  voice: boolean
  /** La IA que redacta (`null`: falta su clave). */
  ai: string | null
  suggestions: string[]
  onSubmit: (text: string) => void
  onChoose: (option: AskOption) => void
  onStop: () => void
  onToggleVoice: () => void
  onSettings: () => void
  onTyping: () => void
}

interface Recognition {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start(): void
  stop(): void
}

/** El reconocimiento de voz del navegador (Chrome, Safari), si lo hay. */
function recognitionClass(): (new () => Recognition) | null {
  const scope = globalThis as unknown as {
    SpeechRecognition?: new () => Recognition
    webkitSpeechRecognition?: new () => Recognition
  }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
}

export function ChatDock({
  entries,
  building,
  voice,
  ai,
  suggestions,
  onSubmit,
  onChoose,
  onStop,
  onToggleVoice,
  onSettings,
  onTyping,
}: ChatDockProps) {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [listening, setListening] = useState(false)
  const recognition = useRef<Recognition | null>(null)
  const thread = useRef<HTMLDivElement | null>(null)
  const Speech = recognitionClass()
  const last = entries[entries.length - 1]
  const lastAi = [...entries].reverse().find((entry) => entry.role === 'ai')

  // La conversación abierta sigue lo último que llega.
  useEffect(() => {
    const node = thread.current
    if (node) node.scrollTop = node.scrollHeight
  }, [entries, open])

  useEffect(() => () => recognition.current?.stop(), [])

  const send = (value: string) => {
    const order = value.trim().slice(0, MAX_COMMAND)
    if (order === '') return
    setText('')
    onSubmit(order)
  }

  const listen = () => {
    if (!Speech) return
    if (listening) {
      recognition.current?.stop()
      return
    }
    const r = new Speech()
    r.lang = 'es-ES'
    r.interimResults = true
    r.continuous = false
    let heard = ''
    r.onresult = (event) => {
      heard = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? '')
        .join('')
      setText(heard)
    }
    r.onend = () => {
      setListening(false)
      recognition.current = null
      if (heard.trim()) send(heard)
    }
    r.onerror = () => {
      setListening(false)
    }
    recognition.current = r
    onTyping()
    setListening(true)
    r.start()
  }

  const preview = lastAi ? lastLine(lastAi) : null

  return (
    <section className="chat" data-open={open || undefined} aria-label="Chat con la IA">
      {open && (
        <div className="chat__thread" ref={thread} role="log" aria-live="polite">
          {entries.length === 0 && (
            <p className="chat__empty">
              Pídele que te enseñe algo («enséñame la recursión»), que explique el programa o que lo
              cambie. Lo verás construirse en el diagrama mientras te lo cuenta.
            </p>
          )}
          {entries.map((entry) => (
            <Bubble
              key={`${entry.role}${entry.id}`}
              entry={entry}
              onChoose={onChoose}
              onSettings={onSettings}
            />
          ))}
        </div>
      )}

      {!open && preview && (
        <button
          type="button"
          className="chat__preview"
          data-busy={lastAi?.busy || undefined}
          onClick={() => setOpen(true)}
        >
          <span className="chat__preview-text">{preview}</span>
          <span className="chat__preview-more">Ver conversación</span>
        </button>
      )}

      {!open && last?.role === 'ai' && last.options && last.options.length > 0 && (
        <div className="chat__chips">
          {last.options.map((option) => (
            <button
              key={option.label}
              type="button"
              className="chat__chip"
              onClick={() => onChoose(option)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}

      {ai === null && (
        <button type="button" className="chat__key" onClick={onSettings}>
          <Icon name="sparkles" size={14} />
          Conecta la IA para que escriba y explique
        </button>
      )}

      {entries.length === 0 && suggestions.length > 0 && (
        <div className="chat__chips">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="chat__chip"
              onClick={() => send(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      <form
        className="chat__composer"
        onSubmit={(event) => {
          event.preventDefault()
          send(text)
        }}
      >
        <button
          type="button"
          className="chat__icon"
          aria-label={open ? 'Ocultar la conversación' : 'Ver la conversación'}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={open ? 'chevron' : 'chevron-up'} size={18} />
        </button>
        <input
          className="chat__input"
          type="text"
          value={text}
          maxLength={MAX_COMMAND}
          enterKeyHint="send"
          autoComplete="off"
          aria-label="Mensaje para la IA"
          placeholder={listening ? 'Te escucho…' : 'Pregunta o pide algo…'}
          onChange={(event) => {
            setText(event.target.value)
            onTyping()
          }}
        />
        {building ? (
          <button
            type="button"
            className="chat__send"
            data-stop=""
            aria-label="Detener"
            onClick={onStop}
          >
            <Icon name="stop" size={16} />
          </button>
        ) : text.trim() === '' && Speech ? (
          <button
            type="button"
            className="chat__send"
            data-listening={listening || undefined}
            aria-label={listening ? 'Dejar de escuchar' : 'Dictar'}
            onClick={listen}
          >
            <Icon name="mic" size={18} />
          </button>
        ) : (
          <button
            type="submit"
            className="chat__send"
            aria-label="Enviar"
            disabled={text.trim() === ''}
          >
            <Icon name="send" size={16} />
          </button>
        )}
        <button
          type="button"
          className="chat__icon"
          aria-pressed={voice}
          aria-label={
            voice
              ? 'Voz activada: pulsa para silenciar'
              : 'Voz apagada: pulsa para oír las explicaciones'
          }
          onClick={onToggleVoice}
        >
          <Icon name={voice ? 'volume' : 'volume-off'} size={18} />
        </button>
      </form>
    </section>
  )
}

function lastLine(entry: ChatEntry): string {
  if (entry.busy && entry.note) return entry.note
  const line = entry.lines?.[entry.lines.length - 1]
  return line ?? entry.text
}

function Bubble({
  entry,
  onChoose,
  onSettings,
}: {
  entry: ChatEntry
  onChoose: (option: AskOption) => void
  onSettings: () => void
}) {
  if (entry.role === 'user') {
    return (
      <p className="chat__bubble" data-role="user">
        {entry.text}
      </p>
    )
  }
  return (
    <div
      className="chat__bubble"
      data-role="ai"
      data-tone={entry.tone}
      data-busy={entry.busy || undefined}
    >
      {entry.text && <p>{entry.text}</p>}
      {entry.lines && entry.lines.length > 0 && (
        <ol className="chat__lines">
          {entry.lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ol>
      )}
      {entry.note && <p className="chat__note">{entry.note}</p>}
      {entry.options && entry.options.length > 0 && (
        <div className="chat__chips">
          {entry.options.map((option) => (
            <button
              key={option.label}
              type="button"
              className="chat__chip"
              onClick={() => onChoose(option)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      {entry.needsKey && (
        <button type="button" className="chat__chip" onClick={onSettings}>
          Abrir ajustes
        </button>
      )}
    </div>
  )
}
