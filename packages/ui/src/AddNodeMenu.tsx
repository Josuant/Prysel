import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { TEMPLATES, TEMPLATE_IDS, type TemplateId } from '@prysel/morphology'
import { Icon } from './Icon.tsx'

/**
 * La paleta de añadir. Cada entrada es una plantilla de Python (una variable, una decisión, un bucle, una
 * función…) con su icono y una frase que dice para qué sirve: quien empieza elige leyendo, y quien ya sabe lo
 * que quiere lo escribe en el buscador y pulsa Intro. Se escribe en el archivo detrás del nodo seleccionado,
 * dentro de la función que se está viendo, o al final del programa.
 */

export interface AddNodeMenuProps {
  onAdd: (template: TemplateId) => void
  /** Dónde va lo que se añade: «después de suma_resultado», «al final de _main»… */
  where?: string
  /** Hacia dónde se abre la paleta: abajo (desde una barra) o arriba (desde el pie del lienzo). */
  placement?: 'down' | 'up'
  /** El texto del botón. */
  label?: string
}

const GROUPS = [...new Set(TEMPLATE_IDS.map((id) => TEMPLATES[id].group))]

/** Sin tildes ni mayúsculas: «decision» encuentra «Decisión». */
const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/**
 * Lo que se ofrece para lo que se ha escrito en el buscador: se busca en el nombre, en la frase que lo explica,
 * en su grupo y en su nombre de Python (`for`, `while`), sin que importen tildes ni mayúsculas.
 */
export function findTemplates(query: string): TemplateId[] {
  const wanted = fold(query.trim())
  if (!wanted) return [...TEMPLATE_IDS]
  return TEMPLATE_IDS.filter((id) => {
    const { label: name, hint, group } = TEMPLATES[id]
    return fold(`${name} ${hint} ${group} ${id}`).includes(wanted)
  })
}

export function AddNodeMenu({
  onAdd,
  where,
  placement = 'down',
  label = 'Añadir',
}: AddNodeMenuProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const listId = useId()

  const close = () => {
    setOpen(false)
    setQuery('')
  }

  useEffect(() => {
    if (!open) return
    search.current?.focus()
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      setQuery('')
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const found = useMemo(() => findTemplates(query), [query])

  const pick = (id: TemplateId) => {
    onAdd(id)
    close()
  }

  /** Las flechas recorren la lista; desde el buscador, la flecha abajo entra en ella. */
  const onListKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('.palette__item') ?? [])]
    if (items.length === 0) return
    event.preventDefault()
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.key === 'ArrowDown'
        ? items[Math.min(items.length - 1, at + 1)]
        : at <= 0
          ? undefined
          : items[at - 1]
    if (next) next.focus()
    else search.current?.focus()
  }

  return (
    <div className="add-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="btn add-menu__trigger"
        data-variant="primary"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          if (open) close()
          else setOpen(true)
        }}
      >
        <Icon name="plus" size={14} />
        {label}
      </button>
      {/* Siempre a la vista: dónde caerá lo que se añada (dentro de una función, detrás de un nodo…). */}
      {where && <span className="add-menu__target type-field-label">{where}</span>}

      {open && (
        // La paleta es un diálogo con un buscador y una lista: las flechas la recorren.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
        <div
          className="palette"
          data-placement={placement}
          id={listId}
          role="dialog"
          aria-label="Añadir un paso"
          onKeyDown={onListKey}
        >
          <label className="palette__search">
            <Icon name="search" size={14} />
            <input
              ref={search}
              className="palette__input"
              placeholder="Buscar: bucle, decisión, lista…"
              aria-label="Buscar qué añadir"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
              }}
              onKeyDown={(event) => {
                const first = found[0]
                if (event.key === 'Enter' && first) {
                  event.preventDefault()
                  pick(first)
                }
              }}
            />
          </label>
          {where && <p className="palette__where type-field-label">Se añadirá {where}</p>}
          <div className="palette__list">
            {GROUPS.map((group) => {
              const ids = found.filter((id) => TEMPLATES[id].group === group)
              if (ids.length === 0) return null
              return (
                <div key={group} role="group" aria-label={group} className="palette__group">
                  <p className="palette__group-name type-field-label">{group}</p>
                  {ids.map((id) => {
                    const template = TEMPLATES[id]
                    return (
                      <button
                        key={id}
                        type="button"
                        className="palette__item"
                        data-group={group}
                        onClick={() => {
                          pick(id)
                        }}
                      >
                        <span className="palette__icon" aria-hidden>
                          <Icon name={template.icon} size={15} />
                        </span>
                        <span className="palette__text">
                          <span className="palette__label">{template.label}</span>
                          <span className="palette__hint">{template.hint}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              )
            })}
            {found.length === 0 && (
              <p className="palette__empty">Nada se llama así. Prueba con «bucle» o «variable».</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
