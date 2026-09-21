import type { BadgeFamily, IconId, NodeState } from '@prysel/morphology'
import { Icon } from './Icon.tsx'

/**
 * Insignia de tipo: icono + nombre sobre un fondo pastel de su familia.
 * Es el portador principal de la identidad del nodo — se lee antes que cualquier otra cosa.
 */
export function TypeBadge({
  family,
  icon,
  label,
  className,
  iconOnly = false,
}: {
  family: BadgeFamily
  icon: IconId
  label: string
  className?: string
  /** Solo el icono: el nombre del tipo va en su tooltip. Es lo que usa una tarjeta compacta. */
  iconOnly?: boolean
}) {
  return (
    <span
      className={['badge type-badge', className].filter(Boolean).join(' ')}
      data-family={family}
      data-icon-only={iconOnly ? '' : undefined}
      {...(iconOnly ? { title: label, role: 'img', 'aria-label': label } : {})}
    >
      <Icon name={icon} size={13} />
      {!iconOnly && label}
    </span>
  )
}

/**
 * Chip de estado. Cada estado tiene icono propio además de color, para que el sistema
 * funcione en escala de grises y sea seguro para daltonismo (regla del DS).
 */
export const STATE_META: Record<NodeState, { icon: IconId; label: string }> = {
  dormant: { icon: 'dot', label: 'Inactivo' },
  running: { icon: 'clock', label: 'Ejecutando' },
  success: { icon: 'check', label: 'Completado' },
  warning: { icon: 'alert', label: 'Advertencia' },
  error: { icon: 'x', label: 'Error' },
  selected: { icon: 'diamond', label: 'Seleccionado' },
}

export function StatusChip({
  state,
  showLabel = true,
  className,
}: {
  state: NodeState
  showLabel?: boolean
  className?: string
}) {
  const { icon, label } = STATE_META[state]
  return (
    <span
      className={['chip type-badge', className].filter(Boolean).join(' ')}
      data-state={state}
      data-icon-only={showLabel ? undefined : ''}
      role="status"
      aria-label={label}
    >
      <Icon name={icon} size={12} />
      {showLabel && <span>{label}</span>}
    </span>
  )
}
