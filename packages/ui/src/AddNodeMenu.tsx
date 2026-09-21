import { useEffect, useId, useRef, useState } from 'react'
import { TEMPLATES, TEMPLATE_IDS, type TemplateId } from '@prysel/morphology'
import { Icon } from './Icon.tsx'

/**
 * El menú de añadir. Cada entrada es una plantilla de Python (una variable, una decisión, un
 * bucle, una función…): al elegirla se escribe en el archivo, detrás del nodo seleccionado, dentro
 * de la función que se está viendo, o al final del programa.
 */

export interface AddNodeMenuProps {
  onAdd: (template: TemplateId) => void
  /** Dónde va lo que se añade: «después de suma_resultado», «al final de _main»… */
  where?: string
}

const GROUPS = [...new Set(TEMPLATE_IDS.map((id) => TEMPLATES[id].group))]

export function AddNodeMenu({ onAdd, where }: AddNodeMenuProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const listId = useId()

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

  return (
    <div className="add-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="add-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          setOpen((current) => !current)
        }}
      >
        <Icon name="plus" size={13} />
        Añadir
      </button>
      {/* Siempre a la vista: dónde caerá lo que se añada (dentro de una función, detrás de un nodo…). */}
      {where && <span className="add-menu__target type-field-label">{where}</span>}

      {open && (
        <div className="add-menu__list" id={listId} role="menu" aria-label="Añadir un nodo">
          {where && <p className="add-menu__where type-field-label">{where}</p>}
          {GROUPS.map((group) => (
            <div key={group} role="group" aria-label={group}>
              <p className="add-menu__group type-field-label">{group}</p>
              {TEMPLATE_IDS.filter((id) => TEMPLATES[id].group === group).map((id) => (
                <button
                  key={id}
                  type="button"
                  role="menuitem"
                  className="add-menu__item"
                  onClick={() => {
                    onAdd(id)
                    setOpen(false)
                  }}
                >
                  {TEMPLATES[id].label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
