import { useEffect, useRef } from 'react'
import { TEMPLATES, VALUE_NAMES, type TemplateId, type ValueType } from '@prysel/morphology'
import { Icon } from './Icon.tsx'

/**
 * El menú que aparece al soltar un cable en el vacío: crea un nodo nuevo **ya conectado** al que
 * lo soltó, en un solo gesto. Solo ofrece lo que sabe leer un valor, y pone primero lo que más
 * sentido tiene para esa clase de valor (a un número, una operación o un `print`; a una colección,
 * un bucle que la recorra).
 */

/** Las plantillas que aceptan un valor de entrada, en el orden en que se sugieren para cada clase. */
const SUGGESTED: Record<ValueType, TemplateId[]> = {
  number: ['operation', 'print', 'if', 'variable', 'call', 'return', 'list'],
  text: ['print', 'call', 'variable', 'return', 'list', 'for'],
  boolean: ['if', 'ifelse', 'print', 'while', 'return', 'variable'],
  collection: ['for', 'print', 'call', 'return', 'variable'],
  any: ['print', 'operation', 'call', 'if', 'for', 'return', 'variable', 'while', 'ifelse', 'list'],
}

/** Lo que se ofrece al soltar un cable de orden en el vacío: cualquier sentencia, sin valor que conectar. */
export const STATEMENTS: readonly TemplateId[] = [
  'print',
  'call',
  'operation',
  'variable',
  'input',
  'if',
  'ifelse',
  'for',
  'while',
  'break',
  'continue',
  'return',
  'raise',
]

export interface QuickAddProps {
  /** Dónde se soltó el cable, en el sistema del lienzo. */
  x: number
  y: number
  /** Qué clase de valor sale del origen. */
  type?: ValueType
  /** El nombre que sale: «lo que se conecta». */
  name?: string
  /** Un cable de orden no lleva valor: se ofrecen sentencias y este es el título. */
  title?: string
  onPick: (template: TemplateId) => void
  onClose: () => void
}

export function QuickAdd({ x, y, type = 'any', name = '', title, onPick, onClose }: QuickAddProps) {
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>('button')?.focus()
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
      className="quick-add"
      role="menu"
      aria-label={title ?? `Nuevo nodo conectado a ${name}`}
      style={{ left: x, top: y }}
    >
      <p className="quick-add__title type-field-label">
        {title ?? `Conectar «${name}» (${VALUE_NAMES[type]}) a…`}
      </p>
      <div className="quick-add__list">
        {(title === undefined ? SUGGESTED[type] : STATEMENTS).map((id) => (
          <button
            key={id}
            type="button"
            role="menuitem"
            className="palette__item"
            data-group={TEMPLATES[id].group}
            title={TEMPLATES[id].hint}
            onClick={() => {
              onPick(id)
            }}
          >
            <span className="palette__icon" aria-hidden>
              <Icon name={TEMPLATES[id].icon} size={14} />
            </span>
            <span className="palette__text">
              <span className="palette__label">{TEMPLATES[id].label}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
