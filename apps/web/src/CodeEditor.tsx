import { useEffect, useRef, useState } from 'react'

/**
 * Un editor de código sencillo, pensado para el teclado del móvil: sin autocorrector ni mayúsculas
 * automáticas, con tabulador de cuatro espacios y la sangría de la línea anterior al saltar de línea.
 * El texto llega al anfitrión con una pausa corta: no se reanaliza en cada tecla.
 */

const INDENT = '    '
const DELAY = 250

export function CodeEditor({
  value,
  onChange,
}: {
  value: string
  onChange: (text: string) => void
}) {
  const [text, setText] = useState(value)
  const typed = useRef(value)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Lo que cambia desde fuera (otra lección, una edición en el diagrama) entra al editor.
  useEffect(() => {
    if (value !== typed.current) {
      typed.current = value
      setText(value)
    }
  }, [value])

  const change = (next: string) => {
    setText(next)
    typed.current = next
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => onChange(next), DELAY)
  }

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const insert = (area: HTMLTextAreaElement, snippet: string) => {
    const { selectionStart: start, selectionEnd: end } = area
    const next = text.slice(0, start) + snippet + text.slice(end)
    change(next)
    requestAnimationFrame(() => {
      area.selectionStart = area.selectionEnd = start + snippet.length
    })
  }

  const lines = text.split('\n').length

  return (
    <div className="web-editor">
      <div className="web-editor__gutter" aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        className="web-editor__text"
        value={text}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        wrap="off"
        rows={lines + 3}
        aria-label="Código Python"
        onChange={(event) => change(event.target.value)}
        onKeyDown={(event) => {
          const area = event.currentTarget
          if (event.key === 'Tab') {
            event.preventDefault()
            insert(area, INDENT)
          } else if (event.key === 'Enter') {
            const before = text.slice(0, area.selectionStart)
            const line = before.slice(before.lastIndexOf('\n') + 1)
            let indent = /^\s*/.exec(line)?.[0] ?? ''
            if (/:\s*$/.test(line)) indent += INDENT
            event.preventDefault()
            insert(area, `\n${indent}`)
          }
        }}
      />
    </div>
  )
}
