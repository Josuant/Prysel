import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

/**
 * Editar un nodo como código. Es la red de seguridad de todo el editor: cualquier sentencia de
 * Python, incluso la que el diagrama no sabe representar, se puede escribir aquí como texto.
 * Por eso escribir Python al 100 % desde el diagrama es posible aunque no todo tenga un editor
 * visual propio.
 *
 * Vive **fuera** del lienzo (no dentro del nodo): el lienzo se escala con el zoom, y un editor de
 * texto que se hace pequeño o queda tapado por otro nodo no sirve para escribir.
 */

export interface CodePanelProps {
  /** El nodo que se edita: «suma_resultado». */
  title: string
  /** Su línea en el archivo. */
  line?: number
  /** El texto tal como está en el archivo. */
  initial: string
  onApply: (text: string) => void
  onCancel: () => void
}

const INDENT = '    '

export function CodePanel({ title, line, initial, onApply, onCancel }: CodePanelProps) {
  const [text, setText] = useState(initial)
  const box = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    box.current?.focus()
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      onApply(text)
    } else if (event.key === 'Tab' && !event.shiftKey) {
      // Tab sangra, como en un editor: no salta al campo siguiente.
      event.preventDefault()
      const el = event.currentTarget
      const { selectionStart, selectionEnd } = el
      setText(text.slice(0, selectionStart) + INDENT + text.slice(selectionEnd))
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = selectionStart + INDENT.length
      })
    }
  }

  return (
    <div className="code-panel" role="dialog" aria-label={`Editar como código: ${title}`}>
      <header className="code-panel__head">
        <span className="type-field-label">Editar como código</span>
        <span className="code-panel__where type-field-label">
          {title}
          {line !== undefined && ` · línea ${line}`}
        </span>
      </header>
      <textarea
        ref={box}
        className="code-panel__text type-code"
        value={text}
        spellCheck={false}
        wrap="off"
        rows={Math.min(14, Math.max(3, text.split('\n').length + 1))}
        aria-label="Código de Python"
        onChange={(event) => {
          setText(event.target.value)
        }}
        onKeyDown={onKeyDown}
      />
      <footer className="code-panel__foot">
        <span className="type-field-label code-panel__hint">Ctrl+Intro aplica · Esc cancela</span>
        <button type="button" className="code-panel__button" onClick={onCancel}>
          Cancelar
        </button>
        <button
          type="button"
          className="code-panel__button code-panel__button--primary"
          onClick={() => {
            onApply(text)
          }}
        >
          Aplicar
        </button>
      </footer>
    </div>
  )
}
