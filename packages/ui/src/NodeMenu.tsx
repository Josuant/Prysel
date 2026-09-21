import { useEffect, useRef } from 'react'

/**
 * El menú de un nodo (clic derecho, o la tecla de menú con el nodo enfocado): duplicar, editar como
 * código, eliminar… Las acciones no ocupan sitio en la tarjeta: aparecen cuando se piden.
 */

export interface NodeMenuItem {
  label: string
  onSelect: () => void
  /** Una acción que quita algo: se distingue del resto. */
  danger?: boolean
  /** La tecla que hace lo mismo, si la hay: se enseña, no se implementa aquí. */
  hint?: string
}

export interface NodeMenuProps {
  /** Dónde se abre, en el sistema del lienzo. */
  x: number
  y: number
  /** A quién pertenece: es lo que dice el menú a un lector de pantalla. */
  title: string
  items: NodeMenuItem[]
  onClose: () => void
}

export function NodeMenu({ x, y, title, items, onClose }: NodeMenuProps) {
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      if (buttons.length === 0) return
      event.preventDefault()
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'ArrowDown' ? at + 1 : at - 1
      buttons[(next + buttons.length) % buttons.length]?.focus()
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
      className="node-menu"
      role="menu"
      aria-label={`Acciones de ${title}`}
      tabIndex={-1}
      style={{ left: x, top: y }}
      // Un clic derecho sobre el propio menú no abre el del navegador.
      onContextMenu={(event) => {
        event.preventDefault()
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className="node-menu__item"
          data-danger={item.danger ? '' : undefined}
          onClick={() => {
            item.onSelect()
            onClose()
          }}
        >
          <span>{item.label}</span>
          {item.hint && <kbd className="node-menu__hint">{item.hint}</kbd>}
        </button>
      ))}
    </div>
  )
}
