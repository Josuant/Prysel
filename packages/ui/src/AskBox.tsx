import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './Icon.tsx'

/**
 * **Pedir con palabras, en el sitio.** Una caja de una línea que aparece donde se señala (un clic derecho en
 * el lienzo o en un nodo, un cable soltado en el vacío): lo que se escribe es una orden sobre eso que se
 * señaló. No sabe quién la atiende: solo recoge la frase y la entrega.
 */

/** Algo que se ofrece bajo la caja, a un toque: una orden ya hecha, una frase empezada o una acción. */
export interface AskChip {
  label: string
  title?: string
  /** Se manda tal cual, como si se hubiera escrito. */
  say?: string
  /** Se deja empezada en la caja: falta decir cómo. */
  prefill?: string
  /** Hace otra cosa (no es una orden): se ejecuta y la caja se cierra. */
  onPick?: () => void
}

export interface AskBoxProps {
  placeholder: string
  /** Lo que ya trae escrito (una frase empezada). */
  initial?: string
  chips?: readonly AskChip[]
  maxLength?: number
  /** Coge el foco al aparecer. */
  focus?: boolean
  onSubmit: (text: string) => void
  /** Lo que se lleva escrito (`null`: nada, o ya se mandó): quien escucha puede ir esbozándolo. */
  onDraft?: (text: string | null) => void
  /** Se eligió algo que no es una orden: quien contiene la caja se cierra. */
  onDone?: () => void
}

export function AskBox({
  placeholder,
  initial = '',
  chips = [],
  maxLength = 400,
  focus = true,
  onSubmit,
  onDraft,
  onDone,
}: AskBoxProps) {
  const [text, setText] = useState(initial)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!focus) return
    const field = input.current
    if (!field) return
    field.focus()
    // El cursor, al final: se sigue escribiendo donde acaba la frase empezada.
    const end = field.value.length
    field.setSelectionRange(end, end)
  }, [focus])
  const send = (value: string) => {
    const order = value.trim().slice(0, maxLength)
    if (order === '') return
    onDraft?.(null)
    // Si la caja se queda (no es de las que se cierran al pedir), empieza de nuevo.
    setText('')
    onSubmit(order)
  }
  return (
    <div className="ask-box">
      <form
        className="ask-box__form"
        onSubmit={(event) => {
          event.preventDefault()
          send(text)
        }}
      >
        <span className="ask-box__mark" aria-hidden>
          <Icon name="sparkles" size={14} />
        </span>
        <input
          ref={input}
          className="ask-box__input nodrag nopan"
          type="text"
          value={text}
          maxLength={maxLength}
          enterKeyHint="send"
          autoComplete="off"
          aria-label={placeholder}
          placeholder={placeholder}
          onChange={(event) => {
            setText(event.target.value)
            onDraft?.(event.target.value)
          }}
          // Las teclas son del texto: ni mueven el lienzo ni borran el nodo elegido.
          onKeyDown={(event) => {
            if (event.key !== 'Escape') event.stopPropagation()
          }}
        />
        <button
          type="submit"
          className="ask-box__send"
          aria-label="Pedirlo"
          disabled={text.trim() === ''}
        >
          <Icon name="send" size={14} />
        </button>
      </form>
      {chips.length > 0 && (
        <div className="ask-box__chips">
          {chips.map((chip) => (
            <button
              key={chip.label}
              type="button"
              className="ask-box__chip"
              title={chip.title}
              onClick={() => {
                if (chip.say !== undefined) send(chip.say)
                else if (chip.prefill !== undefined) {
                  setText(chip.prefill)
                  input.current?.focus()
                } else {
                  chip.onPick?.()
                  onDone?.()
                }
              }}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export interface AskBubbleProps extends AskBoxProps {
  /** Dónde se abre, en el sistema de quien la contiene. */
  x: number
  y: number
  /** De qué se habla («Aquí», «Entre A y B»…). */
  title?: string
  onClose: () => void
}

/** La caja, suelta: flota donde se señaló y se cierra al pulsar fuera o con Escape. */
export function AskBubble({ x, y, title, onClose, onSubmit, ...box }: AskBubbleProps) {
  const root = useRef<HTMLDivElement>(null)

  // Cerca de un borde se abriría cortada: se recoloca para que quepa entera.
  useLayoutEffect(() => {
    const bubble = root.current
    const stage = bubble?.offsetParent
    if (!bubble || !(stage instanceof HTMLElement)) return
    const room = 6
    bubble.style.left = `${Math.max(room, Math.min(x, stage.clientWidth - bubble.offsetWidth - room))}px`
    bubble.style.top = `${Math.max(room, Math.min(y, stage.clientHeight - bubble.offsetHeight - room))}px`
  }, [x, y, box.chips?.length])

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      ref={root}
      className="ask-bubble"
      role="dialog"
      aria-label={title ?? box.placeholder}
      style={{ left: x, top: y }}
      onContextMenu={(event) => {
        event.preventDefault()
      }}
    >
      {title && <p className="ask-bubble__title type-field-label">{title}</p>}
      <AskBox
        {...box}
        onSubmit={(text) => {
          onSubmit(text)
          onClose()
        }}
        onDone={onClose}
      />
    </div>
  )
}
