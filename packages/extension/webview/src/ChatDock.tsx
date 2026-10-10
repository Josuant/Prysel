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
  /**
   * Lo que está seleccionado en el diagrama: se ofrece qué hacer con ello sin tener que escribirlo (preguntar
   * qué hace, cambiarlo, quitarlo). La orden habla de «esto», y va con la selección.
   */
  about?: { label: string } | undefined
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
  /**
   * Lo que lleva escrito en la caja (`null`: nada, o ya lo mandó). Sirve para lo mismo que lo que se le oye:
   * que el lienzo vaya esbozando lo que se pide antes de mandarlo.
   */
  onDraft?: (text: string | null) => void
  /**
   * Lo que dijo el JEV de si eso que se ha oído es una orden entera (1) o está a medias (0). `undefined`:
   * aún no se sabe.
   */
  judged?: (text: string) => number | undefined
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

/** Cuánto silencio basta para dar lo dicho por terminado y mandarlo, sin esperar al navegador. */
/** Lo que se espera tras una tecla antes de contarle al lienzo lo que se lleva escrito. */
const DRAFT_MS = 220
const EARLY_MS = 1000
/** A partir de aquí, el JEV da la frase por entera: se puede mandar ya. */
const WHOLE_SAID = 0.6
/** Por debajo, la frase está a medias: no se manda aunque el navegador la haya cerrado. */
const HALF_SAID = 0.4
/** Lo que se espera a que se termine una frase a medias antes de mandarla tal cual. */
const HELD_MS = 4500

