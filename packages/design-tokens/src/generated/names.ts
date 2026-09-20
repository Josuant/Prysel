// GENERADO por packages/design-tokens (pnpm tokens). No editar a mano.

export const tokenNames = {
  color: ['void', 'surface', 'surface-raised', 'ink', 'ink-muted', 'ink-faint', 'line', 'line-faint', 'accent', 'state-dormant', 'state-running', 'state-success', 'state-warning', 'state-error', 'state-selected', 'border-card', 'grid-dot', 'field', 'badge-value-bg', 'badge-value-fg', 'badge-data-bg', 'badge-data-fg', 'badge-transform-bg', 'badge-transform-fg', 'badge-control-bg', 'badge-control-fg', 'badge-effect-bg', 'badge-effect-fg', 'badge-output-bg', 'badge-output-fg', 'badge-neutral-bg', 'badge-neutral-fg', 'chip-dormant-bg', 'chip-dormant-fg', 'chip-running-bg', 'chip-running-fg', 'chip-success-bg', 'chip-success-fg', 'chip-warning-bg', 'chip-warning-fg', 'chip-error-bg', 'chip-error-fg', 'chip-selected-bg', 'chip-selected-fg'] as const,
  spacing: ['space-1', 'space-2', 'space-3', 'space-4', 'space-6', 'space-10', 'space-16'] as const,
  radius: ['radius-sm', 'radius-md', 'radius-lg', 'radius-full', 'radius-card', 'radius-field', 'radius-space'] as const,
  shadow: ['shadow-raised', 'shadow-card'] as const,
  blur: ['blur-glass'] as const,
  stroke: ['stroke-node', 'stroke-control', 'stroke-data'] as const,
  opacity: ['opacity-ghost', 'opacity-dead', 'opacity-veil'] as const,
  typeStyle: ['primary', 'secondary', 'tertiary', 'space-title', 'architecture', 'node-title', 'badge', 'field-label', 'stat', 'code', 'value'] as const,
} as const

export type TokenFamily = keyof typeof tokenNames
export type TokenName<F extends TokenFamily> = (typeof tokenNames)[F][number]
export type ColorToken = TokenName<'color'>
