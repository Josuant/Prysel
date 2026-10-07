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
  /** El micrófono se abrió o se cerró (abierto: se escucha todo el rato, sin pulsar para cada frase). */
  onMic?: (open: boolean) => void
  /** Lo que se le está oyendo decir ahora mismo (`null`: nada, o ya acabó). */
  onHearing?: (text: string | null) => void
}

interface Recognition {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult:
    | ((event: {
        resultIndex: number
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>
      }) => void)
    | null
  onend: (() => void) | null
  onerror: ((event: { error?: string }) => void) | null
  start(): void
  stop(): void
}

/** Tras empezar a oír algo, lo que se espera a que se convierta en una frase antes de darlo por ruido. */
const HEARING_PATIENCE_MS = 4000

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
  onMic,
  onHearing,
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

  const send = (value: string) => {
    const order = value.trim().slice(0, MAX_COMMAND)
    if (order === '') return
    setText('')
    onSubmit(order)
  }

  // El micrófono abierto: se escucha todo el rato. Cada frase que se termina de decir se manda como una
  // orden; mientras se está diciendo, se avisa (lo que se construye se queda quieto a oírla).
  const wanted = useRef(false)
  const quiet = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hearing = (value: string | null) => {
    if (quiet.current) clearTimeout(quiet.current)
    quiet.current = null
    onHearing?.(value)
    // Si lo oído no llega a frase (un ruido, una tos), se suelta solo.
    if (value !== null) {
      quiet.current = setTimeout(() => {
        setText('')
        onHearing?.(null)
      }, HEARING_PATIENCE_MS)
    }
  }
  const open_ = () => {
    if (!Speech) return
    const r = new Speech()
    r.lang = 'es-ES'
    r.interimResults = true
    r.continuous = true
    r.onresult = (event) => {
      let said = ''
      let partial = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const transcript = result?.[0]?.transcript ?? ''
        if (result?.isFinal) said += transcript
        else partial += transcript
      }
      if (said.trim() !== '') {
        hearing(null)
        send(said)
      } else if (partial.trim() !== '') {
        setText(partial)
        hearing(partial)
      }
    }
    // El navegador corta la escucha cada cierto tiempo (o tras un silencio): mientras se quiera, se reabre.
    r.onend = () => {
      recognition.current = null
      if (wanted.current) open_()
      else setListening(false)
    }
    r.onerror = (event) => {
      // Sin permiso (o sin micrófono) no tiene sentido insistir.
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        wanted.current = false
        onMic?.(false)
      }
    }
    recognition.current = r
    try {
      r.start()
    } catch {
      wanted.current = false
      setListening(false)
      onMic?.(false)
    }
  }
  const listen = () => {
    if (!Speech) return
    if (listening) {
      wanted.current = false
      recognition.current?.stop()
      hearing(null)
      setListening(false)
      onMic?.(false)
      return
    }
    wanted.current = true
    onTyping()
    setListening(true)
    onMic?.(true)
    open_()
  }

  // Al desmontarse, el micrófono se cierra.
  useEffect(
    () => () => {
      wanted.current = false
      recognition.current?.stop()
    },
    [],
  )

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
          placeholder={listening ? 'Te escucho: di lo que quieras…' : 'Pregunta o pide algo…'}
          onChange={(event) => {
            setText(event.target.value)
            onTyping()
          }}
        />
        {Speech && (
          <button
            type="button"
            className="chat__icon chat__mic"
            data-listening={listening || undefined}
            aria-pressed={listening}
            aria-label={
              listening
                ? 'Micrófono abierto: pulsa para cerrarlo'
                : 'Abrir el micrófono: hablar sin pulsar para cada frase'
            }
            title={
              listening
                ? 'Micrófono abierto: te escucho todo el rato. Pulsa para cerrarlo.'
                : 'Abrir el micrófono y hablar con la IA sin pulsar nada más'
            }
            onClick={listen}
          >
            <Icon name="mic" size={18} />
          </button>
        )}
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