/** Lo dicho, para comparar: sin mayúsculas, signos ni espacios de más. */
const spoken = (text: string) =>
  text
    .toLowerCase()
    .replace(/[¿?¡!.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Tras empezar a oír algo, lo que se espera a que se convierta en una frase antes de darlo por ruido. */
const HEARING_PATIENCE_MS = 4000

/** El reconocimiento de voz del navegador (Chrome, Safari), si lo hay. */
function recognitionClass(): (new () => Recognition) | null {
  const scope = globalThis as unknown as {
    SpeechRecognition?: new () => Recognition
    webkitSpeechRecognition?: new () => Recognition
    /** Un guion de prueba pone aquí el suyo: dicta las frases en vez de escucharlas. */
    __pryselSpeech?: new () => Recognition
  }
  return scope.__pryselSpeech ?? scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
}

export function ChatDock({
  entries,
  building,
  voice,
  ai,
  suggestions,
  about,
  onSubmit,
  onChoose,
  onStop,
  onToggleVoice,
  onSettings,
  onTyping,
  onMic,
  onHearing,
  onDraft,
  judged,
}: ChatDockProps) {
  const [text, setText] = useState('')
  const composer = useRef<HTMLInputElement>(null)
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

  // El reconocimiento de voz vive más que un render: lo que llama tiene que ser lo de ahora, no lo de cuando
  // se abrió el micrófono (una orden mandada con datos de entonces llega desfasada y se rechaza).
  const live = useRef({ onSubmit, onHearing, onMic, onDraft, judged })
  useEffect(() => {
    live.current = { onSubmit, onHearing, onMic, onDraft, judged }
  })

  /** Lo escrito se cuenta al lienzo con un pequeño retraso: no en cada tecla, sí en cada palabra. */
  const drafting = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draft = (value: string | null) => {
    if (drafting.current !== null) clearTimeout(drafting.current)
    drafting.current = null
    if (value === null || value.trim().length < 4) {
      live.current.onDraft?.(null)
      return
    }
    drafting.current = setTimeout(() => {
      drafting.current = null
      live.current.onDraft?.(value)
    }, DRAFT_MS)
  }

  const send = (value: string) => {
    const order = value.trim().slice(0, MAX_COMMAND)
    if (order === '') return
    setText('')
    draft(null)
    live.current.onSubmit(order)
  }

  // El micrófono abierto: se escucha todo el rato. Cada frase que se termina de decir se manda como una
  // orden; mientras se está diciendo, se avisa (lo que se construye se queda quieto a oírla).
  const wanted = useRef(false)
  const quiet = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Lo que ya se mandó de la frase que el navegador aún no ha dado por terminada. */
  const early = useRef('')
  const pause = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Una frase que el navegador cerró pero que estaba a medias: espera a lo que falta. */
  const held = useRef('')
  const waiting = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hearing = (value: string | null) => {
    if (quiet.current) clearTimeout(quiet.current)
    quiet.current = null
    live.current.onHearing?.(value)
    // Si lo oído no llega a frase (un ruido, una tos), se suelta solo.
    if (value !== null) {
      quiet.current = setTimeout(() => {
        setText('')
        live.current.onHearing?.(null)
      }, HEARING_PATIENCE_MS)
    }
  }
  const open_ = () => {
    // Se mira ahora, no al dibujar: un guion de prueba puede haber puesto el suyo entre medias.
    const Source = recognitionClass()
    if (!Source) return
    const r = new Source()
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
      // Lo que ya se mandó de esta misma frase (por haberse callado un momento) no se vuelve a mandar: de
      // lo que llega, cuenta solo lo que viene detrás.
      const rest = (heard: string) => {
        const sent = spoken(early.current)
        const now = spoken(heard)
        if (sent === '' || !now.startsWith(sent)) return heard.trim()
        const extra = now.slice(sent.length).trim()
        return extra === ''
          ? ''
          : heard.trim().split(/\s+/).slice(-extra.split(' ').length).join(' ')
      }
      if (pause.current) clearTimeout(pause.current)
      pause.current = null
      // Lo que quedó a medias de antes va delante de lo que se dice ahora: es la misma frase.
      const joined = (piece: string) => (held.current === '' ? piece : `${held.current} ${piece}`)
      const flush = () => {
        const whole = held.current
        held.current = ''
        hearing(null)
        if (whole !== '') send(whole)
      }
      if (said.trim() !== '') {
        const more = rest(said)
        early.current = ''
        if (more === '') {
          if (held.current === '') hearing(null)
          return
        }
        const whole = joined(more)
        // El navegador ha cerrado la frase, pero puede estar a medias (una pausa para pensar). Si el JEV
        // dice que lo está, no se manda: se guarda, y lo que se diga a continuación se le une. Si no llega
        // nada más, se manda tal cual.
        const sure = live.current.judged?.(whole) ?? live.current.judged?.(more)
        if (sure !== undefined && sure < HALF_SAID) {
          held.current = whole
          setText(whole)
          hearing(whole)
          if (waiting.current) clearTimeout(waiting.current)
          waiting.current = setTimeout(flush, HELD_MS)
          return
        }
        if (waiting.current) clearTimeout(waiting.current)
        held.current = ''
        hearing(null)
        send(whole)
      } else if (partial.trim() !== '') {
        const more = rest(partial)
        if (more === '') return
        // Sigue hablando: lo que estaba guardado espera a que acabe.
        if (waiting.current) clearTimeout(waiting.current)
        const whole = joined(more)
        setText(whole)
        hearing(whole)
        // El navegador tarda en dar una frase por terminada. Si lo dicho no cambia durante un momento y
        // el JEV dice que la frase está entera, se manda sin esperarle. Si está a medias, se espera.
        pause.current = setTimeout(() => {
          const sure = live.current.judged?.(whole)
          if (sure === undefined || sure < WHOLE_SAID) return
          early.current = partial
          held.current = ''
          hearing(null)
          send(whole)
        }, EARLY_MS)
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
        live.current.onMic?.(false)
      }
    }
    recognition.current = r
    try {
      r.start()
    } catch {
      wanted.current = false
      setListening(false)
      live.current.onMic?.(false)
    }
  }
  const listen = () => {
    if (!Speech) return
    if (listening) {
      wanted.current = false
      recognition.current?.stop()
      hearing(null)
      setListening(false)
      live.current.onMic?.(false)
      return
    }
    wanted.current = true
    onTyping()
    setListening(true)
    live.current.onMic?.(true)
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

      {about && !building && (
        <div className="chat__chips chat__chips--about">
          <span className="chat__about" title={about.label}>
            {about.label.length > 28 ? `${about.label.slice(0, 27)}…` : about.label}
          </span>
          <button type="button" className="chat__chip" onClick={() => send('¿Qué hace esto?')}>
            ¿Qué hace?
          </button>
          <button
            type="button"
            className="chat__chip"
            onClick={() => {
              // Se deja empezada la frase: falta decir cómo se quiere.
              setText('Cambia esto para que ')
              composer.current?.focus()
            }}
          >
            Cámbialo…
          </button>
          <button type="button" className="chat__chip" onClick={() => send('Quita esto')}>
            Quítalo
          </button>
        </div>
      )}

      {!about && entries.length === 0 && suggestions.length > 0 && (
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
          ref={composer}
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
            draft(event.target.value)
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
