import { ICONS, type IconId } from '@prysel/morphology'

export interface IconProps {
  name: IconId
  size?: number
  className?: string
}

/** Icono de trazo sobre rejilla de 24×24. Hereda el color del texto que lo rodea. */
export function Icon({ name, size = 14, className }: IconProps) {
  return (
    <svg
      className={['icon', className].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <path d={ICONS[name]} />
    </svg>
  )
}
