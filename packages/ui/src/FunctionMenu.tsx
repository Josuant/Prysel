import { useEffect, useId, useRef, useState } from 'react'
import { Icon } from './Icon.tsx'
import type { FunctionInfo } from './program.ts'

/**
 * El menú de funciones. El flujo del programa enseña cada función una sola vez, como la
 * llamada que la usa; aquí están todas, y al elegir una se abre su contenido en un lienzo
 * limpio. Cuando se está dentro de una función, la ruta de arriba lleva de vuelta al programa.
 */

export interface FunctionMenuProps {
  functions: FunctionInfo[]
  /** Los métodos de las clases: se abren igual, y se listan tras las funciones. */
  methods?: FunctionInfo[]
  /** La función que se está viendo, o `null` si es el programa. */
  focus: FunctionInfo | null
  /** Por dónde se llegó a ella desde el programa (abriendo subprocesos): las migas de en medio. */
  trail?: FunctionInfo[]
  onOpen: (id: string | null) => void
  /** Volver a una función del camino (sin perder el resto del camino hasta ella). */
  onCrumb?: (id: string) => void
}

const usage = (fn: FunctionInfo) =>
  fn.calls > 0
    ? `${fn.calls} ${fn.calls === 1 ? 'llamada' : 'llamadas'}`
    : fn.used
      ? 'usada'
      : 'sin usar'

export function FunctionMenu({
  functions,
  methods = [],
  focus,
  trail = [],
  onOpen,
  onCrumb,
}: FunctionMenuProps) {
  const listed = [...functions, ...methods]
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const listId = useId()

  // Se cierra al pulsar fuera o Escape, y Escape devuelve el foco al botón que lo abrió.
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (listed.length === 0) return null

  return (
    <div className="fn-menu" ref={root}>
      <nav className="fn-menu__path" aria-label="Qué se está viendo">
        <button
          type="button"
          className="fn-menu__crumb"
          aria-current={focus === null ? 'page' : undefined}
          onClick={() => {
            onOpen(null)
          }}
        >
          Programa
        </button>
        {focus &&
          trail.map((fn) => (
            <span key={fn.id} className="fn-menu__step">
              <span className="fn-menu__sep" aria-hidden>
                ›
              </span>
              <button
                type="button"
                className="fn-menu__crumb"
                onClick={() => {
                  if (onCrumb) onCrumb(fn.id)
                  else onOpen(fn.id)
                }}
              >
                {fn.name}
              </button>
            </span>
          ))}
        {focus && (
          <>
            <span className="fn-menu__sep" aria-hidden>
              ›
            </span>
            <span className="fn-menu__crumb" aria-current="page">
              {focus.name}
              <span className="fn-menu__sig">{focus.signature}</span>
            </span>
          </>
        )}
      </nav>

      <button
        ref={trigger}
        type="button"
        className="fn-menu__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          setOpen((current) => !current)
        }}
      >
        <Icon name="folder" size={13} />
        Funciones
        <span className="fn-menu__count">{listed.length}</span>
      </button>

      {focus?.doc && (
        <p className="fn-menu__doc" title={focus.doc}>
          {focus.doc}
        </p>
      )}

      {open && (
        <ul className="fn-menu__list" id={listId} role="listbox" aria-label="Funciones del archivo">
          {listed.map((fn) => (
            <li key={fn.id} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={focus?.id === fn.id}
                className="fn-menu__item"
                onClick={() => {
                  onOpen(fn.id)
                  setOpen(false)
                }}
              >
                <span className="fn-menu__name">
                  {fn.name}
                  <span className="fn-menu__sig">{fn.signature}</span>
                </span>
                {fn.doc && <span className="fn-menu__summary">{fn.doc}</span>}
                <span className="fn-menu__meta">
                  {usage(fn)} · {fn.size} {fn.size === 1 ? 'nodo' : 'nodos'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
