import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { IconId } from '@prysel/morphology'
import { Icon } from './Icon.tsx'

/**
 * Las piezas de la interfaz que rodea al lienzo: la barra de la aplicación, sus botones y lo que dice cómo está
 * el motor. Son las mismas en la extensión y en la galería, y siguen la jerarquía de siempre: una acción
 * principal (sólida, con el acento), las secundarias (blancas, con sombra suave) y las de apoyo (solo icono).
 */

export interface ButtonProps {
  children?: ReactNode
  icon?: IconId
  /** `primary`: la acción que importa ahora; `secondary`: otra acción; `ghost`: una de apoyo, sin fondo. */
  variant?: 'primary' | 'secondary' | 'ghost'
  disabled?: boolean
  pressed?: boolean
  title?: string
  onClick?: () => void
  className?: string
}

export function Button({
  children,
  icon,
  variant = 'secondary',
  disabled = false,
  pressed,
  title,
  onClick,
  className,
}: ButtonProps) {
  return (
    <button
      type="button"
      className={['btn', className].filter(Boolean).join(' ')}
      data-variant={variant}
      disabled={disabled}
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
    >
      {icon && <Icon name={icon} size={14} />}
      {children}
    </button>
  )
}

/** Un botón que es solo un icono: su nombre va en la etiqueta accesible y en el tooltip. */
export function IconButton({
  icon,
  label,
  disabled = false,
  pressed,
  onClick,
  className,
}: {
  icon: IconId
  label: string
  disabled?: boolean
  pressed?: boolean
  onClick?: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      className={['icon-btn', className].filter(Boolean).join(' ')}
      aria-label={label}
      title={label}
      disabled={disabled}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <Icon name={icon} size={15} />
    </button>
  )
}

export interface MenuAction {
  label: string
  icon?: IconId
  /** El atajo o una aclaración, a la derecha. */
  hint?: string
  disabled?: boolean
  danger?: boolean
  onClick: () => void
}

/** Cierra un menú al pulsar fuera o Escape (y devuelve el foco a quien lo abrió). */
function useDismiss(
  open: boolean,
  close: () => void,
  root: React.RefObject<HTMLElement | null>,
  trigger: React.RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) close()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      close()
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close, root, trigger])
}

/**
 * La acción principal con sus variantes: un clic hace lo de siempre (ejecutar todo) y la flecha ofrece el
 * resto (ejecutar la selección, parar, reiniciar), cada una con su atajo.
 */
export function SplitButton({
  icon,
  label,
  title,
  disabled = false,
  onClick,
  menuLabel,
  actions,
}: {
  icon?: IconId
  label: string
  title?: string
  disabled?: boolean
  onClick: () => void
  menuLabel: string
  actions: readonly MenuAction[]
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  useDismiss(open, () => setOpen(false), root, trigger)
  return (
    <div className="split" ref={root}>
      <button
        type="button"
        className="btn split__main"
        data-variant="primary"
        disabled={disabled}
        title={title}
        onClick={onClick}
      >
        {icon && <Icon name={icon} size={14} />}
        {label}
      </button>
      <button
        ref={trigger}
        type="button"
        className="btn split__more"
        data-variant="primary"
        aria-label={menuLabel}
        title={menuLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          setOpen((current) => !current)
        }}
      >
        <Icon name="chevron" size={13} />
      </button>
      {open && (
        <div className="menu split__menu" id={menuId} role="menu" aria-label={menuLabel}>
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              role="menuitem"
              className="menu__item"
              data-danger={action.danger ? '' : undefined}
              disabled={action.disabled}
              onClick={() => {
                setOpen(false)
                action.onClick()
              }}
            >
              {action.icon && <Icon name={action.icon} size={14} className="menu__icon" />}
              <span className="menu__label">{action.label}</span>
              {action.hint && <kbd className="menu__hint">{action.hint}</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Cómo está algo que trabaja por detrás (el motor de Python): un punto de color y una palabra. */
export function StatusPill({
  tone,
  label,
  title,
}: {
  /** `idle`: parado; `ready`: listo; `busy`: trabajando; `error`: caído. */
  tone: 'idle' | 'ready' | 'busy' | 'error'
  label: string
  title?: string
}) {
  return (
    <span className="status-pill" data-tone={tone} title={title} aria-live="polite">
      <span className="status-pill__dot" aria-hidden />
      {label}
    </span>
  )
}
