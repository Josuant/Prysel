import { Component, type ReactNode } from 'react'

/**
 * Si algo de lo que se dibuja falla (un dato con una forma que no se esperaba), el lienzo no se queda en
 * blanco: dice qué pasó y se recupera solo en cuanto llega otro estado del programa o se pulsa
 * «Reintentar».
 */
interface Props {
  children: ReactNode
  /** Cuando cambia, se vuelve a intentar dibujar (llegó un programa o un resultado nuevo). */
  resetKey?: unknown
  label: string
}

export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  override componentDidUpdate(previous: Props) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  override render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div role="alert" className="flex h-full items-center justify-center p-6 text-center">
        <div className="max-w-sm">
          <p className="text-sm text-ink">{this.props.label}</p>
          <p className="mt-1 text-xs leading-5 text-ink-faint">{error.message}</p>
          <button
            type="button"
            className="mt-2 rounded border border-border-card px-2 py-1 text-[11px] text-ink-muted hover:text-ink"
            onClick={() => {
              this.setState({ error: null })
            }}
          >
            Reintentar
          </button>
        </div>
      </div>
    )
  }
}
